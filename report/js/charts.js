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
  const grid = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
  const tick = cssVar('--muted');
  const baseScales = {
    x: { ticks: { color: tick, font: { size: 11 }, maxTicksLimit: 15 }, grid: { color: grid } },
    y: { ticks: { color: tick, font: { size: 11 } }, grid: { color: grid } }
  };

  tokChart = new Chart(document.getElementById('c-tok'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Input',       data: inp, backgroundColor: TC.input,       stack: 's' },
      { label: 'Cache read',  data: cr,  backgroundColor: TC.cache_read,  stack: 's' },
      { label: 'Cache write', data: cw,  backgroundColor: TC.cache_write, stack: 's' },
      { label: 'Output',      data: out, backgroundColor: TC.output,      stack: 's' },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, compacts: { indices: compactXs },
        tooltip: { callbacks: { footer: items => 'Total: ' + fmtN(items.reduce((s, i) => s + i.raw, 0)) } } },
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
