//! 内置 AI 对话的本地附件读取：Windows 路径规范化、格式分类与文本编码识别。
//!
//! 设计要点：
//! 1. 只读取用户主动选择、粘贴或拖入的文件，模型本身没有任何读取本机文件的工具，避免越权。
//! 2. 路径兼容 Windows 常见写法：带引号、正斜杠、`file:///` URL、`\\?\` 长路径前缀与 UNC 共享路径。
//! 3. UTF-8 / UTF-16 在后端直接解码；GBK 等本地编码交给 WebView 的 TextDecoder 处理，无需引入编码库。

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

use crate::error::AppError;

/// 图片原始文件上限；前端还会统一缩放压缩，这里只拦截明显异常的超大文件。
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// 文本只读取开头这么多字节；日志等大文件截断后仍能让模型看到关键部分。
const MAX_TEXT_BYTES: usize = 512 * 1024;
/// 判断二进制文件时只嗅探开头一段，避免为了分类读完整个大文件。
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// 读取结果；`text` 与 `data` 二选一：可直接解码的文本给 `text`，图片或本地编码文本给 base64 `data`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachmentFile {
    /// 规范化后的 Windows 路径，用于界面展示与提示模型文件来源。
    pub path: String,
    pub name: String,
    /// 磁盘上的原始大小（字节）。
    pub size: u64,
    /// "image" | "text"。
    pub kind: String,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// 文本超过读取上限被截断。
    pub truncated: bool,
}

/// 附件分类结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum AttachmentClass {
    Image(&'static str),
    Text,
    /// 已知的二进制/办公文档格式，直接给出明确提示而不是读出一堆乱码。
    Unsupported,
}

/// 把用户给出的路径文本整理成标准 Windows 路径写法；只做字符串变换，不访问文件系统。
pub fn normalize_path_text(raw: &str) -> String {
    let mut value = raw.trim();
    // 资源管理器“复制为路径”会带双引号，部分终端会带单引号。
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            value = value[1..value.len() - 1].trim();
        }
    }

    let mut text = value.to_string();
    // file:///C:/a%20b.txt → C:/a b.txt；file://server/share → //server/share。
    if let Some(rest) = strip_prefix_ignore_case(&text, "file:///") {
        text = percent_decode(rest);
    } else if let Some(rest) = strip_prefix_ignore_case(&text, "file://") {
        text = format!("//{}", percent_decode(rest));
    }

    if cfg!(windows) || looks_like_windows_path(&text) {
        text = text.replace('/', "\\");
        // \\?\C:\x 与 \\?\UNC\server\share 是长路径写法，展示与读取都还原成常规写法。
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            text = format!("\\\\{rest}");
        } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
            text = rest.to_string();
        }
        // 盘符统一大写，C: 与 c: 是同一个盘，避免同一文件出现两种写法。
        let bytes = text.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            text = format!("{}{}", (bytes[0] as char).to_ascii_uppercase(), &text[1..]);
        }
        // 合并 UNC 前缀之后多余的重复分隔符，例如 C:\\logs\\\\a.log。
        let (prefix, body) = if let Some(rest) = text.strip_prefix("\\\\") {
            ("\\\\", rest)
        } else {
            ("", text.as_str())
        };
        let mut collapsed = String::with_capacity(body.len());
        let mut last_sep = false;
        for ch in body.chars() {
            if ch == '\\' {
                if !last_sep {
                    collapsed.push(ch);
                }
                last_sep = true;
            } else {
                collapsed.push(ch);
                last_sep = false;
            }
        }
        text = format!("{prefix}{collapsed}");
    }
    text
}

/// 读取一个本地附件；路径必须是绝对路径，且只能是普通文件。
pub fn read_local_attachment(raw_path: &str) -> Result<LocalAttachmentFile, AppError> {
    let normalized = normalize_path_text(raw_path);
    if normalized.is_empty() {
        return Err(AppError::Validation("文件路径为空".into()));
    }
    let path = PathBuf::from(&normalized);
    if !path.is_absolute() {
        return Err(AppError::Validation(format!(
            "请使用绝对路径，例如 C:\\Users\\name\\a.log：{normalized}"
        )));
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| AppError::Validation(format!("无法读取文件 {normalized}：{error}")))?;
    if !metadata.is_file() {
        return Err(AppError::Validation(format!("不是文件：{normalized}")));
    }

    let name = path
        .file_name()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| normalized.clone());
    let size = metadata.len();

    match classify_path(&path) {
        AttachmentClass::Unsupported => Err(AppError::Validation(format!(
            "暂不支持该文件格式：{name}（支持图片与纯文本类文件）"
        ))),
        AttachmentClass::Image(media_type) => {
            if size > MAX_IMAGE_BYTES {
                return Err(AppError::Validation(format!(
                    "图片过大（{} MB），请选择 20 MB 以内的图片：{name}",
                    size / 1024 / 1024
                )));
            }
            let bytes = fs::read(&path).map_err(AppError::from)?;
            Ok(LocalAttachmentFile {
                path: normalized,
                name,
                size,
                kind: "image".into(),
                media_type: media_type.into(),
                text: None,
                data: Some(STANDARD.encode(bytes)),
                truncated: false,
            })
        }
        AttachmentClass::Text => {
            let mut bytes = Vec::with_capacity((size as usize).min(MAX_TEXT_BYTES));
            fs::File::open(&path)
                .and_then(|file| file.take(MAX_TEXT_BYTES as u64).read_to_end(&mut bytes))
                .map_err(AppError::from)?;
            let truncated = size > MAX_TEXT_BYTES as u64;
            let decoded = decode_text_bytes(&bytes, truncated)
                .map_err(|reason| AppError::Validation(format!("{reason}：{name}")))?;
            let (text, data) = match decoded {
                DecodedText::Text(text) => (Some(text), None),
                // 不是 UTF-8/UTF-16 时多半是 GBK 等本地编码，原始字节交给前端 TextDecoder 解码。
                DecodedText::Legacy => (None, Some(STANDARD.encode(&bytes))),
            };
            Ok(LocalAttachmentFile {
                path: normalized,
                name,
                size,
                kind: "text".into(),
                media_type: "text/plain".into(),
                text,
                data,
                truncated,
            })
        }
    }
}

/// 按扩展名分类；没有扩展名的文件（Dockerfile、Makefile 等）按文本处理，再由内容嗅探兜底。
fn classify_path(path: &Path) -> AttachmentClass {
    let extension = path
        .extension()
        .map(|item| item.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => AttachmentClass::Image("image/png"),
        "jpg" | "jpeg" => AttachmentClass::Image("image/jpeg"),
        "gif" => AttachmentClass::Image("image/gif"),
        "webp" => AttachmentClass::Image("image/webp"),
        "bmp" => AttachmentClass::Image("image/bmp"),
        "exe" | "dll" | "sys" | "msi" | "bin" | "iso" | "img" | "zip" | "7z" | "rar" | "gz"
        | "tgz" | "xz" | "bz2" | "tar" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt"
        | "pptx" | "mp3" | "mp4" | "mkv" | "avi" | "mov" | "wav" | "flac" | "ico" | "svgz"
        | "ttf" | "otf" | "woff" | "woff2" | "class" | "jar" | "pyc" | "o" | "so" | "a"
        | "lib" | "pdb" | "db" | "sqlite" => AttachmentClass::Unsupported,
        _ => AttachmentClass::Text,
    }
}

/// 文本解码结果。
#[derive(Debug, PartialEq, Eq)]
enum DecodedText {
    Text(String),
    /// 无法按 Unicode 编码解析，交给前端按本地编码解码。
    Legacy,
}

/// 识别 BOM、UTF-8 与二进制内容；截断时容忍末尾半个多字节字符。
fn decode_text_bytes(bytes: &[u8], truncated: bool) -> Result<DecodedText, &'static str> {
    // UTF-16 文本天然含大量 0 字节，必须先按 BOM 识别，再做二进制嗅探。
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return Ok(DecodedText::Text(decode_utf16(rest, u16::from_le_bytes)));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return Ok(DecodedText::Text(decode_utf16(rest, u16::from_be_bytes)));
    }
    let sniff = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return Err("看起来是二进制文件，无法作为文本读取");
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(text) => Ok(DecodedText::Text(text.to_string())),
        // 截断点刚好落在多字节字符中间：丢弃这半个字符即可，不能误判成本地编码。
        Err(error) if truncated && error.error_len().is_none() => Ok(DecodedText::Text(
            String::from_utf8_lossy(&body[..error.valid_up_to()]).to_string(),
        )),
        Err(_) => Ok(DecodedText::Legacy),
    }
}

fn decode_utf16(bytes: &[u8], read: fn([u8; 2]) -> u16) -> String {
    // 奇数长度时末尾落单的字节属于被截断的半个码元，直接丢弃。
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|pair| read(*pair)).collect();
    String::from_utf16_lossy(&units)
}

fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    if value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&value[prefix.len()..])
    } else {
        None
    }
}

/// 解码 URL 中的 %XX；非法序列原样保留，多字节结果按 UTF-8 还原（中文路径）。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        // 按字节解析两位十六进制，避免在中文等多字节字符中间切片导致 panic。
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 非 Windows 构建（如 CI）下也能识别出 Windows 路径，保证规范化规则在测试里一致。
fn looks_like_windows_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    (bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic())
        || text.starts_with("\\\\")
        || text.starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_text_handles_common_windows_forms() {
        assert_eq!(normalize_path_text("  \"C:\\Logs\\app.log\"  "), "C:\\Logs\\app.log");
        assert_eq!(normalize_path_text("c:/Users/张三/a b.txt"), "C:\\Users\\张三\\a b.txt");
        assert_eq!(normalize_path_text("C:\\\\logs\\\\\\a.log"), "C:\\logs\\a.log");
        assert_eq!(normalize_path_text("\\\\?\\D:\\very\\long.txt"), "D:\\very\\long.txt");
        assert_eq!(
            normalize_path_text("\\\\?\\UNC\\server\\share\\a.txt"),
            "\\\\server\\share\\a.txt"
        );
        assert_eq!(normalize_path_text("\\\\server\\share\\a.txt"), "\\\\server\\share\\a.txt");
    }

    #[test]
    fn normalize_path_text_decodes_file_urls() {
        assert_eq!(
            normalize_path_text("file:///C:/Users/a%20b/%E6%97%A5%E5%BF%97.log"),
            "C:\\Users\\a b\\日志.log"
        );
        assert_eq!(normalize_path_text("FILE://server/share/x.md"), "\\\\server\\share\\x.md");
        // 结尾的不完整 % 序列原样保留，不能越界。
        assert_eq!(normalize_path_text("file:///C:/a%2"), "C:\\a%2");
    }

    #[test]
    fn classify_path_separates_images_text_and_binaries() {
        assert_eq!(classify_path(Path::new("C:\\a\\shot.PNG")), AttachmentClass::Image("image/png"));
        assert_eq!(classify_path(Path::new("C:\\a\\photo.jpeg")), AttachmentClass::Image("image/jpeg"));
        assert_eq!(classify_path(Path::new("C:\\a\\nginx.conf")), AttachmentClass::Text);
        assert_eq!(classify_path(Path::new("C:\\a\\Dockerfile")), AttachmentClass::Text);
        assert_eq!(classify_path(Path::new("C:\\a\\setup.exe")), AttachmentClass::Unsupported);
        assert_eq!(classify_path(Path::new("C:\\a\\report.pdf")), AttachmentClass::Unsupported);
    }

    #[test]
    fn decode_text_bytes_recognizes_encodings_and_binaries() {
        assert_eq!(
            decode_text_bytes("\u{FEFF}hello".as_bytes(), false),
            Ok(DecodedText::Text("hello".into()))
        );
        // UTF-16 LE BOM + "日志"
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("日志".encode_utf16().flat_map(|unit| unit.to_le_bytes()))
            .collect();
        assert_eq!(decode_text_bytes(&utf16, false), Ok(DecodedText::Text("日志".into())));
        // GBK 编码的“中文”不是合法 UTF-8，交给前端按本地编码解码。
        assert_eq!(decode_text_bytes(&[0xD6, 0xD0, 0xCE, 0xC4], false), Ok(DecodedText::Legacy));
        assert!(decode_text_bytes(&[0x4D, 0x5A, 0x00, 0x01], false).is_err());
        // 截断落在“中”字的第二个字节上：丢弃半个字符而不是判为本地编码。
        let mut cut = "ab中".as_bytes().to_vec();
        cut.pop();
        assert_eq!(decode_text_bytes(&cut, true), Ok(DecodedText::Text("ab".into())));
    }
}
