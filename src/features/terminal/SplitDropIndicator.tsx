import { SPLIT_ANCHORS, splitMaskToGridArea, type SplitDropTarget, type SplitLayout } from './splitLayout';

type Props = {
  hint: string;
  layout: SplitLayout;
  target: SplitDropTarget | null;
  visible: boolean;
};

// 落点指示层：拖动时在终端区内浮出八个吸附点（四角 + 四边），淡淡显示以提示可去的位置；
// 指针靠近某点后，整块目标区域被预览出来——用户看到的就是松手后终端会变成的样子。
//
// 这里刻意不做居中的四方格缩略图：缩略图要求用户在"小图里的格子"和"屏幕上的真实区域"之间
// 做一次心算映射。八个点直接长在它们所代表的位置上，指哪打哪，不需要这层翻译。
export function SplitDropIndicator({ hint, layout, target, visible }: Props) {
  if (!visible) {
    return null;
  }

  // 预览区域的几何来源：新开/重塑/留在原处直接用掩码，移入某格用目标格自身的掩码。
  const previewMask = target && (target.kind === 'split' || target.kind === 'reshape' || target.kind === 'keep')
    ? target.mask
    : layout.panes.find((pane) => pane.id === (target as { paneId?: string } | null)?.paneId)?.mask;
  const activeAnchorId = previewMask === undefined
    ? undefined
    : SPLIT_ANCHORS.find((anchor) => anchor.mask === previewMask)?.id;

  return (
    <div aria-hidden="true" className="split-drop-layer">
      {previewMask === undefined ? null : (
        <div
          className={`split-drop-preview ${target?.kind === 'move' ? 'is-move' : ''}`}
          style={splitMaskToGridArea(previewMask)}
        >
          {hint ? <span className="split-drop-preview-hint">{hint}</span> : null}
        </div>
      )}
      {SPLIT_ANCHORS.map((anchor) => (
        <span
          key={anchor.id}
          className={`split-drop-anchor ${anchor.id === activeAnchorId ? 'is-active' : ''}`}
          // 吸附点用归一化坐标绝对定位，与判定用的坐标系完全一致，不会出现"看到的点和判定不符"。
          style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}
        />
      ))}
    </div>
  );
}
