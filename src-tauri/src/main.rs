mod commands;
mod crypto;
mod error;
mod models;
mod state;
mod storage;
mod webdav;

use state::AppState;

fn main() {
    let app_state = AppState::new().expect("failed to initialize app state");

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_state,
            commands::save_app_settings,
            commands::test_connection,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::open_ssh_session,
            commands::close_ssh_session,
            commands::write_terminal_input,
            commands::read_terminal_output,
            commands::resize_terminal,
            commands::list_remote_files,
            commands::upload_remote_file,
            commands::download_remote_file,
            commands::delete_remote_path,
            commands::rename_remote_path,
            commands::load_editor_document,
            commands::save_editor_document,
            commands::list_tunnels,
            commands::fetch_runtime_overview,
            commands::open_tunnel,
            commands::start_tunnel,
            commands::close_tunnel,
            commands::read_remote_shell_history,
            commands::append_command_history,
            commands::get_command_suggestions,
            commands::export_local_config,
            commands::import_local_config,
            commands::upload_settings_to_webdav,
            commands::download_settings_from_webdav,
            commands::upload_connections_to_webdav,
            commands::download_connections_from_webdav,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
