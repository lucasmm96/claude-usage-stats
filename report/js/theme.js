// ---- CSS variable reader (theme-aware) ----
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---- Token colors (read from CSS vars so they respond to theme) ----
const TC = {
  get input()       { return cssVar('--tc-input'); },
  get cache_read()  { return cssVar('--tc-cache-read'); },
  get cache_write() { return cssVar('--tc-cache-write'); },
  get output()      { return cssVar('--tc-output'); },
};

// ---- Model colors (deterministic per name; a model keeps its color across ranges) ----
const MODEL_COLORS = [
  '#60a5fa', '#4ade80', '#fb923c', '#a78bfa', '#f472b6', '#facc15',
  '#34d399', '#38bdf8', '#fb7185', '#a3e635', '#c084fc', '#f59e0b',
];

function modelColor(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return MODEL_COLORS[(h >>> 0) % MODEL_COLORS.length];
}

// ---- Chart.js plugin: compact event vertical lines ----
const compactPlugin = {
  id: 'compacts',
  afterDraw(chart) {
    const indices = chart.options.plugins?.compacts?.indices;
    if (!indices?.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.strokeStyle = cssVar('--tc-cache-write');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    for (const xi of indices) {
      const px = xi < chart.data.labels.length ? scales.x.getPixelForValue(xi) : chartArea.right;
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
    }
    ctx.restore();
  }
};
Chart.register(compactPlugin);
