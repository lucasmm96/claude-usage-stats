// ---- Render ----
let activeSessId      = null;
let activeSessLogLen  = 0;
let activeSessLastAt  = '';
let activePricingJson = null;
let activeRangeSig    = '';

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
  const pills = document.getElementById('profile-pills');
  pills.innerHTML = '';

  const makeBtn = (label, value) => {
    const b = document.createElement('button');
    b.className = 'profile-btn' + (activeProfile === value ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { activeProfile = value; renderAll(); };
    pills.appendChild(b);
  };

  makeBtn('All', null);
  profiles.forEach(p => makeBtn(p, p));
  if (hasOther) makeBtn('other', '__other__');
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

  const bar = document.getElementById('model-bar');
  if (!models.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const container = document.getElementById('model-pills');
  container.innerHTML = '';

  // Custom dropdown: a trigger button + a popover panel
  const wrapper = document.createElement('div');
  wrapper.className = 'model-dropdown';

  const trigger = document.createElement('button');
  trigger.className = 'profile-btn model-dropdown-trigger';
  trigger.type = 'button';
  updateTriggerLabel();

  const panel = document.createElement('div');
  panel.className = 'model-dropdown-panel';

  function updateTriggerLabel() {
    if (activeModels.size === 0) {
      trigger.textContent = 'All ▾';
    } else {
      const names = [...activeModels];
      trigger.textContent = names.length === 1 ? names[0] + ' ▾' : names.length + ' models ▾';
    }
  }

  function buildPanel() {
    panel.innerHTML = '';

    const makeRow = (label, value) => {
      const row = document.createElement('label');
      row.className = 'model-dropdown-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = value === 'All' ? activeModels.size === 0 : activeModels.has(value);

      cb.onchange = () => {
        if (value === 'All') {
          activeModels.clear();
        } else {
          if (cb.checked) activeModels.add(value);
          else activeModels.delete(value);
          if (activeModels.size === 0) activeModels.clear(); // fall back to All
        }
        buildPanel();
        updateTriggerLabel();
        renderAll();
      };

      row.appendChild(cb);
      if (value !== 'All') {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = modelColor(value);
        row.appendChild(dot);
      }
      row.appendChild(document.createTextNode(label));
      panel.appendChild(row);
    };

    makeRow('All', 'All');
    models.forEach(m => makeRow(m, m));
  }

  buildPanel();

  trigger.onclick = () => {
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', !isOpen);
    trigger.classList.toggle('open', !isOpen);
  };

  // Close on outside click (registered once on document, checks containment)
  if (!document.__modelDropdownListener) {
    document.__modelDropdownListener = (e) => {
      document.querySelectorAll('.model-dropdown').forEach(w => {
        if (!w.contains(e.target)) {
          w.querySelector('.model-dropdown-panel').classList.remove('open');
          w.querySelector('.model-dropdown-trigger').classList.remove('open');
        }
      });
    };
    document.addEventListener('click', document.__modelDropdownListener);
  }

  wrapper.appendChild(trigger);
  wrapper.appendChild(panel);
  container.appendChild(wrapper);
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
