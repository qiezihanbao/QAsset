use crate::models::*;
use crate::library;
use tauri::{Emitter, Manager, State};
use notify::Watcher;
use image::GenericImageView;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use image_hasher;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

fn get_library_root(state: &State<'_, crate::library::AppState>) -> Result<std::path::PathBuf, String> {
    state.library_root.read().map_err(|e| e.to_string())?
        .clone()
        .ok_or("No library is currently open".into())
}

fn get_db_path(state: &State<'_, crate::library::AppState>) -> Result<std::path::PathBuf, String> {
    state.db_path.read().map_err(|e| e.to_string())?
        .clone()
        .ok_or("No library is currently open".into())
}

fn needs_transcoded_preview(path_or_name: &str) -> bool {
    let ext = std::path::Path::new(path_or_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "psd" | "psb" | "clip")
}

fn psd_decode_enabled_runtime() -> bool {
    matches!(
        std::env::var("QUICKASSET_ENABLE_PSD_DECODE").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("on") | Some("ON")
    )
}

fn is_psd_stability_skip_error(message: &str) -> bool {
    message.contains("Skipping PSD/PSB decode for stability")
}

fn build_fts_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" AND "))
    }
}

fn sampled_image_quality(img: &image::DynamicImage) -> (f32, u8) {
    let tiny = img.thumbnail(64, 64).to_rgba8();
    let total = tiny.width().saturating_mul(tiny.height());
    if total == 0 {
        return (0.0, 0);
    }

    let mut non_transparent: u32 = 0;
    let mut min_luma: u8 = u8::MAX;
    let mut max_luma: u8 = 0;
    for px in tiny.pixels() {
        let [r, g, b, a] = px.0;
        if a <= 8 {
            continue;
        }
        non_transparent = non_transparent.saturating_add(1);
        let luma = ((r as u16 + g as u16 + b as u16) / 3) as u8;
        if luma < min_luma {
            min_luma = luma;
        }
        if luma > max_luma {
            max_luma = luma;
        }
    }

    if non_transparent == 0 {
        return (0.0, 0);
    }

    let ratio = non_transparent as f32 / total as f32;
    let contrast = max_luma.saturating_sub(min_luma);
    (ratio, contrast)
}

fn image_has_visible_content(img: &image::DynamicImage) -> bool {
    let (ratio, contrast) = sampled_image_quality(img);
    ratio >= 0.03 && contrast >= 8
}

fn preview_cache_has_visible_content(preview_path: &Path) -> bool {
    match image::open(preview_path) {
        Ok(img) => image_has_visible_content(&img),
        Err(_) => false,
    }
}

fn sync_asset_dimensions(
    conn: &rusqlite::Connection,
    asset_path: &str,
    width: u32,
    height: u32,
) -> Result<(), String> {
    conn.execute(
        "UPDATE assets SET width = ?1, height = ?2 WHERE path = ?3",
        rusqlite::params![width, height, asset_path],
    )
    .map_err(|e| format!("Failed to update asset dimensions: {}", e))?;
    Ok(())
}

fn parse_string_list_json(raw: Option<&str>) -> Vec<String> {
    let Some(text) = raw else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(text);
    let Some(arr) = parsed.ok().and_then(|v| v.as_array().cloned()) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in arr {
        let Some(s) = item.as_str().map(|v| v.trim()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let value = s.to_string();
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn normalize_rel_folder(raw: &str) -> String {
    raw.replace('\\', "/").trim_matches('/').to_string()
}

fn unique_file_destination(parent: &Path, original_name: &str) -> PathBuf {
    let input = Path::new(original_name);
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("asset");
    let ext = input.extension().and_then(|s| s.to_str()).unwrap_or("");

    let mut candidate = parent.join(original_name);
    if !candidate.exists() {
        return candidate;
    }

    for i in 2..=9999 {
        let file_name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    if ext.is_empty() {
        parent.join(format!("asset-{}", uuid::Uuid::new_v4().simple()))
    } else {
        parent.join(format!(
            "asset-{}.{}",
            uuid::Uuid::new_v4().simple(),
            ext
        ))
    }
}

fn unique_dir_destination(parent: &Path, dir_name: &str) -> PathBuf {
    let base = dir_name.trim();
    let clean = if base.is_empty() { "folder" } else { base };
    let mut candidate = parent.join(clean);
    if !candidate.exists() {
        return candidate;
    }

    for i in 2..=9999 {
        candidate = parent.join(format!("{} ({})", clean, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("folder-{}", uuid::Uuid::new_v4().simple()))
}

fn move_file_with_fallback(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(_) => Ok(()),
        Err(e) => {
            if e.kind() != io::ErrorKind::CrossesDevices {
                return Err(format!(
                    "Failed to move '{}' -> '{}': {}",
                    src.display(),
                    dst.display(),
                    e
                ));
            }
            fs::copy(src, dst).map_err(|copy_err| {
                format!(
                    "Cross-device copy failed '{}' -> '{}': {}",
                    src.display(),
                    dst.display(),
                    copy_err
                )
            })?;
            fs::remove_file(src).map_err(|remove_err| {
                format!(
                    "Remove source file after copy failed '{}': {}",
                    src.display(),
                    remove_err
                )
            })?;
            Ok(())
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Create directory failed '{}': {}", dst.display(), e))?;

    let entries = fs::read_dir(src)
        .map_err(|e| format!("Read directory failed '{}': {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        if file_name.to_string_lossy().eq_ignore_ascii_case(".quickasset") {
            continue;
        }
        let target = dst.join(&file_name);
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &target)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &target).map_err(|e| {
                format!(
                    "Copy file failed '{}' -> '{}': {}",
                    src_path.display(),
                    target.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

fn copy_path_into_library(src_path: &Path, library_root: &Path) -> Result<(), String> {
    if !src_path.exists() {
        return Ok(());
    }

    let src_canonical = src_path.canonicalize().ok();
    let lib_canonical = library_root.canonicalize().ok();
    if let (Some(src_abs), Some(lib_abs)) = (src_canonical, lib_canonical) {
        if src_abs.starts_with(&lib_abs) {
            // Already inside the library; no-op.
            return Ok(());
        }
    }

    if src_path.is_file() {
        let file_name = src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("asset.bin");
        let target = unique_file_destination(library_root, file_name);
        fs::copy(src_path, &target).map_err(|e| {
            format!(
                "Copy file failed '{}' -> '{}': {}",
                src_path.display(),
                target.display(),
                e
            )
        })?;
        return Ok(());
    }

    if src_path.is_dir() {
        let dir_name = src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("folder");
        let target_dir = unique_dir_destination(library_root, dir_name);
        copy_dir_recursive(src_path, &target_dir)?;
    }

    Ok(())
}

fn clip_debug_enabled() -> bool {
    matches!(
        std::env::var("QUICKASSET_CLIP_DEBUG").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("on") | Some("ON")
    )
}

macro_rules! clip_debug {
    ($($arg:tt)*) => {
        if clip_debug_enabled() {
            eprintln!($($arg)*);
        }
    };
}

#[tauri::command]
pub async fn create_library(
    path: String,
    name: String,
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _ = state.prefetch_runtime.cancel_all().await;
    let library_root = PathBuf::from(&path);
    library::create_library(&library_root, &name)?;

    // Auto-open after creating
    *state.library_root.write().map_err(|e| e.to_string())? = Some(library_root.clone());
    *state.db_path.write().map_err(|e| e.to_string())? = Some(library::library_db_path(&library_root));

    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    library::add_to_registry(&app_data, &path, &name)?;

    Ok(())
}

#[tauri::command]
pub async fn open_library_cmd(
    path: String,
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<LibraryConfig, String> {
    let _ = state.prefetch_runtime.cancel_all().await;
    let library_root = PathBuf::from(&path);
    let config = library::open_library(&library_root)?;

    *state.library_root.write().map_err(|e| e.to_string())? = Some(library_root.clone());
    *state.db_path.write().map_err(|e| e.to_string())? = Some(library::library_db_path(&library_root));

    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    library::add_to_registry(&app_data, &path, &config.name)?;

    Ok(config)
}

#[tauri::command]
pub async fn close_library(
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let _ = state.prefetch_runtime.cancel_all().await;
    // Stop watcher by dropping it
    *state.watcher_handle.lock().map_err(|e| e.to_string())? = None;
    *state.library_root.write().map_err(|e| e.to_string())? = None;
    *state.db_path.write().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
pub async fn get_library_info_cmd(
    state: State<'_, crate::library::AppState>,
) -> Result<LibraryConfig, String> {
    let root = get_library_root(&state)?;
    library::get_library_info(&root)
}

#[tauri::command]
pub async fn get_recent_libraries(
    app_handle: tauri::AppHandle,
) -> Result<Vec<RegistryEntry>, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let registry = library::load_registry(&app_data);
    Ok(registry.recent_libraries)
}

#[tauri::command]
pub async fn relocate_library(
    new_root: String,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let _ = state.prefetch_runtime.cancel_all().await;
    let db_path = get_db_path(&state)?;
    let _library_root = get_library_root(&state)?;
    let new_root_path = PathBuf::from(&new_root);

    let conn = library::get_db_connection(&db_path)?;

    // Recalculate all paths from relative_path + new_root
    let mut stmt = conn.prepare("SELECT id, relative_path FROM assets").map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    for (old_id, rel_path) in &rows {
        let new_abs = new_root_path.join(rel_path);
        let new_abs_str = new_abs.to_string_lossy().to_string();
        let new_name = new_abs.file_name().unwrap_or_default().to_string_lossy().to_string();
        conn.execute(
            "UPDATE assets SET id = ?1, path = ?2, name = ?3 WHERE id = ?4",
            rusqlite::params![new_abs_str, new_abs_str, new_name, old_id],
        ).map_err(|e| e.to_string())?;
    }

    // Update state
    *state.library_root.write().map_err(|e| e.to_string())? = Some(new_root_path);
    *state.db_path.write().map_err(|e| e.to_string())? = Some(library::library_db_path(&PathBuf::from(&new_root)));

    Ok(())
}

#[tauri::command]
pub async fn scan_library(
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<ScanReport, String> {
    let root = get_library_root(&state)?;
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        crate::scanner::scan_library(&root, &db_path, &app_handle)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_external_paths(
    paths: Vec<String>,
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    let library_root = get_library_root(&state)?;
    let db_path = get_db_path(&state)?;
    if paths.is_empty() {
        return Ok(0);
    }

    tokio::task::spawn_blocking(move || {
        let mut imported_entries = 0u32;
        for raw_path in paths {
            let src = PathBuf::from(&raw_path);
            if !src.exists() {
                continue;
            }
            copy_path_into_library(&src, &library_root)?;
            imported_entries = imported_entries.saturating_add(1);
        }

        if imported_entries == 0 {
            return Ok(0);
        }

        let report = crate::scanner::scan_library(&library_root, &db_path, &app_handle)?;
        Ok(report.added.saturating_add(report.updated))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_assets_to_folder(
    asset_ids: Vec<String>,
    target_folder: String,
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        if asset_ids.is_empty() {
            return Ok(0);
        }

        let normalized_target = normalize_rel_folder(&target_folder);
        let target_dir = if normalized_target.is_empty() {
            library_root.clone()
        } else {
            library_root.join(&normalized_target)
        };
        fs::create_dir_all(&target_dir).map_err(|e| {
            format!(
                "Failed to create target folder '{}': {}",
                target_dir.display(),
                e
            )
        })?;

        let conn = library::get_db_connection(&db_path)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Begin move transaction failed: {}", e))?;
        let mut moved_count = 0u32;
        let mut seen = HashSet::new();

        for asset_id in asset_ids {
            if !seen.insert(asset_id.clone()) {
                continue;
            }

            let (current_path, current_relative_path, current_thumbnail_mtime) = match tx.query_row(
                "SELECT path, relative_path, thumbnail_mtime FROM assets WHERE id = ?1",
                rusqlite::params![asset_id.clone()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            ) {
                Ok(row) => row,
                Err(_) => continue,
            };

            let src = PathBuf::from(&current_path);
            if !src.exists() || !src.is_file() {
                continue;
            }
            if src.parent() == Some(target_dir.as_path()) {
                continue;
            }

            let file_name = src
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("asset.bin");
            let target_path = unique_file_destination(&target_dir, file_name);

            move_file_with_fallback(&src, &target_path)?;

            let new_id = target_path.to_string_lossy().to_string();
            let new_name = target_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(file_name)
                .to_string();
            let new_relative = target_path
                .strip_prefix(&library_root)
                .unwrap_or(&target_path)
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            let mut next_thumbnail_mtime = current_thumbnail_mtime;
            let old_thumb_path =
                crate::thumbnails::thumbnail_abs_path(&library_root, &current_relative_path);
            let new_thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &new_relative);
            if old_thumb_path.exists() {
                if let Some(parent) = new_thumb_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| {
                        format!("Failed to create thumbnail directory '{}': {}", parent.display(), e)
                    })?;
                }
                if move_file_with_fallback(&old_thumb_path, &new_thumb_path).is_err() {
                    next_thumbnail_mtime = None;
                }
            } else if current_thumbnail_mtime.is_some() {
                next_thumbnail_mtime = None;
            }

            tx.execute(
                "UPDATE assets SET id = ?1, path = ?2, name = ?3, relative_path = ?4, thumbnail_mtime = ?5 WHERE id = ?6",
                rusqlite::params![
                    new_id,
                    new_id,
                    new_name,
                    new_relative,
                    next_thumbnail_mtime,
                    asset_id
                ],
            )
            .map_err(|e| format!("Update moved asset failed: {}", e))?;

            moved_count = moved_count.saturating_add(1);
        }

        tx.commit()
            .map_err(|e| format!("Commit move transaction failed: {}", e))?;
        crate::scanner::rebuild_folders(&conn, &library_root)?;

        Ok(moved_count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_folder_to_folder(
    source_folder: String,
    target_parent_folder: Option<String>,
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let source_rel = normalize_rel_folder(&source_folder);
        if source_rel.is_empty() {
            return Err("Source folder is required".to_string());
        }
        let target_parent_rel = normalize_rel_folder(target_parent_folder.as_deref().unwrap_or(""));

        let source_abs = library_root.join(&source_rel);
        if !source_abs.exists() || !source_abs.is_dir() {
            return Err(format!("Source folder does not exist: {}", source_rel));
        }

        let source_name = source_abs
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid source folder name".to_string())?
            .to_string();

        let expected_target_rel = if target_parent_rel.is_empty() {
            source_name.clone()
        } else {
            format!("{}/{}", target_parent_rel, source_name)
        };
        if expected_target_rel == source_rel
            || expected_target_rel.starts_with(&format!("{}/", source_rel))
        {
            return Err("Cannot move a folder into itself or its subfolder".to_string());
        }

        let target_parent_abs = if target_parent_rel.is_empty() {
            library_root.clone()
        } else {
            library_root.join(&target_parent_rel)
        };
        fs::create_dir_all(&target_parent_abs).map_err(|e| {
            format!(
                "Failed to create target parent folder '{}': {}",
                target_parent_abs.display(),
                e
            )
        })?;

        let target_abs = unique_dir_destination(&target_parent_abs, &source_name);
        fs::rename(&source_abs, &target_abs).map_err(|e| {
            format!(
                "Move folder failed '{}' -> '{}': {}",
                source_abs.display(),
                target_abs.display(),
                e
            )
        })?;

        let _report = crate::scanner::scan_library(&library_root, &db_path, &app_handle)?;
        let target_rel = target_abs
            .strip_prefix(&library_root)
            .unwrap_or(&target_abs)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");
        Ok(target_rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn query_assets(
    filters: AssetFilters,
    state: State<'_, crate::library::AppState>,
) -> Result<QueryResult, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let has_assets_fts: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'assets_fts'",
                [],
                |row| {
                    let count: i64 = row.get(0)?;
                    Ok(count > 0)
                },
            )
            .unwrap_or(false);

        // Build dynamic WHERE clause
        let mut where_clauses: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref sq) = filters.search_query {
            if !sq.is_empty() {
                if has_assets_fts {
                    if let Some(fts_query) = build_fts_query(sq) {
                        where_clauses.push(
                            "EXISTS (
                                SELECT 1
                                FROM assets_fts
                                WHERE assets_fts.asset_id = assets.id
                                  AND assets_fts MATCH ?
                            )"
                            .to_string(),
                        );
                        param_values.push(Box::new(fts_query));
                    } else {
                        where_clauses.push("name LIKE '%' || ? || '%'".to_string());
                        param_values.push(Box::new(sq.clone()));
                    }
                } else {
                    where_clauses.push("name LIKE '%' || ? || '%'".to_string());
                    param_values.push(Box::new(sq.clone()));
                }
            }
        }

        if let Some(ref types) = filters.asset_types {
            if !types.is_empty() {
                let placeholders: Vec<String> = types.iter().enumerate()
                    .map(|(i, _)| format!("?{}", param_values.len() + i + 1))
                    .collect();
                where_clauses.push(format!("asset_type IN ({})", placeholders.join(", ")));
                for t in types {
                    param_values.push(Box::new(t.clone()));
                }
            }
        }

        if let Some(trashed) = filters.is_trashed {
            where_clauses.push("is_trashed = ?".to_string());
            param_values.push(Box::new(trashed as i32));
        }

        if let Some(ref ws_id) = filters.workspace_id {
            where_clauses.push(
                "EXISTS (
                    SELECT 1
                    FROM asset_workspaces AS aw
                    WHERE aw.asset_id = assets.id AND aw.workspace_id = ?
                )"
                .to_string(),
            );
            param_values.push(Box::new(ws_id.clone()));
        }

        if let Some(ref folder) = filters.folder_path {
            let folder_clean = folder
                .replace('\\', "/")
                .trim_matches('/')
                .to_string();
            // Check if this folder has show_subfolders enabled
            let show_subfolders: bool = {
                let mut check_stmt = conn.prepare(
                    "SELECT COALESCE(show_subfolders, 1) FROM folders WHERE REPLACE(path, char(92), '/') = ?1"
                ).ok();
                if let Some(ref mut stmt) = check_stmt {
                    stmt.query_row(rusqlite::params![folder_clean], |row| {
                        let v: i32 = row.get(0)?;
                        Ok(v != 0)
                    }).unwrap_or(true)
                } else {
                    true
                }
            };

            if !folder_clean.is_empty() {
                if show_subfolders {
                    // Show assets in this folder and all subfolders.
                    where_clauses.push("REPLACE(relative_path, char(92), '/') LIKE ?".to_string());
                    param_values.push(Box::new(format!("{}/%", folder_clean)));
                } else {
                    // Show only assets directly in this folder (not subfolders).
                    where_clauses.push(
                        "(REPLACE(relative_path, char(92), '/') LIKE ? AND REPLACE(relative_path, char(92), '/') NOT LIKE ?)"
                            .to_string(),
                    );
                    param_values.push(Box::new(format!("{}/%", folder_clean)));
                    // Exclude deeper paths: anything with another '/' after the folder prefix
                    param_values.push(Box::new(format!("{}/%/%", folder_clean)));
                }
            }
        }

        if let Some(min_r) = filters.min_rating {
            where_clauses.push("rating >= ?".to_string());
            param_values.push(Box::new(min_r as i32));
        }

        if let Some(min_s) = filters.min_size {
            where_clauses.push("size >= ?".to_string());
            param_values.push(Box::new(min_s as i64));
        }

        if let Some(max_s) = filters.max_size {
            where_clauses.push("size <= ?".to_string());
            param_values.push(Box::new(max_s as i64));
        }

        if let Some(ref tags) = filters.tags {
            if !tags.is_empty() {
                for tag in tags {
                    where_clauses.push(
                        "EXISTS (
                            SELECT 1
                            FROM asset_tags AS at
                            WHERE at.asset_id = assets.id AND at.tag = ?
                        )"
                        .to_string(),
                    );
                    param_values.push(Box::new(tag.clone()));
                }
            }
        }

        if filters.unorganized == Some(true) {
            where_clauses.push(
                "NOT EXISTS (SELECT 1 FROM asset_tags AS at WHERE at.asset_id = assets.id)"
                    .to_string(),
            );
            where_clauses.push(
                "NOT EXISTS (SELECT 1 FROM asset_workspaces AS aw WHERE aw.asset_id = assets.id)"
                    .to_string(),
            );
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // Validate sort_field to prevent SQL injection
        let sort_field = match filters.sort_field.as_str() {
            "name" => "name",
            "size" => "size",
            "rating" => "rating",
            "created_at" => "created_at",
            "modified_at" => "modified_at",
            _ => "created_at",
        };
        let sort_order = if filters.sort_order == "asc" { "ASC" } else { "DESC" };

        // Count total only when explicitly needed (usually first page).
        let total_count: u32 = if filters.skip_total_count == Some(true) {
            0
        } else {
            let count_sql = format!("SELECT COUNT(*) FROM assets {}", where_sql);
            let count_params: Vec<&dyn rusqlite::types::ToSql> =
                param_values.iter().map(|p| p.as_ref()).collect();
            conn.query_row(&count_sql, count_params.as_slice(), |row| row.get(0))
                .map_err(|e| format!("Count query failed: {}", e))?
        };

        // Query page
        let query_sql = format!(
            "SELECT id, name, path, asset_type, size, dominant_color, width, height, created_at, modified_at, rating, is_trashed, thumbnail_mtime, relative_path \
             FROM assets {} ORDER BY {} {} LIMIT ? OFFSET ?",
            where_sql, sort_field, sort_order
        );

        let offset = (filters.page.saturating_sub(1)) * filters.page_size;
        param_values.push(Box::new(filters.page_size as i64));
        param_values.push(Box::new(offset as i64));

        let query_params: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&query_sql).map_err(|e| format!("Query prepare failed: {}", e))?;
        let rows = stmt.query_map(query_params.as_slice(), |row| {
            let is_trashed_i32: i32 = row.get(11)?;
            let thumbnail_mtime: Option<i64> = row.get(12)?;
            let relative_path: String = row.get(13)?;
            let thumbnail_path = if thumbnail_mtime.is_some() {
                let thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
                Some(thumb_path.to_string_lossy().to_string())
            } else {
                None
            };
            Ok(AssetInfoLite {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                asset_type: row.get(3)?,
                size: row.get(4)?,
                dominant_color: row.get(5)?,
                width: row.get(6)?,
                height: row.get(7)?,
                created_at: row.get(8)?,
                modified_at: row.get(9)?,
                rating: row.get(10)?,
                is_trashed: is_trashed_i32 != 0,
                thumbnail_path,
            })
        }).map_err(|e| format!("Query execution failed: {}", e))?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e: rusqlite::Error| e.to_string())?);
        }

        Ok(QueryResult { total_count, items })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prefetch_assets_window(
    request: PrefetchAssetsWindowRequest,
    state: State<'_, crate::library::AppState>,
) -> Result<PrefetchEnqueueResult, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;
    state
        .prefetch_runtime
        .enqueue_window(request, db_path, library_root)
        .await
}

#[tauri::command]
pub async fn cancel_prefetch_task(
    task_id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<PrefetchCancelResult, String> {
    state.prefetch_runtime.cancel_task(task_id).await
}

#[tauri::command]
pub async fn get_prefetch_status(
    task_id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<Option<PrefetchTaskStatus>, String> {
    Ok(state.prefetch_runtime.get_status(task_id).await)
}

#[tauri::command]
pub async fn get_asset_detail(
    id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<AssetDetail, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn.prepare(
            "SELECT id, name, path, relative_path, asset_type, size, dominant_color, tags, description, \
             rating, workspace_ids, created_at, modified_at, p_hash, is_trashed, width, height, \
             source_url, duration \
             FROM assets WHERE id = ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let detail = stmt.query_row(rusqlite::params![id], |row| {
            let is_trashed_i32: i32 = row.get(14)?;
            Ok(AssetDetail {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                relative_path: row.get(3)?,
                asset_type: row.get(4)?,
                size: row.get(5)?,
                dominant_color: row.get(6)?,
                tags: row.get(7)?,
                description: row.get(8)?,
                rating: row.get(9)?,
                workspace_ids: row.get(10)?,
                created_at: row.get(11)?,
                modified_at: row.get(12)?,
                p_hash: row.get(13)?,
                is_trashed: is_trashed_i32 != 0,
                width: row.get(15)?,
                height: row.get(16)?,
                source_url: row.get(17)?,
                duration: row.get(18)?,
                thumbnail_path: None, // set below
            })
        }).map_err(|e| format!("Asset not found: {}", e))?;

        // Compute thumbnail path
        let thumbnail_path = crate::thumbnails::thumbnail_abs_path(&library_root, &detail.relative_path);
        let thumbnail_path_str = if thumbnail_path.exists() {
            Some(thumbnail_path.to_string_lossy().to_string())
        } else {
            None
        };

        Ok(AssetDetail {
            thumbnail_path: thumbnail_path_str,
            ..detail
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ensure_asset_thumbnail(
    id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<Option<String>, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn.prepare(
            "SELECT path, relative_path, asset_type FROM assets WHERE id = ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let (path, relative_path, asset_type): (String, String, String) = stmt
            .query_row(rusqlite::params![id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("Asset not found: {}", e))?;

        if asset_type != "image" && asset_type != "video" {
            return Ok(None);
        }

        let thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
        if thumb_path.exists() {
            return Ok(Some(thumb_path.to_string_lossy().to_string()));
        }

        let abs_path = std::path::Path::new(&path);
        if !abs_path.exists() {
            return Ok(None);
        }

        let processed = if asset_type == "video" {
            crate::scanner::process_video(&library_root, &relative_path, abs_path)
        } else {
            crate::scanner::process_image(&library_root, &relative_path, abs_path)
        };
        if processed.thumbnail_mtime.is_none() {
            return Ok(None);
        }

        let width = if processed.width > 0 { Some(processed.width) } else { None };
        let height = if processed.height > 0 { Some(processed.height) } else { None };

        conn.execute(
            "UPDATE assets SET dominant_color = ?1, width = ?2, height = ?3, p_hash = ?4, thumbnail_mtime = ?5 WHERE path = ?6",
            rusqlite::params![
                processed.dominant_color,
                width,
                height,
                processed.p_hash,
                processed.thumbnail_mtime,
                path,
            ],
        ).map_err(|e| format!("Failed to update asset thumbnail metadata: {}", e))?;

        if thumb_path.exists() {
            Ok(Some(thumb_path.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn repair_missing_thumbnails(
    limit: Option<u32>,
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let max_items = limit.unwrap_or(1200).clamp(1, 20_000) as i64;

        let mut stmt = conn
            .prepare(
                "SELECT id, path, relative_path, asset_type
                 FROM assets
                 WHERE thumbnail_mtime IS NOT NULL
                   AND asset_type IN ('image', 'video')
                 ORDER BY modified_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Prepare failed: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![max_items], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("Query failed: {}", e))?;

        let mut repaired: u32 = 0;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;
        let mut update_stmt = tx
            .prepare(
                "UPDATE assets
                 SET dominant_color = ?1, width = ?2, height = ?3, p_hash = ?4, thumbnail_mtime = ?5
                 WHERE id = ?6",
            )
            .map_err(|e| format!("Prepare update failed: {}", e))?;
        let mut clear_stmt = tx
            .prepare("UPDATE assets SET thumbnail_mtime = NULL WHERE id = ?1")
            .map_err(|e| format!("Prepare clear failed: {}", e))?;

        for row in rows {
            let (id, abs_path, relative_path, asset_type) =
                row.map_err(|e: rusqlite::Error| format!("Row decode failed: {}", e))?;
            let thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
            if thumb_path.exists() {
                continue;
            }

            let file_path = std::path::Path::new(&abs_path);
            if !file_path.exists() {
                let _ = clear_stmt.execute(rusqlite::params![id]);
                continue;
            }

            let processed = if asset_type == "video" {
                crate::scanner::process_video(&library_root, &relative_path, file_path)
            } else {
                crate::scanner::process_image(&library_root, &relative_path, file_path)
            };

            if processed.thumbnail_mtime.is_none() {
                let _ = clear_stmt.execute(rusqlite::params![id]);
                continue;
            }

            let width = if processed.width > 0 {
                Some(processed.width)
            } else {
                None
            };
            let height = if processed.height > 0 {
                Some(processed.height)
            } else {
                None
            };

            update_stmt
                .execute(rusqlite::params![
                    processed.dominant_color,
                    width,
                    height,
                    processed.p_hash,
                    processed.thumbnail_mtime,
                    id,
                ])
                .map_err(|e| format!("Thumbnail repair update failed: {}", e))?;
            repaired = repaired.saturating_add(1);
        }

        drop(update_stmt);
        drop(clear_stmt);
        tx.commit()
            .map_err(|e| format!("Repair commit failed: {}", e))?;

        Ok(repaired)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ensure_asset_full_preview(
    id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<Option<String>, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn.prepare(
            "SELECT path, relative_path, asset_type FROM assets WHERE id = ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let (path, relative_path, asset_type): (String, String, String) = stmt
            .query_row(rusqlite::params![id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("Asset not found: {}", e))?;

        if asset_type != "image" {
            return Ok(None);
        }

        if !needs_transcoded_preview(&path) {
            return Ok(Some(path));
        }

        let is_clip = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("clip"))
            .unwrap_or(false);
        let is_psd = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("psd") || e.eq_ignore_ascii_case("psb"))
            .unwrap_or(false);

        let abs_path = std::path::Path::new(&path);
        if !abs_path.exists() {
            return Ok(None);
        }

        let preview_path = crate::thumbnails::ensure_preview_dir(&library_root, &relative_path)?;
        if preview_path.exists() {
            let cached_dims = image::image_dimensions(&preview_path).ok();
            let preview_decodable = cached_dims.is_some();
            let preview_quality = if is_clip {
                image::open(&preview_path).ok().map(|img| sampled_image_quality(&img))
            } else {
                None
            };
            let preview_content_valid = if is_clip {
                preview_cache_has_visible_content(&preview_path)
            } else {
                true
            };
            let source_newer_than_preview = match (
                std::fs::metadata(abs_path).and_then(|m| m.modified()),
                std::fs::metadata(&preview_path).and_then(|m| m.modified()),
            ) {
                (Ok(src_mtime), Ok(preview_mtime)) => src_mtime > preview_mtime,
                _ => false,
            };

            if preview_decodable && preview_content_valid && !source_newer_than_preview {
                if let Some((w, h)) = cached_dims {
                    let _ = sync_asset_dimensions(&conn, &path, w, h);
                }
                if is_clip {
                    if let Some((w, h)) = cached_dims {
                        let quality_suffix = preview_quality
                            .map(|(ratio, contrast)| format!(" ratio={:.4} contrast={}", ratio, contrast))
                            .unwrap_or_default();
                        clip_debug!(
                            "[CLIP_DEBUG] cache hit '{}' => {}x{}{}",
                            abs_path.display(),
                            w,
                            h,
                            quality_suffix
                        );
                    } else {
                        clip_debug!(
                            "[CLIP_DEBUG] cache hit '{}' => decodable but dimensions unknown",
                            abs_path.display()
                        );
                    }
                }
                return Ok(Some(preview_path.to_string_lossy().to_string()));
            }

            if is_clip {
                let quality_suffix = preview_quality
                    .map(|(ratio, contrast)| format!(" ratio={:.4} contrast={}", ratio, contrast))
                    .unwrap_or_default();
                clip_debug!(
                    "[CLIP_DEBUG] cache invalid '{}' decodable={} visible={} source_newer={}{}",
                    abs_path.display(),
                    preview_decodable,
                    preview_content_valid,
                    source_newer_than_preview,
                    quality_suffix
                );
            }
            let _ = std::fs::remove_file(&preview_path);
        }

        if is_psd && !psd_decode_enabled_runtime() {
            let thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
            if thumb_path.exists() {
                return Ok(Some(thumb_path.to_string_lossy().to_string()));
            }
            return Ok(None);
        }

        let img = match crate::scanner::open_image_for_full_preview(abs_path) {
            Ok(img) => img,
            Err(full_err) => match crate::scanner::open_image_for_processing(abs_path) {
                Ok(fallback_img) => {
                    eprintln!(
                        "Full preview decode failed for '{}': {}. Falling back to processing preview.",
                        abs_path.display(),
                        full_err
                    );
                    fallback_img
                }
                Err(fallback_err) => {
                    if !(is_psd_stability_skip_error(&full_err)
                        && is_psd_stability_skip_error(&fallback_err))
                    {
                        eprintln!(
                            "Failed to decode full preview for '{}': {}. Fallback failed: {}",
                            abs_path.display(),
                            full_err,
                            fallback_err
                        );
                    }
                    return Ok(None);
                }
            },
        };

        let img = if is_clip && !image_has_visible_content(&img) {
            clip_debug!(
                "[CLIP_DEBUG] generated image is not visually valid for '{}', retrying processing preview",
                abs_path.display()
            );
            match crate::scanner::open_image_for_processing(abs_path) {
                Ok(retry_img) if image_has_visible_content(&retry_img) => retry_img,
                Ok(retry_img) => {
                    clip_debug!(
                        "[CLIP_DEBUG] processing preview also not visually valid for '{}', returning None",
                        abs_path.display()
                    );
                    let _ = retry_img;
                    return Ok(None);
                }
                Err(retry_err) => {
                    clip_debug!(
                        "[CLIP_DEBUG] processing preview retry failed for '{}': {}",
                        abs_path.display(),
                        retry_err
                    );
                    return Ok(None);
                }
            }
        } else {
            img
        };

        if is_clip {
            let (ratio, contrast) = sampled_image_quality(&img);
            clip_debug!(
                "[CLIP_DEBUG] generated preview '{}' => {}x{} ratio={:.4} contrast={}",
                abs_path.display(),
                img.width(),
                img.height(),
                ratio,
                contrast
            );
        }

        let file = std::fs::File::create(&preview_path)
            .map_err(|e| format!("Failed to create preview file: {}", e))?;
        let mut writer = std::io::BufWriter::new(file);
        img.write_to(&mut writer, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to write preview image: {}", e))?;
        let _ = sync_asset_dimensions(&conn, &path, img.width(), img.height());

        Ok(Some(preview_path.to_string_lossy().to_string()))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_asset(
    id: String,
    tags: Option<String>,
    description: Option<String>,
    rating: Option<u8>,
    workspace_ids: Option<String>,
    is_trashed: Option<bool>,
    width: Option<u32>,
    height: Option<u32>,
    source_url: Option<String>,
    duration: Option<f64>,
    created_at: Option<u64>,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Fetch current values
        let mut stmt = conn.prepare(
            "SELECT tags, description, rating, workspace_ids, is_trashed, width, height, source_url, duration, created_at \
             FROM assets WHERE id = ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let current: (Option<String>, Option<String>, Option<u8>, Option<String>, i32, Option<u32>, Option<u32>, Option<String>, Option<f64>, Option<u64>) =
            stmt.query_row(rusqlite::params![id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, i32>(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            }).map_err(|e| format!("Asset not found: {}", e))?;

        // Merge: use new value if provided, otherwise keep current
        let merged_tags = tags.or(current.0);
        let merged_description = description.or(current.1);
        let merged_rating = rating.or(current.2);
        let merged_workspace_ids = workspace_ids.or(current.3);
        let merged_is_trashed: i32 = match is_trashed {
            Some(v) => if v { 1 } else { 0 },
            None => current.4,
        };
        let merged_width = width.or(current.5);
        let merged_height = height.or(current.6);
        let merged_source_url = source_url.or(current.7);
        let merged_duration = duration.or(current.8);
        let merged_created_at = created_at.or(current.9);

        conn.execute(
            "UPDATE assets SET tags = ?1, description = ?2, rating = ?3, workspace_ids = ?4, \
             is_trashed = ?5, width = ?6, height = ?7, source_url = ?8, duration = ?9, created_at = ?10 \
             WHERE id = ?11",
            rusqlite::params![
                merged_tags,
                merged_description,
                merged_rating,
                merged_workspace_ids,
                merged_is_trashed,
                merged_width,
                merged_height,
                merged_source_url,
                merged_duration,
                merged_created_at,
                id,
            ],
        ).map_err(|e| format!("Update failed: {}", e))?;

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn batch_update_asset_tags(
    ids: Vec<String>,
    add_tags: Option<Vec<String>>,
    remove_tags: Option<Vec<String>>,
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let mut add_set = HashSet::new();
        let add_tags_clean: Vec<String> = add_tags
            .unwrap_or_default()
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .filter(|v| add_set.insert(v.clone()))
            .collect();

        let remove_set: HashSet<String> = remove_tags
            .unwrap_or_default()
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect();

        if ids.is_empty() || (add_tags_clean.is_empty() && remove_set.is_empty()) {
            return Ok(0);
        }

        let conn = library::get_db_connection(&db_path)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;

        let mut updated_count: u32 = 0;
        {
            let mut select_stmt = tx
                .prepare("SELECT tags FROM assets WHERE id = ?1")
                .map_err(|e| format!("Prepare select failed: {}", e))?;
            let mut update_stmt = tx
                .prepare("UPDATE assets SET tags = ?1 WHERE id = ?2")
                .map_err(|e| format!("Prepare update failed: {}", e))?;

            for id in ids {
                let current_tags: Option<String> = match select_stmt.query_row(rusqlite::params![id], |row| row.get(0)) {
                    Ok(value) => value,
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(e) => return Err(format!("Read tags failed: {}", e)),
                };

                let mut tags = parse_string_list_json(current_tags.as_deref());

                if !remove_set.is_empty() {
                    tags.retain(|t| !remove_set.contains(t));
                }

                if !add_tags_clean.is_empty() {
                    let mut existing: HashSet<String> = tags.iter().cloned().collect();
                    for tag in &add_tags_clean {
                        if existing.insert(tag.clone()) {
                            tags.push(tag.clone());
                        }
                    }
                }

                let tags_json = serde_json::to_string(&tags).map_err(|e| format!("Serialize tags failed: {}", e))?;
                update_stmt
                    .execute(rusqlite::params![tags_json, id])
                    .map_err(|e| format!("Update tags failed: {}", e))?;
                updated_count = updated_count.saturating_add(1);
            }
        }

        tx.commit()
            .map_err(|e| format!("Commit failed: {}", e))?;

        Ok(updated_count)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn batch_update_asset_workspaces(
    ids: Vec<String>,
    add_workspace_ids: Option<Vec<String>>,
    remove_workspace_ids: Option<Vec<String>>,
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let mut add_set = HashSet::new();
        let add_ws_clean: Vec<String> = add_workspace_ids
            .unwrap_or_default()
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .filter(|v| add_set.insert(v.clone()))
            .collect();

        let remove_set: HashSet<String> = remove_workspace_ids
            .unwrap_or_default()
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect();

        if ids.is_empty() || (add_ws_clean.is_empty() && remove_set.is_empty()) {
            return Ok(0);
        }

        let conn = library::get_db_connection(&db_path)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;

        let mut updated_count: u32 = 0;
        {
            let mut select_stmt = tx
                .prepare("SELECT workspace_ids FROM assets WHERE id = ?1")
                .map_err(|e| format!("Prepare select failed: {}", e))?;
            let mut update_stmt = tx
                .prepare("UPDATE assets SET workspace_ids = ?1 WHERE id = ?2")
                .map_err(|e| format!("Prepare update failed: {}", e))?;

            for id in ids {
                let current_workspaces: Option<String> =
                    match select_stmt.query_row(rusqlite::params![id], |row| row.get(0)) {
                        Ok(value) => value,
                        Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                        Err(e) => return Err(format!("Read workspaces failed: {}", e)),
                    };

                let mut workspaces = parse_string_list_json(current_workspaces.as_deref());

                if !remove_set.is_empty() {
                    workspaces.retain(|w| !remove_set.contains(w));
                }

                if !add_ws_clean.is_empty() {
                    let mut existing: HashSet<String> = workspaces.iter().cloned().collect();
                    for ws in &add_ws_clean {
                        if existing.insert(ws.clone()) {
                            workspaces.push(ws.clone());
                        }
                    }
                }

                let ws_json =
                    serde_json::to_string(&workspaces).map_err(|e| format!("Serialize workspaces failed: {}", e))?;
                update_stmt
                    .execute(rusqlite::params![ws_json, id])
                    .map_err(|e| format!("Update workspaces failed: {}", e))?;
                updated_count = updated_count.saturating_add(1);
            }
        }

        tx.commit()
            .map_err(|e| format!("Commit failed: {}", e))?;

        Ok(updated_count)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_assets(
    ids: Vec<String>,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let tx = conn.unchecked_transaction().map_err(|e| format!("Transaction begin failed: {}", e))?;

        if !ids.is_empty() {
            // Delete one-by-one in a single transaction to avoid SQLite variable limits.
            let mut delete_stmt = tx
                .prepare("DELETE FROM assets WHERE id = ?1")
                .map_err(|e| format!("Prepare delete failed: {}", e))?;

            for id in ids {
                delete_stmt
                    .execute(rusqlite::params![id])
                    .map_err(|e| format!("Delete failed: {}", e))?;
            }
        }

        tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
        crate::scanner::rebuild_folders(&conn, &library_root)?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folders(
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut folder_stmt = conn
            .prepare("SELECT path, parent_path, display_name, asset_count, COALESCE(show_subfolders, 1) FROM folders ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = folder_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut folder_rows = Vec::new();
        let mut normalized_folder_set = std::collections::HashSet::new();
        for row in rows {
            let (path, parent_path, display_name, asset_count, show_subfolders_i32) =
                row.map_err(|e: rusqlite::Error| e.to_string())?;
            let normalized_path = path.replace('\\', "/");
            let normalized_parent_path = parent_path.map(|p| p.replace('\\', "/"));
            normalized_folder_set.insert(normalized_path.clone());
            folder_rows.push((
                normalized_path,
                normalized_parent_path,
                display_name,
                asset_count,
                show_subfolders_i32,
            ));
        }

        let mut preview_by_folder: std::collections::HashMap<
            String,
            (Option<String>, Option<String>, Option<String>),
        > = std::collections::HashMap::new();

        let mut assets_stmt = conn
            .prepare(
                "SELECT path, relative_path, asset_type, thumbnail_mtime
                 FROM assets
                 WHERE asset_type IN ('image', 'video')
                 ORDER BY modified_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let asset_rows = assets_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let preview_target_count = normalized_folder_set.len();

        for asset_row in asset_rows {
            let (asset_path, relative_path, asset_type, thumbnail_mtime) =
                asset_row.map_err(|e: rusqlite::Error| e.to_string())?;
            let normalized_relative_path = relative_path.replace('\\', "/");
            let Some(last_sep_idx) = normalized_relative_path.rfind('/') else {
                continue;
            };

            let mut folder_cursor = normalized_relative_path[..last_sep_idx].to_string();
            if folder_cursor.is_empty() {
                continue;
            }

            let preview_thumbnail_path = if thumbnail_mtime.is_some() {
                // Keep compatibility with historical relative_path formats.
                let thumb_from_raw = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
                let thumb_from_normalized = crate::thumbnails::thumbnail_abs_path(&library_root, &normalized_relative_path);

                if thumb_from_raw.exists() {
                    Some(thumb_from_raw.to_string_lossy().to_string())
                } else if thumb_from_normalized.exists() {
                    Some(thumb_from_normalized.to_string_lossy().to_string())
                } else {
                    None
                }
            } else {
                None
            };
            let preview_asset_path = if preview_thumbnail_path.is_none() && asset_type == "image" {
                Some(asset_path.clone())
            } else {
                None
            };
            let preview_payload = (
                preview_thumbnail_path,
                preview_asset_path,
                Some(asset_type),
            );

            loop {
                if normalized_folder_set.contains(&folder_cursor) {
                    preview_by_folder
                        .entry(folder_cursor.clone())
                        .or_insert_with(|| preview_payload.clone());
                }

                if let Some(parent_idx) = folder_cursor.rfind('/') {
                    folder_cursor.truncate(parent_idx);
                    if folder_cursor.is_empty() {
                        break;
                    }
                } else {
                    break;
                }
            }

            if preview_by_folder.len() >= preview_target_count {
                break;
            }
        }

        let mut folders = Vec::new();
        for (normalized_path, normalized_parent_path, display_name, asset_count, show_subfolders_i32) in folder_rows {
            let (preview_thumbnail_path, preview_asset_path, preview_asset_type) =
                preview_by_folder
                    .get(&normalized_path)
                    .cloned()
                    .unwrap_or((None, None, None));
            folders.push(serde_json::json!({
                "path": normalized_path,
                "parent_path": normalized_parent_path,
                "display_name": display_name,
                "asset_count": asset_count,
                "show_subfolders": show_subfolders_i32 != 0,
                "preview_thumbnail_path": preview_thumbnail_path,
                "preview_asset_path": preview_asset_path,
                "preview_asset_type": preview_asset_type,
            }));
        }

        Ok(folders)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_folder_show_subfolders(
    folder_path: String,
    show_subfolders: bool,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let normalized_folder = folder_path.replace('\\', "/").trim_matches('/').to_string();
        conn.execute(
            "UPDATE folders SET show_subfolders = ?1 WHERE REPLACE(path, char(92), '/') = ?2",
            rusqlite::params![show_subfolders as i32, normalized_folder],
        ).map_err(|e| format!("Failed to update folder show_subfolders: {}", e))?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_watcher(
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let library_root = get_library_root(&state)?;
    let db_path = get_db_path(&state)?;

    let mut watcher_lock = state.watcher_handle.lock().map_err(|e| e.to_string())?;

    // Stop existing watcher if any
    *watcher_lock = None;

    let library_root_for_cb = library_root.clone();
    let db_path_for_cb = db_path.clone();
    let app_handle_clone = app_handle.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        match res {
            Ok(event) => {
                let is_relevant_kind = matches!(
                    event.kind,
                    notify::EventKind::Create(_)
                        | notify::EventKind::Modify(_)
                        | notify::EventKind::Remove(_)
                );
                if !is_relevant_kind || event.paths.is_empty() {
                    return;
                }

                let paths = event.paths.clone();
                let root = library_root_for_cb.clone();
                let db = db_path_for_cb.clone();
                let app = app_handle_clone.clone();

                std::thread::spawn(move || {
                    let conn = match library::get_db_connection(&db) {
                        Ok(c) => c,
                        Err(e) => {
                            log::warn!("Watcher DB open failed: {}", e);
                            return;
                        }
                    };

                    let mut changed = false;

                    for path in &paths {
                        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                        // Skip .quickasset internals / DB files / hidden files
                        if path.to_string_lossy().contains(".quickasset")
                            || file_name.ends_with(".db")
                            || file_name.ends_with("-journal")
                            || file_name.starts_with('.')
                        {
                            continue;
                        }

                        if path.exists() && path.is_file() {
                            if crate::scanner::process_single_file(&conn, &root, path).is_ok() {
                                changed = true;
                            }
                        } else {
                            let id = path.to_string_lossy().to_string();
                            if conn
                                .execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id])
                                .is_ok()
                            {
                                changed = true;
                            }
                        }
                    }

                    if changed {
                        let _ = crate::scanner::rebuild_folders(&conn, &root);
                        let _ = app.emit("fs-event", serde_json::json!({ "event_type": "sync" }));
                    }
                });
            }
            Err(e) => {
                log::warn!("Watch error: {:?}", e);
            }
        }
    }).map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher.watch(&library_root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to start watching: {}", e))?;

    *watcher_lock = Some(watcher);
    Ok(())
}

#[tauri::command]
pub async fn migrate_hashed(
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Find image assets with no p_hash
        let mut stmt = conn.prepare(
            "SELECT id, path, relative_path FROM assets WHERE asset_type = 'image' AND (p_hash IS NULL OR p_hash = '')"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let rows: Vec<(String, String, String)> = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let total = rows.len() as u32;
        let mut migrated: u32 = 0;
        let mut processed: u32 = 0;

        if total > 0 {
            let _ = app_handle.emit("migrate-progress", serde_json::json!({
                "migrated": 0,
                "total": total,
            }));
        }

        for (_i, (id, path_str, rel_path)) in rows.iter().enumerate() {
            let abs_path = std::path::Path::new(path_str);
            let mut migrated_this_item = false;

            if abs_path.exists() {
                if let Ok(img) = crate::scanner::open_image_for_processing(abs_path) {
                    // Compute pHash
                    let hasher = image_hasher::HasherConfig::new()
                        .hash_alg(image_hasher::HashAlg::Gradient)
                        .to_hasher();
                    let hash = hasher.hash_image(&img);
                    let p_hash_b64 = hash.to_base64();

                    // Extract dimensions and dominant color
                    let width = img.width();
                    let height = img.height();
                    let dominant_color = {
                        let tiny = img.thumbnail(16, 16);
                        let mut r_sum: u64 = 0;
                        let mut g_sum: u64 = 0;
                        let mut b_sum: u64 = 0;
                        let mut count: u64 = 0;
                        for pixel in tiny.pixels() {
                            let rgba = pixel.2;
                            if rgba[3] < 128 { continue; }
                            r_sum += rgba[0] as u64;
                            g_sum += rgba[1] as u64;
                            b_sum += rgba[2] as u64;
                            count += 1;
                        }
                        if count > 0 {
                            Some(format!("#{:02x}{:02x}{:02x}", (r_sum/count) as u8, (g_sum/count) as u8, (b_sum/count) as u8))
                        } else { None }
                    };

                    // Generate thumbnail
                    let thumb_path = crate::thumbnails::ensure_thumbnail_dir(&library_root, rel_path);
                    if let Ok(tp) = thumb_path {
                        let thumb_img = img.thumbnail(256, 256);
                        if let Ok(file) = std::fs::File::create(&tp) {
                            let mut writer = std::io::BufWriter::new(file);
                            let _ = thumb_img.write_to(&mut writer, image::ImageFormat::Png);
                        }
                    }

                    // Update DB
                    conn.execute(
                        "UPDATE assets SET p_hash = ?1, width = ?2, height = ?3, dominant_color = COALESCE(dominant_color, ?4) WHERE id = ?5",
                        rusqlite::params![p_hash_b64, width, height, dominant_color, id],
                    ).map_err(|e| format!("Update failed for {}: {}", id, e))?;

                    migrated += 1;
                    migrated_this_item = true;
                }
            }

            if !migrated_this_item {
                log::debug!("Skip hash migration for asset '{}': decode failed or source missing", id);
            }

            processed += 1;

            // Progress should represent processed workload, not only successful migrations.
            if processed % 10 == 0 || processed == total {
                let _ = app_handle.emit("migrate-progress", serde_json::json!({
                    "migrated": processed,
                    "total": total,
                }));
            }
        }

        // Final progress event to ensure UI can complete and auto-dismiss.
        let _ = app_handle.emit("migrate-progress", serde_json::json!({
            "migrated": total,
            "total": total,
        }));

        Ok(migrated)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_tags_summary(
    state: State<'_, crate::library::AppState>,
) -> Result<std::collections::HashMap<String, u32>, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn
            .prepare("SELECT tag, COUNT(*) FROM asset_tags GROUP BY tag")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .map_err(|e| e.to_string())?;

        let mut tag_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

        for row in rows {
            let (tag, count) = row.map_err(|e: rusqlite::Error| e.to_string())?;
            tag_counts.insert(tag, count);
        }

        Ok(tag_counts)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_workspace(
    name: String,
    state: State<'_, crate::library::AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = get_db_path(&state)?;
    let conn = library::get_db_connection(&db_path)?;

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = library::now_secs();

    conn.execute(
        "INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, name, created_at],
    ).map_err(|e| format!("Failed to create workspace: {}", e))?;

    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "created_at": created_at,
    }))
}

#[tauri::command]
pub async fn update_workspace(
    id: String,
    name: String,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;
    let conn = library::get_db_connection(&db_path)?;

    conn.execute(
        "UPDATE workspaces SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    ).map_err(|e| format!("Failed to update workspace: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_workspace(
    id: String,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;
    let conn = library::get_db_connection(&db_path)?;

    conn.execute(
        "DELETE FROM workspaces WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| format!("Failed to delete workspace: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_workspaces(
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let db_path = get_db_path(&state)?;
    let conn = library::get_db_connection(&db_path)?;

    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM workspaces ORDER BY created_at")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let created_at: u64 = row.get(2)?;
            Ok(serde_json::json!({
                "id": id,
                "name": name,
                "created_at": created_at,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut workspaces = Vec::new();
    for row in rows {
        workspaces.push(row.map_err(|e: rusqlite::Error| e.to_string())?);
    }

    Ok(workspaces)
}

#[tauri::command]
pub async fn get_library_stats(
    state: State<'_, crate::library::AppState>,
) -> Result<serde_json::Value, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let (active_count, total_size): (u64, u64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM assets WHERE is_trashed = 0",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("Failed to query active stats: {}", e))?;

        let trashed_count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE is_trashed = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to query trash stats: {}", e))?;

        Ok(serde_json::json!({
            "active_count": active_count,
            "trashed_count": trashed_count,
            "total_size": total_size,
        }))
    }).await.map_err(|e| e.to_string())?
}

struct SimilarScanRow {
    item: SimilarAssetItem,
    hash: image_hasher::ImageHash<Vec<u8>>,
}

struct BkNode {
    asset_index: usize,
    children: Vec<(u32, usize)>,
}

struct BkTree {
    root: Option<usize>,
    nodes: Vec<BkNode>,
}

impl BkTree {
    fn new() -> Self {
        Self {
            root: None,
            nodes: Vec::new(),
        }
    }

    fn insert(&mut self, asset_index: usize, hashes: &[image_hasher::ImageHash<Vec<u8>>]) {
        let Some(root_idx) = self.root else {
            self.nodes.push(BkNode {
                asset_index,
                children: Vec::new(),
            });
            self.root = Some(0);
            return;
        };

        let hash = &hashes[asset_index];
        let mut current_idx = root_idx;
        loop {
            let dist = hash.dist(&hashes[self.nodes[current_idx].asset_index]);

            if let Some((_, child_idx)) = self.nodes[current_idx]
                .children
                .iter()
                .find(|(edge_dist, _)| *edge_dist == dist)
            {
                current_idx = *child_idx;
                continue;
            }

            let next_idx = self.nodes.len();
            self.nodes.push(BkNode {
                asset_index,
                children: Vec::new(),
            });
            self.nodes[current_idx].children.push((dist, next_idx));
            break;
        }
    }

    fn search(
        &self,
        query_index: usize,
        radius: u32,
        hashes: &[image_hasher::ImageHash<Vec<u8>>],
        out_indices: &mut Vec<usize>,
    ) {
        let Some(root_idx) = self.root else {
            return;
        };

        let query_hash = &hashes[query_index];
        let mut stack = vec![root_idx];
        while let Some(node_idx) = stack.pop() {
            let node = &self.nodes[node_idx];
            let dist = query_hash.dist(&hashes[node.asset_index]);
            if dist <= radius {
                out_indices.push(node.asset_index);
            }

            let lower = dist.saturating_sub(radius);
            let upper = dist.saturating_add(radius);
            for (edge_dist, child_idx) in &node.children {
                if *edge_dist >= lower && *edge_dist <= upper {
                    stack.push(*child_idx);
                }
            }
        }
    }
}

struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
            rank: vec![0; size],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            let root = self.find(self.parent[x]);
            self.parent[x] = root;
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let mut ra = self.find(a);
        let mut rb = self.find(b);
        if ra == rb {
            return;
        }
        if self.rank[ra] < self.rank[rb] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb] = ra;
        if self.rank[ra] == self.rank[rb] {
            self.rank[ra] = self.rank[ra].saturating_add(1);
        }
    }
}

fn opt_i64_to_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|v| {
        if v > 0 && v <= u32::MAX as i64 {
            Some(v as u32)
        } else {
            None
        }
    })
}

fn keep_candidate_cmp(a: &SimilarAssetItem, b: &SimilarAssetItem) -> Ordering {
    let a_pixels = a.width.unwrap_or(0) as u64 * a.height.unwrap_or(0) as u64;
    let b_pixels = b.width.unwrap_or(0) as u64 * b.height.unwrap_or(0) as u64;

    a_pixels
        .cmp(&b_pixels)
        .then_with(|| a.size.cmp(&b.size))
        .then_with(|| a.rating.unwrap_or(0).cmp(&b.rating.unwrap_or(0)))
        .then_with(|| a.modified_at.cmp(&b.modified_at))
        .then_with(|| a.created_at.cmp(&b.created_at))
        .then_with(|| b.id.cmp(&a.id))
}

fn suggested_keep_index(indices: &[usize], items: &[SimilarAssetItem]) -> usize {
    let mut best_idx = indices[0];
    for idx in indices.iter().copied().skip(1) {
        if keep_candidate_cmp(&items[idx], &items[best_idx]).is_gt() {
            best_idx = idx;
        }
    }
    best_idx
}

#[tauri::command]
pub async fn find_similar_groups(
    threshold: u32,
    max_groups: Option<u32>,
    state: State<'_, crate::library::AppState>,
) -> Result<SimilarGroupsResult, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let threshold_dist = threshold.min(64);
        let limit_groups = max_groups.unwrap_or(300).clamp(1, 5000) as usize;

        let mut stmt = conn
            .prepare(
                "SELECT id, name, path, relative_path, size, width, height, created_at, modified_at, rating, p_hash
                 FROM assets
                 WHERE is_trashed = 0
                   AND asset_type = 'image'
                   AND p_hash IS NOT NULL
                   AND p_hash != ''",
            )
            .map_err(|e| format!("Prepare similar scan failed: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let name: String = row.get(1)?;
                let path: String = row.get(2)?;
                let relative_path: String = row.get(3)?;
                let size_i64: i64 = row.get(4)?;
                let width_i64: Option<i64> = row.get(5)?;
                let height_i64: Option<i64> = row.get(6)?;
                let created_at: u64 = row.get(7)?;
                let modified_at: u64 = row.get(8)?;
                let rating: Option<u8> = row.get(9)?;
                let p_hash: String = row.get(10)?;
                Ok((
                    id,
                    name,
                    path,
                    relative_path,
                    size_i64,
                    width_i64,
                    height_i64,
                    created_at,
                    modified_at,
                    rating,
                    p_hash,
                ))
            })
            .map_err(|e| format!("Query similar scan failed: {}", e))?;

        let mut rows_decoded: Vec<SimilarScanRow> = Vec::new();
        for row in rows {
            let (
                id,
                name,
                path,
                relative_path,
                size_i64,
                width_i64,
                height_i64,
                created_at,
                modified_at,
                rating,
                p_hash_b64,
            ) = row.map_err(|e: rusqlite::Error| e.to_string())?;

            let Ok(hash) = image_hasher::ImageHash::<Vec<u8>>::from_base64(&p_hash_b64) else {
                continue;
            };

            let size = if size_i64 > 0 { size_i64 as u64 } else { 0 };
            let thumb_path = crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
            let thumbnail_path = if thumb_path.exists() {
                Some(thumb_path.to_string_lossy().to_string())
            } else {
                None
            };

            rows_decoded.push(SimilarScanRow {
                item: SimilarAssetItem {
                    id,
                    name,
                    path,
                    relative_path,
                    size,
                    width: opt_i64_to_u32(width_i64),
                    height: opt_i64_to_u32(height_i64),
                    created_at,
                    modified_at,
                    rating,
                    thumbnail_path,
                },
                hash,
            });
        }

        let total_images_scanned = rows_decoded.len() as u32;
        if rows_decoded.len() < 2 {
            return Ok(SimilarGroupsResult {
                threshold: threshold_dist,
                total_images_scanned,
                groups_count: 0,
                duplicate_assets_count: 0,
                reclaimable_size: 0,
                groups: Vec::new(),
            });
        }

        let items: Vec<SimilarAssetItem> = rows_decoded.iter().map(|r| r.item.clone()).collect();
        let hashes: Vec<image_hasher::ImageHash<Vec<u8>>> =
            rows_decoded.into_iter().map(|r| r.hash).collect();

        let mut tree = BkTree::new();
        let mut uf = UnionFind::new(items.len());
        let mut candidates = Vec::new();

        for idx in 0..items.len() {
            tree.search(idx, threshold_dist, &hashes, &mut candidates);
            for other_idx in candidates.drain(..) {
                if other_idx == idx {
                    continue;
                }
                if hashes[idx].dist(&hashes[other_idx]) <= threshold_dist {
                    uf.union(idx, other_idx);
                }
            }
            tree.insert(idx, &hashes);
        }

        let mut grouped: HashMap<usize, Vec<usize>> = HashMap::new();
        for idx in 0..items.len() {
            let root = uf.find(idx);
            grouped.entry(root).or_default().push(idx);
        }

        let mut groups: Vec<SimilarGroup> = Vec::new();
        for member_indices in grouped.into_values() {
            if member_indices.len() < 2 {
                continue;
            }

            let keep_idx = suggested_keep_index(&member_indices, &items);
            let keep_id = items[keep_idx].id.clone();
            let mut members = member_indices
                .iter()
                .map(|idx| items[*idx].clone())
                .collect::<Vec<_>>();
            members.sort_by(|a, b| keep_candidate_cmp(b, a));

            let mut reclaimable_size: u64 = 0;
            let mut suggested_delete_ids = Vec::new();
            for idx in member_indices {
                if idx == keep_idx {
                    continue;
                }
                reclaimable_size = reclaimable_size.saturating_add(items[idx].size);
                suggested_delete_ids.push(items[idx].id.clone());
            }

            groups.push(SimilarGroup {
                group_id: String::new(),
                members,
                suggested_keep_id: keep_id,
                suggested_delete_ids,
                reclaimable_size,
            });
        }

        groups.sort_by(|a, b| {
            b.reclaimable_size
                .cmp(&a.reclaimable_size)
                .then_with(|| b.members.len().cmp(&a.members.len()))
        });
        if groups.len() > limit_groups {
            groups.truncate(limit_groups);
        }
        for (idx, group) in groups.iter_mut().enumerate() {
            group.group_id = format!("group-{}", idx + 1);
        }

        let groups_count = groups.len() as u32;
        let duplicate_assets_count = groups
            .iter()
            .map(|g| g.suggested_delete_ids.len() as u32)
            .sum();
        let reclaimable_size = groups.iter().map(|g| g.reclaimable_size).sum();

        Ok(SimilarGroupsResult {
            threshold: threshold_dist,
            total_images_scanned,
            groups_count,
            duplicate_assets_count,
            reclaimable_size,
            groups,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_similar_dedupe(
    delete_ids: Vec<String>,
    delete_files: Option<bool>,
    state: State<'_, crate::library::AppState>,
) -> Result<SimilarApplyResult, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let should_delete_files = delete_files.unwrap_or(true);
        let mut seen = HashSet::new();
        let deduped_ids: Vec<String> = delete_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .filter(|id| seen.insert(id.clone()))
            .collect();

        if deduped_ids.is_empty() {
            return Ok(SimilarApplyResult {
                deleted_count: 0,
                failed_ids: Vec::new(),
            });
        }

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;

        let mut deleted_count: u32 = 0;
        let mut failed_ids = Vec::new();
        {
            let mut select_stmt = tx
                .prepare("SELECT path, relative_path FROM assets WHERE id = ?1")
                .map_err(|e| format!("Prepare select failed: {}", e))?;
            let mut delete_stmt = tx
                .prepare("DELETE FROM assets WHERE id = ?1")
                .map_err(|e| format!("Prepare delete failed: {}", e))?;

            for id in deduped_ids {
                let (abs_path, relative_path): (String, String) = match select_stmt.query_row(rusqlite::params![&id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                }) {
                    Ok(values) => values,
                    Err(rusqlite::Error::QueryReturnedNoRows) => {
                        failed_ids.push(id);
                        continue;
                    }
                    Err(e) => return Err(format!("Read asset for dedupe failed: {}", e)),
                };

                if should_delete_files {
                    let file_path = std::path::Path::new(&abs_path);
                    if file_path.exists() {
                        if let Err(e) = std::fs::remove_file(file_path) {
                            log::warn!("Failed to delete duplicate file '{}': {}", abs_path, e);
                            failed_ids.push(id);
                            continue;
                        }
                    }
                }

                match delete_stmt.execute(rusqlite::params![&id]) {
                    Ok(affected) if affected > 0 => {
                        deleted_count = deleted_count.saturating_add(1);
                        let thumb_path =
                            crate::thumbnails::thumbnail_abs_path(&library_root, &relative_path);
                        let _ = std::fs::remove_file(&thumb_path);
                    }
                    Ok(_) => {
                        failed_ids.push(id);
                    }
                    Err(_) => {
                        failed_ids.push(id);
                    }
                }
            }
        }

        tx.commit()
            .map_err(|e| format!("Commit failed: {}", e))?;
        crate::scanner::rebuild_folders(&conn, &library_root)?;

        Ok(SimilarApplyResult {
            deleted_count,
            failed_ids,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_similar_images(
    target_id: String,
    threshold: u32,
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Get target metadata and existing hash.
        let (target_path, target_relative_path, target_asset_type, target_hash_str): (String, String, String, Option<String>) = conn.query_row(
            "SELECT path, relative_path, asset_type, p_hash FROM assets WHERE id = ?1",
            rusqlite::params![target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).map_err(|e| format!("Target asset not found: {}", e))?;

        let mut target_hash = target_hash_str
            .as_deref()
            .and_then(|hash| image_hasher::ImageHash::<Vec<u8>>::from_base64(hash).ok());

        // Historical data may contain missing/corrupt p_hash for newly imported files.
        // Recompute once on demand so similarity search remains symmetric.
        if target_hash.is_none() && (target_asset_type == "image" || target_asset_type == "video") {
            let target_abs_path = Path::new(&target_path);
            if target_abs_path.exists() {
                let processed = if target_asset_type == "video" {
                    crate::scanner::process_video(&library_root, &target_relative_path, target_abs_path)
                } else {
                    crate::scanner::process_image(&library_root, &target_relative_path, target_abs_path)
                };

                if let Some(rebuilt_hash_b64) = processed.p_hash {
                    if let Ok(decoded_hash) = image_hasher::ImageHash::<Vec<u8>>::from_base64(&rebuilt_hash_b64) {
                        let width = if processed.width > 0 { Some(processed.width) } else { None };
                        let height = if processed.height > 0 { Some(processed.height) } else { None };
                        conn.execute(
                            "UPDATE assets
                             SET dominant_color = ?1,
                                 width = ?2,
                                 height = ?3,
                                 p_hash = ?4,
                                 thumbnail_mtime = COALESCE(?5, thumbnail_mtime)
                             WHERE id = ?6",
                            rusqlite::params![
                                processed.dominant_color,
                                width,
                                height,
                                rebuilt_hash_b64,
                                processed.thumbnail_mtime,
                                target_id,
                            ],
                        ).map_err(|e| format!("Failed to update rebuilt target hash: {}", e))?;
                        target_hash = Some(decoded_hash);
                    }
                }
            }
        }

        let target_hash = target_hash
            .ok_or_else(|| "Target asset has no valid perceptual hash".to_string())?;

        let threshold_dist = threshold;

        // Query all image/video assets. Candidate hashes may be missing/corrupt in historical data,
        // so rebuild on demand to keep similarity search symmetric.
        let mut stmt = conn.prepare(
            "SELECT id, path, relative_path, asset_type, p_hash
             FROM assets
             WHERE id != ?1
               AND asset_type IN ('image', 'video')"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let rows = stmt.query_map(rusqlite::params![target_id], |row| {
            let id: String = row.get(0)?;
            let path: String = row.get(1)?;
            let relative_path: String = row.get(2)?;
            let asset_type: String = row.get(3)?;
            let hash_b64: Option<String> = row.get(4)?;
            Ok((id, path, relative_path, asset_type, hash_b64))
        }).map_err(|e| format!("Query failed: {}", e))?;

        let mut similar_ids = Vec::new();
        for row in rows {
            if let Ok((id, path, relative_path, asset_type, hash_b64)) = row {
                let mut other_hash = hash_b64
                    .as_deref()
                    .and_then(|value| {
                        if value.trim().is_empty() {
                            None
                        } else {
                            image_hasher::ImageHash::<Vec<u8>>::from_base64(value).ok()
                        }
                    });

                if other_hash.is_none() {
                    let candidate_abs_path = Path::new(&path);
                    if candidate_abs_path.exists() {
                        let processed = if asset_type == "video" {
                            crate::scanner::process_video(&library_root, &relative_path, candidate_abs_path)
                        } else {
                            crate::scanner::process_image(&library_root, &relative_path, candidate_abs_path)
                        };

                        if let Some(rebuilt_hash_b64) = processed.p_hash {
                            if let Ok(decoded_hash) = image_hasher::ImageHash::<Vec<u8>>::from_base64(&rebuilt_hash_b64) {
                                let width = if processed.width > 0 { Some(processed.width) } else { None };
                                let height = if processed.height > 0 { Some(processed.height) } else { None };
                                let _ = conn.execute(
                                    "UPDATE assets
                                     SET dominant_color = ?1,
                                         width = ?2,
                                         height = ?3,
                                         p_hash = ?4,
                                         thumbnail_mtime = COALESCE(?5, thumbnail_mtime)
                                     WHERE id = ?6",
                                    rusqlite::params![
                                        processed.dominant_color,
                                        width,
                                        height,
                                        rebuilt_hash_b64,
                                        processed.thumbnail_mtime,
                                        id,
                                    ],
                                );
                                other_hash = Some(decoded_hash);
                            }
                        }
                    }
                }

                if let Some(other_hash) = other_hash {
                    if target_hash.dist(&other_hash) <= threshold_dist {
                        similar_ids.push(id);
                    }
                }
            }
        }

        Ok(similar_ids)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rebuild_all_thumbnails(
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let assets: Vec<(String, String, String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, path, relative_path, asset_type
                     FROM assets
                     WHERE is_trashed = 0
                       AND asset_type IN ('image', 'video')
                     ORDER BY modified_at DESC",
                )
                .map_err(|e| format!("Prepare failed: {}", e))?;
            let rows = stmt
                .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
                .map_err(|e| format!("Query failed: {}", e))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;
        let mut update_stmt = tx
            .prepare(
                "UPDATE assets
                 SET dominant_color = ?1, width = ?2, height = ?3, p_hash = ?4, thumbnail_mtime = ?5
                 WHERE id = ?6",
            )
            .map_err(|e| format!("Prepare update failed: {}", e))?;
        let mut clear_stmt = tx
            .prepare("UPDATE assets SET thumbnail_mtime = NULL WHERE id = ?1")
            .map_err(|e| format!("Prepare clear failed: {}", e))?;

        let mut rebuilt_count: u32 = 0;
        for (id, abs_path, relative_path, asset_type) in assets {
            let file_path = std::path::Path::new(&abs_path);
            if !file_path.exists() {
                let _ = clear_stmt.execute(rusqlite::params![id]);
                continue;
            }

            let processed = if asset_type == "video" {
                crate::scanner::process_video(&library_root, &relative_path, file_path)
            } else {
                crate::scanner::process_image(&library_root, &relative_path, file_path)
            };

            if processed.thumbnail_mtime.is_none() {
                let _ = clear_stmt.execute(rusqlite::params![id]);
                continue;
            }

            let width = if processed.width > 0 {
                Some(processed.width)
            } else {
                None
            };
            let height = if processed.height > 0 {
                Some(processed.height)
            } else {
                None
            };

            update_stmt
                .execute(rusqlite::params![
                    processed.dominant_color,
                    width,
                    height,
                    processed.p_hash,
                    processed.thumbnail_mtime,
                    id,
                ])
                .map_err(|e| format!("Thumbnail rebuild update failed: {}", e))?;
            rebuilt_count = rebuilt_count.saturating_add(1);
        }

        drop(update_stmt);
        drop(clear_stmt);
        tx.commit()
            .map_err(|e| format!("Rebuild commit failed: {}", e))?;

        Ok(rebuilt_count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rebuild_search_index(
    state: State<'_, crate::library::AppState>,
) -> Result<u32, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Transaction begin failed: {}", e))?;

        tx.execute_batch(
            "DELETE FROM asset_tags;
             DELETE FROM asset_workspaces;

             INSERT OR IGNORE INTO asset_tags(asset_id, tag)
             SELECT
                 a.id,
                 TRIM(CAST(j.value AS TEXT)) AS tag
             FROM assets AS a
             JOIN json_each(
                 CASE
                     WHEN json_valid(a.tags) THEN a.tags
                     ELSE '[]'
                 END
             ) AS j
             WHERE TRIM(CAST(j.value AS TEXT)) != '';

             INSERT OR IGNORE INTO asset_workspaces(asset_id, workspace_id)
             SELECT
                 a.id,
                 TRIM(CAST(j.value AS TEXT)) AS workspace_id
             FROM assets AS a
             JOIN json_each(
                 CASE
                     WHEN json_valid(a.workspace_ids) THEN a.workspace_ids
                     ELSE '[]'
                 END
             ) AS j
             WHERE TRIM(CAST(j.value AS TEXT)) != '';

             DELETE FROM assets_fts;
             INSERT INTO assets_fts(rowid, asset_id, name, relative_path)
             SELECT
                 rowid,
                 id,
                 name,
                 REPLACE(relative_path, char(92), '/')
             FROM assets;",
        )
        .map_err(|e| format!("Failed to rebuild index tables: {}", e))?;

        let total_assets: i64 = tx
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count assets: {}", e))?;

        tx.commit()
            .map_err(|e| format!("Reindex commit failed: {}", e))?;

        Ok(total_assets.max(0) as u32)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn check_health(
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn
            .prepare("SELECT id, path FROM assets")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                Ok((id, path))
            })
            .map_err(|e| e.to_string())?;

        let mut missing = Vec::new();
        for row in rows {
            let (id, path) = row.map_err(|e: rusqlite::Error| e.to_string())?;
            if !std::path::Path::new(&path).exists() {
                missing.push(id);
            }
        }

        Ok(missing)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("Path does not exist: {}", path));
        }

        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| format!("Failed to open explorer: {}", e))?;
        }

        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| format!("Failed to open Finder: {}", e))?;
        }

        #[cfg(target_os = "linux")]
        {
            if let Some(parent) = p.parent() {
                std::process::Command::new("xdg-open")
                    .arg(parent)
                    .spawn()
                    .map_err(|e| format!("Failed to open file manager: {}", e))?;
            }
        }

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_in_default_app(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_asset(
    id: String,
    new_name: String,
    state: State<'_, crate::library::AppState>,
) -> Result<String, String> {
    let db_path = get_db_path(&state)?;
    let library_root = get_library_root(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Get current path and relative_path
        let mut stmt = conn.prepare("SELECT path, relative_path FROM assets WHERE id = ?1")
            .map_err(|e| format!("Prepare failed: {}", e))?;

        let (current_path, _relative_path): (String, String) = stmt
            .query_row(rusqlite::params![id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("Asset not found: {}", e))?;

        let current = std::path::Path::new(&current_path);
        let parent = current.parent().ok_or("Cannot determine parent directory")?;
        let new_path = parent.join(&new_name);

        // Rename on disk
        std::fs::rename(current, &new_path)
            .map_err(|e| format!("Failed to rename file on disk: {}", e))?;

        // Compute new relative path
        let new_relative = new_path.strip_prefix(&library_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(new_name.clone());

        let new_path_str = new_path.to_string_lossy().to_string();

        // Update DB: need to delete old row and insert new one since id (path) is changing
        conn.execute(
            "UPDATE assets SET id = ?1, path = ?2, name = ?3, relative_path = ?4 WHERE id = ?5",
            rusqlite::params![new_path_str, new_path_str, new_name, new_relative, id],
        ).map_err(|e| format!("Failed to update DB: {}", e))?;

        Ok(new_path_str)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_file_text(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file: {}", e))
    }).await.map_err(|e| e.to_string())?
}
