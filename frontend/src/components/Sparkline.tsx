interface SparklineProps {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}

/**
 * 纯 SVG polyline 迷你折线图（无坐标轴）。
 * 将 values 归一化到 [0, height]（max 在顶部 y=0，min 在底部 y=height），
 * 输出 <polyline> + 半透明 <polygon> 填充区域。
 * values 为空或长度 < 2 时渲染占位灰线。
 */
export function Sparkline({ values, color = '#06b6d4', width = 80, height = 20 }: SparklineProps) {
  // 过滤非有限值，避免 NaN/Infinity 污染归一化
  const clean = values.filter((v): v is number => typeof v === 'number' && isFinite(v));

  // 数据不足：渲染占位灰线
  if (clean.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#475569"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeOpacity={0.4}
        />
      </svg>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min;

  // 计算归一化坐标点
  const points = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * width;
    // range === 0（所有值相同）时画居中水平线
    const y = range === 0 ? height / 2 : height - ((v - min) / range) * height;
    return { x, y };
  });

  const polylinePoints = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  // 填充区域：折线点 + 右下角 + 左下角，闭合到底部
  const polygonPoints = `${polylinePoints} ${width.toFixed(2)},${height.toFixed(2)} 0,${height.toFixed(2)}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <polygon points={polygonPoints} fill={color} fillOpacity={0.1} />
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
