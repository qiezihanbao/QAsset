use crate::models::*;
use tauri::State;

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
    _path: String,
    _name: String,
    _state: State<'_, crate::library::AppState>,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn open_library_cmd(
    _path: String,
    _state: State<'_, crate::library::AppState>,
    _app_handle: tauri::AppHandle,
) -> Result<LibraryConfig, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn close_library(
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_library_info_cmd(
    _state: State<'_, crate::library::AppState>,
) -> Result<LibraryConfig, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn get_recent_libraries(
    _app_handle: tauri::AppHandle,
) -> Result<Vec<RegistryEntry>, String> {
    Err("Not implemented".into())
}

#[tauri::command]
pub async fn relocate_library(
    _new_root: String,
    _state: State<'_, crate::library::AppState>,
) -> Result<(), String> {
    Err("Not implemented".into())
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
