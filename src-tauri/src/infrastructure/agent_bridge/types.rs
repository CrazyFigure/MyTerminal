use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{atomic::AtomicBool, Arc};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeLocalSecret {
    /// Broker token 只保存在本机 secret 文件中，不进入 WebDAV 或本地配置包。
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeDiscovery {
    /// discovery 文件给 CLI/MCP 自动发现本地 Broker，端口为运行期随机端口。
    pub port: u16,
    /// 本地 token 随 discovery 暴露给同一用户进程，外部请求仍必须携带 Authorization。
    pub token: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub discovery_path: String,
    pub cli_command: String,
    pub mcp_command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionSummary {
    pub id: String,
    pub name: String,
    pub group_path: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub tags: Vec<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionGroupNode {
    pub name: String,
    pub path: String,
    pub children: Vec<AgentConnectionGroupNode>,
    pub connections: Vec<AgentConnectionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionList {
    pub groups: Vec<AgentConnectionGroupNode>,
    pub connections: Vec<AgentConnectionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub cwd: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandResult {
    pub run_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileReadResult {
    pub session_id: String,
    pub path: String,
    pub encoding: String,
    pub content: Option<String>,
    pub content_base64: Option<String>,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeRequest {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub connection_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub new_path: Option<String>,
    pub content_preview: Option<String>,
    pub logs: Vec<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing)]
    pub action: AgentAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandRequest {
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePathRequest {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteRequest {
    pub session_id: String,
    pub path: String,
    pub content: Option<String>,
    pub content_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameRequest {
    pub session_id: String,
    pub path: String,
    pub new_path: String,
}

#[derive(Debug, Clone)]
pub enum AgentAction {
    RunCommand(RunCommandRequest),
    FileWrite(FileWriteRequest),
    FileDelete(FilePathRequest),
    FileRename(FileRenameRequest),
    FileMkdir(FilePathRequest),
}

#[derive(Debug, Clone)]
pub(crate) struct AgentBridgeServer {
    pub port: u16,
    pub token: String,
    pub stop_flag: Arc<AtomicBool>,
}
