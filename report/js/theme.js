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
// Each model gets a unique color derived from the full set of models detected
// in the data (built by buildModelColors), so colors never repeat and stay
// stable regardless of the active date range. Golden-angle hue spacing keeps
// adjacent models maximally distinguishable.
let _modelColorMap = new Map();

function buildModelColors(names) {
  const set = new Set(names);
  set.add('(unknown)');
  const sorted = [...set].filter(Boolean).sort();
  _modelColorMap = new Map(sorted.map((name, i) => [
    name, `hsl(${Math.round((i * 137.508) % 360)}, 72%, 58%)`
  ]));
}

function modelColor(name) {
  return _modelColorMap.get(name) ||
    `hsl(${Math.round((hashStr(name) * 137.508) % 360)}, 72%, 58%)`;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
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
