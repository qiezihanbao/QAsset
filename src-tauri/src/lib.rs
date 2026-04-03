use serde::{Serialize, Deserialize};
use walkdir::WalkDir;
use std::path::{Path, PathBuf};
use image::GenericImageView;
use base64::{engine::general_purpose, Engine as _};
use std::io::Cursor;
use rusqlite::{params, Connection, Result as SqlResult};
use tauri::{Manager, State};

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
}

struct AppState {
    db_path: PathBuf,
}

fn init_db(db_path: &Path) -> SqlResult<()> {
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

    Ok(())
}

fn get_dominant_color_and_thumb(path: &Path) -> (Option<String>, Option<String>) {
    match image::open(path) {
        Ok(img) => {
            let thumb = img.thumbnail(256, 256);
            let mut buf = Cursor::new(Vec::new());
            
            let thumb_b64 = match thumb.write_to(&mut buf, image::ImageFormat::Jpeg) {
                Ok(_) => {
                    let b64 = general_purpose::STANDARD.encode(buf.into_inner());
                    Some(format!("data:image/jpeg;base64,{}", b64))
                },
                Err(_) => None
            };

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

            (color_hex, thumb_b64)
        },
        Err(_) => (None, None)
    }
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
                
                let mut stmt = tx.prepare("SELECT name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating FROM assets WHERE id = ?1").map_err(|e| e.to_string())?;
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

                let (dominant_color, thumbnail_base64) = if asset_type == "image" {
                    get_dominant_color_and_thumb(path)
                } else {
                    (None, None)
                };

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
                };

                tx.execute(
                    "INSERT INTO assets (id, name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![asset.id, asset.name, asset.path, asset.asset_type, asset.size, asset.dominant_color, asset.thumbnail_base64, asset.tags, asset.description, asset.rating],
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
        let mut stmt = conn.prepare("SELECT id, name, path, asset_type, size, dominant_color, thumbnail_base64, tags, description, rating FROM assets").map_err(|e| e.to_string())?;
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
    state: State<'_, AppState>
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE assets SET tags = ?1, description = ?2, rating = ?3 WHERE id = ?4",
            params![tags, description, rating, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![scan_directory, get_all_assets, update_asset])
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
