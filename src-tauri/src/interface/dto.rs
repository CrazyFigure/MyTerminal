use serde::{Deserialize, Serialize};

use crate::domain::entities::{
    now_rfc3339, AppSettings, ConnectionProfile, HistoryEntry, TunnelRecord,
};

fn default_schema_version() -> u16 {
    1
}

/// 本地配置导出/导入包 — 属于应用层 DTO，序列化为 JSON 文件交换格式。
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

/// 追加命令历史输入的请求 DTO。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryInput {
    pub id: Option<String>,
    pub connection_id: Option<String>,
    pub command: String,
    pub executed_at: Option<String>,
}

/// 打开隧道请求 DTO。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelOpenRequest {
    pub connection_id: String,
    pub name: String,
    #[serde(default = "crate::domain::entities::default_bind_address")]
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// 更新隧道请求 DTO。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelUpdateRequest {
    // 编辑隧道必须定位已有记录，其余端点字段与新增保持一致，避免两套校验规则漂移。
    pub id: String,
    pub connection_id: String,
    pub name: String,
    #[serde(default = "crate::domain::entities::default_bind_address")]
    pub bind_address: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_config_bundle_default_schema_version() {
        let bundle = LocalConfigBundle {
            schema_version: default_schema_version(),
            exported_at: "2024-01-01T00:00:00Z".into(),
            settings: AppSettings::default(),
            connections: vec![],
            history: vec![],
            tunnels: vec![],
        };
        assert_eq!(bundle.schema_version, 1);
    }

    #[test]
    fn test_local_config_bundle_serde_roundtrip() {
        let bundle = LocalConfigBundle {
            schema_version: 1,
            exported_at: "2024-06-01T12:00:00Z".into(),
            settings: AppSettings::default(),
            connections: vec![],
            history: vec![],
            tunnels: vec![],
        };
        let json = serde_json::to_string(&bundle).unwrap();
        let deserialized: LocalConfigBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.schema_version, 1);
        assert_eq!(deserialized.exported_at, "2024-06-01T12:00:00Z");
    }

    #[test]
    fn test_local_config_bundle_deserialize_missing_fields() {
        let json = r#"{}"#;
        let bundle: LocalConfigBundle = serde_json::from_str(json).unwrap();
        assert_eq!(bundle.schema_version, 1);
        assert!(!bundle.exported_at.is_empty());
        assert!(bundle.connections.is_empty());
        assert!(bundle.history.is_empty());
        assert!(bundle.tunnels.is_empty());
    }

    #[test]
    fn test_history_entry_input_deserialize() {
        let json = r#"{"command": "ls -la"}"#;
        let input: HistoryEntryInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.command, "ls -la");
        assert!(input.id.is_none());
        assert!(input.connection_id.is_none());
        assert!(input.executed_at.is_none());
    }

    #[test]
    fn test_history_entry_input_full() {
        let json = r#"{"id":"abc","connectionId":"c1","command":"pwd","executedAt":"2024-01-01T00:00:00Z"}"#;
        let input: HistoryEntryInput = serde_json::from_str(json).unwrap();
        assert_eq!(input.id.unwrap(), "abc");
        assert_eq!(input.connection_id.unwrap(), "c1");
        assert_eq!(input.command, "pwd");
        assert_eq!(input.executed_at.unwrap(), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_tunnel_open_request_deserialize() {
        let json = r#"{"connectionId":"c1","name":"my-tunnel","localPort":8080,"remoteHost":"db.internal","remotePort":5432}"#;
        let req: TunnelOpenRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.connection_id, "c1");
        assert_eq!(req.name, "my-tunnel");
        assert_eq!(req.bind_address, "127.0.0.1"); // default
        assert_eq!(req.local_port, 8080);
        assert_eq!(req.remote_host, "db.internal");
        assert_eq!(req.remote_port, 5432);
    }

    #[test]
    fn test_tunnel_open_request_with_bind_address() {
        let json = r#"{"connectionId":"c1","name":"tun","bindAddress":"0.0.0.0","localPort":9090,"remoteHost":"host","remotePort":3306}"#;
        let req: TunnelOpenRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.bind_address, "0.0.0.0");
    }

    #[test]
    fn test_tunnel_update_request_deserialize() {
        let json = r#"{"id":"t1","connectionId":"c1","name":"updated","localPort":3000,"remoteHost":"srv","remotePort":4000}"#;
        let req: TunnelUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.id, "t1");
        assert_eq!(req.name, "updated");
        assert_eq!(req.bind_address, "127.0.0.1"); // default
        assert_eq!(req.local_port, 3000);
        assert_eq!(req.remote_host, "srv");
        assert_eq!(req.remote_port, 4000);
    }
}
