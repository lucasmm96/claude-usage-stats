function localDateStr(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

let dailyChart = null;
let activeRange = 'month';
let currentDateFrom = '';
let currentDateTo = '';
let dailySectionInitialized = false;

function computeDailyTotals(range, fromDate, toDate) {
  const byDay = {};
  for (const sess of getFilteredSessions()) {
    for (const e of (sess.log || [])) {
      if (e.event || !e.at) continue;
      const day = localDateStr(e.at);
      byDay[day] = (byDay[day] || 0) +
        e.input_tokens + e.cache_read_tokens + e.cache_write_tokens + e.output_tokens;
    }
  }

  let entries = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));

  if (range === 'custom') {
    entries = entries.filter(([d]) => d >= fromDate && d <= toDate);
  } else if (range === 'today') {
    const todayStr = localDateStr(new Date());
    entries = entries.filter(([d]) => d === todayStr);
  } else if (range === 'month') {
    const today = new Date();
    const cutoffStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    entries = entries.filter(([d]) => d >= cutoffStr);
  } else if (range > 0) {
    const today = new Date();
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - 1));
    const cutoffStr = localDateStr(cutoff);
    entries = entries.filter(([d]) => d >= cutoffStr);
  }

  return entries;
}

function renderDailyChart(range, fromDate, toDate) {
  if (!globalData) return;

  const entries = computeDailyTotals(range, fromDate, toDate);
  const emptyEl = document.querySelector('.daily-empty');
  const canvasEl = document.getElementById('c-daily');

  if (dailyChart) { dailyChart.destroy(); dailyChart = null; }

  if (!entries.length) {
    emptyEl.style.display = 'flex';
    canvasEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  canvasEl.style.display = '';

  const pricingData = getPricing();
  let dailyCosts = null;

  if (pricingData) {
    const costByDay = {};
    for (const sess of getFilteredSessions()) {
      for (const e of dedupe(sess.log || [])) {
        if (e.event || !e.at) continue;
        const day = localDateStr(e.at);
        const mp = entryModelPrice(e, sess.model || '', pricingData, e.at);
        costByDay[day] = (costByDay[day] || 0)
          + (e.input_tokens        || 0) / 1e6 * mp.input
          + (e.cache_read_tokens   || 0) / 1e6 * mp.cacheRead
          + (e.cache_write_tokens  || 0) / 1e6 * mp.cacheWrite
          + (e.output_tokens       || 0) / 1e6 * mp.output;
      }
    }
    dailyCosts = entries.map(([d]) => costByDay[d] || 0);
  }

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches ||
    document.documentElement.dataset.theme === 'dark';
  const gridColor = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const tickColor = cssVar('--muted');
  const accentColor = cssVar('--accent');

  dailyChart = new Chart(canvasEl, {
    type: 'bar',
    data: {
      labels: entries.map(([d]) => fmtDay(d)),
      datasets: [{
        label: 'Total tokens',
        data: entries.map(([, v]) => v),
        backgroundColor: dark ? 'rgba(88,166,255,0.55)' : 'rgba(9,105,218,0.45)',
        borderColor: accentColor,
        borderWidth: 1,
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 180 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: item => {
              const base = fmtN(item.raw) + ' tokens';
              if (!dailyCosts) return base;
              const cost = dailyCosts[item.dataIndex];
              return cost > 0 ? base + ' · ' + fmtCost(cost) : base;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 20 }, grid: { color: gridColor } },
        y: { ticks: { color: tickColor, font: { size: 10 }, callback: v => fmtN(v) }, grid: { color: gridColor }, beginAtZero: true }
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
