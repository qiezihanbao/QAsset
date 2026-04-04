use crate::library;
use crate::models::{ScanError, ScanProgress, ScanReport};
use crate::thumbnails;
use image::GenericImageView;
use rayon::prelude::*;
use rusqlite::Connection;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, AppHandle};

/// File extensions grouped by asset type.
fn asset_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "ico" => "image",
        "svg" => "vector",
        "mp4" | "avi" | "mov" | "mkv" | "webm" | "flv" | "wmv" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" | "wma" => "audio",
        "obj" | "fbx" | "gltf" | "glb" | "stl" | "3ds" | "blend" => "3d",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
        | "txt" | "rtf" | "csv" | "json" | "xml" | "html" | "md" => "document",
        _ => "other",
    }
}

/// Whether a file extension should be indexed at all.
fn is_indexable_ext(ext: &str) -> bool {
    matches!(
        asset_type_for_ext(ext),
        "image" | "vector" | "video" | "audio" | "3d" | "document"
    )
}

/// Metadata extracted from processing an image file.
struct ImageProcessResult {
    dominant_color: Option<String>,
    width: u32,
    height: u32,
    p_hash: Option<String>,
    thumbnail_mtime: Option<u64>,
}

/// Process an image: generate thumbnail, extract color, compute pHash.
fn process_image(
    library_root: &Path,
    relative_path: &str,
    abs_path: &Path,
) -> ImageProcessResult {
    let mut result = ImageProcessResult {
        dominant_color: None,
        width: 0,
        height: 0,
        p_hash: None,
        thumbnail_mtime: None,
    };

    // Open image
    let img = match image::open(abs_path) {
        Ok(img) => img,
        Err(_) => return result,
    };

    result.width = img.width();
    result.height = img.height();

    // Generate thumbnail and write to disk
    let thumb_result = generate_thumbnail(library_root, relative_path, &img);
    if let Ok(mtime) = thumb_result {
        result.thumbnail_mtime = Some(mtime);
    }

    // Extract dominant color from a tiny version
    result.dominant_color = extract_dominant_color(&img);

    // Compute perceptual hash
    let hasher = image_hasher::HasherConfig::new()
        .hash_alg(image_hasher::HashAlg::Gradient)
        .to_hasher();
    let hash = hasher.hash_image(&img);
    result.p_hash = Some(hash.to_base64());

    result
}

/// Generate thumbnail: resize to 256px max dimension, save as PNG.
fn generate_thumbnail(
    library_root: &Path,
    relative_path: &str,
    img: &image::DynamicImage,
) -> Result<u64, String> {
    let thumb_path = thumbnails::ensure_thumbnail_dir(library_root, relative_path)?;

    // Resize to max 256px on the longest side
    let thumb_img = img.thumbnail(256, 256);

    // Save as PNG (WebP encoding may not be available in image 0.25 by default)
    let file = std::fs::File::create(&thumb_path)
        .map_err(|e| format!("Failed to create thumbnail file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    thumb_img
        .write_to(&mut writer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write thumbnail: {}", e))?;

    // Return mtime of the written thumbnail
    let metadata = fs::metadata(&thumb_path)
        .map_err(|e| format!("Failed to read thumbnail metadata: {}", e))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(mtime)
}

/// Extract the dominant color from an image by resizing to 16x16 and averaging pixels.
fn extract_dominant_color(img: &image::DynamicImage) -> Option<String> {
    let tiny = img.thumbnail(16, 16);
    let mut r_sum: u64 = 0;
    let mut g_sum: u64 = 0;
    let mut b_sum: u64 = 0;
    let mut count: u64 = 0;

    for pixel in tiny.pixels() {
        let rgba = pixel.2;
        // Skip mostly-transparent pixels
        if rgba[3] < 128 {
            continue;
        }
        r_sum += rgba[0] as u64;
        g_sum += rgba[1] as u64;
        b_sum += rgba[2] as u64;
        count += 1;
    }

    if count == 0 {
        return None;
    }

    let r = (r_sum / count) as u8;
    let g = (g_sum / count) as u8;
    let b = (b_sum / count) as u8;

    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

/// Represents a file discovered on disk.
#[derive(Clone)]
struct DiscoveredFile {
    relative_path: String,
    abs_path: PathBuf,
    size: u64,
    modified: u64,
    asset_type: String,
    name: String,
}

/// Represents an existing asset in the DB.
struct DbAsset {
    id: String,
    relative_path: String,
    modified_at: u64,
    size: u64,
}

/// The main 4-phase scan orchestrator.
pub fn scan_library(
    library_root: &Path,
    db_path: &Path,
    app_handle: &AppHandle,
) -> Result<ScanReport, String> {
    let mut report = ScanReport {
        added: 0,
        updated: 0,
        deleted: 0,
        errors: Vec::new(),
    };

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "discovering".to_string(),
            scanned: 0,
            total: 0,
        },
    );

    // ── Phase 1: Walk directory tree ──────────────────────────────────
    let discovered = phase1_discover(library_root, app_handle);

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "diffing".to_string(),
            scanned: 0,
            total: discovered.len() as u32,
        },
    );

    // ── Phase 2: Diff against DB ──────────────────────────────────────
    let conn = library::get_db_connection(db_path)?;
    let db_assets = load_db_assets(&conn)?;
    let (new_files, changed_files, deleted_ids) =
        phase2_diff(&discovered, &db_assets);

    report.deleted = deleted_ids.len() as u32;

    // Delete removed assets from DB
    for id in &deleted_ids {
        let _ = conn.execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id]);
        // Also remove orphaned thumbnail
        if let Some(rel) = db_assets.get(id) {
            let thumb_path = thumbnails::thumbnail_abs_path(library_root, &rel.relative_path);
            let _ = fs::remove_file(&thumb_path);
        }
    }

    let files_to_process: Vec<&DiscoveredFile> = new_files.iter().copied().chain(changed_files.iter().copied()).collect();
    let total_to_process = files_to_process.len() as u32;

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "processing".to_string(),
            scanned: 0,
            total: total_to_process,
        },
    );

    // ── Phase 3: Parallel processing (thumbnails, color, pHash) ──────
    let scanned_counter = AtomicU32::new(0);
    let errors_mutex: Mutex<Vec<ScanError>> = Mutex::new(Vec::new());

    let results: Vec<(String, DiscoveredFile, Option<ImageProcessResult>)> = files_to_process
        .par_iter()
        .map(|file| {
            let scanned = scanned_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if scanned % 100 == 0 || scanned == total_to_process {
                let _ = app_handle.emit(
                    "scan-progress",
                    ScanProgress {
                        phase: "processing".to_string(),
                        scanned,
                        total: total_to_process,
                    },
                );
            }

            let img_result = if file.asset_type == "image" {
                Some(process_image(library_root, &file.relative_path, &file.abs_path))
            } else {
                None
            };

            (file.relative_path.clone(), (*file).clone(), img_result)
        })
        .collect();

    // Collect errors from parallel phase
    if let Ok(mut errs) = errors_mutex.lock() {
        report.errors.append(&mut errs);
    }

    // ── Phase 4: Batch DB write ───────────────────────────────────────
    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "writing".to_string(),
            scanned: 0,
            total: results.len() as u32,
        },
    );

    let is_new_set: std::collections::HashSet<String> = new_files
        .iter()
        .map(|f| f.relative_path.clone())
        .collect();

    let now = library::now_secs();

    for (i, (_rel, file, img_result)) in results.iter().enumerate() {
        let abs_path_str = file.abs_path.to_string_lossy().to_string();
        let id = abs_path_str.clone();

        if i % 100 == 0 {
            let _ = app_handle.emit(
                "scan-progress",
                ScanProgress {
                    phase: "writing".to_string(),
                    scanned: i as u32,
                    total: results.len() as u32,
                },
            );
        }

        let is_new = is_new_set.contains(&file.relative_path);

        if is_new {
            // INSERT new asset
            let (dominant_color, width, height, p_hash, thumbnail_mtime) = match img_result {
                Some(r) => (
                    r.dominant_color.clone(),
                    Some(r.width),
                    Some(r.height),
                    r.p_hash.clone(),
                    r.thumbnail_mtime,
                ),
                None => (None, None, None, None, None),
            };

            let result = conn.execute(
                "INSERT INTO assets (id, name, path, relative_path, asset_type, size,
                    dominant_color, tags, description, rating, workspace_ids,
                    created_at, modified_at, p_hash, is_trashed, width, height,
                    source_url, duration, thumbnail_mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', '', NULL, '[]',
                    ?8, ?9, ?10, 0, ?11, ?12, NULL, NULL, ?13)",
                rusqlite::params![
                    id,
                    file.name,
                    abs_path_str,
                    file.relative_path,
                    file.asset_type,
                    file.size as i64,
                    dominant_color,
                    now,
                    file.modified,
                    p_hash,
                    width,
                    height,
                    thumbnail_mtime,
                ],
            );

            match result {
                Ok(_) => report.added += 1,
                Err(e) => report.errors.push(ScanError {
                    path: abs_path_str,
                    message: format!("DB insert failed: {}", e),
                }),
            }
        } else {
            // UPDATE changed asset
            let (dominant_color, width, height, p_hash, thumbnail_mtime) = match img_result {
                Some(r) => (
                    r.dominant_color.clone(),
                    Some(r.width),
                    Some(r.height),
                    r.p_hash.clone(),
                    r.thumbnail_mtime,
                ),
                None => (None, None, None, None, None),
            };

            let result = conn.execute(
                "UPDATE assets SET name = ?1, path = ?2, size = ?3, modified_at = ?4,
                    asset_type = ?5, dominant_color = ?6, width = ?7, height = ?8,
                    p_hash = ?9, thumbnail_mtime = ?10
                 WHERE id = ?11",
                rusqlite::params![
                    file.name,
                    abs_path_str,
                    file.size as i64,
                    file.modified,
                    file.asset_type,
                    dominant_color,
                    width,
                    height,
                    p_hash,
                    thumbnail_mtime,
                    id,
                ],
            );

            match result {
                Ok(_) => report.updated += 1,
                Err(e) => report.errors.push(ScanError {
                    path: abs_path_str,
                    message: format!("DB update failed: {}", e),
                }),
            }
        }
    }

    // Rebuild folder cache
    rebuild_folders(&conn, library_root)?;

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "done".to_string(),
            scanned: results.len() as u32,
            total: results.len() as u32,
        },
    );

    Ok(report)
}

/// Phase 1: Walk the directory tree and discover all indexable files.
fn phase1_discover(library_root: &Path, app_handle: &AppHandle) -> Vec<DiscoveredFile> {
    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(library_root)
        .into_iter()
        .filter_entry(|e| {
            // Skip .quickasset internal directory
            e.file_name() != ".quickasset"
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();

        // Get extension
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_lowercase(),
            None => continue,
        };

        if !is_indexable_ext(&ext) {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let relative_path = path
            .strip_prefix(library_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let abs_path = path.to_path_buf();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        files.push(DiscoveredFile {
            relative_path,
            abs_path,
            size: metadata.len(),
            modified,
            asset_type: asset_type_for_ext(&ext).to_string(),
            name,
        });
    }

    let _ = app_handle.emit(
        "scan-progress",
        ScanProgress {
            phase: "discovering".to_string(),
            scanned: files.len() as u32,
            total: files.len() as u32,
        },
    );

    files
}

/// Load existing assets from DB for diff comparison.
fn load_db_assets(conn: &Connection) -> Result<HashMap<String, DbAsset>, String> {
    let mut stmt = conn
        .prepare("SELECT id, relative_path, modified_at, size FROM assets")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(DbAsset {
                id: row.get::<_, String>(0)?,
                relative_path: row.get::<_, String>(1)?,
                modified_at: row.get::<_, u64>(2)?,
                size: row.get::<_, i64>(3)? as u64,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for row in rows {
        let asset = row.map_err(|e: rusqlite::Error| e.to_string())?;
        map.insert(asset.id.clone(), asset);
    }

    Ok(map)
}

/// Phase 2: Compare discovered files against DB to find new, changed, and deleted.
fn phase2_diff<'a>(
    discovered: &'a [DiscoveredFile],
    db_assets: &HashMap<String, DbAsset>,
) -> (Vec<&'a DiscoveredFile>, Vec<&'a DiscoveredFile>, Vec<String>) {
    let mut new_files = Vec::new();
    let mut changed_files = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for file in discovered {
        let id = file.abs_path.to_string_lossy().to_string();
        seen_ids.insert(id.clone());

        match db_assets.get(&id) {
            None => {
                new_files.push(file);
            }
            Some(db_asset) => {
                // Check if file has changed (size or modification time differs)
                if file.size != db_asset.size || file.modified != db_asset.modified_at {
                    changed_files.push(file);
                }
            }
        }
    }

    // Find deleted: in DB but not on disk
    let deleted_ids: Vec<String> = db_assets
        .keys()
        .filter(|id| !seen_ids.contains(*id))
        .cloned()
        .collect();

    (new_files, changed_files, deleted_ids)
}

/// Rebuild the folder cache table from the assets in the DB.
fn rebuild_folders(conn: &Connection, library_root: &Path) -> Result<(), String> {
    // Clear existing folder cache
    conn.execute("DELETE FROM folders", [])
        .map_err(|e| format!("Failed to clear folders: {}", e))?;

    // Collect all unique folders from assets
    let mut stmt = conn
        .prepare("SELECT relative_path FROM assets WHERE is_trashed = 0")
        .map_err(|e| e.to_string())?;

    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Count assets per folder
    let mut folder_counts: HashMap<String, u32> = HashMap::new();
    for rel_path in &paths {
        if let Some(parent) = Path::new(rel_path).parent() {
            let folder = parent.to_string_lossy().to_string();
            // Walk up the directory tree, counting the asset in each ancestor
            let mut current = PathBuf::from(&folder);
            loop {
                let key = current.to_string_lossy().to_string();
                *folder_counts.entry(key).or_insert(0) += 1;
                match current.parent() {
                    Some(p) if p != PathBuf::from("") => current = p.to_path_buf(),
                    _ => break,
                }
            }
        }
    }

    // Insert into folders table
    let mut insert_stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO folders (path, parent_path, display_name, asset_count) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(|e| e.to_string())?;

    for (folder, count) in &folder_counts {
        let path = Path::new(folder);
        let display_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let parent_path = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        insert_stmt
            .execute(rusqlite::params![folder, parent_path, display_name, count])
            .map_err(|e| format!("Failed to insert folder: {}", e))?;
    }

    // Also add the root folder if it has assets
    if let Some(root_count) = folder_counts.get("") {
        let root_name = library_root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        insert_stmt
            .execute(rusqlite::params!["", "", root_name, root_count])
            .map_err(|e| format!("Failed to insert root folder: {}", e))?;
    }

    Ok(())
}
