mod commands;
pub mod core;
pub mod formats;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Cache files left by a crash or force quit can be gigabytes; clear them off the startup path.
    std::thread::spawn(formats::text::clean_stale_cache);
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::close_file,
            commands::view_state,
            commands::get_rows,
            commands::set_cells,
            commands::insert_rows,
            commands::delete_rows,
            commands::undo,
            commands::redo,
            commands::save_file,
            commands::save_cancel,
            commands::json_root,
            commands::json_children,
            commands::json_raw,
            commands::json_edit,
            commands::search_start,
            commands::search_stop,
            commands::search_seek,
            commands::search_replace,
            commands::insert_column,
            commands::delete_columns,
            commands::rename_column,
            commands::move_column,
            commands::view_apply,
            commands::view_clear,
            commands::column_stats,
            commands::task_cancel,
            commands::selection_stats,
            commands::file_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
