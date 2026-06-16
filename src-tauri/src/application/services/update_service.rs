use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use crate::domain::entities::UpdateCheckResult;
use crate::domain::services::{self, GitHubReleaseAsset};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[cfg(target_os = "windows")]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("explorer.exe").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

fn spawn_update_installer(path: &Path) -> std::io::Result<()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut child = if extension == "msi" {
        Command::new("msiexec.exe").arg("/i").arg(path).spawn()?
    } else if extension == "exe" {
        Command::new(path).spawn()?
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不支持的安装包格式",
        ));
    };

    std::thread::sleep(std::time::Duration::from_millis(100));
    match child.try_wait()? {
        Some(status) if !status.success() => Err(std::io::Error::other(format!(
            "安装器启动失败，退出码：{}",
            status.code().unwrap_or(-1)
        ))),
        _ => Ok(()),
    }
}

/// Check for newer versions on GitHub.
pub async fn check_for_updates() -> Result<UpdateCheckResult, AppError> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release_url = "https://github.com/CrazyFigure/MyTerminal/releases/latest".to_string();
    let client = reqwest::Client::new();
    let release = client
        .get("https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest")
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(AppError::from)?
        .error_for_status()
        .map_err(AppError::from)?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(AppError::from)?;

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = services::is_newer_version(&release.tag_name, &current_version);
    let installer_asset = services::select_update_installer_asset(&release.assets);
    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        release_name: release.name,
        release_url: if release.html_url.is_empty() {
            release_url
        } else {
            release.html_url
        },
        published_at: release.published_at,
        update_available,
        installer_asset_name: installer_asset.as_ref().map(|asset| asset.name.clone()),
        installer_download_url: installer_asset
            .as_ref()
            .map(|asset| asset.browser_download_url.clone()),
        installer_size: installer_asset.and_then(|asset| asset.size),
    })
}

/// Download a new version installer and launch it.
pub async fn download_and_install_update(
    download_url: String,
    asset_name: String,
) -> Result<String, AppError> {
    let normalized_url = download_url.trim();
    if !services::is_valid_update_download_url(normalized_url) {
        return Err(AppError::Validation("invalid update installer URL".into()));
    }

    let safe_file_name = services::sanitize_asset_file_name(&asset_name);
    let update_dir = env::temp_dir().join("MyTerminal-updates");
    fs::create_dir_all(&update_dir)?;
    let installer_path: PathBuf = update_dir.join(safe_file_name);

    let client = reqwest::Client::new();
    let bytes = client
        .get(normalized_url)
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(AppError::from)?
        .error_for_status()
        .map_err(AppError::from)?
        .bytes()
        .await
        .map_err(AppError::from)?;

    fs::write(&installer_path, &bytes)?;
    spawn_update_installer(&installer_path).map_err(AppError::Io)?;
    Ok(installer_path.to_string_lossy().to_string())
}

/// Open an external URL in the system default browser.
pub fn open_external_url(url: String) -> Result<bool, AppError> {
    let normalized = url.trim();
    if !(normalized.starts_with("https://") || normalized.starts_with("http://")) {
        return Err(AppError::Validation(
            "only http/https links can be opened".into(),
        ));
    }
    if normalized.chars().any(|character| character.is_control()) {
        return Err(AppError::Validation(
            "link contains invalid control characters".into(),
        ));
    }

    spawn_system_url_opener(normalized).map_err(AppError::Io)?;
    Ok(true)
}
