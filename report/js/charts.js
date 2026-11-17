// Frosted tooltip shared with the daily chart: exchange title, total, and one
// row per token type with its share of the exchange.
function makeTokenTooltipHandler() {
  return function(context) {
    const el = document.getElementById('tok-tooltip');
    if (!el) return;
    const tt = context.tooltip;
    if (!tt || tt.opacity === 0 || !tt.dataPoints || !tt.dataPoints.length) {
      el.style.display = 'none';
      return;
    }
    const i = tt.dataPoints[0].dataIndex;
    const total = tt.dataPoints.reduce((s, p) => s + (p.raw || 0), 0);
    let html = '<div class="tt-title">Exchange ' + context.chart.data.labels[i] + '</div>';
    html += '<div class="tt-total">Total: ' + fmtTokens(total) + '</div>';
    for (const p of tt.dataPoints) {
      const v = p.raw || 0;
      const pct = total > 0 ? Math.round(v / total * 100) : 0;
      html += '<div class="tt-row"><span class="tt-swatch" style="background:' +
        p.dataset.backgroundColor + '"></span>' + p.dataset.label + ': ' +
        fmtTokens(v) + ' (' + pct + '%)</div>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
    placeChartTooltip(el, tt);
  };
}

function buildCharts(log) {
  if (tokChart) { tokChart.destroy(); tokChart = null; }
  if (ctxChart) { ctxChart.destroy(); ctxChart = null; }

  const labels = [], inp = [], cr = [], cw = [], out = [], ctxArr = [], compactXs = [];
  let xi = 0;
  for (const e of log) {
    if (e.event === 'compact') { compactXs.push(xi); }
    else {
      labels.push(xi + 1);
      inp.push(e.input_tokens); cr.push(e.cache_read_tokens);
      cw.push(e.cache_write_tokens); out.push(e.output_tokens);
      ctxArr.push(e.context_pct); xi++;
    }
  }

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const grid = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tick = cssVar('--muted');
  const barBorder = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
  const barStyle = {
    borderColor: barBorder,
    borderWidth: 1,
    borderRadius: 2,
    borderSkipped: false,
    maxBarThickness: 40,
  };
  const baseScales = {
    x: { ticks: { color: tick, font: { size: 11 }, maxTicksLimit: 15 }, grid: { color: grid } },
    y: { ticks: { color: tick, font: { size: 11 } }, grid: { color: grid } }
  };

  tokChart = new Chart(document.getElementById('c-tok'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Input',       data: inp, backgroundColor: TC.input,       stack: 's', ...barStyle },
      { label: 'Cache read',  data: cr,  backgroundColor: TC.cache_read,  stack: 's', ...barStyle },
      { label: 'Cache write', data: cw,  backgroundColor: TC.cache_write, stack: 's', ...barStyle },
      { label: 'Output',      data: out, backgroundColor: TC.output,      stack: 's', ...barStyle },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : { duration: 180 },
      plugins: { legend: { display: false }, compacts: { indices: compactXs },
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: makeTokenTooltipHandler(),
        } },
      scales: {
        x: { ...baseScales.x, stacked: true },
        y: { ...baseScales.y, stacked: true, ticks: { ...baseScales.y.ticks, callback: v => fmtN(v) } }
      }
    }
  });

  ctxChart = new Chart(document.getElementById('c-ctx'), {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Context %', data: ctxArr,
      borderColor: TC.input, backgroundColor: TC.input + '1f',
      borderWidth: 2, pointRadius: 3, fill: true, tension: 0.3,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, compacts: { indices: compactXs },
        tooltip: { callbacks: { label: item => 'Context: ' + item.raw + '%' } } },
      scales: {
        x: { ...baseScales.x },
        y: { ...baseScales.y, min: 0, max: 100, ticks: { ...baseScales.y.ticks, callback: v => v + '%' } }
      }
    }
  });
}
