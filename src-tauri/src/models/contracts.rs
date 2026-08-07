//! 应用启动、隧道、更新、配置交换与加密落盘契约。

use serde::{Deserialize, Serialize};

use super::{connections::*, settings::*};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub connection_id: String,
    pub path: String,
    pub content: String,
    pub language: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRecord {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    #[serde(default = "default_local_tunnel_port")]
    pub local_port: u16,
    #[serde(default = "default_remote_tunnel_host")]
    pub remote_host: String,
    #[serde(default = "default_remote_tunnel_port")]
    pub remote_port: u16,
    #[serde(default = "default_tunnel_status")]
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub settings: AppSettings,
    pub local_terminals: LocalTerminalSettings,
    pub connections: Vec<ConnectionProfile>,
    pub history: Vec<HistoryEntry>,
    pub sessions: Vec<TerminalSession>,
    pub tunnels: Vec<TunnelRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub release_name: Option<String>,
    pub release_url: String,
    pub published_at: Option<String>,
    pub update_available: bool,
    pub installer_asset_name: Option<String>,
    pub installer_download_url: Option<String>,
    pub installer_size: Option<u64>,
    pub release_body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfigBundle {
    #[serde(default = "default_schema_version")]
    pub schema_version: u16,
    #[serde(default = "now_rfc3339")]
    pub exported_at: String,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub connections: Vec<ConnectionProfile>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub tunnels: Vec<TunnelRecord>,
    /// AI 端点及明文 API Key，与连接密码一样随配置包明文保存。
    /// 旧版备份没有该字段：导入时 None 表示不改动本地端点配置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_providers: Option<Vec<AgentProvider>>,
}

fn default_schema_version() -> u16 {
    1
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryInput {
    pub id: Option<String>,
    pub connection_id: Option<String>,
    pub command: String,
    pub executed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelOpenRequest {
    pub connection_id: String,
    pub name: String,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelUpdateRequest {
    // 编辑隧道必须定位已有记录，其余端点字段与新增保持一致，避免两套校验规则漂移。
    pub id: String,
    pub connection_id: String,
    pub name: String,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAppSettings {
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    #[serde(default = "default_runtime_refresh_interval_sec")]
    pub runtime_refresh_interval_sec: u16,
    #[serde(default = "default_runtime_storage_refresh_interval_sec")]
    pub runtime_storage_refresh_interval_sec: u16,
    #[serde(default = "default_runtime_resource_refresh_interval_sec")]
    pub runtime_resource_refresh_interval_sec: u16,
    #[serde(default = "default_runtime_resource_source")]
    pub runtime_resource_source: String,
    #[serde(default = "default_ssh_keepalive_interval_sec")]
    pub ssh_keepalive_interval_sec: u16,
    #[serde(default = "default_shell_latin_font_family")]
    pub shell_latin_font_family: String,
    #[serde(default = "default_shell_cjk_font_family")]
    pub shell_cjk_font_family: String,
    #[serde(default = "default_shell_font_family")]
    pub shell_font_family: String,
    #[serde(default = "default_shell_font_size")]
    pub shell_font_size: u16,
    #[serde(default = "default_shell_line_height")]
    pub shell_line_height: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_chat_latin_font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_chat_cjk_font_family: Option<String>,
    #[serde(default)]
    pub agent_chat_font_size: u16,
    #[serde(default = "default_agent_chat_line_height")]
    pub agent_chat_line_height: f32,
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
    #[serde(default = "default_terminal_line_wrap_mode")]
    pub terminal_line_wrap_mode: String,
    #[serde(default = "default_terminal_match_selection")]
    pub terminal_match_selection: bool,
    #[serde(default = "default_terminal_gutter_show_line_number")]
    pub terminal_gutter_show_line_number: bool,
    #[serde(default = "default_terminal_gutter_show_timestamp")]
    pub terminal_gutter_show_timestamp: bool,
    #[serde(default)]
    pub compact_sidebar: bool,
    #[serde(default = "default_show_command_ghost")]
    pub show_command_ghost: bool,
    #[serde(default = "default_hardware_acceleration")]
    pub hardware_acceleration: bool,
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
    /// 旧文件反序列化时回退 SSH，新保存的数据显式写入协议，避免再靠端口猜类型。
    #[serde(default = "default_connection_protocol")]
    pub protocol: String,
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
    pub jump_hosts: Vec<StoredSshJumpHost>,
    #[serde(default)]
    pub proxy: StoredSshProxyConfig,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSshJumpHost {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSshProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_proxy_type", rename = "type")]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password_encrypted: String,
}

impl Default for StoredSshProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: default_proxy_type(),
            host: String::new(),
            port: default_proxy_port(),
            username: None,
            password_encrypted: String::new(),
        }
    }
}

#[cfg(test)]
mod connection_profile_compatibility_tests {
    use super::ConnectionProfile;

    #[test]
    fn legacy_connection_without_protocol_defaults_to_ssh() {
        // 0.6.6 及更早版本没有 protocol；直接反序列化旧结构必须保持 SSH 和 22 端口语义。
        let connection: ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": "legacy-ssh",
            "name": "Legacy Linux",
            "host": "192.168.1.10",
            "username": "root",
            "password": "secret"
        }))
        .expect("legacy connection should deserialize");

        assert_eq!(connection.protocol, "ssh");
        assert_eq!(connection.port, 22);
    }
}
