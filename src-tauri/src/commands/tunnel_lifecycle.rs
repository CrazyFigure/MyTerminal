//! 隧道启动用例：同一连接的 SSH 标签共享监听，自动与手动操作统一串行化。

use super::*;

/// 配置读改写、监听登记与状态事件使用同一操作锁；不在持锁期间进行 SSH 握手。
pub(super) fn lock_tunnel_operations(state: &AppState) -> Result<MutexGuard<'_, ()>, AppError> {
    state
        .tunnel_operations
        .lock()
        .map_err(|_| AppError::Validation("tunnel operation lock is unavailable".into()))
}

/// 调用方持有操作锁。已有监听直接复用，避免重复打开 SSH 时中断转发或重新抢占端口。
fn ensure_tunnel_started(
    state: &AppState,
    connection: &ConnectionProfile,
    tunnel: &mut TunnelRecord,
) -> Result<bool, AppError> {
    if lock_tunnels(state)?
        .get(&tunnel.id)
        .is_some_and(|runtime| !runtime.stop_flag.load(Ordering::Relaxed))
    {
        // 健康监控标记的异常状态仍由监控恢复，复用监听本身不代表 SSH 已恢复。
        if tunnel.status != "error" {
            tunnel.status = "running".into();
        }
        return Ok(false);
    }

    let removed = lock_tunnels(state)?.remove(&tunnel.id);
    if removed.is_some() {
        cleanup_unused_tunnel_ssh_pool(state, &connection.id)?;
    }
    validate_tunnel_fields(tunnel)?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    let pool = get_or_create_tunnel_ssh_pool(state, connection)?;
    if let Err(error) =
        spawn_tunnel_listener(Arc::clone(&pool), tunnel.clone(), Arc::clone(&stop_flag))
    {
        cleanup_unused_tunnel_ssh_pool(state, &connection.id)?;
        return Err(error);
    }
    let mut runtimes = match lock_tunnels(state) {
        Ok(runtimes) => runtimes,
        Err(error) => {
            stop_flag.store(true, Ordering::Relaxed);
            cleanup_unused_tunnel_ssh_pool(state, &connection.id)?;
            return Err(error);
        }
    };
    runtimes.insert(
        tunnel.id.clone(),
        TunnelRuntime {
            connection_id: connection.id.clone(),
            stop_flag,
            pool,
        },
    );
    tunnel.status = "running".into();
    Ok(true)
}

/// 批量状态只落盘一次；保存失败只撤销本次新建的监听，不影响其他标签正在使用的隧道。
fn save_started_tunnels(
    state: &AppState,
    tunnels: &[TunnelRecord],
    started_ids: &[String],
) -> Result<(), AppError> {
    if let Err(error) = state.storage.save_tunnels(tunnels) {
        for id in started_ids {
            let removed = lock_tunnels(state)?.remove(id);
            if let Some(runtime) = removed {
                runtime.stop_flag.store(true, Ordering::Relaxed);
                cleanup_unused_tunnel_ssh_pool(state, &runtime.connection_id)?;
            }
        }
        return Err(error);
    }
    Ok(())
}

/// 手动开启与自动开启复用相同的幂等启动规则。
pub(super) fn start_tunnel_by_id(
    state: &AppState,
    tunnel_id: &str,
) -> Result<TunnelRecord, AppError> {
    let _operation = lock_tunnel_operations(state)?;
    let mut tunnels = state.storage.load_tunnels()?;
    let index = tunnels
        .iter()
        .position(|item| item.id == tunnel_id)
        .ok_or_else(|| AppError::NotFound(format!("tunnel {tunnel_id} not found")))?;
    let connection = ensure_connection_exists(state, &tunnels[index].connection_id)?;
    let started = ensure_tunnel_started(state, &connection, &mut tunnels[index])?;
    let started_ids = if started {
        vec![tunnel_id.to_string()]
    } else {
        Vec::new()
    };
    save_started_tunnels(state, &tunnels, &started_ids)?;
    Ok(tunnels[index].clone())
}

/// 调用方持有操作锁；单条端口冲突不阻止其余配置启动，并保留每条失败原因。
fn start_configured_tunnels(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<(Vec<TunnelRecord>, Vec<String>), AppError> {
    let mut tunnels = state.storage.load_tunnels()?;
    let mut changed = Vec::new();
    let mut started_ids = Vec::new();
    let mut failures = Vec::new();
    for tunnel in tunnels
        .iter_mut()
        .filter(|item| item.connection_id == connection.id)
    {
        match ensure_tunnel_started(state, connection, tunnel) {
            Ok(true) => started_ids.push(tunnel.id.clone()),
            Ok(false) => {}
            Err(error) => {
                tunnel.status = "error".into();
                failures.push(format!(
                    "{}（{}:{}）：{error}",
                    tunnel.name, tunnel.bind_address, tunnel.local_port
                ));
            }
        }
        changed.push(tunnel.clone());
    }
    if !changed.is_empty() {
        save_started_tunnels(state, &tunnels, &started_ids)?;
    }
    Ok((changed, failures))
}

/// Shell 确认可用后才开启全部隧道；已关闭的标签或恢复配置前的旧会话不再产生监听。
pub(super) fn start_session_tunnels(
    state: &AppState,
    session_id: &str,
    on_status: impl Fn(&TunnelRecord),
) -> Result<Vec<String>, AppError> {
    let _operation = lock_tunnel_operations(state)?;
    let connection_id = {
        let sessions = lock_sessions(state)?;
        let Some(runtime) = sessions.get(session_id) else {
            return Ok(Vec::new());
        };
        if state.is_shutting_down.load(Ordering::Relaxed)
            || runtime.stop_flag.load(Ordering::Relaxed)
        {
            return Ok(Vec::new());
        }
        runtime.session.connection_id.clone()
    };
    let connection = ensure_connection_exists(state, &connection_id)?;
    let (changed, failures) = start_configured_tunnels(state, &connection)?;
    // 事件与停止、编辑操作按锁顺序发出，失败也要让面板显示真实状态。
    for tunnel in &changed {
        on_status(tunnel);
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, net::TcpListener, path::PathBuf};

    struct Fixture {
        state: AppState,
        directory: PathBuf,
    }

    impl Fixture {
        // 临时配置与系统分配的本地端口完全隔离；监听测试不发起远端 SSH 握手。
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("myterminal-tunnels-{}", uuid::Uuid::new_v4()));
            let storage = crate::storage::StorageService::new(directory.clone()).unwrap();
            let state = AppState::from_storage(storage).unwrap();
            let connection: ConnectionProfile = serde_json::from_value(serde_json::json!({
                "id": "connection", "name": "test", "host": "127.0.0.1", "username": "test"
            }))
            .unwrap();
            state
                .storage
                .save_connections(&[connection], &state.crypto)
                .unwrap();
            Self { state, directory }
        }

        fn add_session(&self, id: &str) {
            let (control_tx, _) = mpsc::channel();
            lock_sessions(&self.state).unwrap().insert(
                id.into(),
                RuntimeSession {
                    session: TerminalSession {
                        id: id.into(),
                        kind: "ssh".into(),
                        connection_id: "connection".into(),
                        local_profile_id: None,
                        local_command: None,
                        title: "test".into(),
                        status: "connecting".into(),
                        cwd: None,
                    },
                    cols: 120,
                    rows: 32,
                    output_queue: Arc::new(std::sync::Mutex::new(TerminalOutputQueue::new())),
                    control_tx,
                    stop_flag: Arc::new(AtomicBool::new(false)),
                    agent_pty: Arc::new(std::sync::Mutex::new(AgentPtyState::default())),
                    agent_pty_signal: Arc::new(Condvar::new()),
                },
            );
        }

        fn save(&self, tunnels: &[TunnelRecord]) {
            self.state.storage.save_tunnels(tunnels).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // 测试结束停止全部监听；等待端口释放，确保后台监听线程也已结束。
            let records = self.state.storage.load_tunnels().unwrap_or_default();
            runtime_daemons::stop_all_runtimes(&self.state).unwrap();
            for record in records {
                let deadline = Instant::now() + Duration::from_secs(2);
                while TcpListener::bind(("127.0.0.1", record.local_port)).is_err()
                    && Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(10));
                }
            }
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    fn tunnel(id: &str) -> TunnelRecord {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        TunnelRecord {
            id: id.into(),
            connection_id: "connection".into(),
            name: id.into(),
            bind_address: "127.0.0.1".into(),
            local_port: listener.local_addr().unwrap().port(),
            remote_host: "127.0.0.1".into(),
            remote_port: 80,
            status: "stopped".into(),
        }
    }

    #[test]
    fn starts_all_configured_tunnels_only_for_opened_connection() {
        let fixture = Fixture::new();
        fixture.add_session("session");
        let first = tunnel("first");
        let mut second = tunnel("second");
        second.status = "error".into();
        let mut other = tunnel("other");
        other.connection_id = "another-connection".into();
        fixture.save(&[first.clone(), second.clone(), other]);
        let events = std::sync::Mutex::new(Vec::new());
        let failures = start_session_tunnels(&fixture.state, "session", |record| {
            events.lock().unwrap().push(record.clone());
        })
        .unwrap();
        assert!(failures.is_empty());
        assert_eq!(events.lock().unwrap().len(), 2);
        assert_eq!(lock_tunnels(&fixture.state).unwrap().len(), 2);
        assert!(TcpListener::bind(("127.0.0.1", first.local_port)).is_err());
        assert!(TcpListener::bind(("127.0.0.1", second.local_port)).is_err());
        let saved = fixture.state.storage.load_tunnels().unwrap();
        assert_eq!(saved[0].status, "running");
        assert_eq!(saved[1].status, "running");
        assert_eq!(saved[2].status, "stopped");
    }

    #[test]
    fn repeated_and_concurrent_sessions_reuse_listener_and_pool() {
        let fixture = Fixture::new();
        fixture.add_session("first-session");
        fixture.add_session("second-session");
        let record = tunnel("shared");
        fixture.save(&[record.clone()]);
        start_session_tunnels(&fixture.state, "first-session", |_| {}).unwrap();
        let original = lock_tunnels(&fixture.state).unwrap()["shared"].clone();
        thread::scope(|scope| {
            for _ in 0..8 {
                let state = &fixture.state;
                scope.spawn(move || {
                    assert!(start_session_tunnels(state, "second-session", |_| {})
                        .unwrap()
                        .is_empty());
                    assert_eq!(
                        start_tunnel_by_id(state, "shared").unwrap().status,
                        "running"
                    );
                });
            }
        });
        let runtimes = lock_tunnels(&fixture.state).unwrap();
        assert_eq!(runtimes.len(), 1);
        assert!(Arc::ptr_eq(
            &original.stop_flag,
            &runtimes["shared"].stop_flag
        ));
        assert!(Arc::ptr_eq(&original.pool, &runtimes["shared"].pool));
        assert!(!original.stop_flag.load(Ordering::Relaxed));
        drop(runtimes);
        // 关闭任一 SSH 标签不清理连接级隧道，其他标签仍共享原监听。
        lock_sessions(&fixture.state)
            .unwrap()
            .remove("first-session");
        assert_eq!(
            start_tunnel_by_id(&fixture.state, "shared").unwrap().status,
            "running"
        );
        assert!(!original.stop_flag.load(Ordering::Relaxed));
    }

    #[test]
    fn port_conflict_does_not_block_others_and_next_open_retries_failure() {
        let fixture = Fixture::new();
        fixture.add_session("session");
        let blocker = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut blocked = tunnel("blocked");
        blocked.local_port = blocker.local_addr().unwrap().port();
        let available = tunnel("available");
        fixture.save(&[blocked, available]);
        let failures = start_session_tunnels(&fixture.state, "session", |_| {}).unwrap();
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("blocked"));
        let saved = fixture.state.storage.load_tunnels().unwrap();
        assert_eq!(saved[0].status, "error");
        assert_eq!(saved[1].status, "running");
        let original = lock_tunnels(&fixture.state).unwrap()["available"].clone();
        drop(blocker);
        assert!(start_session_tunnels(&fixture.state, "session", |_| {})
            .unwrap()
            .is_empty());
        assert_eq!(lock_tunnels(&fixture.state).unwrap().len(), 2);
        assert!(!original.stop_flag.load(Ordering::Relaxed));
        assert!(fixture
            .state
            .storage
            .load_tunnels()
            .unwrap()
            .iter()
            .all(|record| record.status == "running"));
    }

    #[test]
    fn closed_cancelled_or_shutdown_sessions_do_not_start_tunnels() {
        let fixture = Fixture::new();
        fixture.save(&[tunnel("configured")]);
        assert!(
            start_session_tunnels(&fixture.state, "closed", |_| panic!("unexpected event"))
                .unwrap()
                .is_empty()
        );
        fixture.add_session("cancelled");
        lock_sessions(&fixture.state).unwrap()["cancelled"]
            .stop_flag
            .store(true, Ordering::Relaxed);
        start_session_tunnels(&fixture.state, "cancelled", |_| panic!("unexpected event")).unwrap();
        fixture.add_session("shutdown");
        fixture
            .state
            .is_shutting_down
            .store(true, Ordering::Relaxed);
        start_session_tunnels(&fixture.state, "shutdown", |_| panic!("unexpected event")).unwrap();
        assert!(lock_tunnels(&fixture.state).unwrap().is_empty());
        assert_eq!(
            fixture.state.storage.load_tunnels().unwrap()[0].status,
            "stopped"
        );
    }

    #[test]
    fn concurrent_manual_starts_preserve_all_persisted_statuses() {
        let fixture = Fixture::new();
        fixture.save(&[tunnel("first"), tunnel("second")]);
        thread::scope(|scope| {
            for id in ["first", "second"] {
                let state = &fixture.state;
                scope.spawn(move || {
                    start_tunnel_by_id(state, id).unwrap();
                });
            }
        });
        assert!(fixture
            .state
            .storage
            .load_tunnels()
            .unwrap()
            .iter()
            .all(|record| record.status == "running"));
        assert_eq!(lock_tunnels(&fixture.state).unwrap().len(), 2);
    }

    #[test]
    fn reusing_unhealthy_listener_preserves_health_status() {
        let fixture = Fixture::new();
        let mut record = tunnel("unhealthy");
        fixture.save(&[record.clone()]);
        start_tunnel_by_id(&fixture.state, "unhealthy").unwrap();
        record.status = "error".into();
        fixture.save(&[record]);
        let original = lock_tunnels(&fixture.state).unwrap()["unhealthy"].clone();
        assert_eq!(
            start_tunnel_by_id(&fixture.state, "unhealthy")
                .unwrap()
                .status,
            "error"
        );
        assert!(!original.stop_flag.load(Ordering::Relaxed));
    }

    #[test]
    fn save_failure_rolls_back_only_new_listeners() {
        let fixture = Fixture::new();
        let original = tunnel("original");
        let mut added = tunnel("added");
        fixture.save(&[original.clone(), added.clone()]);
        start_tunnel_by_id(&fixture.state, "original").unwrap();
        let connection = ensure_connection_exists(&fixture.state, "connection").unwrap();
        assert!(ensure_tunnel_started(&fixture.state, &connection, &mut added).unwrap());
        // 以目录占据配置文件路径，模拟监听成功后的落盘失败。
        let path = fixture.state.storage.tunnels_file_path();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(
            save_started_tunnels(&fixture.state, &[original, added], &["added".into()]).is_err()
        );
        let runtimes = lock_tunnels(&fixture.state).unwrap();
        assert_eq!(runtimes.len(), 1);
        assert!(runtimes.contains_key("original"));
        assert!(!runtimes["original"].stop_flag.load(Ordering::Relaxed));
    }
}
