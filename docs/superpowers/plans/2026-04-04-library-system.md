# Resource Library System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate QuickAsset from a single global SQLite DB to per-library Lightroom-style architecture with parallel scanning, paginated queries, and disk-based thumbnails.

**Architecture:** Each library is a user-chosen folder with a `.quickasset/` hidden directory containing its SQLite DB and WebP thumbnail cache. The app opens one library at a time. Backend uses rayon for parallel image processing. Frontend uses paginated queries with virtual scrolling.

**Tech Stack:** Rust (Tauri v2, rusqlite, rayon, image 0.25, img_hash) + TypeScript/React (Zustand, @tanstack/react-virtual, Tauri asset protocol)

**Spec:** `docs/superpowers/specs/2026-04-04-library-system-design.md`

---

## File Structure

### New Files
- `src-tauri/src/library.rs` — Library management (create/open/close/relocate), registry.json I/O, AppState definition
- `src-tauri/src/db.rs` — Database schema init, migrations, helper functions
- `src-tauri/src/scanner.rs` — Parallel scan logic (rayon), thumbnail generation, scan progress events
- `src-tauri/src/commands.rs` — All Tauri command handlers (query_assets, update_asset, etc.)
- `src-tauri/src/models.rs` — AssetInfoLite, AssetDetail, AssetFilters, QueryResult structs
- `src-tauri/src/thumbnails.rs` — Thumbnail path computation, WebP generation, staleness check
- `src/pages/WelcomePage.tsx` — Welcome/library picker screen when no library is open
- `src/components/LibrarySwitcher.tsx` — Dropdown component in left sidebar for library switching

### Modified Files
- `src-tauri/src/lib.rs` — Refactor to use new modules, new `run()` setup
- `src-tauri/src/main.rs` — No changes needed
- `src-tauri/Cargo.toml` — Add rayon, upgrade image crate
- `src-tauri/tauri.conf.json` — Ensure assetProtocol enabled
- `src-tauri/capabilities/default.json` — Add core:asset:default permission
- `src/App.tsx` — Replace get_all_assets with library open flow + paginated loading
- `src/store/useAssetStore.ts` — Add library state, pagination, AssetLite types
- `src/components/layout/LeftSidebar.tsx` — Add LibrarySwitcher, read workspaces from DB
- `src/components/layout/RightSidebar.tsx` — Use get_asset_detail instead of full Asset objects
- `src/pages/AssetsPage.tsx` — Use paginated query, convertFileSrc for thumbnails, loadMore on scroll
- `src/components/Lightbox.tsx` — Use convertFileSrc for full-res image loading

---

## Task 1: Rust Module Scaffold + Dependency Updates

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/models.rs`
- Create: `src-tauri/src/db.rs`
- Create: `src-tauri/src/library.rs`
- Create: `src-tauri/src/scanner.rs`
- Create: `src-tauri/src/thumbnails.rs`
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update Cargo.toml with new dependencies**

In `src-tauri/Cargo.toml`, add `rayon` and upgrade `image`:
```toml
image = "0.25"
rayon = "1.10"
```

- [ ] **Step 2: Create `src-tauri/src/models.rs` with all data types**

```rust
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetInfoLite {
    pub id: String,
    pub name: String,
    pub path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: u64,
    pub modified_at: u64,
    pub rating: Option<u8>,
    pub is_trashed: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetDetail {
    pub id: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub asset_type: String,
    pub size: u64,
    pub dominant_color: Option<String>,
    pub tags: Option<String>,
    pub description: Option<String>,
    pub rating: Option<u8>,
    pub workspace_ids: Option<String>,
    pub created_at: u64,
    pub modified_at: u64,
    pub p_hash: Option<String>,
    pub is_trashed: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source_url: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AssetFilters {
    pub search_query: Option<String>,
    pub asset_types: Option<Vec<String>>,
    pub is_trashed: Option<bool>,
    pub workspace_id: Option<String>,
    pub folder_path: Option<String>,
    pub min_rating: Option<u8>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub sort_field: String,
    pub sort_order: String,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Serialize, Deserialize)]
pub struct QueryResult {
    pub total_count: u32,
    pub items: Vec<AssetInfoLite>,
}

#[derive(Serialize, Deserialize)]
pub struct LibraryConfig {
    pub name: String,
    pub version: u32,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize)]
pub struct RegistryEntry {
    pub path: String,
    pub name: String,
    pub last_opened: u64,
}

#[derive(Serialize, Deserialize)]
pub struct Registry {
    pub recent_libraries: Vec<RegistryEntry>,
}

#[derive(Serialize, Deserialize)]
pub struct ScanProgress {
    pub phase: String,
    pub scanned: u32,
    pub total: u32,
}

#[derive(Serialize, Deserialize)]
pub struct ScanReport {
    pub added: u32,
    pub updated: u32,
    pub deleted: u32,
    pub errors: Vec<ScanError>,
}

#[derive(Serialize, Deserialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}
```

- [ ] **Step 3: Create `src-tauri/src/db.rs` with schema init**

```rust
use rusqlite::{Connection, Result as SqlResult};
use std::path::Path;

pub fn init_library_db(db_path: &Path) -> SqlResult<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            dominant_color TEXT,
            tags TEXT,
            description TEXT,
            rating INTEGER,
            workspace_ids TEXT,
            created_at INTEGER DEFAULT 0,
            modified_at INTEGER DEFAULT 0,
            p_hash TEXT,
            is_trashed INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            source_url TEXT,
            duration REAL,
            thumbnail_mtime INTEGER
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS folders (
            path TEXT PRIMARY KEY,
            parent_path TEXT,
            display_name TEXT NOT NULL,
            asset_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
        CREATE INDEX IF NOT EXISTS idx_assets_trashed ON assets(is_trashed);
        CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
        CREATE INDEX IF NOT EXISTS idx_assets_modified ON assets(modified_at);
        CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(rating);
        CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
        CREATE INDEX IF NOT EXISTS idx_assets_relative_path ON assets(relative_path);
        "
    )?;
    Ok(())
}
```

- [ ] **Step 4: Create `src-tauri/src/library.rs` with library management**

```rust
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

fn library_db_path(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("library.db")
}

fn library_config_path(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("library.json")
}

pub fn thumbnails_dir(library_root: &Path) -> PathBuf {
    quickasset_dir(library_root).join("thumbnails")
}

pub fn create_library(library_root: &Path, name: &str) -> Result<(), String> {
    let qa_dir = quickasset_dir(library_root);
    fs::create_dir_all(&qa_dir).map_err(|e| format!("Failed to create .quickasset: {}", e))?;
    fs::create_dir_all(thumbnails_dir(library_root))
        .map_err(|e| format!("Failed to create thumbnails dir: {}", e))?;

    let config = LibraryConfig {
        name: name.to_string(),
        version: 1,
        created_at: now_secs(),
    };
    let config_path = library_config_path(library_root);
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
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

pub fn get_library_info(library_root: &Path) -> Result<crate::models::LibraryConfig, String> {
    let config_str = fs::read_to_string(library_config_path(library_root))
        .map_err(|e| format!("Failed to read library.json: {}", e))?;
    serde_json::from_str(&config_str).map_err(|e| format!("Invalid library.json: {}", e))
}

pub fn get_db_connection(db_path: &Path) -> Result<Connection, String> {
    Connection::open(db_path).map_err(|e| format!("DB connection failed: {}", e))
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
    fs::write(&path, serde_json::to_string_pretty(registry).unwrap())
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
```

- [ ] **Step 5: Create `src-tauri/src/thumbnails.rs`**

```rust
use sha2::{Sha256, Digest};
use std::path::{Path, PathBuf};

pub fn thumbnail_relative_path(relative_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("{}/{}.webp", &hash[..2], &hash[2..14])
}

pub fn thumbnail_abs_path(library_root: &Path, relative_path: &str) -> PathBuf {
    crate::library::thumbnails_dir(library_root).join(thumbnail_relative_path(relative_path))
}

pub fn ensure_thumbnail_dir(library_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let thumb_path = thumbnail_abs_path(library_root, relative_path);
    if let Some(parent) = thumb_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;
    }
    Ok(thumb_path)
}
```

- [ ] **Step 6: Create `src-tauri/src/scanner.rs` with stubs**

Create empty file with placeholder functions — will be implemented in Task 3.

```rust
// Placeholder — parallel scan implementation in Task 3
```

- [ ] **Step 7: Create `src-tauri/src/commands.rs` with stubs**

Create empty file with placeholder — will be implemented in Tasks 4-5.

```rust
// Placeholder — command implementations in Tasks 4-5
```

- [ ] **Step 8: Update `src-tauri/src/lib.rs` to use modules**

Replace the entire `lib.rs` with module declarations and the new `run()`:

```rust
mod models;
mod db;
mod library;
mod thumbnails;
mod scanner;
mod commands;

use library::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::create_library,
            commands::open_library_cmd,
            commands::close_library,
            commands::get_library_info_cmd,
            commands::get_recent_libraries,
            commands::relocate_library,
            commands::scan_library,
            commands::query_assets,
            commands::get_asset_detail,
            commands::update_asset,
            commands::delete_assets,
            commands::get_folders,
            commands::get_tags_summary,
            commands::create_workspace,
            commands::update_workspace,
            commands::delete_workspace,
            commands::get_workspaces,
            commands::find_similar_images,
            commands::check_health,
            commands::show_in_folder,
            commands::open_in_default_app,
            commands::rename_asset,
            commands::read_file_text,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.manage(AppState::new());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 9: Add `sha2` dependency to Cargo.toml**

In `src-tauri/Cargo.toml`, add:
```toml
sha2 = "0.10"
```

- [ ] **Step 10: Verify compilation**

Run: `cd D:/Git/QuickAsset/src-tauri && cargo check`
Expected: May have warnings for unused stubs, but no errors. Fix any compile errors before proceeding.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/db.rs src-tauri/src/library.rs src-tauri/src/thumbnails.rs src-tauri/src/scanner.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: scaffold library system modules and data types"
```

---

## Task 2: Library Management Commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Implement library CRUD commands in `commands.rs`**

```rust
use crate::library;
use crate::models::*;
use tauri::{Manager, State, Emitter};
use std::path::PathBuf;

pub struct AppState(pub crate::library::AppState);

fn get_library_root(state: &State<'_, crate::library::AppState>) -> Result<PathBuf, String> {
    state.library_root.read().map_err(|e| e.to_string())?
        .clone()
        .ok_or("No library is currently open".into())
}

fn get_db_path(state: &State<'_, crate::library::AppState>) -> Result<PathBuf, String> {
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
    let library_root = get_library_root(&state)?;
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
```

- [ ] **Step 2: Update capabilities to add asset protocol permission**

In `src-tauri/capabilities/default.json`, ensure permissions include `"core:asset:default"`:
```json
{
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:asset:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 3: Fix the lib.rs command handler to use the correct types**

The `commands.rs` functions use `State<'_, crate::library::AppState>` directly. Update the `generate_handler!` and `manage()` calls in `lib.rs` to match.

- [ ] **Step 4: Verify compilation**

Run: `cd D:/Git/QuickAsset/src-tauri && cargo check`
Expected: Compiles with only warnings about unused stubs for remaining commands.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "feat: implement library management commands (create/open/close/relocate)"
```

---

## Task 3: Parallel Scanner

**Files:**
- Modify: `src-tauri/src/scanner.rs`
- Modify: `src-tauri/src/commands.rs` (add scan_library, workspace CRUD)

- [ ] **Step 1: Implement `scanner.rs` with rayon parallel processing**

This is the largest single file. It implements the 4-phase scan:
- Phase 1: walkdir to discover files
- Phase 2: diff against DB (new/changed/deleted)
- Phase 3: rayon parallel thumbnail + color + pHash
- Phase 4: batch DB write

Key functions:
- `scan_library(library_root, db_path, app_handle)` — orchestrates the 4 phases
- `process_image(path)` — generates thumbnail (WebP to disk), extracts dominant color, computes pHash
- `rebuild_folders(conn, library_root)` — rebuilds the folder tree cache

Use `image::io::Reader` for decoding (image 0.25.x API). Write thumbnails as WebP via `image::codecs::webp::WebPEncoder`. Emit `scan-progress` events every 100 files.

For `process_image`: open image → resize to 256x256 for thumbnail → save WebP to `.quickasset/thumbnails/` → thumbnail 16x16 for dominant color → compute pHash. Return `(dominant_color, width, height, p_hash)`.

- [ ] **Step 2: Implement `scan_library` command in `commands.rs`**

```rust
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
```

- [ ] **Step 3: Implement workspace CRUD commands in `commands.rs`**

Add `create_workspace`, `update_workspace`, `delete_workspace`, `get_workspaces` — each opens DB connection, runs SQL, returns result.

- [ ] **Step 4: Verify compilation**

Run: `cd D:/Git/QuickAsset/src-tauri && cargo check`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/scanner.rs src-tauri/src/commands.rs
git commit -m "feat: implement parallel scanner and workspace CRUD"
```

---

## Task 4: Query + Asset Commands

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Implement `query_assets` with dynamic SQL builder**

Build WHERE clause from `AssetFilters`:
- `search_query` → `AND name LIKE '%' || ?1 || '%'`
- `asset_types` → `AND asset_type IN (...)`
- `is_trashed` → `AND is_trashed = ?`
- `workspace_id` → `AND workspace_ids LIKE '%"id"%'`
- `folder_path` → `AND relative_path LIKE 'folder/%'`
- `min_rating` → `AND rating >= ?`
- `min_size` / `max_size` → `AND size BETWEEN ? AND ?`

Execute `SELECT COUNT(*) ...` for total, then `SELECT ... LIMIT ? OFFSET ?` for page.

Map rows to `AssetInfoLite` (is_trashed: convert i32 to bool).

- [ ] **Step 2: Implement `get_asset_detail`**

Select all columns from assets where id = ?1. Compute `thumbnail_path` using `thumbnails::thumbnail_abs_path`. Return `AssetDetail`.

- [ ] **Step 3: Implement `update_asset`**

Same fetch-current-then-merge pattern as existing code, but using the new schema (no thumbnail_base64 column).

- [ ] **Step 4: Implement `delete_assets`**

Accept `ids: Vec<String>`. Execute `DELETE FROM assets WHERE id IN (...)` in a transaction.

- [ ] **Step 5: Implement `get_folders`**

`SELECT path, parent_path, display_name, asset_count FROM folders ORDER BY path`

- [ ] **Step 6: Implement `get_tags_summary`**

Parse all tags JSON from assets, count occurrences, return HashMap.

- [ ] **Step 7: Port remaining commands from old lib.rs**

Port `find_similar_images`, `check_health`, `show_in_folder`, `open_in_default_app`, `rename_asset`, `read_file_text` — these are mostly unchanged but need to use new `get_db_path`/`get_library_root` helpers and the new schema.

- [ ] **Step 8: Verify compilation**

Run: `cd D:/Git/QuickAsset/src-tauri && cargo check`

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat: implement paginated query, asset CRUD, and ported commands"
```

---

## Task 5: Frontend Store Redesign

**Files:**
- Modify: `src/store/useAssetStore.ts`

- [ ] **Step 1: Define new TypeScript interfaces**

Add `AssetLite`, `AssetDetail`, `LibraryInfo`, `PaginationState`, `AssetFilters` interfaces. Remove the old single `Asset` interface, replace with the new types throughout the store.

- [ ] **Step 2: Add library state and pagination to store**

Add to store:
```typescript
currentLibrary: LibraryInfo | null
recentLibraries: LibraryInfo[]
isLoadingLibrary: boolean
pagination: { page: number, pageSize: number, totalCount: number, hasMore: boolean }
assets: AssetLite[]
assetDetail: AssetDetail | null
```

Add actions:
```typescript
setCurrentLibrary: (lib: LibraryInfo | null) => void
setRecentLibraries: (libs: LibraryInfo[]) => void
setIsLoadingLibrary: (loading: boolean) => void
setPagination: (p: Partial<PaginationState>) => void
appendAssets: (items: AssetLite[]) => void
setAssetDetail: (detail: AssetDetail | null) => void
resetForNewLibrary: () => void
```

- [ ] **Step 3: Update all existing store actions to use AssetLite**

`setAssets`, `updateAssetProperty`, `removeAsset`, `assignAssetToWorkspace`, `removeAssetFromWorkspace` — update type signatures to work with `AssetLite`.

- [ ] **Step 4: Verify frontend builds**

Run: `cd D:/Git/QuickAsset && npm run check`
Expected: Type errors in components that reference the old `Asset` type — these will be fixed in Tasks 6-8.

- [ ] **Step 5: Commit**

```bash
git add src/store/useAssetStore.ts
git commit -m "feat: redesign Zustand store for library system + pagination"
```

---

## Task 6: App Entry Point + Library Loading

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace startup logic**

Remove the old `get_all_assets` + `check_health` call. New startup:
```
1. invoke('get_recent_libraries') → get recent list
2. If recent exists → invoke('open_library_cmd', { path: last.path }) → load first page
3. If none → render WelcomePage
```

- [ ] **Step 2: Replace fs-event handler**

On `fs-event` create/modify: call `scan_library` (or just `query_assets` for the changed folder). On remove: `delete_assets` by path.

- [ ] **Step 3: Add library switch listener**

When user switches library from sidebar, call `close_library` then `open_library_cmd` with new path, then `query_assets(page=1)`.

- [ ] **Step 4: Verify build**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: update App.tsx for library-based startup flow"
```

---

## Task 7: Welcome Page + Library Switcher

**Files:**
- Create: `src/pages/WelcomePage.tsx`
- Create: `src/components/LibrarySwitcher.tsx`
- Modify: `src/components/layout/LeftSidebar.tsx`

- [ ] **Step 1: Create WelcomePage.tsx**

A centered page with:
- App logo/name
- "Create New Library" button → dialog to pick folder + enter name → `create_library`
- "Open Existing Library" button → dialog to pick folder → `open_library_cmd`
- Recent libraries list (from store) → click to open
- Use `@tauri-apps/plugin-dialog` for folder selection

- [ ] **Step 2: Create LibrarySwitcher.tsx**

A dropdown at the top of LeftSidebar:
- Shows current library name (or "No Library")
- Dropdown with recent libraries → click to switch
- "Create New" / "Open Existing" options at bottom
- Calls close_library → open_library_cmd → refresh

- [ ] **Step 3: Update LeftSidebar.tsx**

- Import and render LibrarySwitcher at the top
- Replace hardcoded workspaces with `invoke('get_workspaces')` data
- Replace folder tree computation with `invoke('get_folders')` data

- [ ] **Step 4: Verify build**

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/pages/WelcomePage.tsx src/components/LibrarySwitcher.tsx src/components/layout/LeftSidebar.tsx
git commit -m "feat: add welcome page and library switcher UI"
```

---

## Task 8: AssetsPage + Thumbnails via Asset Protocol

**Files:**
- Modify: `src/pages/AssetsPage.tsx`
- Modify: `src/components/layout/RightSidebar.tsx`
- Modify: `src/components/Lightbox.tsx`

- [ ] **Step 1: Update AssetsPage.tsx for pagination**

Replace the current in-memory filtering/sorting with:
- On mount: `invoke('query_assets', { filters: { page: 1, pageSize: 100, sortField: 'created_at', sortOrder: 'desc' } })`
- On scroll near bottom: `loadMore()` → query next page → append to assets
- On filter/sort change: reset page=1, re-query, replace assets
- Color/shape filters remain client-side (filter the loaded `AssetLite[]`)

- [ ] **Step 2: Replace base64 thumbnails with convertFileSrc**

In the AssetCard component:
```tsx
import { convertFileSrc } from '@tauri-apps/api/core'

// Instead of <img src={asset.thumbnail_base64}>
// Use:
const thumbSrc = asset.thumbnail_path
  ? convertFileSrc(asset.thumbnail_path)
  : null
// Then <img src={thumbSrc} loading="lazy" />
```

For non-image assets, keep the existing icon-based display.

- [ ] **Step 3: Update RightSidebar.tsx**

- On asset selection: `invoke('get_asset_detail', { id })` to get full info
- Use `convertFileSrc` for preview image
- Tags, description, rating editing uses the same pattern but calls `update_asset`

- [ ] **Step 4: Update Lightbox.tsx**

- Use `convertFileSrc(asset.path)` to load the full-resolution image directly from disk
- No base64 needed

- [ ] **Step 5: Verify build + manual test**

Run: `npm run build && npm run tauri dev`

- [ ] **Step 6: Commit**

```bash
git add src/pages/AssetsPage.tsx src/components/layout/RightSidebar.tsx src/components/Lightbox.tsx
git commit -m "feat: paginated assets page with disk-based thumbnail loading"
```

---

## Task 9: Integration Test + Manual Verification

**Files:** None new

- [ ] **Step 1: Run full build**

Run: `cd D:/Git/QuickAsset && npm run build && cd src-tauri && cargo check`

- [ ] **Step 2: Manual test — create library**

Launch app → Welcome page shows → Create library at a test folder → Verify `.quickasset/` created with `library.db`, `library.json`, `thumbnails/`

- [ ] **Step 3: Manual test — scan**

Click scan → Verify files discovered → Verify thumbnails generated in `.quickasset/thumbnails/` → Verify progress events in console → Verify grid shows thumbnails

- [ ] **Step 4: Manual test — pagination**

Use a folder with >100 images → Verify only first 100 load → Scroll → Verify next page loads

- [ ] **Step 5: Manual test — close and reopen**

Close app → Reopen → Verify last library auto-opens → Verify assets load from DB (instant)

- [ ] **Step 6: Manual test — filter + sort**

Test type filter, search, sort by name/date/size → Verify server-side query returns correct results

- [ ] **Step 7: Fix any issues found**

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "fix: address integration test findings"
```
