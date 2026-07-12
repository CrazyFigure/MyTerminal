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

// 大文件扫描默认 5 秒刷新一次；该命令会遍历文件系统，默认值不跟随常规运行状态的 1 秒刷新。
fn default_runtime_storage_refresh_interval_sec() -> u16 {
    5
}

// 进程/线程资源明细默认 3 秒刷新一次；该接口只在内存行展开后启用。
fn default_runtime_resource_refresh_interval_sec() -> u16 {
    3
}

fn default_runtime_resource_source() -> String {
    "system".into()
}

// SSH 保活默认间隔（秒）；0 表示关闭。默认 30 秒，兼顾防止空闲掉线和后台资源占用。
fn default_ssh_keepalive_interval_sec() -> u16 {
    30
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

// 旧设置文件没有长行展示模式时保持原有自动换行行为。
fn default_terminal_line_wrap_mode() -> String {
    "wrap".into()
}

fn default_terminal_match_selection() -> bool {
    true
}

// 旧设置文件没有行号栏开关时默认显示行号与时间戳。
fn default_terminal_gutter_show_line_number() -> bool {
    true
}

fn default_terminal_gutter_show_timestamp() -> bool {
    true
}

fn default_show_command_ghost() -> bool {
    true
}

// Windows 硬件加速默认开启；软件渲染只作为兼容模式，不能假定在所有显卡和负载下都更省内存。
fn default_hardware_acceleration() -> bool {
    true
}

fn default_agent_bridge_timeout_sec() -> u16 {
    60
}

fn default_agent_bridge_max_output_bytes() -> usize {
    200_000
}

fn default_connection_groups() -> Vec<String> {
    Vec::new()
}

fn default_connection_order() -> Vec<String> {
    Vec::new()
}

fn default_local_terminal_commands() -> Vec<LocalTerminalCommand> {
    vec![
        LocalTerminalCommand {
            id: "shell".into(),
            name: "本地终端".into(),
            command: String::new(),
            built_in: true,
        },
        LocalTerminalCommand {
            id: "claude".into(),
            name: "claude".into(),
            command: "claude".into(),
            built_in: true,
        },
        LocalTerminalCommand {
            id: "codex".into(),
            name: "codex".into(),
            command: "codex".into(),
            built_in: true,
        },
        LocalTerminalCommand {
            id: "opencode".into(),
            name: "opencode".into(),
            command: "opencode".into(),
            built_in: true,
        },
    ]
}

fn default_terminal_session_kind() -> String {
    "ssh".into()
}

fn default_local_terminal_title() -> String {
    "本地终端".into()
}

fn default_auth_method() -> String {
    "password".into()
}

fn default_remote_path() -> String {
    "/myterminal".into()
}

fn default_remote_settings_path() -> String {
    "/myterminal".into()
}

fn default_remote_connections_path() -> String {
    "/myterminal".into()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_proxy_port() -> u16 {
    1080
}

fn default_proxy_type() -> String {
    "socks5".into()
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
    /// 自动执行开启时全部连接跳过 GUI 审批；关闭时仅连接白名单仍自动执行。
    #[serde(default)]
    pub auto_execute: bool,
    /// 自动执行关闭时仍允许自动执行的连接白名单。
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
    /// 存储行展开后的大文件列表刷新频率（秒），独立于常规运行状态刷新。
    #[serde(default = "default_runtime_storage_refresh_interval_sec")]
    pub runtime_storage_refresh_interval_sec: u16,
    /// 内存行展开后的进程/线程资源明细刷新频率（秒），独立于常规运行状态刷新。
    #[serde(default = "default_runtime_resource_refresh_interval_sec")]
    pub runtime_resource_refresh_interval_sec: u16,
    /// 内存行展开后的资源明细默认来源，Docker 同时覆盖 Docker Compose 容器场景。
    #[serde(default = "default_runtime_resource_source")]
    pub runtime_resource_source: String,
    /// SSH 保活间隔（秒），0 表示关闭；作用于交互终端、文件/状态辅助会话与隧道池会话。
    #[serde(default = "default_ssh_keepalive_interval_sec")]
    pub ssh_keepalive_interval_sec: u16,
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
    /// 终端长行展示方式由前端渲染执行，后端只负责兼容旧配置并持久化。
    #[serde(default = "default_terminal_line_wrap_mode")]
    pub terminal_line_wrap_mode: String,
    /// 选中文本匹配高亮由前端渲染层执行，后端只负责持久化开关。
    #[serde(default = "default_terminal_match_selection")]
    pub terminal_match_selection: bool,
    /// 终端左侧行号栏由前端渲染层执行，后端只负责持久化显示开关。
    #[serde(default = "default_terminal_gutter_show_line_number")]
    pub terminal_gutter_show_line_number: bool,
    #[serde(default = "default_terminal_gutter_show_timestamp")]
    pub terminal_gutter_show_timestamp: bool,
    #[serde(default)]
    pub compact_sidebar: bool,
    #[serde(default = "default_show_command_ghost")]
    pub show_command_ghost: bool,
    /// Windows 硬件加速开关（重启生效）；关闭时给 WebView2 追加 --disable-gpu 使用软件渲染兼容模式。
    #[serde(default = "default_hardware_acceleration")]
    pub hardware_acceleration: bool,
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
            runtime_storage_refresh_interval_sec: default_runtime_storage_refresh_interval_sec(),
            runtime_resource_refresh_interval_sec: default_runtime_resource_refresh_interval_sec(),
            runtime_resource_source: default_runtime_resource_source(),
            ssh_keepalive_interval_sec: default_ssh_keepalive_interval_sec(),
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
            terminal_line_wrap_mode: default_terminal_line_wrap_mode(),
            terminal_match_selection: default_terminal_match_selection(),
            terminal_gutter_show_line_number: default_terminal_gutter_show_line_number(),
            terminal_gutter_show_timestamp: default_terminal_gutter_show_timestamp(),
            compact_sidebar: false,
            show_command_ghost: true,
            hardware_acceleration: default_hardware_acceleration(),
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
    /// 多级跳板按数组顺序串接，最终一级再连接目标 SSH 主机。
    #[serde(default)]
    pub jump_hosts: Vec<SshJumpHost>,
    /// 代理只作用于第一跳，后续跳板通过 SSH direct-tcpip 继续转发。
    #[serde(default)]
    pub proxy: SshProxyConfig,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHost {
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
    pub password: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_text: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProxyConfig {
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
    pub password: Option<String>,
}

impl Default for SshProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proxy_type: default_proxy_type(),
            host: String::new(),
            port: default_proxy_port(),
            username: None,
            password: None,
        }
    }
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
    /// 会话来源决定前端是否启用远端文件、运行状态和隧道等 SSH 专属能力。
    #[serde(default = "default_terminal_session_kind")]
    pub kind: String,
    #[serde(default)]
    pub connection_id: String,
    /// 本地终端启动项 id 只用于重开和展示，不参与 SSH 连接查找。
    #[serde(default)]
    pub local_profile_id: Option<String>,
    /// 本地终端实际启动命令，前端据此识别 Claude/Codex 等全屏 TUI 并避免横向扩列。
    #[serde(default)]
    pub local_command: Option<String>,
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
pub struct LocalTerminalCommand {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub command: String,
    /// 内置命令由应用兜底提供，前端允许排序但不允许删除。
    #[serde(default)]
    pub built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalProfile {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default = "default_local_terminal_title")]
    pub title: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub last_used_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalSettings {
    #[serde(default)]
    pub shell_path: String,
    /// 命令顺序来自本地终端管理页，内置命令缺失时加载阶段会自动补齐。
    #[serde(default = "default_local_terminal_commands")]
    pub commands: Vec<LocalTerminalCommand>,
    #[serde(default)]
    pub profiles: Vec<LocalTerminalProfile>,
}

impl Default for LocalTerminalSettings {
    fn default() -> Self {
        Self {
            shell_path: String::new(),
            commands: default_local_terminal_commands(),
            profiles: Vec::new(),
        }
    }
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
    /// 远端主机当前已建立 TCP 连接数，附带 SSH 端口连接数用于判断 SSH 负载。
    #[serde(default)]
    pub connections: String,
    #[serde(default)]
    pub network: String,
    #[serde(default)]
    pub uptime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceUsageRequest {
    #[serde(default = "default_runtime_resource_source")]
    pub source: String,
    #[serde(default)]
    pub metric: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceUsageItem {
    #[serde(default)]
    pub rank: usize,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub cpu: String,
    #[serde(default)]
    pub memory: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub cpu_percent: Option<f64>,
    #[serde(default)]
    pub memory_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeResourceUsage {
    #[serde(default = "default_runtime_resource_source")]
    pub source: String,
    #[serde(default)]
    pub metric: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub items: Vec<RuntimeResourceUsageItem>,
    #[serde(default)]
    pub captured_at: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
// 存储展开区的单文件信息，前端依赖名称、路径和格式化大小同时展示与悬浮提示。
pub struct RuntimeStorageFileItem {
    #[serde(default)]
    pub rank: usize,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub size_kib: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
// 存储展开区的扫描结果，error 用于把远端扫描异常直接反馈到列表占位区域。
pub struct RuntimeStorageFiles {
    #[serde(default)]
    pub items: Vec<RuntimeStorageFileItem>,
    #[serde(default)]
    pub captured_at: String,
    #[serde(default)]
    pub error: Option<String>,
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
    #[serde(default)]
    pub tags: Vec<String>,
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
