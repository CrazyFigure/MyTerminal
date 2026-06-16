use chrono::Utc;
use serde::{Deserialize, Serialize};

pub fn default_quick_commands() -> Vec<String> {
    vec!["pwd".into(), "ls -la".into(), "docker ps".into()]
}

pub fn default_theme_mode() -> String {
    "light".into()
}

pub fn default_ui_language() -> String {
    "zh-CN".into()
}

pub fn default_shell_font_family() -> String {
    "JetBrains Mono".into()
}

pub fn default_shell_latin_font_family() -> String {
    "JetBrains Mono".into()
}

pub fn default_shell_cjk_font_family() -> String {
    "Microsoft YaHei UI".into()
}

pub fn default_shell_font_size() -> u16 {
    15
}

pub fn default_runtime_refresh_interval_sec() -> u16 {
    1
}

pub fn default_terminal_background() -> String {
    "#f7f7f7".into()
}

pub fn default_terminal_foreground() -> String {
    "#111111".into()
}

pub fn default_accent_color() -> String {
    "#4f46e5".into()
}

pub fn default_terminal_background_image_opacity() -> f32 {
    0.18
}

pub fn default_terminal_background_image_fit() -> String {
    "cover".into()
}

pub fn default_terminal_right_click_behavior() -> String {
    "paste".into()
}

pub fn default_show_command_ghost() -> bool {
    true
}

pub fn default_agent_bridge_timeout_sec() -> u16 {
    60
}

pub fn default_agent_bridge_max_output_bytes() -> usize {
    200_000
}

pub fn default_connection_groups() -> Vec<String> {
    Vec::new()
}

pub fn default_connection_order() -> Vec<String> {
    Vec::new()
}

pub fn default_auth_method() -> String {
    "password".into()
}

pub fn default_remote_path() -> String {
    "/myterminal".into()
}

pub fn default_remote_settings_path() -> String {
    "/myterminal".into()
}

pub fn default_remote_connections_path() -> String {
    "/myterminal".into()
}

pub fn default_ssh_port() -> u16 {
    22
}

pub fn default_local_tunnel_port() -> u16 {
    15432
}

pub fn default_remote_tunnel_host() -> String {
    "127.0.0.1".into()
}

pub fn default_remote_tunnel_port() -> u16 {
    5432
}

pub fn default_bind_address() -> String {
    "127.0.0.1".into()
}

pub fn default_tunnel_status() -> String {
    "stopped".into()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSettings {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub sync_passphrase: String,
    /// 远程同步目录，合并后只保留一个路径。
    #[serde(default = "default_remote_path")]
    pub remote_path: String,
    /// 旧字段保留反序列化兼容，已有配置文件中仍包含此字段。
    #[serde(default = "default_remote_settings_path", skip_serializing)]
    pub remote_settings_path: String,
    /// 旧字段保留反序列化兼容，已有配置文件中仍包含此字段。
    #[serde(default = "default_remote_connections_path", skip_serializing)]
    pub remote_connections_path: String,
}

impl Default for WebDavSettings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            username: String::new(),
            password: String::new(),
            sync_passphrase: String::new(),
            remote_path: "/myterminal".into(),
            remote_settings_path: String::new(),
            remote_connections_path: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeSettings {
    /// AI Bridge 默认关闭，只有用户在设置页明确启用后才暴露本地 Broker。
    #[serde(default)]
    pub enabled: bool,
    /// 自动执行只对用户选择的连接生效；关闭时命令和写操作都必须由 GUI 审批。
    #[serde(default)]
    pub auto_execute: bool,
    /// 允许自动执行的连接白名单；为空时不自动执行任何连接。
    #[serde(default)]
    pub allowed_connection_ids: Vec<String>,
    /// 远端命令默认超时，避免 agent 发起的命令长期占用 SSH channel。
    #[serde(default = "default_agent_bridge_timeout_sec")]
    pub default_timeout_sec: u16,
    /// 单次命令输出最大保留字节数，超出后截断并标记 truncated。
    #[serde(default = "default_agent_bridge_max_output_bytes")]
    pub max_output_bytes: usize,
}

impl Default for AgentBridgeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_execute: false,
            allowed_connection_ids: Vec::new(),
            default_timeout_sec: default_agent_bridge_timeout_sec(),
            max_output_bytes: default_agent_bridge_max_output_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    #[serde(default = "default_runtime_refresh_interval_sec")]
    pub runtime_refresh_interval_sec: u16,
    /// 终端英文字体用于 ASCII、数字和符号优先匹配。
    #[serde(default = "default_shell_latin_font_family")]
    pub shell_latin_font_family: String,
    /// 终端中文字体用于 CJK 字符优先匹配，避免中文回退影响英文宽度。
    #[serde(default = "default_shell_cjk_font_family")]
    pub shell_cjk_font_family: String,
    /// 旧版单字体字段保留兼容，保存时前端会同步成中英文字体组合。
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
    /// 终端右键行为由前端执行，后端负责持久化用户偏好。
    #[serde(default = "default_terminal_right_click_behavior")]
    pub terminal_right_click_behavior: String,
    #[serde(default)]
    pub compact_sidebar: bool,
    #[serde(default = "default_show_command_ghost")]
    pub show_command_ghost: bool,
    /// 连接分组需要独立持久化，保证空分组也能在连接管理中保留。
    #[serde(default = "default_connection_groups")]
    pub connection_groups: Vec<String>,
    /// 连接列表排序独立于连接内容，避免拖拽排序污染连接密文文件结构。
    #[serde(default = "default_connection_order")]
    pub connection_order: Vec<String>,
    #[serde(default = "default_quick_commands")]
    pub quick_commands: Vec<String>,
    #[serde(default)]
    pub webdav: WebDavSettings,
    #[serde(default)]
    pub agent_bridge: AgentBridgeSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ui_language: "zh-CN".into(),
            theme_mode: "light".into(),
            runtime_refresh_interval_sec: 1,
            shell_latin_font_family: default_shell_latin_font_family(),
            shell_cjk_font_family: default_shell_cjk_font_family(),
            shell_font_family: "JetBrains Mono".into(),
            shell_font_size: 15,
            terminal_background: "#f7f7f7".into(),
            terminal_foreground: "#111111".into(),
            accent_color: "#4f46e5".into(),
            background_image: None,
            terminal_background_image_opacity: default_terminal_background_image_opacity(),
            terminal_background_image_fit: default_terminal_background_image_fit(),
            terminal_right_click_behavior: default_terminal_right_click_behavior(),
            compact_sidebar: false,
            show_command_ghost: true,
            connection_groups: default_connection_groups(),
            connection_order: default_connection_order(),
            quick_commands: default_quick_commands(),
            webdav: WebDavSettings::default(),
            agent_bridge: AgentBridgeSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
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
    pub password: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_text: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub command: String,
    #[serde(default = "now_rfc3339")]
    pub executed_at: String,
}

impl HistoryEntry {
    pub fn new(connection_id: Option<String>, command: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id,
            command,
            executed_at: Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputChunk {
    #[serde(default)]
    pub session_id: String,
    /// 远端 Shell 当前目录；仅用于前端同步文件管理路径，不作为终端可见输出。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 会话状态结构化回传给前端标签栏，避免把连接/断开提示写入终端正文。
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub modified_at: Option<String>,
    /// 类 Unix 权限文本，便于前端按表格方式展示文件属性。
    #[serde(default)]
    pub permissions: Option<String>,
    /// 文件属主；SFTP 只能返回 uid 时使用数字字符串兜底。
    #[serde(default)]
    pub owner: Option<String>,
    /// 文件属组；SFTP 只能返回 gid 时使用数字字符串兜底。
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCpuCore {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOverview {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub cpu: String,
    /// 每个 CPU 核心的采样占用率，前端点击总 CPU 行时按需展开。
    #[serde(default)]
    pub cpu_cores: Vec<RuntimeCpuCore>,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub storage: String,
    #[serde(default)]
    pub network: String,
    #[serde(default)]
    pub uptime: String,
}

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
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Step 1: default_*() function tests ───────────────────────────────

    #[test]
    fn test_default_quick_commands() {
        let cmds = default_quick_commands();
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0], "pwd");
        assert!(cmds.contains(&"docker ps".to_string()));
    }

    #[test]
    fn test_default_theme_mode() {
        assert_eq!(default_theme_mode(), "light");
    }

    #[test]
    fn test_default_ui_language() {
        assert_eq!(default_ui_language(), "zh-CN");
    }

    #[test]
    fn test_default_shell_font_family() {
        let v = default_shell_font_family();
        assert!(!v.is_empty(), "font family should not be empty");
    }

    #[test]
    fn test_default_shell_latin_font_family() {
        let v = default_shell_latin_font_family();
        assert!(!v.is_empty(), "latin font family should not be empty");
    }

    #[test]
    fn test_default_shell_cjk_font_family() {
        let v = default_shell_cjk_font_family();
        assert!(!v.is_empty(), "CJK font family should not be empty");
    }

    #[test]
    fn test_default_shell_font_size() {
        assert!(default_shell_font_size() > 0);
    }

    #[test]
    fn test_default_runtime_refresh_interval_sec() {
        assert!(default_runtime_refresh_interval_sec() > 0);
    }

    #[test]
    fn test_default_terminal_background() {
        let v = default_terminal_background();
        assert!(!v.is_empty(), "background should not be empty");
        assert!(v.starts_with('#'), "background should start with #");
    }

    #[test]
    fn test_default_terminal_foreground() {
        let v = default_terminal_foreground();
        assert!(!v.is_empty(), "foreground should not be empty");
        assert!(v.starts_with('#'), "foreground should start with #");
    }

    #[test]
    fn test_default_accent_color() {
        let v = default_accent_color();
        assert!(!v.is_empty(), "accent color should not be empty");
        assert!(v.starts_with('#'), "accent color should start with #");
    }

    #[test]
    fn test_default_terminal_background_image_opacity() {
        let v = default_terminal_background_image_opacity();
        assert!((0.0..=1.0).contains(&v), "opacity should be in [0.0, 1.0]");
    }

    #[test]
    fn test_default_terminal_background_image_fit() {
        assert_eq!(default_terminal_background_image_fit(), "cover");
    }

    #[test]
    fn test_default_terminal_right_click_behavior() {
        assert_eq!(default_terminal_right_click_behavior(), "paste");
    }

    #[test]
    fn test_default_show_command_ghost() {
        assert!(default_show_command_ghost());
    }

    #[test]
    fn test_default_agent_bridge_timeout_sec() {
        assert!(default_agent_bridge_timeout_sec() > 0);
    }

    #[test]
    fn test_default_agent_bridge_max_output_bytes() {
        assert!(default_agent_bridge_max_output_bytes() > 0);
    }

    #[test]
    fn test_default_connection_groups() {
        let v = default_connection_groups();
        assert!(v.is_empty(), "connection groups should be empty");
    }

    #[test]
    fn test_default_connection_order() {
        let v = default_connection_order();
        assert!(v.is_empty(), "connection order should be empty");
    }

    #[test]
    fn test_default_auth_method() {
        assert_eq!(default_auth_method(), "password");
    }

    #[test]
    fn test_default_remote_path() {
        let v = default_remote_path();
        assert!(!v.is_empty(), "remote path should not be empty");
        assert!(v.starts_with('/'), "remote path should start with /");
    }

    #[test]
    fn test_default_remote_settings_path() {
        let v = default_remote_settings_path();
        assert!(!v.is_empty(), "remote settings path should not be empty");
    }

    #[test]
    fn test_default_remote_connections_path() {
        let v = default_remote_connections_path();
        assert!(!v.is_empty(), "remote connections path should not be empty");
    }

    #[test]
    fn test_default_ssh_port() {
        assert_eq!(default_ssh_port(), 22);
    }

    #[test]
    fn test_default_local_tunnel_port() {
        assert_eq!(default_local_tunnel_port(), 15432);
    }

    #[test]
    fn test_default_remote_tunnel_host() {
        let v = default_remote_tunnel_host();
        assert!(!v.is_empty(), "remote tunnel host should not be empty");
    }

    #[test]
    fn test_default_remote_tunnel_port() {
        assert!(default_remote_tunnel_port() > 0);
    }

    #[test]
    fn test_default_bind_address() {
        let v = default_bind_address();
        assert!(!v.is_empty(), "bind address should not be empty");
    }

    #[test]
    fn test_default_tunnel_status() {
        assert_eq!(default_tunnel_status(), "stopped");
    }

    // ─── Step 2: impl Default tests ──────────────────────────────────────

    // 2a. WebDavSettings::default()

    #[test]
    fn test_webdav_settings_default_base_url() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.base_url, "");
    }

    #[test]
    fn test_webdav_settings_default_username() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.username, "");
    }

    #[test]
    fn test_webdav_settings_default_password() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.password, "");
    }

    #[test]
    fn test_webdav_settings_default_sync_passphrase() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.sync_passphrase, "");
    }

    #[test]
    fn test_webdav_settings_default_remote_path() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.remote_path, "/myterminal");
    }

    #[test]
    fn test_webdav_settings_default_remote_settings_path() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.remote_settings_path, "");
    }

    #[test]
    fn test_webdav_settings_default_remote_connections_path() {
        let settings = WebDavSettings::default();
        assert_eq!(settings.remote_connections_path, "");
    }

    // 2b. AgentBridgeSettings::default()

    #[test]
    fn test_agent_bridge_settings_default_enabled() {
        let settings = AgentBridgeSettings::default();
        assert!(!settings.enabled, "AI Bridge should be disabled by default");
    }

    #[test]
    fn test_agent_bridge_settings_default_auto_execute() {
        let settings = AgentBridgeSettings::default();
        assert!(!settings.auto_execute);
    }

    #[test]
    fn test_agent_bridge_settings_default_allowed_connection_ids() {
        let settings = AgentBridgeSettings::default();
        assert!(settings.allowed_connection_ids.is_empty());
    }

    #[test]
    fn test_agent_bridge_settings_default_timeout_sec() {
        let settings = AgentBridgeSettings::default();
        assert_eq!(
            settings.default_timeout_sec,
            default_agent_bridge_timeout_sec()
        );
        assert_eq!(settings.default_timeout_sec, 60);
    }

    #[test]
    fn test_agent_bridge_settings_default_max_output_bytes() {
        let settings = AgentBridgeSettings::default();
        assert_eq!(
            settings.max_output_bytes,
            default_agent_bridge_max_output_bytes()
        );
        assert_eq!(settings.max_output_bytes, 200_000);
    }

    // 2c. AppSettings::default()

    #[test]
    fn test_app_settings_default_ui_language() {
        let settings = AppSettings::default();
        assert_eq!(settings.ui_language, "zh-CN");
    }

    #[test]
    fn test_app_settings_default_theme_mode() {
        let settings = AppSettings::default();
        assert_eq!(settings.theme_mode, "light");
    }

    #[test]
    fn test_app_settings_default_shell_font_size() {
        let settings = AppSettings::default();
        assert_eq!(settings.shell_font_size, 15);
    }

    #[test]
    fn test_app_settings_default_terminal_background() {
        let settings = AppSettings::default();
        assert_eq!(settings.terminal_background, "#f7f7f7");
    }

    #[test]
    fn test_app_settings_default_terminal_foreground() {
        let settings = AppSettings::default();
        assert_eq!(settings.terminal_foreground, "#111111");
    }

    #[test]
    fn test_app_settings_default_accent_color() {
        let settings = AppSettings::default();
        assert_eq!(settings.accent_color, "#4f46e5");
    }

    #[test]
    fn test_app_settings_default_background_image() {
        let settings = AppSettings::default();
        assert_eq!(settings.background_image, None);
    }

    #[test]
    fn test_app_settings_default_compact_sidebar() {
        let settings = AppSettings::default();
        assert!(!settings.compact_sidebar);
    }

    #[test]
    fn test_app_settings_default_show_command_ghost() {
        let settings = AppSettings::default();
        assert!(settings.show_command_ghost);
    }

    #[test]
    fn test_app_settings_default_quick_commands() {
        let settings = AppSettings::default();
        assert_eq!(settings.quick_commands.len(), 3);
    }

    #[test]
    fn test_app_settings_default_webdav() {
        let settings = AppSettings::default();
        // Verify it matches WebDavSettings::default() field by field
        assert_eq!(settings.webdav.base_url, "");
        assert_eq!(settings.webdav.remote_path, "/myterminal");
    }

    #[test]
    fn test_app_settings_default_agent_bridge() {
        let settings = AppSettings::default();
        assert!(!settings.agent_bridge.enabled);
        assert_eq!(settings.agent_bridge.default_timeout_sec, 60);
        assert_eq!(settings.agent_bridge.max_output_bytes, 200_000);
    }

    // 2d. Derived Default structs

    #[test]
    fn test_runtime_cpu_core_default() {
        let core = RuntimeCpuCore::default();
        assert_eq!(core.name, "");
        assert_eq!(core.percent, 0.0);
    }

    #[test]
    fn test_runtime_overview_default() {
        let overview = RuntimeOverview::default();
        assert_eq!(overview.host, "");
        assert_eq!(overview.os, "");
        assert_eq!(overview.cpu, "");
        assert!(overview.cpu_cores.is_empty());
        assert_eq!(overview.memory, "");
        assert_eq!(overview.storage, "");
        assert_eq!(overview.network, "");
        assert_eq!(overview.uptime, "");
    }

    #[test]
    fn test_editor_document_default() {
        let doc = EditorDocument::default();
        assert_eq!(doc.connection_id, "");
        assert_eq!(doc.path, "");
        assert_eq!(doc.content, "");
        assert_eq!(doc.language, "");
        assert!(!doc.dirty);
    }

    // ─── Step 3: HistoryEntry tests ──────────────────────────────────────

    #[test]
    fn test_history_entry_new_has_id() {
        let entry = HistoryEntry::new(Some("conn-1".into()), "ls -la".into());
        assert!(!entry.id.is_empty(), "id should not be empty");
    }

    #[test]
    fn test_history_entry_new_has_executed_at() {
        let entry = HistoryEntry::new(Some("conn-1".into()), "ls -la".into());
        assert!(
            !entry.executed_at.is_empty(),
            "executed_at should not be empty"
        );
    }

    #[test]
    fn test_history_entry_new_stores_connection_id() {
        let entry = HistoryEntry::new(Some("conn-1".into()), "ls -la".into());
        assert_eq!(entry.connection_id, Some("conn-1".to_string()));
    }

    #[test]
    fn test_history_entry_new_stores_command() {
        let entry = HistoryEntry::new(None, "pwd".into());
        assert_eq!(entry.command, "pwd");
    }

    #[test]
    fn test_history_entry_new_connection_id_none() {
        let entry = HistoryEntry::new(None, "top".into());
        assert!(entry.connection_id.is_none());
        assert_eq!(entry.command, "top");
    }

    #[test]
    fn test_history_entry_new_id_unique() {
        let a = HistoryEntry::new(None, "a".into());
        let b = HistoryEntry::new(None, "b".into());
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn test_history_entry_serialize_deserialize_roundtrip() {
        let entry = HistoryEntry::new(Some("conn-1".into()), "ls -la".into());
        let json = serde_json::to_string(&entry).expect("serialize");
        let deserialized: HistoryEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(entry.id, deserialized.id);
        assert_eq!(entry.connection_id, deserialized.connection_id);
        assert_eq!(entry.command, deserialized.command);
        assert_eq!(entry.executed_at, deserialized.executed_at);
    }

    #[test]
    fn test_history_entry_default_id_not_empty() {
        // HistoryEntry doesn't implement Default, but via serde with {} we
        // get defaults from #[serde(default = "new_id")]
        let entry: HistoryEntry = serde_json::from_str("{}").expect("deserialize");
        assert!(
            !entry.id.is_empty(),
            "id from serde default should not be empty"
        );
    }

    // ─── Step 4: new_id() and now_rfc3339() tests ────────────────────────

    #[test]
    fn test_new_id_not_empty() {
        assert!(!new_id().is_empty());
    }

    #[test]
    fn test_new_id_unique() {
        assert_ne!(new_id(), new_id());
    }

    #[test]
    fn test_new_id_is_uuid_v4() {
        let id = new_id();
        // UUID v4 format: 8-4-4-4-12 hex digits
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5, "UUID should have 5 hyphen-separated parts");
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
        // All hex characters
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        // Version nibble should be 4
        assert_eq!(&parts[2].chars().next().unwrap(), &'4');
    }

    #[test]
    fn test_now_rfc3339_not_empty() {
        assert!(!now_rfc3339().is_empty());
    }

    #[test]
    fn test_now_rfc3339_format() {
        let s = now_rfc3339();
        let result = chrono::DateTime::parse_from_rfc3339(&s);
        assert!(result.is_ok(), "should be valid RFC3339: {}", s);
    }

    // ─── Step 5: DTO serde default behaviour tests ──────────────────────

    #[test]
    fn test_connection_profile_default_via_serde() {
        let profile: ConnectionProfile = serde_json::from_str("{}").expect("deserialize");
        assert!(!profile.id.is_empty(), "id should be generated");
        assert_eq!(profile.port, 22);
        assert_eq!(profile.auth_method, "password");
        assert_eq!(profile.host, "");
        assert!(profile.tags.is_empty());
    }

    #[test]
    fn test_terminal_session_default_via_serde() {
        let session: TerminalSession = serde_json::from_str("{}").expect("deserialize");
        assert!(!session.id.is_empty(), "id should be generated");
        assert_eq!(session.status, "");
    }

    #[test]
    fn test_terminal_output_chunk_default_via_serde() {
        let chunk: TerminalOutputChunk = serde_json::from_str("{}").expect("deserialize");
        assert_eq!(chunk.session_id, "");
        assert!(chunk.cwd.is_none());
        assert!(chunk.status.is_none());
        assert_eq!(chunk.content, "");
    }

    #[test]
    fn test_remote_file_entry_default_via_serde() {
        let entry: RemoteFileEntry = serde_json::from_str("{}").expect("deserialize");
        assert_eq!(entry.name, "");
        assert_eq!(entry.path, "");
        assert!(!entry.is_dir);
        assert!(!entry.is_symlink);
        assert_eq!(entry.size, 0);
    }

    #[test]
    fn test_tunnel_record_default_via_serde() {
        let record: TunnelRecord = serde_json::from_str("{}").expect("deserialize");
        assert!(!record.id.is_empty());
        assert_eq!(record.status, "stopped");
        assert_eq!(record.local_port, 15432);
        assert_eq!(record.bind_address, "127.0.0.1");
        assert_eq!(record.remote_host, "127.0.0.1");
        assert_eq!(record.remote_port, 5432);
    }
}
