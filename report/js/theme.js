// ---- CSS variable reader (theme-aware) ----
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartFontSize() {
  return Number.parseFloat(cssVar('--chart-font-size')) || 11;
}

// ---- Token colors (read from CSS vars so they respond to theme) ----
const TC = {
  get input()       { return cssVar('--tc-input'); },
  get cache_read()  { return cssVar('--tc-cache-read'); },
  get cache_write() { return cssVar('--tc-cache-write'); },
  get output()      { return cssVar('--tc-output'); },
};

// ---- Model colors ----
// A fixed, low-saturation palette keeps model colors distinct without the
// neon primaries of an evenly-spaced HSL wheel. Hues stay stable per model;
// lightness adapts to the active theme.
const MODEL_HUES = [210, 150, 25, 280, 345, 185, 45, 320, 115, 240, 0, 195, 80, 265, 160, 305];
let _modelColorMap = new Map();

function modelThemeIsDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ||
    document.documentElement.dataset.theme === 'dark';
}

function buildModelColors(names) {
  const set = new Set(names);
  set.add('(unknown)');
  const sorted = [...set].filter(Boolean).sort();
  const dark = modelThemeIsDark();
  const saturation = dark ? 58 : 62;
  const baseLightness = dark ? 64 : 42;
  _modelColorMap = new Map();
  sorted.forEach((name, i) => {
    const ring = Math.floor(i / MODEL_HUES.length);
    const lightness = Math.max(30, Math.min(74, baseLightness + (ring % 2 ? 8 : 0)));
    _modelColorMap.set(name, `hsl(${MODEL_HUES[i % MODEL_HUES.length]} ${saturation}% ${lightness}%)`);
  });
}

function modelColor(name) {
  return _modelColorMap.get(name) || cssVar('--model-color-fallback');
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

// Charts inherit the report's type and palette instead of Chart.js defaults.
Chart.defaults.font.family = cssVar('--font-sans');
Chart.defaults.font.size = chartFontSize();
Chart.defaults.color = cssVar('--muted');

// Rebuild model colors and charts when the OS theme changes.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  Chart.defaults.color = cssVar('--muted');
  if (typeof renderAll === 'function' && typeof globalData !== 'undefined' && globalData) renderAll();
});
