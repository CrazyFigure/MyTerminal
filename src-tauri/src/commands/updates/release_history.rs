//! 升级区间的发布说明：完整遍历分页，并按应用语义版本筛选、去重和排序。

use crate::models::UpdateReleaseNotes;

use super::{fetch_release_response, parse_version_parts, GitHubReleaseResponse};

// GitHub 每页最多返回 100 条；遍历所有页而不是只读第一页，避免老版本升级时漏掉说明。
const RELEASES_PER_PAGE: usize = 100;
const RELEASES_API_URL: &str = "https://api.github.com/repos/CrazyFigure/MyTerminal/releases";

/// 正式版本比较键忽略 v 前缀、构建元数据和末尾零；预发布及资源包标签不属于应用升级区间。
fn stable_version_key(version: &str) -> Option<Vec<u64>> {
    let core = version.trim().split('+').next()?;
    if core.contains('-') {
        return None;
    }
    let mut parts = parse_version_parts(core)?;
    // 1.2 与 1.2.0 视为同一个版本，避免不同 tag 重复展示。
    while parts.last() == Some(&0) {
        parts.pop();
    }
    Some(parts)
}

/// 从原始发布记录提取展示数据；页面地址缺失时退回仓库发布列表，不拼接未经转义的 tag。
fn release_notes(release: &GitHubReleaseResponse) -> UpdateReleaseNotes {
    UpdateReleaseNotes {
        version: release.tag_name.trim_start_matches(['v', 'V']).to_string(),
        release_url: if release.html_url.is_empty() {
            "https://github.com/CrazyFigure/MyTerminal/releases".to_string()
        } else {
            release.html_url.clone()
        },
        published_at: release.published_at.clone(),
        body: release.body.clone(),
    }
}

/// 合并一页正式版本，只保留 current < version <= latest；保留 latest 接口提供的目标说明。
fn merge_release_page(
    notes: &mut Vec<UpdateReleaseNotes>,
    page: &[GitHubReleaseResponse],
    current: &str,
    latest: &str,
) {
    let (Some(current_key), Some(latest_key)) =
        (stable_version_key(current), stable_version_key(latest))
    else {
        return;
    };
    // GitHub 按发布时间而非语义版本排列，不能遇到旧版本就提前结束遍历。
    for release in page {
        if release.draft || release.prerelease {
            continue;
        }
        let Some(key) = stable_version_key(&release.tag_name) else {
            continue;
        };
        if key <= current_key || key > latest_key {
            continue;
        }
        if notes
            .iter()
            .any(|note| stable_version_key(&note.version).as_ref() == Some(&key))
        {
            continue;
        }
        notes.push(release_notes(release));
    }
    // 数字版本键排序避免 0.9.10 被当成小于 0.9.9，且不依赖发布日期。
    notes.sort_by_cached_key(|note| std::cmp::Reverse(stable_version_key(&note.version)));
}

/// Link 头决定是否存在下一页，避免整页数据恰好填满时额外发出空页请求。
fn has_next_page(link: Option<&str>) -> bool {
    link.is_some_and(|value| {
        value.split(',').any(|entry| {
            entry
                .split(';')
                .skip(1)
                .any(|part| part.trim() == "rel=\"next\"")
        })
    })
}

/// 先保留已确认的最新版本，再逐页补全历史；失败返回已有说明及不完整标记，不阻断安装。
pub(super) async fn load_release_history(
    current: &str,
    latest: &GitHubReleaseResponse,
) -> (Vec<UpdateReleaseNotes>, bool) {
    let mut notes = vec![release_notes(latest)];
    let mut page_number = 1;
    loop {
        let url = format!("{RELEASES_API_URL}?per_page={RELEASES_PER_PAGE}&page={page_number}");
        let response = match fetch_release_response(&url).await {
            Ok(response) => response,
            Err(_) => return (notes, false),
        };
        let has_next = has_next_page(
            response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|value| value.to_str().ok()),
        );
        let page = match response.json::<Vec<GitHubReleaseResponse>>().await {
            Ok(page) => page,
            Err(_) => return (notes, false),
        };
        merge_release_page(&mut notes, &page, current, &latest.tag_name);
        if !has_next {
            return (notes, true);
        }
        page_number += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试只构造发布元数据，不访问 GitHub 或触发安装流程。
    fn release(tag: &str) -> GitHubReleaseResponse {
        serde_json::from_value(serde_json::json!({
            "tag_name": tag,
            "html_url": format!("https://github.com/CrazyFigure/MyTerminal/releases/tag/{tag}"),
            "body": format!("{tag} 更新说明"),
        }))
        .unwrap()
    }

    #[test]
    fn filters_upgrade_range_and_sorts_numeric_versions() {
        let latest = release("v0.9.11");
        let mut notes = vec![release_notes(&latest)];
        let mut draft = release("v0.9.8");
        draft.draft = true;
        let mut prerelease = release("v0.9.7");
        prerelease.prerelease = true;
        let page = vec![
            release("v0.9.9"),
            release("v0.9.12"),
            release("v0.9.6"),
            release("v0.9.10"),
            release("v0.9.11"),
            release("fonts-v1.0.0"),
            release("v0.9.10-beta.1"),
            draft,
            prerelease,
        ];
        merge_release_page(&mut notes, &page, "0.9.6", &latest.tag_name);
        assert_eq!(
            notes
                .iter()
                .map(|note| note.version.as_str())
                .collect::<Vec<_>>(),
            vec!["0.9.11", "0.9.10", "0.9.9"]
        );
    }

    #[test]
    fn merges_multiple_pages_without_stopping_at_an_old_release() {
        let latest = release("v1.4.0");
        let mut notes = vec![release_notes(&latest)];
        merge_release_page(&mut notes, &[release("v1.0.0")], "1.1.0", &latest.tag_name);
        merge_release_page(
            &mut notes,
            &[release("v1.2.0"), release("v1.3.0")],
            "1.1.0",
            &latest.tag_name,
        );
        assert_eq!(
            notes
                .iter()
                .map(|note| note.version.as_str())
                .collect::<Vec<_>>(),
            vec!["1.4.0", "1.3.0", "1.2.0"]
        );
    }

    #[test]
    fn deduplicates_equivalent_tags_and_preserves_latest_body() {
        let latest = release("v1.3.0");
        let mut notes = vec![release_notes(&latest)];
        let mut duplicate = release("V1.3");
        duplicate.body = None;
        merge_release_page(
            &mut notes,
            &[duplicate, release("v1.2.0"), release("V1.2+build.5")],
            "1.1",
            &latest.tag_name,
        );
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].body.as_deref(), Some("v1.3.0 更新说明"));
    }

    #[test]
    fn retains_empty_notes_and_rejects_invalid_versions() {
        let latest = release("v2.0.0");
        let mut notes = vec![release_notes(&latest)];
        let mut empty = release("v1.5.0");
        empty.body = None;
        merge_release_page(
            &mut notes,
            &[empty, release("v1..7"), release("invalid")],
            "1.0.0",
            &latest.tag_name,
        );
        assert_eq!(notes.len(), 2);
        assert!(notes[1].body.is_none());
        assert_eq!(stable_version_key(" V1.2.0+build.1 "), Some(vec![1, 2]));
        assert!(stable_version_key("1.2.0-rc.1").is_none());
    }

    #[test]
    fn reads_next_page_relation_only() {
        assert!(has_next_page(Some("<https://api.github.com/releases?page=2>; rel=\"next\", <https://api.github.com/releases?page=5>; rel=\"last\"")));
        assert!(!has_next_page(Some(
            "<https://api.github.com/releases?page=1>; rel=\"prev\""
        )));
        assert!(!has_next_page(None));
    }
}
