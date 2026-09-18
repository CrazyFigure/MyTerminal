//! 系统已安装终端 (Shell) 动态探测器。
//! 仅在用户手动触发时执行探测，避免每次开启弹窗或启动应用时的性能损耗。

#[allow(unused_imports)]
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::models::LocalTerminalShellConfig;

#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 执行 where.exe 查找可执行文件绝对路径。
/// 设为 pub(super) 供本地终端兜底探测复用，确保两处 PATH 查找语义一致。
#[cfg(windows)]
pub(super) fn find_executable_in_path(executable: &str) -> Option<PathBuf> {
    let mut command = Command::new("where.exe");
    command.arg(executable);
    command.creation_flags(WINDOWS_CREATE_NO_WINDOW);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// 查询注册表字符串值（Windows）。
#[cfg(windows)]
fn query_windows_registry_value(key: &str, value_name: &str) -> Option<String> {
    let mut command = Command::new("reg.exe");
    command.args(["query", key, "/v", value_name]);
    command.creation_flags(WINDOWS_CREATE_NO_WINDOW);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(value_name) {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 3 {
                // REG_SZ 之后的内容可能包含空格，拼接后续部分
                let val = parts[2..].join(" ");
                return Some(val);
            }
        }
    }
    None
}

/// 解码 WSL 可能以 UTF-16LE 格式输出的标准输出。
#[cfg(windows)]
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[1] == 0 {
        let u16_vec: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16_lossy(&u16_vec)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

/// 探测当前系统中可用的本地终端 Shell 列表。
pub fn detect_available_system_shells() -> Vec<LocalTerminalShellConfig> {
    let mut shells = Vec::new();

    #[cfg(windows)]
    {
        // 1. 探测 PowerShell 7 (pwsh)
        let pwsh_candidates = [
            find_executable_in_path("pwsh.exe"),
            Some(PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")),
            Some(PathBuf::from(r"C:\Program Files\PowerShell\7-preview\pwsh.exe")),
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|val| PathBuf::from(val).join(r"Microsoft\PowerShell\pwsh.exe")),
        ];
        let mut pwsh_path: Option<PathBuf> = None;
        for candidate in pwsh_candidates.into_iter().flatten() {
            if candidate.is_file() {
                pwsh_path = Some(candidate);
                break;
            }
        }
        if let Some(path) = pwsh_path {
            shells.push(LocalTerminalShellConfig {
                id: "pwsh-7".into(),
                name: "PowerShell 7".into(),
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                icon: Some("/icons/powershell7.svg".into()),
                enabled: true,
            });
        }

        // 2. 探测 Windows PowerShell 5.1
        let winps_candidates = [
            std::env::var("SystemRoot").ok().map(|val| {
                PathBuf::from(val).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
            }),
            Some(PathBuf::from(
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            )),
            find_executable_in_path("powershell.exe"),
        ];
        let mut winps_path: Option<PathBuf> = None;
        for candidate in winps_candidates.into_iter().flatten() {
            if candidate.is_file() {
                winps_path = Some(candidate);
                break;
            }
        }
        if let Some(path) = winps_path {
            shells.push(LocalTerminalShellConfig {
                id: "powershell".into(),
                name: "PowerShell 5".into(),
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                icon: Some("/icons/powershell.svg".into()),
                enabled: true,
            });
        }

        // 3. 探测 Git Bash
        let mut git_bash_path: Option<PathBuf> = None;

        // 尝试从注册表获取 Git 安装目录
        let reg_install_path = query_windows_registry_value(
            r"HKLM\SOFTWARE\GitForWindows",
            "InstallPath",
        )
        .or_else(|| {
            query_windows_registry_value(r"HKCU\SOFTWARE\GitForWindows", "InstallPath")
        });

        if let Some(install_dir) = reg_install_path {
            let bash_candidate = PathBuf::from(install_dir).join(r"bin\bash.exe");
            if bash_candidate.is_file() {
                git_bash_path = Some(bash_candidate);
            }
        }

        // 常见路径与从 git.exe 衍生
        if git_bash_path.is_none() {
            let git_candidates = [
                PathBuf::from(r"C:\Software\Git\bin\bash.exe"),
                PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
                PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
                PathBuf::from(r"D:\Program Files\Git\bin\bash.exe"),
            ];
            for candidate in git_candidates {
                if candidate.is_file() {
                    git_bash_path = Some(candidate);
                    break;
                }
            }
        }

        if git_bash_path.is_none() {
            if let Some(git_exe) = find_executable_in_path("git.exe") {
                if let Some(parent) = git_exe.parent() {
                    // 通常是 .../cmd/git.exe 或 .../bin/git.exe
                    let root = parent.parent().unwrap_or(parent);
                    let bash_candidate = root.join(r"bin\bash.exe");
                    if bash_candidate.is_file() {
                        git_bash_path = Some(bash_candidate);
                    }
                }
            }
        }

        if let Some(path) = git_bash_path {
            shells.push(LocalTerminalShellConfig {
                id: "git-bash".into(),
                name: "Git Bash".into(),
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                icon: Some("/icons/git.svg".into()),
                enabled: true,
            });
        }

        // 4. 探测命令提示符 (CMD)
        let cmd_candidates = [
            std::env::var("SystemRoot")
                .ok()
                .map(|val| PathBuf::from(val).join(r"System32\cmd.exe")),
            Some(PathBuf::from(r"C:\Windows\System32\cmd.exe")),
            find_executable_in_path("cmd.exe"),
        ];
        let mut cmd_path: Option<PathBuf> = None;
        for candidate in cmd_candidates.into_iter().flatten() {
            if candidate.is_file() {
                cmd_path = Some(candidate);
                break;
            }
        }
        if let Some(path) = cmd_path {
            shells.push(LocalTerminalShellConfig {
                id: "cmd".into(),
                name: "CMD".into(),
                command: path.to_string_lossy().to_string(),
                args: Vec::new(),
                icon: Some("/icons/cmd.svg".into()),
                enabled: true,
            });
        }

        // 5. 探测 WSL 发行版
        let wsl_exe = find_executable_in_path("wsl.exe")
            .or_else(|| {
                let p = PathBuf::from(r"C:\Windows\System32\wsl.exe");
                if p.is_file() {
                    Some(p)
                } else {
                    None
                }
            });

        if let Some(wsl_path) = wsl_exe {
            let mut command = Command::new(&wsl_path);
            command.args(["-l", "-q"]);
            command.creation_flags(WINDOWS_CREATE_NO_WINDOW);

            if let Ok(output) = command.output() {
                if output.status.success() {
                    let decoded = decode_wsl_output(&output.stdout);
                    let mut wsl_distros = Vec::new();
                    for line in decoded.lines() {
                        let trimmed = line.trim().trim_matches('\0').trim();
                        if !trimmed.is_empty() && !trimmed.contains("Error") {
                            wsl_distros.push(trimmed.to_string());
                        }
                    }
                    let single_distro = wsl_distros.len() <= 1;
                    for distro in wsl_distros {
                        let name = if single_distro {
                            "WSL".to_string()
                        } else {
                            format!("WSL ({distro})")
                        };
                        let distro_lower = distro.to_lowercase();
                        // 单一发行版精简命名为 WSL 时使用官方通用 WSL 企鹅图标，与预设图标对齐
                        let icon = if single_distro {
                            Some("/icons/wsl.svg".into())
                        } else if distro_lower.contains("ubuntu") {
                            Some("/icons/ubuntu.svg".into())
                        } else if distro_lower.contains("debian") {
                            Some("/icons/debian.svg".into())
                        } else {
                            Some("/icons/wsl.svg".into())
                        };
                        shells.push(LocalTerminalShellConfig {
                            id: format!("wsl-{}", distro.to_lowercase().replace(' ', "-")),
                            name,
                            command: wsl_path.to_string_lossy().to_string(),
                            args: vec!["-d".into(), distro],
                            icon,
                            enabled: true,
                        });
                    }
                }
            }
        }

        // 6. 探测现代终端 (如 Nushell)
        if let Some(nu_path) = find_executable_in_path("nu.exe") {
            shells.push(LocalTerminalShellConfig {
                id: "nushell".into(),
                name: "Nushell".into(),
                command: nu_path.to_string_lossy().to_string(),
                args: Vec::new(),
                icon: Some("/icons/nu.svg".into()),
                enabled: true,
            });
        }
    }

    #[cfg(not(windows))]
    {
        for candidate in ["/bin/zsh", "/bin/bash", "/usr/bin/fish", "/bin/sh"] {
            let p = Path::new(candidate);
            if p.is_file() {
                let name = p
                    .file_name()
                    .and_then(|val| val.to_str())
                    .unwrap_or(candidate);
                shells.push(LocalTerminalShellConfig {
                    id: name.to_string(),
                    name: name.to_string(),
                    command: candidate.to_string(),
                    args: Vec::new(),
                    icon: Some(format!("/icons/{name}.svg")),
                    enabled: true,
                });
            }
        }
    }

    shells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_available_system_shells() {
        let shells = detect_available_system_shells();
        assert!(!shells.is_empty(), "应该能检测到至少一个系统 Shell");
    }
}
