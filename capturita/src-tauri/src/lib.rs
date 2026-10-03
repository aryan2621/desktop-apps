mod captions;
mod export;
mod google;
mod helper;
mod recording;

use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ⌘⇧R starts and stops a recording from anywhere.
    let record_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyR);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &record_shortcut {
                        recording::toggle_from_shortcut(app);
                    }
                })
                .build(),
        )
        .manage(helper::Helper::default())
        .manage(recording::Recording::default())
        .manage(export::Export::default())
        .manage(google::Google::default())
        .manage(captions::Captions::default())
        .setup(move |app| {
            if let Err(error) = app.global_shortcut().register(record_shortcut) {
                eprintln!("Could not register the ⌘⇧R shortcut: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            recording::recorder_request,
            recording::get_recording_status,
            recording::prepare_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::stop_recording,
            recording::cancel_recording,
            recording::list_recordings,
            recording::delete_recording,
            recording::load_edit,
            recording::save_edit,
            recording::import_music,
            recording::recordings_dir,
            recording::restart_app,
            recording::log_debug,
            captions::caption_model_status,
            captions::transcribe,
            captions::download_caption_model,
            captions::cancel_transcription,
            captions::save_export_text,
            export::export_open,
            export::export_write,
            export::export_close,
            google::google_status,
            google::google_open_config_folder,
            google::google_sign_in,
            google::google_sign_out,
            google::google_upload,
            google::google_cancel_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
