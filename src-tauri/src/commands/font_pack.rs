//! 应用内字体资源包：固定来源下载、完整性校验、原子安装与状态查询。

use std::{
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use zip::ZipArchive;

use crate::{
    models::{FontPackFace, FontPackStatus},
    state::AppState,
};

use super::updates::{build_direct_http_client, build_update_http_client};

const FONT_PACK_ID: &str = "core";
const FONT_PACK_VERSION: &str = "1.0.0";
const FONT_PACK_RELEASE_TAG: &str = "fonts-v1.0.0";
const FONT_PACK_ASSET_NAME: &str = "MyTerminal-fontpack-core-v1.0.0.zip";
const FONT_PACK_DOWNLOAD_URL: &str = "https://github.com/CrazyFigure/MyTerminal/releases/download/fonts-v1.0.0/MyTerminal-fontpack-core-v1.0.0.zip";
// GitHub 工作流使用 Deflate ZIP，本地按同一流程实测约 36.96 MiB；下载时仍以 Content-Length 为准。
const FONT_PACK_DOWNLOAD_ESTIMATE_BYTES: u64 = 37 * 1024 * 1024;
const FONT_PACK_INSTALLED_BYTES: u64 = 73_469_156;
// 压缩包只应包含 70 MiB 原始字体及少量文本，限制压缩体积可阻止错误地址或异常资产无限写盘。
const FONT_PACK_ARCHIVE_MAX_BYTES: u64 = 50 * 1024 * 1024;
const FONT_PACK_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const FONT_PACK_PROGRESS_EVENT: &str = "myterminal-font-pack-download-progress";
const FONT_PACK_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
struct FontFileSpec {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

// 文件清单固定在应用版本内：即使 GitHub 资产被替换，也只有逐文件哈希完全一致时才会交给 WebView 解析。
const FONT_FILES: &[FontFileSpec] = &[
    FontFileSpec {
        name: "JetBrainsMono-Bold.woff2",
        size: 94_588,
        sha256: "c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2",
    },
    FontFileSpec {
        name: "JetBrainsMono-BoldItalic.woff2",
        size: 98_152,
        sha256: "3a013466c0eee979fb9d42c2d7a8887cd3645dc8b897cfc5b71781cf982efc5a",
    },
    FontFileSpec {
        name: "JetBrainsMono-Italic.woff2",
        size: 95_864,
        sha256: "cb6a1b246318ed3885d7dffa14a2609297fe80e9b8e500bea33b52fa312a36a4",
    },
    FontFileSpec {
        name: "JetBrainsMono-Light.woff2",
        size: 93_856,
        sha256: "43eb798d59b557c3d87c1402ce684b3fda1ad66bf7ec8021b0a43dc31ad9c572",
    },
    FontFileSpec {
        name: "JetBrainsMono-LightItalic.woff2",
        size: 97_280,
        sha256: "49c50b344b458c1322d859f4f0d9db7f770533c1dbdab31defa0987c29925b9b",
    },
    FontFileSpec {
        name: "JetBrainsMono-Regular.woff2",
        size: 92_164,
        sha256: "a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-Bold.ttf",
        size: 17_957_868,
        sha256: "ab69a5e2abc5de7c031d2409f674e7a5957ae88f50c5d4ecb07c8e84f79ece07",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-Light.ttf",
        size: 18_081_536,
        sha256: "0187e14807f41241dd42da5e6e230ff16ef6cb8d68e2b105340a580085324702",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-LightItalic.ttf",
        size: 18_755_040,
        sha256: "2d4c9233c02981a66a972f18bd48afa0ac914bfa63958272a511c0e8f3b5f79d",
    },
    FontFileSpec {
        name: "MapleMonoNormal-NF-CN-Regular.ttf",
        size: 18_102_808,
        sha256: "0a02d131cf514418c560b516fe53094a1b2ac94a54771cd817b44d61a924ed9b",
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontPackDownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u32>,
}

fn font_pack_error(code: &str, detail: impl AsRef<str>) -> String {
    let detail = detail.as_ref();
    if detail.is_empty() {
        format!("font_pack_error:{code}")
    } else {
        format!("font_pack_error:{code}:{detail}")
    }
}

fn pack_version_dir(root: &Path) -> PathBuf {
    root.join(FONT_PACK_ID).join(FONT_PACK_VERSION)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| font_pack_error("read", error.to_string()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| font_pack_error("read", error.to_string()))?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 每次启动校验完整大小与 SHA-256，不能只凭“目录存在”就把字体二进制交给 WebView。
fn verify_installed_pack(version_dir: &Path) -> Result<(), String> {
    for spec in FONT_FILES {
        let path = version_dir.join("fonts").join(spec.name);
        let metadata =
            fs::metadata(&path).map_err(|_| font_pack_error("missing_file", spec.name))?;
        if !metadata.is_file() || metadata.len() != spec.size {
            return Err(font_pack_error("invalid_file", spec.name));
        }
        if sha256_file(&path)? != spec.sha256 {
            return Err(font_pack_error("invalid_file", spec.name));
        }
    }
    Ok(())
}

fn face(version_dir: &Path, family: &str, weight: &str, style: &str, file: &str) -> FontPackFace {
    FontPackFace {
        family: family.to_string(),
        weight: weight.to_string(),
        style: style.to_string(),
        path: version_dir
            .join("fonts")
            .join(file)
            .to_string_lossy()
            .to_string(),
    }
}

/// 字体别名与旧版 CSS 声明保持一致，下载后无需迁移用户已保存的字体族设置。
fn build_font_faces(version_dir: &Path) -> Vec<FontPackFace> {
    vec![
        face(
            version_dir,
            "JetBrains Mono Light",
            "300",
            "normal",
            "JetBrainsMono-Light.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono Light",
            "300",
            "italic",
            "JetBrainsMono-LightItalic.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "300",
            "normal",
            "JetBrainsMono-Light.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "300",
            "italic",
            "JetBrainsMono-LightItalic.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "400",
            "normal",
            "JetBrainsMono-Regular.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "400",
            "italic",
            "JetBrainsMono-Italic.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "700",
            "normal",
            "JetBrainsMono-Bold.woff2",
        ),
        face(
            version_dir,
            "JetBrains Mono",
            "700",
            "italic",
            "JetBrainsMono-BoldItalic.woff2",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN Light",
            "300",
            "normal",
            "MapleMonoNormal-NF-CN-Light.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN Light",
            "300",
            "italic",
            "MapleMonoNormal-NF-CN-LightItalic.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "300",
            "normal",
            "MapleMonoNormal-NF-CN-Light.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "300",
            "italic",
            "MapleMonoNormal-NF-CN-LightItalic.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "400",
            "normal",
            "MapleMonoNormal-NF-CN-Regular.ttf",
        ),
        face(
            version_dir,
            "Maple Mono Normal NF CN",
            "700",
            "normal",
            "MapleMonoNormal-NF-CN-Bold.ttf",
        ),
        // 推荐列表保留了 Regular 独立族名；显式注册别名，避免旧实现“判定内置但实际没有 @font-face”的落差。
        face(
            version_dir,
            "Maple Mono Normal NF CN Regular",
            "400",
            "normal",
            "MapleMonoNormal-NF-CN-Regular.ttf",
        ),
    ]
}

fn build_status(root: &Path) -> FontPackStatus {
    let version_dir = pack_version_dir(root);
    let (state, faces) = if !version_dir.exists() {
        ("missing", Vec::new())
    } else if verify_installed_pack(&version_dir).is_ok() {
        ("ready", build_font_faces(&version_dir))
    } else {
        ("invalid", Vec::new())
    };
    FontPackStatus {
        id: FONT_PACK_ID.to_string(),
        version: FONT_PACK_VERSION.to_string(),
        state: state.to_string(),
        installed_size_bytes: FONT_PACK_INSTALLED_BYTES,
        download_size_bytes: FONT_PACK_DOWNLOAD_ESTIMATE_BYTES,
        download_url: FONT_PACK_DOWNLOAD_URL.to_string(),
        faces,
    }
}

async fn download_archive(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    archive_path: &Path,
) -> Result<(), String> {
    match fs::remove_file(archive_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(font_pack_error("write", error.to_string())),
    }

    let mut response = client
        .get(FONT_PACK_DOWNLOAD_URL)
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(|error| font_pack_error("download", error.to_string()))?
        .error_for_status()
        .map_err(|error| font_pack_error("download", error.to_string()))?;
    let total_bytes = response.content_length();
    if total_bytes.is_some_and(|size| size == 0 || size > FONT_PACK_ARCHIVE_MAX_BYTES) {
        return Err(font_pack_error("archive_size", "content-length"));
    }

    let mut output = fs::File::create(archive_path)
        .map_err(|error| font_pack_error("write", error.to_string()))?;
    let mut downloaded_bytes = 0_u64;
    let mut last_emit = Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| font_pack_error("download", error.to_string()))?
    {
        downloaded_bytes += chunk.len() as u64;
        if downloaded_bytes > FONT_PACK_ARCHIVE_MAX_BYTES {
            return Err(font_pack_error("archive_size", "downloaded"));
        }
        output
            .write_all(&chunk)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        if last_emit.elapsed() >= FONT_PACK_PROGRESS_THROTTLE {
            let percent = total_bytes.map(|total| {
                ((downloaded_bytes as f64 / total as f64) * 100.0)
                    .min(100.0)
                    .round() as u32
            });
            let _ = app_handle.emit(
                FONT_PACK_PROGRESS_EVENT,
                &FontPackDownloadProgressEvent {
                    downloaded_bytes,
                    total_bytes,
                    percent,
                },
            );
            last_emit = Instant::now();
        }
    }
    output
        .flush()
        .map_err(|error| font_pack_error("write", error.to_string()))?;
    if downloaded_bytes == 0 {
        return Err(font_pack_error("archive_size", "empty"));
    }
    let _ = app_handle.emit(
        FONT_PACK_PROGRESS_EVENT,
        &FontPackDownloadProgressEvent {
            downloaded_bytes,
            total_bytes: total_bytes.or(Some(downloaded_bytes)),
            percent: Some(100),
        },
    );
    Ok(())
}

fn extract_verified_archive(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive_path).map_err(|error| font_pack_error("read", error.to_string()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| font_pack_error("invalid_archive", error.to_string()))?;
    let fonts_dir = staging_dir.join("fonts");
    fs::create_dir_all(&fonts_dir).map_err(|error| font_pack_error("write", error.to_string()))?;

    for spec in FONT_FILES {
        let entry_name = format!("fonts/{}", spec.name);
        let mut entry = archive
            .by_name(&entry_name)
            .map_err(|_| font_pack_error("missing_file", spec.name))?;
        if entry.is_dir() || entry.size() != spec.size {
            return Err(font_pack_error("invalid_file", spec.name));
        }
        let output_path = fonts_dir.join(spec.name);
        let mut output = fs::File::create(&output_path)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let size = entry
                .read(&mut buffer)
                .map_err(|error| font_pack_error("invalid_archive", error.to_string()))?;
            if size == 0 {
                break;
            }
            written += size as u64;
            if written > spec.size {
                return Err(font_pack_error("invalid_file", spec.name));
            }
            hasher.update(&buffer[..size]);
            output
                .write_all(&buffer[..size])
                .map_err(|error| font_pack_error("write", error.to_string()))?;
        }
        output
            .flush()
            .map_err(|error| font_pack_error("write", error.to_string()))?;
        if written != spec.size || format!("{:x}", hasher.finalize()) != spec.sha256 {
            return Err(font_pack_error("invalid_file", spec.name));
        }
    }

    // 本地清单只记录已通过内置哈希表校验的版本；状态查询仍会逐文件复核，不把清单本身当作信任来源。
    let installed_manifest = serde_json::json!({
        "id": FONT_PACK_ID,
        "version": FONT_PACK_VERSION,
        "releaseTag": FONT_PACK_RELEASE_TAG,
        "assetName": FONT_PACK_ASSET_NAME,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    fs::write(
        staging_dir.join("font-pack.json"),
        serde_json::to_vec_pretty(&installed_manifest)
            .map_err(|error| font_pack_error("write", error.to_string()))?,
    )
    .map_err(|error| font_pack_error("write", error.to_string()))?;
    Ok(())
}

/// 先完整解压到同盘临时目录，再用目录重命名切换；失败时恢复旧包，避免修复过程中破坏仍可用版本。
fn install_archive_atomically(archive_path: &Path, root: &Path) -> Result<FontPackStatus, String> {
    let pack_root = root.join(FONT_PACK_ID);
    fs::create_dir_all(&pack_root).map_err(|error| font_pack_error("write", error.to_string()))?;
    let target_dir = pack_version_dir(root);
    let staging_dir = pack_root.join(format!(
        ".{FONT_PACK_VERSION}-installing-{}",
        Uuid::new_v4()
    ));
    let backup_dir = pack_root.join(format!(".{FONT_PACK_VERSION}-backup"));
    let _ = fs::remove_dir_all(&staging_dir);
    let _ = fs::remove_dir_all(&backup_dir);

    if let Err(error) = extract_verified_archive(archive_path, &staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    if target_dir.exists() {
        fs::rename(&target_dir, &backup_dir)
            .map_err(|error| font_pack_error("write", error.to_string()))?;
    }
    if let Err(error) = fs::rename(&staging_dir, &target_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(font_pack_error("write", error.to_string()));
    }
    let _ = fs::remove_dir_all(&backup_dir);

    verify_installed_pack(&target_dir)?;
    Ok(build_status(root))
}

#[tauri::command]
pub fn get_font_pack_status(state: State<'_, AppState>) -> Result<FontPackStatus, String> {
    Ok(build_status(&state.storage.font_packs_dir_path()))
}

#[tauri::command]
pub async fn download_font_pack(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<FontPackStatus, String> {
    let root = state.storage.font_packs_dir_path();
    let current = build_status(&root);
    if current.state == "ready" {
        return Ok(current);
    }
    fs::create_dir_all(&root).map_err(|error| font_pack_error("write", error.to_string()))?;
    let archive_path = root.join(format!("{FONT_PACK_ID}-{FONT_PACK_VERSION}.zip.download"));

    // 与应用更新保持一致：先尊重系统代理，代理节点返回 403 时再直连重试。
    let client = build_update_http_client(FONT_PACK_DOWNLOAD_TIMEOUT)
        .map_err(|error| font_pack_error("download", error.to_string()))?;
    if let Err(error) = download_archive(&app_handle, &client, &archive_path).await {
        if error.contains("403") {
            let direct_client = build_direct_http_client(FONT_PACK_DOWNLOAD_TIMEOUT)
                .map_err(|direct_error| font_pack_error("download", direct_error.to_string()))?;
            download_archive(&app_handle, &direct_client, &archive_path).await?;
        } else {
            return Err(error);
        }
    }

    let install_path = archive_path.clone();
    let install_root = root.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        install_archive_atomically(&install_path, &install_root)
    })
    .await
    .map_err(|error| font_pack_error("install", error.to_string()))??;
    let _ = fs::remove_file(&archive_path);
    Ok(status)
}

#[tauri::command]
pub async fn import_font_pack(
    source_path: String,
    state: State<'_, AppState>,
) -> Result<FontPackStatus, String> {
    let source = PathBuf::from(source_path.trim());
    let metadata =
        fs::metadata(&source).map_err(|error| font_pack_error("read", error.to_string()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > FONT_PACK_ARCHIVE_MAX_BYTES {
        return Err(font_pack_error("archive_size", "import"));
    }
    let root = state.storage.font_packs_dir_path();
    let install_path = source.clone();
    tauri::async_runtime::spawn_blocking(move || install_archive_atomically(&install_path, &root))
        .await
        .map_err(|error| font_pack_error("install", error.to_string()))?
}

#[tauri::command]
pub fn remove_font_pack(state: State<'_, AppState>) -> Result<FontPackStatus, String> {
    let root = state.storage.font_packs_dir_path();
    let version_dir = pack_version_dir(&root);
    match fs::remove_dir_all(&version_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(font_pack_error("remove", error.to_string())),
    }
    let archive_path = root.join(format!("{FONT_PACK_ID}-{FONT_PACK_VERSION}.zip.download"));
    match fs::remove_file(archive_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(font_pack_error("remove", error.to_string())),
    }
    Ok(build_status(&root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_manifest_size_matches_file_specs() {
        let total: u64 = FONT_FILES.iter().map(|spec| spec.size).sum();
        assert_eq!(total, FONT_PACK_INSTALLED_BYTES);
    }

    #[test]
    fn font_face_files_are_all_declared_in_manifest() {
        let root = Path::new("C:/font-pack-test");
        let declared = FONT_FILES
            .iter()
            .map(|spec| spec.name)
            .collect::<std::collections::HashSet<_>>();
        for face in build_font_faces(root) {
            let name = Path::new(&face.path)
                .file_name()
                .and_then(|value| value.to_str())
                .expect("font face path should have a UTF-8 file name");
            assert!(declared.contains(name));
        }
    }

    #[test]
    fn source_font_files_match_embedded_manifest() {
        let font_source_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("assets")
            .join("fonts");
        for spec in FONT_FILES {
            let path = font_source_dir.join(spec.name);
            let metadata = fs::metadata(&path).expect("font pack source file should exist");
            assert_eq!(metadata.len(), spec.size, "size mismatch for {}", spec.name);
            assert_eq!(
                sha256_file(&path).expect("font pack source file should be readable"),
                spec.sha256,
                "hash mismatch for {}",
                spec.name
            );
        }
    }
}
