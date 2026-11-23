// ---- localStorage keys ----
const LS_PAT  = 'claude_usage_stats_pat';
const LS_REPO = 'claude_usage_stats_repo';
const LS_FILE = 'claude_usage_stats_file';

const LS_API_URL = 'claude_usage_stats_api_url';
const LS_API_KEY = 'claude_usage_stats_api_key';

const LS_PRICE_INPUT       = 'claude_usage_stats_price_input';
const LS_PRICE_CACHE_READ  = 'claude_usage_stats_price_cache_read';
const LS_PRICE_CACHE_WRITE = 'claude_usage_stats_price_cache_write';
const LS_PRICE_OUTPUT      = 'claude_usage_stats_price_output';

let globalData = null;
let activeProfile = null;
let activeModels = new Set(); // empty = All models shown
let tokChart = null;
let ctxChart = null;

// Single locale for every user-facing date/time string, so the app stays in
// English regardless of the browser's language.
const UI_LOCALE = 'en-US';

// ---- Inline icon set ----
// Monochrome SVGs that inherit currentColor, so buttons keep one visual voice
// across platforms (emoji render differently on every OS).
const ICONS = {
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.25" y="7" width="9.5" height="6.5" rx="1.75"/><path d="M5.75 7V5.1a2.25 2.25 0 0 1 4.5 0V7"/></svg>',
  database: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.75" rx="4.75" ry="1.9"/><path d="M3.25 3.75v8.5c0 1.05 2.13 1.9 4.75 1.9s4.75-.85 4.75-1.9v-8.5"/><path d="M3.25 8c0 1.05 2.13 1.9 4.75 1.9S12.75 9.05 12.75 8"/></svg>',
  pricing: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11"/><path d="M10.9 5.2H7.1a1.9 1.9 0 0 0 0 3.8h1.8a1.9 1.9 0 0 1 0 3.8H5.1"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.6l2.9 2.9 6.1-6.6"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8"/><path d="M12 4l-8 8"/></svg>',
  resync: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 3v3h-3"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.8l2.4 2.4L6 12.4H3.6v-2.4z"/></svg>',
  warning: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5l6 10.5H2z"/><path d="M8 6v4"/><path d="M8 12.1v.01"/></svg>',
  chevronLeft: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>',
};

const MOBILE_BREAKPOINT = 760;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
