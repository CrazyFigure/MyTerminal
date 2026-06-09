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
        AppSettings, ConnectionProfile, EditorDocument, HistoryEntry, StoredAppSettings,
        StoredConnectionProfile, TunnelRecord, WebDavSettings,
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
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let base = if cwd.file_name() == Some(OsStr::new("src-tauri")) {
            cwd.parent().map(Path::to_path_buf).unwrap_or(cwd)
        } else {
            cwd
        };
        base.join(".myterminal-data")
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
        let stored = self.read_json_or_default::<Option<StoredAppSettings>>(&self.settings_path())?;
        let Some(stored) = stored else {
            return Ok(AppSettings::default());
        };

        Ok(AppSettings {
            ui_language: stored.ui_language,
            theme_mode: stored.theme_mode,
            runtime_refresh_interval_sec: stored.runtime_refresh_interval_sec,
            shell_font_family: stored.shell_font_family,
            shell_font_size: stored.shell_font_size,
            terminal_background: stored.terminal_background,
            terminal_foreground: stored.terminal_foreground,
            accent_color: stored.accent_color,
            background_image: stored.background_image,
            compact_sidebar: stored.compact_sidebar,
            show_command_ghost: stored.show_command_ghost,
            connection_groups: stored.connection_groups,
            connection_order: stored.connection_order,
            quick_commands: stored.quick_commands,
            webdav: WebDavSettings {
                base_url: stored.webdav_base_url,
                username: stored.webdav_username,
                password: crypto.decrypt_local(&stored.webdav_password_encrypted)?,
                remote_settings_path: stored.webdav_remote_settings_path,
                remote_connections_path: stored.webdav_remote_connections_path,
            },
        })
    }

    pub fn save_settings(&self, settings: &AppSettings, crypto: &CryptoService) -> Result<(), AppError> {
        let stored = StoredAppSettings {
            ui_language: settings.ui_language.clone(),
            theme_mode: settings.theme_mode.clone(),
            runtime_refresh_interval_sec: settings.runtime_refresh_interval_sec,
            shell_font_family: settings.shell_font_family.clone(),
            shell_font_size: settings.shell_font_size,
            terminal_background: settings.terminal_background.clone(),
            terminal_foreground: settings.terminal_foreground.clone(),
            accent_color: settings.accent_color.clone(),
            background_image: settings.background_image.clone(),
            compact_sidebar: settings.compact_sidebar,
            show_command_ghost: settings.show_command_ghost,
            connection_groups: settings.connection_groups.clone(),
            connection_order: settings.connection_order.clone(),
            quick_commands: settings.quick_commands.clone(),
            webdav_base_url: settings.webdav.base_url.clone(),
            webdav_username: settings.webdav.username.clone(),
            webdav_password_encrypted: crypto.encrypt_local(&settings.webdav.password)?,
            webdav_remote_settings_path: settings.webdav.remote_settings_path.clone(),
            webdav_remote_connections_path: settings.webdav.remote_connections_path.clone(),
        };
        self.write_json(&self.settings_path(), &stored)
    }

    pub fn load_connections(&self, crypto: &CryptoService) -> Result<Vec<ConnectionProfile>, AppError> {
        let stored = self.read_json_or_default::<Vec<StoredConnectionProfile>>(&self.connections_path())?;
        stored
            .into_iter()
            .map(|item| {
                let private_key_text = crypto.decrypt_local(&item.private_key_text_encrypted)?;
                let passphrase = crypto.decrypt_local(&item.passphrase_encrypted)?;
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
                    note: item.note,
                    tags: item.tags,
                })
            })
            .collect()
    }

    pub fn save_connections(&self, connections: &[ConnectionProfile], crypto: &CryptoService) -> Result<(), AppError> {
        let stored: Result<Vec<_>, AppError> = connections
            .iter()
            .map(|item| {
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
                    private_key_text_encrypted: crypto.encrypt_local(item.private_key_text.as_deref().unwrap_or(""))?,
                    passphrase_encrypted: crypto.encrypt_local(item.passphrase.as_deref().unwrap_or(""))?,
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

    fn editor_cache_path(&self, connection_id: &str, remote_path: &str) -> PathBuf {
        let digest = Sha256::digest(format!("{connection_id}:{remote_path}").as_bytes());
        let hex = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        self.editor_cache_dir().join(format!("{hex}.json"))
    }

    pub fn load_editor_cache(&self, connection_id: &str, remote_path: &str) -> Result<Option<EditorDocument>, AppError> {
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
