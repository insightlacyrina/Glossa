import { useState } from 'react';
import './ink-color.css';

const inkPresets = [
  ['墨黑', '#3f3b42'],
  ['苔绿', '#67755d'],
  ['赭棕', '#926c59'],
  ['靛蓝', '#3c5890'],
  ['朱红', '#a54048'],
  ['藤紫', '#705787'],
  ['深青', '#306d72'],
  ['赭金', '#8b671e'],
] as const;
export const quickInkColors = inkPresets.slice(0, 3);
const inkColorKey = 'glossa:ink-color';
const validInkColor = /^#[0-9a-f]{6}$/i;

export function readInkColor() {
  try {
    const color = localStorage.getItem(inkColorKey);
    if (color && validInkColor.test(color)) return color;
  } catch {
    // The active color can still be used when local storage is unavailable.
  }
  return inkPresets[0][1];
}

export function saveInkColor(color: string) {
  try {
    localStorage.setItem(inkColorKey, color);
  } catch {
    // The active color is kept in the current window.
  }
}

export function InkColorPicker({
  color,
  onChoose,
}: {
  color: string;
  onChoose: (color: string) => void;
}) {
  const [custom, setCustom] = useState(color);
  const valid = validInkColor.test(custom);
  return (
    <div className="ink-color-picker">
      <div className="ink-palette" role="group" aria-label="预设墨色">
        {inkPresets.map(([label, value]) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === color}
            onClick={() => onChoose(value)}
          >
            <span className="ink-swatch" style={{ backgroundColor: value }} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <form
        className="ink-color-custom"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onChoose(custom.toLowerCase());
        }}
      >
        <label>
          自定义颜色
          <input
            type="color"
            value={valid ? custom : color}
            onChange={(event) => setCustom(event.target.value)}
          />
        </label>
        <label>
          色值
          <input
            type="text"
            value={custom}
            onChange={(event) => setCustom(event.target.value.trim())}
            placeholder="#3f3b42"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={7}
            pattern="#[0-9A-Fa-f]{6}"
          />
        </label>
        <button type="submit" className="button primary" disabled={!valid}>
          使用颜色
        </button>
      </form>
    </div>
  );
}
