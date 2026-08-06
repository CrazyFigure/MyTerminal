//! SSH 传输基础设施：认证、代理、跳板连接与隧道会话池。

use std::{
    collections::VecDeque,
    env,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ssh2::{Channel, MethodType, Session};

use crate::{
    error::AppError,
    models::{ConnectionProfile, SshJumpHost, SshProxyConfig, TunnelRecord},
    state::{AppState, TunnelSshPool, TunnelSshPoolSession, TunnelSshPoolState},
};

use super::{
    is_transient_channel_write_error, is_transient_ssh_error, lock_tunnel_ssh_pools, lock_tunnels,
    validate_connection_profile, SSH_BANNER_RETRY_DELAY, SSH_CONNECT_TIMEOUT, SSH_IO_TIMEOUT,
    TUNNEL_CHANNELS_PER_SSH_SESSION, TUNNEL_MAX_IDLE_SSH_SESSIONS_PER_CONNECTION,
    TUNNEL_MAX_PENDING_BYTES, TUNNEL_MAX_SSH_SESSIONS_PER_CONNECTION,
    TUNNEL_PENDING_SHRINK_THRESHOLD, TUNNEL_POOL_WAIT, TUNNEL_TRANSFER_BUFFER_BYTES,
    TUNNEL_TRANSFER_IDLE_WAIT,
};

mod tunnels;
pub(super) use tunnels::{
    cleanup_unused_tunnel_ssh_pool, clear_tunnel_ssh_pools, drop_tunnel_ssh_pool,
    get_or_create_tunnel_ssh_pool, mark_connection_tunnels_stopped, spawn_tunnel_listener,
    stop_connection_tunnel_runtimes,
};

pub(super) fn ssh_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(error.to_string())
}

pub(super) fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn expand_home_path(raw_path: &str) -> PathBuf {
    let trimmed = raw_path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            let mut expanded = PathBuf::from(home);
            if trimmed.len() > 2 {
                expanded.push(&trimmed[2..]);
            }
            return expanded;
        }
    }

    PathBuf::from(trimmed)
}

struct SshAuthConfig<'a> {
    username: &'a str,
    auth_method: &'a str,
    password: &'a str,
    private_key_path: Option<&'a str>,
    private_key_text: Option<&'a str>,
    passphrase: Option<&'a str>,
}

impl<'a> SshAuthConfig<'a> {
    fn from_connection(connection: &'a ConnectionProfile) -> Self {
        Self {
            username: &connection.username,
            auth_method: &connection.auth_method,
            password: &connection.password,
            private_key_path: connection.private_key_path.as_deref(),
            private_key_text: connection.private_key_text.as_deref(),
            passphrase: connection.passphrase.as_deref(),
        }
    }

    fn from_jump_host(jump_host: &'a SshJumpHost) -> Self {
        Self {
            username: &jump_host.username,
            auth_method: &jump_host.auth_method,
            password: &jump_host.password,
            private_key_path: jump_host.private_key_path.as_deref(),
            private_key_text: jump_host.private_key_text.as_deref(),
            passphrase: jump_host.passphrase.as_deref(),
        }
    }
}

fn authenticate_ssh_session(session: &Session, auth: &SshAuthConfig<'_>) -> Result<(), AppError> {
    let auth_method = auth.auth_method.trim();
    let username = auth.username.trim();

    if auth_method.eq_ignore_ascii_case("privateKey") {
        let passphrase = non_empty_trimmed(auth.passphrase);

        if let Some(private_key_text) = non_empty_trimmed(auth.private_key_text) {
            session
                .userauth_pubkey_memory(username, None, private_key_text, passphrase)
                .map_err(ssh_error)?;
            return Ok(());
        }

        let private_key_path = non_empty_trimmed(auth.private_key_path).ok_or_else(|| {
            AppError::Validation(
                "private key authentication requires a key path or pasted key content".into(),
            )
        })?;

        session
            .userauth_pubkey_file(
                username,
                None,
                &expand_home_path(private_key_path),
                passphrase,
            )
            .map_err(ssh_error)?;

        return Ok(());
    }

    let password = auth.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation(
            "password authentication requires a password".into(),
        ));
    }

    session
        .userauth_password(username, password)
        .map_err(ssh_error)?;

    Ok(())
}

fn is_key_exchange_error(error: &AppError) -> bool {
    let AppError::Ssh(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    normalized.contains("unable to exchange encryption keys") || normalized.contains("session(-8)")
}

// libssh2 的 Session(-13) 表示 TCP 已连接但尚未收到合法 SSH banner；此阶段还没有进入密钥交换或认证。
fn is_ssh_banner_error(error: &AppError) -> bool {
    let AppError::Ssh(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    normalized.contains("failed getting banner") || normalized.contains("session(-13)")
}

fn configure_ssh_compatibility_preferences(session: &Session) -> Result<(), AppError> {
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

pub(super) fn format_tcp_endpoint(host: &str, port: u16) -> String {
    let trimmed = host.trim();
    // IPv6 字面量作为 host:port 使用时必须加方括号；普通域名、IPv4 和已带括号的 IPv6 保持原样。
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

fn strip_ipv6_brackets(host: &str) -> &str {
    let trimmed = host.trim();
    // 表单里允许用户按 URI 习惯填写 [::1]；SOCKS5 地址字段需要裸 IPv6 字节，不能保留方括号。
    trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed)
}

fn resolve_tcp_address(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, AppError> {
    let address = format_tcp_endpoint(host, port);
    let addresses = address.to_socket_addrs()?.collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            format!("no resolved address for {address}"),
        )));
    }
    Ok(addresses)
}

pub(super) fn connect_tcp_direct(host: &str, port: u16) -> Result<TcpStream, AppError> {
    // SSH 辅助连接与 RDP 端口测试共享固定连接超时，避免不可达地址拖住 UI 刷新和测试连接。
    let mut last_error = None;
    for socket_address in resolve_tcp_address(host, port)? {
        match TcpStream::connect_timeout(&socket_address, SSH_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    Err(AppError::Io(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no reachable TCP address",
        )
    })))
}

fn read_http_proxy_response(stream: &mut TcpStream) -> Result<String, AppError> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 1];
    while response.len() < 16 * 1024 {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        response.push(buffer[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }

    String::from_utf8(response)
        .map_err(|error| AppError::Validation(format!("invalid HTTP proxy response: {error}")))
}

fn connect_http_proxy(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    let mut stream = connect_tcp_direct(&proxy.host, proxy.port)?;
    stream.set_read_timeout(Some(SSH_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(SSH_CONNECT_TIMEOUT))?;

    let target = format_tcp_endpoint(target_host, target_port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(username) = non_empty_trimmed(proxy.username.as_deref()) {
        let password = proxy.password.as_deref().unwrap_or("");
        let credentials = STANDARD.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let response = read_http_proxy_response(&mut stream)?;
    let status_line = response.lines().next().unwrap_or("");
    let status_ok = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse::<u16>().ok())
        .is_some_and(|status| (200..300).contains(&status));
    if !status_ok {
        return Err(AppError::Ssh(format!(
            "HTTP proxy CONNECT failed: {}",
            status_line.trim()
        )));
    }

    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(stream)
}

fn socks5_write_address(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), AppError> {
    let normalized_host = strip_ipv6_brackets(host);
    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(value) => {
                stream.write_all(&[0x01])?;
                stream.write_all(&value.octets())?;
            }
            IpAddr::V6(value) => {
                stream.write_all(&[0x04])?;
                stream.write_all(&value.octets())?;
            }
        }
    } else {
        let bytes = normalized_host.as_bytes();
        if bytes.len() > u8::MAX as usize {
            return Err(AppError::Validation(
                "SOCKS5 target host is too long".into(),
            ));
        }
        stream.write_all(&[0x03, bytes.len() as u8])?;
        stream.write_all(bytes)?;
    }

    stream.write_all(&port.to_be_bytes())?;
    Ok(())
}

fn socks5_read_address(stream: &mut TcpStream, atyp: u8) -> Result<(), AppError> {
    match atyp {
        0x01 => {
            let mut addr = [0_u8; 4];
            stream.read_exact(&mut addr)?;
        }
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len)?;
            let mut addr = vec![0_u8; len[0] as usize];
            stream.read_exact(&mut addr)?;
        }
        0x04 => {
            let mut addr = [0_u8; 16];
            stream.read_exact(&mut addr)?;
        }
        value => {
            return Err(AppError::Ssh(format!(
                "SOCKS5 proxy returned unsupported address type {value}"
            )))
        }
    }

    let mut port = [0_u8; 2];
    stream.read_exact(&mut port)?;
    Ok(())
}

fn connect_socks5_proxy(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    let mut stream = connect_tcp_direct(&proxy.host, proxy.port)?;
    stream.set_read_timeout(Some(SSH_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(SSH_CONNECT_TIMEOUT))?;

    let has_credentials = non_empty_trimmed(proxy.username.as_deref()).is_some();
    let methods: &[u8] = if has_credentials {
        &[0x00, 0x02]
    } else {
        &[0x00]
    };
    stream.write_all(&[0x05, methods.len() as u8])?;
    stream.write_all(methods)?;
    stream.flush()?;

    let mut selection = [0_u8; 2];
    stream.read_exact(&mut selection)?;
    if selection[0] != 0x05 {
        return Err(AppError::Ssh(
            "SOCKS5 proxy returned invalid version".into(),
        ));
    }

    if selection[1] == 0x02 {
        let username = proxy.username.as_deref().unwrap_or("");
        let password = proxy.password.as_deref().unwrap_or("");
        if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
            return Err(AppError::Validation(
                "SOCKS5 username or password is too long".into(),
            ));
        }
        stream.write_all(&[0x01, username.len() as u8])?;
        stream.write_all(username.as_bytes())?;
        stream.write_all(&[password.len() as u8])?;
        stream.write_all(password.as_bytes())?;
        stream.flush()?;
        let mut auth_response = [0_u8; 2];
        stream.read_exact(&mut auth_response)?;
        if auth_response != [0x01, 0x00] {
            return Err(AppError::Ssh(
                "SOCKS5 proxy username/password authentication failed".into(),
            ));
        }
    } else if selection[1] != 0x00 {
        return Err(AppError::Ssh(format!(
            "SOCKS5 proxy did not accept supported authentication method: {}",
            selection[1]
        )));
    }

    stream.write_all(&[0x05, 0x01, 0x00])?;
    socks5_write_address(&mut stream, target_host, target_port)?;
    stream.flush()?;

    let mut header = [0_u8; 4];
    stream.read_exact(&mut header)?;
    if header[0] != 0x05 || header[1] != 0x00 {
        return Err(AppError::Ssh(format!(
            "SOCKS5 proxy CONNECT failed with reply code {}",
            header[1]
        )));
    }
    socks5_read_address(&mut stream, header[3])?;

    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(stream)
}

fn connect_first_hop(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    if !proxy.enabled {
        return connect_tcp_direct(target_host, target_port);
    }
    if proxy.host.trim().is_empty() {
        return Err(AppError::Validation("proxy host is required".into()));
    }

    match proxy.proxy_type.trim().to_ascii_lowercase().as_str() {
        "http" | "https" | "http-connect" => connect_http_proxy(proxy, target_host, target_port),
        "socks5" | "socks" => connect_socks5_proxy(proxy, target_host, target_port),
        value => Err(AppError::Validation(format!(
            "unsupported proxy type: {value}"
        ))),
    }
}

fn prepare_ssh_tcp_stream(tcp: &TcpStream) -> Result<(), AppError> {
    // 交互终端输入是大量小包，必须关闭 Nagle，避免连续字符/退格被 TCP 合并后成批回显。
    tcp.set_nodelay(true)?;
    // 底层 socket 必须先切到 OS 非阻塞：libssh2 的阻塞 API 会自行 wait_socket，
    // 交互 Shell 的非阻塞 API 才能稳定收到 EAGAIN/WouldBlock，而不是 transport read。
    tcp.set_nonblocking(true)?;
    Ok(())
}

struct JumpBridge {
    local_host: String,
    local_port: u16,
    stop_flag: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for JumpBridge {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // 唤醒非阻塞 accept 循环，让会话结束时临时本地监听能及时退出。
        let _ = TcpStream::connect((self.local_host.as_str(), self.local_port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct SshTransport {
    stream: TcpStream,
    // 跳板桥接守卫必须跟随最终 SSH Session 生命周期，否则本地 loopback 转发会提前释放。
    _bridges: Vec<JumpBridge>,
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        // 最终 SSH 会话释放时先关闭本地 socket，再释放跳板监听守卫，确保代理转发线程尽快收到 EOF。
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

#[cfg(unix)]
impl std::os::fd::AsRawFd for SshTransport {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.stream.as_raw_fd()
    }
}

#[cfg(windows)]
impl std::os::windows::io::AsRawSocket for SshTransport {
    fn as_raw_socket(&self) -> std::os::windows::io::RawSocket {
        self.stream.as_raw_socket()
    }
}

fn establish_ssh_session(
    transport: SshTransport,
    auth: &SshAuthConfig<'_>,
    auth_host_label: &str,
    compatibility_mode: bool,
) -> Result<Session, AppError> {
    // 不在 TCP socket 上设 SO_RCVTIMEO/SO_SNDTIMEO：
    // Windows 上 socket timeout 与非阻塞模式冲突，recv()/send() 超时后返回 WSAETIMEDOUT，
    // libssh2 不认识这个错误码，包装成 "transport read" 错误导致非阻塞会话卡死。
    // 改用 libssh2 自身的 session.set_timeout() 控制阻塞操作（握手/认证）超时。
    prepare_ssh_tcp_stream(&transport.stream)?;
    let mut session = Session::new().map_err(ssh_error)?;
    session.set_timeout(SSH_IO_TIMEOUT.as_millis() as u32);
    session.set_tcp_stream(transport);
    if compatibility_mode {
        configure_ssh_compatibility_preferences(&session)?;
    }
    session.handshake().map_err(|error| {
        // 握手失败要保留当前阶段标签；多级跳板时仅显示最终目标会掩盖实际失败的那一跳。
        AppError::Ssh(format!(
            "SSH handshake failed for {auth_host_label}: {error}"
        ))
    })?;
    authenticate_ssh_session(&session, auth)?;

    if !session.authenticated() {
        return Err(AppError::Validation(format!(
            "authentication failed for {}@{}",
            auth.username.trim(),
            auth_host_label
        )));
    }

    // 认证完成后再启用底层 keepalive，避免影响部分 SSH 服务端的密钥交换阶段兼容性。
    session.set_keepalive(false, 20);

    Ok(session)
}

#[derive(Default)]
struct TunnelPendingBytes {
    // 非阻塞写可能只能消费部分数据，剩余字节必须排队，避免网页响应或请求体被截断。
    bytes: VecDeque<u8>,
}

impl TunnelPendingBytes {
    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data.iter().copied());
    }

    fn front_chunk(&self, max_len: usize) -> &[u8] {
        let (front, back) = self.bytes.as_slices();
        let chunk = if front.is_empty() { back } else { front };
        &chunk[..chunk.len().min(max_len)]
    }

    fn consume(&mut self, amount: usize) {
        let amount = amount.min(self.bytes.len());
        if amount > 0 {
            let _ = self.bytes.drain(..amount);
        }
        // 队列排空后若底层容量因突发扩得过大则收回，避免每个 channel 长期占用大缓冲。
        if self.bytes.is_empty() && self.bytes.capacity() > TUNNEL_PENDING_SHRINK_THRESHOLD {
            self.bytes.shrink_to(TUNNEL_PENDING_SHRINK_THRESHOLD);
        }
    }
}

fn is_transient_socket_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
    )
}

pub(super) fn open_direct_tcpip_channel(
    session: &Session,
    remote_host: &str,
    remote_port: u16,
    stop_flag: &AtomicBool,
) -> Result<Option<Channel>, AppError> {
    let started_at = Instant::now();
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }

        match session.channel_direct_tcpip(remote_host, remote_port, None) {
            Ok(channel) => return Ok(Some(channel)),
            Err(error) if is_transient_ssh_error(&error) => {
                if started_at.elapsed() > SSH_IO_TIMEOUT {
                    return Err(AppError::Ssh(format!(
                        "tunnel channel open timed out for {remote_host}:{remote_port}"
                    )));
                }
                thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
            }
            Err(error) => return Err(ssh_error(error)),
        }
    }
}

fn close_tunnel_channel(mut channel: Channel) {
    // 非阻塞 close 可能短暂 EAGAIN；短重试能让服务端尽快回收 channel，又不拖住隧道线程。
    for _ in 0..8 {
        match channel.close() {
            Ok(()) => break,
            Err(error) if is_transient_ssh_error(&error) => {
                thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
            }
            Err(_) => break,
        }
    }
}

pub(super) fn proxy_tcp_stream(
    mut local_stream: TcpStream,
    mut channel: Channel,
    stop_flag: Arc<AtomicBool>,
) -> bool {
    let _ = local_stream.set_nodelay(true);
    let _ = local_stream.set_nonblocking(true);

    let mut to_remote = TunnelPendingBytes::default();
    let mut to_local = TunnelPendingBytes::default();
    let mut local_buffer = vec![0_u8; TUNNEL_TRANSFER_BUFFER_BYTES];
    let mut remote_buffer = vec![0_u8; TUNNEL_TRANSFER_BUFFER_BYTES];
    let mut local_read_closed = false;
    let mut remote_read_closed = false;
    let mut remote_eof_sent = false;
    let mut local_write_shutdown = false;
    let mut session_reusable = true;

    while !stop_flag.load(Ordering::Relaxed) {
        let mut made_progress = false;
        let mut wrote_remote = false;

        while !to_remote.is_empty() {
            let chunk = to_remote.front_chunk(TUNNEL_TRANSFER_BUFFER_BYTES);
            let chunk_len = chunk.len();
            match channel.write(chunk) {
                Ok(0) => break,
                Ok(size) => {
                    to_remote.consume(size.min(chunk_len));
                    made_progress = true;
                    wrote_remote = true;
                }
                Err(error) if is_transient_channel_write_error(&error) => break,
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if !session_reusable {
            break;
        }

        if wrote_remote {
            match channel.flush() {
                Ok(()) => {}
                Err(error) if is_transient_channel_write_error(&error) => {}
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if local_read_closed && to_remote.is_empty() && !remote_eof_sent {
            match channel.send_eof() {
                Ok(()) => {
                    remote_eof_sent = true;
                    made_progress = true;
                }
                Err(error) if is_transient_ssh_error(&error) => {}
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        while !to_local.is_empty() {
            let chunk = to_local.front_chunk(TUNNEL_TRANSFER_BUFFER_BYTES);
            let chunk_len = chunk.len();
            match local_stream.write(chunk) {
                Ok(0) => break,
                Ok(size) => {
                    to_local.consume(size.min(chunk_len));
                    made_progress = true;
                }
                Err(error) if is_transient_socket_error(&error) => break,
                Err(_) => {
                    // 本地浏览器提前关闭连接属于正常网页行为，不应丢弃可复用 SSH session。
                    local_read_closed = true;
                    to_local.consume(to_local.len());
                    break;
                }
            }
        }

        if remote_read_closed && to_local.is_empty() && !local_write_shutdown {
            let _ = local_stream.shutdown(Shutdown::Write);
            local_write_shutdown = true;
            made_progress = true;
        }

        while !local_read_closed && to_remote.len() < TUNNEL_MAX_PENDING_BYTES {
            let remaining_capacity = TUNNEL_MAX_PENDING_BYTES - to_remote.len();
            let read_len = local_buffer.len().min(remaining_capacity);
            match local_stream.read(&mut local_buffer[..read_len]) {
                Ok(0) => {
                    local_read_closed = true;
                    made_progress = true;
                    break;
                }
                Ok(size) => {
                    to_remote.push(&local_buffer[..size]);
                    made_progress = true;
                    if size < read_len {
                        break;
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if is_transient_socket_error(&error) => break,
                Err(_) => {
                    // 本地端异常断开时尽快给远端 EOF，让 HTTP keep-alive 连接能释放。
                    local_read_closed = true;
                    made_progress = true;
                    break;
                }
            }
        }

        while !remote_read_closed && to_local.len() < TUNNEL_MAX_PENDING_BYTES {
            let remaining_capacity = TUNNEL_MAX_PENDING_BYTES - to_local.len();
            let read_len = remote_buffer.len().min(remaining_capacity);
            match channel.read(&mut remote_buffer[..read_len]) {
                Ok(0) => {
                    if channel.eof() {
                        remote_read_closed = true;
                        made_progress = true;
                    }
                    break;
                }
                Ok(size) => {
                    to_local.push(&remote_buffer[..size]);
                    made_progress = true;
                    if size < read_len {
                        break;
                    }
                }
                Err(error) if is_transient_channel_write_error(&error) => break,
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if !session_reusable {
            break;
        }

        if local_read_closed && remote_read_closed && to_remote.is_empty() && to_local.is_empty() {
            break;
        }

        if !made_progress {
            thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
        }
    }

    if stop_flag.load(Ordering::Relaxed) {
        session_reusable = false;
    }
    close_tunnel_channel(channel);
    session_reusable
}

fn spawn_jump_bridge(
    session: Session,
    target_host: String,
    target_port: u16,
) -> Result<JumpBridge, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let local_port = listener.local_addr()?.port();
    let local_host = "127.0.0.1".to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        // 跳板桥只服务后续 SSH TCP 流；切到非阻塞后，双向转发不会因单侧 read 卡住同一 session 的写入。
        session.set_blocking(false);
        session.set_timeout(0);
        while !thread_stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _)) => {
                    if thread_stop_flag.load(Ordering::SeqCst) {
                        let _ = local_stream.shutdown(Shutdown::Both);
                        break;
                    }
                    let channel = match open_direct_tcpip_channel(
                        &session,
                        &target_host,
                        target_port,
                        &thread_stop_flag,
                    ) {
                        Ok(Some(channel)) => channel,
                        Ok(None) => {
                            let _ = local_stream.shutdown(Shutdown::Both);
                            break;
                        }
                        Err(_) => {
                            let _ = local_stream.shutdown(Shutdown::Both);
                            continue;
                        }
                    };
                    let bridge_stop = Arc::clone(&thread_stop_flag);
                    thread::spawn(move || {
                        if !proxy_tcp_stream(local_stream, channel, bridge_stop) {
                            // 单条桥接流失败只影响当前连接；外层 listener 继续接收后续重连。
                        }
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    Ok(JumpBridge {
        local_host,
        local_port,
        stop_flag,
        handle: Some(handle),
    })
}

fn jump_host_label(jump_host: &SshJumpHost) -> String {
    jump_host
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&jump_host.host)
        .to_string()
}

fn connect_ssh_once(
    connection: &ConnectionProfile,
    compatibility_mode: bool,
) -> Result<Session, AppError> {
    if connection.jump_hosts.is_empty() {
        let tcp = connect_first_hop(&connection.proxy, &connection.host, connection.port)?;
        return establish_ssh_session(
            SshTransport {
                stream: tcp,
                _bridges: Vec::new(),
            },
            &SshAuthConfig::from_connection(connection),
            &connection.host,
            compatibility_mode,
        );
    }

    let first_jump = &connection.jump_hosts[0];
    let first_tcp = connect_first_hop(&connection.proxy, &first_jump.host, first_jump.port)?;
    let first_label = jump_host_label(first_jump);
    let mut current_session = establish_ssh_session(
        SshTransport {
            stream: first_tcp,
            _bridges: Vec::new(),
        },
        &SshAuthConfig::from_jump_host(first_jump),
        &first_label,
        compatibility_mode,
    )?;

    let mut bridges = Vec::new();
    for jump_host in connection.jump_hosts.iter().skip(1) {
        let bridge = spawn_jump_bridge(current_session, jump_host.host.clone(), jump_host.port)?;
        let local_host = bridge.local_host.clone();
        let local_port = bridge.local_port;
        bridges.push(bridge);
        let tcp = connect_tcp_direct(&local_host, local_port)?;
        let jump_label = jump_host_label(jump_host);
        current_session = establish_ssh_session(
            SshTransport {
                stream: tcp,
                _bridges: Vec::new(),
            },
            &SshAuthConfig::from_jump_host(jump_host),
            &jump_label,
            compatibility_mode,
        )?;
    }

    let target_bridge =
        spawn_jump_bridge(current_session, connection.host.clone(), connection.port)?;
    let target_host = target_bridge.local_host.clone();
    let target_port = target_bridge.local_port;
    bridges.push(target_bridge);
    let tcp = connect_tcp_direct(&target_host, target_port)?;

    establish_ssh_session(
        SshTransport {
            stream: tcp,
            _bridges: bridges,
        },
        &SshAuthConfig::from_connection(connection),
        &connection.host,
        compatibility_mode,
    )
}

// 默认算法与兼容算法的选择集中在一个连接尝试内；banner 重试必须重建 TCP/代理/跳板整条链路，不能复用已污染 Session。
fn connect_ssh_with_compatibility(connection: &ConnectionProfile) -> Result<Session, AppError> {
    match connect_ssh_once(connection, false) {
        Ok(session) => Ok(session),
        Err(error) if is_key_exchange_error(&error) => connect_ssh_once(connection, true),
        Err(error) => Err(error),
    }
}

// banner 诊断只包含定位所需的主机、端口与路由类型，不输出密码、密钥、代理账号等认证材料。
fn ssh_banner_failure_with_context(connection: &ConnectionProfile, error: &AppError) -> AppError {
    let reason = match error {
        AppError::Ssh(message) => message.as_str(),
        _ => return AppError::Ssh(error.to_string()),
    };
    let route = if connection.jump_hosts.is_empty() {
        if connection.proxy.enabled {
            "proxy route".to_string()
        } else {
            "direct route".to_string()
        }
    } else {
        format!("{} jump host(s)", connection.jump_hosts.len())
    };

    AppError::Ssh(format!(
        "SSH banner handshake failed for {}:{} via {} after one retry: {}. TCP connected, but the peer did not provide a valid SSH banner; verify the SSH service/port and server connection limits",
        connection.host.trim(),
        connection.port,
        route,
        reason
    ))
}

pub(crate) fn connect_ssh(connection: &ConnectionProfile) -> Result<Session, AppError> {
    // 所有 SSH 入口（界面、AI、文件和隧道）最终都会经过这里，防止 RDP 配置被误当作 SSH 发起握手。
    if !connection.protocol.trim().eq_ignore_ascii_case("ssh") {
        return Err(AppError::Validation(
            "this connection is not an SSH connection".into(),
        ));
    }
    validate_connection_profile(connection)?;
    match connect_ssh_with_compatibility(connection) {
        Ok(session) => Ok(session),
        Err(error) if is_ssh_banner_error(&error) => {
            thread::sleep(SSH_BANNER_RETRY_DELAY);
            match connect_ssh_with_compatibility(connection) {
                Ok(session) => Ok(session),
                Err(retry_error) if is_ssh_banner_error(&retry_error) => {
                    Err(ssh_banner_failure_with_context(connection, &retry_error))
                }
                Err(retry_error) => Err(retry_error),
            }
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod ssh_banner_error_tests {
    use super::*;

    #[test]
    fn recognizes_libssh2_banner_receive_errors_only() {
        assert!(is_ssh_banner_error(&AppError::Ssh(
            "[Session(-13)] Failed getting banner".into()
        )));
        assert!(!is_ssh_banner_error(&AppError::Ssh(
            "[Session(-8)] Unable to exchange encryption keys".into()
        )));
    }
}
