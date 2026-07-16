interface DonutProps {
  value: number;
  max: number;
  color: string;
  size?: number;
  label?: string;
  sublabel?: string;
}

/**
 * 纯 SVG 环形进度图。
 * 两个 <circle>：背景灰环 + 前景色环（strokeDasharray/strokeDashoffset 算弧长）。
 * 起点在顶部（rotate(-90)），中心显示百分比 + 可选 label/sublabel。
 * value=0 时前景环不可见（offset=circumference）；value>=max 时完整环（offset=0）。
 */
export function Donut({ value, max, color, size = 64, label, sublabel }: DonutProps) {
  const strokeWidth = 6;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(Math.max(value / safeMax, 0), 1);
  const offset = circ * (1 - ratio);
  const pct = Math.round(ratio * 100);

  // 字号根据 size 自适应
  const labelFontSize = (size * 0.135).toFixed(1);
  const pctFontSize = (size * 0.24).toFixed(1);
  const subFontSize = (size * 0.14).toFixed(1);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block' }}>
      {/* 背景灰环 */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,.06)"
        strokeWidth={strokeWidth}
      />
      {/* 前景色环：strokeDasharray=circ，offset 控制可见弧长 */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dashoffset .6s ease' }}
      />
      {label && (
        <text
          x={cx}
          y={cy - 10}
          textAnchor="middle"
          fontSize={labelFontSize}
          fill="#64748b"
        >
          {label}
        </text>
      )}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={pctFontSize}
        fontWeight={700}
        fill="#e2e8f0"
      >
        {pct}%
      </text>
      {sublabel && (
        <text
          x={cx}
          y={cy + 12}
          textAnchor="middle"
          fontSize={subFontSize}
          fill="#94a3b8"
        >
          {sublabel}
        </text>
      )}
    </svg>
  );
}
