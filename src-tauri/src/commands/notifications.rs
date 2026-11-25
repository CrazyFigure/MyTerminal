//! 本地终端系统通知适配器（Windows Toast / 跨平台桌面通知）与点击跳转聚焦。

use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const LOCAL_TERMINAL_NOTIFICATION_ACTIVATED_EVENT: &str =
    "local-terminal-notification-activated";

const fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalNotificationRequest {
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default = "default_true")]
    pub only_when_background: bool,
    #[serde(default)]
    pub session_is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalNotificationActivatedEvent {
    pub session_id: String,
    pub kind: String,
}

// 构造符合 Windows Toast 长度与字符约束的稳定标签；同一会话重复提醒时覆盖旧通知而非堆满通知中心。
fn build_toast_tag(session_id: &str) -> String {
    const PREFIX: &str = "mt-lt-";
    const MAX_LEN: usize = 64;
    let sanitized: String = session_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .take(MAX_LEN - PREFIX.len())
        .collect();
    if sanitized.is_empty() {
        format!("{PREFIX}session")
    } else {
        format!("{PREFIX}{sanitized}")
    }
}

// 仅在启用“仅后台提醒”且主窗口正处于可见未最小化且获焦、同时目标标签就是当前激活标签时跳过提醒。
fn should_skip_foreground_notification(
    app_handle: &AppHandle,
    only_when_background: bool,
    session_is_active: bool,
) -> bool {
    if !only_when_background || !session_is_active {
        return false;
    }
    let Some(window) = app_handle.get_webview_window("main") else {
        return false;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    visible && !minimized && focused
}

// 点击系统通知后把主窗口恢复到前台并获取焦点，再由前端切换到对应会话标签。
fn activate_session_window(app_handle: &AppHandle, session_id: String, kind: String) {
    let focus_handle = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        if let Some(window) = focus_handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    let _ = app_handle.emit(
        LOCAL_TERMINAL_NOTIFICATION_ACTIVATED_EVENT,
        LocalTerminalNotificationActivatedEvent { session_id, kind },
    );
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::path::MAIN_SEPARATOR;
    use windows::{
        core::{IInspectable, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{
            ToastDismissalReason, ToastDismissedEventArgs, ToastNotification,
            ToastNotificationManager,
        },
    };

    const TOAST_GROUP: &str = "myterminal-local-terminal";
    // 未安装运行（target\debug / target\release）时系统没有注册 MyTerminal 的 Start Menu AUMID，
    // 沿用 tauri-plugin-notification 的做法回退到 PowerShell AUMID，确保开发态通知同样可弹出并响应点击。
    const POWERSHELL_APP_ID: &str =
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    const MAX_ACTIVE_TOASTS: usize = 32;

    static ACTIVE_TOASTS: OnceLock<Mutex<Vec<(String, ToastNotification)>>> = OnceLock::new();

    fn toast_registry() -> &'static Mutex<Vec<(String, ToastNotification)>> {
        ACTIVE_TOASTS.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn store_active_toast(tag: String, toast: ToastNotification) {
        if let Ok(mut list) = toast_registry().lock() {
            list.retain(|(existing_tag, _)| existing_tag != &tag);
            if list.len() >= MAX_ACTIVE_TOASTS {
                list.remove(0);
            }
            list.push((tag, toast));
        }
    }

    fn remove_active_toast(tag: &str) {
        if let Ok(mut list) = toast_registry().lock() {
            list.retain(|(existing_tag, _)| existing_tag != tag);
        }
    }

    pub(super) fn escape_xml_text(value: &str) -> String {
        let mut escaped = String::with_capacity(value.len());
        for ch in value.chars() {
            match ch {
                '&' => escaped.push_str("&amp;"),
                '<' => escaped.push_str("&lt;"),
                '>' => escaped.push_str("&gt;"),
                '"' => escaped.push_str("&quot;"),
                '\'' => escaped.push_str("&apos;"),
                // 剔除 XML 1.0 非法控制字符，避免终端转义残留导致 XmlDocument::LoadXml 失败。
                '\n' | '\r' | '\t' => escaped.push(ch),
                ch if (ch as u32) < 0x20 || ch == '\u{7f}' => {}
                _ => escaped.push(ch),
            }
        }
        escaped
    }

    pub(super) fn build_toast_xml(title: &str, body: &str) -> String {
        let title_xml = escape_xml_text(title.trim());
        let body_trimmed = body.trim();
        let body_xml = if body_trimmed.is_empty() {
            String::new()
        } else {
            format!("<text id=\"2\">{}</text>", escape_xml_text(body_trimmed))
        };
        format!(
            "<toast duration=\"short\"><visual><binding template=\"ToastGeneric\"><text id=\"1\">{title_xml}</text>{body_xml}</binding></visual></toast>"
        )
    }

    fn resolve_app_user_model_id(app_handle: &AppHandle) -> String {
        if let Ok(exe) = tauri::utils::platform::current_exe() {
            if let Some(dir) = exe.parent() {
                let dir_str = dir.display().to_string();
                if dir_str.ends_with(&format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}debug"))
                    || dir_str.ends_with(&format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}release"))
                {
                    return POWERSHELL_APP_ID.to_string();
                }
            }
        }
        app_handle.config().identifier.clone()
    }

    pub(super) fn show_notification(
        app_handle: &AppHandle,
        request: LocalTerminalNotificationRequest,
    ) -> Result<(), String> {
        let tag = build_toast_tag(&request.session_id);
        let xml_doc = XmlDocument::new().map_err(|error| format!("toast xml init error: {error}"))?;
        let xml_payload = build_toast_xml(&request.title, &request.body);
        xml_doc
            .LoadXml(&HSTRING::from(xml_payload))
            .map_err(|error| format!("toast xml load error: {error}"))?;

        let toast = ToastNotification::CreateToastNotification(&xml_doc)
            .map_err(|error| format!("toast create error: {error}"))?;
        let _ = toast.SetTag(&HSTRING::from(&tag));
        let _ = toast.SetGroup(&HSTRING::from(TOAST_GROUP));

        let activated_app = app_handle.clone();
        let activated_session = request.session_id.clone();
        let activated_kind = request.kind.clone();
        let activated_tag = tag.clone();
        let activated_handler =
            TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
                remove_active_toast(&activated_tag);
                activate_session_window(
                    &activated_app,
                    activated_session.clone(),
                    activated_kind.clone(),
                );
                Ok(())
            });
        toast
            .Activated(&activated_handler)
            .map_err(|error| format!("toast activated hook error: {error}"))?;

        let dismissed_tag = tag.clone();
        let dismissed_handler =
            TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    if let Ok(reason) = args.Reason() {
                        // 超时退入操作中心（TimedOut）时保留句柄，用户稍后在操作中心点击仍可跳转回对应标签。
                        if reason != ToastDismissalReason::TimedOut {
                            remove_active_toast(&dismissed_tag);
                        }
                    }
                }
                Ok(())
            });
        toast
            .Dismissed(&dismissed_handler)
            .map_err(|error| format!("toast dismissed hook error: {error}"))?;

        let preferred_aumid = resolve_app_user_model_id(app_handle);
        let show_with_aumid = |aumid: &str| -> windows::core::Result<()> {
            let notifier =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))?;
            notifier.Show(&toast)
        };

        if let Err(primary_error) = show_with_aumid(&preferred_aumid) {
            if preferred_aumid == POWERSHELL_APP_ID
                || show_with_aumid(POWERSHELL_APP_ID).is_err()
            {
                return Err(format!("toast show error: {primary_error}"));
            }
        }

        store_active_toast(tag, toast);
        Ok(())
    }

    pub(super) fn clear_notification(app_handle: &AppHandle, session_id: &str) {
        let tag = build_toast_tag(session_id);
        remove_active_toast(&tag);
        let tag_h = HSTRING::from(tag);
        let group_h = HSTRING::from(TOAST_GROUP);
        let preferred_aumid = resolve_app_user_model_id(app_handle);
        if let Ok(history) = ToastNotificationManager::History() {
            let _ = history.RemoveGroupedTagWithId(&tag_h, &group_h, &HSTRING::from(preferred_aumid));
            let _ = history.RemoveGroupedTagWithId(&tag_h, &group_h, &HSTRING::from(POWERSHELL_APP_ID));
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use std::thread;

    pub(super) fn show_notification(
        app_handle: &AppHandle,
        request: LocalTerminalNotificationRequest,
    ) -> Result<(), String> {
        let mut notification = notify_rust::Notification::new();
        notification.summary(&request.title).body(&request.body);
        let handle = notification
            .show()
            .map_err(|error| format!("notification error: {error}"))?;

        let activated_app = app_handle.clone();
        let session_id = request.session_id;
        let kind = request.kind;
        thread::spawn(move || {
            let _ = handle.wait_for_response(|response| {
                if matches!(
                    response,
                    notify_rust::NotificationResponse::Default
                        | notify_rust::NotificationResponse::Action(_)
                ) {
                    activate_session_window(&activated_app, session_id, kind);
                }
            });
        });
        Ok(())
    }

    pub(super) fn clear_notification(_app_handle: &AppHandle, _session_id: &str) {}
}

/// 在本地终端任务完成或等待用户输入时发送系统通知；点击通知时唤醒主窗口并跳转到对应标签。
#[tauri::command]
pub fn show_local_terminal_notification(
    app_handle: AppHandle,
    request: LocalTerminalNotificationRequest,
) -> Result<bool, String> {
    if request.session_id.trim().is_empty() || request.title.trim().is_empty() {
        return Ok(false);
    }
    if should_skip_foreground_notification(
        &app_handle,
        request.only_when_background,
        request.session_is_active,
    ) {
        return Ok(false);
    }
    platform::show_notification(&app_handle, request)?;
    Ok(true)
}

/// 切换到目标标签或关闭标签时清理操作中心里遗留的旧提醒。
#[tauri::command]
pub fn clear_local_terminal_notification(
    app_handle: AppHandle,
    session_id: String,
) -> Result<bool, String> {
    if session_id.trim().is_empty() {
        return Ok(false);
    }
    platform::clear_notification(&app_handle, &session_id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::build_toast_tag;

    #[test]
    fn builds_bounded_sanitized_toast_tag() {
        let long_id = format!("{}@!", "a".repeat(80));
        let tag = build_toast_tag(&long_id);
        assert!(tag.len() <= 64);
        assert!(tag.starts_with("mt-lt-"));
        assert!(!tag.contains('@'));
    }

    #[cfg(windows)]
    #[test]
    fn escapes_xml_and_strips_control_chars_for_toast_payload() {
        let xml = super::platform::build_toast_xml("任务 <完成> & \"确认\"\x07", "line1\nline2 'ok'");
        assert!(xml.contains("&lt;完成&gt; &amp; &quot;确认&quot;"));
        assert!(!xml.contains('\x07'));
        assert!(xml.contains("line1\nline2 &apos;ok&apos;"));
    }
}
