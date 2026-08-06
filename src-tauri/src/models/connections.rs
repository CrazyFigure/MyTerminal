//! 连接、会话、本地终端与历史记录领域模型。

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::settings::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default = "new_id")]
    pub id: String,
    /// ssh 使用内置终端能力，rdp 调用 Windows 系统远程桌面客户端。
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
    /// PTY 初建或 resize 真正生效后的列数；尺寸元数据与普通输出共用队列以保持严格时序。
    #[serde(default)]
    pub cols: Option<u16>,
    /// PTY 初建或 resize 真正生效后的行数；前端重放原始流时据此恢复当时的终端几何。
    #[serde(default)]
    pub rows: Option<u16>,
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
