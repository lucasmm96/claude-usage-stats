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

// ---- Model colors ----
// Colors are chosen for the full set of models detected in the data (built by
// buildModelColors), so none repeat and each stays stable regardless of the
// active date range. Hues are spread exactly evenly around the wheel (i·360/N),
// the maximum possible minimum gap (360/N), which keeps colors visually
// distinct even with many models.
let _modelColorMap = new Map();

function buildModelColors(names) {
  const set = new Set(names);
  set.add('(unknown)');
  const sorted = [...set].filter(Boolean).sort();
  const n = sorted.length;
  _modelColorMap = new Map();
  sorted.forEach((name, i) => {
    const h = n > 1 ? Math.round((i * 360) / n) % 360 : 0;
    _modelColorMap.set(name, `hsl(${h}, 72%, 52%)`);
  });
}

function modelColor(name) {
  return _modelColorMap.get(name) || '#94a3b8';
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
