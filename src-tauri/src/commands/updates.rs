//! 应用更新、远程背景资源与系统外链适配器。

use std::{
    env, fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{error::AppError, models::UpdateCheckResult};

#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

// 更新检查和安装包下载要快速失败，避免 GitHub 直连或代理异常时设置页长时间停在处理中。
const UPDATE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
// 增加更新包数据读取的超时时间，提升慢速网络环境下的连接稳定性
const UPDATE_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(40);
// 极大调高下载超时上限至 600 秒（10分钟），确保在慢速网络下也能完整下载安装包
const UPDATE_INSTALLER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "myterminal-update-download-progress";
const UPDATE_DOWNLOAD_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u32>,
}

fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let normalized = version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V');
    let core = normalized.split(['-', '+']).next().unwrap_or(normalized);
    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() {
            return None;
        }
        parts.push(segment.parse::<u64>().ok()?);
    }
    Some(parts)
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    // GitHub tag 只做保守语义版本比较；遇到非数字标签不提示更新，避免误报。
    let Some(mut latest_parts) = parse_version_parts(latest) else {
        return false;
    };
    let Some(mut current_parts) = parse_version_parts(current) else {
        return false;
    };

    let len = latest_parts.len().max(current_parts.len());
    latest_parts.resize(len, 0);
    current_parts.resize(len, 0);
    latest_parts > current_parts
}

fn installer_asset_score(asset_name: &str) -> i32 {
    let normalized = asset_name.to_ascii_lowercase();
    if !(normalized.ends_with(".exe") || normalized.ends_with(".msi")) {
        return -1;
    }

    let mut score = 10;
    if normalized.ends_with(".exe") {
        score += 8;
    }
    if normalized.contains("setup") || normalized.contains("installer") {
        score += 6;
    }
    if normalized.contains("windows")
        || normalized.contains("win")
        || normalized.contains("pc-windows")
    {
        score += 5;
    }
    if normalized.contains("x64") || normalized.contains("amd64") {
        score += 3;
    }
    if normalized.contains("nsis") {
        score += 2;
    }
    if normalized.ends_with(".msi") {
        score += 1;
    }
    score
}

fn select_update_installer_asset(assets: &[GitHubReleaseAsset]) -> Option<GitHubReleaseAsset> {
    // Release 里可能同时包含校验文件、压缩包和安装器，这里优先选择 Windows 可直接启动的安装包。
    assets
        .iter()
        .filter_map(|asset| {
            let score = installer_asset_score(&asset.name);
            (score >= 0).then_some((score, asset))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset.clone())
}

fn sanitize_asset_file_name(asset_name: &str) -> String {
    let sanitized: String = asset_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        "MyTerminal-update.exe".into()
    } else {
        sanitized
    }
}

fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    (normalized.starts_with("https://") || normalized.starts_with("http://"))
        && (normalized.ends_with(".exe") || normalized.ends_with(".msi"))
        && !normalized.chars().any(|character| character.is_control())
}

pub(super) fn build_update_http_client(total_timeout: Duration) -> Result<reqwest::Client, AppError> {
    // 更新相关请求必须尊重系统代理；Cargo 特性启用后，默认 Client 会读取 Windows 代理和代理环境变量。
    reqwest::Client::builder()
        .connect_timeout(UPDATE_HTTP_CONNECT_TIMEOUT)
        .read_timeout(UPDATE_HTTP_READ_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(AppError::from)
}

// 直连客户端：忽略系统代理。代理节点的数据中心 IP 常被 GitHub API 风控（403），
// 更新请求在代理失败时回退直连重试，避免把代理服务器的拒绝误报成 GitHub 限流。
pub(super) fn build_direct_http_client(total_timeout: Duration) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(UPDATE_HTTP_CONNECT_TIMEOUT)
        .read_timeout(UPDATE_HTTP_READ_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(AppError::from)
}

fn installer_path_matches_expected_size(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<bool, AppError> {
    // Release 元数据有文件大小时必须严格匹配，避免复用之前中断留下的半截安装包。
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::from(error)),
    };
    if !metadata.is_file() {
        return Ok(false);
    }

    // 少数 Release 可能缺少 size 字段；此时只复用非空文件，仍避免 0 字节缓存导致安装失败。
    Ok(expected_size
        .map(|size| metadata.len() == size)
        .unwrap_or(metadata.len() > 0))
}

async fn download_update_installer(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    download_url: &str,
    installer_path: &Path,
    expected_size: Option<u64>,
) -> Result<(), AppError> {
    // 临时文件完整落盘后才替换正式安装包，避免下载中断时污染下次可复用的缓存。
    let temp_installer_path = installer_path.with_extension(format!(
        "{}.download",
        installer_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("tmp")
    ));
    match fs::remove_file(&temp_installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::from(error)),
    }

    let mut response = client
        .get(download_url)
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(AppError::from)?
        .error_for_status()
        .map_err(AppError::from)?;
    let mut temp_file = fs::File::create(&temp_installer_path).map_err(AppError::from)?;
    let mut downloaded_size = 0_u64;
    let mut last_progress_emit = Instant::now();

    while let Some(chunk) = response.chunk().await.map_err(AppError::from)? {
        // 下载过程中持续校验大小上界，防止错误地址返回 HTML 或其它大文件时继续写入。
        downloaded_size += chunk.len() as u64;
        if expected_size.is_some_and(|size| downloaded_size > size) {
            return Err(AppError::Validation(
                "downloaded update installer is larger than expected".into(),
            ));
        }
        temp_file.write_all(&chunk).map_err(AppError::from)?;

        // 按固定间隔向前端推送下载进度，避免高频 chunk 事件占用过多通信带宽。
        if last_progress_emit.elapsed() >= UPDATE_DOWNLOAD_PROGRESS_THROTTLE {
            let percent = expected_size.map(|size| {
                ((downloaded_size as f64 / size as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            });
            let _ = app_handle.emit(
                UPDATE_DOWNLOAD_PROGRESS_EVENT,
                &UpdateDownloadProgressEvent {
                    downloaded_bytes: downloaded_size,
                    total_bytes: expected_size,
                    percent,
                },
            );
            last_progress_emit = Instant::now();
        }
    }
    temp_file.flush().map_err(AppError::from)?;
    drop(temp_file);

    // 下载结束时再推送一次完整进度，让前端进度条到达 100%。
    let _ = app_handle.emit(
        UPDATE_DOWNLOAD_PROGRESS_EVENT,
        &UpdateDownloadProgressEvent {
            downloaded_bytes: downloaded_size,
            total_bytes: expected_size,
            percent: expected_size.map(|size| {
                ((downloaded_size as f64 / size as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            }),
        },
    );

    // 下载结束后再次校验精确大小，确保启动安装器前拿到的是完整 Release 资产。
    if expected_size.is_some_and(|size| downloaded_size != size) {
        return Err(AppError::Validation(
            "downloaded update installer size does not match release metadata".into(),
        ));
    }
    if downloaded_size == 0 {
        return Err(AppError::Validation(
            "downloaded update installer is empty".into(),
        ));
    }

    match fs::remove_file(installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::from(error)),
    }
    fs::rename(&temp_installer_path, installer_path).map_err(AppError::from)?;
    Ok(())
}

fn spawn_update_installer(path: &Path) -> std::io::Result<()> {
    // Windows MSI 需要交给 msiexec 启动；EXE 安装包则直接执行，避免检测到更新后按钮无响应。
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

    // 验证进程是否成功启动（等待 100ms 检查是否立即退出）
    std::thread::sleep(std::time::Duration::from_millis(100));
    match child.try_wait()? {
        Some(status) if !status.success() => Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("安装器启动失败，退出码：{}", status.code().unwrap_or(-1)),
        )),
        _ => Ok(()),
    }
}

// 远程背景图最大下载体积，避免误填超大文件或非图片资源撑爆内存与 data URL。
const REMOTE_BACKGROUND_IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;

#[tauri::command]
pub async fn fetch_remote_background_image(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    // 只处理 http(s) 远程地址；本地路径、data:、asset: 等由前端自行渲染，不该进后端下载。
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("仅支持 http(s) 远程图片地址".to_string());
    }

    // 走后端 reqwest 下载可绕开 WebView 自动附带的 tauri.localhost Referer，避免被图床防盗链拦截返回 403。
    let client = build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?;
    let response = client
        .get(trimmed)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .send()
        .await
        .map_err(|err| format!("背景图下载失败，请检查网络或链接是否有效。错误原因: {err}"))?;

    let response = response
        .error_for_status()
        .map_err(|err| format!("背景图请求返回错误状态: {err}"))?;

    // 响应头 Content-Type 仅作兜底：部分图床(如 haowallpaper)声称 jpeg 实际却是 webp，data URL 的 MIME 与真实字节不符时浏览器会拒绝渲染。
    let header_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| value.starts_with("image/"));

    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("背景图数据读取失败: {err}"))?;

    if bytes.is_empty() {
        return Err("背景图内容为空".to_string());
    }
    if bytes.len() > REMOTE_BACKGROUND_IMAGE_MAX_BYTES {
        return Err("背景图体积过大，请更换更小的图片".to_string());
    }

    // 以真实字节的魔术数字识别图片类型，避免服务器 Content-Type 与内容不符导致 data URL 无法渲染。
    let content_type = detect_image_mime(&bytes)
        .map(|mime| mime.to_string())
        .or(header_content_type)
        .unwrap_or_else(|| "image/jpeg".to_string());

    // 转成 data URL 返回；CSP 已允许 img-src data:，前端可直接用作 background-image。
    let encoded = STANDARD.encode(&bytes);
    Ok(format!("data:{content_type};base64,{encoded}"))
}

// 通过文件头魔术字节判断常见图片格式，返回标准 MIME；识别不出时返回 None 交由调用方兜底。
fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    // JPEG: FF D8 FF
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    // GIF: "GIF8"
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    // WebP: "RIFF"...."WEBP"
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // BMP: "BM"
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

// 请求 GitHub 最新 Release 元数据；use_system_proxy 决定是否读取 Windows 系统代理。
// 网络错误（代理不可达等）与 403（代理节点被风控）均由调用方决定是否回退直连重试。
async fn fetch_latest_release(use_system_proxy: bool) -> Result<reqwest::Response, String> {
    let client = if use_system_proxy {
        build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    } else {
        build_direct_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    };
    // GitHub API 要求明确 User-Agent；这里仅读取最新 Release 元数据，并挑出后续可安装的 Windows 安装包。
    // 错误统一以 "update_error:{code}:{params}" 返回，由前端按界面语言翻译成完整文案，避免中英混杂。
    client
        .get("https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest")
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(|err| format!("update_error:network:{err}"))
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    // 更新提示返回给前端的 Release 页面地址，必须和 GitHub 仓库名保持一致。
    let release_url = "https://github.com/CrazyFigure/MyTerminal/releases/latest".to_string();

    // 首次请求走系统代理（用户代理软件常见）；代理节点 IP 常被 GitHub API 风控返回 403，
    // 或代理不可达导致网络错误，两种情况都回退直连重试一次，避免误报限流或网络故障。
    let mut response = match fetch_latest_release(true).await {
        Ok(response) => response,
        Err(_) => fetch_latest_release(false).await?,
    };
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        response = fetch_latest_release(false).await?;
    }

    // 403 需区分两种情况：响应头 X-RateLimit-Remaining 为 0 才确认是 API 配额耗尽；
    // 否则（或该头缺失）多为代理或安全策略拦截，不应误报成限流。
    // 错误统一以 "update_error:{code}:{params}" 返回，由前端按界面语言翻译成完整文案。
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        let rate_limited = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            == Some(0);
        if rate_limited {
            // 配额确认耗尽：附上配额重置时间戳（Unix 秒），由前端按当前语言格式化为可读时间。
            let reset_ts = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.parse::<i64>().is_ok())
                .unwrap_or_default();
            return Err(if reset_ts.is_empty() {
                "update_error:rate_limited".to_string()
            } else {
                format!("update_error:rate_limited:{reset_ts}")
            });
        }
        return Err("update_error:forbidden".to_string());
    }

    let release = response
        .error_for_status()
        .map_err(|err| format!("update_error:http_status:{err}"))?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|err| format!("update_error:parse:{err}"))?;

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer_version(&release.tag_name, &current_version);
    let installer_asset = select_update_installer_asset(&release.assets);
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
        release_body: release.body,
    })
}

#[tauri::command]
pub async fn download_and_install_update(
    app_handle: AppHandle,
    download_url: String,
    asset_name: String,
    installer_size: Option<u64>,
) -> Result<String, String> {
    let normalized_url = download_url.trim();
    if !is_valid_update_download_url(normalized_url) {
        return Err(AppError::Validation("invalid update installer URL".into()).into());
    }

    let safe_file_name = sanitize_asset_file_name(&asset_name);
    let update_dir = env::temp_dir().join("MyTerminal-updates");
    fs::create_dir_all(&update_dir).map_err(|error| AppError::from(error).to_string())?;
    let installer_path: PathBuf = update_dir.join(safe_file_name);

    // 本地已有完整安装包时直接启动，避免用户重复点击时再次等待 GitHub 下载。
    if installer_path_matches_expected_size(&installer_path, installer_size)? {
        spawn_update_installer(&installer_path)
            .map_err(|error| AppError::from(error).to_string())?;
        return Ok(installer_path.to_string_lossy().to_string());
    }

    // 安装包下载使用 GitHub Release 浏览器下载地址；完成写入后立即启动安装程序，交互式确认交给安装器自身处理。
    // 首次走系统代理，若被代理节点风控返回 403，回退直连重试一次（与检测更新的策略保持一致）。
    let client = build_update_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
    if let Err(error) = download_update_installer(
        &app_handle,
        &client,
        normalized_url,
        &installer_path,
        installer_size,
    )
    .await
    {
        if error.to_string().contains("403") {
            let direct_client = build_direct_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
            download_update_installer(
                &app_handle,
                &direct_client,
                normalized_url,
                &installer_path,
                installer_size,
            )
            .await?;
        } else {
            return Err(error.to_string());
        }
    }
    spawn_update_installer(&installer_path).map_err(|error| AppError::from(error).to_string())?;
    Ok(installer_path.to_string_lossy().to_string())
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

#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
    let normalized = url.trim();
    if !(normalized.starts_with("https://") || normalized.starts_with("http://")) {
        return Err(AppError::Validation("only http/https links can be opened".into()).into());
    }
    if normalized.chars().any(|character| character.is_control()) {
        return Err(AppError::Validation("link contains invalid control characters".into()).into());
    }

    // 外部链接只允许交给系统默认浏览器处理，不在 WebView 内弹新窗口，避免按钮点击无反馈。
    spawn_system_url_opener(normalized).map_err(|error| AppError::from(error).to_string())?;
    Ok(true)
}
