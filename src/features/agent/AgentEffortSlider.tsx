import type { CSSProperties } from "react";

import type { AgentEffort } from "../../types";

/** 档位从左到右排列；“默认”表示不下发该参数，放在最左侧。 */
const EFFORT_LEVELS: AgentEffort[] = ["default", "low", "medium", "high", "xhigh", "max"];

type Props = {
  ariaLabel: string;
  /** “默认”档的展示文案，其余档位直接显示 API 取值。 */
  defaultLabel: string;
  onChange: (effort: AgentEffort) => void;
  value: AgentEffort;
};

// 分段滑杆：轨道 + 圆点刻度 + 下方档位名。视觉层只负责绘制，拖动与键盘操作交给覆盖在上面的透明原生 range，
// 天然支持方向键、Home/End 与无障碍读屏；档位名本身也可点击直接跳转。
export function AgentEffortSlider({ ariaLabel, defaultLabel, onChange, value }: Props) {
  const index = Math.max(0, EFFORT_LEVELS.indexOf(value));
  const last = EFFORT_LEVELS.length - 1;
  const labelOf = (level: AgentEffort) => (level === "default" ? defaultLabel : level);

  return (
    <div
      className="agent-effort-slider"
      // 当前进度以比例下发给样式表，填充段与滑块共用同一个变量保证对齐。
      style={{ "--effort-progress": index / last } as CSSProperties}
    >
      <div className="agent-effort-track">
        <div className="agent-effort-rail" />
        <div className="agent-effort-fill" />
        {EFFORT_LEVELS.map((level, levelIndex) => (
          <span
            key={level}
            className={`agent-effort-dot ${levelIndex <= index ? "is-passed" : ""}`}
            style={{ "--effort-stop": levelIndex / last } as CSSProperties}
          />
        ))}
        <span className="agent-effort-knob" />
        <input
          aria-label={ariaLabel}
          aria-valuetext={labelOf(EFFORT_LEVELS[index])}
          max={last}
          min={0}
          onChange={(event) => onChange(EFFORT_LEVELS[Number(event.target.value)])}
          step={1}
          type="range"
          value={index}
        />
      </div>
      <div className="agent-effort-labels">
        {EFFORT_LEVELS.map((level, levelIndex) => (
          <button
            key={level}
            className={levelIndex === index ? "is-active" : ""}
            onClick={() => onChange(level)}
            tabIndex={-1}
            type="button"
          >
            {labelOf(level)}
          </button>
        ))}
      </div>
    </div>
  );
}
