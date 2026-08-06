//! 远程文件与运行状态采集模型。

use serde::{Deserialize, Serialize};

use super::settings::default_runtime_resource_source;

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
    /// 远端主机当前已建立 TCP 连接数，附带最终 sshd 实际端口的连接数；无法可靠采集时 SSH 显示不可用。
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
// 连接数展开区的单条 ESTABLISHED 连接，is_ssh 标记本地端口命中最终 sshd 端口的管理连接。
pub struct RuntimeConnectionItem {
    #[serde(default)]
    pub local: String,
    #[serde(default)]
    pub remote: String,
    #[serde(default)]
    pub is_ssh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
// 连接数展开区的采集结果；total 为远端 ESTABLISHED 总数，超出单次输出上限时前端用它提示剩余条数。
pub struct RuntimeConnectionList {
    #[serde(default)]
    pub items: Vec<RuntimeConnectionItem>,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub captured_at: String,
    #[serde(default)]
    pub error: Option<String>,
}
