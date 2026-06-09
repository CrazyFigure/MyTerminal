use std::{fs, path::PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct CryptoService {
    key_path: PathBuf,
}

impl CryptoService {
    pub fn new(key_path: PathBuf) -> Result<Self, AppError> {
        if let Some(parent) = key_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if !key_path.exists() {
            let mut seed = [0_u8; 32];
            rand::thread_rng().fill_bytes(&mut seed);
            fs::write(&key_path, STANDARD.encode(seed))?;
        }

        Ok(Self { key_path })
    }

    fn load_master_key(&self) -> Result<[u8; 32], AppError> {
        let raw = fs::read_to_string(&self.key_path)?;
        let decoded = STANDARD
            .decode(raw.trim())
            .map_err(|error| AppError::Crypto(format!("failed to decode master key: {error}")))?;

        let digest = Sha256::digest(decoded);
        let mut key = [0_u8; 32];
        key.copy_from_slice(&digest[..32]);
        Ok(key)
    }

    fn cipher_from_key(key: &[u8; 32]) -> Result<Aes256Gcm, AppError> {
        Aes256Gcm::new_from_slice(key)
            .map_err(|error| AppError::Crypto(format!("failed to create cipher: {error}")))
    }

    fn encrypt_with_key(key: &[u8; 32], plaintext: &str) -> Result<String, AppError> {
        let cipher = Self::cipher_from_key(key)?;
        let mut nonce = [0_u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);

        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .map_err(|error| AppError::Crypto(format!("failed to encrypt: {error}")))?;

        let mut payload = nonce.to_vec();
        payload.extend(ciphertext);
        Ok(STANDARD.encode(payload))
    }

    fn decrypt_with_key(key: &[u8; 32], payload: &str) -> Result<String, AppError> {
        if payload.is_empty() {
            return Ok(String::new());
        }

        let decoded = STANDARD
            .decode(payload)
            .map_err(|error| AppError::Crypto(format!("failed to decode payload: {error}")))?;

        if decoded.len() < 13 {
            return Err(AppError::Crypto("invalid encrypted payload".into()));
        }

        let (nonce, ciphertext) = decoded.split_at(12);
        let cipher = Self::cipher_from_key(key)?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|error| AppError::Crypto(format!("failed to decrypt: {error}")))?;

        String::from_utf8(plaintext)
            .map_err(|error| AppError::Crypto(format!("invalid utf-8 payload: {error}")))
    }

    pub fn encrypt_local(&self, plaintext: &str) -> Result<String, AppError> {
        let key = self.load_master_key()?;
        Self::encrypt_with_key(&key, plaintext)
    }

    pub fn decrypt_local(&self, payload: &str) -> Result<String, AppError> {
        let key = self.load_master_key()?;
        Self::decrypt_with_key(&key, payload)
    }

    pub fn encrypt_for_sync(&self, passphrase: &str, plaintext: &str) -> Result<String, AppError> {
        if passphrase.trim().is_empty() {
            return Err(AppError::Validation(
                "A sync passphrase is required before uploading to WebDAV".into(),
            ));
        }

        let digest = Sha256::digest(passphrase.as_bytes());
        let mut key = [0_u8; 32];
        key.copy_from_slice(&digest[..32]);
        Self::encrypt_with_key(&key, plaintext)
    }

    pub fn decrypt_from_sync(&self, passphrase: &str, payload: &str) -> Result<String, AppError> {
        if passphrase.trim().is_empty() {
            return Err(AppError::Validation(
                "A sync passphrase is required before downloading from WebDAV".into(),
            ));
        }

        let digest = Sha256::digest(passphrase.as_bytes());
        let mut key = [0_u8; 32];
        key.copy_from_slice(&digest[..32]);
        Self::decrypt_with_key(&key, payload)
    }
}

