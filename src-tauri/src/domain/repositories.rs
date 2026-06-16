use crate::{
    domain::entities::{AppSettings, ConnectionProfile, HistoryEntry, TunnelRecord},
    error::AppError,
    infrastructure::crypto::CryptoService,
};

/// Settings 仓储接口
pub trait SettingsRepository {
    fn load_settings(&self, crypto: &CryptoService) -> Result<AppSettings, AppError>;
    fn save_settings(&self, settings: &AppSettings, crypto: &CryptoService)
        -> Result<(), AppError>;
}

/// Connection 仓储接口
pub trait ConnectionRepository {
    fn load_connections(&self, crypto: &CryptoService) -> Result<Vec<ConnectionProfile>, AppError>;
    fn save_connections(
        &self,
        connections: &[ConnectionProfile],
        crypto: &CryptoService,
    ) -> Result<(), AppError>;
}

/// History 仓储接口
pub trait HistoryRepository {
    fn load_history(&self) -> Result<Vec<HistoryEntry>, AppError>;
    fn save_history(&self, history: &[HistoryEntry]) -> Result<(), AppError>;
}

/// Tunnel 仓储接口
pub trait TunnelRepository {
    fn load_tunnels(&self) -> Result<Vec<TunnelRecord>, AppError>;
    fn save_tunnels(&self, tunnels: &[TunnelRecord]) -> Result<(), AppError>;
}
