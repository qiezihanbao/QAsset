use crate::models::{LibraryConfig, Registry, RegistryEntry};
use crate::db;
use rusqlite::Connection;
use serde_json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use notify::RecommendedWatcher;

pub struct AppState {
    pub library_root: std::sync::RwLock<Option<PathBuf>>,
    pub db_path: std::sync::RwLock<Option<PathBuf>>,
    pub watcher_handle: Mutex<Option<RecommendedWatcher>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            library_root: std::sync::RwLock::new(None),
            db_path: std::sync::RwLock::new(None),
            watcher_handle: Mutex::new(None),
        }
    }
}

fn quickasset_dir(library_root: &Path) -> PathBuf {
    library_root.join(".quickasset")
}

pub fn library_db_path(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("library.db")
}

fn library_config_path(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("library.json")
}

pub fn thumbnails_dir(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("thumbnails")
}

pub fn previews_dir(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("previews")
}

pub fn create_library(library_root: &Path, name: &str) -> Result<(), String> {
    let qa_dir = quickasset_dir(library_root);
    fs::create_dir_all(&qa_dir).map_err(|e| format!("Failed to create .quickasset: {}", e))?;
    fs::create_dir_all(thumbnails_dir(library_root))
        .map_err(|e| format!("Failed to create thumbnails dir: {}", e))?;
    fs::create_dir_all(previews_dir(library_root))
        .map_err(|e| format!("Failed to create previews dir: {}", e))?;

    let config = LibraryConfig {
        name: name.to_string(),
        version: 1,
        created_at: now_secs(),
    };
    let config_path = library_config_path(library_root);
    let config_json = serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, config_json)
        .map_err(|e| format!("Failed to write library.json: {}", e))?;

    let db_path = library_db_path(library_root);
    db::init_library_db(&db_path).map_err(|e| format!("Failed to init DB: {}", e))?;

    Ok(())
}

pub fn open_library(library_root: &Path) -> Result<LibraryConfig, String> {
    let qa_dir = quickasset_dir(library_root);
    if !qa_dir.exists() {
        return Err("Not a QuickAsset library (.quickasset/ not found)".into());
    }

    let db_path = library_db_path(library_root);
    if !db_path.exists() {
        return Err("Library database not found".into());
    }

    // Run migrations if needed
    db::init_library_db(&db_path).map_err(|e| format!("DB migration failed: {}", e))?;

    let config_str = fs::read_to_string(library_config_path(library_root))
        .map_err(|e| format!("Failed to read library.json: {}", e))?;
    let config: LibraryConfig = serde_json::from_str(&config_str)
        .map_err(|e| format!("Invalid library.json: {}", e))?;

    Ok(config)
}

pub fn get_library_info(library_root: &Path) -> Result<LibraryConfig, String> {
    let config_str = fs::read_to_string(library_config_path(library_root))
        .map_err(|e| format!("Failed to read library.json: {}", e))?;
    serde_json::from_str(&config_str).map_err(|e| format!("Invalid library.json: {}", e))
}

pub fn get_db_connection(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("DB connection failed: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA wal_autocheckpoint=1000;
         PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| format!("DB pragma setup failed: {}", e))?;
    Ok(conn)
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

// Registry management
pub fn get_registry_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("registry.json")
}

pub fn load_registry(app_data_dir: &Path) -> Registry {
    let path = get_registry_path(app_data_dir);
    if path.exists() {
        if let Ok(s) = fs::read_to_string(&path) {
            if let Ok(r) = serde_json::from_str(&s) {
                return r;
            }
        }
    }
    Registry { recent_libraries: vec![] }
}

pub fn save_registry(app_data_dir: &Path, registry: &Registry) -> Result<(), String> {
    let _ = fs::create_dir_all(app_data_dir);
    let path = get_registry_path(app_data_dir);
    let json = serde_json::to_string_pretty(registry).map_err(|e| format!("Failed to serialize registry: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("Failed to save registry: {}", e))
}

pub fn add_to_registry(app_data_dir: &Path, path: &str, name: &str) -> Result<(), String> {
    let mut registry = load_registry(app_data_dir);
    let now = now_secs();
    if let Some(entry) = registry.recent_libraries.iter_mut().find(|e| e.path == path) {
        entry.last_opened = now;
        entry.name = name.to_string();
    } else {
        registry.recent_libraries.insert(0, RegistryEntry {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: now,
        });
        // Keep max 20 entries
        registry.recent_libraries.truncate(20);
    }
    save_registry(app_data_dir, &registry)
}
