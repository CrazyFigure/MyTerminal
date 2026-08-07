//! 应用设置、WebDAV 与 AI 配置领域模型。

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::connections::LocalTerminalCommand;

pub(super) fn default_quick_commands() -> Vec<String> {
    vec!["pwd".into(), "ls -la".into(), "docker ps".into()]
}

pub(super) fn default_theme_mode() -> String {
    "light".into()
}

pub(super) fn default_ui_language() -> String {
    "zh-CN".into()
}

pub(super) fn default_shell_font_family() -> String {
    "JetBrains Mono".into()
}

pub(super) fn default_shell_latin_font_family() -> String {
    "JetBrains Mono".into()
}

pub(super) fn default_shell_cjk_font_family() -> String {
    "Microsoft YaHei UI".into()
}

pub(super) fn default_shell_font_size() -> u16 {
    15
}

// 终端行高倍数，沿用前端历史硬编码值；xterm 对小于 1 的行高会直接抛错。
pub(super) fn default_shell_line_height() -> f32 {
    1.18
}

// AI 对话正文行高倍数，与终端行高相互独立，不跟随终端设置。
pub(super) fn default_agent_chat_line_height() -> f32 {
    1.6
}

pub(super) fn default_runtime_refresh_interval_sec() -> u16 {
    1
}

// 大文件扫描默认 5 秒刷新一次；该命令会遍历文件系统，默认值不跟随常规运行状态的 1 秒刷新。
pub(super) fn default_runtime_storage_refresh_interval_sec() -> u16 {
    5
}

// 进程/线程资源明细默认 3 秒刷新一次；该接口只在内存行展开后启用。
pub(super) fn default_runtime_resource_refresh_interval_sec() -> u16 {
    3
}

pub(super) fn default_runtime_resource_source() -> String {
    "system".into()
}

// SSH 保活默认间隔（秒）；0 表示关闭。默认 30 秒，兼顾防止空闲掉线和后台资源占用。
pub(super) fn default_ssh_keepalive_interval_sec() -> u16 {
    30
}

pub(super) fn default_terminal_background() -> String {
    "#f7f7f7".into()
}

pub(super) fn default_terminal_foreground() -> String {
    "#111111".into()
}

pub(super) fn default_accent_color() -> String {
    "#4f46e5".into()
}

pub(super) fn default_terminal_background_image_opacity() -> f32 {
    0.18
}

pub(super) fn default_terminal_background_image_fit() -> String {
    "cover".into()
}

pub(super) fn default_terminal_right_click_behavior() -> String {
    "paste".into()
}

// 旧设置文件没有长行展示模式时保持原有自动换行行为。
pub(super) fn default_terminal_line_wrap_mode() -> String {
    "wrap".into()
}

pub(super) fn default_terminal_match_selection() -> bool {
    true
}

// 旧设置文件没有行号栏开关时默认显示行号与时间戳。
pub(super) fn default_terminal_gutter_show_line_number() -> bool {
    true
}

pub(super) fn default_terminal_gutter_show_timestamp() -> bool {
    true
}

pub(super) fn default_show_command_ghost() -> bool {
    true
}

// Windows 硬件加速默认开启；软件渲染只作为兼容模式，不能假定在所有显卡和负载下都更省内存。
pub(super) fn default_hardware_acceleration() -> bool {
    true
}

pub(super) fn default_agent_bridge_timeout_sec() -> u16 {
    60
}

pub(super) fn default_agent_bridge_max_output_bytes() -> usize {
    200_000
}

/// 可见执行默认开启：让用户能实时看到 AI 在自己终端里做了什么，是本功能的核心价值。
pub(super) fn default_agent_bridge_visible_execution() -> bool {
    true
}

pub(super) fn default_connection_groups() -> Vec<String> {
    Vec::new()
}

pub(super) fn default_connection_order() -> Vec<String> {
    Vec::new()
}

pub(super) fn default_local_terminal_commands() -> Vec<LocalTerminalCommand> {
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

pub(super) fn default_terminal_session_kind() -> String {
    "ssh".into()
}

// 历史连接文件没有协议字段，默认按原有 SSH 语义加载，保证升级后无需迁移即可继续使用。
pub(super) fn default_connection_protocol() -> String {
    "ssh".into()
}

pub(super) fn default_local_terminal_title() -> String {
    "本地终端".into()
}

pub(super) fn default_auth_method() -> String {
    "password".into()
}

pub(super) fn default_remote_path() -> String {
    "/myterminal".into()
}

pub(super) fn default_remote_settings_path() -> String {
    "/myterminal".into()
}

pub(super) fn default_remote_connections_path() -> String {
    "/myterminal".into()
}

pub(super) fn default_ssh_port() -> u16 {
    22
}

pub(super) fn default_proxy_port() -> u16 {
    1080
}

pub(super) fn default_proxy_type() -> String {
    "socks5".into()
}

pub(super) fn default_local_tunnel_port() -> u16 {
    15432
}

pub(super) fn default_remote_tunnel_host() -> String {
    "127.0.0.1".into()
}

pub(super) fn default_remote_tunnel_port() -> u16 {
    5432
}

pub(super) fn default_bind_address() -> String {
    "127.0.0.1".into()
}

pub(super) fn default_tunnel_status() -> String {
    "stopped".into()
}

pub(super) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(super) fn now_rfc3339() -> String {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// AI 命令是否在用户可见的终端标签中执行；默认开启。
    /// 关闭后回到后台隐藏通道执行，用户只能在审批卡片里看到命令本身。
    #[serde(default = "default_agent_bridge_visible_execution")]
    pub visible_execution: bool,
}

impl Default for AgentBridgeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_execute: false,
            allowed_connection_ids: Vec::new(),
            default_timeout_sec: default_agent_bridge_timeout_sec(),
            max_output_bytes: default_agent_bridge_max_output_bytes(),
            visible_execution: default_agent_bridge_visible_execution(),
        }
    }
}

/// 内置 Agent 可用的一个模型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// 调用 API 时使用的模型 id，例如 claude-opus-5 或 gpt-4o。
    pub id: String,
    /// 界面上展示的名称；为空时前端回退显示 id。
    #[serde(default)]
    pub name: String,
    /// 单次回复最大 token 数；Anthropic 协议要求必填，其它协议留空则不下发。
    #[serde(default = "default_agent_model_max_tokens")]
    pub max_tokens: u32,
    /// 上下文窗口大小（token）；用于估算何时触发自动压缩。
    #[serde(default = "default_agent_model_context_window")]
    pub context_window: u32,
}

pub(super) fn default_agent_model_max_tokens() -> u32 {
    16000
}

/// 保守默认 200k：多数主流模型不低于此值，估算偏小只会让压缩更早触发，不会溢出。
pub(super) fn default_agent_model_context_window() -> u32 {
    200_000
}

/// 思考强度；仅对支持该参数的模型下发，其余协议自动忽略。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentEffort {
    /// 不下发任何思考参数，走模型默认行为。
    Default,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Default for AgentEffort {
    fn default() -> Self {
        Self::Default
    }
}

impl AgentEffort {
    /// 转成 API 需要的字符串；Default 返回 None 表示不下发。
    pub fn as_api_value(&self) -> Option<&'static str> {
        match self {
            Self::Default => None,
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
            Self::Xhigh => Some("xhigh"),
            Self::Max => Some("max"),
        }
    }
}

/// 一个 AI 服务端点及其下属模型。API Key 落盘前由 CryptoService 加密；
/// 下发前端与导出配置时为明文，与 WebDAV 密码同一策略，用户可随时查看。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub id: String,
    pub name: String,
    /// 接口协议："anthropic" | "openai-chat" | "openai-responses"。
    pub protocol: String,
    /// 服务基址，例如 https://api.anthropic.com。
    pub base_url: String,
    /// 明文 API Key；落盘时加密存储，下发前端与导出配置（本地/WebDAV）时为明文。
    #[serde(default)]
    pub api_key: String,
    /// 前端据此显示“已配置密钥”，无需自行判断密钥串是否为空。
    #[serde(default)]
    pub has_api_key: bool,
    #[serde(default)]
    pub models: Vec<AgentModel>,
}

/// 一条持久化的 AI 对话。
/// 消息结构对后端是不透明的 JSON：对话内容的形状由前端定义，
/// 后端只负责按会话 id 存取，避免两边为了展示细节反复同步类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversation {
    pub id: String,
    pub title: String,
    /// 最后更新时间（毫秒时间戳），用于历史列表排序。
    pub updated_at: i64,
    /// 该对话使用的端点与模型，重新打开时恢复选择。
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub model_id: String,
    /// 前端消息列表原样保存。
    pub messages: serde_json::Value,
}

/// 一轮对话的运行参数；由前端每次发送时携带，不落盘，便于随时调整。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunOptions {
    /// 思考强度。
    #[serde(default)]
    pub effort: AgentEffort,
    /// 上下文占用超过该比例时触发自动压缩（0.1~0.95）。
    #[serde(default = "default_agent_compact_threshold")]
    pub compact_threshold: f32,
    /// 是否启用自动压缩；关闭后超长对话会直接被 API 拒绝，由用户自行新建对话。
    #[serde(default = "default_agent_auto_compact")]
    pub auto_compact: bool,
}

impl Default for AgentRunOptions {
    fn default() -> Self {
        Self {
            effort: AgentEffort::default(),
            compact_threshold: default_agent_compact_threshold(),
            auto_compact: default_agent_auto_compact(),
        }
    }
}

/// 留 35% 余量给本轮的新输出与工具结果，避免压缩刚好卡在溢出边缘。
pub(super) fn default_agent_compact_threshold() -> f32 {
    0.65
}

pub(super) fn default_agent_auto_compact() -> bool {
    true
}

/// AgentProvider 的落盘形态：API Key 以密文保存，与连接凭据同一套加密方案。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAgentProvider {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key_encrypted: String,
    #[serde(default)]
    pub models: Vec<AgentModel>,
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
    /// 内存行展开后的资源明细默认来源；Docker 覆盖 Compose，Podman 使用独立命令采集。
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
    /// 终端行高倍数；前端 normalizer 会把范围夹在 1.0~2.5，防止 xterm 因非法行高抛错。
    #[serde(default = "default_shell_line_height")]
    pub shell_line_height: f32,
    /// 右侧 AI 对话英文字体；None 表示跟随终端英文字体，回落由前端解析。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_chat_latin_font_family: Option<String>,
    /// 右侧 AI 对话中文字体；None 表示跟随终端中文字体，回落由前端解析。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_chat_cjk_font_family: Option<String>,
    /// 右侧 AI 对话字体大小（px）；0 表示跟随终端字体大小，回落由前端解析。
    #[serde(default)]
    pub agent_chat_font_size: u16,
    /// 右侧 AI 对话正文行高倍数；与终端行高独立，没有“跟随终端”语义。
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
            shell_line_height: default_shell_line_height(),
            agent_chat_latin_font_family: None,
            agent_chat_cjk_font_family: None,
            agent_chat_font_size: 0,
            agent_chat_line_height: default_agent_chat_line_height(),
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
