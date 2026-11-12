function buildLogTable(log, pricing, sessModel) {
  // Detect if this session has more than one distinct model across its entries
  const entryModels = [...new Set(log.filter(e => !e.event && e.model).map(e => e.model))];
  const hasMultiModel = entryModels.length > 1;
  const hasPricing = !!pricing;
  const defaultIsEmpty = hasPricing &&
    pricing._default.input === 0 && pricing._default.cacheRead === 0 &&
    pricing._default.cacheWrite === 0 && pricing._default.output === 0;

  const extraCols = (hasMultiModel ? 1 : 0) + (hasPricing ? 1 : 0);
  const cols = 8 + extraCols;

  let rows = '', i = 0;
  const numbered = log.map(e => ({ ...e, _n: e.event === 'compact' ? null : ++i }));
  const sorted = [...numbered].sort((a, b) => new Date(b.at) - new Date(a.at));

  for (const e of sorted) {
    if (e.event === 'compact') {
      rows += `<tr class="compact-row"><td colspan="${cols}">⚡ Compact — context reset to ${e.context_pct}%</td></tr>`;
    } else {
      const t = e.input_tokens + e.cache_read_tokens + e.cache_write_tokens + e.output_tokens;

      // Per-entry cost cell
      const costCell = hasPricing
        ? (() => {
            const key = e.model || sessModel || '';
            const hasPrice = findPrice(key, pricing) !== null;
            if (!hasPrice && defaultIsEmpty) return '<td class="cost-warning">?</td>';
            const mp = entryModelPrice(e, sessModel, pricing, e.at);
            const c = (e.input_tokens        || 0) / 1e6 * mp.input +
                      (e.cache_read_tokens   || 0) / 1e6 * mp.cacheRead +
                      (e.cache_write_tokens  || 0) / 1e6 * mp.cacheWrite +
                      (e.output_tokens       || 0) / 1e6 * mp.output;
            return '<td>' + fmtCost(c) + '</td>';
          })()
        : '';

      // Model column (only when session has more than one distinct model)
      const modelCell = hasMultiModel
        ? `<td>${e.model || sessModel || '—'}</td>`
        : '';

      rows += `<tr>
        <td>${e._n}</td><td>${fmtDt(e.at)}</td>
        ${modelCell}
        <td>${fmtN(e.input_tokens)}</td><td>${fmtN(e.cache_read_tokens)}</td>
        <td>${fmtN(e.cache_write_tokens)}</td><td>${fmtN(e.output_tokens)}</td>
        <td>${fmtN(t)}</td>${costCell}<td>${e.context_pct}%</td>
      </tr>`;
    }
  }

  const modelHeader = hasMultiModel ? '<th>Model</th>' : '';
  const costHeader  = hasPricing    ? '<th>Cost</th>'  : '';
  return `<table class="log">
    <thead><tr><th>#</th><th>Time</th>${modelHeader}<th>Input</th><th>Cache rd</th><th>Cache wr</th><th>Output</th><th>Total</th>${costHeader}<th>Ctx</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
