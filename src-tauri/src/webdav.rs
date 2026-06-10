use reqwest::{Client, Method, StatusCode};

use crate::{
    crypto::CryptoService,
    error::AppError,
    models::{AppSettings, ConnectionProfile, WebDavSettings},
};

#[derive(Debug, Clone)]
pub struct WebDavService {
    client: Client,
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
    ) -> Result<(), AppError> {
        Self::validate_settings(&settings.webdav)?;
        let serialized = serde_json::to_string_pretty(settings)?;
        self.ensure_parent_collections(&settings.webdav, &settings.webdav.remote_settings_path)
            .await?;
        let url = Self::build_url(
            &settings.webdav.base_url,
            &settings.webdav.remote_settings_path,
        );
        self.put_text(url, &settings.webdav, serialized).await
    }

    pub async fn download_settings(
        &self,
        webdav: &WebDavSettings,
        _crypto: &CryptoService,
    ) -> Result<AppSettings, AppError> {
        Self::validate_settings(webdav)?;
        let url = Self::build_url(&webdav.base_url, &webdav.remote_settings_path);
        let payload = self.get_text(url, webdav).await?;
        Ok(serde_json::from_str(&payload)?)
    }

    pub async fn upload_connections(
        &self,
        settings: &AppSettings,
        connections: &[ConnectionProfile],
        _crypto: &CryptoService,
    ) -> Result<(), AppError> {
        Self::validate_settings(&settings.webdav)?;
        let serialized = serde_json::to_string_pretty(connections)?;
        self.ensure_parent_collections(&settings.webdav, &settings.webdav.remote_connections_path)
            .await?;
        let url = Self::build_url(
            &settings.webdav.base_url,
            &settings.webdav.remote_connections_path,
        );
        self.put_text(url, &settings.webdav, serialized).await
    }

    pub async fn download_connections(
        &self,
        webdav: &WebDavSettings,
        _crypto: &CryptoService,
    ) -> Result<Vec<ConnectionProfile>, AppError> {
        Self::validate_settings(webdav)?;
        let url = Self::build_url(&webdav.base_url, &webdav.remote_connections_path);
        let payload = self.get_text(url, webdav).await?;
        Ok(serde_json::from_str(&payload)?)
    }
}
