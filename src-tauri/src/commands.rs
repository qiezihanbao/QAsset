use crate::models::*;
use crate::library;
use tauri::{Manager, State};
use std::path::PathBuf;

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
    _state: State<'_, crate::library::AppState>,
    _app_handle: tauri::AppHandle,
) -> Result<ScanReport, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn query_assets(
    _filters: AssetFilters,
    _state: State<'_, crate::library::AppState>,
) -> Result<QueryResult, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_asset_detail(
    _id: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<AssetDetail, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn update_asset(
    _id: String,
    _tags: Option<String>,
    _description: Option<String>,
    _rating: Option<u8>,
    _workspace_ids: Option<String>,
    _is_trashed: Option<bool>,
    _width: Option<u32>,
    _height: Option<u32>,
    _source_url: Option<String>,
    _duration: Option<f64>,
    _created_at: Option<u64>,
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn delete_assets(
    _ids: Vec<String>,
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_folders(
    _state: State<'_, crate::library::AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_tags_summary(
    _state: State<'_, crate::library::AppState>,
) -> Result<std::collections::HashMap<String, u32>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn create_workspace(
    _name: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<serde_json::Value, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn update_workspace(
    _id: String,
    _name: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn delete_workspace(
    _id: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_workspaces(
    _state: State<'_, crate::library::AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn find_similar_images(
    _target_id: String,
    _threshold: u32,
    _state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn check_health(
    _state: State<'_, crate::library::AppState>,
) -> Result<Vec<String>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn show_in_folder(_path: String) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn open_in_default_app(_path: String) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn rename_asset(
    _id: String,
    _new_name: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<String, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn read_file_text(_path: String) -> Result<String, String> {
    Err("Not implemented".into())
}
