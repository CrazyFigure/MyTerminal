//! Windows 安装版的一键更新，沿用官方 Release 渠道与现有 NSIS 安装器。

use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use tauri::{async_runtime, AppHandle, Manager, State, WebviewWindow};

use super::{
    download_installer_with_fallback, fetch_release_response, GitHubReleaseAsset,
    GitHubReleaseResponse,
};
use crate::{commands::shutdown_app_backends, models::UpdateChannel, state::AppState};

// 发布流水线只把公钥编译进客户端；缺少公钥的构建仍可手动从 Release 页升级。
const PUBLIC_KEY: Option<&str> = option_env!("MYTERMINAL_UPDATE_PUBLIC_KEY");
const MAX_SIGNATURE_BYTES: usize = 4096;
const INSTALLER_PREFIX: &str = "MyTerminal_";
const INSTALLER_SUFFIX: &str = "_windows_x64-setup.exe";

struct PreparedUpdate {
    id: String,
    path: PathBuf,
    signature: Signature,
    channel: UpdateChannel,
}

/// 单实例内串行下载与安装。准备结果只由 Rust 保存，前端只持有会话内 ID。
#[derive(Default)]
pub struct UpdateInstallerState(async_runtime::Mutex<Option<PreparedUpdate>>);

/// 版本固定为三段正式版本号，避免预发布、路径片段或同版本覆盖进入安装链路。
fn stable_version(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let mut next = || {
        let part = parts.next()?;
        let number = part.parse::<u64>().ok()?;
        (part == number.to_string()).then_some(number)
    };
    let version = [next()?, next()?, next()?];
    parts.next().is_none().then_some(version)
}

fn installer_name(version: &str) -> Option<String> {
    let current = stable_version(env!("CARGO_PKG_VERSION"))?;
    (stable_version(version)? > current)
        .then(|| format!("{INSTALLER_PREFIX}{version}{INSTALLER_SUFFIX}"))
}

/// 只在已安装的官方 x64 发行版运行覆盖安装，避免开发进程误装到正式版目录。
fn installed_directory() -> Option<PathBuf> {
    if cfg!(debug_assertions) || std::env::consts::ARCH != "x86_64" {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    directory
        .join("uninstall.exe")
        .is_file()
        .then(|| directory.to_path_buf())
}

fn decode_signed_text(encoded: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|error| error.to_string())?;
    String::from_utf8(decoded).map_err(|error| error.to_string())
}

fn signing_key() -> Result<PublicKey, String> {
    let encoded = PUBLIC_KEY
        .filter(|key| !key.trim().is_empty())
        .ok_or("update_install:unavailable")?;
    PublicKey::decode(&decode_signed_text(encoded)?).map_err(|error| error.to_string())
}

/// 发布列表要求对应架构的 NSIS 包和签名均已上传，其他附件保留手动下载入口。
pub(super) fn signed_release_asset(release: &GitHubReleaseResponse) -> Option<GitHubReleaseAsset> {
    installed_directory()?;
    signing_key().ok()?;
    let name = installer_name(release.tag_name.strip_prefix('v')?)?;
    let signature_name = format!("{name}.sig");
    let uploaded = |asset: &&GitHubReleaseAsset| {
        asset
            .state
            .as_deref()
            .is_none_or(|state| state == "uploaded")
    };
    if !release
        .assets
        .iter()
        .filter(uploaded)
        .any(|asset| asset.name == signature_name)
    {
        return None;
    }
    release
        .assets
        .iter()
        .filter(uploaded)
        .find(|asset| asset.name == name)
        .cloned()
}

/// 信任 Tauri 签名中的完整文件名，防止用旧版签名安装器冒充用户选中的新版本。
fn verify_installer(
    path: &Path,
    name: &str,
    key: &PublicKey,
    signature: &Signature,
) -> Result<(), String> {
    let signed_name = format!("file:{name}");
    if !signature
        .trusted_comment()
        .split('\t')
        .any(|part| part == signed_name)
    {
        return Err("update_install:invalid_signature".into());
    }
    let verify = || -> Result<(), Box<dyn std::error::Error>> {
        let mut file = BufReader::new(fs::File::open(path)?);
        let mut verifier = key.verify_stream(signature)?;
        loop {
            let bytes = file.fill_buf()?;
            if bytes.is_empty() {
                break;
            }
            verifier.update(bytes);
            let read = bytes.len();
            file.consume(read);
        }
        verifier.finalize()?;
        Ok(())
    };
    verify().map_err(|_| "update_install:invalid_signature".into())
}

/// 签名沿用 Release 网络回退策略，并限制签名响应大小。
async fn fetch_signature(url: &str) -> Result<Signature, String> {
    let mut response = fetch_release_response(url).await?;
    let mut encoded = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if encoded.len() + chunk.len() > MAX_SIGNATURE_BYTES {
            return Err("update_install:invalid_signature".into());
        }
        encoded.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&encoded).map_err(|_| "update_install:invalid_signature")?;
    Signature::decode(&decode_signed_text(text)?)
        .map_err(|_| "update_install:invalid_signature".into())
}

fn update_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("updates"))
        .map_err(|error| error.to_string())
}

/// 下载地址由官方渠道和版本派生。下载失败或验签失败时，应用继续运行。
#[tauri::command]
pub async fn prepare_windows_update(
    app: AppHandle,
    installer: State<'_, UpdateInstallerState>,
    version: String,
    channel: UpdateChannel,
) -> Result<String, String> {
    let name = installer_name(&version).ok_or("update_install:unavailable")?;
    installed_directory().ok_or("update_install:unavailable")?;
    let key = signing_key()?;
    let mut pending = installer
        .0
        .try_lock()
        .map_err(|_| "update_install:already_running")?;
    if let Some(ready) = pending
        .as_ref()
        .filter(|ready| ready.channel == channel && ready.path.ends_with(&name))
    {
        return Ok(ready.id.clone());
    }
    let cache = update_directory(&app)?;
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let path = cache.join(&name);
    let url = channel.installer_url(&format!("v{version}"), &name);
    let signature = fetch_signature(&format!("{url}.sig")).await?;
    download_installer_with_fallback(&app, &url, &path).await?;
    let (path, signature) = async_runtime::spawn_blocking(move || {
        if let Err(error) = verify_installer(&path, &name, &key, &signature) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok((path, signature))
    })
    .await
    .map_err(|error| error.to_string())??;
    let id = uuid::Uuid::new_v4().to_string();
    *pending = Some(PreparedUpdate {
        id: id.clone(),
        path,
        signature,
        channel,
    });
    Ok(id)
}

/// NSIS 使用被动升级并在成功后启动新版本；显式覆盖当前目录，包括自定义安装路径。
fn installer_command(path: &Path, installed: &Path, parent: u32) -> Command {
    let parent_arg = format!("/MYTERMINAL_PID={parent}");
    // NSIS 要求 /D= 放到最后，路径含空格也不可加引号，由安装器自行消费剩余字符串。
    let mut directory_arg = OsString::from("/D=");
    directory_arg.push(installed);
    let mut command = Command::new(path);
    command
        .args(["/P", "/UPDATE", "/R", &parent_arg])
        .raw_arg(directory_arg);
    command
}

/// 再验签后启动安装器，复用正常关闭的后端清理；安装器等待旧进程退出后才开始替换。
#[tauri::command(async)]
pub fn apply_windows_update(
    window: WebviewWindow,
    state: State<'_, AppState>,
    installer: State<'_, UpdateInstallerState>,
    id: String,
) -> Result<(), String> {
    let mut pending = installer
        .0
        .try_lock()
        .map_err(|_| "update_install:already_running")?;
    let ready = pending
        .as_ref()
        .filter(|ready| ready.id == id)
        .ok_or("update_install:unavailable")?;
    let installed = installed_directory().ok_or("update_install:unavailable")?;
    let name = ready
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("update_install:unavailable")?;
    if let Err(error) = verify_installer(&ready.path, name, &signing_key()?, &ready.signature) {
        let _ = fs::remove_file(&ready.path);
        *pending = None;
        return Err(error);
    }

    // 与 SFTP 登记共用锁；安装器启动后不再接受文件传输，避免切换版本时中途截断。
    let transfers = state
        .sftp_transfer_cancellations
        .lock()
        .map_err(|error| error.to_string())?;
    if !transfers.is_empty() {
        return Err("update_install:transfers_active".into());
    }
    if state.is_shutting_down.swap(true, Ordering::SeqCst) {
        return Err("update_install:already_running".into());
    }
    if let Err(error) = installer_command(&ready.path, &installed, std::process::id()).spawn() {
        state.is_shutting_down.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    drop(transfers);
    *pending = None;
    let _ = window.hide();
    let _ = shutdown_app_backends(&state);
    if window.close().is_err() {
        window.app_handle().exit(0);
    }
    Ok(())
}

/// 新版本启动后只清理自己缓存内的旧安装包。遇到仍被安装器占用的文件，下次启动重试。
pub fn cleanup_applied_installers(app: &AppHandle) {
    let Some(current) = stable_version(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    let Ok(directory) = update_directory(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let version = name
            .to_str()
            .map(|name| name.strip_suffix(".download").unwrap_or(name))
            .and_then(|name| name.strip_prefix(INSTALLER_PREFIX))
            .and_then(|name| name.strip_suffix(INSTALLER_SUFFIX))
            .and_then(stable_version);
        if version.is_some_and(|version| version <= current) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_newer_canonical_windows_installers() {
        let current = stable_version(env!("CARGO_PKG_VERSION")).unwrap();
        let newer = format!("{}.0.0", current[0] + 1);
        assert_eq!(
            installer_name(&newer),
            Some(format!("MyTerminal_{newer}_windows_x64-setup.exe"))
        );
        for invalid in [
            env!("CARGO_PKG_VERSION"),
            "0.0.0",
            "99.0.0-beta",
            "99.0.00",
            "99.0.0/../bad",
        ] {
            assert!(installer_name(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn nsis_command_preserves_custom_install_path_and_requests_relaunch() {
        let installed = Path::new(r"C:\Software\MyTerminal 自定义路径");
        let command = installer_command(Path::new("setup.exe"), installed, 4321);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "/P",
                "/UPDATE",
                "/R",
                "/MYTERMINAL_PID=4321",
                r"/D=C:\Software\MyTerminal 自定义路径",
            ]
        );
    }

    #[test]
    fn verifies_tauri_signature_and_rejects_modified_or_relabelled_package() {
        // 用一次性测试密钥生成的公开签名；只保留公钥和样本签名。
        let key = PublicKey::decode(
            &decode_signed_text(concat!(
                "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0MjY4RTdEMTNCMEQ4MUEK",
                "UldRYTJMQVRmWTRtTkZIelVVa2gxM05PY2JKRGNXTUMxb2VFdnJTWUFsZmw4K0lvK0gvVU03bTUK",
            ))
            .unwrap(),
        )
        .unwrap();
        let signature = Signature::decode(&decode_signed_text(concat!(
            "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRYTJMQVRmWTRtTkJYeFFvVFBjeHh4Q3JkekhubjYrTlJo",
            "UlQraFpyVENiWHQ2bURoeFZzNHFPKzN2b2JCSTRJclBHTXBXeWUvVUZHZ2g0QmxFRU1JYktvZnFwckhsMkFvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFt",
            "cDoxNzk1MDc3NjcwCWZpbGU6TXlUZXJtaW5hbF85OS4wLjBfd2luZG93c194NjQtc2V0dXAuZXhlCmlWMjNkaUdDQWZBVllhR2xoOE5LRzkyTnE3cTBK",
            "WUE3RFcrazJ4TTNLd1VuNDRabk9CcU1ZOXdoeDZDZ1FkZklMWnBzc3oyWm5xTDBQUlM5Q2xRS0RnPT0K",
        )).unwrap()).unwrap();
        let name = "MyTerminal_99.0.0_windows_x64-setup.exe";
        let path = std::env::temp_dir().join(format!(
            "myterminal-update-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"MyTerminal fixture").unwrap();
        let genuine = verify_installer(&path, name, &key, &signature);
        let relabelled = verify_installer(
            &path,
            "MyTerminal_99.0.1_windows_x64-setup.exe",
            &key,
            &signature,
        );
        fs::write(&path, b"MyTerminal modified").unwrap();
        let modified = verify_installer(&path, name, &key, &signature);
        fs::remove_file(&path).unwrap();
        assert!(genuine.is_ok());
        assert!(relabelled.is_err());
        assert!(modified.is_err());
    }
}
