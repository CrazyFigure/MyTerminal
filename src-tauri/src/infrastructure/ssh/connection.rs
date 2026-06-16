use ssh2::{MethodType, Session};
use std::{
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

use crate::{
    domain::entities::ConnectionProfile,
    domain::services::{expand_home_path, non_empty_trimmed},
    error::AppError,
};

pub(crate) const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
pub(crate) const SSH_IO_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn ssh_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(error.to_string())
}

pub(crate) fn authenticate_ssh_session(
    session: &Session,
    connection: &ConnectionProfile,
) -> Result<(), AppError> {
    let auth_method = connection.auth_method.trim();

    if auth_method.eq_ignore_ascii_case("privateKey") {
        let passphrase = non_empty_trimmed(connection.passphrase.as_deref());

        if let Some(private_key_text) = non_empty_trimmed(connection.private_key_text.as_deref()) {
            session
                .userauth_pubkey_memory(&connection.username, None, private_key_text, passphrase)
                .map_err(ssh_error)?;
            return Ok(());
        }

        let private_key_path = non_empty_trimmed(connection.private_key_path.as_deref())
            .ok_or_else(|| {
                AppError::Validation(
                    "private key authentication requires a key path or pasted key content".into(),
                )
            })?;

        session
            .userauth_pubkey_file(
                &connection.username,
                None,
                &expand_home_path(private_key_path),
                passphrase,
            )
            .map_err(ssh_error)?;

        return Ok(());
    }

    let password = connection.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation(
            "password authentication requires a password".into(),
        ));
    }

    session
        .userauth_password(&connection.username, password)
        .map_err(ssh_error)?;

    Ok(())
}

pub(crate) fn is_key_exchange_error(error: &AppError) -> bool {
    let AppError::Ssh(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    normalized.contains("unable to exchange encryption keys") || normalized.contains("session(-8)")
}

pub(crate) fn configure_ssh_compatibility_preferences(session: &Session) -> Result<(), AppError> {
    // 兼容模式只在默认密钥交换失败后启用：优先走稳定的 group14，再保留曲线、GEX 和旧算法兜底。
    let preferences = [
        (
            MethodType::Kex,
            "diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1",
        ),
        (
            MethodType::HostKey,
            "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa,ssh-dss",
        ),
        (
            MethodType::CryptCs,
            "aes256-ctr,aes192-ctr,aes128-ctr,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc",
        ),
        (
            MethodType::CryptSc,
            "aes256-ctr,aes192-ctr,aes128-ctr,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc",
        ),
        (
            MethodType::MacCs,
            "hmac-sha2-512,hmac-sha2-256,hmac-sha1,hmac-sha1-96,hmac-md5,hmac-md5-96",
        ),
        (
            MethodType::MacSc,
            "hmac-sha2-512,hmac-sha2-256,hmac-sha1,hmac-sha1-96,hmac-md5,hmac-md5-96",
        ),
    ];

    for (method_type, prefs) in preferences {
        session.method_pref(method_type, prefs).map_err(ssh_error)?;
    }

    Ok(())
}

pub(crate) fn connect_ssh_once(
    connection: &ConnectionProfile,
    compatibility_mode: bool,
) -> Result<Session, AppError> {
    let address = format!("{}:{}", connection.host, connection.port);
    // SSH/SFTP 辅助连接必须有明确超时，避免文件管理刷新卡在握手阶段并拖慢终端交互。
    let mut last_error = None;
    let addresses = address.to_socket_addrs()?;
    let mut tcp = None;
    for socket_address in addresses {
        match TcpStream::connect_timeout(&socket_address, SSH_CONNECT_TIMEOUT) {
            Ok(stream) => {
                tcp = Some(stream);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let tcp = tcp.ok_or_else(|| {
        AppError::Io(last_error.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "no resolved SSH address",
            )
        }))
    })?;
    tcp.set_read_timeout(Some(SSH_IO_TIMEOUT))?;
    tcp.set_write_timeout(Some(SSH_IO_TIMEOUT))?;

    let mut session = Session::new().map_err(ssh_error)?;
    session.set_tcp_stream(tcp);
    if compatibility_mode {
        configure_ssh_compatibility_preferences(&session)?;
    }
    session.handshake().map_err(ssh_error)?;
    authenticate_ssh_session(&session, connection)?;

    if !session.authenticated() {
        return Err(AppError::Validation(format!(
            "authentication failed for {}@{}",
            connection.username, connection.host
        )));
    }

    // 认证完成后再启用底层 keepalive，避免影响部分 SSH 服务端的密钥交换阶段兼容性。
    session.set_keepalive(false, 20);

    Ok(session)
}

pub(crate) fn connect_ssh(connection: &ConnectionProfile) -> Result<Session, AppError> {
    match connect_ssh_once(connection, false) {
        Ok(session) => Ok(session),
        Err(error) if is_key_exchange_error(&error) => connect_ssh_once(connection, true),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_error_string() {
        let err = ssh_error("connection timeout");
        match err {
            AppError::Ssh(msg) => assert_eq!(msg, "connection timeout"),
            _ => panic!("expected AppError::Ssh"),
        }
    }

    #[test]
    fn test_ssh_error_display() {
        let err = ssh_error(42);
        let msg = err.to_string();
        assert!(msg.contains("ssh error"));
        assert!(msg.contains("42"));
    }

    #[test]
    fn test_is_key_exchange_error_ssh_variant() {
        let err = AppError::Ssh("unable to exchange encryption keys".into());
        assert!(is_key_exchange_error(&err));
    }

    #[test]
    fn test_is_key_exchange_error_session8() {
        let err = AppError::Ssh("session(-8) error".into());
        assert!(is_key_exchange_error(&err));
    }

    #[test]
    fn test_is_key_exchange_error_other_ssh() {
        let err = AppError::Ssh("permission denied".into());
        assert!(!is_key_exchange_error(&err));
    }

    #[test]
    fn test_is_key_exchange_error_non_ssh() {
        let err = AppError::Validation("bad input".into());
        assert!(!is_key_exchange_error(&err));
    }

    #[test]
    fn test_is_key_exchange_error_case_insensitive() {
        let err = AppError::Ssh("Unable To Exchange Encryption Keys".into());
        assert!(is_key_exchange_error(&err));
    }

    #[test]
    fn test_ssh_error_into_app_error() {
        let err: AppError = ssh_error("test error");
        assert!(matches!(err, AppError::Ssh(_)));
    }
}
