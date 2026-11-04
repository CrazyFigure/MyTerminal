//! 固定的官方发布来源，统一发布页、分页接口和资源下载地址。

use super::{
    fetch_release_response, is_newer_version, parse_version_parts, select_update_installer_asset,
    GitHubReleaseResponse,
};
use crate::models::UpdateChannel;

const GITHUB_REPOSITORY: &str = "https://github.com/CrazyFigure/MyTerminal";
const CNB_REPOSITORY: &str = "https://cnb.cool/crazy-figure/MyTerminal";
const GITHUB_DOWNLOAD: &str = "https://github.com/CrazyFigure/MyTerminal/releases/download/";
const CNB_DOWNLOAD: &str = "https://cnb.cool/crazy-figure/MyTerminal/-/releases/download/";

impl UpdateChannel {
    /// CNB 的公开网页路由通过 Accept JSON 返回发布列表，无需向客户端分发令牌。
    pub(super) fn releases_url(self, page: usize, page_size: usize) -> String {
        match self {
            Self::Github => format!("https://api.github.com/repos/CrazyFigure/MyTerminal/releases?per_page={page_size}&page={page}"),
            Self::Cnb => format!("{CNB_REPOSITORY}/-/releases?page={page}&page_size={page_size}"),
        }
    }

    pub(super) fn release_url(self, tag: &str) -> String {
        let tag = urlencoding::encode(tag);
        match self {
            Self::Github => format!("{GITHUB_REPOSITORY}/releases/tag/{tag}"),
            Self::Cnb => format!("{CNB_REPOSITORY}/-/releases/tag/{tag}"),
        }
    }

    /// 只改写本项目官方附件的固定前缀，旧检测结果也能跟随用户新选择的下载渠道。
    pub(crate) fn download_url(self, url: &str) -> String {
        let suffix = url
            .strip_prefix(GITHUB_DOWNLOAD)
            .or_else(|| url.strip_prefix(CNB_DOWNLOAD));
        match suffix {
            Some(suffix) => format!(
                "{}{suffix}",
                match self {
                    Self::Github => GITHUB_DOWNLOAD,
                    Self::Cnb => CNB_DOWNLOAD,
                }
            ),
            None => url.to_string(),
        }
    }
}

/// GitHub 保持 latest 语义；CNB 列表按正式应用版本筛选，排除字体等独立资源发布。
async fn fetch_latest_release(channel: UpdateChannel) -> Result<GitHubReleaseResponse, String> {
    let release = match channel {
        UpdateChannel::Github => fetch_release_response(
            "https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest",
        )
        .await?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|error| format!("update_error:parse:{error}"))?,
        UpdateChannel::Cnb => {
            let mut latest: Option<GitHubReleaseResponse> = None;
            let mut page = 1;
            loop {
                let releases = fetch_release_response(&channel.releases_url(page, 100))
                    .await?
                    .json::<Vec<GitHubReleaseResponse>>()
                    .await
                    .map_err(|error| format!("update_error:parse:{error}"))?;
                let complete = releases.len() < 100;
                for release in releases {
                    if is_stable_app_release(&release)
                        && latest.as_ref().is_none_or(|previous| {
                            is_newer_version(&release.tag_name, &previous.tag_name)
                        })
                    {
                        latest = Some(release);
                    }
                }
                if complete {
                    break;
                }
                page += 1;
            }
            latest.ok_or_else(|| "update_error:parse:no stable CNB release".to_string())?
        }
    };
    if !is_stable_app_release(&release) {
        return Err("update_error:parse:invalid application release".to_string());
    }
    // 目标缺少安装包时允许改试镜像，避免把尚未上传完成的版本当成可用更新。
    if is_newer_version(&release.tag_name, env!("CARGO_PKG_VERSION"))
        && select_update_installer_asset(&release.assets).is_none()
    {
        return Err("update_error:parse:missing update installer".to_string());
    }
    Ok(release)
}

fn is_stable_app_release(release: &GitHubReleaseResponse) -> bool {
    !release.draft
        && !release.prerelease
        && !release
            .tag_name
            .split('+')
            .next()
            .unwrap_or_default()
            .contains('-')
        && parse_version_parts(&release.tag_name).is_some()
}

/// 优先使用已保存的渠道，失败后回退到另一渠道，完整解析成功才决定后续下载来源。
async fn first_available_release<F, Fut>(
    preferred: UpdateChannel,
    mut fetch: F,
) -> Result<(UpdateChannel, GitHubReleaseResponse), String>
where
    F: FnMut(UpdateChannel) -> Fut,
    Fut: std::future::Future<Output = Result<GitHubReleaseResponse, String>>,
{
    let fallback = match preferred {
        UpdateChannel::Github => UpdateChannel::Cnb,
        UpdateChannel::Cnb => UpdateChannel::Github,
    };
    match fetch(preferred).await {
        Ok(release) => Ok((preferred, release)),
        Err(preferred_error) => fetch(fallback)
            .await
            .map(|release| (fallback, release))
            .map_err(|fallback_error| {
                // 错误字段始终保持 GitHub、CNB 顺序，前端按来源展示时不会错配。
                let (github_error, cnb_error) = match preferred {
                    UpdateChannel::Github => (preferred_error, fallback_error),
                    UpdateChannel::Cnb => (fallback_error, preferred_error),
                };
                format!("update_error:channels:{github_error}|{cnb_error}")
            }),
    }
}

/// 返回首个可用的官方发布来源，自动检测和手动检测共用此顺序。
pub(super) async fn check_release(
    preferred: UpdateChannel,
) -> Result<(UpdateChannel, GitHubReleaseResponse), String> {
    first_available_release(preferred, fetch_latest_release).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_official_assets_in_both_directions() {
        let github = format!("{GITHUB_DOWNLOAD}v1.0.0/MyTerminal_setup.exe");
        let cnb = format!("{CNB_DOWNLOAD}v1.0.0/MyTerminal_setup.exe");
        assert_eq!(UpdateChannel::Cnb.download_url(&github), cnb);
        assert_eq!(UpdateChannel::Github.download_url(&cnb), github);
        assert_eq!(
            UpdateChannel::Cnb.download_url("https://example.com/a.exe"),
            "https://example.com/a.exe"
        );
        assert!(UpdateChannel::Cnb
            .releases_url(2, 100)
            .ends_with("page=2&page_size=100"));
    }

    #[test]
    fn old_and_unknown_settings_default_to_github() {
        let settings: crate::models::AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.update_channel, UpdateChannel::Github);
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"unknown\"").unwrap(),
            UpdateChannel::Github
        );
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"cnb\"").unwrap(),
            UpdateChannel::Cnb
        );
    }

    fn release(tag: &str) -> GitHubReleaseResponse {
        serde_json::from_value(serde_json::json!({ "tag_name": tag })).unwrap()
    }

    #[test]
    fn successful_github_check_skips_cnb() {
        let mut attempts = Vec::new();
        let result = tauri::async_runtime::block_on(first_available_release(
            UpdateChannel::Github,
            |channel| {
                attempts.push(channel);
                std::future::ready(Ok(release("v1.0.0")))
            },
        ))
        .unwrap();
        assert_eq!(attempts, vec![UpdateChannel::Github]);
        assert_eq!(result.0, UpdateChannel::Github);
    }

    #[test]
    fn github_failure_falls_back_to_cnb() {
        let mut attempts = Vec::new();
        let result = tauri::async_runtime::block_on(first_available_release(
            UpdateChannel::Github,
            |channel| {
                attempts.push(channel);
                std::future::ready(match channel {
                    UpdateChannel::Github => Err("update_error:network:offline".to_string()),
                    UpdateChannel::Cnb => Ok(release("v1.0.0")),
                })
            },
        ))
        .unwrap();
        assert_eq!(attempts, vec![UpdateChannel::Github, UpdateChannel::Cnb]);
        assert_eq!(result.0, UpdateChannel::Cnb);
    }

    #[test]
    fn both_failures_preserve_reasons() {
        for preferred in [UpdateChannel::Github, UpdateChannel::Cnb] {
            let error =
                tauri::async_runtime::block_on(first_available_release(preferred, |channel| {
                    std::future::ready(Err(match channel {
                        UpdateChannel::Github => "update_error:forbidden".to_string(),
                        UpdateChannel::Cnb => "update_error:parse:empty".to_string(),
                    }))
                }))
                .unwrap_err();
            assert_eq!(
                error,
                "update_error:channels:update_error:forbidden|update_error:parse:empty"
            );
        }
    }

    #[test]
    fn successful_preferred_cnb_check_skips_github() {
        let mut attempts = Vec::new();
        let result = tauri::async_runtime::block_on(first_available_release(
            UpdateChannel::Cnb,
            |channel| {
                attempts.push(channel);
                std::future::ready(Ok(release("v1.0.0")))
            },
        ))
        .unwrap();
        assert_eq!(attempts, vec![UpdateChannel::Cnb]);
        assert_eq!(result.0, UpdateChannel::Cnb);
    }

    #[test]
    fn preferred_cnb_failure_falls_back_to_github() {
        let mut attempts = Vec::new();
        let result = tauri::async_runtime::block_on(first_available_release(
            UpdateChannel::Cnb,
            |channel| {
                attempts.push(channel);
                std::future::ready(match channel {
                    UpdateChannel::Cnb => Err("update_error:network:offline".to_string()),
                    UpdateChannel::Github => Ok(release("v1.0.0")),
                })
            },
        ))
        .unwrap();
        assert_eq!(attempts, vec![UpdateChannel::Cnb, UpdateChannel::Github]);
        assert_eq!(result.0, UpdateChannel::Github);
    }

    #[test]
    fn cnb_metadata_without_html_url_and_resource_tags_are_handled() {
        let stable = release("v1.0.0");
        assert!(stable.html_url.is_empty());
        assert!(is_stable_app_release(&stable));
        assert!(!is_stable_app_release(&release("fonts-v1.0.0")));
        assert!(!is_stable_app_release(&release("v1.1.0-beta.1")));
        let mut draft = release("v1.1.0");
        draft.draft = true;
        assert!(!is_stable_app_release(&draft));
    }
}
