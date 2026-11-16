function localDateStr(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

let dailyChart = null;
let activeRange = 'month';
let currentDateFrom = '';
let currentDateTo = '';
let dailySectionInitialized = false;

// Aggregates tokens (and cost, when pricing is available) per day and per model.
// Uses the same dedupe as the cost loop and the top stat bar so bar totals,
// tooltip totals and the top-bar total always agree.
function computeDailyByModel(range, fromDate, toDate, pricingData) {
  const tokens = {};
  const costs = {};
  const daySet = new Set();
  const hasPricing = !!pricingData;

  for (const sess of getFilteredSessions()) {
    const sessModel = sess.model || '';
    for (const e of dedupe(sess.log || [])) {
      if (e.event || !e.at) continue;
      const day = localDateStr(e.at);
      const model = e.model || sessModel || '(unknown)';
      daySet.add(day);
      const tok = (tokens[model] = tokens[model] || {});
      tok[day] = (tok[day] || 0) +
        (e.input_tokens || 0) + (e.cache_read_tokens || 0) +
        (e.cache_write_tokens || 0) + (e.output_tokens || 0);
      if (hasPricing) {
        const mp = entryModelPrice(e, sessModel, pricingData, e.at);
        const c = (costs[model] = costs[model] || {});
        c[day] = (c[day] || 0) +
          (e.input_tokens        || 0) / 1e6 * mp.input +
          (e.cache_read_tokens   || 0) / 1e6 * mp.cacheRead +
          (e.cache_write_tokens  || 0) / 1e6 * mp.cacheWrite +
          (e.output_tokens       || 0) / 1e6 * mp.output;
      }
    }
  }

  let days = [...daySet].sort();

  if (range === 'custom') {
    days = days.filter(d => d >= fromDate && d <= toDate);
  } else if (range === 'today') {
    const todayStr = localDateStr(new Date());
    days = days.filter(d => d === todayStr);
  } else if (range === 'month') {
    const today = new Date();
    const cutoffStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    days = days.filter(d => d >= cutoffStr);
  } else if (range > 0) {
    const today = new Date();
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - 1));
    const cutoffStr = localDateStr(cutoff);
    days = days.filter(d => d >= cutoffStr);
  }

  const modelTotals = {};
  for (const m of Object.keys(tokens)) {
    modelTotals[m] = Object.values(tokens[m] || {}).reduce((s, v) => s + v, 0);
  }
  const models = Object.keys(tokens).sort((a, b) => {
    const ta = modelTotals[a] || 0;
    const tb = modelTotals[b] || 0;
    if (tb !== ta) return tb - ta;                 // most tokens first
    const ca = costs ? Object.values(costs[a] || {}).reduce((s, v) => s + v, 0) : 0;
    const cb = costs ? Object.values(costs[b] || {}).reduce((s, v) => s + v, 0) : 0;
    return cb - ca;                                // tiebreak by cost
  });
  return { days, models, tokens, costs: hasPricing ? costs : null };
}

function makeDailyTooltipHandler(agg, dayTotals, dayCosts) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return function(context) {
    const el = document.getElementById('daily-tooltip');
    if (!el) return;
    const tt = context.tooltip;
    if (!tt || tt.opacity === 0 || !tt.dataPoints || !tt.dataPoints.length) {
      el.style.display = 'none';
      return;
    }
    const i = tt.dataPoints[0].dataIndex;
    const day = agg.days[i];
    const active = agg.models.filter(m => (agg.tokens[m][day] || 0) > 0).length;
    const total = dayTotals[i];
    const costTotal = dayCosts ? dayCosts[i] : null;

    const rows = agg.models.map(m => ({
      m,
      tok: agg.tokens[m][day] || 0,
      cost: agg.costs ? (agg.costs[m][day] || 0) : undefined
    })).sort((a, b) => (b.tok - a.tok) || ((b.cost || 0) - (a.cost || 0)));

    let html = '<div class="tt-title">' + esc(fmtDay(day)) + '</div>';
    html += '<div class="tt-total">Total: ' + fmtN(total) + ' tokens · ' + active + ' model' + (active === 1 ? '' : 's');
    if (costTotal !== null) html += ' · ' + fmtCost(costTotal);
    html += '</div>';
    for (const r of rows) {
      const pctTok = total > 0 ? Math.round(r.tok / total * 100) : 0;
      let line = '<span class="tt-swatch" style="background:' + modelColor(r.m) + '"></span>' + esc(r.m) + ': ' + fmtN(r.tok) + ' tokens';
      if (r.cost !== undefined) line += ' · ' + fmtCost(r.cost);
      if (costTotal !== null) {
        const pctCost = costTotal > 0 ? Math.round(r.cost / costTotal * 100) : 0;
        line += ' (' + pctTok + '% tok · ' + pctCost + '% cost)';
      } else {
        line += ' (' + pctTok + '% tok)';
      }
      html += '<div class="tt-row">' + line + '</div>';
    }
    el.innerHTML = html;
    el.style.display = 'block';
    const wrap = el.parentElement;
    const x = tt.caretX, y = tt.caretY;
    const tw = el.offsetWidth, th = el.offsetHeight;
    let left = x + 14;
    let top = y - th - 10;
    if (left + tw > wrap.clientWidth) left = x - tw - 14;
    if (left < 0) left = 0;
    if (top < 0) top = y + 14;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  };
}

function renderDailyChart(range, fromDate, toDate) {
  if (!globalData) return;

  const pricingData = getPricing();
  const agg = computeDailyByModel(range, fromDate, toDate, pricingData);
  const emptyEl = document.querySelector('.daily-empty');
  const canvasEl = document.getElementById('c-daily');

  if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

  if (!agg.days.length) {
    emptyEl.style.display = 'flex';
    canvasEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  canvasEl.style.display = '';

  const dayTotals = agg.days.map(d =>
    agg.models.reduce((s, m) => s + (agg.tokens[m][d] || 0), 0)
  );
  const dayCosts = agg.costs ? agg.days.map(d =>
    agg.models.reduce((s, m) => s + (agg.costs[m][d] || 0), 0)
  ) : null;

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches ||
    document.documentElement.dataset.theme === 'dark';
  const gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = cssVar('--muted');
  const borderColor = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
  dailyChart = new Chart(canvasEl, {
    type: 'bar',
    data: {
      labels: agg.days.map(d => fmtDay(d)),
      datasets: agg.models.map(m => ({
        label: m,
        data: agg.days.map(d => agg.tokens[m][d] || 0),
        backgroundColor: modelColor(m),
        borderColor: borderColor,
        borderWidth: 1,
        borderRadius: 2,
        borderSkipped: false,
        maxBarThickness: 40,
        stack: 's',
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : { duration: 180 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          enabled: false,
          external: makeDailyTooltipHandler(agg, dayTotals, dayCosts),
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: tickColor, font: { size: 11 }, maxTicksLimit: 20 }, grid: { color: gridColor } },
        y: { stacked: true, ticks: { color: tickColor, font: { size: 11 }, callback: v => fmtN(v) }, grid: { color: gridColor }, beginAtZero: true }
      }
    }
  });
}

function setRange(range) {
  activeRange = range;
  document.querySelectorAll('.range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === String(range));
  });
  const customDates = document.querySelector('.custom-dates');
  customDates.hidden = range !== 'custom';
  if (range !== 'custom') {
    currentDateFrom = '';
    currentDateTo = '';
    renderAll();
  }
}

function applyCustomRange() {
  const from = document.getElementById('date-from').value;
  const to   = document.getElementById('date-to').value;
  if (from && to && from <= to) {
    currentDateFrom = from;
    currentDateTo   = to;
    renderAll();
  }
}

function initDailySection() {
  const section = document.getElementById('daily-section');
  section.hidden = false;

  if (dailySectionInitialized) {
    renderDailyChart(activeRange, currentDateFrom, currentDateTo);
    return;
  }

  dailySectionInitialized = true;

  document.querySelectorAll('#daily-section .range-btn').forEach(btn => {
    btn.onclick = () => setRange(btn.dataset.range === '0' ? 0 : btn.dataset.range);
  });

  const today = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const from30 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
  currentDateFrom = toISO(from30);
  currentDateTo   = toISO(today);
  document.getElementById('date-from').value = currentDateFrom;
  document.getElementById('date-to').value   = currentDateTo;

  document.getElementById('date-from').onchange = applyCustomRange;
  document.getElementById('date-to').onchange   = applyCustomRange;

  renderDailyChart(activeRange);
}
