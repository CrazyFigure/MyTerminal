use chrono::Utc;
use serde::{Deserialize, Serialize};

fn default_quick_commands() -> Vec<String> {
    vec!["pwd".into(), "ls -la".into(), "docker ps".into()]
}

fn default_theme_mode() -> String {
    "light".into()
}

fn default_ui_language() -> String {
    "zh-CN".into()
}

fn default_shell_font_family() -> String {
    "JetBrains Mono".into()
}

fn default_shell_latin_font_family() -> String {
    "JetBrains Mono".into()
}

fn default_shell_cjk_font_family() -> String {
    "Microsoft YaHei UI".into()
}

fn default_shell_font_size() -> u16 {
    15
}

fn default_runtime_refresh_interval_sec() -> u16 {
    1
}

fn default_terminal_background() -> String {
    "#f7f7f7".into()
}

fn default_terminal_foreground() -> String {
    "#111111".into()
}

fn default_accent_color() -> String {
    "#4f46e5".into()
}

fn default_terminal_background_image_opacity() -> f32 {
    0.18
}

fn default_terminal_background_image_fit() -> String {
    "cover".into()
}

fn default_terminal_right_click_behavior() -> String {
    "paste".into()
}

fn default_show_command_ghost() -> bool {
    true
}

fn default_connection_groups() -> Vec<String> {
    Vec::new()
}

fn default_connection_order() -> Vec<String> {
    Vec::new()
}

fn default_auth_method() -> String {
    "password".into()
}

fn default_remote_settings_path() -> String {
    "/myterminal/settings.enc.json".into()
}

fn default_remote_connections_path() -> String {
    "/myterminal/connections.enc.json".into()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_local_tunnel_port() -> u16 {
    15432
}

fn default_remote_tunnel_host() -> String {
    "127.0.0.1".into()
}

fn default_remote_tunnel_port() -> u16 {
    5432
}

fn default_bind_address() -> String {
    "127.0.0.1".into()
}

fn default_tunnel_status() -> String {
    "stopped".into()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn now_rfc3339() -> String {
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
    #[serde(default = "default_remote_settings_path")]
    pub remote_settings_path: String,
    #[serde(default = "default_remote_connections_path")]
    pub remote_connections_path: String,
}

impl Default for WebDavSettings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            username: String::new(),
            password: String::new(),
            remote_settings_path: "/myterminal/settings.enc.json".into(),
            remote_connections_path: "/myterminal/connections.enc.json".into(),
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
            background_image: Some(String::new()),
            terminal_background_image_opacity: default_terminal_background_image_opacity(),
            terminal_background_image_fit: default_terminal_background_image_fit(),
            terminal_right_click_behavior: default_terminal_right_click_behavior(),
            compact_sidebar: false,
            show_command_ghost: true,
            connection_groups: default_connection_groups(),
            connection_order: default_connection_order(),
            quick_commands: default_quick_commands(),
            webdav: WebDavSettings::default(),
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
    pub webdav_base_url: String,
    #[serde(default)]
    pub webdav_username: String,
    #[serde(default)]
    pub webdav_password_encrypted: String,
    #[serde(default = "default_remote_settings_path")]
    pub webdav_remote_settings_path: String,
    #[serde(default = "default_remote_connections_path")]
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
