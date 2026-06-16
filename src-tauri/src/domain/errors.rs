use thiserror::Error;

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validation_error_display() {
        let err = DomainError::Validation("name is required".into());
        let msg = err.to_string();
        assert!(msg.contains("validation error"));
        assert!(msg.contains("name is required"));
    }

    #[test]
    fn test_not_found_error_display() {
        let err = DomainError::NotFound("connection not found".into());
        let msg = err.to_string();
        assert!(msg.contains("not found"));
        assert!(msg.contains("connection not found"));
    }

    #[test]
    fn test_validation_error_debug() {
        let err = DomainError::Validation("test".into());
        let debug = format!("{err:?}");
        assert!(debug.contains("Validation"));
        assert!(debug.contains("test"));
    }

    #[test]
    fn test_not_found_error_debug() {
        let err = DomainError::NotFound("missing".into());
        let debug = format!("{err:?}");
        assert!(debug.contains("NotFound"));
        assert!(debug.contains("missing"));
    }
}
