import { useId, useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';

import { MarkdownView } from '../../MarkdownView';
import type { TranslationKey } from '../../i18n';
import type { UpdateCheckResult } from '../../types';

type Props = {
  result: UpdateCheckResult;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

/** 日期异常或缺失时不展示无效日期，版本说明仍可正常阅读。 */
function formatReleaseDate(value?: string) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

/**
 * 展示本次升级覆盖的版本；单版本默认展开，多版本默认全部折叠。
 * 展开状态只属于当前弹窗，不随下载进度重置；重新打开由父层重新挂载恢复默认状态。
 */
export function UpdateReleaseHistory({ result, t }: Props) {
  const panelId = useId();
  // 兼容仅含最新版本正文的旧结果；后端返回的历史已经按语义版本降序排列。
  const releases = result.releases?.length ? result.releases : [{
    version: result.latestVersion,
    publishedAt: result.publishedAt,
    body: result.releaseBody,
    releaseUrl: result.releaseUrl,
  }];
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(
    () => new Set(releases.length === 1 ? [releases[0].version] : []),
  );
  const allExpanded = releases.every((release) => expandedVersions.has(release.version));

  // 每个版本独立切换，允许同时对照多份说明，不强制只展开一项。
  const toggleVersion = (version: string) => {
    setExpandedVersions((current) => {
      const next = new Set(current);
      if (next.has(version)) {
        next.delete(version);
      } else {
        next.add(version);
      }
      return next;
    });
  };

  return (
    <section className="update-modal-notes" aria-label={t('updateReleaseNotes')}>
      <div className="update-notes-toolbar">
        <h4>{t('updateReleaseNotes')}</h4>
        {releases.length > 1 ? (
          <button
            className="update-notes-toggle-all"
            onClick={() => setExpandedVersions(
              allExpanded ? new Set() : new Set(releases.map((release) => release.version)),
            )}
            type="button"
          >
            {allExpanded ? t('updateCollapseAll') : t('updateExpandAll')}
          </button>
        ) : null}
      </div>
      {result.releaseHistoryComplete === false ? (
        <p className="update-notes-warning" role="status">
          <Info size={15} aria-hidden="true" />
          <span>{t('updateHistoryIncomplete')}</span>
        </p>
      ) : null}
      <div className="update-release-list">
        {releases.map((release, index) => {
          const expanded = expandedVersions.has(release.version);
          const date = formatReleaseDate(release.publishedAt);
          const contentId = `${panelId}-${index}`;
          return (
            <article className={`update-release-card${expanded ? ' is-expanded' : ''}`} key={release.version}>
              <button
                aria-controls={contentId}
                aria-expanded={expanded}
                className="update-release-trigger"
                onClick={() => toggleVersion(release.version)}
                type="button"
              >
                <span className="update-release-heading">
                  <strong className="update-release-version">v{release.version}</strong>
                  {release.version === result.latestVersion ? (
                    <span className="update-release-badge">{t('latestVersion')}</span>
                  ) : null}
                </span>
                <span className="update-release-trailing">
                  {date ? <time dateTime={release.publishedAt}>{date}</time> : null}
                  <ChevronDown className="update-release-chevron" size={16} aria-hidden="true" />
                </span>
              </button>
              <div className="update-release-content" hidden={!expanded} id={contentId}>
                {/* 仅在展开时渲染正文，多个长版本日志默认收起时不额外解析 Markdown。 */}
                {expanded ? (
                  release.body?.trim() ? <MarkdownView source={release.body} /> : (
                    <p className="update-modal-empty-notes">{t('updateNoReleaseNotes')}</p>
                  )
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
