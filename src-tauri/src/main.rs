// 发布版使用 Windows GUI 子系统，避免安装后额外弹出 myterminal.exe 控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::Ordering;

use myterminal::{commands, state::AppState};
use tauri::{Manager, WindowEvent};

fn main() {
    let app_state = AppState::new().expect("failed to initialize app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            // 启动后台 SSH 保活守护线程，防止辅助会话与隧道池会话在应用后台运行时空闲掉线。
            commands::spawn_keepalive_daemon(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = window.app_handle().clone();
                let state = app_handle.state::<AppState>();
                if state.is_shutting_down.swap(true, Ordering::SeqCst) {
                    return;
                }

                // 关闭窗口时先让界面消失，再后台清理 SSH/MCP 后端，避免远端 close 阻塞用户退出体验。
                // 清理完成后触发一次真实 close，让 WebView/Chromium 在开发模式下按正常窗口销毁路径退出。
                api.prevent_close();
                let _ = window.hide();
                let cleanup_window = window.clone();
                std::thread::spawn(move || {
                    let state = app_handle.state::<AppState>();
                    let _ = commands::shutdown_app_backends(&state);
                    if cleanup_window.close().is_err() {
                        app_handle.exit(0);
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap_state,
            commands::save_app_settings,
            commands::load_local_terminal_settings,
            commands::save_local_terminal_settings,
            commands::agent_bridge_status,
            commands::list_agent_bridge_requests,
            commands::approve_agent_bridge_request,
            commands::reject_agent_bridge_request,
            commands::clear_agent_bridge_requests,
            commands::show_agent_bridge_notification,
            commands::reset_agent_bridge_token,
            commands::set_agent_bridge_enabled,
            commands::test_connection,
            commands::create_connection,
            commands::update_connection,
            commands::delete_connection,
            commands::open_ssh_session,
            commands::open_local_terminal_session,
            commands::close_ssh_session,
            commands::write_terminal_input,
            commands::read_terminal_output,
            commands::resize_terminal,
            commands::list_remote_files,
            commands::upload_remote_file,
            commands::upload_local_paths,
            commands::download_remote_file,
            commands::download_remote_paths,
            commands::delete_remote_path,
            commands::delete_remote_paths,
            commands::copy_remote_paths,
            commands::rename_remote_path,
            commands::load_editor_document,
            commands::save_editor_document,
            commands::list_tunnels,
            commands::fetch_runtime_overview,
            commands::fetch_runtime_resource_usage,
            commands::fetch_runtime_storage_files,
            commands::open_tunnel,
            commands::update_tunnel,
            commands::start_tunnel,
            commands::close_tunnel,
            commands::read_remote_shell_history,
            commands::append_command_history,
            commands::get_command_suggestions,
            commands::check_for_updates,
            commands::download_and_install_update,
            commands::open_external_url,
            commands::export_local_config,
            commands::import_local_config,
            commands::test_webdav_connection,
            commands::upload_settings_to_webdav,
            commands::list_settings_backups,
            commands::download_settings_from_webdav,
            commands::upload_connections_to_webdav,
            commands::list_connections_backups,
            commands::download_connections_from_webdav,
            commands::upload_config_to_webdav,
            commands::list_config_backups,
            commands::download_config_from_webdav,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
