// ---- Render ----
let activeSessId      = null;
let activeSessLogLen  = 0;
let activeSessLastAt  = '';
let activePricingJson = null;
let activeRangeSig    = '';

// Shared filter dropdown: a trigger button + a popover panel of selectable rows.
// Items: [{ value, label, color? }]. In single mode value is the active scalar
// (null = "All"); in multi mode it's the active Set and rows carry checkboxes.
function buildFilterDropdown({ containerEl, items, active, isMulti, triggerText, onChange }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'filter-dropdown';

  const trigger = document.createElement('button');
  trigger.className = 'profile-btn filter-dropdown-trigger';
  trigger.type = 'button';

  const panel = document.createElement('div');
  panel.className = 'filter-dropdown-panel';

  function isChecked(value) {
    if (isMulti) return value === 'All' ? active.size === 0 : active.has(value);
    return value === 'All' ? active == null : active === value;
  }

  function syncTrigger() {
    trigger.textContent = triggerText();
  }

  function buildPanel() {
    panel.innerHTML = '';
    const makeRow = (item) => {
      const row = document.createElement('label');
      row.className = 'filter-dropdown-row';

      const input = document.createElement('input');
      input.type = isMulti ? 'checkbox' : 'radio';
      if (!isMulti) input.name = 'filter-dropdown-' + containerEl.id;
      input.checked = isChecked(item.value);

      input.onchange = () => {
        onChange(item.value, input.checked);
        buildPanel();
        syncTrigger();
        renderAll();
      };

      row.appendChild(input);
      if (item.color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = item.color;
        row.appendChild(dot);
      }
      const labelSpan = document.createElement('span');
      labelSpan.className = 'filter-dropdown-label';
      labelSpan.textContent = item.label;
      row.appendChild(labelSpan);
      panel.appendChild(row);
    };

    makeRow({ value: 'All', label: 'All' });
    items.forEach(makeRow);
  }

  trigger.onclick = () => {
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  };

  // Close on outside click (registered once on document, checks containment)
  if (!document.__filterDropdownListener) {
    document.__filterDropdownListener = (e) => {
      document.querySelectorAll('.filter-dropdown').forEach(w => {
        if (!w.contains(e.target)) {
          w.querySelector('.filter-dropdown-panel').classList.remove('open');
          w.querySelector('.filter-dropdown-trigger').classList.remove('open');
        }
      });
    };
    document.addEventListener('click', document.__filterDropdownListener);
  }

  buildPanel();
  syncTrigger();
  wrapper.appendChild(trigger);
  wrapper.appendChild(panel);
  containerEl.innerHTML = '';
  containerEl.appendChild(wrapper);
}

function renderProfileBar() {
  const profiles = [...new Set(
    Object.values(globalData.sessions).map(s => s.profile).filter(Boolean)
  )].sort();

  const all = Object.values(globalData.sessions);
  const hasOther = all.some(s => !s.profile && s.log && s.log.some(e => !e.event || e.event === 'compact'));

  const bar = document.getElementById('profile-bar');
  if (!profiles.length && !hasOther) { bar.hidden = true; activeProfile = null; return; }
  if (activeProfile === '__other__' && !hasOther) activeProfile = null;

  bar.hidden = false;
  const items = profiles.map(p => ({ value: p, label: p }));
  if (hasOther) items.push({ value: '__other__', label: 'other' });

  buildFilterDropdown({
    containerEl: document.getElementById('profile-pills'),
    items,
    active: activeProfile,
    isMulti: false,
    triggerText: () => (activeProfile == null ? 'All ▾' : (activeProfile === '__other__' ? 'other' : activeProfile) + ' ▾'),
    onChange: (value) => { activeProfile = value === 'All' ? null : value; },
  });
}

function renderModelBar() {
  const modelSet = new Set();
  for (const s of Object.values(globalData.sessions)) {
    if (s.model) modelSet.add(s.model);
    for (const e of (s.log || [])) {
      if (!e.event && e.model) modelSet.add(e.model);
    }
  }
  const models = [...modelSet].sort();
  buildModelColors(models);

  const bar = document.getElementById('model-bar');
  if (!models.length) { bar.hidden = true; return; }
  bar.hidden = false;

  buildFilterDropdown({
    containerEl: document.getElementById('model-pills'),
    items: models.map(m => ({ value: m, label: m, color: modelColor(m) })),
    active: activeModels,
    isMulti: true,
    triggerText: () => {
      if (activeModels.size === 0) return 'All ▾';
      const names = [...activeModels];
      return names.length === 1 ? names[0] + ' ▾' : names.length + ' models ▾';
    },
    onChange: (value, checked) => {
      if (value === 'All') {
        activeModels.clear();
      } else {
        if (checked) activeModels.add(value);
        else activeModels.delete(value);
        if (activeModels.size === 0) activeModels.clear(); // fall back to All
      }
    },
  });
}

function renderAll() {
  const sessions = getFilteredSessions()
    .sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at));

  let statCount = 0, totalTok = 0, totalComp = 0, totalCR = 0, totalIn = 0;
  for (const s of sessions) {
    const log = dedupe(s.log || []);
    const exch = log.filter(e => !e.event && isInDateRange(e.at));
    const compacts = log.filter(e => e.event === 'compact' && isInDateRange(e.at)).length;
    if (exch.length > 0 || compacts > 0) statCount++;
    totalTok  += exch.reduce((x, e) => x + e.input_tokens + e.cache_read_tokens + e.cache_write_tokens + e.output_tokens, 0);
    totalComp += compacts;
    totalCR   += exch.reduce((x, e) => x + e.cache_read_tokens, 0);
    totalIn   += exch.reduce((x, e) => x + e.input_tokens + e.cache_read_tokens + e.cache_write_tokens, 0);
  }

  document.getElementById('s-count').textContent    = statCount;
  document.getElementById('s-tokens').textContent   = fmtN(totalTok);
  document.getElementById('s-cache').textContent    = totalIn > 0 ? Math.round(totalCR / totalIn * 100) + '%' : '—';
  document.getElementById('s-compacts').textContent = totalComp;

  const pricing = getPricing();
  const costStat = document.getElementById('s-cost-stat');
  const statBar  = document.getElementById('stat-bar');
  if (pricing) {
    let cost = 0, unpriced = 0;
    const defaultIsEmpty = pricing._default.input === 0 && pricing._default.cacheRead === 0 &&
                           pricing._default.cacheWrite === 0 && pricing._default.output === 0;
    for (const s of sessions) {
      const log = dedupe(s.log || []);
      for (const e of log) {
        if (e.event || !isInDateRange(e.at)) continue;
        const key = e.model || s.model || '';
        const hasPrice = findPrice(key, pricing) !== null;
        if (!hasPrice && defaultIsEmpty) {
          unpriced += (e.input_tokens || 0) + (e.cache_read_tokens || 0) +
                      (e.cache_write_tokens || 0) + (e.output_tokens || 0);
        } else {
          const mp = entryModelPrice(e, s.model, pricing, e.at);
          cost += (e.input_tokens       || 0) / 1e6 * mp.input;
          cost += (e.cache_read_tokens  || 0) / 1e6 * mp.cacheRead;
          cost += (e.cache_write_tokens || 0) / 1e6 * mp.cacheWrite;
          cost += (e.output_tokens      || 0) / 1e6 * mp.output;
        }
      }
    }
    let costText = fmtCost(cost);
    if (unpriced > 0) costText += ` <span class="cost-warning">⚠ ${fmtN(unpriced)} unpriced</span>`;
    document.getElementById('s-cost').innerHTML = costText;
    costStat.style.display = '';
    statBar.classList.add('has-cost');
  } else {
    costStat.style.display = 'none';
    statBar.classList.remove('has-cost');
  }

  // Snapshot of active state before DOM rebuild
  const prevId     = activeSessId;
  const prevLogLen = activeSessLogLen;
  const prevLastAt = activeSessLastAt;
  const prevRangeSig = activeRangeSig;
  activeRangeSig = String(activeRange) + '|' + currentDateFrom + '|' + currentDateTo;
  const detailEl   = document.getElementById('detail');
  const prevScroll = detailEl ? detailEl.scrollTop : 0;

  const list = document.getElementById('sessions');
  list.innerHTML = '';
  let activeItem = null;

  sessions.forEach((sess, i) => {
    const st = sessStats(sess);
    const el = document.createElement('div');
    el.className = 'sess-item';
    el.innerHTML = `
      <div class="sess-name" title="${sess.session_name || sess.session_id}">${sess.session_name || sess.session_id.slice(0, 8)}</div>
      <div class="sess-meta">${sess.model}</div>
      <div class="sess-meta">${fmtN(st.total)} &middot; ${fmtDt(sess.started_at)}</div>
    `;
    el.onclick = () => {
      document.querySelectorAll('.sess-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      activeSessId = sess.session_id;
      renderDetail(sess);
    };
    list.appendChild(el);

    // Restore or default active item
    if (prevId ? sess.session_id === prevId : i === 0) {
      el.classList.add('active');
      activeItem = { el, sess };
    }
  });

  // Fallback: first session if prev selection not found
  if (!activeItem && sessions.length) {
    const firstEl = list.querySelector('.sess-item');
    if (firstEl) { firstEl.classList.add('active'); activeItem = { el: firstEl, sess: sessions[0] }; }
  }

  if (activeItem) {
    const { sess } = activeItem;
    activeSessId = sess.session_id;

    // Only re-render detail if this session's data or pricing changed
    const currentPricingJson = JSON.stringify(getPricing());
    const dataChanged = !prevId ||
      sess.last_activity_at !== prevLastAt ||
      (sess.log || []).length !== prevLogLen ||
      activeRangeSig !== prevRangeSig ||
      currentPricingJson !== activePricingJson;
    activePricingJson = currentPricingJson;

    if (dataChanged) {
      renderDetail(sess);
    } else {
      if (detailEl) detailEl.scrollTop = prevScroll;
    }
  }

  renderProfileBar();
  renderModelBar();
  initDailySection();
}

function renderDetail(sess) {
  // Track for change detection on next renderAll
  activeSessLogLen = (sess.log || []).length;
  activeSessLastAt = sess.last_activity_at || '';

  const st     = sessStats(sess);
  const detail = document.getElementById('detail');

  const pricing = getPricing();

  // Collect distinct models from log entries; fall back to sess.model for display
  const entryModels = [...new Set(
    (sess.log || []).filter(e => !e.event && e.model).map(e => e.model)
  )];
  const modelDisplay = entryModels.length > 0 ? entryModels.join(', ') : (sess.model || '—');

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${sess.session_name || sess.session_id}</h2>
      <p>${modelDisplay} &middot; ${fmtDt(sess.started_at)} &middot; ${fmtDur(sess.started_at, sess.last_activity_at)} &middot; ${st.exch.length} exchanges</p>
    </div>
    <div class="detail-stats">
      <div><div class="ds-label">Total tokens</div><div class="ds-val">${fmtN(st.total)}</div></div>
      <div><div class="ds-label">Cache hit rate</div><div class="ds-val">${Math.round(st.cacheHit)}%</div></div>
      <div><div class="ds-label">Compacts</div><div class="ds-val">${st.compacts}</div></div>
      <div><div class="ds-label">Last context</div><div class="ds-val">${sess._state?.last_ctx ?? '—'}%</div></div>
    </div>
    <div class="chart-section">
      <h3>Tokens per Exchange</h3>
      <div class="legend">
        <span><span class="dot" style="background:${TC.input}"></span>Input</span>
        <span><span class="dot" style="background:${TC.cache_read}"></span>Cache read</span>
        <span><span class="dot" style="background:${TC.cache_write}"></span>Cache write</span>
        <span><span class="dot" style="background:${TC.output}"></span>Output</span>
        <span style="color:var(--orange)">&#10072; Compact</span>
      </div>
      <div class="chart-wrap"><canvas id="c-tok"></canvas></div>
    </div>
    <div class="chart-section">
      <h3>Context Window Usage</h3>
      <div class="chart-wrap"><canvas id="c-ctx"></canvas></div>
    </div>
    <div class="log-section">
      <h3>Exchange Log</h3>
      ${buildLogTable(st.log, pricing, sess.model)}
    </div>
  `;

  buildCharts(st.log);
}
