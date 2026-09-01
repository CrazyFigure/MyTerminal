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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePercentMetric {
    #[serde(default)]
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCpuCore {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMemoryMetric {
    #[serde(default)]
    pub percent: Option<f64>,
    #[serde(default)]
    pub used_kib: Option<u64>,
    #[serde(default)]
    pub total_kib: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStorageMetric {
    #[serde(default)]
    pub percent: Option<f64>,
    #[serde(default)]
    pub mount: String,
    #[serde(default)]
    pub used_kib: Option<u64>,
    #[serde(default)]
    pub total_kib: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConnectionMetric {
    #[serde(default)]
    pub tcp_established: Option<u64>,
    #[serde(default)]
    pub ssh_established: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOverviewSnapshot {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub primary_address: Option<String>,
    #[serde(default)]
    pub captured_at: String,
    #[serde(default)]
    pub cpu: RuntimePercentMetric,
    #[serde(default)]
    pub cpu_cores: Vec<RuntimeCpuCore>,
    #[serde(default)]
    pub memory: RuntimeMemoryMetric,
    #[serde(default)]
    pub storage: RuntimeStorageMetric,
    #[serde(default)]
    pub connections: RuntimeConnectionMetric,
    #[serde(default)]
    pub uptime_seconds: Option<u64>,
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RuntimeOverviewEvent {
    #[serde(rename = "snapshot")]
    Snapshot {
        subscription_id: String,
        connection_id: String,
        sequence: u64,
        snapshot: RuntimeOverviewSnapshot,
    },
    #[serde(rename = "error")]
    Error {
        subscription_id: String,
        connection_id: String,
        sequence: u64,
        attempted_at: String,
        message: String,
        retry_in_ms: u64,
    },
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
