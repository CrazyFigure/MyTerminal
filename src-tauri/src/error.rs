use thiserror::Error;

use crate::domain::errors::DomainError;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error(transparent)]
    Domain(#[from] DomainError),
}

impl From<AppError> for String {
    fn from(value: AppError) -> Self {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn test_io_error_from() {
        let io_err = io::Error::new(io::ErrorKind::NotFound, "file missing");
        let app_err: AppError = io_err.into();
        let msg = app_err.to_string();
        assert!(msg.contains("io error"));
        assert!(msg.contains("file missing"));
    }

    #[test]
    fn test_ssh_error_display() {
        let err = AppError::Ssh("connection refused".into());
        let msg = err.to_string();
        assert!(msg.contains("ssh error"));
        assert!(msg.contains("connection refused"));
    }

    #[test]
    fn test_crypto_error_display() {
        let err = AppError::Crypto("decryption failed".into());
        let msg = err.to_string();
        assert!(msg.contains("crypto error"));
        assert!(msg.contains("decryption failed"));
    }

    #[test]
    fn test_validation_error_display() {
        let err = AppError::Validation("invalid input".into());
        let msg = err.to_string();
        assert!(msg.contains("validation error"));
        assert!(msg.contains("invalid input"));
    }

    #[test]
    fn test_not_found_error_display() {
        let err = AppError::NotFound("resource".into());
        let msg = err.to_string();
        assert!(msg.contains("not found"));
        assert!(msg.contains("resource"));
    }

    #[test]
    fn test_domain_error_from() {
        let domain_err = DomainError::Validation("bad data".into());
        let app_err: AppError = domain_err.into();
        let msg = app_err.to_string();
        assert!(msg.contains("validation error"));
        assert!(msg.contains("bad data"));
    }

    #[test]
    fn test_into_string_conversion() {
        let err = AppError::Validation("oops".into());
        let s: String = err.into();
        assert_eq!(s, "validation error: oops");
    }

    #[test]
    fn test_json_error_from() {
        let json_err = serde_json::from_str::<i32>("not-a-number").unwrap_err();
        let app_err: AppError = json_err.into();
        let msg = app_err.to_string();
        assert!(msg.contains("json error"));
    }
}
