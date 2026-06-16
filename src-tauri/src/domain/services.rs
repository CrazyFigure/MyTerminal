use std::path::PathBuf;

use serde::Deserialize;

use crate::domain::errors::DomainError;

// ── 隧道校验 ──

pub fn validate_tunnel_fields(
    connection_id: &str,
    name: &str,
    bind_address: &str,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> Result<(), DomainError> {
    if connection_id.trim().is_empty() {
        return Err(DomainError::Validation(
            "tunnel connection is required".into(),
        ));
    }
    if name.trim().is_empty() {
        return Err(DomainError::Validation("tunnel name is required".into()));
    }
    if bind_address.trim().is_empty() {
        return Err(DomainError::Validation(
            "tunnel bind address is required".into(),
        ));
    }
    if local_port == 0 || remote_port == 0 {
        return Err(DomainError::Validation(
            "tunnel ports must be between 1 and 65535".into(),
        ));
    }
    if remote_host.trim().is_empty() {
        return Err(DomainError::Validation(
            "tunnel remote host is required".into(),
        ));
    }
    Ok(())
}

// ── 版本比较 ──

pub fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
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

pub fn is_newer_version(latest: &str, current: &str) -> bool {
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

// ── 安装包选择 ──

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: Option<u64>,
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

pub fn select_update_installer_asset(assets: &[GitHubReleaseAsset]) -> Option<GitHubReleaseAsset> {
    assets
        .iter()
        .filter_map(|asset| {
            let score = installer_asset_score(&asset.name);
            (score >= 0).then_some((score, asset))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset.clone())
}

// ── 文件名校验 ──

pub fn sanitize_asset_file_name(asset_name: &str) -> String {
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

pub fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    (normalized.starts_with("https://") || normalized.starts_with("http://"))
        && (normalized.ends_with(".exe") || normalized.ends_with(".msi"))
        && !normalized.chars().any(|character| character.is_control())
}

// ── 路径操作 ──

pub fn normalize_remote_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

pub fn remote_file_name(path: &str) -> Option<String> {
    normalize_remote_path(path)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = normalize_remote_path(remote_dir);
    let name = normalize_remote_path(file_name)
        .trim_matches('/')
        .to_string();
    if base == "." || base.is_empty() {
        name
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

// ── 语言检测 ──

pub fn detect_language(path: &str) -> String {
    if path.ends_with(".rs") {
        "rust".into()
    } else if path.ends_with(".ts") || path.ends_with(".tsx") {
        "typescript".into()
    } else if path.ends_with(".json") {
        "json".into()
    } else if path.ends_with(".yml") || path.ends_with(".yaml") {
        "yaml".into()
    } else if path.ends_with(".conf") || path.ends_with(".ini") {
        "ini".into()
    } else if path.ends_with(".md") {
        "markdown".into()
    } else {
        "shell".into()
    }
}

// ── Shell 命令 ──

pub fn shell_cwd_sync_command() -> String {
    [
        "__myterminal_sync_cwd(){ printf '\\033]6973;MyTerminalCwd=%s\\a' \"$PWD\"; }",
        "__myterminal_sync_history(){ if [ -n \"${ZSH_VERSION-}\" ]; then fc -AI 2>/dev/null || true; elif [ -n \"${BASH_VERSION-}\" ]; then history -a 2>/dev/null || true; fi; }",
        "__myterminal_sync_prompt(){ __myterminal_sync_history; __myterminal_sync_cwd; }",
        "if [ -n \"${BASH_VERSION-}${ZSH_VERSION-}\" ]; then cd(){ builtin cd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; pushd(){ builtin pushd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; popd(){ builtin popd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; fi",
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __myterminal_sync_prompt 2>/dev/null || PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "elif [ -n \"${BASH_VERSION-}\" ]; then PROMPT_COMMAND=\"__myterminal_sync_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"",
        "else PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "fi",
        "__myterminal_sync_prompt",
        "\n",
    ]
    .join("; ")
}

// ── 工具函数 ──

pub fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub fn expand_home_path(raw_path: &str) -> PathBuf {
    let trimmed = raw_path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let mut expanded = PathBuf::from(home);
            if trimmed.len() > 2 {
                expanded.push(&trimmed[2..]);
            }
            return expanded;
        }
    }

    PathBuf::from(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::errors::DomainError;

    // ── validate_tunnel_fields ──

    #[test]
    fn test_validate_tunnel_fields_ok() {
        assert!(
            validate_tunnel_fields("conn1", "My Tunnel", "0.0.0.0", 22, "example.com", 443).is_ok()
        );
    }

    #[test]
    fn test_validate_tunnel_fields_empty_connection_id() {
        let err = validate_tunnel_fields("", "name", "0.0.0.0", 22, "host", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("connection")));
    }

    #[test]
    fn test_validate_tunnel_fields_whitespace_connection_id() {
        let err = validate_tunnel_fields("   ", "name", "0.0.0.0", 22, "host", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("connection")));
    }

    #[test]
    fn test_validate_tunnel_fields_empty_name() {
        let err = validate_tunnel_fields("conn1", "", "0.0.0.0", 22, "host", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("name")));
    }

    #[test]
    fn test_validate_tunnel_fields_empty_bind_address() {
        let err = validate_tunnel_fields("conn1", "name", "", 22, "host", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("bind address")));
    }

    #[test]
    fn test_validate_tunnel_fields_local_port_zero() {
        let err = validate_tunnel_fields("conn1", "name", "0.0.0.0", 0, "host", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("ports")));
    }

    #[test]
    fn test_validate_tunnel_fields_remote_port_zero() {
        let err = validate_tunnel_fields("conn1", "name", "0.0.0.0", 22, "host", 0).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("ports")));
    }

    #[test]
    fn test_validate_tunnel_fields_empty_remote_host() {
        let err = validate_tunnel_fields("conn1", "name", "0.0.0.0", 22, "", 443).unwrap_err();
        assert!(matches!(&err, DomainError::Validation(msg) if msg.contains("remote host")));
    }

    // ── parse_version_parts ──

    #[test]
    fn test_parse_version_parts_normal() {
        assert_eq!(parse_version_parts("v1.2.3"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_parse_version_parts_no_v_prefix() {
        assert_eq!(parse_version_parts("1.2.3"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_parse_version_parts_lowercase_v() {
        assert_eq!(parse_version_parts("V1.2.3"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_parse_version_parts_with_prerelease() {
        assert_eq!(parse_version_parts("v1.2.3-beta"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_parse_version_parts_with_build() {
        assert_eq!(parse_version_parts("v1.2.3+build.1"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_parse_version_parts_with_prerelease_and_build() {
        assert_eq!(
            parse_version_parts("v1.2.3-alpha+build.42"),
            Some(vec![1, 2, 3])
        );
    }

    #[test]
    fn test_parse_version_parts_more_parts() {
        assert_eq!(parse_version_parts("v1.2.3.4"), Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn test_parse_version_parts_zeroes() {
        assert_eq!(parse_version_parts("v0.0.0"), Some(vec![0, 0, 0]));
    }

    #[test]
    fn test_parse_version_parts_empty_segment() {
        assert_eq!(parse_version_parts("1..3"), None);
    }

    #[test]
    fn test_parse_version_parts_non_numeric_segment() {
        assert_eq!(parse_version_parts("1.a.3"), None);
    }

    #[test]
    fn test_parse_version_parts_empty_string() {
        assert_eq!(parse_version_parts(""), None);
    }

    #[test]
    fn test_parse_version_parts_whitespace() {
        assert_eq!(parse_version_parts("  v1.2.3  "), Some(vec![1, 2, 3]));
    }

    // ── is_newer_version ──

    #[test]
    fn test_is_newer_version_true() {
        assert!(is_newer_version("v2.0.0", "v1.0.0"));
    }

    #[test]
    fn test_is_newer_version_false() {
        assert!(!is_newer_version("v1.0.0", "v2.0.0"));
    }

    #[test]
    fn test_is_newer_version_equal() {
        assert!(!is_newer_version("v1.0.0", "v1.0.0"));
    }

    #[test]
    fn test_is_newer_version_diff_length_larger() {
        assert!(is_newer_version("v2", "v1.0.0"));
    }

    #[test]
    fn test_is_newer_version_diff_length_smaller() {
        assert!(!is_newer_version("v1.0.0", "v2"));
    }

    #[test]
    fn test_is_newer_version_equal_diff_length() {
        assert!(!is_newer_version("v2", "v2.0.0"));
    }

    #[test]
    fn test_is_newer_version_major_wins() {
        assert!(is_newer_version("v2.0.0", "v1.99.99"));
    }

    #[test]
    fn test_is_newer_version_patch_wins() {
        assert!(is_newer_version("v1.0.10", "v1.0.9"));
    }

    #[test]
    fn test_is_newer_version_invalid_latest() {
        assert!(!is_newer_version("invalid", "v1.0.0"));
    }

    #[test]
    fn test_is_newer_version_invalid_current() {
        assert!(!is_newer_version("v1.0.0", "invalid"));
    }

    #[test]
    fn test_is_newer_version_both_invalid() {
        assert!(!is_newer_version("bad", "wrong"));
    }

    // ── select_update_installer_asset ──

    #[test]
    fn test_select_update_installer_asset_prefers_exe_over_msi() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "installer.msi".into(),
                browser_download_url: "https://example.com/installer.msi".into(),
                size: Some(100),
            },
            GitHubReleaseAsset {
                name: "installer.exe".into(),
                browser_download_url: "https://example.com/installer.exe".into(),
                size: Some(200),
            },
        ];
        let result = select_update_installer_asset(&assets);
        assert!(result.is_some());
        assert!(result.unwrap().name.ends_with(".exe"));
    }

    #[test]
    fn test_select_update_installer_asset_prefers_setup_windows_x64() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "MyTerminal_x86.exe".into(),
                browser_download_url: "https://example.com/a.exe".into(),
                size: None,
            },
            GitHubReleaseAsset {
                name: "MyTerminal_x64_setup_windows.exe".into(),
                browser_download_url: "https://example.com/b.exe".into(),
                size: None,
            },
        ];
        let result = select_update_installer_asset(&assets);
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "MyTerminal_x64_setup_windows.exe");
    }

    #[test]
    fn test_select_update_installer_asset_no_match_returns_none() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "source_code.tar.gz".into(),
                browser_download_url: "https://example.com/code.tar.gz".into(),
                size: None,
            },
            GitHubReleaseAsset {
                name: "MyTerminal.dmg".into(),
                browser_download_url: "https://example.com/app.dmg".into(),
                size: None,
            },
        ];
        assert!(select_update_installer_asset(&assets).is_none());
    }

    #[test]
    fn test_select_update_installer_asset_empty_list() {
        let assets: Vec<GitHubReleaseAsset> = vec![];
        assert!(select_update_installer_asset(&assets).is_none());
    }

    #[test]
    fn test_select_update_installer_asset_single_exe() {
        let assets = vec![GitHubReleaseAsset {
            name: "app.exe".into(),
            browser_download_url: "https://example.com/app.exe".into(),
            size: Some(42),
        }];
        let result = select_update_installer_asset(&assets);
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "app.exe");
    }

    #[test]
    fn test_select_update_installer_asset_prefers_nsis() {
        let assets = vec![
            GitHubReleaseAsset {
                name: "MyTerminal_x64_setup.exe".into(),
                browser_download_url: "https://example.com/a.exe".into(),
                size: None,
            },
            GitHubReleaseAsset {
                name: "MyTerminal_x64_setup_nsis.exe".into(),
                browser_download_url: "https://example.com/b.exe".into(),
                size: None,
            },
        ];
        let result = select_update_installer_asset(&assets);
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "MyTerminal_x64_setup_nsis.exe");
    }

    // ── sanitize_asset_file_name ──

    #[test]
    fn test_sanitize_asset_file_name_normal() {
        assert_eq!(
            sanitize_asset_file_name("MyTerminal_1.0.0_x64-setup.exe"),
            "MyTerminal_1.0.0_x64-setup.exe"
        );
    }

    #[test]
    fn test_sanitize_asset_file_name_special_chars() {
        assert_eq!(
            sanitize_asset_file_name("My Terminal (1).exe"),
            "My_Terminal__1_.exe"
        );
    }

    #[test]
    fn test_sanitize_asset_file_name_all_special() {
        assert_eq!(
            sanitize_asset_file_name("!!!@@@###"),
            "MyTerminal-update.exe"
        );
    }

    #[test]
    fn test_sanitize_asset_file_name_empty_result_fallback() {
        assert_eq!(sanitize_asset_file_name("____"), "MyTerminal-update.exe");
    }

    // ── is_valid_update_download_url ──

    #[test]
    fn test_is_valid_update_download_url_https_exe() {
        assert!(is_valid_update_download_url("https://example.com/app.exe"));
    }

    #[test]
    fn test_is_valid_update_download_url_http_msi() {
        assert!(is_valid_update_download_url("http://example.com/app.msi"));
    }

    #[test]
    fn test_is_valid_update_download_url_no_protocol() {
        assert!(!is_valid_update_download_url("example.com/app.exe"));
    }

    #[test]
    fn test_is_valid_update_download_url_wrong_extension() {
        assert!(!is_valid_update_download_url(
            "https://example.com/app.tar.gz"
        ));
    }

    #[test]
    fn test_is_valid_update_download_url_control_chars() {
        // Use a control character that is NOT whitespace (trim won't remove it)
        assert!(!is_valid_update_download_url(
            "https://example.com/app\x01.exe"
        ));
    }

    #[test]
    fn test_is_valid_update_download_url_ftp_protocol() {
        assert!(!is_valid_update_download_url("ftp://example.com/app.exe"));
    }

    #[test]
    fn test_is_valid_update_download_url_trim_whitespace() {
        assert!(is_valid_update_download_url(
            "  https://example.com/app.exe  "
        ));
    }

    // ── normalize_remote_path ──

    #[test]
    fn test_normalize_remote_path_normal() {
        assert_eq!(
            normalize_remote_path("/home/user/file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_normalize_remote_path_backslash() {
        assert_eq!(normalize_remote_path("C:\\Users\\test"), "C:/Users/test");
    }

    #[test]
    fn test_normalize_remote_path_empty() {
        assert_eq!(normalize_remote_path(""), ".");
    }

    #[test]
    fn test_normalize_remote_path_whitespace() {
        assert_eq!(normalize_remote_path("  /path/to/dir  "), "/path/to/dir");
    }

    // ── remote_file_name ──

    #[test]
    fn test_remote_file_name_normal_file() {
        assert_eq!(
            remote_file_name("/home/user/file.txt"),
            Some("file.txt".into())
        );
    }

    #[test]
    fn test_remote_file_name_directory() {
        assert_eq!(remote_file_name("/home/user/"), Some("user".into()));
    }

    #[test]
    fn test_remote_file_name_root() {
        assert_eq!(remote_file_name("/"), None);
    }

    #[test]
    fn test_remote_file_name_empty() {
        // normalize_remote_path("") returns ".", so the result is Some(".")
        assert_eq!(remote_file_name(""), Some(".".into()));
    }

    #[test]
    fn test_remote_file_name_just_filename() {
        assert_eq!(remote_file_name("file.txt"), Some("file.txt".into()));
    }

    #[test]
    fn test_remote_file_name_backslash() {
        assert_eq!(
            remote_file_name("home\\user\\file.txt"),
            Some("file.txt".into())
        );
    }

    #[test]
    fn test_remote_file_name_current_dir() {
        assert_eq!(remote_file_name("."), Some(".".into()));
    }

    // ── join_remote_path ──

    #[test]
    fn test_join_remote_path_normal() {
        assert_eq!(
            join_remote_path("/home/user", "file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_join_remote_path_root() {
        assert_eq!(join_remote_path("/", "file.txt"), "/file.txt");
    }

    #[test]
    fn test_join_remote_path_current_dir() {
        assert_eq!(join_remote_path(".", "file.txt"), "file.txt");
    }

    #[test]
    fn test_join_remote_path_empty_dir() {
        assert_eq!(join_remote_path("", "file.txt"), "file.txt");
    }

    #[test]
    fn test_join_remote_path_trailing_slash() {
        assert_eq!(
            join_remote_path("/home/user/", "file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn test_join_remote_path_backslash_dir() {
        assert_eq!(
            join_remote_path("home\\user", "file.txt"),
            "home/user/file.txt"
        );
    }

    // ── detect_language ──

    #[test]
    fn test_detect_language_rust() {
        assert_eq!(detect_language("main.rs"), "rust");
    }

    #[test]
    fn test_detect_language_typescript() {
        assert_eq!(detect_language("app.ts"), "typescript");
    }

    #[test]
    fn test_detect_language_typescript_react() {
        assert_eq!(detect_language("component.tsx"), "typescript");
    }

    #[test]
    fn test_detect_language_json() {
        assert_eq!(detect_language("package.json"), "json");
    }

    #[test]
    fn test_detect_language_yml() {
        assert_eq!(detect_language("config.yml"), "yaml");
    }

    #[test]
    fn test_detect_language_yaml() {
        assert_eq!(detect_language("config.yaml"), "yaml");
    }

    #[test]
    fn test_detect_language_conf() {
        assert_eq!(detect_language("nginx.conf"), "ini");
    }

    #[test]
    fn test_detect_language_ini() {
        assert_eq!(detect_language("settings.ini"), "ini");
    }

    #[test]
    fn test_detect_language_markdown() {
        assert_eq!(detect_language("README.md"), "markdown");
    }

    #[test]
    fn test_detect_language_unknown() {
        assert_eq!(detect_language("script.py"), "shell");
    }

    #[test]
    fn test_detect_language_no_extension() {
        assert_eq!(detect_language("Makefile"), "shell");
    }

    // ── shell_cwd_sync_command ──

    #[test]
    fn test_shell_cwd_sync_command_not_empty() {
        let cmd = shell_cwd_sync_command();
        assert!(!cmd.is_empty(), "command should not be empty");
    }

    #[test]
    fn test_shell_cwd_sync_command_contains_keywords() {
        let cmd = shell_cwd_sync_command();
        assert!(cmd.contains("sync_cwd"), "should contain sync_cwd");
        assert!(cmd.contains("sync_history"), "should contain sync_history");
        assert!(
            cmd.contains("PROMPT_COMMAND"),
            "should contain PROMPT_COMMAND"
        );
    }

    #[test]
    fn test_shell_cwd_sync_command_structure() {
        let cmd = shell_cwd_sync_command();
        assert!(
            cmd.contains("__myterminal_sync_cwd"),
            "should define sync_cwd function"
        );
        assert!(
            cmd.contains("__myterminal_sync_prompt"),
            "should define sync_prompt function"
        );
        assert!(cmd.contains("builtin cd"), "should wrap cd");
    }

    // ── non_empty_trimmed ──

    #[test]
    fn test_non_empty_trimmed_some_value() {
        assert_eq!(non_empty_trimmed(Some("  value  ")), Some("value"));
    }

    #[test]
    fn test_non_empty_trimmed_some_empty() {
        assert_eq!(non_empty_trimmed(Some("")), None);
    }

    #[test]
    fn test_non_empty_trimmed_some_whitespace() {
        assert_eq!(non_empty_trimmed(Some("   ")), None);
    }

    #[test]
    fn test_non_empty_trimmed_none() {
        assert_eq!(non_empty_trimmed(None), None);
    }

    // ── expand_home_path ──

    #[test]
    fn test_expand_home_path_tilde() {
        std::env::set_var("HOME", "/home/testuser");
        let result = expand_home_path("~");
        assert_eq!(result, std::path::PathBuf::from("/home/testuser"));
    }

    #[test]
    fn test_expand_home_path_tilde_path() {
        std::env::set_var("HOME", "/home/testuser");
        let result = expand_home_path("~/documents");
        assert_eq!(result, std::path::PathBuf::from("/home/testuser/documents"));
    }

    #[test]
    fn test_expand_home_path_tilde_backslash() {
        std::env::set_var("HOME", "/home/testuser");
        let result = expand_home_path("~\\documents");
        assert_eq!(result, std::path::PathBuf::from("/home/testuser/documents"));
    }

    #[test]
    fn test_expand_home_path_normal() {
        let result = expand_home_path("/absolute/path");
        assert_eq!(result, std::path::PathBuf::from("/absolute/path"));
    }

    #[test]
    fn test_expand_home_path_relative() {
        let result = expand_home_path("relative/path");
        assert_eq!(result, std::path::PathBuf::from("relative/path"));
    }

    #[test]
    fn test_expand_home_path_tilde_other_user() {
        let result = expand_home_path("~other/path");
        assert_eq!(result, std::path::PathBuf::from("~other/path"));
    }

    #[test]
    fn test_expand_home_path_trimmed() {
        std::env::set_var("HOME", "/home/testuser");
        let result = expand_home_path("  ~/path  ");
        assert_eq!(result, std::path::PathBuf::from("/home/testuser/path"));
    }
}
