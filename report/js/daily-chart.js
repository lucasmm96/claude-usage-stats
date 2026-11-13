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

  const models = Object.keys(tokens).sort();
  return { days, models, tokens, costs: hasPricing ? costs : null };
}

function renderDailyChart(range, fromDate, toDate) {
  if (!globalData) return;

  const pricingData = getPricing();
  const agg = computeDailyByModel(range, fromDate, toDate, pricingData);
  const emptyEl = document.querySelector('.daily-empty');
  const canvasEl = document.getElementById('c-daily');
  const legendEl = document.getElementById('daily-legend');

  if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

  if (!agg.days.length) {
    emptyEl.style.display = 'flex';
    canvasEl.style.display = 'none';
    if (legendEl) legendEl.hidden = true;
    return;
  }

  emptyEl.style.display = 'none';
  canvasEl.style.display = '';

  if (legendEl) {
    legendEl.hidden = false;
    legendEl.innerHTML = '';
    for (const m of agg.models) {
      const span = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = modelColor(m);
      span.appendChild(dot);
      span.appendChild(document.createTextNode(m));
      legendEl.appendChild(span);
    }
  }

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
        stack: 's',
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 180 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            title: items => {
              if (!items.length) return [];
              const i = items[0].dataIndex;
              const line = 'Total: ' + fmtN(dayTotals[i]) + ' tokens';
              return dayCosts && dayCosts[i] > 0
                ? [fmtDay(agg.days[i]), line + ' · ' + fmtCost(dayCosts[i])]
                : [fmtDay(agg.days[i]), line];
            },
            label: item => {
              const day = agg.days[item.dataIndex];
              const model = item.dataset.label;
              const tok = item.raw;
              if (!tok) return null;
              let line = model + ': ' + fmtN(tok) + ' tokens';
              const cost = agg.costs ? (agg.costs[model][day] || 0) : undefined;
              if (cost !== undefined && cost > 0) line += ' · ' + fmtCost(cost);
              const pctTok = dayTotals[item.dataIndex] > 0
                ? Math.round(tok / dayTotals[item.dataIndex] * 100) : 0;
              if (dayCosts && dayCosts[item.dataIndex] > 0) {
                const pctCost = cost > 0 ? Math.round(cost / dayCosts[item.dataIndex] * 100) : 0;
                line += ' (' + pctTok + '% tok · ' + pctCost + '% cost)';
              } else {
                line += ' (' + pctTok + '% tok)';
              }
              return line;
            }
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 20 }, grid: { color: gridColor } },
        y: { stacked: true, ticks: { color: tickColor, font: { size: 10 }, callback: v => fmtN(v) }, grid: { color: gridColor }, beginAtZero: true }
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
