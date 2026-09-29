use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime},
};

use serde::Serialize;

use crate::error::AppError;

// 剪贴板截图落盘后保留的时长；AI Agent 通常在提交时才读取图片，保留一天足够且不会无限堆积。
const CLIPBOARD_IMAGE_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// 终端粘贴时剪贴板中的非文本内容：文件列表直接给出路径，位图先保存为临时 PNG 再给出路径。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardAttachment {
    Files { paths: Vec<String> },
    Image { path: String },
}

// 读取剪贴板里的文件或图片；纯文本由前端既有通道处理，这里只兜底文本为空的场景。
// PNG 编码可能耗时数十毫秒，用 (async) 移出主线程，避免粘贴大截图时卡住界面。
#[tauri::command(async)]
pub fn read_clipboard_attachment() -> Result<Option<ClipboardAttachment>, String> {
    // 资源管理器复制的文件优先：其剪贴板同时可能附带图标位图，不能误判成截图。
    let paths = read_clipboard_file_paths();
    if !paths.is_empty() {
        return Ok(Some(ClipboardAttachment::Files { paths }));
    }
    Ok(save_clipboard_image()?.map(|path| ClipboardAttachment::Image { path }))
}

#[cfg(windows)]
fn read_clipboard_file_paths() -> Vec<String> {
    use clipboard_win::{formats, get_clipboard};

    // CF_HDROP 不存在或剪贴板被其它进程占用时都视为没有文件，交给后续图片分支继续判断。
    get_clipboard::<Vec<String>, _>(formats::FileList).unwrap_or_default()
}

#[cfg(not(windows))]
fn read_clipboard_file_paths() -> Vec<String> {
    Vec::new()
}

fn clipboard_image_dir() -> PathBuf {
    std::env::temp_dir().join("MyTerminal").join("clipboard-images")
}

// 位图统一编码为 PNG 写入临时目录，返回绝对路径；剪贴板没有图片时返回 None。
fn save_clipboard_image() -> Result<Option<String>, AppError> {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return Ok(None);
    };
    let Ok(image) = clipboard.get_image() else {
        return Ok(None);
    };
    let (width, height) = (image.width as u32, image.height as u32);
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let dir = clipboard_image_dir();
    fs::create_dir_all(&dir)?;
    cleanup_expired_clipboard_images(&dir);

    let file_name = format!(
        "clipboard-{}-{}.png",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid::Uuid::new_v4().simple().to_string()[..8],
    );
    let path = dir.join(file_name);
    image::save_buffer_with_format(
        &path,
        &image.bytes,
        width,
        height,
        image::ExtendedColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|error| AppError::Validation(format!("failed to save clipboard image: {error}")))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// 顺带清理过期截图；单个文件删除失败（被占用等）不影响本次粘贴。
fn cleanup_expired_clipboard_images(dir: &PathBuf) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > CLIPBOARD_IMAGE_RETENTION);
        if expired {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_attachment_serializes_with_kind_tag() {
        let files = ClipboardAttachment::Files {
            paths: vec!["C:\\a b\\c.txt".into()],
        };
        let image = ClipboardAttachment::Image {
            path: "C:\\tmp\\x.png".into(),
        };
        assert_eq!(
            serde_json::to_value(files).unwrap(),
            serde_json::json!({ "kind": "files", "paths": ["C:\\a b\\c.txt"] })
        );
        assert_eq!(
            serde_json::to_value(image).unwrap(),
            serde_json::json!({ "kind": "image", "path": "C:\\tmp\\x.png" })
        );
    }
}
