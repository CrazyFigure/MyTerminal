use serde::{Deserialize, Serialize};

use crate::domain::entities::{
    default_accent_color, default_auth_method, default_connection_groups, default_connection_order,
    default_quick_commands, default_remote_connections_path, default_remote_path,
    default_remote_settings_path, default_runtime_refresh_interval_sec,
    default_shell_cjk_font_family, default_shell_font_family, default_shell_font_size,
    default_shell_latin_font_family, default_show_command_ghost, default_ssh_port,
    default_terminal_background, default_terminal_background_image_fit,
    default_terminal_background_image_opacity, default_terminal_foreground,
    default_terminal_right_click_behavior, default_theme_mode, default_ui_language, new_id,
    AgentBridgeSettings,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAppSettings {
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    #[serde(default = "default_runtime_refresh_interval_sec")]
    pub runtime_refresh_interval_sec: u16,
    #[serde(default = "default_shell_latin_font_family")]
    pub shell_latin_font_family: String,
    #[serde(default = "default_shell_cjk_font_family")]
    pub shell_cjk_font_family: String,
    #[serde(default = "default_shell_font_family")]
    pub shell_font_family: String,
    #[serde(default = "default_shell_font_size")]
    pub shell_font_size: u16,
    #[serde(default = "default_terminal_background")]
    pub terminal_background: String,
    #[serde(default = "default_terminal_foreground")]
    pub terminal_foreground: String,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default)]
    pub background_image: Option<String>,
    #[serde(default = "default_terminal_background_image_opacity")]
    pub terminal_background_image_opacity: f32,
    #[serde(default = "default_terminal_background_image_fit")]
    pub terminal_background_image_fit: String,
    #[serde(default = "default_terminal_right_click_behavior")]
    pub terminal_right_click_behavior: String,
    #[serde(default)]
    pub compact_sidebar: bool,
    #[serde(default = "default_show_command_ghost")]
    pub show_command_ghost: bool,
    #[serde(default = "default_connection_groups")]
    pub connection_groups: Vec<String>,
    #[serde(default = "default_connection_order")]
    pub connection_order: Vec<String>,
    #[serde(default = "default_quick_commands")]
    pub quick_commands: Vec<String>,
    #[serde(default)]
    pub agent_bridge: AgentBridgeSettings,
    #[serde(default)]
    pub webdav_base_url: String,
    #[serde(default)]
    pub webdav_username: String,
    #[serde(default)]
    pub webdav_password_encrypted: String,
    #[serde(default = "default_remote_path")]
    pub webdav_remote_path: String,
    /// 旧字段保留反序列化兼容，已有配置文件中仍包含此字段。
    #[serde(default = "default_remote_settings_path", skip_serializing)]
    pub webdav_remote_settings_path: String,
    /// 旧字段保留反序列化兼容，已有配置文件中仍包含此字段。
    #[serde(default = "default_remote_connections_path", skip_serializing)]
    pub webdav_remote_connections_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredConnectionProfile {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub group_path: Option<String>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    #[serde(default)]
    pub password_encrypted: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_text_encrypted: String,
    #[serde(default)]
    pub passphrase_encrypted: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stored_app_settings_deserialize_empty() {
        let json = r#"{}"#;
        let settings: StoredAppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.ui_language, "zh-CN");
        assert_eq!(settings.theme_mode, "light");
        assert_eq!(settings.runtime_refresh_interval_sec, 1);
        assert_eq!(settings.shell_font_size, 15);
        assert_eq!(settings.terminal_background, "#f7f7f7");
        assert_eq!(settings.accent_color, "#4f46e5");
        assert!(settings.show_command_ghost); // default is true
        assert!(settings.background_image.is_none());
        assert!(settings.connection_groups.is_empty());
        assert!(settings.webdav_base_url.is_empty());
    }

    #[test]
    fn test_stored_app_settings_serde_roundtrip() {
        let settings = StoredAppSettings {
            ui_language: "en".into(),
            theme_mode: "dark".into(),
            runtime_refresh_interval_sec: 5,
            shell_latin_font_family: "mono".into(),
            shell_cjk_font_family: "cjk".into(),
            shell_font_family: "font".into(),
            shell_font_size: 16,
            terminal_background: "#000".into(),
            terminal_foreground: "#fff".into(),
            accent_color: "#ff0".into(),
            background_image: Some("bg.png".into()),
            terminal_background_image_opacity: 0.5,
            terminal_background_image_fit: "fill".into(),
            terminal_right_click_behavior: "menu".into(),
            compact_sidebar: true,
            show_command_ghost: false,
            connection_groups: vec!["prod".into()],
            connection_order: vec!["c1".into()],
            quick_commands: vec!["ls".into()],
            agent_bridge: AgentBridgeSettings::default(),
            webdav_base_url: "https://dav.example.com".into(),
            webdav_username: "user".into(),
            webdav_password_encrypted: "enc".into(),
            webdav_remote_path: "/remote".into(),
            webdav_remote_settings_path: String::new(),
            webdav_remote_connections_path: String::new(),
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: StoredAppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.ui_language, "en");
        assert_eq!(deserialized.theme_mode, "dark");
        assert_eq!(deserialized.background_image, Some("bg.png".into()));
        assert_eq!(deserialized.webdav_base_url, "https://dav.example.com");
    }

    #[test]
    fn test_stored_app_settings_skip_serializing_old_fields() {
        let settings = StoredAppSettings {
            ui_language: "zh-CN".into(),
            theme_mode: "light".into(),
            runtime_refresh_interval_sec: 1,
            shell_latin_font_family: String::new(),
            shell_cjk_font_family: String::new(),
            shell_font_family: String::new(),
            shell_font_size: 15,
            terminal_background: String::new(),
            terminal_foreground: String::new(),
            accent_color: String::new(),
            background_image: None,
            terminal_background_image_opacity: 0.0,
            terminal_background_image_fit: String::new(),
            terminal_right_click_behavior: String::new(),
            compact_sidebar: false,
            show_command_ghost: false,
            connection_groups: vec![],
            connection_order: vec![],
            quick_commands: vec![],
            agent_bridge: AgentBridgeSettings::default(),
            webdav_base_url: String::new(),
            webdav_username: String::new(),
            webdav_password_encrypted: String::new(),
            webdav_remote_path: String::new(),
            webdav_remote_settings_path: "old/path".into(),
            webdav_remote_connections_path: "old/conn".into(),
        };
        let json = serde_json::to_string(&settings).unwrap();
        // These fields should not appear in serialized JSON
        assert!(!json.contains("remoteSettingsPath"));
        assert!(!json.contains("remoteConnectionsPath"));
    }

    #[test]
    fn test_stored_connection_profile_deserialize_empty() {
        let json = r#"{}"#;
        let profile: StoredConnectionProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.port, 22);
        assert_eq!(profile.auth_method, "password");
        assert!(!profile.id.is_empty());
        assert!(profile.host.is_empty());
        assert!(profile.tags.is_empty());
    }

    #[test]
    fn test_stored_connection_profile_serde_roundtrip() {
        let profile = StoredConnectionProfile {
            id: "test-id".into(),
            name: "myserver".into(),
            group_path: Some("prod/web".into()),
            host: "10.0.0.1".into(),
            port: 2222,
            username: "admin".into(),
            auth_method: "privateKey".into(),
            password_encrypted: "enc-pass".into(),
            private_key_path: Some("/path/to/key".into()),
            private_key_text_encrypted: "enc-key".into(),
            passphrase_encrypted: "enc-phrase".into(),
            note: Some("my server".into()),
            tags: vec!["prod".into(), "web".into()],
        };
        let json = serde_json::to_string(&profile).unwrap();
        let deserialized: StoredConnectionProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "test-id");
        assert_eq!(deserialized.name, "myserver");
        assert_eq!(deserialized.host, "10.0.0.1");
        assert_eq!(deserialized.port, 2222);
        assert_eq!(deserialized.tags, vec!["prod", "web"]);
    }

    #[test]
    fn test_stored_connection_profile_minimal() {
        let json = r#"{"host":"example.com"}"#;
        let profile: StoredConnectionProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.host, "example.com");
        assert_eq!(profile.port, 22); // default
        assert_eq!(profile.username, ""); // default empty
        assert!(profile.note.is_none());
    }
}
