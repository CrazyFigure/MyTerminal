//! 连接配置与 RDP 命令适配器。
//! 负责协议字段归一、认证配置校验、Windows 凭据写入以及连接配置 CRUD；SSH PTY 生命周期仍由父命令层维护。

use super::*;

fn validate_ssh_auth_fields(
    label: &str,
    username: &str,
    auth_method: &str,
    password: &str,
    private_key_path: Option<&str>,
    private_key_text: Option<&str>,
) -> Result<(), AppError> {
    // 主机和每级跳板机都复用同一套认证约束，避免 IPC 或旧配置绕过前端校验后保存出不可连接的链路。
    if username.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "{label} username is required"
        )));
    }

    if auth_method.trim().eq_ignore_ascii_case("privateKey") {
        if non_empty_trimmed(private_key_path).is_none()
            && non_empty_trimmed(private_key_text).is_none()
        {
            return Err(AppError::Validation(format!(
                "{label} private key authentication requires a key path or pasted key content"
            )));
        }
    } else if password.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "{label} password authentication requires a password"
        )));
    }

    Ok(())
}

pub(super) fn validate_connection_profile(connection: &ConnectionProfile) -> Result<(), AppError> {
    // 连接配置会被前端、MCP/CLI 和历史数据共同使用；后端保存前必须做最终兜底校验。
    if connection.name.trim().is_empty() {
        return Err(AppError::Validation("connection name is required".into()));
    }
    if connection.host.trim().is_empty() {
        return Err(AppError::Validation("connection host is required".into()));
    }
    if connection.port == 0 {
        return Err(AppError::Validation(
            "connection port must be between 1 and 65535".into(),
        ));
    }

    let protocol = connection.protocol.trim().to_ascii_lowercase();
    if protocol == "rdp" {
        // Windows 远程桌面只接受账号密码；SSH 私钥、跳板机和代理字段由前端保存时清空，此处不参与校验。
        return validate_ssh_auth_fields(
            "RDP connection",
            &connection.username,
            "password",
            &connection.password,
            None,
            None,
        );
    }
    if protocol != "ssh" {
        return Err(AppError::Validation(format!(
            "unsupported connection protocol: {protocol}"
        )));
    }
    validate_ssh_auth_fields(
        "connection",
        &connection.username,
        &connection.auth_method,
        &connection.password,
        connection.private_key_path.as_deref(),
        connection.private_key_text.as_deref(),
    )?;

    for (index, jump_host) in connection.jump_hosts.iter().enumerate() {
        let label = format!("jump host {}", index + 1);
        if jump_host.host.trim().is_empty() {
            return Err(AppError::Validation(format!("{label} host is required")));
        }
        if jump_host.port == 0 {
            return Err(AppError::Validation(format!(
                "{label} port must be between 1 and 65535"
            )));
        }
        validate_ssh_auth_fields(
            &label,
            &jump_host.username,
            &jump_host.auth_method,
            &jump_host.password,
            jump_host.private_key_path.as_deref(),
            jump_host.private_key_text.as_deref(),
        )?;
    }

    if connection.proxy.enabled {
        if connection.proxy.host.trim().is_empty() {
            return Err(AppError::Validation("proxy host is required".into()));
        }
        if connection.proxy.port == 0 {
            return Err(AppError::Validation(
                "proxy port must be between 1 and 65535".into(),
            ));
        }

        match connection
            .proxy
            .proxy_type
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "http" | "https" | "http-connect" | "socks5" | "socks" => {}
            value => {
                return Err(AppError::Validation(format!(
                    "unsupported proxy type: {value}"
                )))
            }
        }
    }

    Ok(())
}

fn normalize_connection_protocol_fields(
    connection: &mut ConnectionProfile,
) -> Result<(), AppError> {
    // 规范化必须在后端完成，避免 CLI、MCP 或手工 IPC 绕过前端后把 RDP 与 SSH 专属字段混存。
    match connection.protocol.trim().to_ascii_lowercase().as_str() {
        "ssh" => {
            connection.protocol = "ssh".into();
        }
        "rdp" => {
            connection.protocol = "rdp".into();
            connection.auth_method = "password".into();
            connection.private_key_path = None;
            connection.private_key_text = None;
            connection.passphrase = None;
            connection.jump_hosts.clear();
            connection.proxy = SshProxyConfig::default();
        }
        value => {
            return Err(AppError::Validation(format!(
                "unsupported connection protocol: {value}"
            )))
        }
    }
    Ok(())
}

#[tauri::command]
pub fn test_connection(mut connection: ConnectionProfile) -> Result<bool, String> {
    normalize_connection_protocol_fields(&mut connection)?;
    validate_connection_profile(&connection)?;
    if connection.protocol.trim().eq_ignore_ascii_case("rdp") {
        // RDP 没有轻量的账号认证探测接口；测试只确认 TCP 服务可达，真实凭据由 mstsc 完成认证。
        let stream = connect_tcp_direct(&connection.host, connection.port)?;
        let _ = stream.shutdown(Shutdown::Both);
        return Ok(true);
    }
    let _ = connect_ssh(&connection)?;
    Ok(true)
}

#[cfg(windows)]
fn rdp_client_address(connection: &ConnectionProfile) -> String {
    // 默认 3389 不写端口，确保 Windows 凭据目标使用系统最常见的 TERMSRV/host 形式；自定义端口保持显式。
    if connection.port == 3389 {
        let host = connection.host.trim();
        if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        }
    } else {
        format_tcp_endpoint(&connection.host, connection.port)
    }
}

#[cfg(windows)]
fn write_rdp_session_credential(
    address: &str,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    use windows::{
        core::PWSTR,
        Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
        },
    };

    // 直接调用 Windows Credential API，密码不会像 cmdkey.exe 那样短暂暴露在进程命令行中。
    let mut target = format!("TERMSRV/{address}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut user = username
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut password_blob = password.encode_utf16().collect::<Vec<_>>();
    let password_blob_size = u32::try_from(password_blob.len().saturating_mul(2))
        .map_err(|_| AppError::Validation("RDP password is too long".into()))?;

    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: password_blob_size,
        CredentialBlob: password_blob.as_mut_ptr().cast::<u8>(),
        // 仅保留到当前 Windows 登录会话结束，长期凭据仍只由 MyTerminal 的加密配置持有。
        Persist: CRED_PERSIST_SESSION,
        UserName: PWSTR(user.as_mut_ptr()),
        ..Default::default()
    };

    unsafe { CredWriteW(&credential, 0) }.map_err(|error| {
        AppError::Io(std::io::Error::other(format!(
            "failed to prepare Windows Remote Desktop credential: {error}"
        )))
    })
}

#[cfg(test)]
mod rdp_connection_tests {
    use super::*;

    fn rdp_connection(host: &str, port: u16) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": "rdp-test",
            "protocol": "rdp",
            "name": "Windows Test",
            "host": host,
            "port": port,
            "username": "Administrator",
            "authMethod": "privateKey",
            "password": "secret",
            "privateKeyPath": "C:/should-not-remain",
            "jumpHosts": [{
                "id": "jump",
                "host": "10.0.0.1",
                "username": "root",
                "password": "jump-secret"
            }],
            "proxy": {
                "enabled": true,
                "type": "socks5",
                "host": "127.0.0.1",
                "port": 1080
            }
        }))
        .expect("RDP test profile should deserialize")
    }

    #[test]
    fn rdp_normalization_removes_ssh_only_fields() {
        let mut connection = rdp_connection("192.168.1.20", 3389);
        normalize_connection_protocol_fields(&mut connection)
            .expect("RDP connection should normalize");

        assert_eq!(connection.auth_method, "password");
        assert!(connection.private_key_path.is_none());
        assert!(connection.jump_hosts.is_empty());
        assert!(!connection.proxy.enabled);
        validate_connection_profile(&connection)
            .expect("normalized RDP connection should validate");
    }

    #[cfg(windows)]
    #[test]
    fn rdp_address_handles_default_port_custom_port_and_ipv6() {
        assert_eq!(
            rdp_client_address(&rdp_connection("server.local", 3389)),
            "server.local"
        );
        assert_eq!(
            rdp_client_address(&rdp_connection("server.local", 3390)),
            "server.local:3390"
        );
        assert_eq!(rdp_client_address(&rdp_connection("::1", 3389)), "[::1]");
        assert_eq!(
            rdp_client_address(&rdp_connection("::1", 3390)),
            "[::1]:3390"
        );
    }
}

#[tauri::command]
pub fn open_rdp_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    validate_connection_profile(&connection)?;
    if !connection.protocol.trim().eq_ignore_ascii_case("rdp") {
        return Err(AppError::Validation(
            "this connection is not a Windows Remote Desktop connection".into(),
        )
        .into());
    }

    #[cfg(windows)]
    {
        let address = rdp_client_address(&connection);
        write_rdp_session_credential(&address, &connection.username, &connection.password)?;
        // mstsc 使用独立原生窗口；只传目标地址，账号密码通过当前登录会话的凭据存储读取。
        Command::new("mstsc.exe")
            .arg(format!("/v:{address}"))
            .creation_flags(WINDOWS_CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::from)?;
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        Err(AppError::Validation(
            "Windows Remote Desktop connections can only be opened on Windows".into(),
        )
        .into())
    }
}

#[tauri::command]
pub fn create_connection(
    state: State<'_, AppState>,
    mut connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    normalize_connection_protocol_fields(&mut connection)?;
    validate_connection_profile(&connection)?;
    drop_auxiliary_session(&state, &connection.id);
    // 连接配置可能被同 ID 覆盖；旧隧道必须停止，避免后台继续使用旧主机、旧代理或旧凭据。
    stop_connection_tunnel_runtimes(&state, &connection.id)?;
    mark_connection_tunnels_stopped(&state, &connection.id)?;
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection.id);
    connections.insert(0, connection.clone());
    state
        .storage
        .save_connections(&connections, &state.crypto)?;
    Ok(connection)
}

#[tauri::command]
pub fn update_connection(
    state: State<'_, AppState>,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    create_connection(state, connection)
}

#[tauri::command]
pub fn delete_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    drop_auxiliary_session(&state, &connection_id);
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection_id);
    state
        .storage
        .save_connections(&connections, &state.crypto)?;

    let mut sessions = lock_sessions(&state)?;
    let session_ids = sessions
        .iter()
        .filter_map(|(session_id, runtime)| {
            (runtime.session.connection_id == connection_id).then(|| session_id.clone())
        })
        .collect::<Vec<_>>();

    for session_id in session_ids {
        if let Some(runtime) = sessions.remove(&session_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
            let _ = runtime.control_tx.send(SessionControl::Close);
        }
    }
    drop(sessions);

    let persisted_tunnels = state.storage.load_tunnels()?;
    let tunnel_ids = persisted_tunnels
        .iter()
        .filter(|tunnel| tunnel.connection_id == connection_id)
        .map(|tunnel| tunnel.id.clone())
        .collect::<Vec<_>>();

    let mut tunnel_runtime = lock_tunnels(&state)?;
    for tunnel_id in tunnel_ids {
        if let Some(runtime) = tunnel_runtime.remove(&tunnel_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
        }
    }
    drop(tunnel_runtime);
    drop_tunnel_ssh_pool(&state, &connection_id);

    let mut tunnels = persisted_tunnels;
    tunnels.retain(|item| item.connection_id != connection_id);
    state.storage.save_tunnels(&tunnels)?;

    Ok(true)
}
