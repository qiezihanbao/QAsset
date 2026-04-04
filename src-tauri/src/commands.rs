use crate::models::*;
use crate::library;
use tauri::{Manager, State};
use std::path::PathBuf;
use image_hasher;

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

#[tauri::command]
pub async fn create_library(
    path: String,
    name: String,
    state: State<'_, crate::library::AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
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
pub async fn query_assets(
    filters: AssetFilters,
    state: State<'_, crate::library::AppState>,
) -> Result<QueryResult, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Build dynamic WHERE clause
        let mut where_clauses: Vec<String> = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref sq) = filters.search_query {
            if !sq.is_empty() {
                where_clauses.push("name LIKE '%' || ? || '%'".to_string());
                param_values.push(Box::new(sq.clone()));
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
            where_clauses.push("workspace_ids LIKE ?".to_string());
            param_values.push(Box::new(format!("%\"{}\"%", ws_id)));
        }

        if let Some(ref folder) = filters.folder_path {
            where_clauses.push("relative_path LIKE ?".to_string());
            param_values.push(Box::new(format!("{}/%", folder.trim_end_matches('/'))));
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

        // Count total
        let count_sql = format!("SELECT COUNT(*) FROM assets {}", where_sql);
        let count_params: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let total_count: u32 = conn.query_row(&count_sql, count_params.as_slice(), |row| row.get(0))
            .map_err(|e| format!("Count query failed: {}", e))?;

        // Query page
        let query_sql = format!(
            "SELECT id, name, path, asset_type, size, dominant_color, width, height, created_at, modified_at, rating, is_trashed \
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
pub async fn delete_assets(
    ids: Vec<String>,
    state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let tx = conn.unchecked_transaction().map_err(|e| format!("Transaction begin failed: {}", e))?;

        if !ids.is_empty() {
            let placeholders: Vec<String> = ids.iter().enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect();
            let sql = format!("DELETE FROM assets WHERE id IN ({})", placeholders.join(", "));
            let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
            tx.execute(&sql, params.as_slice()).map_err(|e| format!("Delete failed: {}", e))?;
        }

        tx.commit().map_err(|e| format!("Commit failed: {}", e))?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folders(
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        let mut stmt = conn
            .prepare("SELECT path, parent_path, display_name, asset_count FROM folders ORDER BY path")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let parent_path: Option<String> = row.get(1)?;
                let display_name: String = row.get(2)?;
                let asset_count: i32 = row.get(3)?;
                Ok(serde_json::json!({
                    "path": path,
                    "parent_path": parent_path,
                    "display_name": display_name,
                    "asset_count": asset_count,
                }))
            })
            .map_err(|e| e.to_string())?;

        let mut folders = Vec::new();
        for row in rows {
            folders.push(row.map_err(|e: rusqlite::Error| e.to_string())?);
        }

        Ok(folders)
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
            .prepare("SELECT tags FROM assets WHERE tags IS NOT NULL AND tags != ''")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let tags_str: String = row.get(0)?;
                Ok(tags_str)
            })
            .map_err(|e| e.to_string())?;

        let mut tag_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

        for row in rows {
            let tags_str = row.map_err(|e: rusqlite::Error| e.to_string())?;
            // Parse JSON array string like ["tag1","tag2"]
            if let Ok(tags_vec) = serde_json::from_str::<Vec<String>>(&tags_str) {
                for tag in tags_vec {
                    *tag_counts.entry(tag).or_insert(0) += 1;
                }
            }
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
pub async fn find_similar_images(
    target_id: String,
    threshold: u32,
    state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&state)?;

    tokio::task::spawn_blocking(move || {
        let conn = library::get_db_connection(&db_path)?;

        // Get target hash
        let target_hash_str: Option<String> = conn.query_row(
            "SELECT p_hash FROM assets WHERE id = ?1",
            rusqlite::params![target_id],
            |row| row.get(0),
        ).map_err(|e| format!("Target asset not found: {}", e))?;

        let target_hash_b64 = target_hash_str
            .ok_or_else(|| "Target asset has no perceptual hash".to_string())?;

        let target_hash = image_hasher::ImageHash::<Vec<u8>>::from_base64(&target_hash_b64)
            .map_err(|e| format!("Failed to decode target hash: {:?}", e))?;

        let threshold_dist = threshold;

        // Query all assets with non-null p_hash
        let mut stmt = conn.prepare(
            "SELECT id, p_hash FROM assets WHERE p_hash IS NOT NULL AND id != ?1"
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let rows = stmt.query_map(rusqlite::params![target_id], |row| {
            let id: String = row.get(0)?;
            let hash_b64: String = row.get(1)?;
            Ok((id, hash_b64))
        }).map_err(|e| format!("Query failed: {}", e))?;

        let mut similar_ids = Vec::new();
        for row in rows {
            if let Ok((id, hash_b64)) = row {
                if let Ok(other_hash) = image_hasher::ImageHash::<Vec<u8>>::from_base64(&hash_b64) {
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
