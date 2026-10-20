import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronRight, Info } from 'lucide-react';

import { MarkdownView } from '../../MarkdownView';
import type { TranslationKey } from '../../i18n';
import type { UpdateCheckResult, UpdateReleaseNotes } from '../../types';
import { parseReleaseNotes, type ReleaseNoteKind } from './releaseNotes';

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
  if (Number.isNaN(date.getTime())) return '';
  // 与参考项目一致使用紧凑的年月日格式，版本栏宽度不随系统日期格式变化。
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 分类名称跟随界面语言，原始发布说明继续按 Release 正文展示。
const kindLabels: Record<ReleaseNoteKind, TranslationKey> = {
  added: 'updateNotesAdded',
  fixed: 'updateNotesFixed',
  improved: 'updateNotesImproved',
  other: 'updateNotesOther',
};

/** 单个版本使用左侧箭头、折叠摘要和展开动画；正文首次展开后保留，以支持收起过渡。 */
function ReleaseCard({ release, latest, expanded, onToggle, t }: {
  release: UpdateReleaseNotes;
  latest: boolean;
  expanded: boolean;
  onToggle: () => void;
  t: Props['t'];
}) {
  const contentId = useId();
  const sections = useMemo(() => parseReleaseNotes(release.body ?? ''), [release.body]);
  const summary = useMemo(() => (Object.keys(kindLabels) as ReleaseNoteKind[]).map((kind) => ({
    kind,
    count: sections.filter((section) => section.title && section.kind === kind)
      .reduce((total, section) => total + section.count, 0),
  })).filter((item) => item.count > 0), [sections]);
  const [bodyMounted, setBodyMounted] = useState(expanded);
  const date = formatReleaseDate(release.publishedAt);

  // 默认收起的版本不解析 Markdown；首次展开后仅改变可见性，快速连续切换也能平滑回退。
  useEffect(() => {
    if (expanded) setBodyMounted(true);
  }, [expanded]);

  return (
    <article className={`update-release-card${expanded ? ' is-expanded' : ''}`}>
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="update-release-trigger"
        onClick={onToggle}
        type="button"
      >
        <ChevronRight className="update-release-chevron" size={15} aria-hidden="true" />
        <strong className="update-release-version">v{release.version}</strong>
        {latest ? <span className="update-release-badge">{t('latestVersion')}</span> : null}
        {/* 展开后隐藏重复摘要，并保留其横向空间，使日期始终靠右。 */}
        <span className="update-release-summary" aria-hidden={expanded}>
          {summary.map(({ kind, count }) => (
            <span className={`update-release-summary-item is-${kind}`} key={kind}>
              <i aria-hidden="true" />{t(kindLabels[kind])} {count}
            </span>
          ))}
        </span>
        {date ? <time className="update-release-date" dateTime={release.publishedAt}>{date}</time> : null}
      </button>
      {/* 收起内容立即退出键盘和辅助技术导航，视觉动画结束后再隐藏。 */}
      <div className="update-release-body" aria-hidden={!expanded} inert={!expanded} id={contentId}>
        <div className="update-release-content">
          {expanded || bodyMounted ? (
            sections.length ? sections.map((section, index) => (
              <div className={`update-release-section is-${section.kind}`} key={index}>
                {section.title ? <h5 className="update-release-section-title">{section.title}</h5> : null}
                {section.source ? <MarkdownView source={section.source} /> : null}
              </div>
            )) : <p className="update-modal-empty-notes">{t('updateNoReleaseNotes')}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/**
 * 展示本次升级覆盖的版本；单版本默认展开，多版本默认全部折叠。
 * 展开状态只属于当前弹窗，不随下载进度重置；重新打开由父层重新挂载恢复默认状态。
 */
export function UpdateReleaseHistory({ result, t }: Props) {
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
        {releases.map((release) => (
          <ReleaseCard
            key={release.version}
            release={release}
            latest={release.version === result.latestVersion}
            expanded={expandedVersions.has(release.version)}
            onToggle={() => toggleVersion(release.version)}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}
