export function BackgroundEffects() {
  const particles = Array.from({ length: 20 }, () => ({
    left: `${Math.random() * 100}%`,
    animationDuration: `${8 + Math.random() * 12}s`,
    animationDelay: `${Math.random() * 10}s`,
    opacity: 0.3 + Math.random() * 0.5,
    size: 1 + Math.random() * 2,
  }));

  const cornerSize = 60;
  const cornerLen = 30;
  const cornerColor = 'rgba(0,212,255,.25)';
  const cornerStroke = 1.5;

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
      {/* 移动网格背景 */}
      <div
        className="bg-grid"
        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }}
      />

      {/* 大型模糊光球 - 蓝 */}
      <div
        className="bg-orb bg-orb-1"
        style={{ position: 'fixed', zIndex: 0 }}
      />

      {/* 大型模糊光球 - 紫 */}
      <div
        className="bg-orb bg-orb-2"
        style={{ position: 'fixed', zIndex: 0 }}
      />

      {/* 大型模糊光球 - 青 */}
      <div
        className="bg-orb bg-orb-3"
        style={{ position: 'fixed', zIndex: 0 }}
      />

      {/* 扫描线效果 */}
      <div
        className="scan-line"
        style={{ position: 'fixed', left: 0, right: 0, zIndex: 0 }}
      />

      {/* 20个随机漂浮粒子 */}
      {particles.map((p, i) => (
        <div
          key={i}
          className="particle"
          style={{
            position: 'fixed',
            left: p.left,
            bottom: 0,
            width: p.size,
            height: p.size,
            animationDuration: p.animationDuration,
            animationDelay: p.animationDelay,
            opacity: p.opacity,
            zIndex: 0,
          }}
        />
      ))}

      {/* 四角 SVG L型装饰线 - 左上 */}
      <svg
        style={{ position: 'fixed', top: 0, left: 0, width: cornerSize, height: cornerSize, zIndex: 0 }}
        viewBox={`0 0 ${cornerSize} ${cornerSize}`}
      >
        <line x1={0} y1={0} x2={cornerLen} y2={0} stroke={cornerColor} strokeWidth={cornerStroke} />
        <line x1={0} y1={0} x2={0} y2={cornerLen} stroke={cornerColor} strokeWidth={cornerStroke} />
      </svg>

      {/* 四角 SVG L型装饰线 - 右上 */}
      <svg
        style={{ position: 'fixed', top: 0, right: 0, width: cornerSize, height: cornerSize, zIndex: 0 }}
        viewBox={`0 0 ${cornerSize} ${cornerSize}`}
      >
        <line x1={cornerSize - cornerLen} y1={0} x2={cornerSize} y2={0} stroke={cornerColor} strokeWidth={cornerStroke} />
        <line x1={cornerSize} y1={0} x2={cornerSize} y2={cornerLen} stroke={cornerColor} strokeWidth={cornerStroke} />
      </svg>

      {/* 四角 SVG L型装饰线 - 左下 */}
      <svg
        style={{ position: 'fixed', bottom: 0, left: 0, width: cornerSize, height: cornerSize, zIndex: 0 }}
        viewBox={`0 0 ${cornerSize} ${cornerSize}`}
      >
        <line x1={0} y1={cornerSize - cornerLen} x2={0} y2={cornerSize} stroke={cornerColor} strokeWidth={cornerStroke} />
        <line x1={0} y1={cornerSize} x2={cornerLen} y2={cornerSize} stroke={cornerColor} strokeWidth={cornerStroke} />
      </svg>

      {/* 四角 SVG L型装饰线 - 右下 */}
      <svg
        style={{ position: 'fixed', bottom: 0, right: 0, width: cornerSize, height: cornerSize, zIndex: 0 }}
        viewBox={`0 0 ${cornerSize} ${cornerSize}`}
      >
        <line x1={cornerSize} y1={cornerSize - cornerLen} x2={cornerSize} y2={cornerSize} stroke={cornerColor} strokeWidth={cornerStroke} />
        <line x1={cornerSize - cornerLen} y1={cornerSize} x2={cornerSize} y2={cornerSize} stroke={cornerColor} strokeWidth={cornerStroke} />
      </svg>
    </div>
  );
}
