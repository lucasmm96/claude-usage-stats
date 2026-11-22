function localDateStr(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

let dailyChart = null;
let activeRange = 'month';
let currentDateFrom = '';
let currentDateTo = '';
let dailySectionInitialized = false;
let _dailyTooltipHandler = null; // handler atual para ESC/click-fora

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
  const el = document.getElementById('daily-tooltip');
  if (!el) return null;
  let pieChart = null;
  let currentDay = null;
  let hideTimeout = null;
  let activeTab = 'rows';
  let pinned = false;
  let lastTT = null;

  // Event delegation para abas: sobrevive a re-render do innerHTML
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.tt-nav-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const tab = btn.dataset.tab;
    if (!tab || tab === activeTab) return;
    activeTab = tab;
    if (currentDay) render(currentDay, lastTT);
  });

  // Mouse SOBRE o tooltip: cancela qualquer fechamento pendente
  el.addEventListener('mouseenter', () => {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  });

  // Mouse SAÍU do tooltip: agenda esconder depois de 500ms
  el.addEventListener('mouseleave', () => {
    if (pinned) return;
    hideTimeout = setTimeout(() => {
      hideTimeout = null;
      const ttp = document.getElementById('daily-tooltip');
      if (ttp && !ttp.matches(':hover')) {
        destroyPie();
        currentDay = null;
        ttp.style.display = 'none';
      }
    }, 500);
  });

  function destroyPie() {
    if (pieChart) { pieChart.destroy(); pieChart = null; }
  }

  function buildRows(day) {
    let html = '<div class="tt-title">' + esc(fmtDay(day)) + '</div>';
    const total = dayTotals[agg.days.indexOf(day)];
    const costTotal = dayCosts ? dayCosts[agg.days.indexOf(day)] : null;
    const active = agg.models.filter(m => (agg.tokens[m][day] || 0) > 0).length;
    html += '<div class="tt-total">Total: ' + fmtTokens(total) + ' · ' + active + ' model' + (active === 1 ? '' : 's');
    if (costTotal !== null) html += ' · ' + fmtCost(costTotal);
    html += '</div>';
    const rows = agg.models
      .filter(m => (agg.tokens[m][day] || 0) > 0)
      .map(m => ({ m, tok: agg.tokens[m][day], cost: agg.costs ? (agg.costs[m][day] || 0) : undefined }))
      .sort((a, b) => (b.tok - a.tok) || ((b.cost || 0) - (a.cost || 0)));
    for (const r of rows) {
      const pctTok = total > 0 ? Math.round(r.tok / total * 100) : 0;
      let line = '<span class="tt-swatch" style="background:' + modelColor(r.m) + '"></span>' + esc(r.m) + ': ' + fmtTokens(r.tok);
      if (r.cost !== undefined) line += ' · ' + fmtCost(r.cost);
      if (costTotal !== null) {
        const pctCost = costTotal > 0 ? Math.round(r.cost / costTotal * 100) : 0;
        line += ' (' + pctTok + '% tok · ' + pctCost + '% cost)';
      } else { line += ' (' + pctTok + '% tok)'; }
      html += '<div class="tt-row">' + line + '</div>';
    }
    return html;
  }

  function buildPie(day, key) {
    destroyPie();
    const rows = agg.models
      .filter(m => (agg[key][m][day] || 0) > 0)
      .sort((a, b) => agg[key][b][day] - agg[key][a][day]);
    if (!rows.length) return;

    const total = key === 'costs' ? (dayCosts ? dayCosts[agg.days.indexOf(day)] : 0) : (dayTotals ? dayTotals[agg.days.indexOf(day)] : 0);

    // Labels lado a lado para caber melhor
    let labelsHtml = '';
    for (const r of rows) {
      const pct = total > 0 ? Math.round(agg[key][r][day] / total * 100) : 0;
      const val = key === 'costs' ? fmtCost(agg[key][r][day]) : fmtTokens(agg[key][r][day]);
      labelsHtml += '<div class="tt-pie-label"><span class="tt-swatch" style="background:' + modelColor(r) + '"></span>' + esc(r) + ': ' + val + ' (' + pct + '%)</div>';
    }

    return '<div class="tt-title">' + esc(fmtDay(day)) + '</div>'
      + '<div class="tt-total">Total: ' + (key === 'costs' ? fmtCost(total || 0) : fmtTokens(total || 0)) + ' · ' + rows.length + ' model' + (rows.length === 1 ? '' : 's') + '</div>'
      + '<div class="tt-pie-layout"><div class="tt-pie-wrapper"><canvas class="tt-pie-canvas" width="220" height="180"></canvas></div><div class="tt-pie-labels">' + labelsHtml + '</div></div>';
  }

  function renderPie(day, key) {
    destroyPie();
    const rows = agg.models
      .filter(m => (agg[key][m][day] || 0) > 0)
      .sort((a, b) => agg[key][b][day] - agg[key][a][day]);
    if (!rows.length) return;
    const canvas = el.querySelector('.tt-pie-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    pieChart = new Chart(ctx, {
      type: 'pie',
      data: { labels: rows.map(m => esc(m)), datasets: [{ data: rows.map(m => agg[key][m][day]), backgroundColor: rows.map(m => modelColor(m)), borderColor: cssVar('--surface'), borderWidth: 2 }] },
      options: { responsive: false, animation: prefersReducedMotion() ? false : { duration: 180 }, plugins: { legend: { display: false }, tooltip: { enabled: false } }, cutout: '70%' }
    });
  }

  function render(day, tt) {
    currentDay = day;
    lastTT = tt;
    let html =
      '<div class="tt-nav">' +
      '<button class="tt-nav-btn' + (activeTab === 'rows' ? ' active' : '') + '" data-tab="rows">Models</button>' +
      (dayCosts !== null ? '<button class="tt-nav-btn' + (activeTab === 'cost' ? ' active' : '') + '" data-tab="cost">Cost</button>' : '') +
      '<button class="tt-nav-btn' + (activeTab === 'tok' ? ' active' : '') + '" data-tab="tok">Tokens</button>' +
      '</div><div class="tt-content">';
    if (activeTab === 'rows') html += buildRows(day);
    else if (activeTab === 'cost') html += buildPie(day, 'costs');
    else if (activeTab === 'tok') html += buildPie(day, 'tokens');
    html += '</div>';
    el.innerHTML = html;

    if (activeTab === 'cost') renderPie(day, 'costs');
    else if (activeTab === 'tok') renderPie(day, 'tokens');
    el.style.display = 'block';
    placeChartTooltip(el, tt);
  }

  function pin(day, tt) {
    pinned = true;
    hideTimeout && clearTimeout(hideTimeout);
    render(day, tt);
  }

  function closeTooltip() {
    destroyPie();
    currentDay = null;
    pinned = false;
    el.style.display = 'none';
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  }

  function handler(context) {
    const tt = context.tooltip;

    // Se já está fixado, ignora completamente - não fecha nunca via Chart.js
    if (pinned) return;

    // Dados vazios ou invisíveis: agenda fechamento (cancela se mouse voltar pro tooltip)
    if (!tt || tt.opacity === 0 || !tt.dataPoints || !tt.dataPoints.length) {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      hideTimeout = setTimeout(() => {
        hideTimeout = null;
        const ttp = document.getElementById('daily-tooltip');
        if (ttp && !ttp.matches(':hover')) {
          destroyPie();
          currentDay = null;
          ttp.style.display = 'none';
        }
      }, 500);
      return;
    }

    // Cancela qualquer timer pendente quando hover válido
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }

    lastTT = tt;
    const day = agg.days[tt.dataPoints[0].dataIndex];
    render(day, tt);
  }

  handler._pin = pin;
  handler._unpin = closeTooltip;
  handler._pinnedDay = () => currentDay;
  return handler;
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

  const handler = makeDailyTooltipHandler(agg, dayTotals, dayCosts);
  _dailyTooltipHandler = handler;

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
          external: handler,
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: tickColor, font: { size: 11 }, maxTicksLimit: 20 }, grid: { color: gridColor } },
        y: { stacked: true, ticks: { color: tickColor, font: { size: 11 }, callback: v => fmtN(v) }, grid: { color: gridColor }, beginAtZero: true }
      }
    }
  });

  // Click na barra: pin/unpin tooltip fixo
  canvasEl.onclick = (e) => {
    const points = dailyChart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
    if (!points.length) return;
    const dayIndex = points[0].index;
    const day = agg.days[dayIndex];
    const rect = canvasEl.getBoundingClientRect();
    const tt = {
      opacity: 1,
      caretX: e.clientX - rect.left,
      caretY: e.clientY - rect.top,
      dataPoints: [{ dataIndex: dayIndex }]
    };
    if (handler._pinnedDay() === day) {
      handler._unpin();
    } else {
      handler._pin(day, tt);
    }
  };
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

// --- ESC e click fora: unpin tooltip fixo ---
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (_dailyTooltipHandler) _dailyTooltipHandler._unpin();
});

document.addEventListener('click', (e) => {
  const el = document.getElementById('daily-tooltip');
  if (!el || el.style.display !== 'block') return;
  if (!e.target.closest('#c-daily') && !el.contains(e.target)) {
    if (_dailyTooltipHandler) _dailyTooltipHandler._unpin();
  }
});
