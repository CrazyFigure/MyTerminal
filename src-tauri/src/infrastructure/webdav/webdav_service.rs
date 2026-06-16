use chrono::Local;
use reqwest::{Client, Method, StatusCode};

use crate::{
    domain::entities::{AppSettings, ConnectionProfile, WebDavSettings},
    error::AppError,
    infrastructure::crypto::CryptoService,
    interface::dto::LocalConfigBundle,
};

#[derive(Debug, Clone)]
pub struct WebDavService {
    client: Client,
}

impl Default for WebDavService {
    fn default() -> Self {
        Self::new()
    }
}

impl WebDavService {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }

    fn validate_settings(settings: &WebDavSettings) -> Result<(), AppError> {
        if settings.base_url.trim().is_empty() {
            return Err(AppError::Validation("WebDAV base URL is required".into()));
        }
        Ok(())
    }

    fn build_url(base_url: &str, remote_path: &str) -> String {
        let base = base_url.trim_end_matches('/');
        let path = remote_path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    fn parent_collections(remote_path: &str) -> Vec<String> {
        let mut parts = remote_path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>();

        if parts.len() <= 1 {
            return Vec::new();
        }

        parts.pop();
        let mut collections = Vec::with_capacity(parts.len());
        for index in 0..parts.len() {
            collections.push(parts[..=index].join("/"));
        }
        collections
    }

    async fn ensure_parent_collections(
        &self,
        settings: &WebDavSettings,
        remote_path: &str,
    ) -> Result<(), AppError> {
        let method = Method::from_bytes(b"MKCOL")
            .map_err(|error| AppError::Validation(format!("invalid WebDAV method: {error}")))?;

        for collection in Self::parent_collections(remote_path) {
            let url = Self::build_url(&settings.base_url, &collection);
            let response = self
                .client
                .request(method.clone(), url)
                .basic_auth(&settings.username, Some(&settings.password))
                .send()
                .await?;

            if response.status().is_success() || response.status() == StatusCode::METHOD_NOT_ALLOWED
            {
                continue;
            }

            response.error_for_status()?;
        }

        Ok(())
    }

    async fn put_text(
        &self,
        url: String,
        settings: &WebDavSettings,
        body: String,
    ) -> Result<(), AppError> {
        let response = self
            .client
            .put(url)
            .basic_auth(&settings.username, Some(&settings.password))
            .body(body)
            .send()
            .await?
            .error_for_status()?;

        let _ = response;
        Ok(())
    }

    async fn get_text(&self, url: String, settings: &WebDavSettings) -> Result<String, AppError> {
        Ok(self
            .client
            .get(url)
            .basic_auth(&settings.username, Some(&settings.password))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?)
    }

    /// 发送 PROPFIND 请求并返回响应体文本。WebDAV PROPFIND 正常返回 207 Multi-Status，
    /// reqwest 的 error_for_status() 不认 207，必须手动放行。
    async fn propfind(&self, settings: &WebDavSettings, url: &str) -> Result<String, AppError> {
        let method = Method::from_bytes(b"PROPFIND")
            .map_err(|error| AppError::Validation(format!("invalid WebDAV method: {error}")))?;

        // 坚果云等部分 WebDAV 服务需要 Content-Type: application/xml
        let propfind_body = r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop></prop></propfind>"#;

        let response = self
            .client
            .request(method, url)
            .basic_auth(&settings.username, Some(&settings.password))
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(propfind_body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() && status != StatusCode::MULTI_STATUS {
            let err = response.error_for_status().unwrap_err();
            return Err(AppError::from(err));
        }

        Ok(response.text().await?)
    }

    /// 从 PROPFIND XML 响应中提取 href 路径列表。
    /// 不同 WebDAV 实现使用不同的命名空间前缀（D:、d:、lp1:、无前缀等），
    /// 用字符串搜索精确匹配 `<...href>` 开标签和 `</...href>` 闭标签之间的内容。
    fn extract_hrefs(body: &str) -> Vec<String> {
        let mut hrefs = Vec::new();
        let mut search_from = 0;
        while let Some(open_start) = body[search_from..].find('<') {
            let abs_pos = search_from + open_start;
            // 找到开标签的闭合 >
            let after_open = &body[abs_pos..];
            if let Some(tag_end) = after_open.find('>') {
                let tag_name = &after_open[..tag_end + 1]; // 如 "<D:href>"
                                                           // 检查是否是 href 开标签（不是 </ 开头的闭标签）
                if tag_name.contains("href") && !tag_name.contains('/') {
                    let content_start = abs_pos + tag_end + 1;
                    // 找对应的闭标签 </...href>
                    if let Some(close_start) = body[content_start..].find("</") {
                        let close_text = &body[content_start + close_start..];
                        if let Some(close_end) = close_text.find('>') {
                            let close_tag = &close_text[..close_end + 1]; // 如 "</D:href>"
                            if close_tag.contains("href") {
                                let content = &body[content_start..content_start + close_start];
                                let trimmed = content.trim();
                                if !trimmed.is_empty() {
                                    hrefs.push(trimmed.to_string());
                                }
                            }
                        }
                        search_from = content_start + close_start + 1;
                        continue;
                    }
                }
            }
            search_from = abs_pos + 1;
        }
        hrefs
    }

    /// 从 href 列表中提取符合指定前缀和扩展名的文件名。
    fn filter_backup_filenames(
        hrefs: &[String],
        prefixes: &[&str],
        extensions: &[&str],
    ) -> Vec<String> {
        let mut files = Vec::new();
        for href in hrefs {
            let decoded = urlencoding::decode(href).unwrap_or_default();
            if let Some(filename) = decoded.split('/').next_back() {
                if filename.is_empty() {
                    continue;
                }
                let matches_prefix = prefixes.iter().any(|p| filename.starts_with(p));
                let matches_ext = extensions.iter().any(|e| filename.ends_with(e));
                if matches_prefix && matches_ext {
                    files.push(filename.to_string());
                }
            }
        }
        // 按时间戳倒序排列（最新的在前）
        files.sort_by(|a, b| b.cmp(a));
        files
    }

    // 使用 Depth=0 的 PROPFIND 轻量探测 WebDAV 根地址，避免测试连接时创建或覆盖任何远端文件。
    pub async fn test_connection(&self, settings: &WebDavSettings) -> Result<(), AppError> {
        Self::validate_settings(settings)?;
        let method = Method::from_bytes(b"PROPFIND")
            .map_err(|error| AppError::Validation(format!("invalid WebDAV method: {error}")))?;
        let response = self
            .client
            .request(method, settings.base_url.trim_end_matches('/'))
            .basic_auth(&settings.username, Some(&settings.password))
            .header("Depth", "0")
            .send()
            .await?;

        if response.status().is_success()
            || response.status() == StatusCode::MULTI_STATUS
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
        {
            return Ok(());
        }

        response.error_for_status()?;
        Ok(())
    }

    pub async fn upload_settings(
        &self,
        settings: &AppSettings,
        _crypto: &CryptoService,
    ) -> Result<String, AppError> {
        Self::validate_settings(&settings.webdav)?;
        let serialized = serde_json::to_string_pretty(settings)?;

        let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = settings.webdav.remote_path.trim_end_matches('/');
        let remote_path = format!("{}/settings-{}.enc.json", dir, timestamp);

        self.ensure_parent_collections(&settings.webdav, &remote_path)
            .await?;
        let url = Self::build_url(&settings.webdav.base_url, &remote_path);
        self.put_text(url, &settings.webdav, serialized).await?;
        Ok(remote_path)
    }

    pub async fn list_settings_backups(
        &self,
        webdav: &WebDavSettings,
    ) -> Result<Vec<String>, AppError> {
        Self::validate_settings(webdav)?;

        let dir_path = webdav.remote_path.trim_end_matches('/');
        let url = Self::build_url(&webdav.base_url, dir_path);
        let body = self.propfind(webdav, &url).await?;
        let hrefs = Self::extract_hrefs(&body);
        Ok(Self::filter_backup_filenames(
            &hrefs,
            &["settings"],
            &[".enc.json"],
        ))
    }

    pub async fn download_settings(
        &self,
        webdav: &WebDavSettings,
        remote_path: &str,
        _crypto: &CryptoService,
    ) -> Result<AppSettings, AppError> {
        Self::validate_settings(webdav)?;
        let url = Self::build_url(&webdav.base_url, remote_path);
        let payload = self.get_text(url, webdav).await?;
        Ok(serde_json::from_str(&payload)?)
    }

    pub async fn upload_connections(
        &self,
        settings: &AppSettings,
        connections: &[ConnectionProfile],
        _crypto: &CryptoService,
    ) -> Result<String, AppError> {
        Self::validate_settings(&settings.webdav)?;
        let serialized = serde_json::to_string_pretty(connections)?;

        let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = settings.webdav.remote_path.trim_end_matches('/');
        let remote_path = format!("{}/connections-{}.enc.json", dir, timestamp);

        self.ensure_parent_collections(&settings.webdav, &remote_path)
            .await?;
        let url = Self::build_url(&settings.webdav.base_url, &remote_path);
        self.put_text(url, &settings.webdav, serialized).await?;
        Ok(remote_path)
    }

    pub async fn list_connections_backups(
        &self,
        webdav: &WebDavSettings,
    ) -> Result<Vec<String>, AppError> {
        Self::validate_settings(webdav)?;

        let dir_path = webdav.remote_path.trim_end_matches('/');
        let url = Self::build_url(&webdav.base_url, dir_path);
        let body = self.propfind(webdav, &url).await?;
        let hrefs = Self::extract_hrefs(&body);
        Ok(Self::filter_backup_filenames(
            &hrefs,
            &["connections"],
            &[".enc.json"],
        ))
    }

    pub async fn download_connections(
        &self,
        webdav: &WebDavSettings,
        remote_path: &str,
        _crypto: &CryptoService,
    ) -> Result<Vec<ConnectionProfile>, AppError> {
        Self::validate_settings(webdav)?;
        let url = Self::build_url(&webdav.base_url, remote_path);
        let payload = self.get_text(url, webdav).await?;
        Ok(serde_json::from_str(&payload)?)
    }

    /// 合并上传所有配置（设置 + 连接 + 历史 + 隧道），与本地导出使用相同的 LocalConfigBundle 结构。
    pub async fn upload_config_bundle(
        &self,
        webdav: &WebDavSettings,
        bundle: &LocalConfigBundle,
    ) -> Result<String, AppError> {
        Self::validate_settings(webdav)?;
        let serialized = serde_json::to_string_pretty(bundle)?;

        let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = webdav.remote_path.trim_end_matches('/');
        let remote_path = format!("{}/myterminal-config-{}.enc.json", dir, timestamp);

        self.ensure_parent_collections(webdav, &remote_path).await?;
        let url = Self::build_url(&webdav.base_url, &remote_path);
        self.put_text(url, webdav, serialized).await?;
        Ok(remote_path)
    }

    /// 列出远程目录中的所有备份文件（兼容合并格式 myterminal-config-* 和旧格式 settings-*/connections-*）。
    pub async fn list_config_backups(
        &self,
        webdav: &WebDavSettings,
    ) -> Result<Vec<String>, AppError> {
        Self::validate_settings(webdav)?;

        let dir_path = webdav.remote_path.trim_end_matches('/');
        let url = Self::build_url(&webdav.base_url, dir_path);
        let body = self.propfind(webdav, &url).await?;

        let hrefs = Self::extract_hrefs(&body);

        let files = Self::filter_backup_filenames(
            &hrefs,
            &["myterminal-config", "settings", "connections"],
            &[".enc.json"],
        );

        Ok(files)
    }

    /// 下载合并配置包，反序列化为 LocalConfigBundle。
    pub async fn download_config_bundle(
        &self,
        webdav: &WebDavSettings,
        remote_path: &str,
    ) -> Result<LocalConfigBundle, AppError> {
        Self::validate_settings(webdav)?;
        let url = Self::build_url(&webdav.base_url, remote_path);
        let payload = self.get_text(url, webdav).await?;
        Ok(serde_json::from_str(&payload)?)
    }
}
