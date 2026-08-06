//! SSH 隧道连接池与本地监听适配器。
//! 按连接复用有限 SSH session/channel，连接编辑或最后一条隧道关闭时统一回收池资源。

use super::*;

struct TunnelSessionLease {
    // lease 归还时需要回到原池更新 active channel 计数。
    pool: Arc<TunnelSshPool>,
    // 池内 session ID，避免 Vec 扩缩容后使用下标归还错误。
    session_id: u64,
    // ssh2::Session 是同一底层连接的句柄克隆；channel 结束后由 Drop 自动归还计数。
    session: Session,
    // transport 级错误会污染整个 SSH session，此时归还时应从池里剔除。
    reusable: bool,
}

impl TunnelSessionLease {
    fn session(&self) -> &Session {
        &self.session
    }

    fn discard(&mut self) {
        self.reusable = false;
    }
}

impl Drop for TunnelSessionLease {
    fn drop(&mut self) {
        self.pool.release_session(self.session_id, self.reusable);
    }
}

impl TunnelSshPool {
    fn new(connection: ConnectionProfile) -> Self {
        Self {
            connection,
            inner: Mutex::new(TunnelSshPoolState {
                sessions: Vec::new(),
                connecting_sessions: 0,
                next_session_id: 1,
                closed: false,
            }),
            available: std::sync::Condvar::new(),
        }
    }

    fn checkout(
        self: &Arc<Self>,
        stop_flag: &AtomicBool,
    ) -> Result<Option<TunnelSessionLease>, AppError> {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                return Ok(None);
            }

            let mut state = self
                .inner
                .lock()
                .map_err(|_| AppError::Validation("tunnel ssh pool is unavailable".into()))?;
            if state.closed {
                return Ok(None);
            }

            if let Some(slot) = state
                .sessions
                .iter_mut()
                .find(|slot| !slot.failed && slot.active_channels < TUNNEL_CHANNELS_PER_SSH_SESSION)
            {
                slot.active_channels += 1;
                return Ok(Some(TunnelSessionLease {
                    pool: Arc::clone(self),
                    session_id: slot.id,
                    session: slot.session.clone(),
                    reusable: true,
                }));
            }

            let total_sessions = state.sessions.len() + state.connecting_sessions;
            let should_connect = state.connecting_sessions == 0
                && total_sessions < TUNNEL_MAX_SSH_SESSIONS_PER_CONNECTION;
            if should_connect {
                state.connecting_sessions += 1;
                drop(state);

                let connect_result = self.connect_session();
                let mut state = self
                    .inner
                    .lock()
                    .map_err(|_| AppError::Validation("tunnel ssh pool is unavailable".into()))?;
                state.connecting_sessions = state.connecting_sessions.saturating_sub(1);

                let session = match connect_result {
                    Ok(session) => session,
                    Err(error) => {
                        self.available.notify_all();
                        return Err(error);
                    }
                };

                if state.closed || stop_flag.load(Ordering::Relaxed) {
                    self.available.notify_all();
                    return Ok(None);
                }

                let session_id = state.next_session_id;
                state.next_session_id = state.next_session_id.saturating_add(1);
                state.sessions.push(TunnelSshPoolSession {
                    id: session_id,
                    session: session.clone(),
                    active_channels: 1,
                    failed: false,
                });
                self.available.notify_all();
                return Ok(Some(TunnelSessionLease {
                    pool: Arc::clone(self),
                    session_id,
                    session,
                    reusable: true,
                }));
            }

            let (next_state, _) = self
                .available
                .wait_timeout(state, TUNNEL_POOL_WAIT)
                .map_err(|_| AppError::Validation("tunnel ssh pool wait failed".into()))?;
            drop(next_state);
        }
    }

    fn connect_session(&self) -> Result<Session, AppError> {
        let session = connect_ssh(&self.connection)?;
        // 隧道 channel 使用自己的非阻塞轮询泵，不能让 libssh2 阻塞读占住同一 session 的全局锁。
        session.set_blocking(false);
        session.set_timeout(0);
        Ok(session)
    }

    fn release_session(&self, session_id: u64, reusable: bool) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };

        if let Some(slot) = state.sessions.iter_mut().find(|slot| slot.id == session_id) {
            slot.active_channels = slot.active_channels.saturating_sub(1);
            if !reusable {
                slot.failed = true;
            }
        }

        state
            .sessions
            .retain(|slot| !(slot.failed && slot.active_channels == 0));

        if !state.closed {
            let mut idle_kept = 0_usize;
            state.sessions.retain(|slot| {
                if slot.active_channels > 0 {
                    true
                } else {
                    idle_kept += 1;
                    idle_kept <= TUNNEL_MAX_IDLE_SSH_SESSIONS_PER_CONNECTION
                }
            });
        }

        self.available.notify_all();
    }

    fn close(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.closed = true;
            state.sessions.clear();
            self.available.notify_all();
        }
    }
}

pub(in crate::commands) fn get_or_create_tunnel_ssh_pool(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<Arc<TunnelSshPool>, AppError> {
    let mut pools = lock_tunnel_ssh_pools(state)?;
    if let Some(pool) = pools.get(&connection.id) {
        return Ok(Arc::clone(pool));
    }

    // 池按连接配置快照创建；连接编辑会关闭旧池，新隧道自然使用新配置。
    let pool = Arc::new(TunnelSshPool::new(connection.clone()));
    pools.insert(connection.id.clone(), Arc::clone(&pool));
    Ok(pool)
}

pub(in crate::commands) fn drop_tunnel_ssh_pool(state: &AppState, connection_id: &str) {
    if let Ok(mut pools) = lock_tunnel_ssh_pools(state) {
        if let Some(pool) = pools.remove(connection_id) {
            pool.close();
        }
    }
}

pub(in crate::commands) fn clear_tunnel_ssh_pools(state: &AppState) {
    if let Ok(mut pools) = lock_tunnel_ssh_pools(state) {
        for pool in pools.drain().map(|(_, pool)| pool) {
            pool.close();
        }
    }
}

pub(in crate::commands) fn cleanup_unused_tunnel_ssh_pool(
    state: &AppState,
    connection_id: &str,
) -> Result<(), AppError> {
    let has_running_tunnel = lock_tunnels(state)?
        .values()
        .any(|runtime| runtime.connection_id == connection_id);
    if !has_running_tunnel {
        drop_tunnel_ssh_pool(state, connection_id);
    }
    Ok(())
}

pub(in crate::commands) fn stop_connection_tunnel_runtimes(
    state: &AppState,
    connection_id: &str,
) -> Result<(), AppError> {
    let mut tunnel_runtime = lock_tunnels(state)?;
    let tunnel_ids = tunnel_runtime
        .iter()
        .filter_map(|(tunnel_id, runtime)| {
            (runtime.connection_id == connection_id).then(|| tunnel_id.clone())
        })
        .collect::<Vec<_>>();

    for tunnel_id in tunnel_ids {
        if let Some(runtime) = tunnel_runtime.remove(&tunnel_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
        }
    }
    drop(tunnel_runtime);

    drop_tunnel_ssh_pool(state, connection_id);
    Ok(())
}

pub(in crate::commands) fn mark_connection_tunnels_stopped(
    state: &AppState,
    connection_id: &str,
) -> Result<(), AppError> {
    let mut tunnels = state.storage.load_tunnels()?;
    let mut changed = false;
    for tunnel in &mut tunnels {
        if tunnel.connection_id == connection_id && tunnel.status == "running" {
            tunnel.status = "stopped".into();
            changed = true;
        }
    }

    if changed {
        state.storage.save_tunnels(&tunnels)?;
    }
    Ok(())
}

fn forward_single_connection(
    pool: Arc<TunnelSshPool>,
    remote_host: String,
    remote_port: u16,
    local_stream: TcpStream,
    stop_flag: Arc<AtomicBool>,
) {
    let Ok(Some(mut lease)) = pool.checkout(&stop_flag) else {
        return;
    };

    let channel =
        match open_direct_tcpip_channel(lease.session(), &remote_host, remote_port, &stop_flag) {
            Ok(Some(channel)) => channel,
            Ok(None) => return,
            Err(_) => {
                if stop_flag.load(Ordering::Relaxed) {
                    lease.discard();
                }
                return;
            }
        };

    if !proxy_tcp_stream(local_stream, channel, Arc::clone(&stop_flag))
        && !stop_flag.load(Ordering::Relaxed)
    {
        lease.discard();
    }
}

pub(in crate::commands) fn spawn_tunnel_listener(
    pool: Arc<TunnelSshPool>,
    tunnel: TunnelRecord,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let listener = TcpListener::bind((tunnel.bind_address.as_str(), tunnel.local_port))?;
    listener.set_nonblocking(true)?;

    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let pool = Arc::clone(&pool);
                    let remote_host = tunnel.remote_host.clone();
                    let remote_port = tunnel.remote_port;
                    let stop = Arc::clone(&stop_flag);
                    thread::spawn(move || {
                        forward_single_connection(pool, remote_host, remote_port, stream, stop);
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}
