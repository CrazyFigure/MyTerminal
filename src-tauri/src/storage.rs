use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    crypto::CryptoService,
    error::AppError,
    models::{
        AppSettings, ConnectionProfile, EditorDocument, HistoryEntry, LocalTerminalCommand,
        LocalTerminalProfile, LocalTerminalSettings, SshJumpHost, SshProxyConfig, StoredAppSettings,
        StoredConnectionProfile, StoredSshJumpHost, StoredSshProxyConfig, TunnelRecord,
        WebDavSettings,
    },
};

#[derive(Debug, Clone)]
pub struct StorageService {
    data_dir: PathBuf,
}

impl StorageService {
    pub fn new(data_dir: PathBuf) -> Result<Self, AppError> {
        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(data_dir.join("backups"))?;
        fs::create_dir_all(data_dir.join("editor-cache"))?;
        Ok(Self { data_dir })
    }

    pub fn default_data_dir() -> PathBuf {
        // 1) 显式环境变量优先：外部 MCP 客户端拉起 CLI 时用它精确指向数据目录，安装版也可覆盖。
        if let Ok(dir) = std::env::var("MYTERMINAL_DATA_DIR") {
            let trimmed = dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }

        // 2) 开发态保持项目根下的 .myterminal-data，避免打断开发机上已有连接与密钥。
        if cfg!(debug_assertions) {
            return Self::legacy_cwd_data_dir();
        }

        // 3) 安装版使用每用户可写的稳定目录（Windows: %APPDATA%\com.myterminal.app）。
        //    工作目录随快捷方式变化，且 Program Files 通常不可写，必须落到用户数据目录，
        //    这样 discovery 文件路径确定可写，MCP 配置无论从哪启动都一致。
        let stable = Self::platform_data_dir();
        // 首次运行时把旧布局（可执行文件旁 / 当前目录下的 .myterminal-data）迁移过来，保留原目录便于回滚。
        Self::migrate_legacy_data_if_needed(&stable);
        stable
    }

    /// 旧版数据目录：基于当前工作目录（src-tauri 时取父目录）下的 .myterminal-data。
    fn legacy_cwd_data_dir() -> PathBuf {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let base = if cwd.file_name() == Some(OsStr::new("src-tauri")) {
            cwd.parent().map(Path::to_path_buf).unwrap_or(cwd)
        } else {
            cwd
        };
        base.join(".myterminal-data")
    }

    /// 每用户可写的稳定数据目录。Windows 用 %APPDATA%，其它平台回退到 HOME 下的隐藏目录。
    fn platform_data_dir() -> PathBuf {
        // identifier 与 tauri.conf.json 的 com.myterminal.app 保持一致，和 Tauri appDataDir 同址。
        const APP_IDENTIFIER: &str = "com.myterminal.app";
        if cfg!(windows) {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let trimmed = appdata.trim();
                if !trimmed.is_empty() {
                    return PathBuf::from(trimmed).join(APP_IDENTIFIER);
                }
            }
        } else if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join(".local")
                    .join("share")
                    .join(APP_IDENTIFIER);
            }
        }
        // 环境变量缺失时兜底到旧布局，至少保证功能可用。
        Self::legacy_cwd_data_dir()
    }

    /// 若稳定目录尚不存在而旧目录存在，则整目录复制迁移一次；原目录保留不动，便于回滚。
    fn migrate_legacy_data_if_needed(stable: &Path) {
        // 稳定目录已初始化过（存在 master.key）就不再迁移，避免覆盖用户新数据。
        if stable.join("master.key").exists() {
            return;
        }
        // 候选旧目录：当前工作目录布局，以及可执行文件同级 / 上级目录下的 .myterminal-data。
        let mut candidates = vec![Self::legacy_cwd_data_dir()];
        if let Ok(exe) = std::env::current_exe() {
            for ancestor in exe.ancestors() {
                candidates.push(ancestor.join(".myterminal-data"));
            }
        }
        for legacy in candidates {
            if legacy == stable {
                continue;
            }
            // 以 master.key 为准判断是否为有效的旧数据目录。
            if legacy.join("master.key").exists() {
                if copy_dir_recursive(&legacy, stable).is_ok() {
                    return;
                }
            }
        }
    }

    pub fn data_dir_path(&self) -> &Path {
        &self.data_dir
    }

    pub fn key_path(&self) -> PathBuf {
        self.data_dir.join("master.key")
    }

    pub fn settings_file_path(&self) -> PathBuf {
        self.settings_path()
    }

    pub fn connections_file_path(&self) -> PathBuf {
        self.connections_path()
    }

    pub fn history_file_path(&self) -> PathBuf {
        self.history_path()
    }

    pub fn tunnels_file_path(&self) -> PathBuf {
        self.tunnels_path()
    }

    pub fn local_terminals_file_path(&self) -> PathBuf {
        self.local_terminals_path()
    }

    pub fn agent_bridge_secret_path(&self) -> PathBuf {
        self.data_dir.join("agent-bridge-secret.json")
    }

    pub fn agent_bridge_discovery_path(&self) -> PathBuf {
        self.data_dir.join("agent-bridge-discovery.json")
    }

    pub fn downloads_dir_path(&self) -> PathBuf {
        self.data_dir.join("downloads")
    }

    pub fn exports_dir_path(&self) -> PathBuf {
        self.data_dir.join("exports")
    }

    fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    fn connections_path(&self) -> PathBuf {
        self.data_dir.join("connections.json")
    }

    fn history_path(&self) -> PathBuf {
        self.data_dir.join("history.json")
    }

    fn tunnels_path(&self) -> PathBuf {
        self.data_dir.join("tunnels.json")
    }

    fn local_terminals_path(&self) -> PathBuf {
        self.data_dir.join("local-terminals.json")
    }

    fn editor_cache_dir(&self) -> PathBuf {
        self.data_dir.join("editor-cache")
    }

    fn backup_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    fn read_json_or_default<T>(&self, path: &Path) -> Result<T, AppError>
    where
        T: DeserializeOwned + Default,
    {
        if !path.exists() {
            return Ok(T::default());
        }

        let raw = fs::read_to_string(path)?;
        if raw.trim().is_empty() {
            return Ok(T::default());
        }

        Ok(serde_json::from_str(&raw)?)
    }

    fn write_json<T>(&self, path: &Path, value: &T) -> Result<(), AppError>
    where
        T: Serialize,
    {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(value)?)?;
        Ok(())
    }

    pub fn backup_existing_file(&self, source: &Path, label: &str) -> Result<(), AppError> {
        if !source.exists() {
            return Ok(());
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
        let destination = self.backup_dir().join(format!("{label}-{timestamp}.json"));
        fs::copy(source, destination)?;
        Ok(())
    }

    pub fn load_settings(&self, crypto: &CryptoService) -> Result<AppSettings, AppError> {
        let stored =
            self.read_json_or_default::<Option<StoredAppSettings>>(&self.settings_path())?;
        let Some(stored) = stored else {
            return Ok(AppSettings::default());
        };

        Ok(AppSettings {
            ui_language: stored.ui_language,
            theme_mode: stored.theme_mode,
            runtime_refresh_interval_sec: stored.runtime_refresh_interval_sec,
            runtime_storage_refresh_interval_sec: stored.runtime_storage_refresh_interval_sec,
            runtime_resource_refresh_interval_sec: stored.runtime_resource_refresh_interval_sec,
            runtime_resource_source: stored.runtime_resource_source,
            ssh_keepalive_interval_sec: stored.ssh_keepalive_interval_sec,
            shell_latin_font_family: stored.shell_latin_font_family,
            shell_cjk_font_family: stored.shell_cjk_font_family,
            shell_font_family: stored.shell_font_family,
            shell_font_size: stored.shell_font_size,
            terminal_background: stored.terminal_background,
            terminal_foreground: stored.terminal_foreground,
            accent_color: stored.accent_color,
            background_image: stored.background_image,
            terminal_background_image_opacity: stored.terminal_background_image_opacity,
            terminal_background_image_fit: stored.terminal_background_image_fit,
            terminal_right_click_behavior: stored.terminal_right_click_behavior,
            terminal_line_wrap_mode: stored.terminal_line_wrap_mode,
            terminal_match_selection: stored.terminal_match_selection,
            terminal_gutter_show_line_number: stored.terminal_gutter_show_line_number,
            terminal_gutter_show_timestamp: stored.terminal_gutter_show_timestamp,
            compact_sidebar: stored.compact_sidebar,
            show_command_ghost: stored.show_command_ghost,
            hardware_acceleration: stored.hardware_acceleration,
            connection_groups: stored.connection_groups,
            connection_order: stored.connection_order,
            quick_commands: stored.quick_commands,
            // MCP Bridge 开关和自动执行策略都是用户明确保存的本机配置，重启后按原值恢复；
            // 新安装仍使用 AgentBridgeSettings::default() 的关闭状态，不会未经授权自动暴露 Broker。
            agent_bridge: stored.agent_bridge,
            webdav: WebDavSettings {
                base_url: stored.webdav_base_url,
                username: stored.webdav_username,
                password: crypto.decrypt_local(&stored.webdav_password_encrypted)?,
                sync_passphrase: String::new(),
                remote_path: if stored.webdav_remote_path.is_empty()
                    && !stored.webdav_remote_settings_path.is_empty()
                {
                    stored.webdav_remote_settings_path
                } else {
                    stored.webdav_remote_path
                },
                remote_settings_path: String::new(),
                remote_connections_path: String::new(),
            },
        })
    }

    pub fn save_settings(
        &self,
        settings: &AppSettings,
        crypto: &CryptoService,
    ) -> Result<(), AppError> {
        let stored = StoredAppSettings {
            ui_language: settings.ui_language.clone(),
            theme_mode: settings.theme_mode.clone(),
            runtime_refresh_interval_sec: settings.runtime_refresh_interval_sec,
            runtime_storage_refresh_interval_sec: settings.runtime_storage_refresh_interval_sec,
            runtime_resource_refresh_interval_sec: settings.runtime_resource_refresh_interval_sec,
            runtime_resource_source: settings.runtime_resource_source.clone(),
            ssh_keepalive_interval_sec: settings.ssh_keepalive_interval_sec,
            shell_latin_font_family: settings.shell_latin_font_family.clone(),
            shell_cjk_font_family: settings.shell_cjk_font_family.clone(),
            shell_font_family: settings.shell_font_family.clone(),
            shell_font_size: settings.shell_font_size,
            terminal_background: settings.terminal_background.clone(),
            terminal_foreground: settings.terminal_foreground.clone(),
            accent_color: settings.accent_color.clone(),
            background_image: settings.background_image.clone(),
            terminal_background_image_opacity: settings.terminal_background_image_opacity,
            terminal_background_image_fit: settings.terminal_background_image_fit.clone(),
            terminal_right_click_behavior: settings.terminal_right_click_behavior.clone(),
            terminal_line_wrap_mode: settings.terminal_line_wrap_mode.clone(),
            terminal_match_selection: settings.terminal_match_selection,
            terminal_gutter_show_line_number: settings.terminal_gutter_show_line_number,
            terminal_gutter_show_timestamp: settings.terminal_gutter_show_timestamp,
            compact_sidebar: settings.compact_sidebar,
            show_command_ghost: settings.show_command_ghost,
            hardware_acceleration: settings.hardware_acceleration,
            connection_groups: settings.connection_groups.clone(),
            connection_order: settings.connection_order.clone(),
            quick_commands: settings.quick_commands.clone(),
            agent_bridge: settings.agent_bridge.clone(),
            webdav_base_url: settings.webdav.base_url.clone(),
            webdav_username: settings.webdav.username.clone(),
            webdav_password_encrypted: crypto.encrypt_local(&settings.webdav.password)?,
            webdav_remote_path: settings.webdav.remote_path.clone(),
            webdav_remote_settings_path: String::new(),
            webdav_remote_connections_path: String::new(),
        };
        self.write_json(&self.settings_path(), &stored)
    }

    pub fn load_connections(
        &self,
        crypto: &CryptoService,
    ) -> Result<Vec<ConnectionProfile>, AppError> {
        let stored =
            self.read_json_or_default::<Vec<StoredConnectionProfile>>(&self.connections_path())?;
        stored
            .into_iter()
            .map(|item| {
                let private_key_text = crypto.decrypt_local(&item.private_key_text_encrypted)?;
                let passphrase = crypto.decrypt_local(&item.passphrase_encrypted)?;
                let jump_hosts = item
                    .jump_hosts
                    .into_iter()
                    .map(|jump_host| {
                        let private_key_text =
                            crypto.decrypt_local(&jump_host.private_key_text_encrypted)?;
                        let passphrase = crypto.decrypt_local(&jump_host.passphrase_encrypted)?;
                        Ok(SshJumpHost {
                            id: jump_host.id,
                            name: jump_host.name,
                            host: jump_host.host,
                            port: jump_host.port,
                            username: jump_host.username,
                            auth_method: jump_host.auth_method,
                            password: crypto.decrypt_local(&jump_host.password_encrypted)?,
                            private_key_path: jump_host.private_key_path,
                            private_key_text: (!private_key_text.is_empty()).then_some(private_key_text),
                            passphrase: (!passphrase.is_empty()).then_some(passphrase),
                        })
                    })
                    .collect::<Result<Vec<_>, AppError>>()?;
                let proxy_password = crypto.decrypt_local(&item.proxy.password_encrypted)?;
                Ok(ConnectionProfile {
                    id: item.id,
                    name: item.name,
                    group_path: item.group_path,
                    host: item.host,
                    port: item.port,
                    username: item.username,
                    auth_method: item.auth_method,
                    password: crypto.decrypt_local(&item.password_encrypted)?,
                    private_key_path: item.private_key_path,
                    private_key_text: (!private_key_text.is_empty()).then_some(private_key_text),
                    passphrase: (!passphrase.is_empty()).then_some(passphrase),
                    jump_hosts,
                    proxy: SshProxyConfig {
                        enabled: item.proxy.enabled,
                        proxy_type: item.proxy.proxy_type,
                        host: item.proxy.host,
                        port: item.proxy.port,
                        username: item.proxy.username,
                        password: (!proxy_password.is_empty()).then_some(proxy_password),
                    },
                    note: item.note,
                    tags: item.tags,
                })
            })
            .collect()
    }

    pub fn save_connections(
        &self,
        connections: &[ConnectionProfile],
        crypto: &CryptoService,
    ) -> Result<(), AppError> {
        let stored: Result<Vec<_>, AppError> = connections
            .iter()
            .map(|item| {
                let jump_hosts: Result<Vec<_>, AppError> = item
                    .jump_hosts
                    .iter()
                    .map(|jump_host| {
                        Ok(StoredSshJumpHost {
                            id: jump_host.id.clone(),
                            name: jump_host.name.clone(),
                            host: jump_host.host.clone(),
                            port: jump_host.port,
                            username: jump_host.username.clone(),
                            auth_method: jump_host.auth_method.clone(),
                            password_encrypted: crypto.encrypt_local(&jump_host.password)?,
                            private_key_path: jump_host.private_key_path.clone(),
                            private_key_text_encrypted: crypto
                                .encrypt_local(jump_host.private_key_text.as_deref().unwrap_or(""))?,
                            passphrase_encrypted: crypto
                                .encrypt_local(jump_host.passphrase.as_deref().unwrap_or(""))?,
                        })
                    })
                    .collect();
                Ok(StoredConnectionProfile {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    group_path: item.group_path.clone(),
                    host: item.host.clone(),
                    port: item.port,
                    username: item.username.clone(),
                    auth_method: item.auth_method.clone(),
                    password_encrypted: crypto.encrypt_local(&item.password)?,
                    private_key_path: item.private_key_path.clone(),
                    private_key_text_encrypted: crypto
                        .encrypt_local(item.private_key_text.as_deref().unwrap_or(""))?,
                    passphrase_encrypted: crypto
                        .encrypt_local(item.passphrase.as_deref().unwrap_or(""))?,
                    jump_hosts: jump_hosts?,
                    proxy: StoredSshProxyConfig {
                        enabled: item.proxy.enabled,
                        proxy_type: item.proxy.proxy_type.clone(),
                        host: item.proxy.host.clone(),
                        port: item.proxy.port,
                        username: item.proxy.username.clone(),
                        password_encrypted: crypto.encrypt_local(item.proxy.password.as_deref().unwrap_or(""))?,
                    },
                    note: item.note.clone(),
                    tags: item.tags.clone(),
                })
            })
            .collect();
        self.write_json(&self.connections_path(), &stored?)
    }

    pub fn load_history(&self) -> Result<Vec<HistoryEntry>, AppError> {
        self.read_json_or_default(&self.history_path())
    }

    pub fn save_history(&self, history: &[HistoryEntry]) -> Result<(), AppError> {
        self.write_json(&self.history_path(), &history)
    }

    pub fn load_tunnels(&self) -> Result<Vec<TunnelRecord>, AppError> {
        self.read_json_or_default(&self.tunnels_path())
    }

    pub fn save_tunnels(&self, tunnels: &[TunnelRecord]) -> Result<(), AppError> {
        self.write_json(&self.tunnels_path(), &tunnels)
    }

    pub fn load_local_terminals(&self) -> Result<LocalTerminalSettings, AppError> {
        let stored = self.read_json_or_default::<LocalTerminalSettings>(&self.local_terminals_path())?;
        Ok(normalize_local_terminal_settings(stored))
    }

    pub fn save_local_terminals(&self, settings: &LocalTerminalSettings) -> Result<(), AppError> {
        let normalized = normalize_local_terminal_settings(settings.clone());
        self.write_json(&self.local_terminals_path(), &normalized)
    }

    fn editor_cache_path(&self, connection_id: &str, remote_path: &str) -> PathBuf {
        let digest = Sha256::digest(format!("{connection_id}:{remote_path}").as_bytes());
        let hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.editor_cache_dir().join(format!("{hex}.json"))
    }

    pub fn load_editor_cache(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<Option<EditorDocument>, AppError> {
        let path = self.editor_cache_path(connection_id, remote_path);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(self.read_json_or_default::<EditorDocument>(&path)?))
    }

    pub fn save_editor_cache(&self, document: &EditorDocument) -> Result<(), AppError> {
        let path = self.editor_cache_path(&document.connection_id, &document.path);
        self.write_json(&path, document)
    }
}

/// 递归复制目录内容，用于把旧数据目录整体迁移到新的稳定目录。
/// 目标已存在的同名文件不覆盖，保证迁移幂等且不会破坏用户在新目录里的改动。
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn normalize_local_terminal_settings(settings: LocalTerminalSettings) -> LocalTerminalSettings {
    let mut command_ids = std::collections::HashSet::new();
    let mut commands = Vec::<LocalTerminalCommand>::new();

    // 内置命令只强制补齐“本地终端”（id == "shell"），其余内置项如被用户删除则不予补回。
    let default_cmds = vec![
        LocalTerminalCommand {
            id: "shell".into(),
            name: "本地终端".into(),
            command: String::new(),
            built_in: true,
        }
    ];
    for command in settings.commands.into_iter().chain(default_cmds) {
        let name = command.name.trim();
        let command_text = command.command.trim();
        if name.is_empty() || (!command.built_in && command_text.is_empty()) {
            continue;
        }
        let id = if command.id.trim().is_empty() {
            if command_text.is_empty() {
                "shell".into()
            } else {
                command_text.to_string()
            }
        } else {
            command.id.trim().to_string()
        };
        if command_ids.insert(id.clone()) {
            commands.push(LocalTerminalCommand {
                id,
                name: name.to_string(),
                command: command_text.to_string(),
                built_in: command.built_in,
            });
        }
    }

    let mut profile_ids = std::collections::HashSet::new();
    let profiles = settings
        .profiles
        .into_iter()
        .filter_map(|profile| {
            let cwd = profile.cwd.trim();
            let command = profile.command.trim();
            if cwd.is_empty() {
                return None;
            }
            let id = if profile.id.trim().is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                profile.id.trim().to_string()
            };
            if !profile_ids.insert(id.clone()) {
                return None;
            }
            let title = profile.title.trim();
            Some(LocalTerminalProfile {
                id,
                title: if title.is_empty() {
                    if command.is_empty() {
                        cwd.to_string()
                    } else {
                        format!("{command} · {cwd}")
                    }
                } else {
                    title.to_string()
                },
                cwd: cwd.to_string(),
                command: command.to_string(),
                last_used_at: profile.last_used_at,
            })
        })
        .collect();

    LocalTerminalSettings {
        shell_path: settings.shell_path.trim().to_string(),
        commands,
        profiles,
    }
}
