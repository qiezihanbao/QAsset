use serde::{Serialize, Deserialize};
use walkdir::WalkDir;
use std::path::{Path, PathBuf};
use image::GenericImageView;
use base64::{engine::general_purpose, Engine as _};
use std::io::Cursor;
use rusqlite::{params, Connection, Result as SqlResult};
use tauri::{Manager, State, Emitter};
use img_hash::{HasherConfig};
use notify::{Watcher, RecursiveMode};
use std::sync::mpsc::channel;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub thumbnail_base64: Option<String>,
    pub tags: Option<String>,        // JSON array string
    pub description: Option<String>,
    pub rating: Option<u8>,
    pub workspace_ids: Option<String>, // JSON array string
    pub created_at: u64,             // timestamp
    pub modified_at: u64,            // timestamp
    pub p_hash: Option<String>,      // Perceptual hash for similarity search
    pub is_trashed: bool,            // Trash flag
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source_url: Option<String>,
    pub duration: Option<f64>,
}

pub struct AppState {
    pub db_path: PathBuf,
}

#[derive(Clone, serde::Serialize)]
struct FsEventPayload {
    event_type: String,
    path: String,
}

pub fn init_db(db_path: &Path) -> SqlResult<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            dominant_color TEXT,
            thumbnail_base64 TEXT,
            tags TEXT,
            description TEXT,
            rating INTEGER
        )",
        [],
    )?;
    
    // Handle schema migrations for existing databases
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN tags TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN description TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN rating INTEGER", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN workspace_ids TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN created_at INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN modified_at INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN p_hash TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN is_trashed INTEGER DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN width INTEGER", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN height INTEGER", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN source_url TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN duration REAL", []);

    Ok(())
}

fn get_image_metadata(path: &Path) -> (Option<String>, Option<String>, Option<String>, Option<u32>, Option<u32>) {
    match image::open(path) {
        Ok(img) => {
            let (width, height) = img.dimensions();
            // 1. Generate Thumbnail
            let thumb = img.thumbnail(256, 256);
            let mut buf = Cursor::new(Vec::new());
            
            let thumb_b64 = match thumb.write_to(&mut buf, image::ImageFormat::Jpeg) {
                Ok(_) => {
                    let b64 = general_purpose::STANDARD.encode(buf.into_inner());
                    Some(format!("data:image/jpeg;base64,{}", b64))
                },
                Err(_) => None
            };

            // 2. Calculate Dominant Color
            let small_img = img.thumbnail_exact(16, 16);
            let mut r = 0u64;
            let mut g = 0u64;
            let mut b = 0u64;
            let mut count = 0u64;

            for (_, _, rgba) in small_img.pixels() {
                if rgba[3] > 0 {
                    r += rgba[0] as u64;
                    g += rgba[1] as u64;
                    b += rgba[2] as u64;
                    count += 1;
                }
            }

            let color_hex = if count > 0 {
                let avg_r = (r / count) as u8;
                let avg_g = (g / count) as u8;
                let avg_b = (b / count) as u8;
                Some(format!("#{:02x}{:02x}{:02x}", avg_r, avg_g, avg_b))
            } else {
                None
            };

            // 3. Calculate Perceptual Hash (phash)
            let hasher = HasherConfig::new().to_hasher();
            let hash = hasher.hash_image(&img);
            let p_hash_str = Some(hash.to_base64());

            (color_hex, thumb_b64, p_hash_str, Some(width), Some(height))
        },
        Err(_) => (None, None, None, None, None)
    }
}

#[tauri::command]
async fn open_in_default_app(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_asset(id: String, new_name: String, state: State<'_, AppState>) -> Result<String, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        
        // 1. Get current path
        let current_path: String = conn.query_row(
            "SELECT path FROM assets WHERE id = ?1",
            params![id],
            |row| row.get(0)
        ).map_err(|e| e.to_string())?;
        
        let path = std::path::Path::new(&current_path);
        let parent = path.parent().ok_or("No parent directory")?;
        let ext = path.extension().unwrap_or_default();
        
        // 2. Construct new path
        let mut new_path = parent.join(&new_name);
        if !ext.is_empty() {
            new_path.set_extension(ext);
        }
        
        let new_path_str = new_path.to_string_lossy().to_string();
        
        // 3. Rename file on disk
        std::fs::rename(&current_path, &new_path).map_err(|e| format!("Failed to rename file on disk: {}", e))?;
        
        // 4. Update DB
        conn.execute(
            "UPDATE assets SET name = ?1, path = ?2, id = ?3 WHERE id = ?4",
            params![new_name, new_path_str, new_path_str, id],
        ).map_err(|e| e.to_string())?;
        
        Ok(new_path_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn scan_directory(
    dir_path: String, 
    state: State<'_, AppState>
) -> Result<Vec<AssetInfo>, String> {
    let db_path = state.db_path.clone();

    tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let mut assets = Vec::new();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        
        for entry in WalkDir::new(&dir_path).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                let path_str = path.to_string_lossy().into_owned();
                
                let mut stmt = tx.prepare("SELECT name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating, workspace_ids, created_at, modified_at, p_hash, is_trashed, width, height, source_url, duration FROM assets WHERE id = ?1").map_err(|e| e.to_string())?;
                let existing: Option<AssetInfo> = stmt.query_row(params![path_str], |row| {
                    Ok(AssetInfo {
                        id: path_str.clone(),
                        name: row.get(0)?,
                        path: row.get(1)?,
                        asset_type: row.get(2)?,
                        size: row.get(3)?,
                        dominant_color: row.get(4)?,
                        thumbnail_base64: row.get(5)?,
                        tags: row.get(6)?,
                        description: row.get(7)?,
                        rating: row.get(8)?,
                        workspace_ids: row.get(9)?,
                        created_at: row.get(10)?,
                        modified_at: row.get(11)?,
                        p_hash: row.get(12)?,
                        is_trashed: row.get::<_, i32>(13).unwrap_or(0) != 0,
                        width: row.get(14).unwrap_or(None),
                        height: row.get(15).unwrap_or(None),
                        source_url: row.get(16).unwrap_or(None),
                        duration: row.get(17).unwrap_or(None),
                    })
                }).ok();

                if let Some(asset) = existing {
                    assets.push(asset);
                    continue;
                }

                let name = entry.file_name().to_string_lossy().into_owned();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                
                let asset_type = match path.extension().and_then(|e| e.to_str()) {
                    Some(ext) => match ext.to_lowercase().as_str() {
                        "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
                        "svg" => "vector",
                        "mp4" | "avi" | "mov" | "webm" => "video",
                        "mp3" | "wav" | "ogg" => "audio",
                        "obj" | "fbx" | "gltf" | "glb" => "3d",
                        _ => "document",
                    },
                    None => "unknown",
                }.to_string();

                let (dominant_color, thumbnail_base64, p_hash, width, height) = if asset_type == "image" {
                    get_image_metadata(path)
                } else {
                    (None, None, None, None, None)
                };

                let created_at = std::fs::metadata(&path)
                    .and_then(|m| m.created())
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                    .unwrap_or(0);
                
                let modified_at = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                    .unwrap_or(0);

                let asset = AssetInfo {
                    id: path_str.clone(),
                    name: name.clone(),
                    path: path_str.clone(),
                    asset_type: asset_type.clone(),
                    size,
                    dominant_color: dominant_color.clone(),
                    thumbnail_base64: thumbnail_base64.clone(),
                    tags: None,
                    description: None,
                    rating: None,
                    workspace_ids: None,
                    created_at,
                    modified_at,
                    p_hash: p_hash.clone(),
                    is_trashed: false,
                    width,
                    height,
                    source_url: None,
                    duration: None,
                };

                tx.execute(
                    "INSERT INTO assets (id, name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating, workspace_ids, created_at, modified_at, p_hash, is_trashed, width, height, source_url, duration) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                    params![asset.id, asset.name, asset.path, asset.asset_type, asset.size, asset.dominant_color, asset.thumbnail_base64, asset.tags, asset.description, asset.rating, asset.workspace_ids, asset.created_at, asset.modified_at, asset.p_hash, 0, asset.width, asset.height, asset.source_url, asset.duration],
                ).map_err(|e| e.to_string())?;

                assets.push(asset);
            }
        }
        
        tx.commit().map_err(|e| e.to_string())?;
        
        Ok(assets)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_all_assets(state: State<'_, AppState>) -> Result<Vec<AssetInfo>, String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating, workspace_ids, created_at, modified_at, p_hash, is_trashed, width, height, source_url, duration FROM assets").map_err(|e| e.to_string())?;
        let asset_iter = stmt.query_map([], |row| {
            Ok(AssetInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                asset_type: row.get(3)?,
                size: row.get(4)?,
                dominant_color: row.get(5)?,
                thumbnail_base64: row.get(6)?,
                tags: row.get(7)?,
                description: row.get(8)?,
                rating: row.get(9)?,
                workspace_ids: row.get(10)?,
                created_at: row.get(11)?,
                modified_at: row.get(12)?,
                p_hash: row.get(13)?,
                is_trashed: row.get::<_, i32>(14).unwrap_or(0) != 0,
                width: row.get(15).unwrap_or(None),
                height: row.get(16).unwrap_or(None),
                source_url: row.get(17).unwrap_or(None),
                duration: row.get(18).unwrap_or(None),
            })
        }).map_err(|e| e.to_string())?;

        let mut assets = Vec::new();
        for asset in asset_iter {
            if let Ok(a) = asset {
                assets.push(a);
            }
        }
        Ok(assets)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn update_asset(
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
    state: State<'_, AppState>
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        
        // Fetch current asset to not overwrite with NULLs if not provided (since frontend might not pass all fields)
        let mut stmt = conn.prepare("SELECT tags, description, rating, workspace_ids, is_trashed, width, height, source_url, duration, created_at FROM assets WHERE id = ?1").map_err(|e| e.to_string())?;
        
        let (cur_tags, cur_desc, cur_rating, cur_ws, cur_trashed, cur_width, cur_height, cur_source_url, cur_duration, cur_created_at): (Option<String>, Option<String>, Option<u8>, Option<String>, i32, Option<u32>, Option<u32>, Option<String>, Option<f64>, u64) = stmt.query_row(params![id], |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, 
                row.get::<_, i32>(4).unwrap_or(0),
                row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9).unwrap_or(0)
            ))
        }).map_err(|e| e.to_string())?;

        let new_tags = tags.or(cur_tags);
        let new_desc = description.or(cur_desc);
        let new_rating = rating.or(cur_rating);
        let new_ws = workspace_ids.or(cur_ws);
        let new_trashed = is_trashed.map(|t| if t { 1 } else { 0 }).unwrap_or(cur_trashed);
        let new_width = width.or(cur_width);
        let new_height = height.or(cur_height);
        let new_source_url = source_url.or(cur_source_url);
        let new_duration = duration.or(cur_duration);
        let new_created_at = created_at.unwrap_or(cur_created_at);

        conn.execute(
            "UPDATE assets SET tags = ?1, description = ?2, rating = ?3, workspace_ids = ?4, is_trashed = ?5, width = ?6, height = ?7, source_url = ?8, duration = ?9, created_at = ?10 WHERE id = ?11",
            params![new_tags, new_desc, new_rating, new_ws, new_trashed, new_width, new_height, new_source_url, new_duration, new_created_at, id],
        ).map_err(|e| e.to_string())?;
        
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn find_similar_images(
    target_id: String,
    threshold: u32,
    state: State<'_, AppState>
) -> Result<Vec<String>, String> {
    let db_path = state.db_path.clone();
    
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        
        // 1. Get target hash
        let mut target_stmt = conn.prepare("SELECT p_hash FROM assets WHERE id = ?1").map_err(|e| e.to_string())?;
        let target_hash_str: Option<String> = target_stmt.query_row(params![target_id], |row| row.get(0)).ok().flatten();
        
        let target_hash_str = match target_hash_str {
            Some(h) => h,
            None => return Ok(Vec::new()), // Target has no hash or not found
        };

        // Parse target hash
        let target_hash_bytes = match general_purpose::STANDARD.decode(&target_hash_str) {
            Ok(b) => b,
            Err(_) => return Ok(Vec::new()),
        };
        let target_hash = img_hash::ImageHash::<Box<[u8]>>::from_bytes(&target_hash_bytes).map_err(|_| "Invalid hash bytes".to_string())?;

        // 2. Scan other images
        let mut stmt = conn.prepare("SELECT id, p_hash FROM assets WHERE asset_type = 'image' AND id != ?1 AND p_hash IS NOT NULL").map_err(|e| e.to_string())?;
        
        let mut similar_ids = Vec::new();
        let iter = stmt.query_map(params![target_id], |row| {
            let id: String = row.get(0)?;
            let hash_str: String = row.get(1)?;
            Ok((id, hash_str))
        }).map_err(|e| e.to_string())?;

        for item in iter {
            if let Ok((id, hash_str)) = item {
                if let Ok(hash_bytes) = general_purpose::STANDARD.decode(&hash_str) {
                    if let Ok(hash) = img_hash::ImageHash::<Box<[u8]>>::from_bytes(&hash_bytes) {
                        let dist = target_hash.dist(&hash);
                        if dist <= threshold {
                            similar_ids.push(id);
                        }
                    }
                }
            }
        }
        
        Ok(similar_ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_health(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db_path = state.db_path.clone();
    
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        
        let mut stmt = conn.prepare("SELECT id, path FROM assets").map_err(|e| e.to_string())?;
        
        let mut missing_ids = Vec::new();
        let iter = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let path: String = row.get(1)?;
            Ok((id, path))
        }).map_err(|e| e.to_string())?;

        for item in iter {
            if let Ok((id, path)) = item {
                if !Path::new(&path).exists() {
                    missing_ids.push(id);
                }
            }
        }
        
        Ok(missing_ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_asset(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM assets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Many linux file managers don't support select, so we just open the directory
        let parent = std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new(""));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn start_watcher(dir_path: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = std::path::PathBuf::from(dir_path.clone());
    if !path.exists() {
        return Err("Directory does not exist".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let (tx, rx) = channel();

        // Create a watcher object, delivering debounced events.
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create watcher: {}", e);
                return;
            }
        };

        // Add a path to be watched. All files and directories at that path and
        // below will be monitored for changes.
        if let Err(e) = watcher.watch(&path, RecursiveMode::Recursive) {
            eprintln!("Failed to watch directory: {}", e);
            return;
        }

        println!("Started watching directory: {}", dir_path);

        for res in rx {
            match res {
                Ok(event) => {
                    let event_type = match event.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Modify(_) => "modify",
                        notify::EventKind::Remove(_) => "remove",
                        _ => continue,
                    };

                    for path in event.paths {
                        let path_buf = path.clone();
                        let path_str = path_buf.to_string_lossy().to_string();
                        // Basic filter to ignore sqlite journal files or hidden files
                        if path_str.ends_with(".db") || path_str.ends_with("-journal") || path_buf.file_name().map_or(false, |n| n.to_string_lossy().starts_with(".")) {
                            continue;
                        }

                        println!("FS Event: {} on {}", event_type, path_str);
                        
                        let payload = FsEventPayload {
                            event_type: event_type.to_string(),
                            path: path_str,
                        };
                        
                        // Emit event to frontend
                        let _ = app_handle.emit("fs-event", payload);
                    }
                },
                Err(e) => println!("watch error: {:?}", e),
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
        scan_directory, get_all_assets, update_asset, 
        find_similar_images, check_health, delete_asset, show_in_folder, start_watcher,
        open_in_default_app, rename_asset
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      
      let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
      std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
      let db_path = app_data_dir.join("assets.db");
      
      init_db(&db_path).expect("failed to init db");
      
      app.manage(AppState { db_path });
      
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// Removed mod tests since they are integration tests now


