mod models;
pub mod db;
mod library;
mod thumbnails;
mod scanner;
mod commands;
mod web_import;
mod prefetch;

use library::AppState;
use tauri::Manager;

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
            commands::import_external_paths,
            commands::move_assets_to_folder,
            commands::move_folder_to_folder,
            commands::query_assets,
            commands::prefetch_assets_window,
            commands::cancel_prefetch_task,
            commands::get_prefetch_status,
            commands::get_asset_detail,
            commands::ensure_asset_thumbnail,
            commands::repair_missing_thumbnails,
            commands::rebuild_all_thumbnails,
            commands::rebuild_search_index,
            commands::ensure_asset_full_preview,
            commands::update_asset,
            commands::batch_update_asset_tags,
            commands::batch_update_asset_workspaces,
            commands::delete_assets,
            commands::get_folders,
            commands::get_tags_summary,
            commands::create_workspace,
            commands::update_workspace,
            commands::delete_workspace,
            commands::get_workspaces,
            commands::get_library_stats,
            commands::find_similar_images,
            commands::find_similar_groups,
            commands::apply_similar_dedupe,
            commands::check_health,
            commands::show_in_folder,
            commands::open_in_default_app,
            commands::rename_asset,
            commands::read_file_text,
            commands::update_folder_show_subfolders,
            commands::migrate_hashed,
            commands::start_watcher,
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
            web_import::start_web_import_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
