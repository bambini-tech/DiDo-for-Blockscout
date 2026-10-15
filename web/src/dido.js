/* DiDo for Blockscout — app half of the bundle. Runs inside the IIFE that
   web/build.mjs wraps around the vendored engine, so `DD` is in scope;
   nothing here touches window beyond the URL, the theme and the keyboard.

   DiDo is the DigitalDon terminal: the holder map is the ground of the whole
   page, and the chart docks over it bottom right with the engine's zones
   drawn on price. This is its open, stand-alone edition for the Blockscout
   PRO API Buildathon: every holder, cluster, wallet and token fact comes from
   this repo's own server, which reads the Blockscout PRO API and nothing
   else. This file holds NO analysis logic and NO map code. What it holds is:

     the pipeline   token resolution on DexScreener and candles from
                    GeckoTerminal for the price chart, plus the engine inputs
                    derived from the pair. Prices are the only data that does
                    not come from Blockscout, and they are read in the
                    viewer's browser.
     the field      the vendored holder-map block (stamped below, at the
                    HOLDERMAP placeholder) mounted into #stage and driven to
                    the viewport through its host-driven fullscreen path,
                    fed by the server's Blockscout holder intelligence.
     the chart      a candle chart with the engine's zones on price, with
                    lower timeframes fetched for the chart only -- the engine
                    keeps reading its 1h/4h series untouched.

     the watchlist  kept in this browser.
     the wallet     the server's Blockscout wallet scan rendered as a pane:
                    the journey from a holder on the map to what it holds,
                    and on to any of those tokens. */
(function (DD) {
  'use strict';

  const VERSION = '{{VERSION}}';
  const ENGINE_VERSION = '{{ENGINE_VERSION}}';

  /* ---------- data sources (mirror of webapp/index.html) ---------- */
  const DEXSCREENER = 'https://api.dexscreener.com/latest/dex';
  const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2';
  const JUPITER_CHARTS = 'https://datapi.jup.ag/v2/charts';
  /* The chains the server reads through the Blockscout PRO API. KEEP IN SYNC
     with src/chains.ts (test/web.test.mjs fails on drift). Keys are
     DexScreener chainIds, which is what the price pipeline keys on. */
  const SUPPORTED = new Set(['ethereum', 'eth', 'base', 'robinhood', 'arbitrum']);
  /* Every chain here is EVM; kept so the home filter's grouping still reads. */
  const NON_EVM = new Set(['solana']);
  const GT_CHAIN = { ethereum: 'eth', eth: 'eth', base: 'base', robinhood: 'robinhood', arbitrum: 'arbitrum' };
  /* Aliases a URL is likely to carry in `?c=`. Values are DexScreener
     chainIds, which is what the pipeline keys on. */
  const CHAIN_ALIASES = { eth: 'ethereum', ethereum: 'ethereum', base: 'base', robinhood: 'robinhood', rh: 'robinhood', arb: 'arbitrum', arbitrum: 'arbitrum' };
  /* Each chain's Blockscout explorer: every address and token DiDo shows is
     one click from its page there. KEEP IN SYNC with src/chains.ts. */
  const EXPLORERS = { ethereum: 'https://eth.blockscout.com', eth: 'https://eth.blockscout.com', base: 'https://base.blockscout.com', arbitrum: 'https://arbitrum.blockscout.com', robinhood: 'https://robinhoodchain.blockscout.com' };

  const SEARCH_TIMEOUT_MS = 12000;
  const OHLCV_TIMEOUT_MS = 15000;
  const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
  const RETRY_ATTEMPTS = 2;      // total tries per URL, not extra tries
  const RETRY_DELAY_MS = 900;
  const OHLCV_SPOT_MAX_RATIO = 25;
  /* Minute bars below which the fresh-launch chart is not drawn. Same as
     DigitalDon's other surfaces: they must not disagree on when a launch is
     chartable. */
  const FRESH_CHART_MIN_BARS = 5;
  /* Hourly bars below which no technical analysis is attempted. Read from the
     engine rather than restated, because a restated constant is one that can
     drift. The engine is the only thing entitled to say when a series is
     too short to read, and it already says so. */
  const TA_MIN_BARS = DD.MIN_ANALYSIS_BARS;

  /* Holder intelligence: same two-stage call and the same budgets as the
     analyzer (base ~20 s, a cold cluster walk up to a minute). */
  const HOLDER_BASE_TIMEOUT_MS = 60000;
  const HOLDER_FULL_TIMEOUT_MS = 120000;
  const HOLDER_ERRORS = {
    invalid_token: 'the token address could not be validated.',
    unsupported_chain: 'no holder map for this chain yet.',
    token_not_found: 'could not resolve this token right now.',
    rate_limited: 'too many requests — give it a minute and try again.',
    not_configured: 'the server has no Blockscout API key configured.',
    feature_disabled: 'holder intelligence is not live right now.',
    internal: 'the holder engine hit an unexpected error. try again in a minute.',
  };

  /* Chart-only timeframes. The engine reads 1h (500) and 4h (300) exactly as
     the analyzer fetches them; 5m and 15m exist for the eye and never reach
     DD.analyze. Bars per screen at first paint, then the wheel takes over. */
  const TIMEFRAMES = {
    '5m': { path: 'minute', aggregate: 5, limit: 300, ms: 5 * 60000 },
    '15m': { path: 'minute', aggregate: 15, limit: 300, ms: 15 * 60000 },
    '1h': { path: 'hour', aggregate: 1, limit: 500, ms: 3600000 },
    '4h': { path: 'hour', aggregate: 4, limit: 300, ms: 4 * 3600000 },
  };
  const DEFAULT_TF = '1h';
  const DEFAULT_BARS = 96;      // bars on screen at first paint; the analyzer's old still frame drew exactly this many
  const PRICE_POLL_MS = 30000;
  const CHART_SIZES = ['sm', 'md', 'lg'];

  /* Chart geometry and behaviour, KEEP IN SYNC with the analyzer's chart
     section (webapp/index.html, `CHART_MIN_BARS` onwards). The terminal and
     the analyzer draw the same plan on the same candles; a viewer who reads a
     level here and checks it there must see the same picture.
     dido/test/build.test.mjs reads both files and fails on drift. */
  const CHART_MIN_BARS = 12;     // tightest zoom, in bars
  const CHART_RIGHT_GAP = 4;     // empty bars held at the right edge
  /* How far outside the visible candles a level may sit and still pull the
     y-axis with it. Beyond this it is parked on the price rail with an arrow
     instead: a long-term target at +130% would otherwise flatten every candle
     in view into a hairline. */
  const CHART_FIT_LO = 0.55, CHART_FIT_HI = 1.9;
  /* Candidate time-axis spacings in minutes, finest first. */
  const CHART_TICK_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080, 20160, 43200];

  /* The plan's levels as the chart draws them, a mirror of the analyzer's
     chartLevelSpecs(). All six numbers the plan cards print, not the three
     the old still frame drew -- a chart that shows half the plan and a card
     that prints all of it describe different trades. A level the engine did
     not produce (the short-term plan is withheld for $DON, and a fresh launch
     has none at all) is simply absent. Nothing here computes a level: that is
     the engine's job, and a chart that computed one would be a third engine. */
  function chartLevelSpecs(res) {
    const pos = v => typeof v === 'number' && isFinite(v) && v > 0;
    const band = (key, label, tag, lo, hi, o) => (pos(lo) && pos(hi))
      ? Object.assign({ key, label, tag, lo: Math.min(lo, hi), hi: Math.max(lo, hi) }, o || {}) : null;
    return [
      band('entrySt', 'entry st', 'entry st', res.stEntryLow, res.stEntryHigh),
      band('exitSt', 'exit st', 'exit st', res.stTpLow, res.stTpHigh, { line: 'lo' }),
      band('entryLt', 'entry lt', 'entry lt', res.ltEntryLow, res.ltEntryHigh),
      band('exitLt', 'target lt', 'target lt', res.ltTpLow, res.ltTpHigh, { line: 'lo' }),
    ].filter(Boolean);
  }

  /* ---------- DOM ---------- */
  const $ = id => document.getElementById(id);
  const els = {
    app: $('app'), stage: $('stage'), trail: $('trail'), sec: $('sec'),
    tradeChip: $('tradeChip'),
    search: $('search'), input: $('searchInput'), go: $('searchGo'), rows: $('searchRows'),
    empty: $('empty'), emptyTitle: $('emptyTitle'), emptySub: $('emptySub'),
    chart: $('chart'), tape: $('tape'), tfs: $('tfs'), emaChip: $('emaChip'), zonesChip: $('zonesChip'),
    sizeChip: $('sizeChip'), maxChip: $('maxChip'), foldChip: $('foldChip'),
    plot: $('plot'), grips: document.querySelectorAll('.dd-chart__grip'), chartNote: $('chartNote'), chartChip: $('chartChip'),
    legend: $('legend'), measureChip: $('measureChip'), units: $('units'),
    starChip: $('starChip'), wlChip: $('wlChip'),
    brand: $('brand'), soc: $('soc'), socBall: $('socBall'), ticker: $('ticker'), links: $('links'), tl: $('tl'), tr: $('tr'), railFold: $('railFold'), railChip: $('railChip'),
    mapState: $('mapState'), mapStateText: $('mapStateText'), mapStateBar: $('mapStateBar'), mapStateFill: $('mapStateFill'),
    wl: $('wl'), wlHz: $('wlHz'), wlPills: $('wlPills'), wlBody: $('wlBody'), wlNote: $('wlNote'), wlCopy: $('wlCopy'), wlClose: $('wlClose'),
    wal: $('wal'), walTitle: $('walTitle'), walBody: $('walBody'), walCopy: $('walCopy'), walClose: $('walClose'),
    wground: $('wground'), wgCap: $('wgCap'), wgFold: $('wgFold'), wgBody: $('wgBody'), wgRead: $('wgRead'), hctx: $('hctx'), journey: $('journey'),
    home: $('home'), homeShelves: $('homeShelves'), garden: $('garden'), gpeek: $('gardenPeek'),
    homeStage: $('homeStage'), homeField: $('homeField'), homeWait: $('homeWait'), homeWaitT: $('homeWaitT'), homeWaitPct: $('homeWaitPct'), homeWaitRect: $('hsLoadRect'), homeZoom: $('homeZoom'),
    homeKey: $('homeKey'), homeFilters: $('homeFilters'), homeFiltersBtn: $('homeFiltersBtn'), homePill: $('homePill'), homeTrend: $('homeTrend'), homeWatch: $('homeWatch'), homeRecent: $('homeRecent'),
  };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dash = s => String(s == null ? '' : s).split(' -- ').join(' — ');
  const fmtPct = v => (v == null || !isFinite(v)) ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(1)}%`;
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const fmtClock = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  /* A market cap on the chart's rail: three significant digits, so four
     grid lines a few percent apart still read apart ($412K, $41.2K, $4.12M).
     DD.fmtLarge rounds to whole thousands and would print one label twice. */
  const fmtCap = v => {
    if (!(v > 0)) return '$0';
    const [d, u] = v >= 1e9 ? [1e9, 'B'] : v >= 1e6 ? [1e6, 'M'] : v >= 1e3 ? [1e3, 'K'] : [1, ''];
    const x = v / d;
    return `$${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}${u}`;
  };
  const fmtDay = t => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

  /* ---------- the URL is the place ----------
     ?c=<chain>&t=<address> names a token, ?q=<query> searches for one,
     ?a=<0x…> opens a wallet beside it, ?w=<cc>:<address>,… merges a shared
     watchlist in (the analyzer's list-link format). The hash carries the
     view: #tf=1h&chart=md. Both are rewritten as the viewer moves, so any
     moment of the terminal is a link. Moving to another place (a token, a
     wallet) is a history step, so the browser's back retraces the journey;
     a change of view only rewrites the current step. */
  function readUrl() {
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    return {
      chain: normChain(params.get('c') || params.get('chain')),
      address: (params.get('t') || params.get('address') || '').trim(),
      q: (params.get('q') || '').trim(),
      wallet: WAL_ADDR_RE.test((params.get('a') || '').trim()) ? params.get('a').trim() : '',
      w: (params.get('w') || '').trim(),
      tf: TIMEFRAMES[hash.get('tf')] ? hash.get('tf') : DEFAULT_TF,
      chart: ['sm', 'md', 'lg', 'off'].includes(hash.get('chart')) ? hash.get('chart') : 'md',
      unit: hash.get('y') === 'mc' ? 'mcap' : 'price',
    };
  }
  /* The first place written after the page opens, or after a back/forward
     re-runs a token, corrects the step it is on rather than adding one. */
  let navReplace = true;
  function writeUrl() {
    const params = new URLSearchParams();
    if (current) { params.set('c', current.chain); params.set('t', current.address); }
    if (WALLET.addr) params.set('a', WALLET.addr);
    const hash = new URLSearchParams();
    if (chart.tf !== DEFAULT_TF) hash.set('tf', chart.tf);
    if (chart.unit === 'mcap') hash.set('y', 'mc');
    if (chart.folded) hash.set('chart', 'off');
    else if (chart.size !== 'md') hash.set('chart', chart.size);
    const qs = params.toString(), hs = hash.toString();
    const next = `${location.pathname}${qs ? `?${qs}` : ''}${hs ? `#${hs}` : ''}`;
    const moved = `${qs ? `?${qs}` : ''}` !== location.search;
    const replace = navReplace;
    navReplace = false;
    let pushed = false;
    if (next !== location.pathname + location.search + location.hash) {
      try {
        if (moved && !replace) { history.pushState(null, '', next); pushed = true; }
        else history.replaceState(null, '', next);
      } catch (e) { /* file:// and friends */ }
    }
    TRAIL.step(pushed);
  }

  /* ---------- the trail ----------
     Every place visited on this page, at the foot of the field: the journey
     made visible. The steps ARE the browser's history steps (writeUrl above
     adds or corrects one), so going to a step is history.go, and the
     popstate handler puts that place back on screen exactly as the back
     button does. It replaces the single back chip the wallet used to leave
     in the band. A reload starts a new trail. */
  const TRAIL = (() => {
    let steps = [], at = -1, fresh = false;
    function here() {
      const a = WALLET.addr;
      if (a) return { kind: 'wallet', label: `${a.slice(0, 6)}…${a.slice(-4)}`, logo: '' };
      if (current) return { kind: 'token', label: `$${current.symbol || '?'}`, logo: current.image_url && IMG_OK.test(current.image_url) ? current.image_url : '' };
      return { kind: 'home', label: 'start', logo: '' };
    }
    function step(pushed) {
      const s = Object.assign({ search: location.search }, here());
      if (pushed || at < 0) { steps = steps.slice(0, at + 1); steps.push(s); at = steps.length - 1; fresh = pushed; }
      else steps[at] = s;
      render();
    }
    /* Back, forward, or a jump from the trail: find the step this URL is,
       the nearest one to where we were when a place was visited twice. */
    function popped() {
      const q = location.search;
      let best = -1;
      steps.forEach((s, k) => { if (s.search === q && (best < 0 || Math.abs(k - at) < Math.abs(best - at))) best = k; });
      if (best >= 0) at = best;
      render();
    }
    /* The token's name arrives after its step was written. Only a token's
       own step takes it: leaving a wallet for a token names the token
       before the URL has moved on, and the wallet's step stays the wallet. */
    function named() {
      if (at < 0 || !steps[at] || steps[at].search !== location.search) return;
      if (new URLSearchParams(steps[at].search).get('a')) return;
      const h = here();
      if (h.kind !== 'token') return;
      if (h.label === steps[at].label && h.logo === steps[at].logo) return;
      Object.assign(steps[at], h);
      render();
    }
    /* The pill. Folded, it shows where you are and the step before it;
       the rest of the way folds into a little stack of marks with a count
       at either end. Hovered, focused or tapped, it slides open toward the
       past the way the website's island nav unfolds -- but never wider than
       the room at the foot of the field: what stands there (the chart, the
       wallet, the watchlist, the map's zoom) is measured and the pill moves
       aside and caps itself to the free stretch. A journey longer than that
       stays one pill with a window on it, slid a page at a time by the
       chevrons (or the wheel), its edges fading where more of the way is.
       Every width and offset is set through the style object (the CSP). */
    const WIN = 2, GAP = 12, NEAR = 24;
    let open = false, offset = 0, maxView = 640, closeT = 0, lastIn = -1;
    const nodes = () => ({
      el: els.journey,
      view: els.journey.querySelector('.dd-journey__view'),
      track: els.journey.querySelector('.dd-journey__track'),
      btns: [...els.journey.querySelectorAll('[data-step]')],
    });
    const markOf = (s, cls) => s.kind === 'wallet' ? `<i class="dd-journey__mark is-wallet${cls}" aria-hidden="true">◇</i>`
      : s.kind === 'token' ? `<i class="dd-journey__mark${cls}" data-logo="${esc(s.logo)}" aria-hidden="true">${esc(s.label.replace(/^\$/, '').slice(0, 1))}</i>`
        : `<i class="dd-journey__mark is-home${cls}" aria-hidden="true">·</i>`;
    /* the folded window: the step you are on and the one before it */
    function win() {
      const b = Math.max(Math.min(steps.length - 1, at), Math.min(WIN - 1, steps.length - 1));
      return [Math.max(0, b - WIN + 1), b];
    }
    const CHEV = d => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
    function render() {
      const el = els.journey, show = steps.length > 1;
      el.hidden = !show;
      els.app.classList.toggle('has-trail', show);
      if (!show) { open = false; el.classList.remove('is-open'); return; }
      const [a, b] = win();
      const stack = (from, to, side) => {
        const n = to - from;
        if (n <= 0) return `<button type="button" class="dd-journey__stack is-${side}" data-stack="${side}" hidden tabindex="-1"></button>`;
        const shown = steps.slice(from, to);
        const pick = side === 'l' ? shown.slice(-3) : shown.slice(0, 3);
        return `<button type="button" class="dd-journey__stack is-${side}" data-stack="${side}" aria-label="${n} more step${n === 1 ? '' : 's'} ${side === 'l' ? 'before' : 'after'} this one: show the whole trail">`
          + `<span class="dd-journey__pile">${pick.map(st => markOf(st, ' is-mini')).join('')}</span><b class="num">${n}</b></button>`;
      };
      el.innerHTML = '<span class="dd-journey__k">trail</span>'
        + stack(0, a, 'l')
        + `<button type="button" class="dd-journey__nav is-prev" data-nav="-1" aria-label="earlier steps" tabindex="-1">${CHEV('M10 3.5 5.5 8l4.5 4.5')}</button>`
        + '<div class="dd-journey__view"><div class="dd-journey__track">'
        + steps.map((st, k) => `${k ? '<span class="dd-journey__sep" aria-hidden="true">›</span>' : ''}<button type="button" data-step="${k}"${k === at ? ' aria-current="step"' : ''}${fresh && k === at ? ' class="is-new"' : ''}>${markOf(st, '')}${esc(st.label)}</button>`).join('')
        + '</div></div>'
        + `<button type="button" class="dd-journey__nav is-next" data-nav="1" aria-label="later steps" tabindex="-1">${CHEV('M6 3.5 10.5 8 6 12.5')}</button>`
        + stack(b + 1, steps.length, 'r');
      fresh = false;
      el.querySelectorAll('[data-logo]').forEach(mark => {
        const src = mark.dataset.logo;
        if (!src) return;
        const img = new Image();
        img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin';
        img.onload = () => { if (img.naturalWidth && mark.isConnected) { mark.textContent = ''; mark.appendChild(img); fit(); } };
        img.src = src;
      });
      lastIn = -1;
      fit(true);
    }
    /* The free stretch at the foot of the field: the window less every pane
       that stands at the pill's height. The stretch under the middle of the
       window if there is one wide enough, else the widest. */
    function room() {
      const W = innerWidth;
      if (W <= 640) return { left: GAP, right: W - GAP };
      const band = { top: innerHeight - 14 - 44, bottom: innerHeight - 8 };
      const walls = [];
      [chart.max ? null : els.chart, els.chartChip, els.wl, els.wal, els.stage.querySelector('.hm-bar .holder-map-controls')].forEach(p => {
        if (!p || p.hidden) return;
        const r = p.getBoundingClientRect();
        if (r.width > 1 && r.top < band.bottom && r.bottom > band.top) walls.push([r.left - GAP, r.right + GAP]);
      });
      walls.sort((x, y) => x[0] - y[0]);
      const segs = [];
      let x = GAP;
      walls.forEach(([l, r]) => { if (l > x) segs.push({ left: x, right: l }); x = Math.max(x, r); });
      if (W - GAP > x) segs.push({ left: x, right: W - GAP });
      if (!segs.length) return { left: GAP, right: W - GAP };
      const mid = segs.find(sg => sg.left <= W / 2 && sg.right >= W / 2 && sg.right - sg.left >= 260);
      return mid || segs.reduce((m, sg) => (sg.right - sg.left > m.right - m.left ? sg : m));
    }
    /* Lay the pill out: the view's width, the track's offset, the arrows and
       fades, and where the pill stands. `snap` sets it without the slide
       (a fresh render), so only what changes moves. */
    function fit(snap) {
      const { el, view, track, btns } = nodes();
      if (el.hidden || !view || !btns.length) return;
      const [a, b] = win();
      const L = k => btns[k].offsetLeft, R = k => btns[k].offsetLeft + btns[k].offsetWidth;
      const full = track.scrollWidth;
      const rm = room();
      const appL = els.app.getBoundingClientRect().left;
      // the pill's own chrome: label, stacks and arrows, padding and border
      // (scrollWidth: a folding stack's natural width, not its width mid-fold)
      const chromeOf = list => list.reduce((w, n) => w + (n && !n.hidden ? n.scrollWidth + 2 : 0), 0) + 12;
      const k = el.querySelector('.dd-journey__k');
      const sl = el.querySelector('.dd-journey__stack.is-l'), sr = el.querySelector('.dd-journey__stack.is-r');
      const pv = el.querySelector('.is-prev'), nx = el.querySelector('.is-next');
      let viewW, over = false;
      if (!open) {
        viewW = R(b) - L(a);
        offset = L(a);
      } else {
        maxView = Math.max(160, (rm.right - rm.left) - chromeOf([k]) - 2 * 30);
        over = full > maxView + 1;
        viewW = over ? maxView : full;
        if (!over) offset = 0;
        else {
          if (snap || lastIn < 0) offset = R(b) - viewW;   // open toward the past
          offset = Math.max(0, Math.min(full - viewW, offset));
        }
      }
      el.classList.toggle('is-open', open);
      el.classList.toggle('is-over', over);
      el.classList.toggle('has-l', open ? offset > 1 : a > 0);
      el.classList.toggle('has-r', open ? offset < full - viewW - 1 : b < steps.length - 1);
      if (pv) { pv.disabled = !(over && offset > 1); pv.tabIndex = over ? 0 : -1; }
      if (nx) { nx.disabled = !(over && offset < full - viewW - 1); nx.tabIndex = over ? 0 : -1; }
      // the stacks are a pointer's way in; the keyboard opens the pill by
      // landing on a step, and the arrow keys walk the rest
      [sl, sr].forEach(st => { if (st) st.tabIndex = -1; });
      if (snap) el.classList.add('is-snap');
      view.style.width = `${Math.ceil(viewW)}px`;
      track.style.transform = `translateX(${-Math.round(offset)}px)`;
      btns.forEach((bt, i) => { bt.tabIndex = (L(i) >= offset - 1 && R(i) <= offset + viewW + 1) ? 0 : -1; });
      lastIn = 1;
      // where the pill stands: the middle of the window when the stretch
      // holds it there, else as near it as the stretch allows
      const arrows = open && over ? 2 * 30 : 0;
      const stacks = open ? 0 : chromeOf([sl, sr]) - 12;
      const total = viewW + chromeOf([k]) + arrows + stacks;
      const W = innerWidth;
      const cx = Math.max(rm.left + total / 2, Math.min(rm.right - total / 2, W / 2));
      el.style.left = `${Math.round(cx - appL)}px`;
      if (snap) { void el.offsetWidth; el.classList.remove('is-snap'); }
    }
    /* Slide a page, landing on a step's edge rather than through a label. */
    function slide(dir) {
      const { view, track, btns } = nodes();
      if (!view) return;
      const viewW = view.offsetWidth, full = track.scrollWidth;
      const want = offset + dir * viewW * 0.72;
      const edges = btns.map(bt => bt.offsetLeft - 6);
      let to = dir > 0 ? (edges.filter(e => e > offset + 1 && e <= want).pop() ?? want) : (edges.filter(e => e < offset - 1 && e >= want)[0] ?? want);
      offset = Math.max(0, Math.min(full - viewW, to));
      fit();
    }
    function setOpen(on) {
      clearTimeout(closeT);
      if (on === open) return;
      open = on;
      lastIn = -1;   // opening starts from the newest end of the window
      fit();
    }
    const el = els.journey;
    const hoverable = () => !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    el.addEventListener('pointerenter', ev => { if (ev.pointerType === 'mouse' || hoverable()) setOpen(true); });
    el.addEventListener('pointerleave', ev => {
      if (ev.pointerType !== 'mouse' && !hoverable()) return;
      clearTimeout(closeT);
      // a grace on the way out, so a pointer grazing the edge does not fold it
      closeT = setTimeout(() => { if (!el.querySelector(':focus-visible')) setOpen(false); }, 380);
    });
    el.addEventListener('focusin', ev => {
      if (ev.target.matches && ev.target.matches(':focus-visible')) setOpen(true);
      const bt = ev.target.closest && ev.target.closest('[data-step]');
      if (!bt) return;
      const { view, track } = nodes();
      const l = bt.offsetLeft, r = l + bt.offsetWidth, w = view.offsetWidth;
      if (l < offset || r > offset + w) { offset = Math.max(0, Math.min(track.scrollWidth - w, l < offset ? l - NEAR : r - w + NEAR)); fit(); }
    });
    el.addEventListener('focusout', () => { setTimeout(() => { if (!el.contains(document.activeElement) && !el.matches(':hover')) setOpen(false); }, 0); });
    el.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && open) { ev.stopPropagation(); if (el.contains(document.activeElement)) document.activeElement.blur(); setOpen(false); return; }
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const { btns } = nodes();
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      const j = i + (ev.key === 'ArrowLeft' ? -1 : 1);
      if (btns[j]) { ev.preventDefault(); btns[j].tabIndex = 0; btns[j].focus({ preventScroll: true }); }
    });
    el.addEventListener('wheel', ev => {
      if (!open || !el.classList.contains('is-over')) return;
      const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (!d) return;
      ev.preventDefault();
      const { view, track } = nodes();
      offset = Math.max(0, Math.min(track.scrollWidth - view.offsetWidth, offset + d));
      el.classList.add('is-wheel');
      fit();
      clearTimeout(el._wheelT);
      el._wheelT = setTimeout(() => el.classList.remove('is-wheel'), 140);
    }, { passive: false });
    el.addEventListener('click', ev => {
      const nav = ev.target.closest('[data-nav]');
      if (nav) { slide(+nav.dataset.nav); return; }
      if (ev.target.closest('[data-stack]') || (!open && ev.target.closest('.dd-journey__k'))) { setOpen(true); return; }
      const bt = ev.target.closest('[data-step]');
      if (!bt) return;
      const k = +bt.dataset.step;
      if (k !== at) history.go(k - at);
    });
    // a tap anywhere else folds it again (touch screens; a mouse leaves)
    document.addEventListener('pointerdown', ev => { if (open && !el.contains(ev.target)) setOpen(false); }, true);
    window.addEventListener('resize', () => fit(true));
    return { step, popped, named, fit: () => fit() };
  })();
  function normChain(c) {
    const k = String(c || '').trim().toLowerCase();
    return CHAIN_ALIASES[k] || (k && SUPPORTED.has(k) ? k : '');
  }

  /* ---------- deployment config (own origin) ----------
     This page's own server is the API: it answers /api/config with what is
     live (a Blockscout key configured or not). Fails closed: no answer, no
     map -- the chart still runs. */
  const CONFIG = { api: '', holder_intel: false, wallet_scan: false, loaded: false };
  const configReady = (async () => {
    try {
      const res = await fetch('/api/config', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const json = await res.json();
      if (json && json.ok) {
        CONFIG.holder_intel = json.holder_intel === true;
        CONFIG.wallet_scan = json.wallet_scan === true;
      }
    } catch (e) { /* stays closed */ }
    CONFIG.loaded = true;
  })();

  /* ---------- theme ----------
     DiDo is dark: a terminal, worn at night, the ground's water reads best on
     it. The page ships with data-theme="dark"; the light tokens stay in the
     stylesheet for the shared block, but there is no switch. */
  function isDark() { return true; }
  document.documentElement.setAttribute('data-theme', 'dark');
  try { localStorage.removeItem('dido-theme'); } catch (e) { /* private mode */ }

  /* ---------- state ---------- */
  let runToken = 0;      // invalidates in-flight runs when a newer one starts
  let current = null;    // tokenInfo of the token on screen
  let currentPair = null;
  let currentRes = null; // the engine's read, or null before/without one
  let holdersRun = null; // { key, status, base, full } for the current token
  let searchOpen = false;
  let home = null;       // the welcome (HOME, below); set once it is built
  let fieldNoted = false; // a note owns the empty field (a picker, an error, a wallet)

  /* idle: no token. loading: resolving. live: a token is on screen (the map
     may still be loading or absent). error: the search failed. */
  function setState(state) {
    els.app.dataset.state = state;
    // the first search sends the start screen's pill up into the band, for good
    if (state === 'loading' || state === 'live') els.app.classList.add('has-run');
    const idle = state === 'idle';
    const live = state === 'live';
    els.empty.hidden = live && !!(holdersRun && holdersRun.status !== 'error' && holdersRun.status !== 'none');
    els.go.disabled = state === 'loading';
    if (!live) { els.chart.hidden = true; els.chartChip.hidden = true; }
    else chart.syncVisible();
    if (idle) {
      els.emptyTitle.textContent = 'paste a token.';
      els.emptyTitle.classList.remove('is-err');
      els.emptySub.hidden = false;
    }
    fieldNoted = false;
    if (home) home.sync();
    updateDock();
  }
  function fieldNote(text, isErr) {
    if (isErr) COIN.land('token');   // a token that cannot be drawn ends its bubble's travel
    els.emptyTitle.textContent = text;
    els.emptyTitle.classList.toggle('is-err', !!isErr);
    els.emptySub.hidden = true;
    els.empty.hidden = false;
    fieldNoted = true;
    if (home) home.sync();
  }
  function showError(msg) {
    holdersRun = null;
    setState('error');
    fieldNote(msg, true);
  }

  /* ---------- search ---------- */
  /* The pill lives in the band for good: open = wide and focused (also
     while its result rows show), closed = narrow again. A click anywhere
     else closes it. */
  function openSearch() {
    searchOpen = true;
    els.search.classList.add('is-open');
    els.input.focus();
    els.input.select();
  }
  function closeSearch() {
    searchOpen = false;
    els.search.classList.remove('is-open');
    els.rows.hidden = true;
    els.rows.innerHTML = '';
    els.input.blur();
  }
  els.input.addEventListener('focus', () => { searchOpen = true; els.search.classList.add('is-open'); });
  // a tap anywhere on the pill (on a phone it is only a glyph) opens it
  els.search.addEventListener('click', ev => { if (!searchOpen && !ev.target.closest('button')) openSearch(); });
  document.addEventListener('pointerdown', ev => {
    if (searchOpen && !els.search.contains(ev.target)) closeSearch();
  }, true);
  els.search.addEventListener('submit', ev => {
    ev.preventDefault();
    run(els.input.value);
  });

  /* ---------- fetch helpers (mirror of webapp/index.html) ---------- */
  async function getJsonOnce(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async function getJson(url, timeoutMs = SEARCH_TIMEOUT_MS) {
    let lastErr;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        return await getJsonOnce(url, timeoutMs);
      } catch (e) {
        lastErr = e;
        const retryable = e.status == null || RETRY_STATUS.has(e.status);
        if (!retryable || attempt === RETRY_ATTEMPTS - 1) throw e;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    throw lastErr;
  }
  /* The API answers typed envelopes on every status; read the body
     regardless and let the caller act on `ok`/`error`. */
  async function fetchJsonTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- token resolution ---------- */
  function bestPerChain(pairs) {
    const byChain = {};
    for (const p of pairs || []) {
      const chain = (p.chainId || '').toLowerCase();
      if (!SUPPORTED.has(chain)) continue;
      const liq = +((p.liquidity || {}).usd || 0);
      const curLiq = byChain[chain] ? +((byChain[chain].liquidity || {}).usd || 0) : -1;
      if (liq > curLiq) byChain[chain] = p;
    }
    return Object.values(byChain).sort((a, b) =>
      +((b.liquidity || {}).usd || 0) - +((a.liquidity || {}).usd || 0));
  }
  /* /tokens/{address} lists every pool the token sits in, on EITHER side; a
     pool where it is the quote token prices the OTHER asset. Keep the pools
     that price the token asked about (mirror of the analyzer's
     findPairsPlain and the bot's search_token_multichain). A known address
     whose every pool has it on the quote side is a miss, not its neighbour. */
  const pricesToken = (p, addr) =>
    ((p.baseToken || {}).address || '').toLowerCase() === addr.toLowerCase();
  async function findPairs(query) {
    const q = query.trim();
    const looksLikeAddress = /^0x[a-fA-F0-9]{40}$/.test(q) || /^[A-Za-z0-9]{25,}$/.test(q);
    if (looksLikeAddress) {
      try {
        const data = await getJson(`${DEXSCREENER}/tokens/${encodeURIComponent(q)}`);
        const pairs = data.pairs || [];
        if (pairs.length) return bestPerChain(pairs.filter(p => pricesToken(p, q)));
      } catch (e) { /* fall through to search */ }
    }
    const data = await getJson(`${DEXSCREENER}/search?q=${encodeURIComponent(q)}`);
    return bestPerChain(data.pairs).slice(0, 3);
  }
  /* A link named the token. Resolve by address; honour the chain when it
     matches a pool, fall back to the deepest pool anywhere when it does not. */
  async function findPinned(chain, address) {
    const data = await getJson(`${DEXSCREENER}/tokens/${encodeURIComponent(address)}`);
    const pairs = bestPerChain((data.pairs || []).filter(p => pricesToken(p, address)));
    if (!pairs.length) return [];
    if (chain) {
      const onChain = pairs.filter(p => (p.chainId || '').toLowerCase() === chain);
      if (onChain.length) return onChain;
    }
    return [pairs[0]];
  }

  /* ---------- candles (mirror of webapp/index.html) ---------- */
  function parseOhlcv(json) {
    const list = (((json || {}).data || {}).attributes || {}).ohlcv_list || [];
    if (!list.length) return null;
    const rows = list.slice().sort((a, b) => a[0] - b[0]);
    return {
      t: rows.map(r => r[0] * 1000),
      o: rows.map(r => +r[1]), h: rows.map(r => +r[2]),
      l: rows.map(r => +r[3]), c: rows.map(r => +r[4]), v: rows.map(r => +r[5]),
    };
  }
  function ohlcvToken(pair) {
    const addr = ((pair.baseToken || {}).address || '').trim();
    if (!addr) return 'base';
    return addr.startsWith('0x') ? addr.toLowerCase() : addr;
  }
  function candlesMatchSpot(df, pair) {
    if (!df || !df.c || !df.c.length) return true;
    const last = +df.c[df.c.length - 1], spot = +pair.priceUsd || 0;
    if (!(last > 0) || !(spot > 0)) return true;
    const ratio = last / spot;
    return ratio >= 1 / OHLCV_SPOT_MAX_RATIO && ratio <= OHLCV_SPOT_MAX_RATIO;
  }
  /* Returns {df, answered, missing}. `df` is null in three situations that
     look identical from outside and are not: GeckoTerminal served an empty
     candle list (`answered`), it has never indexed the pool at all -- HTTP 404
     (`missing`), or the request failed outright: rate limit, 5xx, timeout,
     offline (neither). `missing` is its own flag because a 404 is a definite
     ANSWER about the pool, not a refusal to answer. */
  async function fetchOhlcvUrl(url, pair) {
    let df;
    try {
      df = parseOhlcv(await getJson(url, OHLCV_TIMEOUT_MS));
    } catch (e) {
      return { df: null, answered: false, missing: e && e.status === 404 };
    }
    return { df: candlesMatchSpot(df, pair) ? df : null, answered: true, missing: false };
  }

  /* The token's OTHER pools on this chain, deepest first -- the pinned one
     excluded, and base-token pools only, because in a pool where our token is
     the QUOTE side `priceUsd` denominates the other asset and the candles
     would price the wrong thing. Cached per token for the page's lifetime: a
     pool GeckoTerminal has no candles for still has none a minute later, and
     the terminal asks across several timeframes. */
  const ALT_POOL_MAX = 2;
  const _altPoolCache = new Map();

  async function altPoolPairs(pair) {
    const token = ((pair.baseToken || {}).address || '').trim();
    const chain = (pair.chainId || '').toLowerCase();
    if (!token || !chain) return [];
    const key = chain + ':' + token.toLowerCase();
    if (!_altPoolCache.has(key)) {
      let pairs = [];
      try {
        const data = await getJson(`${DEXSCREENER}/tokens/${encodeURIComponent(token)}`);
        pairs = (data && data.pairs) || [];
      } catch (e) { pairs = []; }
      _altPoolCache.set(key, pairs
        .filter(p => (p.chainId || '').toLowerCase() === chain)
        .filter(p => (((p.baseToken || {}).address || '').toLowerCase() === token.toLowerCase()))
        .sort((a, b) => (+((b.liquidity || {}).usd) || 0) - (+((a.liquidity || {}).usd) || 0)));
    }
    const pinned = (pair.pairAddress || '').toLowerCase();
    return _altPoolCache.get(key)
      .filter(p => { const a = (p.pairAddress || '').toLowerCase(); return a && a !== pinned; })
      .slice(0, ALT_POOL_MAX);
  }

  /* Candles for the token out of one of its other pools. Every frame is vetted
     against the PINNED pair's spot price, not the sibling's: a series that
     cannot be this token's price is useless here even if it is internally
     consistent. */
  async function fetchOhlcvFromAltPool(pair, suffix) {
    for (const alt of await altPoolPairs(pair)) {
      const url = `${GECKOTERMINAL}/networks/${gtNetwork(alt)}/pools/${alt.pairAddress}${suffix}`;
      const { df, answered, missing } =
        await fetchOhlcvUrl(url + encodeURIComponent(ohlcvToken(alt)), pair);
      if (df) return df;
      /* Empty (200) or unknown to GeckoTerminal (404) are both facts about
         THIS pool and say nothing about the next one -- on a young chain most
         siblings are 404s. A refusal is different: walking further down the
         list only deepens the hole. */
      if (!answered && !missing) break;
    }
    return null;
  }

  /* The addressed request answered "no candles for this token" -> the pool is
     indexed under another address, and the legacy selector keeps an analysis
     available. A request that never got answered is no evidence of that, and
     retrying it would just double the load on an endpoint already refusing us
     -- so a 404 does not trigger it either, since re-asking a pool
     GeckoTerminal does not have can only fail again.

     When the pinned pool comes back empty OR unknown, the token's other pools
     may still have candles: that is a fact about the POOL, not the token.
     DexScreener pins the deepest pool it can see, which on a chain either
     index has only just picked up is often one the other has no row for. */
  async function fetchOhlcvWithFallback(base, pair, suffix) {
    const token = ohlcvToken(pair);
    let { df, answered, missing } = await fetchOhlcvUrl(base + encodeURIComponent(token), pair);
    if (df) return df;
    if (answered && token !== 'base') {
      df = (await fetchOhlcvUrl(base + 'base', pair)).df;
      if (df) return df;
    }
    if (answered || missing) return await fetchOhlcvFromAltPool(pair, suffix);
    return null;
  }
  function gtNetwork(pair) {
    return GT_CHAIN[(pair.chainId || '').toLowerCase()] || (pair.chainId || '').toLowerCase();
  }
  /* Jupiter's chart API: Solana candles keyed by TOKEN, in USD, aggregated
     across every pool the mint trades in. Consulted only when GeckoTerminal
     produced nothing -- a pool it never indexed, typically a token paired
     against a stock token or a third-party coin (SNARKSTR/ZEC: a week of
     trading, an empty candle list on every side). Same endpoint, parameters,
     row filter and position in the chain as the bot's jupiter_source.py, so a
     token scores from the same series on every surface; the spot check still
     applies. `aggregate` follows GeckoTerminal: only exact equivalents map. */
  const JUP_INTERVAL = { 'minute:1': '1_MINUTE', 'minute:5': '5_MINUTE', 'minute:15': '15_MINUTE',
                        'hour:1': '1_HOUR', 'hour:4': '4_HOUR' };
  function parseJupiterCandles(json) {
    const ok = x => Number.isFinite(x) && x > 0;
    const rows = (((json || {}).candles) || [])
      .map(r => r && ({ t: +r.time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume }))
      .filter(r => r && Number.isFinite(r.t) && ok(r.o) && ok(r.h) && ok(r.l) && ok(r.c))
      .sort((a, b) => a.t - b.t);
    if (!rows.length) return null;
    return {
      t: rows.map(r => r.t * 1000),
      o: rows.map(r => r.o), h: rows.map(r => r.h),
      l: rows.map(r => r.l), c: rows.map(r => r.c),
      v: rows.map(r => (Number.isFinite(r.v) && r.v >= 0 ? r.v : 0)),
    };
  }
  async function fetchJupiterCandles(pair, timeframe, aggregate, limit) {
    if ((pair.chainId || '').toLowerCase() !== 'solana') return null;
    const interval = JUP_INTERVAL[`${timeframe}:${aggregate}`];
    const mint = ((pair.baseToken || {}).address || '').trim();
    if (!interval || !mint) return null;
    const n = Math.max(1, Math.min(limit | 0, 1000));
    const url = `${JUPITER_CHARTS}/${encodeURIComponent(mint)}?interval=${interval}` +
                `&to=${Date.now()}&candles=${n}&type=price&quote=usd`;
    let df;
    try { df = parseJupiterCandles(await getJson(url, OHLCV_TIMEOUT_MS)); }
    catch (e) { return null; }
    return candlesMatchSpot(df, pair) ? df : null;
  }

  async function fetchOhlcv(pair, aggregate, limit) {
    const suffix = `/ohlcv/hour?aggregate=${aggregate}&limit=${limit}&currency=usd&token=`;
    return (await fetchOhlcvWithFallback(
      `${GECKOTERMINAL}/networks/${gtNetwork(pair)}/pools/${pair.pairAddress}` + suffix, pair, suffix))
      || fetchJupiterCandles(pair, 'hour', aggregate, limit);
  }
  /* 1-minute candles, fresh launches only. GeckoTerminal's `minute` timeframe
     defaults to aggregate=15, so the multiplier has to be explicit. */
  async function fetchOhlcvMinute(pair, limit) {
    const suffix = `/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd&token=`;
    return (await fetchOhlcvWithFallback(
      `${GECKOTERMINAL}/networks/${gtNetwork(pair)}/pools/${pair.pairAddress}` + suffix, pair, suffix))
      || fetchJupiterCandles(pair, 'minute', 1, limit);
  }
  /* Chart-only candles. NOT part of the mirrored pipeline: nothing fetched
     here reaches the engine. Same host, same fallback, same spot check. */
  async function fetchChartOhlcv(pair, tf) {
    const cfg = TIMEFRAMES[tf];
    const suffix = `/ohlcv/${cfg.path}?aggregate=${cfg.aggregate}&limit=${cfg.limit}&currency=usd&token=`;
    return (await fetchOhlcvWithFallback(
      `${GECKOTERMINAL}/networks/${gtNetwork(pair)}/pools/${pair.pairAddress}` + suffix, pair, suffix))
      || fetchJupiterCandles(pair, cfg.path, cfg.aggregate, cfg.limit);
  }

  /* ---------- the run ---------- */
  async function runPair(pair) {
    const me = ++runToken;
    const info = DD.tokenInfo(pair);
    /* Token artwork for the map's nameplate. Outside DD.tokenInfo because
       that function is the engine, and the engine is in 1:1 parity with the
       bot -- this is presentation. */
    info.image_url = ((pair && pair.info) || {}).imageUrl || null;
    info.links = projectLinks(pair);
    current = info;
    currentPair = pair;
    currentRes = null;
    holdersRun = null;
    chart.reset();
    closeSearch();
    LINKS.close();
    renderTrail(info, null);
    renderSecurity(null);
    renderTicker();
    placeRailControls();
    applyTint(info.image_url);
    writeUrl();
    setState('live');
    if (home) home.remember(info, pair);
    WATCH.onRead(info, null, pair);
    fieldNote('reading the chain…', false);
    await configReady;
    if (me !== runToken) return;

    /* The field and the chart load side by side: the holder walk is the
       slow one, the candles are what a trader looks at first. */
    runHolders(info, pair);

    const [df1, df4] = await Promise.all([
      fetchOhlcv(pair, 1, 500),
      fetchOhlcv(pair, 4, 300),
    ]);
    if (me !== runToken) return;
    if (!df1 || DD.dfLen(df1) < TA_MIN_BARS) {
      /* Same fork as the analyzer: too few candles is a fact about the token
         (fresh, or dormant and barely traded) or a data problem on our side. */
      const bars1 = df1 ? DD.dfLen(df1) : 0;
      const bars4 = df4 ? DD.dfLen(df4) : 0;
      const thinHistory = (bars1 > 0 && bars1 < TA_MIN_BARS) || (bars4 > 0 && bars4 < TA_MIN_BARS);
      const fresh = DD.isFreshLaunch(info);
      if (fresh || thinHistory) {
        const df1m = await fetchOhlcvMinute(pair, 300);
        if (me !== runToken) return;
        const bars = df1m ? DD.dfLen(df1m) : 0;
        chart.setBase({ df1, df4, df1m: bars >= FRESH_CHART_MIN_BARS ? df1m : null, res: null,
          note: fresh ? 'fresh launch · no zones until the pool has a few hours of candles'
                      : 'thin history · no zones until the pool has traded for a few hours' });
        return;
      }
      chart.setBase({ df1: null, df4: null, df1m: null, res: null, note: 'not enough chart history to draw yet' });
      return;
    }
    /* Last argument: which token these candles belong to. Only DigitalDon's
       own token does anything with it (the engine's NATIVE_TOKENS table, which
       travels into this bundle with the engine). */
    const res = DD.analyze(df1, df4, info.vol_mcap_ratio, info.age_days, info.buys_24h, info.sells_24h,
                           { chain: info.chain, address: info.address,
                             asset_class: info.asset_class });
    if (me !== runToken) return;
    currentRes = res;
    renderTrail(info, res);
    WATCH.onRead(info, res, pair);
    chart.setBase({ df1, df4, df1m: null, res, note: null });
  }
  async function analyzePair(pair) {
    try {
      await runPair(pair);
    } catch (e) {
      console.error('[dido] run failed:', e);
      showError('something went wrong while reading this token. try again in a moment.');
    }
  }
  async function run(query) {
    if (!query || !query.trim()) return;
    const me = ++runToken;
    els.rows.hidden = true;
    if (!current) setState('loading');
    fieldNote('resolving…', false);
    let pairs;
    try {
      pairs = await findPairs(query);
    } catch (e) {
      if (me !== runToken) return;
      return showError('could not reach the market data right now. try again in a moment.');
    }
    if (me !== runToken) return;
    if (!pairs.length && WAL_ADDR_RE.test(query.trim())) {
      /* No pool anywhere for a 0x address: it is a wallet, not a token. */
      await configReady;
      if (me !== runToken) return;
      if (CONFIG.wallet_scan) {
        closeSearch();
        if (!current) { setState('idle'); fieldNote('pick a holding to open it.', false); }
        else setState('live');
        return WALLET.open(query.trim());
      }
    }
    if (!pairs.length) return showError(`no token found for "${query.trim()}" on a supported chain.`);
    if (pairs.length === 1) return analyzePair(pairs[0]);
    showPicker(pairs);
  }
  async function runPinned(chain, address) {
    const me = ++runToken;
    setState('loading');
    fieldNote('resolving…', false);
    let pairs;
    try {
      pairs = await findPinned(chain, address);
    } catch (e) {
      if (me !== runToken) return;
      return showError('could not reach the market data right now. try again in a moment.');
    }
    if (me !== runToken) return;
    if (!pairs.length) return showError('no pool found for this token on a supported chain.');
    if (pairs.length === 1) return analyzePair(pairs[0]);
    showPicker(pairs);
  }
  function showPicker(pairs) {
    els.rows.innerHTML = '';
    for (const p of pairs) {
      const info = DD.tokenInfo(p);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dd-row';
      b.innerHTML = `<span class="nm">${esc(info.name)}<span class="mono">$${esc(info.symbol)}</span></span>
        <span class="mt mono num">${esc(DD.chainTag(info.chain))} &middot; liq ${esc(DD.fmtLarge(info.liquidity_usd))}</span>`;
      b.addEventListener('click', () => analyzePair(p));
      els.rows.appendChild(b);
    }
    els.rows.hidden = false;
    if (!current) { setState('idle'); fieldNote('which one?', false); }
    openSearch();
  }

  /* ---------- the ticker (top left, beside the trail) ----------
     Price with its 24h move, then market cap, liquidity and 24h volume.
     Monochrome: the direction is a glyph (▲ ▼), never a hue. Each part has
     a priority; when the band runs out of room (a narrow window, a long
     name), fitBand() lets the lowest go first -- volume, then liquidity,
     then market cap -- and price with 24h always stays. */
  function renderTicker() {
    if (!current) { els.ticker.hidden = true; els.ticker.innerHTML = ''; return; }
    const chg = (currentPair && currentPair.priceChange) || {};
    const h24 = chg.h24 == null || !isFinite(chg.h24) ? null : +chg.h24;
    const dir = h24 == null ? '' : h24 > 0 ? 'up' : h24 < 0 ? 'dn' : '';
    const vol = (currentPair && currentPair.volume && currentPair.volume.h24) || null;
    els.ticker.innerHTML = [
      `<span data-pri="1" class="dd-ticker__px num">${esc(DD.fmtPrice(chart.lastPrice || current.price_usd))}</span>`,
      `<span data-pri="1" class="num dd-ch${dir ? ` dd-ch--${dir}` : ''}">${esc(fmtPct(h24))} <i>24h</i></span>`,
      `<span data-pri="2"><i>mc</i> <b class="num">${esc(DD.fmtLarge(current.market_cap || current.fdv))}</b></span>`,
      `<span data-pri="3"><i>liq</i> <b class="num">${esc(DD.fmtLarge(current.liquidity_usd))}</b></span>`,
      `<span data-pri="4"><i>vol</i> <b class="num">${esc(DD.fmtLarge(vol))}</b></span>`,
    ].join('');
    els.ticker.hidden = false;
    fitBand();
  }
  /* The search pill's footprint when narrow: the room the band keeps free
     in its centre, whatever the pill is doing right now. */
  const PHONE = window.matchMedia ? window.matchMedia('(max-width: 640px)') : { matches: false };
  function searchBox() {
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--search-w')) || 230;
    if (PHONE.matches) {
      // docked beside the chips on a phone
      const right = els.tr.getBoundingClientRect().left - 8;
      return { left: right - w - 10, right: right + 10 };
    }
    return { left: window.innerWidth / 2 - w / 2 - 10, right: window.innerWidth / 2 + w / 2 + 10 };
  }
  function fitBand() {
    /* The security strip sits right, against the chips, so the left group
       has the width of the band to itself; it goes to dots only (each keeps
       its title) when its words would reach the search pill. */
    els.sec.style.right = `${Math.round(window.innerWidth - els.tr.getBoundingClientRect().left + 8)}px`;
    els.search.style.right = PHONE.matches ? `${Math.round(window.innerWidth - els.tr.getBoundingClientRect().left + 8)}px` : '';
    // a phone's left group may use the band up to the docked search
    els.tl.style.maxWidth = PHONE.matches ? `${Math.max(120, Math.round(searchBox().left - 12))}px` : '';
    els.sec.classList.remove('is-tight');
    if (!els.sec.hidden && els.sec.getBoundingClientRect().left < searchBox().right) els.sec.classList.add('is-tight');
    const parts = [...els.ticker.querySelectorAll('[data-pri]')];
    const names = [...els.trail.querySelectorAll('.nm')];
    const word = [...els.brand.querySelectorAll('.dd-mark__w')];
    parts.concat(names, word).forEach(p => { p.hidden = false; });
    if (els.ticker.hidden || !parts.length) return;
    /* The left group must end before whatever sits next on the band: the
       security strip when it shows, else the right-hand chips. What goes,
       in order: the DiDo name beside the mark (the token's own facts matter
       more), then volume, the token's full name (the ticker symbol stays),
       liquidity, market cap. Price with its 24h move always stays. */
    const limit = () => {
      const next = !els.sec.hidden && els.sec.getBoundingClientRect().width > 0 ? els.sec : els.tr;
      return Math.min(next.getBoundingClientRect().left - 10, searchBox().left);
    };
    const steps = [
      word, parts.filter(p => +p.dataset.pri === 4), parts.filter(p => +p.dataset.pri === 3),
      parts.filter(p => +p.dataset.pri === 2), names,
    ];
    for (const step of steps) {
      if (els.ticker.getBoundingClientRect().right <= limit()) return;
      step.forEach(p => { p.hidden = true; });
    }
  }
  window.addEventListener('resize', fitBand);

  /* ---------- the project's links ----------
     DexScreener's pair.info: `socials` [{type, url}] and `websites`
     [{label, url}]. Third-party text, so only an absolute http(s) URL ever
     reaches an href (the analyzer's safeUrl rule) and every label goes
     through esc(). The window shows each link with where it really goes (the
     @handle, t.me/..., the bare domain), opens it in a new tab or copies it.
     It never links out to a
     screener (DexScreener's own page included): people stay in DiDo. Not
     checked by DigitalDon, and it says so. */
  const safeUrl = u => { const s = String(u == null ? '' : u).trim(); return /^https?:\/\//i.test(s) ? s : ''; };
  /* DiDo keeps people in DiDo: no link out to a screener or chart site,
     not even one a project lists as its own. */
  const SCREENERS = /^https?:\/\/([a-z0-9-]+\.)*(dexscreener|dextools|birdeye|geckoterminal|coingecko|coinmarketcap|gmgn|photon-sol|bullx|defined)\.[a-z.]+(\/|$)/i;
  const GLYPH = {
    x: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M3 3h4.3l3.5 4.9L15 3h1.9l-5.2 6 6.3 8h-4.3l-3.8-5.3L5.1 17H3.2l5.6-6.4L3 3Zm2.4 1.2 8.6 11.6h1.5L6.9 4.2H5.4Z"/></svg>',
    telegram: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2.3 9.4 17 3.3c.8-.3 1.5.3 1.3 1.2l-2.5 11.8c-.2.8-1.1 1.2-1.8.7l-3.8-2.8-1.9 1.8c-.3.3-.8.1-.8-.3v-2.9l6.8-6.2c.2-.2 0-.4-.3-.3L5.6 11.6 2.4 10.6c-.8-.2-.8-1-.1-1.2Z"/></svg>',
    discord: '<svg class="dd-g" viewBox="0 0 22 18" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M4.7 2.4C6.6 1.5 8.2 1.2 8.2 1.2l.4.8a14 14 0 0 1 4.8 0l.4-.8s1.6.3 3.5 1.2c1.8 2.8 2.6 5.8 2.3 9-1.7 1.4-3.4 2.1-5 2.5l-1-1.5c.6-.2 1.2-.5 1.7-.9l-.4-.3a10.8 10.8 0 0 1-9.8 0l-.4.3c.5.4 1.1.7 1.7.9l-1 1.5c-1.6-.4-3.3-1.1-5-2.5-.3-3.2.5-6.2 2.3-9ZM8 7.7c-.8 0-1.4.7-1.4 1.6S7.2 10.9 8 10.9s1.4-.7 1.4-1.6S8.8 7.7 8 7.7Zm6 0c-.8 0-1.4.7-1.4 1.6s.6 1.6 1.4 1.6 1.4-.7 1.4-1.6-.6-1.6-1.4-1.6Z"/></svg>',
    web: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2.2 2.1 3.2 4.5 3.2 7.2s-1 5.1-3.2 7.2c-2.2-2.1-3.2-4.5-3.2-7.2s1-5.1 3.2-7.2Z"/></svg>',
    docs: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 2.8h6.5L15 6.3v10.9H5Z"/><path d="M11.3 2.8v3.7H15M7.5 10h5M7.5 13h5"/></svg>',
    github: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6-4 4 4 4M13 6l4 4-4 4"/></svg>',
    link: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1"/></svg>',
    out: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/></svg>',
    copy: '<svg class="dd-g" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 4.5V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h.5"/></svg>',
  };
  /* A 1:1 mirror of what DexScreener lists, in its order: the websites
     (each under the label the project gave it -- "Git" stays "Git"; no
     label reads "Website"), then the socials (named by their type,
     capitalised). Nothing is added, renamed, merged or sorted, and a link
     the project did not list is not shown at all. The only things dropped
     are an href that is not http(s) and a screener site (SCREENERS). The
     kind (k) only picks the glyph and the "where" line. */
  function projectLinks(pair) {
    const pi = (pair && pair.info) || {}, out = [];
    const kindOf = (t, u, l) => {
      if (t === 'twitter' || t === 'x' || /\/\/(www\.)?(x|twitter)\.com\//i.test(u)) return 'x';
      if (t === 'telegram' || /\/\/t\.me\//i.test(u)) return 'telegram';
      if (t === 'discord' || /discord\.(gg|com)\//i.test(u)) return 'discord';
      if (/\/\/(www\.)?github\.com\//i.test(u) || /^git(hub)?$/i.test(l)) return 'github';
      if (/docs?|gitbook|whitepaper/i.test(l) || /\/\/docs\./i.test(u)) return 'docs';
      return t ? 'link' : 'web';
    };
    for (const w of (Array.isArray(pi.websites) ? pi.websites : [])) {
      const u = safeUrl(w && w.url), l = String((w && w.label) || '').trim().slice(0, 40);
      if (u && !SCREENERS.test(u)) out.push({ k: kindOf('', u, l), url: u, name: l || 'Website' });
    }
    for (const so of (Array.isArray(pi.socials) ? pi.socials : [])) {
      const u = safeUrl(so && so.url), t = String((so && (so.type || so.platform)) || '').trim().slice(0, 40);
      if (u && !SCREENERS.test(u)) out.push({ k: kindOf(t.toLowerCase(), u, ''), url: u, name: t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Link' });
    }
    return out;
  }
  /* what a person recognises: @handle, t.me/name, the bare domain */
  function linkWhere(l) {
    try {
      const u = new URL(l.url), path = u.pathname.replace(/\/+$/, ''), host = u.hostname.replace(/^www\./, '');
      if (l.k === 'x') { const h = path.split('/').filter(Boolean)[0]; return h ? `@${h}` : host; }
      if (l.k === 'web') return host;
      return host + path;
    } catch (e) { return l.url; }
  }
  const LINKS = {
    open: false,
    toggle() { if (this.open) this.close(); else this.show(); },
    show() {
      if (!current) return;
      const btn = els.trail.querySelector('[data-links]');
      const ls = current.links || [];
      const logo = current.image_url && IMG_OK.test(current.image_url) ? `<img alt="" src="${esc(current.image_url)}" decoding="async" referrerpolicy="origin">` : '';
      const row = l => `<div class="dd-lrow"><span class="dd-lrow__ic">${GLYPH[l.k]}</span>`
        + `<a class="dd-lrow__t" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(l.name)}</b><span>${esc(linkWhere(l))}</span></a>`
        + `<span class="dd-lrow__act"><a class="dd-lbtn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" aria-label="open ${esc(l.name)}" title="open">${GLYPH.out}</a>`
        + `<button type="button" class="dd-lbtn" data-copy="${esc(l.url)}" aria-label="copy the ${esc(l.name)} link" title="copy link">${GLYPH.copy}</button></span></div>`;
      els.links.innerHTML = `<div class="dd-links__hd"><span class="dd-links__logo">${logo}</span><div><b>${esc(current.name || current.symbol)}</b>`
        + `<span>$${esc(current.symbol)} · ${esc(DD.chainTag(current.chain))} · ${ls.length} link${ls.length === 1 ? '' : 's'}</span></div>`
        + `<button type="button" class="dd-lbtn dd-links__x" data-close aria-label="close">✕</button></div>`
        + (ls.length ? ls.map(row).join('') : '<p class="dd-links__none">This project lists no links.</p>')
        + `<p class="dd-links__ft">the project's own links · not checked by DigitalDon</p>`;
      const img = els.links.querySelector('.dd-links__logo img');
      if (img) img.onerror = () => img.remove();
      els.links.hidden = false;
      this.open = true;
      if (btn) btn.setAttribute('aria-expanded', 'true');
      this.place();
      const first = els.links.querySelector('a, button');
      if (first) first.focus({ preventScroll: true });
    },
    place() {
      if (!this.open) return;
      const btn = els.trail.querySelector('[data-links]');
      const r = btn ? btn.getBoundingClientRect() : { left: 12, bottom: 40 };
      const w = els.links.offsetWidth || 300;
      els.links.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 20)))}px`;
      els.links.style.top = `${Math.round(r.bottom + 10)}px`;
    },
    close() {
      if (!this.open) return;
      this.open = false;
      els.links.hidden = true;
      els.links.innerHTML = '';
      const btn = els.trail.querySelector('[data-links]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    },
  };
  els.links.addEventListener('click', async ev => {
    if (ev.target.closest('[data-close]')) { LINKS.close(); return; }
    const c = ev.target.closest('[data-copy]');
    if (!c) return;
    let ok = false;
    try { await navigator.clipboard.writeText(c.dataset.copy); ok = true; } catch (e) { ok = false; }
    c.classList.toggle('is-done', ok);
    c.title = ok ? 'copied' : 'copy failed';
    setTimeout(() => { if (c.isConnected) { c.classList.remove('is-done'); c.title = 'copy link'; } }, 1400);
  });
  document.addEventListener('pointerdown', ev => {
    if (LINKS.open && !els.links.contains(ev.target) && !ev.target.closest('[data-links]')) LINKS.close();
  }, true);
  window.addEventListener('resize', () => LINKS.place());

  /* ---------- the trail (top left) ---------- */
  els.trail.addEventListener('click', async ev => {
    if (ev.target.closest('[data-links]')) { LINKS.toggle(); return; }
    const btn = ev.target.closest('[data-ca]');
    if (!btn) return;
    const ca = btn.dataset.ca;
    let ok = false;
    try { await navigator.clipboard.writeText(ca); ok = true; } catch (e) {
      // no clipboard API (http, an old browser): the textarea way
      const ta = document.createElement('textarea');
      ta.value = ca; ta.setAttribute('readonly', ''); ta.className = 'dd-offscreen';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
    }
    btn.textContent = ok ? 'copied ✓' : 'copy failed';
    btn.classList.toggle('is-done', ok);
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { if (btn.isConnected) { btn.innerHTML = GLYPH.copy; btn.classList.remove('is-done'); } }, 1600);
  });
  function renderTrail(info, res) {
    TRAIL.named();
    if (!info) { els.trail.innerHTML = ''; fitBand(); return; }   // no token: the mark and its name stand alone
    /* The token's logo leads the pill (the cluster menu's top card shows it
       too): drawn only once it loads, from the logo hosts the CSP allows. */
    const logo = info.image_url && IMG_OK.test(info.image_url) ? info.image_url : '';
    /* logo · name · $TICKER · chain · copy: the name leads; a token whose
       name is its ticker shows the ticker once. */
    const named = info.name && info.name !== info.symbol;
    const bits = [...(logo ? [`<i class="dd-trail__logo" data-logo="${esc(logo)}"></i>`] : [])];
    if (named) bits.push(`<b class="nm" title="${esc(info.name)}">${esc(info.name)}</b>`);
    bits.push(named ? `<span class="tk">$${esc(info.symbol)}</span>` : `<b>$${esc(info.symbol)}</b>`,
      `<span class="sep ch-sep">·</span>`, `<span class="ch">${esc(DD.chainTag(info.chain))}</span>`);
    /* THE $DON EXCEPTION, said out loud: every surface that applies the
       house policy shows the badge (NATIVE_TOKEN.md). */
    if (res && res.native) bits.push(`<span class="dd-native" title="${esc(dash(res.nativeBadge || 'our token — house policy applied'))}">our token</span>`);
    /* Copy the contract, to pass the token on. */
    /* The project's own links (option 1 of the links lab): one chip, one
       small window. Shown with no links too -- "no links" is worth knowing. */
    const nl = (info.links || []).length;
    const linksChip = `<button type="button" class="dd-trail__ca dd-trail__links${nl ? '' : ' is-none'}" data-links aria-haspopup="dialog" aria-expanded="false" title="${nl ? `the project's links (${nl}) · L` : 'no links listed · L'}" aria-label="${nl ? `the project's ${nl} links` : 'no links listed'}">${GLYPH.link}<span class="dd-trail__n">${nl}</span></button>`;
    if (info.address) bits.push(`<button type="button" class="dd-trail__ca" data-ca="${esc(info.address)}" title="copy the contract address" aria-label="copy the contract address ${esc(info.address)}">${GLYPH.copy}</button>`);
    bits.push(linksChip);
    els.trail.innerHTML = bits.join('');
    const mark = els.trail.querySelector('[data-logo]');
    if (mark) {
      const img = new Image();
      img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin';
      img.onload = () => { if (img.naturalWidth && mark.isConnected) { mark.appendChild(img); mark.classList.add('is-in'); fitBand(); } };
      img.onerror = () => mark.remove();
      img.src = mark.dataset.logo;
    }
    fitBand();
  }

  /* ---------- the security strip (top centre) ----------
     From the base holder payload's `security` block (read from the token's
     verified contract on Blockscout).
     Four facts a trader wants before anything else. Missing = "no data",
     never safe: a dashed dot, never a filled one. */
  function renderSecurity(sec) {
    if (!sec) { els.sec.hidden = true; els.sec.innerHTML = ''; return; }
    const cell = (label, state, text) =>
      `<span class="is-${state}" title="${esc(label)}"><i></i>${esc(text)}</span>`;
    const tri = (v, okText, badText, label) => v === true ? cell(label, 'ok', okText) : v === false ? cell(label, 'bad', badText) : cell(label, 'none', `${label} ?`);
    const items = [];
    items.push(sec.honeypot === 'yes' ? cell('honeypot', 'bad', 'honeypot')
      : sec.honeypot === 'no' ? cell('honeypot', 'ok', 'sells ok') : cell('honeypot', 'none', 'honeypot ?'));
    items.push(tri(sec.renounced_mint, 'mint off', 'can mint', 'mint'));
    items.push(tri(sec.renounced_freeze, 'freeze off', 'can freeze', 'freeze'));
    if (sec.owner_renounced !== null && sec.owner_renounced !== undefined) items.push(tri(sec.owner_renounced, 'renounced', 'owned', 'owner'));
    const tax = [sec.buy_tax, sec.sell_tax].map(t => (t == null || t === '') ? null : +t);
    if (tax[0] != null || tax[1] != null) {
      const hi = Math.max(tax[0] || 0, tax[1] || 0) * (Math.max(tax[0] || 0, tax[1] || 0) <= 1 ? 100 : 1);
      items.push(cell('tax', hi >= 10 ? 'bad' : 'ok', `tax ${hi.toFixed(hi % 1 ? 1 : 0)}%`));
    }
    els.sec.innerHTML = items.join('');
    els.sec.hidden = false;
    fitBand();
  }

  /* ---------- the field: the holder map ----------
     Two calls to the server, exactly as the analyzer makes them: stage=base
     (distribution, security) then stage=full (clusters, launch signals).
     The shell opens straight away under the block's own loader; the map
     joins it and is driven to the viewport. */
  async function runHolders(info, pair) {
    const key = `${info.chain}:${info.address}`;
    if (holdersRun && holdersRun.key === key && holdersRun.status !== 'error') return;
    const me = { key, status: 'base', base: null, full: null };
    holdersRun = me;
    mapState(me, null);
    if (!CONFIG.holder_intel) {
      me.status = 'none';
      els.stage.innerHTML = ''; delete els.stage.dataset.map;
      return fieldNote(HOLDER_ERRORS.feature_disabled, true);
    }
    if (!SUPPORTED.has((info.chain || '').toLowerCase())) {
      me.status = 'none';
      els.stage.innerHTML = ''; delete els.stage.dataset.map;
      return fieldNote(HOLDER_ERRORS.unsupported_chain, true);
    }
    els.empty.hidden = true;
    els.stage.innerHTML = holderSectionShellHtml(true);
    placeRailControls();
    const loader = holderLoader(els.stage.querySelector('#holderLoader'));
    loader.phase('base');
    COIN.dock(els.stage.querySelector('#holderLoader'));

    /* The chain travels with the token: the server reads Blockscout per chain
       and never resolves a pair on its own. */
    const qs = new URLSearchParams({ token: info.address, chain: info.chain });
    if (info.pair_address) qs.set('pair', info.pair_address);
    const base = `${CONFIG.api}/api/holder-intel?${qs}`;

    let baseJson;
    try {
      baseJson = await fetchJsonTimeout(`${base}&stage=base`, HOLDER_BASE_TIMEOUT_MS);
    } catch (e) {
      console.error('[dido] holder intel request failed:', e);
      loader.stop();
      return holdersFail(me, 'could not reach the holder intelligence service. check your connection and try again in a minute.');
    }
    if (holdersRun !== me) return;
    if (!baseJson || baseJson.ok !== true || !baseJson.data) {
      const code = baseJson && baseJson.error;
      loader.stop();
      return holdersFail(me, HOLDER_ERRORS[code] || 'holder data not available right now. try again in a minute.');
    }
    me.base = baseJson.data;
    me.status = 'full';
    renderSecurity(me.base.security || null);

    /* Progressive: the holders now, their clusters when they land. The base
       stage (seconds) already carries the top holders and the pool, so the
       field shows them at once as a pending map -- it says it is mapping and
       claims nothing about groups or risk -- and the cluster answer is merged
       into it later from where every bubble already sits (the shared map's
       snapshot/seed hooks). No request is added: these are the two calls the
       terminal always made. */
    const owners = (me.base.top_owners || []).length;
    me.t0 = Date.now();
    if (owners) {
      loader.finish(() => {
        if (holdersRun !== me) return;
        if (me.full) mountField(info, me.full, me);
        else mountField(info, Object.assign({}, me.base, { pending: true, clusters: [], links: [] }), me);
      });
      mapState(me, 'mapping');
    } else {
      loader.phase('cluster');
    }

    /* stale=1: a cluster answer up to an hour old comes back at once, marked
       with its age, while the server refreshes it behind. The
       terminal shows it labelled and asks again, without stale=1, to join the
       refresh. A cluster scan can outlast one wait on a fresh token; the
       server keeps it running and a second ask joins it, so ask once more
       before calling it a timeout. */
    const fetchFull = async stale => {
      const url = `${base}&stage=full${stale ? '&stale=1' : ''}`;
      try {
        try { return await fetchJsonTimeout(url, HOLDER_FULL_TIMEOUT_MS); }
        catch (e) {
          if (holdersRun !== me) return null;
          return await fetchJsonTimeout(url, HOLDER_FULL_TIMEOUT_MS);
        }
      } catch (e) {
        return null;
      }
    };
    const okFull = j => !!(j && j.ok === true && j.data);

    let fullJson = await fetchFull(true);
    if (holdersRun !== me) return;
    if (okFull(fullJson) && fullJson.data.stale) {
      presentFull(info, me, fullJson.data, loader);
      mapState(me, 'stale', fullJson.data.age_s);
      fullJson = await fetchFull(false);
      if (holdersRun !== me) return;
    }
    if (!okFull(fullJson)) {
      const why = !fullJson ? 'cluster mapping timed out'
        : (HOLDER_ERRORS[fullJson.error] || 'cluster mapping failed');
      /* The holders are already on the field (or an older map is): keep
         them, and say plainly what is missing. Only an empty field falls
         back to the full-field note. */
      if (owners || me.full) { me.status = 'done'; mapState(me, 'failed', why); return; }
      loader.stop();
      return holdersFail(me, `${why}. the chart is still live.`);
    }
    presentFull(info, me, fullJson.data, loader);
    mapState(me, null);
  }
  /* The cluster answer onto the field: merged into the map already on
     screen (every bubble starts where it is), or mounted when the loader
     lifts if nothing is on screen yet. */
  function presentFull(info, me, full, loader) {
    me.full = full;
    me.status = 'done';
    if (me.mounted) mountField(info, full, me, holderMapApi && holderMapApi.snapshot ? holderMapApi.snapshot() : null);
    else loader.finish(() => { if (holdersRun === me) mountField(info, me.full, me); });
    chart.setArrivals(full);
  }

  /* ---------- the ground: frosted water in the token's colours ----------
     The website's pool shader (website/index.html, "the water on the GPU"),
     tuned down for a working screen: drawn at 40% resolution under one CSS
     blur (the frost), moving at 0.15x the website's pace. It is drawn on an
     even beat of 30 frames a second, every second display frame at 60 Hz
     (every fourth at 120 Hz), with time-based motion, so the flow is smooth;
     a slower beat (6/s, 0.8.0) read as stutter. The pointer stirs it like on
     the website, far more gently (a third of the push, quieter and rarer
     rings), and only while it does is it drawn on every frame. Light and dark take the website's own plain light; a token whose
     logo has a clear colour lends it to the light and to the two blooms
     beneath (server /api/token-tint: one image read per logo, then memory).
     The colour is only ever the analysed token's own: a newer token cancels
     an older answer, and the ground falls back to plain light while a new
     logo is read, so it never wears another token's colours. No WebGL: the
     blooms alone. */
  const ground = (() => {
    const cv = $('water');
    const host = $('tint');
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const RES = 0.4, BEAT_MS = 1000 / 30, PACE = 0.15;
    let gl = null;
    try { gl = cv && cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' }); } catch (e) { gl = null; }
    const fs = 'precision mediump float;uniform vec2 R;uniform float t;uniform vec3 C1;uniform vec3 C2;uniform float G;uniform vec4 P;uniform float E;uniform vec4 K;uniform vec4 RP[3];'
      + 'float light(vec2 q,float ph){float a=sin(q.x*1.3+t)+sin(q.y*1.7-t*.8)+sin((q.x+q.y)*.9+t*.6)+sin(length(q-vec2(4.5,3.))*1.6-t)+ph;return pow(max(0.,1.-abs(a)*.55),6.);}'
      + 'void main(){vec2 uv=gl_FragCoord.xy/R;uv.y=1.-uv.y;float ar=R.x/R.y;'
      + 'vec2 a=vec2((uv.x-.28+sin(t*.3)*.08)/.36,(uv.y-.22)/.34);vec2 b=vec2((uv.x-.82)/.3,(uv.y-.86+cos(t*.25)*.06)/.3);float ma=exp(-dot(a,a));float mb=.8*exp(-dot(b,b));'
      + 'vec2 p=vec2((uv.x-P.x)*ar,uv.y-P.y);float d2=dot(p,p);float f=E*exp(-d2/.012);'
      + 'vec2 disp=vec2(p.x/ar,p.y)*f*K.x+P.zw*f*K.y;float glow=E*exp(-d2/.03)*K.z;float ph=0.;'
      + 'for(int i=0;i<3;i++){vec2 r=vec2((uv.x-RP[i].x)*ar,uv.y-RP[i].y);float w=length(r)-RP[i].z;float g=exp(-w*w/.0018)*RP[i].w;ph+=g*sin(w*70.);glow+=g*.35*K.z;}'
      + 'float m=ma+mb;vec3 col=(C1*ma+C2*mb)/max(m,.001);'
      + 'float al=light((uv-disp)*vec2(9.,6.),ph)*G*min(1.,m+glow)/255.;gl_FragColor=vec4(col/255.*al,al);}';
    const U = {};
    if (gl) {
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; };
      const v = sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'), f = sh(gl.FRAGMENT_SHADER, fs);
      const pr = v && f ? gl.createProgram() : null;
      if (pr) { gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr); }
      if (!pr || !gl.getProgramParameter(pr, gl.LINK_STATUS)) gl = null;
      else {
        gl.useProgram(pr);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        ['R', 't', 'C1', 'C2', 'G', 'P', 'E', 'K', 'RP'].forEach(n => { U[n] = gl.getUniformLocation(pr, n); });
        cv.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; cv.classList.remove('is-on'); });
      }
    }

    /* the light's colours: the theme's plain light, or the token's */
    let tint = null, c1 = [0, 0, 0], c2 = [0, 0, 0], gain = 0;
    const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
    const mix = (a, b, k) => a.map((x, n) => x + (b[n] - x) * k);
    function colour() {
      const cs = getComputedStyle(document.documentElement), dark = isDark();
      const plain = cs.getPropertyValue('--water-rgb').split(',').map(Number);
      if (!tint) { c1 = c2 = plain.length === 3 ? plain : [40, 44, 58]; gain = parseFloat(cs.getPropertyValue('--water-gain')) || 84; }
      else {
        // dark: the hue lifted toward light; light: pulled a little deeper so a pastel still reads on paper
        const lift = c => (dark ? mix(rgb(c), [255, 255, 255], 0.3) : mix(rgb(c), [0, 0, 0], 0.22));
        c1 = lift(tint[0]); c2 = lift(tint[1] || tint[0]); gain = dark ? 170 : 120;
      }
      gain *= 1.1;
      wake();
    }

    /* the pointer: the website's damped spring and rings, a third as strong */
    const T = { x: 0.5, y: 0.5, vx: 0, vy: 0, e: 0, rips: [], push: 0.2, drag: 0.02, lamp: 0.25, on: false };
    let tx = 0.5, ty = 0.5, has = false, lastX = 0.5, lastY = 0.5, lastT = 0, box = null;
    const at = e => { box = box || host.getBoundingClientRect(); tx = (e.clientX - box.left) / box.width; ty = (e.clientY - box.top) / box.height; };
    const ring = (x, y, a) => { if (T.rips.length >= 3) T.rips.shift(); T.rips.push({ x, y, a, age: 0, rad: 0, amp: 0 }); };
    function step(dt, now) {
      if (has) {
        const k = 70, c = 2 * Math.sqrt(k);
        T.vx += (k * (tx - T.x) - c * T.vx) * dt; T.vy += (k * (ty - T.y) - c * T.vy) * dt;
        T.x += T.vx * dt; T.y += T.vy * dt;
      } else { T.vx *= 0.9; T.vy *= 0.9; }
      const sp = Math.hypot(T.vx, T.vy);
      T.e = Math.min(0.6, T.e * Math.pow(0.18, dt) + (has ? sp * 0.9 * dt * 8 : 0));
      if (!has) T.e *= Math.pow(0.25, dt);
      if (has && sp > 0.5 && now - lastT > 320 && Math.hypot(T.x - lastX, T.y - lastY) > 0.1) { ring(T.x, T.y, Math.min(0.35, sp * 0.15)); lastX = T.x; lastY = T.y; lastT = now; }
      for (let n = T.rips.length - 1; n >= 0; n--) { const r = T.rips[n]; r.age += dt; r.rad = 0.03 + r.age * 0.3; r.amp = r.a * Math.exp(-r.age * 1.8); if (r.age > 2.2) T.rips.splice(n, 1); }
      T.on = T.e > 0.004 || T.rips.length > 0;
    }
    if (gl && !reduced) {
      addEventListener('pointermove', e => {
        at(e);
        if (!has) { T.x = tx; T.y = ty; has = true; }
        if (!T.on) { T.on = true; wake(); }
      }, { passive: true });
      addEventListener('pointerdown', e => { at(e); ring(tx, ty, 0.4); T.on = true; wake(); }, { passive: true });
      document.addEventListener('pointerleave', () => { has = false; });
    }

    /* the loop: a timer at rest (no 60/s wake-ups for six frames), frames
       only while the pointer stirs it; nothing while the tab is hidden */
    const rp = new Float32Array(12);
    let t = Math.random() * 10, prev = 0, last = 0, raf = 0;
    function size() {
      if (!gl) return;
      box = null;
      const w = cv.clientWidth || innerWidth, h = cv.clientHeight || innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const k = Math.min(dpr, 2200 / Math.max(w, h)) * RES;
      cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
      gl.viewport(0, 0, cv.width, cv.height);
      wake();
    }
    function draw(now) {
      raf = 0;
      if (!gl || document.hidden) return;
      raf = requestAnimationFrame(draw);
      // an even beat: draw when a 30/s slot has passed (4 ms of slack so a
      // 60 Hz display draws exactly every second frame), every frame while stirred
      if (!T.on && last && now - last < BEAT_MS - 4) return;
      last = now;
      const dt = Math.min(0.1, (now - (prev || now)) / 1000) || BEAT_MS / 1000; prev = now;
      t += (reduced ? 0.0025 : 0.010 * PACE) * dt / 0.033;
      step(dt, now);
      for (let n = 0; n < 3; n++) { const r = T.rips[n]; rp[n * 4] = r ? r.x : 0; rp[n * 4 + 1] = r ? r.y : 0; rp[n * 4 + 2] = r ? r.rad : -9; rp[n * 4 + 3] = r ? r.amp : 0; }
      gl.uniform2f(U.R, cv.width, cv.height); gl.uniform1f(U.t, t);
      gl.uniform3f(U.C1, c1[0], c1[1], c1[2]); gl.uniform3f(U.C2, c2[0], c2[1], c2[2]); gl.uniform1f(U.G, gain);
      gl.uniform4f(U.P, T.x, T.y, T.vx, T.vy); gl.uniform1f(U.E, T.e); gl.uniform4f(U.K, T.push, T.drag, T.lamp, 0); gl.uniform4fv(U.RP, rp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!cv.classList.contains('is-on')) cv.classList.add('is-on');
    }
    /* one rAF loop while the tab is visible; a hidden tab gets no frames */
    function wake() {
      if (!gl || raf || document.hidden) return;
      last = 0;
      raf = requestAnimationFrame(draw);
    }
    if (gl) {
      size();
      addEventListener('resize', size);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { prev = 0; wake(); } });
      new MutationObserver(colour).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    colour();
    return {
      /* the token's colours, or null for the plain light */
      set(cols) {
        tint = cols && cols.length ? cols : null;
        if (tint) {
          document.documentElement.style.setProperty('--tint-a', tint[0]);
          document.documentElement.style.setProperty('--tint-b', tint[1] || tint[0]);
        }
        els.app.classList.toggle('has-tint', !!tint);
        colour();
      },
    };
  })();
  const tintCache = new Map();
  async function applyTint(url) {
    const me = runToken;
    if (!url) { ground.set(null); return; }
    await configReady;
    let cols = tintCache.get(url);
    if (!cols) {
      // never show the previous token's colours while this one's are read
      if (me === runToken) ground.set(null);
      try {
        const j = await fetchJsonTimeout(`${CONFIG.api}/api/token-tint?u=${encodeURIComponent(url)}`, 8000);
        cols = j && j.ok && j.data && Array.isArray(j.data.colors) ? j.data.colors.filter(c => /^#[0-9a-f]{6}$/i.test(c)) : [];
      } catch (e) {
        cols = [];
      }
      tintCache.set(url, cols);
    }
    if (me !== runToken) return;
    ground.set(cols);
  }

  /* ---------- the map's state chip ----------
     One line under the map's summary while the field is not the final
     answer: mapping (with the seconds it has taken, so a long scan reads as
     work, not a hang), an older map being refreshed (with its age), or a
     cluster stage that failed while the holders stay on screen. */
  let mapStateTimer = 0, mapPollTimer = 0;
  /* While the server maps clusters it reports how far it has got
     (/api/holder-progress, read from its memory: no upstream request, no
     credits). Polled every 1.5 s while the chip says "mapping". */
  const PHASE_WORDS = {
    graph: 'reading token transfers',
    funders: 'tracing who funded each wallet',
    proxies: 'following pass-through wallets',
    linking: 'linking the clusters',
  };
  function mapState(me, state, extra) {
    clearInterval(mapStateTimer);
    clearInterval(mapPollTimer);
    const chip = els.mapState;
    if (!state || !me || holdersRun !== me) { chip.hidden = true; syncKeepOut(); return; }
    const paint = () => {
      if (holdersRun !== me) { clearInterval(mapStateTimer); clearInterval(mapPollTimer); chip.hidden = true; return; }
      let text, pct = null;
      if (state === 'mapping') {
        const sec = Math.round((Date.now() - me.t0) / 1000);
        const p = me.progress;
        if (p && p.running) {
          const f = p.funders || {};
          const count = p.phase === 'funders' && f.total ? ` ${f.done}/${f.total}` : '';
          text = `${PHASE_WORDS[p.phase] || 'mapping clusters'}${count} · ${sec}s`;
          pct = Math.max(2, Math.min(99, Number(p.pct) || 0));
        } else {
          text = `mapping clusters · ${sec}s`;
        }
      } else if (state === 'stale') {
        const min = Math.max(1, Math.round((Number(extra) || 0) / 60));
        text = `clusters as of ${min} min ago · refreshing`;
      } else {
        text = `${extra || 'cluster mapping failed'} · holders shown`;
      }
      els.mapStateText.textContent = text;
      els.mapStateBar.hidden = pct == null;
      if (pct != null) els.mapStateFill.style.width = `${pct}%`;
    };
    chip.dataset.state = state;
    chip.hidden = false;
    paint();
    if (state === 'mapping') {
      mapStateTimer = setInterval(paint, 1000);
      const [chain, address] = me.key.split(':');
      const url = `${CONFIG.api}/api/holder-progress?token=${encodeURIComponent(address)}&chain=${encodeURIComponent(chain)}`;
      const poll = async () => {
        try {
          const j = await fetchJsonTimeout(url, 4000);
          if (holdersRun === me && j && j.ok && j.data) { me.progress = j.data; paint(); }
        } catch (e) { /* a missed poll only leaves the last reading up */ }
      };
      poll();
      mapPollTimer = setInterval(() => { if (!document.hidden) poll(); }, 1500);
    }
    syncKeepOut();
  }
  /* No map for this token: the field says why. (Dropped by mistake in 0.7.0
     while its three callers stayed, so a failed holder read threw instead
     and left the loader up for good.) */
  function holdersFail(me, msg) {
    me.status = 'error';
    mapState(me, null);
    els.stage.innerHTML = '';
    placeRailControls();
    fieldNote(msg, true);
  }
  /* Mount the map. Same markup, same map, same interactions as the analyzer
     -- it is the same source. No hooks: the block's own fullscreen button is
     retired and the expanded state is driven from here, which the block
     believes from the first setFullscreen call on. */
  function mountField(info, full, me, snap) {
    const canvas = els.stage.querySelector('#holderMapCanvas');
    if (!canvas) return;
    /* A bubble's card offers "open wallet": the terminal's own wallet pane
       (the journey), for EVM wallets while wallet scans are on. */
    const hooks = {
      walletOk: addr => CONFIG.wallet_scan && WAL_ADDR_RE.test(addr || ''),
      /* The bubble lifts and travels to where the wallet will stand. */
      onWallet: addr => {
        const from = lastNode && lastNode.isConnected ? lastNode : els.stage.querySelector('.hm-ctx:not([hidden])');
        WALLET.open(addr);   // shows the pane at once; the scan follows
        COIN.lift(from, { kind: 'wallet', label: `${addr.slice(0, 6)}…${addr.slice(-4)}`, phases: WAL_PHASES, to: COIN.walletSpot });
      },
    };
    if (snap) { hooks.seed = snap.seed; hooks.view = snap.view; }
    /* A bubble menu open while the map is re-mounted (the full holder data
       arriving over the first map) stays open on the same wallet, instead
       of vanishing under the user's pointer. */
    const openItem = els.stage.querySelector('.hm-ctx:not([hidden]) [data-addr]');
    const reopen = openItem ? openItem.dataset.addr : null;
    /* ...and keyboard focus stays where it was: on the same bubble, or on
       the same item of the reopened menu. */
    const ae = document.activeElement;
    const focusHm = ae && ae.closest && ae.closest('#stage .hm-ctx') ? ae.dataset.hm : null;
    const focusNode = !focusHm && ae && ae.closest && ae.closest('#stage .holder-node') ? ae.closest('#stage .holder-node').getAttribute('aria-label') : null;
    initHolderMap(canvas, full, info, hooks);
    els.stage.dataset.mounts = String((+els.stage.dataset.mounts || 0) + 1);
    if (reopen && holderMapApi && holderMapApi.openMenu) holderMapApi.openMenu(reopen);
    if (focusHm) {
      const it = [...els.stage.querySelectorAll('.hm-ctx:not([hidden]) [data-hm]')].find(el => el.dataset.hm === focusHm);
      if (it) it.focus({ preventScroll: true });
    } else if (focusNode) {
      const n = [...els.stage.querySelectorAll('.holder-node')].find(g => g.getAttribute('aria-label') === focusNode);
      if (n) n.focus({ preventScroll: true });
    }
    if (me) me.mounted = true;
    COIN.land('token');
    /* which map is on the field: the first one (holders) or the final one
       (with the clusters); e2e waits for the final one before it clicks */
    els.stage.dataset.map = me && me.status === 'done' ? 'full' : 'first';
    const btn = els.stage.querySelector('#holderFullscreen');
    if (btn) btn.hidden = true;
    if (holderMapApi && holderMapApi.setFullscreen) holderMapApi.setFullscreen(true);
    els.empty.hidden = true;
    updateDock();
    placeRailControls();
    syncKeepOut();
    if (window.ResizeObserver) {
      const rail = railEl();
      if (rail && !railObserved.has(rail)) {
        railObserved.add(rail);
        new ResizeObserver(() => requestAnimationFrame(placeRailControls)).observe(rail);
      }
    }
  }
  const railObserved = new WeakSet();

  /* ---------- the panes are walls ----------
     The terminal's own panes float over the field: the chart (or its chip),
     the watchlist, a wallet. Their boxes go to the shared map as keep-out
     areas (holderMapApi.setKeepOut), which settles the bubbles around them
     and frames the cloud into the room that is left -- so no pane ever
     stacks over a holder. The map adds its own furniture to the list. A
     pane over the whole field (the chart at max) is not a wall: the map is
     not on screen then. One call per frame at most. */
  let keepOutRaf = 0;
  function syncKeepOut() {
    if (keepOutRaf) return;
    keepOutRaf = requestAnimationFrame(() => {
      keepOutRaf = 0;
      TRAIL.fit();   // a pane moved: the trail keeps to the free stretch
      if (!holderMapApi || !holderMapApi.setKeepOut) { WGROUND.place(); return; }
      const rects = [];
      const add = el => {
        if (!el || el.hidden) return;
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      };
      if (!chart.max) { add(els.chart); add(els.chartChip); }
      add(els.wl);
      add(els.wal);
      add(els.railChip);
      WGROUND.place();
      add(els.mapState);
      holderMapApi.setKeepOut(rects);
    });
  }
  window.addEventListener('resize', syncKeepOut);

  /* ---------- the map's cluster menu folds ----------
     The rail of group cards on the right is the shared block's; DiDo cannot
     add a button inside it (one implementation, untouched), so the fold
     button sits on the rail's top-right corner from the host's side and the
     rail is hidden with a host override when folded, like the panel parts
     DiDo already hides. Folded, a "groups · N" chip takes the corner; the
     choice is kept in this browser. A folded rail is no longer a wall, so
     the bubbles spread into the room it gave back. */
  const RAIL_KEY = 'dido-rail-folded';
  let railFolded = false;
  try { railFolded = localStorage.getItem(RAIL_KEY) === '1'; } catch (e) { /* private mode */ }
  function railEl() { return els.stage.querySelector('.holder-map-wrap.is-fullscreen .hm-rail'); }
  function placeRailControls() {
    const rail = railEl();
    const has = !!rail && !rail.classList.contains('is-gone') && rail.children.length > 0 && !!els.stage.querySelector('.hm-idx, .hm-token:not([hidden])');
    els.app.classList.toggle('rail-folded', has && railFolded);
    if (!has) { els.railFold.hidden = true; els.railChip.hidden = true; return; }
    const n = els.stage.querySelectorAll('.hm-rail .hm-idx').length;
    els.railFold.hidden = railFolded;
    els.railChip.hidden = !railFolded;
    /* Folded, the menu keeps its top: the token's nameplate, cloned from the
       rail (the block's own markup and classes, its artwork included), with
       the cluster count on its second line and a ▸ where the ▾ was. */
    if (railFolded) {
      const plate = rail.querySelector('.hm-token');
      els.railChip.textContent = '';
      /* "groups", not "clusters": the nameplate already says CLUSTER, and
         the map's own summary counts them as groups. */
      const count = `${n} ${n === 1 ? 'group' : 'groups'}`;
      if (plate && !plate.hidden) {
        const copy = plate.cloneNode(true);
        copy.removeAttribute('id');
        const sub = copy.querySelector('.hm-token__t span');
        if (sub) sub.textContent = `${sub.textContent} · ${count}`;
        els.railChip.appendChild(copy);
      } else {
        const t = document.createElement('span');
        t.className = 'mono';
        t.textContent = count;
        els.railChip.appendChild(t);
      }
      const more = document.createElement('span');
      more.className = 'dd-railcard__more';
      more.setAttribute('aria-hidden', 'true');
      more.textContent = '▸';
      els.railChip.appendChild(more);
      els.railChip.setAttribute('aria-label', `show the cluster menu, ${n} ${n === 1 ? 'group' : 'groups'}`);
    }
    /* The corner the rail occupies (measured while it shows; the folded
       chip keeps to the same corner). */
    if (!railFolded) {
      const r = rail.getBoundingClientRect();
      if (r.width > 0) {
        els.railFold.style.left = `${Math.round(r.right - 30)}px`;
        els.railFold.style.top = `${Math.round(r.top + 8)}px`;
        placeRailControls.at = { right: window.innerWidth - r.right, top: r.top, width: r.width };
      }
    }
    /* Folded from the start (a reload), the rail was never on screen to be
       measured: read its place from its own stylesheet instead. */
    if (!placeRailControls.at) {
      const cs = getComputedStyle(rail), box = rail.offsetParent || rail.parentElement;
      const b = box.getBoundingClientRect();
      placeRailControls.at = { right: window.innerWidth - b.right + (parseFloat(cs.right) || 12), top: b.top + (parseFloat(cs.top) || 60), width: parseFloat(cs.width) || 196 };
    }
    const at = placeRailControls.at;
    els.railChip.style.right = `${Math.round(at.right)}px`;
    els.railChip.style.top = `${Math.round(at.top)}px`;
    if (at.width) els.railChip.style.width = `${Math.round(at.width)}px`;
  }
  function setRailFolded(on) {
    railFolded = !!on;
    try { localStorage.setItem(RAIL_KEY, railFolded ? '1' : '0'); } catch (e) { /* fine */ }
    placeRailControls();
    syncKeepOut();
  }
  els.railFold.addEventListener('click', () => setRailFolded(true));
  els.railChip.addEventListener('click', () => setRailFolded(false));
  window.addEventListener('resize', () => requestAnimationFrame(placeRailControls));

  /* ---------- the dock ----------
     The chart pane's real box, mirrored into two custom properties the
     stylesheet reads so the map's rail and drawer keep clear
     of it. Zero when the chart is folded, absent or the whole field. */
  function updateDock() {
    const rootStyle = document.documentElement.style;
    /* A chart the viewer has moved is not in the dock: the map's furniture
       stays home and the walls (syncKeepOut) do the making room. */
    const docked = !els.chart.hidden && !chart.max && window.innerWidth > 640 && !LAYOUT.placed('chart');
    if (!docked) { rootStyle.setProperty('--dd-dock', '0px'); rootStyle.setProperty('--dd-dock-w', '0px'); syncKeepOut(); return; }
    const r = els.chart.getBoundingClientRect();
    rootStyle.setProperty('--dd-dock', `${Math.round(r.height + 12)}px`);
    rootStyle.setProperty('--dd-dock-w', `${Math.round(r.width + 12)}px`);
    syncKeepOut();
  }

  /* ---------- the chart ----------
     One SVG, redrawn from data on every change. The vocabulary is the
     analyzer's (webapp/index.html, the chart section) so a level read here
     and checked there is the same picture: all four of the plan's bands on
     price at once, each one switchable from the legend, a band too far
     outside the view parked on the price rail with an arrow rather than
     allowed to flatten the candles. What is DiDo's own is the volume strip,
     the arrivals rug, the EMAs and the lower timeframes.

     Display only. Every number drawn here was computed by the engine or
     fetched by the run; nothing re-enters DD.analyze(). Keep it that way --
     a chart that computes a level is a third engine. */
  const chart = {
    /* One drawing per frame. Pointer and wheel events arrive faster than the
       screen refreshes (120 Hz and up on a modern mouse), and every drawing
       rebuilds the SVG; the state they change is applied at once, the
       drawing waits for the next frame and happens once. */
    raf: 0,
    requestRender() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    },
    tf: DEFAULT_TF, ema: false, zones: true, size: 'md', folded: false, max: false,
    /* What the y axis reads in: the price, or the market cap (the
       screeners' "MCap" switch). Market cap is price times the supply the
       token's own read implies (market cap, else FDV, over its price), so the
       candles, the zones and every gesture stay in price space and only the
       numbers printed on the chart change. Nothing here re-enters the engine. */
    unit: 'price',
    base: null,          // { df1, df4, df1m, res, note } from the run
    series: new Map(),   // tf -> { df, at }
    /* The visible window in bar-index space, fractional on purpose so that
       zooming keeps the bar under the cursor under the cursor. */
    a: 0, b: 0,
    hover: null,         // { i, p } under the pointer, or null
    drag: null,          // { kind: 'pan' | 'measure', ... } while a gesture runs
    meas: null,          // the measurement box, when one has been drawn
    measure: false,      // the measure tool is armed
    levels: [],          // chartLevelSpecs(res) for the token on screen
    hidden: {},          // level keys the viewer switched off in the legend
    G: null, sc: null,   // geometry and price scale of the last paint
    arrivals: null,      // { times: number[] (ms), roles: Set<number> } from the holder payload
    poll: null, pollState: 'off', lastPrice: null, lastAt: 0,
    zonesAt: 0,
    loading: false,

    reset() {
      this.base = null; this.series.clear(); this.arrivals = null;
      this.a = this.b = 0; this.hover = null; this.drag = null; this.meas = null;
      this.levels = []; this.hidden = {}; this.G = this.sc = null;
      this.lastPrice = null; this.lastAt = 0; this.zonesAt = 0;
      this.stopPoll();
      els.plot.innerHTML = '';
      els.plot.classList.remove('is-empty');
      els.tape.textContent = '';
      els.legend.hidden = true;
      els.legend.innerHTML = '';
      els.chartNote.hidden = true;
    },
    setBase(b) {
      this.base = b;
      this.zonesAt = b.res ? Date.now() : 0;
      this.levels = b.res ? chartLevelSpecs(b.res) : [];
      this.hidden = {};
      this.meas = null;
      /* The engine's own series are the 1h and 4h charts; a fresh launch
         charts its minute candles instead. */
      if (b.df1) this.series.set('1h', { df: b.df1, at: Date.now() });
      if (b.df4) this.series.set('4h', { df: b.df4, at: Date.now() });
      if (b.df1m) this.series.set('1m', { df: b.df1m, at: Date.now() });
      if (!b.df1 && b.df1m) this.tf = '1m';
      else if (this.tf === '1m') this.tf = DEFAULT_TF;
      this.resetView();
      this.syncVisible();
      this.syncChips();
      this.ensureSeries();
      this.startPoll();
      this.renderTape();
    },
    setArrivals(full) {
      const owners = (full && full.top_owners) || [];
      const times = [], roles = new Set();
      for (const o of owners) {
        const ts = (typeof o.fund_ts === 'number' && o.fund_ts > 0) ? o.fund_ts
          : (typeof o.first_ts === 'number' && o.first_ts > 0) ? o.first_ts : null;
        if (ts == null) continue;
        if ((o.roles || []).some(r => r === 'sniper' || r === 'bundle' || r === 'insider')) roles.add(times.length);
        times.push(ts * 1000);
      }
      this.arrivals = times.length ? { times, roles } : null;
      this.render();
    },
    syncVisible() {
      const has = !!this.base;
      els.chart.hidden = !has || this.folded;
      els.chartChip.hidden = !has || !this.folded;
      els.chart.dataset.size = this.max ? 'max' : this.size;
      LAYOUT.apply('chart');
      updateDock();
      if (has && !this.folded) this.render();
    },
    /* price -> market cap, or null when the token's read has no cap */
    capK() {
      const c = current || {}, cap = +c.market_cap || +c.fdv, p = +c.price_usd;
      return cap > 0 && p > 0 ? cap / p : null;
    },
    fmt(v) {
      const k = this.unit === 'mcap' ? this.capK() : null;
      return k ? fmtCap(v * k) : DD.fmtPrice(v);
    },
    setUnit(u) {
      this.unit = u === 'mcap' && this.capK() ? 'mcap' : 'price';
      this.syncChips();
      this.render();
      writeUrl();
    },
    syncChips() {
      els.tfs.querySelectorAll('button[data-tf]').forEach(b => b.classList.toggle('on', b.dataset.tf === this.tf));
      const canCap = !!this.capK(), unit = canCap ? this.unit : 'price';
      els.units.querySelectorAll('button[data-unit]').forEach(b => {
        b.classList.toggle('on', b.dataset.unit === unit);
        b.setAttribute('aria-pressed', String(b.dataset.unit === unit));
        if (b.dataset.unit === 'mcap') { b.disabled = !canCap; b.title = canCap ? 'read the chart as market cap' : 'no market cap for this token'; }
      });
      els.emaChip.setAttribute('aria-pressed', this.ema ? 'true' : 'false');
      els.zonesChip.setAttribute('aria-pressed', this.zones ? 'true' : 'false');
      els.zonesChip.disabled = !this.levels.length;
      els.measureChip.setAttribute('aria-pressed', this.measure ? 'true' : 'false');
      els.maxChip.textContent = this.max ? '⤓' : '⤢';
    },
    /* Make sure the current timeframe has candles; fetch when it does not
       or when they are older than one bar. */
    async ensureSeries() {
      if (!this.base || !currentPair) return;
      const tf = this.tf;
      if (tf === '1m') return;
      const have = this.series.get(tf);
      const cfg = TIMEFRAMES[tf];
      if (have && Date.now() - have.at < Math.max(60000, cfg.ms)) return;
      if (this.loading === tf) return;
      this.loading = tf;
      const pair = currentPair, me = runToken;
      this.setPollState('polling');
      const df = await fetchChartOhlcv(pair, tf);
      if (me !== runToken || this.tf !== tf) { this.loading = false; return; }
      this.loading = false;
      if (df) { this.series.set(tf, { df, at: Date.now() }); this.resetView(); }
      this.setPollState(df ? 'fresh' : 'stale');
      this.render();
    },
    current() {
      const s = this.series.get(this.tf);
      return s ? s.df : null;
    },
    setTf(tf) {
      if (!TIMEFRAMES[tf] || this.tf === tf) return;
      this.tf = tf; this.hover = null; this.meas = null;
      this.resetView();
      this.syncChips();
      writeUrl();
      this.render();
      this.ensureSeries();
    },
    setSize(size) {
      this.size = size; this.folded = false; this.max = false;
      this.syncVisible(); this.syncChips(); writeUrl();
    },
    cycleSize(dir) {
      const i = CHART_SIZES.indexOf(this.size);
      this.setSize(CHART_SIZES[(i + dir + CHART_SIZES.length) % CHART_SIZES.length]);
    },
    toggleMax() {
      this.max = !this.max; this.folded = false;
      this.syncVisible(); this.syncChips();
    },
    toggleFold() {
      this.folded = !this.folded; this.max = false;
      this.syncVisible(); writeUrl();
    },
    setMeasure(on) {
      this.measure = !!on;
      if (!this.measure) this.meas = null;
      els.chart.classList.toggle('is-measure', this.measure);
      this.syncChips();
      this.render();
    },

    /* ---- live price ----
       DexScreener's pair endpoint every 30 s while the tab is visible: the
       tape, and the last candle's close, high and low. */
    startPoll() {
      this.stopPoll();
      if (!currentPair) return;
      const tick = async () => {
        if (document.hidden || !currentPair) return;
        const me = runToken, pair = currentPair;
        this.setPollState('polling');
        try {
          const data = await getJsonOnce(`${DEXSCREENER}/pairs/${encodeURIComponent(pair.chainId)}/${encodeURIComponent(pair.pairAddress)}`, SEARCH_TIMEOUT_MS);
          if (me !== runToken) return;
          const p = (data && (data.pair || (data.pairs || [])[0])) || null;
          if (!p) throw new Error('no pair');
          /* A poll answers for one pool. One that names another token is not
             a price for this one, and must never rewrite the token on screen. */
          if (String((p.baseToken || {}).address || '').toLowerCase() !== String((pair.baseToken || {}).address || '').toLowerCase()) throw new Error('another pair');
          currentPair = Object.assign({}, pair, p);
          const info = DD.tokenInfo(currentPair);
          info.image_url = current.image_url;
          current = Object.assign(current, info);
          this.lastPrice = +p.priceUsd || null;
          this.lastAt = Date.now();
          this.absorbPrice();
          this.setPollState('fresh');
        } catch (e) {
          if (me !== runToken) return;
          this.setPollState('stale');
        }
        this.renderTape();
        this.render();
      };
      this.poll = setInterval(tick, PRICE_POLL_MS);
      tick();
    },
    stopPoll() {
      if (this.poll) clearInterval(this.poll);
      this.poll = null;
      this.setPollState('off');
    },
    setPollState(s) {
      this.pollState = s;
      const dot = els.tape.querySelector('.dd-dot');
      if (dot) dot.dataset.state = s;
    },
    /* Fold the live price into the last bar of every series on screen, or
       open a new bar when the last one's period has ended. The engine's
       inputs are untouched: it read its candles once, at the run. */
    absorbPrice() {
      const p = this.lastPrice;
      if (!(p > 0)) return;
      for (const [tf, s] of this.series) {
        const df = s.df, n = df.t.length;
        if (!n) continue;
        const ms = tf === '1m' ? 60000 : TIMEFRAMES[tf].ms;
        const last = df.t[n - 1];
        if (Date.now() - last < ms) {
          df.c[n - 1] = p;
          if (p > df.h[n - 1]) df.h[n - 1] = p;
          if (p < df.l[n - 1]) df.l[n - 1] = p;
        } else if (Date.now() - last < ms * 2) {
          /* A bar rolled. Keep a view that was following the right edge
             following it; a view the viewer panned away stays where it is. */
          const following = tf === this.tf && this.atRightEdge(n);
          const t0 = last + ms;
          df.t.push(t0); df.o.push(df.c[n - 1]); df.h.push(Math.max(p, df.c[n - 1])); df.l.push(Math.min(p, df.c[n - 1])); df.c.push(p); df.v.push(0);
          if (following) { this.a += 1; this.b += 1; this.clampView(); }
          s.at = 0; // a period rolled: refetch on the next ensureSeries
        }
      }
      this.ensureSeries();
    },

    /* The token's numbers live in the band, beside its name (the ticker):
       price, 24h, market cap, liquidity, volume -- the first things a trader
       checks, visible whether the chart is open, folded or moved. The chart's
       own tape keeps what belongs to the chart: the live dot and the short
       moves (5m, 1h). */
    renderTape() {
      if (!current) { els.tape.innerHTML = ''; renderTicker(); return; }
      const chg = (currentPair && currentPair.priceChange) || {};
      els.tape.innerHTML = [
        `<span class="dd-dot" data-state="${esc(this.pollState)}" title="live price"></span>`,
        `<b>live</b>`,
        `<span class="num">5m ${esc(fmtPct(chg.m5))}</span>`,
        `<span class="num">1h ${esc(fmtPct(chg.h1))}</span>`,
      ].join('');
      renderTicker();
      this.renderNote();
    },

    /* The note line under the pane. Left: what is on screen and when the
       zones were read. Right: the hovered bar's OHLC -- in the caption
       rather than a floating tooltip, because a box that follows the cursor
       covers the candles it is describing. Mirror of the analyzer's
       writeCaption(). */
    renderNote() {
      const df = this.current();
      const left = [];
      if (df && df.t.length) {
        const n = df.c.length;
        const bars = Math.max(0, Math.round(Math.min(n, this.b) - Math.max(0, this.a)));
        left.push(`${this.tf} · ${bars} of ${n} bars`);
      }
      if (this.base && this.base.note) left.push(this.base.note);
      else if (this.base && this.base.res) left.push(`zones as of ${fmtClock(this.zonesAt)} · engine v${ENGINE_VERSION}`);
      if (this.base && this.base.res && this.base.res.stNoSetup) left.push('no short-term setup');
      left.push('not financial advice');
      let right = '';
      const i = (df && this.hover && !this.drag) ? Math.round(this.hover.i) : -1;
      if (df && i >= 0 && i < df.c.length) {
        const n = df.c.length, lastC = df.c[n - 1];
        const chg = lastC > 0 ? (df.c[i] - lastC) / lastC * 100 : 0;
        right = `o ${this.fmt(df.o[i])} h ${this.fmt(df.h[i])} l ${this.fmt(df.l[i])} c ${this.fmt(df.c[i])}`
          + (i === n - 1 ? '' : ` · ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% vs last`);
      }
      els.chartNote.innerHTML = `<span class="dd-note__l">${esc(left.join(' · '))}</span>`
        + `<span class="dd-note__r num">${esc(right)}</span>`;
      els.chartNote.hidden = false;
    },

    /* ---- drawing ----
       Mirrors the analyzer's interactive chart (webapp/index.html, the
       `initCandleChart` section): same level model, same fit guard, same
       rail pills, same clock-boundary ticks, same hairline fallback. What is
       DiDo's own is the volume strip, the arrivals rug and the EMAs. One SVG
       redrawn from data on every change -- there is no charting library,
       because the page ships under `script-src 'self'`.

       Geometry is in CSS pixels, not a fixed viewBox: a 640-unit box scaled
       into a 360px pane shrinks 9px axis text to about 5px, which is the bug
       the analyzer's own chart had until it stopped doing that. */
    geom() {
      const box = els.plot.getBoundingClientRect();
      const W = Math.max(240, Math.round(box.width) || 240);
      const H = Math.max(120, Math.round(box.height) || 120);
      const narrow = W < 460;
      /* Type at the size a trading chart is read at (11px, 10px on a narrow
         pane); the rail, the pills and the time axis are sized from it, so
         the longest price ($0.00001234) still fits its pill. */
      const font = narrow ? 10 : 11, ph = font + 6;
      const padR = narrow ? 76 : 88;
      const pad = { l: narrow ? 6 : 10, r: padR, t: 12, b: font + 12 };
      const ih = H - pad.t - pad.b;
      const volH = ih > 150 ? Math.round(ih * 0.16) : 0;   // the strip is the first thing a short pane drops
      return {
        W, H, pad, narrow, ih, volH,
        iw: W - pad.l - pad.r,
        rail: W - padR,
        font, ph, base: Math.round(font * 0.35),             // pill height; baseline offset from a line
        tags: !narrow,                                      // level name pills need a rail wide enough
        priceH: ih - (volH ? volH + 4 : 0),
      };
    },
    /* Bar length read off the timestamps rather than assumed from the
       timeframe. The frames reaching the chart have been through the engine's
       stripLaunchCandles() and can come from a sibling pool, so the only
       trustworthy statement about a frame's resolution is the one its own
       candles make. Mirror of the analyzer's chartBarMinutes(). */
    barMinutes(df) {
      const t = (df && df.t) || [];
      if (t.length < 3) return TIMEFRAMES[this.tf] ? TIMEFRAMES[this.tf].ms / 60000 : 60;
      const gaps = [];
      for (let i = 1; i < Math.min(t.length, 12); i++) gaps.push(t[i] - t[i - 1]);
      gaps.sort((a, b) => a - b);
      return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 60000));
    },
    shownLevels() {
      if (!this.zones) return [];
      return this.levels.filter(lv => !this.hidden[lv.key]);
    },
    atRightEdge(n) {
      return this.b >= (n == null ? this.barCount() : n) + CHART_RIGHT_GAP - 0.01;
    },
    barCount() {
      const df = this.current();
      return df ? df.c.length : 0;
    },
    clampView() {
      const max = this.barCount() + CHART_RIGHT_GAP;
      const span = Math.max(Math.min(CHART_MIN_BARS, max), Math.min(max, this.b - this.a));
      this.a = Math.max(0, Math.min(max - span, this.a));
      this.b = this.a + span;
    },
    /* The view a frame opens on: the last DEFAULT_BARS candles with a few
       empty bars held at the right edge, so the newest candle is never welded
       to the price rail. */
    resetView() {
      const n = this.barCount(), max = n + CHART_RIGHT_GAP;
      this.b = max;
      this.a = Math.max(0, max - Math.min(n, DEFAULT_BARS) - CHART_RIGHT_GAP);
      this.clampView();
    },
    zoomAt(factor, pivot) {
      const max = this.barCount() + CHART_RIGHT_GAP;
      const span0 = this.b - this.a;
      const span = Math.max(Math.min(CHART_MIN_BARS, max), Math.min(max, span0 * factor));
      const frac = Math.max(0, Math.min(1, (pivot + 0.5 - this.a) / span0));
      this.a = pivot + 0.5 - frac * span;
      this.b = this.a + span;
      this.clampView();
      this.requestRender();
    },
    px(i) { return this.G.pad.l + (i + 0.5 - this.a) / (this.b - this.a) * this.G.iw; },
    pxInv(x) { return (x - this.G.pad.l) / this.G.iw * (this.b - this.a) + this.a - 0.5; },

    /* Price scale: the visible candles, plus every shown level close enough to
       be worth the room (CHART_FIT_LO/HI). A level outside that comes back as
       an `edge` marker instead of flattening every candle in view into a
       hairline -- the viewer can see which way to zoom for it. */
    scale() {
      const d = this.current(), G = this.G;
      const i0 = Math.max(0, Math.floor(this.a)), i1 = Math.min(d.c.length - 1, Math.ceil(this.b));
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        if (d.l[i] < lo) lo = d.l[i];
        if (d.h[i] > hi) hi = d.h[i];
      }
      if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
      const cLo = lo, cHi = hi, edge = [];
      const inFit = v => v > cLo * CHART_FIT_LO && v < cHi * CHART_FIT_HI;
      for (const lv of this.shownLevels()) {
        if (inFit(lv.lo) || inFit(lv.hi)) {
          if (inFit(lv.lo)) lo = Math.min(lo, lv.lo);
          if (inFit(lv.hi)) hi = Math.max(hi, lv.hi);
        } else {
          edge.push({ lv, above: lv.lo >= cHi });
        }
      }
      const pad = (hi - lo) * 0.05 || (hi || 1) * 0.05;
      lo -= pad; hi += pad;
      const span = (hi - lo) || 1;
      return {
        lo, hi, edge,
        y: v => G.pad.t + (1 - (v - lo) / span) * G.priceH,
        inv: p => lo + (1 - (p - G.pad.t) / G.priceH) * span,
      };
    },
    /* Time axis. Ticks land on real clock boundaries rather than every nth
       bar, so labels stay on the hour or the day however far the view is
       panned. Mirror of the analyzer's ticks(). */
    ticks(minutes) {
      const d = this.current(), G = this.G;
      const visible = (this.b - this.a) * minutes;
      const want = Math.max(2, Math.round(G.iw / (G.narrow ? 70 : 96)));
      let stepMin = CHART_TICK_MINUTES[CHART_TICK_MINUTES.length - 1];
      for (const m of CHART_TICK_MINUTES) {
        if (m >= minutes && m >= visible / want) { stepMin = m; break; }
      }
      const stepMs = stepMin * 60000;
      const out = [];
      const i0 = Math.max(0, Math.floor(this.a)), i1 = Math.min(d.c.length - 1, Math.ceil(this.b));
      let prevBucket = null, prevDay = null;
      for (let i = i0; i <= i1; i++) {
        const bucket = Math.floor(d.t[i] / stepMs);
        if (prevBucket === null) { prevBucket = bucket; prevDay = new Date(d.t[i]).getDate(); continue; }
        if (bucket === prevBucket) continue;
        prevBucket = bucket;
        const day = new Date(d.t[i]).getDate();
        const newDay = day !== prevDay;
        prevDay = day;
        out.push({ i, text: (stepMin >= 1440 || newDay) ? fmtDay(d.t[i]) : fmtClock(d.t[i]) });
      }
      return out;
    },

    render() {
      if (els.chart.hidden) return;
      const df = this.current();
      const plot = els.plot;
      if (!df || !df.t.length) {
        plot.innerHTML = '';
        plot.classList.add('is-empty');
        plot.dataset.note = this.loading ? 'loading candles…' : (this.base && this.base.note) || 'no candles for this timeframe';
        this.renderLegend();
        return;
      }
      plot.classList.remove('is-empty');
      const G = this.G = this.geom();
      const n = df.c.length;
      if (!(this.b > this.a)) this.resetView();
      this.clampView();
      const sc = this.sc = this.scale();
      const y = sc.y;
      const top = G.pad.t, bot = G.pad.t + G.priceH, gridR = G.rail + 6;
      const vTop = bot + 4;
      const minutes = this.barMinutes(df);
      const cw = Math.max(1, G.iw / (this.b - this.a) * 0.6);
      const hairline = cw < 2.2;                 // below this a body is thinner than its own outline
      const f1 = v => (+v).toFixed(1);

      const text = (x, ty, s, o) =>
        `<text class="${(o && o.cls) || 'c-lbl'}" x="${f1(x)}" y="${f1(ty)}" font-size="${(o && o.size) || G.font}"${o && o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${s}</text>`;
      /* A rail pill: price readouts, level names, off-screen level markers. */
      const pill = (ty, s, cls) =>
        `<rect class="c-pill${cls ? ' c-pill--' + cls : ''}" x="${f1(G.rail + 2)}" y="${f1(ty - G.ph / 2)}" width="${f1(G.pad.r - 4)}" height="${G.ph}" rx="${G.ph / 2}"/>`
        + text(G.rail + 7, ty + G.base, s, { cls: `c-pill-lbl${cls ? ' c-pill-lbl--' + cls : ''}`, size: G.font - 0.5 });

      let out = `<svg viewBox="0 0 ${G.W} ${G.H}" width="${G.W}" height="${G.H}" role="img" aria-label="${esc(this.tf)} candlestick chart">`;

      /* Level name pills are laid out before the grid so a price label hidden
         behind one is simply not drawn -- two strings in the same 14px of
         rail is the one way this chart becomes unreadable. */
      const half = G.ph / 2;
      const tags = [];
      if (G.tags) {
        for (const lv of this.shownLevels()) {
          const ty = lv.line ? y(lv[lv.line]) : (y(lv.hi) + y(lv.lo)) / 2;
          if (ty < top + half || ty > bot + half) continue;
          tags.push({ y: ty, text: esc(lv.tag) });
        }
        tags.sort((p, q) => p.y - q.y);
        let lastY = -Infinity;
        for (const t of tags) { t.y = Math.max(t.y, lastY + G.ph + 1); lastY = t.y; }
      }
      const tagged = py => tags.some(t => Math.abs(t.y - py) < half + 2);

      /* price grid */
      for (let g = 0; g <= 4; g++) {
        const gv = sc.lo + (sc.hi - sc.lo) * g / 4, gy = y(gv);
        out += `<line class="c-grid" x1="${G.pad.l}" y1="${f1(gy)}" x2="${f1(gridR)}" y2="${f1(gy)}"/>`;
        if (!tagged(gy)) out += text(G.rail + 7, gy + G.base, esc(this.fmt(gv)));
      }
      /* time axis */
      for (const t of this.ticks(minutes)) {
        const tx = this.px(t.i);
        out += `<line class="c-tickmark" x1="${f1(tx)}" y1="${f1(G.pad.t + G.ih)}" x2="${f1(tx)}" y2="${f1(G.pad.t + G.ih + 4)}"/>`;
        out += text(tx, G.H - 6, esc(t.text), { anchor: 'middle' });
      }

      /* the plan's levels, under the candles. All six numbers the engine
         produced, not the three the old still frame drew. */
      for (const lv of this.shownLevels()) {
        const yT = Math.max(top, y(lv.hi)), yB = Math.min(bot, y(lv.lo));
        if (yB > top && yT < bot) {
          out += `<rect class="c-lv c-lv--${lv.key}" x="${G.pad.l}" y="${f1(yT)}" width="${f1(G.iw + 6)}" height="${f1(Math.max(2, yB - yT))}" rx="2"/>`;
        }
        if (lv.line) {
          const ly = y(lv[lv.line]);
          if (ly >= top && ly <= bot) {
            out += `<line class="c-ln c-ln--${lv.key}" x1="${G.pad.l}" y1="${f1(ly)}" x2="${f1(gridR)}" y2="${f1(ly)}"/>`;
          }
        }
      }

      /* volume strip */
      if (G.volH) {
        const i0v = Math.max(0, Math.floor(this.a)), i1v = Math.min(n - 1, Math.ceil(this.b));
        let vMax = 1e-9;
        for (let i = i0v; i <= i1v; i++) if (df.v[i] > vMax) vMax = df.v[i];
        for (let i = i0v; i <= i1v; i++) {
          const vh = Math.max(0.5, df.v[i] / vMax * G.volH);
          out += `<rect class="c-vol" x="${f1(this.px(i) - cw / 2)}" y="${f1(vTop + G.volH - vh)}" width="${f1(Math.max(0.6, cw))}" height="${f1(vh)}"/>`;
        }
      }

      /* arrivals: when the mapped wallets were funded, as a rug along the
         bottom of the price area; the ones before the window are counted. */
      if (this.arrivals) {
        const t0 = df.t[Math.max(0, Math.floor(this.a))];
        const t1 = df.t[Math.min(n - 1, Math.ceil(this.b))] + minutes * 60000;
        let older = 0;
        this.arrivals.times.forEach((t, idx) => {
          if (t < t0) { older++; return; }
          if (t > t1) return;
          const rx = G.pad.l + (t - t0) / Math.max(1, t1 - t0) * G.iw;
          const role = this.arrivals.roles.has(idx);
          out += `<line class="c-rug${role ? ' c-rug--role' : ''}" x1="${f1(rx)}" y1="${f1(bot - 1)}" x2="${f1(rx)}" y2="${f1(bot - (role ? 9 : 5))}"/>`;
        });
        if (older && G.tags) out += text(G.pad.l + 2, bot - 3, `+${older} earlier`, { cls: 'c-zl' });
      }

      /* candles */
      const i0 = Math.max(0, Math.floor(this.a)), i1 = Math.min(n - 1, Math.ceil(this.b));
      for (let i = i0; i <= i1; i++) {
        const cx = this.px(i), up = df.c[i] >= df.o[i];
        out += `<line class="c-wick" x1="${f1(cx)}" y1="${f1(y(df.h[i]))}" x2="${f1(cx)}" y2="${f1(y(df.l[i]))}"/>`;
        if (!hairline) {
          const bt = y(Math.max(df.o[i], df.c[i])), bb = y(Math.min(df.o[i], df.c[i]));
          out += `<rect class="${up ? 'c-up' : 'c-dn'}" x="${f1(cx - cw / 2)}" y="${f1(bt)}" width="${f1(cw)}" height="${f1(Math.max(1, bb - bt))}"/>`;
        }
      }

      /* EMAs, computed on the whole series so the window's left edge is
         honest rather than restarted at the first visible bar. */
      if (this.ema && DD._internals && DD._internals.emaSpan) {
        for (const [span, cls] of [[20, ''], [50, ' c-ema--slow']]) {
          const e = DD._internals.emaSpan(df.c, span);
          let path = '';
          for (let i = i0; i <= i1; i++) {
            const val = e[i];
            if (!isFinite(val)) continue;
            path += `${path ? 'L' : 'M'}${f1(this.px(i))} ${f1(y(val))}`;
          }
          if (path) out += `<path class="c-ema${cls}" d="${path}"/>`;
        }
      }

      /* level name pills, then the levels this view cannot hold */
      for (const t of tags) out += pill(t.y, t.text, 'tag');
      for (const e of sc.edge) {
        const ey = e.above ? top + half : bot - half;
        out += pill(ey, `${e.above ? '&#8593;' : '&#8595;'}${G.tags ? ' ' + esc(e.lv.tag) : ''}`, 'edge');
      }

      /* the measure box */
      if (this.meas) {
        const m = this.meas, x0 = this.px(m.i0), x1 = this.px(m.i1), y0 = y(m.p0), y1 = y(m.p1);
        out += `<rect class="c-meas" x="${f1(Math.min(x0, x1))}" y="${f1(Math.min(y0, y1))}" width="${f1(Math.abs(x1 - x0))}" height="${f1(Math.abs(y1 - y0))}"/>`;
        const pct = m.p0 > 0 ? (m.p1 - m.p0) / m.p0 * 100 : 0;
        const bars = Math.max(0, Math.round(Math.abs(m.i1 - m.i0)));
        const mins = bars * minutes;
        const span = mins >= 1440 ? `${(mins / 1440).toFixed(mins % 1440 ? 1 : 0)}d`
          : mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h` : `${mins}m`;
        const w = G.narrow ? 140 : 160;
        const lx = Math.min(G.rail - w / 2, Math.max(G.pad.l + w / 2, (x0 + x1) / 2));
        const by = Math.max(top, Math.min(y0, y1) - 4 - G.ph);
        out += `<rect class="c-box" x="${f1(lx - w / 2)}" y="${f1(by)}" width="${w}" height="${G.ph}" rx="${half}"/>`;
        out += text(lx, by + half + G.base, `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% &middot; ${bars} bars &middot; ${span}`,
          { cls: 'c-box-lbl', size: G.font - 0.5, anchor: 'middle' });
      }

      /* last price, on the rail */
      const last = df.c[n - 1];
      if (last > 0 && this.atRightEdge(n)) {
        const ly = y(last);
        if (ly >= top && ly <= bot) {
          out += `<line class="c-last" x1="${G.pad.l}" y1="${f1(ly)}" x2="${f1(gridR)}" y2="${f1(ly)}"/>`;
          out += pill(ly, esc(this.fmt(last)), 'last');
        }
      }

      /* crosshair. The readout goes in the note line under the pane, not a
         floating tooltip: a box that follows the cursor covers the candles it
         is describing. */
      if (this.hover && !this.drag) {
        const i = Math.round(this.hover.i);
        if (i >= 0 && i < n) {
          const cx = this.px(i), w = G.narrow ? 86 : 96;
          out += `<line class="c-cross" x1="${f1(cx)}" y1="${top}" x2="${f1(cx)}" y2="${f1(G.pad.t + G.ih)}"/>`;
          const lx = Math.min(G.rail - w / 2, Math.max(G.pad.l + w / 2, cx));
          out += `<rect class="c-box" x="${f1(lx - w / 2)}" y="${f1(G.pad.t + G.ih + 2)}" width="${w}" height="${G.ph}" rx="${half}"/>`;
          out += text(lx, G.pad.t + G.ih + 2 + half + G.base, esc(`${fmtDay(df.t[i])} ${fmtClock(df.t[i])}`), { cls: 'c-box-lbl', size: G.font - 0.5, anchor: 'middle' });
        }
        const hy = y(this.hover.p);
        if (hy >= top && hy <= bot) {
          out += `<line class="c-cross" x1="${G.pad.l}" y1="${f1(hy)}" x2="${f1(gridR)}" y2="${f1(hy)}"/>`;
          out += pill(hy, esc(this.fmt(this.hover.p)));
        }
      }

      out += '</svg>';
      plot.innerHTML = out;
      this.renderLegend();
      this.renderNote();
    },

    /* One button per level, the analyzer's legend in the pane's foot. The
       swatch is the same ink the level is drawn in, so the legend reads as a
       key rather than a list of names. */
    renderLegend() {
      const levels = this.zones ? this.levels : [];
      els.legend.hidden = !levels.length;
      if (!levels.length) { els.legend.innerHTML = ''; return; }
      els.legend.innerHTML = levels.map(lv => {
        const off = !!this.hidden[lv.key];
        return `<button type="button" data-lv="${esc(lv.key)}" aria-pressed="${off ? 'false' : 'true'}"${off ? ' class="is-off"' : ''}>`
          + `<span class="c-key c-key--${esc(lv.key)}"></span>${esc(lv.label)}</button>`;
      }).join('');
    },
  };

  /* ---------- chart wiring ---------- */
  els.tfs.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-tf]');
    if (b) chart.setTf(b.dataset.tf);
  });
  els.units.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-unit]');
    if (b && !b.disabled) chart.setUnit(b.dataset.unit);
  });
  els.emaChip.addEventListener('click', () => { chart.ema = !chart.ema; chart.syncChips(); chart.render(); });
  els.zonesChip.addEventListener('click', () => { chart.zones = !chart.zones; chart.syncChips(); chart.render(); });
  els.sizeChip.addEventListener('click', () => chart.cycleSize(1));
  els.maxChip.addEventListener('click', () => chart.toggleMax());
  els.foldChip.addEventListener('click', () => chart.toggleFold());
  els.chartChip.addEventListener('click', () => chart.toggleFold());

  els.legend.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-lv]');
    if (!b) return;
    const k = b.dataset.lv;
    if (chart.hidden[k]) delete chart.hidden[k]; else chart.hidden[k] = true;
    chart.render();
  });
  els.measureChip.addEventListener('click', () => chart.setMeasure(!chart.measure));

  /* ---- pointer: hover, drag to pan, wheel to zoom, pinch, measure ----
     stopPropagation throughout: the field underneath is a map that pans and
     zooms on the same gestures, and a wheel meant for the chart must not also
     move the map behind it. */
  (function chartPointer() {
    const local = ev => {
      const svg = els.plot.firstElementChild;
      if (!svg || !chart.G) return null;
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: (ev.clientX - r.left) / r.width * chart.G.W, y: (ev.clientY - r.top) / r.height * chart.G.H };
    };
    const pointers = new Map();
    let pinch = null;

    els.plot.addEventListener('pointerdown', ev => {
      const p = local(ev);
      if (!p) return;
      ev.stopPropagation();
      pointers.set(ev.pointerId, p);
      try { els.plot.setPointerCapture(ev.pointerId); } catch (e) { /* not fatal */ }
      if (pointers.size === 2) {
        const [p1, p2] = [...pointers.values()];
        pinch = { dist: Math.max(8, Math.abs(p1.x - p2.x)), a: chart.a, b: chart.b, mid: chart.pxInv((p1.x + p2.x) / 2) };
        chart.drag = null;
        return;
      }
      if (ev.button !== 0) return;
      if (chart.measure && chart.sc) {
        const i = chart.pxInv(p.x), v = chart.sc.inv(p.y);
        chart.meas = { i0: i, p0: v, i1: i, p1: v };
        chart.drag = { kind: 'measure' };
        chart.requestRender();
        return;
      }
      chart.drag = { kind: 'pan', x0: p.x, a0: chart.a, b0: chart.b };
      els.chart.classList.add('is-panning');
    });

    els.plot.addEventListener('pointermove', ev => {
      const p = local(ev);
      if (!p) return;
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [p1, p2] = [...pointers.values()];
        const dist = Math.max(8, Math.abs(p1.x - p2.x));
        const max = chart.barCount() + CHART_RIGHT_GAP;
        const span = Math.max(Math.min(CHART_MIN_BARS, max), Math.min(max, (pinch.b - pinch.a) * pinch.dist / dist));
        const frac = Math.max(0, Math.min(1, ((p1.x + p2.x) / 2 - chart.G.pad.l) / chart.G.iw));
        chart.a = pinch.mid + 0.5 - frac * span;
        chart.b = chart.a + span;
        chart.clampView();
        chart.requestRender();
        return;
      }
      if (chart.drag && chart.drag.kind === 'pan') {
        const bars = (p.x - chart.drag.x0) / chart.G.iw * (chart.drag.b0 - chart.drag.a0);
        chart.a = chart.drag.a0 - bars;
        chart.b = chart.drag.b0 - bars;
        chart.clampView();
        chart.requestRender();
        return;
      }
      if (chart.drag && chart.drag.kind === 'measure' && chart.sc) {
        chart.meas.i1 = chart.pxInv(p.x);
        chart.meas.p1 = chart.sc.inv(p.y);
        chart.requestRender();
        return;
      }
      if (chart.sc) { chart.hover = { i: chart.pxInv(p.x), p: chart.sc.inv(p.y) }; chart.requestRender(); }
    });

    const endPointer = ev => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      /* A finger leaves no cursor behind, so pointerleave may never come. */
      if (ev.pointerType && ev.pointerType !== 'mouse') chart.hover = null;
      if (chart.drag) { chart.drag = null; els.chart.classList.remove('is-panning'); }
      chart.requestRender();
    };
    els.plot.addEventListener('pointerup', endPointer);
    els.plot.addEventListener('pointercancel', endPointer);
    els.plot.addEventListener('pointerleave', () => { chart.hover = null; chart.requestRender(); });
    els.plot.addEventListener('dblclick', ev => { ev.stopPropagation(); chart.resetView(); chart.requestRender(); });
    els.plot.addEventListener('wheel', ev => {
      const p = local(ev);
      if (!p) return;
      ev.preventDefault();
      ev.stopPropagation();
      chart.zoomAt(Math.exp(ev.deltaY * 0.0018), chart.pxInv(p.x));
    }, { passive: false });
  })();

  /* Resize by any of the four corner grips (desktop). The pane can be put
     anywhere, so the corner in reach is the one to pull. The corner opposite
     the grip stays put; the size becomes a custom one, written through the
     CSSOM -- the page forbids style attributes in markup, not properties set
     from script. */
  (function grips() {
    let g = null;
    const top = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dd-top')) || 44) + 6;
    for (const el of els.grips) {
      const c = el.dataset.c, left = c[1] === 'l', up = c[0] === 't';
      el.addEventListener('pointerdown', ev => {
        if (ev.button !== 0 || chart.max) return;
        LAYOUT.anchor('chart', left ? 'r' : 'l', up ? 'b' : 't');
        const r = els.chart.getBoundingClientRect();
        /* Never past the window's edges, never up into the band. */
        g = {
          x0: ev.clientX, y0: ev.clientY, w0: r.width, h0: r.height,
          wMax: left ? r.right : window.innerWidth - r.left,
          hMax: up ? r.bottom - top() : window.innerHeight - r.top,
        };
        el.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        ev.stopPropagation();
      });
      el.addEventListener('pointermove', ev => {
        if (!g) return;
        const dx = ev.clientX - g.x0, dy = ev.clientY - g.y0;
        const w = Math.max(320, Math.min(window.innerWidth - 24, g.wMax, g.w0 + (left ? -dx : dx)));
        const h = Math.max(180, Math.min(window.innerHeight - 56, g.hMax, g.h0 + (up ? -dy : dy)));
        els.chart.style.width = `${Math.round(w)}px`;
        els.chart.style.minWidth = '0';
        els.chart.style.height = `${Math.round(h)}px`;
        chart.requestRender();
      });
      const end = () => { if (g) { g = null; LAYOUT.settle('chart'); updateDock(); } };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
    /* a preset size clears the custom one */
    for (const el of [els.sizeChip, els.maxChip]) el.addEventListener('click', () => { els.chart.style.width = ''; els.chart.style.minWidth = ''; els.chart.style.height = ''; });
  })();

  if (window.ResizeObserver) {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; updateDock(); chart.requestRender(); });
    }).observe(els.chart);
  }
  window.addEventListener('resize', () => { updateDock(); chart.requestRender(); });
  document.addEventListener('visibilitychange', () => {
    if (!current) return;
    if (document.hidden) chart.setPollState('off');
    else chart.startPoll();
  });

  /* ---------- the watchlist ----------
     The Web Analyzer's watchlist (webapp/index.html, the WL module), in the
     terminal: a star on the token on screen keeps it in THIS browser with the
     score, price and both plans from that read, and the list says what to do
     with each one now. Same record shape and same verdict rule as the
     analyzer's, so the two read a token the same way; the storage is this
     origin's own (a browser keeps one list per site), and the analyzer's
     "copy list link" (?w=<cc>:<address>,…) opens here and merges in.
     Nothing reaches our backend: prices come from DexScreener in batches of
     30 every 60 s while the panel is open and the tab visible, and a score
     refreshes when the token is opened, which is a read by the engine. */
  /* KEEP IN SYNC with CC / CC_REV in webapp/index.html (the WL module):
     two-letter chain codes in list links. tools/check_chain_wiring.py
     compares the two. */
  const WL_CC = { solana: 'so', ethereum: 'et', eth: 'et', base: 'ba', bsc: 'bs', robinhood: 'ro', arbitrum: 'ar', mantle: 'ma', arc: 'ac' };
  const WL_CC_REV = { so: 'solana', et: 'ethereum', ba: 'base', bs: 'bsc', ro: 'robinhood', ar: 'arbitrum', ma: 'mantle', ac: 'arc' };
  const WATCH = (() => {
    const KEY = 'dd-watch:v1', VIEW_KEY = 'dido-watch-view:v1', CAP = 50, PRICE_EVERY_MS = 60000;
    const GROUPS = { go: 'in the buy zone', wait: 'waiting for a dip', under: 'fell under the zone', none: 'no buy signal' };
    const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
    let store = read(KEY);
    if (!store || store.v !== 1 || !Array.isArray(store.items)) store = { v: 1, items: [] };
    let horizon = (read(VIEW_KEY) || {}).horizon === 'lt' ? 'lt' : 'st';
    let isOpen = false, filter = null, timer = null;

    const sym = v => String(v || '').replace(/^\$+/, '');
    const chainOf = c => (c === 'eth' ? 'ethereum' : String(c || '').toLowerCase());
    const keyOf = (chain, addr) => `${chainOf(chain)}:${String(addr || '').toLowerCase()}`;
    const find = (chain, addr) => store.items.find(i => keyOf(i.chain, i.address) === keyOf(chain, addr)) || null;
    const save = () => { if (!write(KEY, store)) note("couldn't save: this browser blocks storage here"); };
    const livePrice = it => (it.px != null ? it.px : (it.last ? it.last.price : null));
    const pctAbs = v => `${Math.abs(v * 100).toFixed(Math.abs(v * 100) < 10 ? 1 : 0)}%`;
    const pct = v => (v == null || !isFinite(v)) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${pctAbs(v)}`;
    function ago(ts) {
      if (!ts) return '–';
      const s = Math.max(0, (Date.now() - ts) / 1000);
      if (s < 90) return 'just now';
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      return `${Math.round(s / 86400)} d ago`;
    }

    /* The record, field for field the analyzer's `snapshot`/`planOf`. */
    function planOf(res, h) {
      const lo = h === 'st' ? res.stEntryLow : res.ltEntryLow;
      const hi = h === 'st' ? res.stEntryHigh : res.ltEntryHigh;
      const tp = h === 'st' ? res.stTpLow : res.ltTpLow;
      return (lo != null && hi != null && tp != null) ? { lo, hi, tp } : null;
    }
    function snapshot(info, res) {
      return {
        ts: Date.now(), score: res.score, price: info.price_usd || null,
        mcap: info.market_cap || info.fdv || null,
        st: planOf(res, 'st'), lt: planOf(res, 'lt'),
        stock: res.profile === 'STOCK', native: !!res.native,
      };
    }
    /* The verdict. KEEP IN SYNC with `signal` in the analyzer's WL module:
       below 55 the score does not support a buy; inside the zone (or within
       2% under its floor, which is noise) is a buy; above is a wait; further
       under means the support the zone was drawn on broke. */
    function signal(it, h) {
      const L = it.last;
      if (!L) return { k: 'none', word: 'not read yet', why: 'open it to read it' };
      const p = L[h], price = livePrice(it);
      if (L.score < 55) return { k: 'none', word: 'not a buy', why: 'score under 55' };
      if (!p) return { k: 'none', word: 'no setup', why: L.native ? 'no plan for our own token' : `no ${h === 'st' ? 'short-term' : 'long-term'} plan` };
      if (!price) return { k: 'none', word: 'no price', why: 'price unavailable' };
      if (price >= p.tp) return { k: 'wait', word: 'past the sell level', why: '' };
      const profit = p.tp / price - 1;
      if (price > p.hi) return { k: 'wait', word: 'wait for a dip', why: `${pctAbs(price / p.hi - 1)} above zone`, profit };
      if (price < p.lo * 0.98) return { k: 'under', word: 'plan needs a reread', why: `${pctAbs(1 - price / p.lo)} under zone` };
      return { k: 'go', word: 'in the buy zone', why: `${pct(profit)} to sell level`, profit };
    }

    function absorb(it, info, res, pair) {
      it.last = snapshot(info, res);
      if (!it.at) it.at = { ts: it.last.ts, score: res.score, price: it.last.price, mcap: it.last.mcap };
      if (!it.seen) it.seen = { score: res.score, st: signal(it, 'st').k, lt: signal(it, 'lt').k };
      it.symbol = sym(info.symbol) || it.symbol; it.name = info.name || it.name;
      if (pair) { it.pair = pair.pairAddress || it.pair; it.img = ((pair.info || {}).imageUrl) || it.img || null; }
      if (info.price_usd) { it.px = info.price_usd; it.pmcap = it.last.mcap; it.pts = Date.now(); }
    }

    /* ── the chips ── */
    function paintChips() {
      const n = store.items.length;
      $('wlCount').textContent = String(n);
      const go = store.items.filter(it => signal(it, horizon).k === 'go').length;
      $('wlGoDot').hidden = !go;
      els.wlChip.title = n ? `watchlist · ${n} token${n > 1 ? 's' : ''}${go ? ` · ${go} in the buy zone` : ''}` : 'watchlist';
      const star = els.starChip;
      star.hidden = !current;
      if (!current) return;
      const it = find(current.chain, current.address);
      star.setAttribute('aria-pressed', String(!!it));
      if (!it) { star.innerHTML = '☆<span class="dd-chip__t"> watch</span>'; star.title = currentRes ? 'keep this token on your watchlist, with this read' : 'keep this token on your watchlist'; return; }
      const A = it.at, L = it.last;
      const since = A && L && Date.now() - A.ts > 5 * 60000 ? ` · ${A.score}→${L.score}` : '';
      star.innerHTML = `★<span class="dd-chip__t"> watching${esc(since)}</span>`;
      star.title = 'remove from your watchlist';
    }
    /* Called for every token the terminal reads: a watched token's record
       is refreshed from that read, which is how scores stay current. */
    function onRead(info, res, pair) {
      const it = find(info.chain, info.address);
      if (it && res) { absorb(it, info, res, pair); save(); }
      paintChips();
      if (isOpen) render();
    }
    function toggleStar() {
      if (!current) return;
      const cur = find(current.chain, current.address);
      if (cur) store.items = store.items.filter(x => x !== cur);
      else {
        if (store.items.length >= CAP) { note(`${CAP} is the limit`); return; }
        const it = { chain: chainOf(current.chain), address: current.address, symbol: sym(current.symbol), name: current.name,
          pair: current.pair_address || null, img: current.image_url || null, addedAt: Date.now(), at: null, last: null };
        if (currentRes) absorb(it, current, currentRes, currentPair);
        store.items.unshift(it);
      }
      save(); paintChips(); if (isOpen) render();
    }

    /* ── the panel ── */
    function open(v) {
      isOpen = v;
      els.wl.hidden = !v;
      if (v) LAYOUT.apply('wl');
      els.wlChip.setAttribute('aria-expanded', String(v));
      els.wlChip.classList.toggle('on', v);
      syncKeepOut();
      clearInterval(timer);
      if (v) {
        render(); refreshPrices();
        timer = setInterval(() => { if (!document.hidden) refreshPrices(); }, PRICE_EVERY_MS);
      } else {
        store.items.forEach(it => { if (it.last) it.seen = { score: it.last.score, st: signal(it, 'st').k, lt: signal(it, 'lt').k }; });
        save();
      }
    }
    function isMoved(it) {
      if (!it.seen || !it.last) return false;
      return it.seen.score !== it.last.score || it.seen.st !== signal(it, 'st').k || it.seen.lt !== signal(it, 'lt').k;
    }
    /* The token's logo on a disc, its ticker's initial while there is none
       (or it is still loading). A logo this page has already shown goes in
       straight away, so the minute's re-render does not fade it in again. */
    const shownLogos = new Set();
    function logoHtml(it) {
      const ini = `<b>${esc((sym(it.symbol) || '?').slice(0, 1).toUpperCase())}</b>`;
      if (!it.img || !IMG_OK.test(it.img)) return `<i class="dd-hc__logo dd-wcard__logo" aria-hidden="true">${ini}</i>`;
      if (shownLogos.has(it.img)) return `<i class="dd-hc__logo dd-wcard__logo is-in" aria-hidden="true">${ini}<img alt="" src="${esc(it.img)}" decoding="async" referrerpolicy="origin"></i>`;
      return `<i class="dd-hc__logo dd-wcard__logo" data-logo="${esc(it.img)}" aria-hidden="true">${ini}</i>`;
    }
    function cardHtml(it, sig) {
      const L = it.last, A = it.at;
      const d = L && A ? L.score - A.score : 0;
      const here = current && keyOf(current.chain, current.address) === keyOf(it.chain, it.address);
      const price = livePrice(it);
      const p = L && L[horizon];
      const meta = [];
      if (price) meta.push(`<span>price <b>${esc(DD.fmtPrice(price))}</b>${A && A.price ? ` ${esc(pct(price / A.price - 1))}` : ''}</span>`);
      if (p) meta.push(`<span>buy <b>${esc(DD.fmtPrice(p.lo))}–${esc(DD.fmtPrice(p.hi))}</b></span>`, `<span>sell <b>${esc(DD.fmtPrice(p.tp))}</b></span>`);
      meta.push(`<span>read ${esc(ago(L && L.ts))}</span>`);
      return `<article class="dd-wcard${here ? ' is-here' : ''}" tabindex="0" data-k="${esc(keyOf(it.chain, it.address))}" aria-label="$${esc(it.symbol || '')}, ${esc(sig.word)}">
        <span class="dd-wcard__sym">${logoHtml(it)}<span class="dd-wcard__tk">$${esc(it.symbol || '?')}<span class="mono">${esc(DD.chainTag(it.chain))}</span>${L && L.native ? '<span class="dd-tag" title="house policy applied to our own token">our token</span>' : ''}${isMoved(it) ? '<span class="dd-tag" title="changed since you last opened the list">moved</span>' : ''}</span></span>
        <span class="dd-wcard__score num">${L ? `${L.score}<small>${d ? `${d > 0 ? '▲' : '▼'}${Math.abs(d)}` : '·'}</small>` : '–'}</span>
        <div class="dd-wcard__sig is-${sig.k}"><b>${esc(sig.word)}</b><span>${esc(sig.why || '')}</span></div>
        <div class="dd-wcard__meta num">${meta.join('')}</div>
        <button type="button" class="dd-wcard__x" data-x aria-label="remove $${esc(it.symbol || '')} from the watchlist">✕</button>
      </article>`;
    }
    function render() {
      paintChips();
      if (!isOpen) return;
      els.wlHz.querySelectorAll('[data-hz]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.hz === horizon)));
      if (!store.items.length) {
        els.wlPills.innerHTML = '';
        els.wlBody.innerHTML = `<p class="dd-empty-note"><b>nothing watched yet.</b><br>open a token and press <b>☆ watch</b> (or <b>s</b>).<br>it lands here with the read from that moment.</p>`;
        return;
      }
      const rows = store.items.map(it => ({ it, sig: signal(it, horizon) }));
      const counts = { go: 0, wait: 0, under: 0, none: 0 };
      rows.forEach(r => { counts[r.sig.k]++; });
      els.wlPills.innerHTML = Object.keys(GROUPS).map(k =>
        `<button type="button" class="dd-wl__pill is-${k}${counts[k] ? '' : ' is-zero'}" data-pill="${k}" aria-pressed="${filter === k}"><i></i><b>${counts[k]}</b>${esc(GROUPS[k])}</button>`).join('');
      const html = [];
      ['go', 'wait', 'under', 'none'].forEach(k => {
        if (filter && filter !== k) return;
        const g = rows.filter(r => r.sig.k === k)
          .sort((a, b) => (isMoved(b.it) - isMoved(a.it)) || ((b.sig.profit == null ? -9 : b.sig.profit) - (a.sig.profit == null ? -9 : a.sig.profit)) || (b.it.addedAt - a.it.addedAt));
        if (!g.length) return;
        html.push(`<div class="dd-wl__grp is-${k}"><i></i>${esc(GROUPS[k])} · ${horizon === 'st' ? 'short-term' : 'long-term'} plan</div>`);
        g.forEach(r => html.push(cardHtml(r.it, r.sig)));
      });
      els.wlBody.innerHTML = html.join('');
      els.wlBody.querySelectorAll('[data-logo]').forEach(mark => {
        const img = new Image();
        img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin';
        img.onload = () => { if (!img.naturalWidth) return; shownLogos.add(mark.dataset.logo); if (mark.isConnected) { mark.appendChild(img); mark.classList.add('is-in'); } };
        img.src = mark.dataset.logo;
      });
      syncKeepOut();
    }
    function note(msg) {
      const n = els.wlNote;
      n.textContent = msg;
      clearTimeout(n._t);
      n._t = setTimeout(() => { n.textContent = 'kept in this browser only'; }, 4200);
    }

    /* ── prices: one batched DexScreener read per 30 tokens ── */
    async function refreshPrices() {
      const due = store.items.filter(it => !it.pts || Date.now() - it.pts > PRICE_EVERY_MS - 5000);
      for (let i = 0; i < due.length; i += 30) {
        const chunk = due.slice(i, i + 30);
        const addrs = [...new Set(chunk.map(it => it.address))];
        let pairs = [];
        try { pairs = (await getJson(`${DEXSCREENER}/tokens/${addrs.map(encodeURIComponent).join(',')}`)).pairs || []; } catch (e) { continue; }
        chunk.forEach(it => {
          const mine = pairs.filter(p => chainOf(p.chainId) === chainOf(it.chain) && pricesToken(p, it.address));
          if (!mine.length) return;
          const pair = mine.find(p => it.pair && (p.pairAddress || '').toLowerCase() === String(it.pair).toLowerCase())
            || mine.sort((a, b) => +((b.liquidity || {}).usd || 0) - +((a.liquidity || {}).usd || 0))[0];
          const px = +pair.priceUsd;
          if (px > 0) { it.px = px; it.pmcap = +(pair.marketCap || pair.fdv || 0) || null; it.pts = Date.now(); }
          if (!it.pair) it.pair = pair.pairAddress;
          const bt = pair.baseToken || {};
          if (!it.symbol || it.symbol.endsWith('…')) it.symbol = sym(bt.symbol) || it.symbol;
          if (!it.name) it.name = bt.name || '';
          if (!it.img) it.img = ((pair.info || {}).imageUrl) || null;
        });
      }
      if (due.length) { save(); render(); if (home) home.watchChanged(); }
    }

    /* ── links: the analyzer's format, both ways ── */
    function importFrom(raw) {
      let added = 0, over = 0;
      String(raw || '').split(',').forEach(part => {
        const m = part.trim().match(/^([a-z]{2}):([A-Za-z0-9]{20,64})$/);
        if (!m || !WL_CC_REV[m[1]]) return;
        const chain = WL_CC_REV[m[1]], address = m[2];
        if (find(chain, address)) return;
        if (store.items.length >= CAP) { over++; return; }
        store.items.unshift({ chain, address, symbol: `${address.slice(0, 4)}…`, name: '', pair: null, img: null, addedAt: Date.now(), at: null, last: null });
        added++;
      });
      return { added, over };
    }
    const listUrl = () => `${location.origin}/?w=${store.items.map(it => `${WL_CC[chainOf(it.chain)] || '??'}:${it.address}`).join(',')}`;

    function init(wParam) {
      els.wlChip.addEventListener('click', () => open(!isOpen));
      els.wlClose.addEventListener('click', () => open(false));
      els.starChip.addEventListener('click', toggleStar);
      els.wlHz.addEventListener('click', e => {
        const b = e.target.closest('[data-hz]');
        if (!b || b.dataset.hz === horizon) return;
        horizon = b.dataset.hz; filter = null;
        write(VIEW_KEY, { v: 1, horizon });
        render();
      });
      els.wlPills.addEventListener('click', e => {
        const b = e.target.closest('[data-pill]');
        if (!b) return;
        filter = filter === b.dataset.pill ? null : b.dataset.pill;
        render();
      });
      const pick = card => {
        const it = store.items.find(x => keyOf(x.chain, x.address) === card.dataset.k);
        if (!it) return;
        if (window.innerWidth <= 640) open(false);
        goToken(chainOf(it.chain), it.address);
      };
      els.wlBody.addEventListener('click', e => {
        const card = e.target.closest('.dd-wcard');
        if (!card) return;
        if (e.target.closest('[data-x]')) {
          store.items = store.items.filter(x => keyOf(x.chain, x.address) !== card.dataset.k);
          save(); render(); return;
        }
        pick(card);
      });
      els.wlBody.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.classList.contains('dd-wcard')) pick(e.target);
      });
      els.wlCopy.addEventListener('click', async () => {
        if (!store.items.length) { note('nothing to share yet'); return; }
        try { await navigator.clipboard.writeText(listUrl()); note('list link copied'); }
        catch (e) { window.prompt('copy this link:', listUrl()); }
      });
      window.addEventListener('pagehide', () => { if (isOpen) open(false); });
      window.addEventListener('storage', e => { if (e.key === KEY) { store = read(KEY) || store; render(); } });
      if (wParam) {
        const r = importFrom(wParam);
        save();
        open(true);
        if (r.added) note(`${r.added} added from a shared list${r.over ? ` · ${r.over} over the limit` : ''}`);
      }
      paintChips();
    }
    return { init, onRead, toggle: () => open(!isOpen), close: () => open(false), toggleStar, paintChips, get open() { return isOpen; },
      /* for the welcome: the list, the verdict and the price refresh as they are, nothing re-derived */
      get items() { return store.items; }, get horizon() { return horizon; }, signal, livePrice, keyOf, refresh: refreshPrices, ago };
  })();

  /* ---------- the wallet ----------
     The journey (README, roadmap 5): any EVM wallet on the map opens as a
     place of its own, and anything it holds opens as its own terminal. The
     numbers are the server's GET /api/wallet-scan, read from Blockscout's
     address, token-balance and NFT endpoints on every chain at once -- the
     portfolio, the cross-chain merge, the dust floor and the spam filter
     are worked out there, never a second time here. What the terminal does
     not draw (the NFT gallery, the full history) is one link away on the
     wallet's Blockscout page, never silently dropped. */
  const WAL_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  /* Token artwork the page's CSP lets in (dido/server.js, img-src). Any
     other host would be refused by the browser, so it is not asked. */
  const IMG_OK = /^(https:\/\/(cdn|dd)\.dexscreener\.com\/|data:image\/png;base64,[A-Za-z0-9+/=]+$)/;
  /* What a wallet scan really goes through, in order: the pane's loading
     list and the travelling bubble both say these. */
  const WAL_PHASES = ['probing the chains', 'reading balances', 'pricing holdings', 'reconstructing cost basis'];
  /* A holding's identity across the list, the bubbles and the menu. */
  const holdingKey = h => `${h.chain}:${h.native ? 'native' : String(h.address || '').toLowerCase()}`;
  /* The bubble the viewer last pointed at on the map: where a wallet opened
     from its menu starts its travel. */
  let lastNode = null;
  ['pointerdown', 'focusin'].forEach(t => els.stage.addEventListener(t, ev => {
    const n = ev.target.closest && ev.target.closest('.holder-node');
    if (n) lastNode = n;
  }, true));
  const WALLET = (() => {
    let addr = null, data = null, filter = null, run = 0, phaseT = null, picked = null, shown = [];
    const cache = new Map();   // address -> scan, so going back is instant
    const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
    function usd(v) {
      const n = Math.abs(Number(v) || 0), sign = (Number(v) || 0) < 0 ? '-' : '';
      if (n >= 1e9) return `${sign}$${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${sign}$${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${sign}$${(n / 1e3).toFixed(1)}K`;
      if (n >= 0.01) return `${sign}$${n.toFixed(2)}`;
      return n > 0 ? '<$0.01' : '$0.00';
    }
    const signed = v => `${(Number(v) || 0) >= 0 ? '+' : ''}${usd(v)}`;
    const pctTxt = v => (v == null || !isFinite(v)) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
    function qty(v) {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
      if (n >= 1) return n.toFixed(2);
      return n ? n.toPrecision(3) : '0';
    }
    const mono = s => String(s || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';

    function loading() {
      const steps = WAL_PHASES;
      let i = 0;
      const paint = () => {
        els.walBody.innerHTML = `<div class="dd-wal__load">${steps.map((s, k) =>
          `<span class="${k < i ? 'is-done' : k === i ? 'is-on' : ''}">${k < i ? '✓' : k === i ? '·' : ' '} ${esc(s)}</span>`).join('')}</div>`;
      };
      paint();
      clearInterval(phaseT);
      phaseT = setInterval(() => { if (i < steps.length - 1) { i++; paint(); } }, 2600);
    }
    function fail(msg) {
      clearInterval(phaseT);
      els.walBody.innerHTML = `<p class="dd-empty-note">${esc(msg)}</p>`;
      WGROUND.hide();
      COIN.land('wallet');
    }

    async function open(address, opts) {
      const a = String(address || '').trim();
      if (!WAL_ADDR_RE.test(a)) return;
      const me = ++run;
      addr = a; filter = null; picked = null; shown = [];
      HMENU.close();
      WGROUND.arrive();
      els.wal.hidden = false;
      LAYOUT.apply('wal');
      syncKeepOut();
      els.walTitle.innerHTML = `wallet<small>${esc(short(a))}</small>`;
      els.app.classList.add('has-wal');
      if (!(opts && opts.quiet)) writeUrl();
      await configReady;
      if (me !== run) return;
      if (!CONFIG.wallet_scan) return fail('wallet scans are switched off right now.');
      const hit = cache.get(a.toLowerCase());
      if (hit) { data = hit; render(); if (hit.pnl_pending) finish(a, me); return; }
      data = null;
      loading();
      let json;
      try {
        /* Every chain is probed and read server-side; a busy wallet is ~30
           rate-gated requests, hence the analyzer's generous ceiling. */
        /* `defer=1`: the card as soon as balances, prices and NFTs are in;
           the cost basis follows in finish(). */
        json = await fetchJsonTimeout(`${CONFIG.api}/api/wallet-scan?address=${encodeURIComponent(a)}&defer=1`, 60000);
      } catch (e) {
        if (me !== run) return;
        return fail('could not reach the wallet scan. it timed out or is busy; try again in a moment.');
      }
      if (me !== run) return;
      clearInterval(phaseT);
      if (!json || json.ok !== true || !json.data) {
        const detail = json && typeof json.detail === 'string' ? json.detail : '';
        return fail(json && json.error === 'rate_limited'
          ? 'too many wallet scans from here in the last minute. give it a moment.'
          : (detail || 'this wallet could not be scanned right now.'));
      }
      data = json.data;
      cache.set(a.toLowerCase(), data);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      render();
      if (data.pnl_pending) finish(a, me);
    }
    /* The cost basis behind a deferred card, the analyzer's walFinish: /pnl
       waits on the booking the card started and never reads anything itself;
       if the server has nothing to hand over, the full scan is asked for, so
       the pane never ends up without the basis it would have had. */
    async function finish(a, me) {
      const q = `address=${encodeURIComponent(a)}`;
      let json = null;
      try {
        json = await fetchJsonTimeout(`${CONFIG.api}/api/wallet-scan/pnl?${q}`, 60000);
        /* Only "nothing pending" earns the full scan: after a timeout the
           booking is still running, and a full scan would wait on it too. */
        if (json && json.error === 'not_pending') {
          json = await fetchJsonTimeout(`${CONFIG.api}/api/wallet-scan?${q}`, 60000);
        }
      } catch (e) { json = null; }
      const ok = json && json.ok === true && json.data;
      const key = a.toLowerCase();
      const prev = cache.get(key);
      const next = ok ? json.data : (prev ? { ...prev, pnl_pending: false,
        notes: (prev.notes || []).concat('cost basis could not be read just now') } : null);
      // A failed read is not cached as final: the next visit asks again.
      if (ok && prev) cache.set(key, next);
      if (me !== run || !next) return;
      data = next;
      render();
    }
    function close(opts) {
      run++;
      clearInterval(phaseT);
      HMENU.close();
      WGROUND.hide();
      COIN.land('wallet');
      addr = null; data = null; picked = null; shown = [];
      els.wal.hidden = true;
      syncKeepOut();
      els.walBody.innerHTML = '';
      els.app.classList.remove('has-wal');
      if (!(opts && opts.quiet)) writeUrl();
    }

    /* Rows: the server's merged, ranked list for the whole book; for one
       chain, that chain's own holdings plus its native, the analyzer's
       `walRows`. `pct` is book-relative either way. */
    function rows(w) {
      if (!filter) return w.holdings || [];
      const c = (w.chains || []).find(x => x.chain === filter);
      if (!c) return [];
      const out = [];
      if (c.native && c.native.amount > 0) {
        out.push({ symbol: c.native_symbol, amount: c.native.amount, usd: c.native.usd,
          pct: w.total_usd > 0 ? c.native.usd / w.total_usd * 100 : 0,
          native: true, chain: c.chain, chain_label: c.chain_label, pnl: null });
      }
      return out.concat(c.holdings || []).sort((x, y) => y.usd - x.usd);
    }
    function render() {
      const w = data;
      if (!w) return;
      const chains = w.chains || [];
      if (filter && !chains.some(c => c.chain === filter)) filter = null;
      const tags = [];
      if (w.ens || w.name) tags.push(w.ens || w.name);
      if (w.is_contract) tags.push('contract');
      (w.tags || []).slice(0, 3).forEach(t => tags.push(t));
      if (w.tx_count) tags.push(`${Number(w.tx_count).toLocaleString('en-US')} txs`);
      const pnl = w.pnl;
      const pending = !pnl && !!w.pnl_pending;   // a deferred card: basis still booking
      const failed = w.failed_chains || [], empty = w.empty_chains || [];
      const stat = (k, v, s, dim) => `<div class="dd-wal__stat"><span class="k">${esc(k)}</span><span class="v${dim ? ' is-dim' : ''}">${esc(v)}</span><span class="s">${esc(s)}</span></div>`;
      const head = `<p class="dd-wal__addr">${esc(w.address || addr)}</p>`
        + (tags.length ? `<div class="dd-wal__tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : '')
        + `<div class="dd-wal__stats">`
        + stat('total', usd(w.total_usd), `${chains.length} chain${chains.length === 1 ? '' : 's'}${failed.length ? ` · ${failed.length} unread` : ''}`)
        + stat('tokens · native', usd(w.tokens_usd), `${usd(w.native_usd)} native`)
        + stat('positions', `${(w.holdings || []).length}${w.more ? ` +${w.more}` : ''}`, `${w.unpriced ? `${w.unpriced} unpriced` : 'all priced'}${w.dust ? ` · ${w.dust} dust` : ''}`)
        + stat('unrealised', pnl ? signed(pnl.unrealized_usd) : (pending ? '…' : '—'), pnl ? `${pctTxt(pnl.pct)} on ${usd(pnl.basis_usd)}` : (pending ? 'reading history…' : 'no cost basis'), !pnl || pnl.unrealized_usd < 0)
        + `</div>`;
      /* The chain filter. A chain that could not be READ is not a chain that
         is empty: the dash is a fact about the wallet, "not scanned" is a
         fact about us, and the total is missing whatever sits there. */
      const chainRow = chains.length || empty.length || failed.length ? `<div class="dd-wal__chains">`
        + (chains.length > 1 ? `<button type="button" data-f="" aria-pressed="${!filter}">all</button>` : '')
        + chains.map(c => `<button type="button" data-f="${esc(c.chain)}" aria-pressed="${filter === c.chain}"><b>${esc(c.chain_label)}</b>${esc(usd(c.total_usd))}</button>`).join('')
        + empty.map(k => `<span title="nothing found on ${esc(k)}"><b>${esc(DD.chainTag(k))}</b>—</span>`).join('')
        + failed.map(k => `<span class="is-failed" title="could not be read; anything held there is missing from the total"><b>${esc(DD.chainTag(k))}</b>not scanned</span>`).join('')
        + `</div>` : '';
      const list = rows(w);
      /* Every row opens the holding's menu, the same menu its bubble opens:
         scanning the token is the first thing in it, never a side effect of
         a click. A gas coin opens it too and says why there is no page. */
      const rowHtml = list.length ? list.map((h, k) => {
        const p = h.pnl, opens = !h.native && h.address && SUPPORTED.has(String(h.chain || '').toLowerCase());
        const width = Math.max(0, Math.min(100, h.pct || 0)).toFixed(2);
        return `<button type="button" class="dd-wrow${h.native ? ' is-native' : ''}" data-k="${k}" data-key="${esc(holdingKey(h))}" aria-haspopup="menu" ${opens ? `data-c="${esc(h.chain)}" data-t="${esc(h.address)}" ` : ''}title="$${esc(h.symbol)}: what you can do with it">
          <span class="dd-wrow__mark" data-logo="${esc(h.logo || '')}">${esc(mono(h.symbol))}</span>
          <span class="dd-wrow__sym">${esc(h.symbol)}<span class="mono">${esc(h.chain_label || DD.chainTag(h.chain))}${h.native ? ' · native' : ''}</span></span>
          <span class="dd-wrow__val">${esc(usd(h.usd))}</span>
          <span class="dd-wrow__sub num">${esc(qty(h.amount))} · ${esc((h.pct || 0).toFixed(1))}% of portfolio</span>
          <span class="dd-wrow__pnl${p && p.pct != null && p.pct < 0 ? ' is-down' : ''}">${p && p.pct != null ? esc(pctTxt(p.pct)) : (h.native ? '' : (pending ? '…' : 'no basis'))}</span>
          <span class="dd-wrow__bar"><i data-w="${width}"></i></span>
        </button>`;
      }).join('') : `<p class="dd-empty-note">${chains.length ? 'no priced tokens here.' : `nothing found on the ${empty.length} chain${empty.length === 1 ? '' : 's'} that answered.`}</p>`;
      const facts = [];
      if (pnl) {
        facts.push(['cost basis', `${pnl.positions}/${pnl.positions_total} positions · ${(pnl.coverage_pct || 0).toFixed(0)}% of token value`]);
        if (pnl.realized_usd) facts.push(['realised', signed(pnl.realized_usd)]);
      } else if (pending) facts.push(['cost basis', 'loading · reading the history']);
      else if (chains.length) facts.push(['cost basis', 'none · nothing guessed in its place']);
      if (w.dust) facts.push(['dust', `${w.dust} under $1 · ${usd(w.dust_usd)}`]);
      if (w.unpriced) facts.push(['unpriced', `${w.unpriced} tokens · no market anywhere`]);
      if (w.nfts_hidden) facts.push(['spam nfts', `${w.nfts_hidden} hidden`]);
      if (failed.length) facts.push(['not scanned', `${failed.length} chain${failed.length === 1 ? '' : 's'} · missing from the total`, true]);
      const nfts = w.nft_count || (w.nfts || []).length;
      const topChain = ((w.chains || [])[0] || {}).chain || 'ethereum';
      const full = `${EXPLORERS[topChain] || EXPLORERS.ethereum}/address/${encodeURIComponent(w.address || addr)}`;
      /* The wallet's bubbles, a section of the pane under the totals; its
         corner chip opens them over the whole field. */
      els.walBody.innerHTML = head + '<section class="dd-wal__bubbles" aria-label="the wallet\'s bubbles"></section>' + chainRow + rowHtml
        + (facts.length ? `<div class="dd-wal__facts">${facts.map(([k, v, loud]) => `<div${loud ? ' class="is-loud"' : ''}><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>` : '')
        + `<p class="dd-wal__more">${nfts ? `${nfts}${w.nfts_more ? '+' : ''} nft${nfts === 1 ? '' : 's'} · ` : ''}<a href="${esc(full)}" target="_blank" rel="noopener">open on Blockscout ↗</a></p>`;
      els.walBody.querySelectorAll('[data-w]').forEach(n => { n.style.width = `${n.dataset.w}%`; });
      els.walBody.querySelectorAll('[data-logo]').forEach(mark => {
        const src = mark.dataset.logo;
        if (!src || !IMG_OK.test(src)) return;
        const img = new Image();
        img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin';
        img.onload = () => { if (img.naturalWidth && mark.isConnected) { mark.textContent = ''; mark.appendChild(img); } };
        img.src = src;
      });
      shown = list;
      WGROUND.mini(els.walBody.querySelector('.dd-wal__bubbles'), w);
      syncPick();
      WGROUND.show(w);
      COIN.land('wallet');
      syncKeepOut();   // the pane's height follows its content
    }

    /* A pick lights the row and the bubble together. */
    function syncPick() {
      els.walBody.querySelectorAll('.dd-wrow[data-key]').forEach(r => r.classList.toggle('is-picked', r.dataset.key === picked));
      WGROUND.sync();
    }
    function pick(key) {
      picked = key && key !== picked ? key : null;
      syncPick();
      const row = picked && els.walBody.querySelector(`.dd-wrow[data-key="${CSS.escape(picked)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    function setFilter(k) { filter = k && k !== filter ? k : null; picked = null; render(); }
    /* Leave the wallet for one of its holdings. The trail, and the
       browser's back, return to it with the scan already in hand. */
    function leaveFor(h) {
      close({ quiet: true });
      goToken(h.chain, h.address);
    }

    function init() {
      els.walClose.addEventListener('click', () => close());
      els.walCopy.addEventListener('click', async () => {
        if (!addr) return;
        try { await navigator.clipboard.writeText(addr); els.walCopy.textContent = 'copied'; }
        catch (e) { window.prompt('copy this address:', addr); }
        setTimeout(() => { els.walCopy.textContent = 'copy'; }, 1200);
      });
      els.walBody.addEventListener('click', e => {
        const f = e.target.closest('[data-f]');
        if (f) { setFilter(f.dataset.f || null); return; }
        const row = e.target.closest('.dd-wrow[data-k]');
        if (!row) return;
        const h = shown[+row.dataset.k];
        if (h) HMENU.toggle(h, row);
      });
      /* The way in from the map is the shared block's own now: a click on a
         bubble (or an address in a group) opens the wallet's card, and its
         "open wallet" calls the onWallet hook mountField passes. */
    }
    return {
      init, open, close, pick, setFilter, leaveFor,
      fmt: { usd, pctTxt, short, mono },
      get addr() { return addr; }, get data() { return data; }, get filter() { return filter; }, get picked() { return picked; },
    };
  })();


  /* Open a token by chain and address, as a link would. */
  function goToken(chain, address) {
    if (current && normChain(current.chain) === normChain(chain) && String(current.address).toLowerCase() === String(address).toLowerCase()) { writeUrl(); COIN.land('token'); return; }
    runPinned(normChain(chain), address);
  }

  /* A light tick under the finger where the device has one (Android phones);
     never with reduced motion. iOS has no vibration API, so it stays quiet. */
  function buzz(ms) {
    try { if (navigator.vibrate && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) navigator.vibrate(ms); } catch (e) { /* fine */ }
  }

  /* ---------- a holding's menu ----------
     The holder map's bubble menu (.hm-ctx, styled by the shared block's own
     stylesheet) for one holding of a wallet: the same card in the same
     order, so a wallet reads like the map it was opened from. What it is,
     one line of facts, the step forward first and in bold (scan token), then
     details, its chain, copy. A holding's bubble and its row open the same
     menu. There is no "hide": what a wallet holds is the scan's answer, and
     the scan already drops scam and unpriced tokens before it gets here. */
  const HMENU = (() => {
    const el = els.hctx;
    let on = null;   // { h, anchor }
    const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    function close() {
      if (!on) return;
      on.anchor.classList.remove('is-menu');
      on = null;
      el.hidden = true;
    }
    function open(h, anchor, viaKeyboard) {
      close();
      const w = WALLET.data;
      if (!w || !h || !anchor) return;
      const { usd, pctTxt, short } = WALLET.fmt;
      const key = holdingKey(h);
      const rank = (w.holdings || []).findIndex(x => holdingKey(x) === key);
      const share = w.total_usd > 0 ? (Number(h.usd) || 0) / w.total_usd * 100 : 0;
      const chain = (w.chains || []).find(c => c.chain === h.chain);
      const scans = !h.native && h.address && SUPPORTED.has(String(h.chain || '').toLowerCase());
      const p = h.pnl && h.pnl.pct != null ? h.pnl.pct : null;
      const facts = [`holds ${usd(h.usd)}`,
        h.native ? 'gas coin' : p != null ? `${pctTxt(p)} vs cost` : (w.pnl_pending ? 'cost basis loading' : 'no cost basis'),
        (chain && chain.chain_name) || h.chain_label || DD.chainTag(h.chain)];
      const item = (act, label) => `<button type="button" role="menuitem" class="hm-ctx__i" data-hm="${act}">${label}</button>`;
      el.innerHTML = `<div class="hm-ctx__h"><b>${rank >= 0 ? `#${rank + 1} &middot; ` : ''}${share.toFixed(2)}%</b><span>${esc(h.symbol)} · ${h.native ? 'native' : esc(short(String(h.address || '')))}</span></div>`
        + `<div class="hm-ctx__f">${facts.map(esc).join(' &middot; ')}</div><div class="hm-ctx__m">`
        + (scans ? item('token-open', 'scan token <span>&rarr;</span>')
          : `<p class="dd-hctx__note">${h.native ? 'a gas coin has no token page' : 'this chain is not in the terminal yet'}</p>`)
        + item('pick', WALLET.picked === key ? 'clear details' : 'details')
        + (chain ? item('chain', `${WALLET.filter === h.chain ? 'every chain' : `chain ${esc(chain.chain_label)}`} <span>${(w.total_usd > 0 ? chain.total_usd / w.total_usd * 100 : 0).toFixed(1)}%</span>`) : '')
        + (h.native ? '' : item('copy', 'copy contract'))
        + '</div>';
      on = { h, anchor };
      el.hidden = false;
      anchor.classList.add('is-menu');
      // Beside what was clicked, on the side with room, inside the window.
      const b = anchor.getBoundingClientRect(), mw = el.offsetWidth, mh = el.offsetHeight;
      let x = b.right + 10, side = 'left';
      if (x + mw > innerWidth - 8) { x = b.left - 10 - mw; side = 'right'; }
      x = Math.max(8, Math.min(innerWidth - mw - 8, x));
      const y = Math.max(8, Math.min(innerHeight - mh - 8, b.top + b.height / 2 - mh / 2));
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.transformOrigin = `${side} center`;
      if (!reduced() && el.animate) el.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 190, easing: 'cubic-bezier(.22,1.3,.36,1)' });
      buzz(6);
      if (viaKeyboard) { const first = el.querySelector('[role="menuitem"]'); if (first) first.focus(); }
    }
    function toggle(h, anchor, viaKeyboard) {
      if (on && on.anchor === anchor && holdingKey(on.h) === holdingKey(h)) { close(); return; }
      open(h, anchor, viaKeyboard);
    }
    el.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-hm]');
      if (!b || !on) return;
      const { h, anchor } = on;
      const act = b.dataset.hm;
      if (act === 'copy') {
        let ok = true;
        try { await navigator.clipboard.writeText(h.address); } catch (e) { ok = false; }
        b.innerHTML = ok ? 'copied <span>✓</span>' : `<span>${esc(h.address)}</span>`;
        if (ok) setTimeout(close, 700);
        return;
      }
      close();
      if (act === 'token-open') {
        COIN.lift(anchor, { kind: 'token', label: `$${h.symbol}`, art: h.logo && IMG_OK.test(h.logo) ? h.logo : '',
          phases: ['reading the market', 'reading holders', 'mapping clusters'], to: COIN.fieldSpot });
        buzz(12);
        WALLET.leaveFor(h);
      } else if (act === 'pick') WALLET.pick(holdingKey(h));
      else if (act === 'chain') WALLET.setFilter(h.chain === WALLET.filter ? null : h.chain);
    });
    // A press anywhere else closes it; a scroll or a resize moves what it points at.
    document.addEventListener('pointerdown', ev => { if (on && !el.contains(ev.target) && !on.anchor.contains(ev.target)) close(); }, true);
    els.walBody.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    return { open, close, toggle, get isOpen() { return !!on; } };
  })();

  /* ---------- the travelling bubble ----------
     What was picked becomes the centre of the next place: the bubble (or a
     holding's coin) lifts, arcs to where that place will stand and waits
     there, saying the scan's real phases, until the place is drawn; then it
     lets go. One at a time: a new lift drops the last. Moved with the Web
     Animations API and the DOM's style object, never a style attribute (the
     CSP). With reduced motion nothing travels.

     A token's bubble and the holder map's loader wait in the same place, so
     once the loader is up the bubble takes the loader's mark's seat (dock):
     the mark steps aside, the bubble glides onto it, and the loader's
     percentage and phase sit under the token's own logo -- one stack, not a
     logo dropped over the loader. The loader then says the phases, so the
     bubble stops saying its own. */
  const COIN = (() => {
    const SIZE = 112;
    let cur = null;
    const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* Where it rests is snapped to the screen's own pixels: a centre worked
       out from the window or a box is often a half pixel, and a layer
       parked between pixels is resampled, which softens the logo and the
       rim (measured: the sharpest edge drops from 159 to 93 of 255 on a 1x
       screen). */
    const px = v => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };
    const at = (x, y, k) => `translate(${px(x - SIZE / 2)}px, ${px(y - SIZE / 2)}px) scale(${k})`;
    /* A finished move is written to the style object and the animation let
       go, so the bubble rests as a still layer, not one held by a filling
       animation. */
    const settle = (el, anim, end) => anim.finished.then(() => { el.style.transform = end(); anim.cancel(); });
    function undock(g) {
      if (g && g.host) { g.host.classList.remove('has-coin'); g.host = null; }
    }
    function drop() {
      if (!cur) return;
      clearInterval(cur.timer); clearTimeout(cur.guard);
      undock(cur);
      cur.el.remove();
      cur = null;
    }
    /* The centre of the loader's mark, where the bubble sits once docked. */
    function seat(host) {
      const m = host.querySelector('.hm-loader__mark');
      const r = m && m.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }
    function glide(g) {
      const to = g.host && seat(g.host);
      if (!to || (Math.abs(to.x - g.x) < 1 && Math.abs(to.y - g.y) < 1)) return;
      const from = at(g.x, g.y, 1);
      g.x = to.x; g.y = to.y;
      const a = g.el.animate([{ transform: from }, { transform: at(g.x, g.y, 1) }],
        { duration: 360, easing: 'cubic-bezier(.3,.9,.3,1)', fill: 'forwards' });
      settle(g.el, a, () => at(g.x, g.y, 1)).catch(() => {});
    }
    /* The holder loader is up: the waiting token bubble moves into it. It
       now waits as long as the loader does (the map's mount, a failure note
       or a new run lets it go), so the 15 s guard is off; a loader taken off
       the field without either still lets it go, on the next tick. */
    function dock(host) {
      const g = cur;
      if (!g || g.kind !== 'token' || !host) return;
      undock(g);
      g.host = host;
      host.classList.add('has-coin');
      g.el.classList.add('is-docked');
      clearTimeout(g.guard);
      g.flown.then(() => { if (cur === g) glide(g); });
    }
    function lift(from, o) {
      drop();
      if (reduced() || !from || !from.getBoundingClientRect || !els.app.animate) return;
      const b = from.getBoundingClientRect();
      if (!(b.width > 0)) return;
      const el = document.createElement('div');
      el.className = `dd-coin${o.art ? ' has-art' : ''}`;
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = `${o.art ? '<img alt="">' : ''}<span class="dd-coin__t"><b>${esc(o.label)}</b><small></small></span>`;
      if (o.art) { const img = el.querySelector('img'); img.referrerPolicy = 'origin'; img.src = o.art; }
      els.app.appendChild(el);
      const x0 = b.left + b.width / 2, y0 = b.top + b.height / 2;
      const k0 = Math.max(0.16, Math.min(1, Math.max(18, Math.min(b.width, b.height)) / SIZE));
      const to = o.to();
      const g = { el, kind: o.kind, x: to.x, y: to.y, timer: 0, guard: 0, host: null };
      el.style.transform = at(x0, y0, k0);
      const flight = el.animate([
        { transform: at(x0, y0, k0), opacity: 0.75 },
        { transform: at((x0 + to.x) / 2, Math.min(y0, to.y) - 60, 0.74), opacity: 1, offset: 0.45 },
        { transform: at(to.x, to.y, 1), opacity: 1 },
      ], { duration: 620, easing: 'cubic-bezier(.3,.9,.3,1.06)', fill: 'forwards' });
      g.flown = settle(el, flight, () => at(to.x, to.y, 1)).catch(() => {});
      g.flown.then(() => {
        if (cur !== g) return;
        el.classList.add('is-waiting');
        const sm = el.querySelector('small');
        let k = 0;
        sm.textContent = o.phases[0] || '';
        g.timer = setInterval(() => {
          k = Math.min(o.phases.length - 1, k + 1); sm.textContent = o.phases[k];
          if (g.host && !g.host.isConnected) { land(g.kind); return; }
          glide(g);   // the window moved: keep the seat
        }, 1400);
      });
      // A place that never draws must not leave the bubble hanging.
      g.guard = setTimeout(() => land(o.kind), 15000);
      cur = g;
    }
    async function land(kind) {
      const g = cur;
      if (!g || (kind && g.kind !== kind)) return;
      cur = null;
      clearTimeout(g.guard);
      await g.flown;
      clearInterval(g.timer);
      g.el.classList.remove('is-waiting');
      undock(g);
      g.el.animate([{ transform: at(g.x, g.y, 1), opacity: 1 }, { transform: at(g.x, g.y, 0.82), opacity: 0 }],
        { duration: 300, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {}).then(() => g.el.remove());
    }
    /* Where the next place stands: a wallet's bubbles in its pane (the
       section under the totals), a token's map in the middle of the field. */
    function walletSpot() {
      const r = els.wal.hidden ? null : els.wal.getBoundingClientRect();
      if (!r || !(r.width > 1)) { const b = WGROUND.box(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
      return { x: r.left + r.width / 2, y: Math.min(innerHeight - 70, r.top + 366) };
    }
    function fieldSpot() {
      const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dd-top')) || 44;
      return { x: innerWidth / 2, y: (top + innerHeight) / 2 };
    }
    return { lift, land, dock, walletSpot, fieldSpot };
  })();

  /* ---------- the wallet as the ground ----------
     A wallet opens as its own field: the token's map steps back, and what
     the wallet holds is drawn in the holder map's glass -- one marble per
     holding, sized by its share of the wallet, and each chain's holdings
     fused into one liquid body with a plate naming it, the way the map
     draws a cluster of wallets. The address and its total sit in the
     middle. The same drawing, sized down, is a section of the wallet pane
     (`mini`); that is how every wallet opens, and the chip on the
     section's corner opens the full view over the field, with the pane's
     list beside it as the detail (decided 2026-10-11). A pick in one lights
     the other, and a bubble opens the same menu as its row.

     Everything the bubbles say is in the scan already -- nothing is fetched,
     nothing is worked out a second time. Every holding the list shows is
     drawn: no cap, no dropped dust row. */
  /* The holder map's glass, for the wallet's bubbles. These are the shared
     holder-map block's own numbers (sphereFill's SHARE_STEPS, the
     holderGlassRim stops, gooFilter's blur, matrix and alphas) -- one look
     across the map and the wallet. The block keeps them inside its init, out
     of reach, so they are restated here and dido/test/build.test.mjs fails
     the build if the two ever disagree. */
  const GLASS = {
    SHARE_STEPS: [0.08, 0.14, 0.2, 0.27, 0.34, 0.42],
    RIM: [['0', '0.95'], ['0.5', '0.14'], ['1', '0.4']],
    GOO_BLUR: '5',
    GOO_MATRIX: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8',
    GOO_FILL: '0.075',
    GOO_EDGE: '0.42',
  };
  const WGROUND = (() => {
    const el = els.wground, body = els.wgBody;
    let folded = false, w = null, drawnFor = null, drawnAddr = '', size = '';
    const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const phone = () => window.innerWidth <= 640;
    const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

    /* The room beside the pane, wherever the viewer has put it. */
    function box() {
      const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dd-top')) || 44) + 6;
      if (phone()) return { left: 8, top, width: innerWidth - 16, height: Math.max(180, innerHeight * 0.58 - top - 8) };
      const r = els.wal.hidden ? null : els.wal.getBoundingClientRect();
      let left = Math.min(484, innerWidth - 24) + 24, right = innerWidth - 12;
      if (r && r.width > 1) {
        if (r.left + r.width / 2 < innerWidth / 2) left = r.right + 12;
        else { left = 12; right = r.left - 12; }
      }
      return { left, top, width: Math.max(220, right - left), height: Math.max(220, innerHeight - 12 - top) };
    }
    function place() {
      if (el.hidden) return;
      const b = box();
      el.style.left = `${Math.round(b.left)}px`; el.style.top = `${Math.round(b.top)}px`;
      el.style.width = `${Math.round(b.width)}px`; el.style.height = `${Math.round(b.height)}px`;
    }
    /* The full view is the viewer's call: every wallet arrives with its
       bubbles as a section of the pane, and the corner chip on that section
       opens them over the field (decided 2026-10-11). */
    function arrive() { folded = true; }
    function show(data) {
      w = data;
      if (folded || !data || !priced(data)) { hide(); return; }
      /* Bubbles arrive for a new wallet only; the same wallet's later scan
         (the cost basis landing) redraws them in place. */
      const arriving = el.hidden || drawnAddr !== String(data.address || '').toLowerCase();
      el.hidden = false;
      /* A wallet on the field is a run, like a token: the search goes up into
         the band for the session instead of waiting in the middle of the
         bubbles. */
      els.app.classList.add('has-wground', 'has-run');
      place();
      const { short } = WALLET.fmt;
      els.wgCap.innerHTML = `<b>wallet</b> · ${esc(short(data.address || WALLET.addr || ''))} · each chain one body · size = share of the wallet`;
      els.wgFold.textContent = current ? `◂ $${current.symbol || '?'} map` : '◂ the list';
      els.wgFold.title = current ? 'back to the holder map' : 'back to the list';
      const key = `${body.clientWidth}x${body.clientHeight}`;
      if (arriving || drawnFor !== data || key !== size) draw(arriving); else sync();
      syncChip();
    }
    function hide() {
      if (el.hidden) { syncChip(); return; }
      el.hidden = true;
      els.app.classList.remove('has-wground');
      body.innerHTML = '';
      drawnFor = null; drawnAddr = '';
      syncChip();
      syncKeepOut();
    }
    function toggle() {
      HMENU.close();
      folded = !folded;
      if (folded) hide(); else show(WALLET.data);
      buzz(8);
    }
    const priced = data => (data.holdings || []).some(h => (Number(h.usd) || 0) > 0);
    /* The section's corner chip says which way it goes. */
    function syncChip() {
      const chip = els.walBody.querySelector('.dd-wal__full');
      if (!chip) return;
      const on = !el.hidden;
      chip.innerHTML = on ? '<span aria-hidden="true">⤡</span> back to the map' : '<span aria-hidden="true">⤢</span> full view';
      chip.setAttribute('aria-pressed', String(on));
      chip.setAttribute('aria-label', on ? 'Close the full view: back to the map' : "Open the wallet's bubbles over the whole field");
    }

    /* -- the drawing: the holder map's glass, by attribute only. One drawing
       for both sizes: the section in the pane (mini) and the full view. Each
       carries its own ids, since both can be in the page at once. -- */
    function defs(idp) {
      const sphere = (id, a, b) => `<radialGradient id="${id}" cx="0.36" cy="0.28" r="0.94"><stop offset="0" stop-color="var(--ink)" stop-opacity="${a}"/><stop offset="0.55" stop-color="var(--ink)" stop-opacity="${(a + b) / 2}"/><stop offset="1" stop-color="var(--ink)" stop-opacity="${b}"/></radialGradient>`;
      return `<defs>${GLASS.SHARE_STEPS.map((o, i) => sphere(`${idp}S${i}`, Math.min(1, o * 1.25), o * 0.6)).join('')}`
        + `<linearGradient id="${idp}Rim" x1="0" y1="0" x2="0" y2="1">${GLASS.RIM.map(([o, a]) => `<stop offset="${o}" stop-color="#ffffff" stop-opacity="${a}"/>`).join('')}</linearGradient>`
        + `<filter id="${idp}Goo" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur in="SourceGraphic" stdDeviation="${GLASS.GOO_BLUR}" result="blur"/><feColorMatrix in="blur" mode="matrix" values="${GLASS.GOO_MATRIX}" result="goo"/>`
        + `<feMorphology in="goo" operator="erode" radius="0.9" result="core"/><feComposite in="goo" in2="core" operator="out" result="edge"/><feOffset in="goo" dy="1.6" result="low"/><feComposite in="goo" in2="low" operator="out" result="top"/>`
        + `<feFlood flood-color="#ffffff" flood-opacity="0.55" result="white"/><feComposite in="white" in2="top" operator="in" result="glint"/>`
        + `<feComponentTransfer in="goo" result="fillA"><feFuncA type="linear" slope="${GLASS.GOO_FILL}"/></feComponentTransfer><feComponentTransfer in="edge" result="edgeA"><feFuncA type="linear" slope="${GLASS.GOO_EDGE}"/></feComponentTransfer>`
        + `<feMerge><feMergeNode in="fillA"/><feMergeNode in="edgeA"/><feMergeNode in="glint"/></feMerge></filter></defs>`;
    }
    function glassOf(r, idp) {
      const ar = r * 0.8, a0 = 205 * Math.PI / 180, a1 = 295 * Math.PI / 180;
      return `<circle class="holder-node__glass" r="${Math.max(1, r - 0.6).toFixed(1)}" fill="none" stroke="url(#${idp}Rim)" stroke-width="${clamp(0.7, 1.3, r * 0.07).toFixed(2)}" pointer-events="none"/>`
        + `<path class="holder-node__glass" d="M${(ar * Math.cos(a0)).toFixed(2)},${(ar * Math.sin(a0)).toFixed(2)} A${ar.toFixed(2)},${ar.toFixed(2)} 0 0 1 ${(ar * Math.cos(a1)).toFixed(2)},${(ar * Math.sin(a1)).toFixed(2)}" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-linecap="round" stroke-width="${clamp(0.8, 2, r * 0.1).toFixed(2)}" pointer-events="none"/>`;
    }
    function marble(d, h, i, x, y, r, top, hub, mini) {
      const { usd } = WALLET.fmt, idp = mini ? 'ddwm' : 'ddwg';
      const share = d.total_usd > 0 ? h.usd / d.total_usd * 100 : 0;
      const step = Math.min(5, Math.max(0, Math.round(Math.pow(Math.min(1, h.usd / top), 0.55) * 5)));
      const loss = !h.native && h.pnl && h.pnl.pct != null && h.pnl.pct < 0;
      const art = h.logo && IMG_OK.test(h.logo) && r >= (mini ? 10 : 13) ? h.logo : '';
      const cr = r * 0.62;
      /* A token's own artwork sits inside the glass as a coin; the ticker
         goes under it. Without artwork the ticker (and, for a big one, the
         value) is written on the marble. The section is too small for the
         ticker under a coin: its read line names what is pointed at. */
      const label = mini ? (art || r < 14 ? '' : `<text class="dd-wg-tick">${esc(h.symbol)}</text>`)
        : art || r < 16 ? `<text class="dd-wg-tick is-out" y="${(r + 12).toFixed(1)}">${esc(h.symbol)}</text>`
          : r >= 30 ? `<text class="dd-wg-tick" y="-6">${esc(h.symbol)}</text><text class="dd-wg-tick is-val" y="9">${esc(usd(h.usd))}</text>`
            : `<text class="dd-wg-tick">${esc(h.symbol)}</text>`;
      return `<g class="holder-node dd-wg-sat" data-i="${i}" data-c="${esc(h.chain)}" data-key="${esc(holdingKey(h))}" data-dx="${(hub[0] - x).toFixed(1)}" data-dy="${(hub[1] - y).toFixed(1)}" tabindex="0" role="button" aria-haspopup="menu"`
        + ` aria-label="${esc(h.symbol)}${h.native ? ', gas coin' : ''}, ${esc(usd(h.usd))}, ${share.toFixed(1)} percent of the wallet" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">`
        + `<g class="holder-node__inner"><circle class="holder-node__halo" r="${(r + (mini ? 5 : 6)).toFixed(1)}" fill="none" stroke="var(--ink)" stroke-width="1.2" stroke-opacity="0.4" opacity="0" pointer-events="none"/>`
        + `<circle class="holder-node__body" r="${r.toFixed(1)}" fill="url(#${idp}S${step})" stroke="var(--ink)" stroke-opacity="${loss ? 0.7 : 0.42}" stroke-width="1"${loss ? ' stroke-dasharray="3 2.5"' : ''}/>`
        + (art ? `<circle r="${(cr + 1.5).toFixed(1)}" fill="none" stroke="var(--ink)" stroke-opacity="0.22" pointer-events="none"/><clipPath id="${idp}Clip${i}"><circle r="${cr.toFixed(1)}"/></clipPath>`
          + `<image data-logo="${esc(art)}" x="${(-cr).toFixed(1)}" y="${(-cr).toFixed(1)}" width="${(2 * cr).toFixed(1)}" height="${(2 * cr).toFixed(1)}" clip-path="url(#${idp}Clip${i})" preserveAspectRatio="xMidYMid slice" pointer-events="none"/>` : '')
        + glassOf(r, idp) + label + '</g></g>';
    }
    /* Chain pools: each chain's holdings packed around their own centre and
       fused into one liquid body; the address and its total in the middle. */
    function poolsSvg(d, W, H, mini) {
      const { usd, short } = WALLET.fmt, idp = mini ? 'ddwm' : 'ddwg';
      const items = (d.holdings || []).map((h, i) => ({ h, i })).filter(x => (Number(x.h.usd) || 0) > 0);
      const cx = W / 2, cy = H / 2 + (mini ? -4 : 4);
      const top = Math.max(...items.map(x => x.h.usd));
      const k = Math.sqrt(W * H * (mini ? 0.16 : 0.15) / (Math.PI * items.reduce((a, x) => a + x.h.usd, 0)));
      const rOf = h => clamp(mini ? 8 : 13, Math.min(W, H) * (mini ? 0.15 : 0.13), k * Math.sqrt(h.usd));
      const hubR = mini ? 30 : clamp(44, 64, Math.min(W, H) * 0.09);
      const gap = mini ? { own: 4, hub: 5, other: 20, ring: 6, top: 22, bottom: 22, side: 6, spiral: 0.55 } : { own: 5, hub: 8, other: 30, ring: 8, top: 34, bottom: 18, side: 8, spiral: 0.7 };
      /* Chains in the scan's own order (largest first); a holding on a chain
         the scan did not list still gets its own body. */
      const order = (d.chains || []).map(c => c.chain);
      items.forEach(x => { if (!order.includes(x.h.chain)) order.push(x.h.chain); });
      const groups = order.map(k2 => ({ chain: k2, c: (d.chains || []).find(c => c.chain === k2), mem: items.filter(x => x.h.chain === k2) })).filter(g => g.mem.length);
      const n = groups.length, rx = W * (mini ? 0.32 : 0.3), ry = H * (mini ? 0.27 : 0.28);
      const placed = [{ x: cx, y: cy, r: hubR + (mini ? 12 : 22), c: '#hub' }];
      groups.forEach((g, j) => {
        const a = n === 1 ? 0 : -Math.PI / 2 + j * 2 * Math.PI / n + (n === 2 ? Math.PI / 2 : 0);
        const pc = n === 1 ? [cx + rx * 0.75, cy] : [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
        g.pos = [];
        g.mem.slice().sort((p, q) => q.h.usd - p.h.usd).forEach(x => {
          const r = rOf(x.h);
          let spot = null, last = null;
          for (let t = 0; t < 2600 && !spot; t++) {
            const ang = t * 0.5, dd = t * gap.spiral, px = pc[0] + Math.cos(ang) * dd, py = pc[1] + Math.sin(ang) * dd * 0.9;
            if (px < r + gap.side || px > W - r - gap.side || py < r + gap.top || py > H - r - gap.bottom) continue;
            last = [px, py];
            if (placed.every(m => Math.hypot(m.x - px, m.y - py) > m.r + r + (m.c === g.chain ? gap.own : m.c === '#hub' ? gap.hub : gap.other))) spot = last;
          }
          // Crowded: it still goes on the field, nearest the room it wanted.
          spot = spot || last || pc;
          const m = { x: spot[0], y: spot[1], r, c: g.chain, x0: x };
          placed.push(m); g.pos.push(m);
        });
      });
      const plateOf = g => {
        const total = g.c ? g.c.total_usd : g.mem.reduce((a, x) => a + x.h.usd, 0);
        const label = (g.c && g.c.chain_label) || g.mem[0].h.chain_label || DD.chainTag(g.chain);
        const share = (d.total_usd > 0 ? total / d.total_usd * 100 : 0).toFixed(0);
        const rest = mini ? ` ${share}%` : ` ${usd(total)} · ${share}%`;
        const ph = mini ? 16 : 20, pw = (mini ? 14 : 18) + (label.length + rest.length) * (mini ? 5.6 : 6.2);
        const mx = clamp(pw / 2 + 6, W - pw / 2 - 6, g.pos.reduce((a, m) => a + m.x, 0) / g.pos.length);
        /* Above its body, or below it when a neighbour or the centre is in the way. */
        const hits = y => placed.some(m => m.c !== g.chain && Math.abs(m.x - mx) < pw / 2 + m.r && Math.abs(m.y - y) < ph / 2 + 2 + m.r);
        const up = Math.max(ph / 2 + 2, Math.min(...g.pos.map(m => m.y - m.r)) - (mini ? 12 : 20)), down = Math.min(H - ph / 2 - 2, Math.max(...g.pos.map(m => m.y + m.r)) + (mini ? 14 : 30));
        const y = hits(up) && !hits(down) ? down : up;
        return `<g class="dd-wg-plate" data-c="${esc(g.chain)}" transform="translate(${mx.toFixed(1)} ${y.toFixed(1)})" role="button" tabindex="0" aria-label="only ${esc((g.c && g.c.chain_name) || label)}">`
          + `<rect x="${(-pw / 2).toFixed(1)}" y="${-ph / 2}" width="${pw.toFixed(1)}" height="${ph}" rx="${ph / 2}"/><text><tspan class="is-k">${esc(label)}</tspan><tspan class="is-m">${esc(rest)}</tspan></text></g>`;
      };
      let svg = `<svg class="dd-wg-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(short(d.address || ''))}: ${items.length} holdings on ${n} chain${n === 1 ? '' : 's'}">${defs(idp)}`;
      svg += groups.map(g => `<g class="dd-wg-pool" data-c="${esc(g.chain)}" filter="url(#${idp}Goo)" pointer-events="none">${g.pos.map(m => `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${(m.r + gap.ring).toFixed(1)}" fill="var(--ink)"/>`).join('')}</g>`).join('');
      svg += groups.map(g => {
        const m = g.pos[0], dd = Math.hypot(m.x - cx, m.y - cy) || 1, ux = (m.x - cx) / dd, uy = (m.y - cy) / dd, hr = hubR + (mini ? 6 : 9);
        return `<line class="dd-wg-spoke" data-c="${esc(g.chain)}" x1="${(cx + ux * hr).toFixed(1)}" y1="${(cy + uy * hr).toFixed(1)}" x2="${(m.x - ux * m.r).toFixed(1)}" y2="${(m.y - uy * m.r).toFixed(1)}"/>`;
      }).join('');
      svg += `<g class="dd-wg-hub" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})"><g class="dd-wg-hubin"><circle r="${(hubR + (mini ? 6 : 9)).toFixed(1)}" fill="none" stroke="var(--ink)" stroke-opacity="0.22" stroke-dasharray="3 3"/>`
        + `<circle r="${hubR.toFixed(1)}" fill="url(#${idp}S1)" stroke="var(--ink)" stroke-opacity="0.55" stroke-width="1.2"/>${glassOf(hubR, idp)}`
        + (mini ? `<text class="dd-wg-hubval" y="5">${esc(usd(d.total_usd))}</text>`
          : `<text class="dd-wg-hubname" y="-15">${esc(short(d.address || ''))}</text><text class="dd-wg-hubval" y="7">${esc(usd(d.total_usd))}</text><text class="dd-wg-hubsub" y="24">${(d.holdings || []).length} HOLDINGS</text>`)
        + '</g></g>';
      svg += groups.map(g => g.pos.map(m => marble(d, m.x0.h, m.x0.i, m.x, m.y, m.r, top, [cx, cy], mini)).join('')).join('');
      svg += groups.map(plateOf).join('');
      return `${svg}</svg>`;
    }
    // Artwork is drawn only once it has loaded, from the hosts the CSP allows.
    function loadArt(root) {
      root.querySelectorAll('image[data-logo]').forEach(node => {
        const src = node.getAttribute('data-logo');
        if (!IMG_OK.test(src)) return;
        const probe = new Image();
        probe.referrerPolicy = 'origin';
        probe.onload = () => { if (probe.naturalWidth && node.isConnected) node.setAttribute('href', src); };
        probe.src = src;
      });
    }
    function draw(animate) {
      const W = Math.max(220, body.clientWidth), H = Math.max(220, body.clientHeight);
      size = `${body.clientWidth}x${body.clientHeight}`;
      drawnFor = w; drawnAddr = String(w.address || '').toLowerCase();
      body.innerHTML = poolsSvg(w, W, H, false);
      loadArt(body);
      sync();
      if (animate) grow(body);
    }
    /* The section in the pane. WALLET.render rebuilds the pane, so this is
       drawn again with it; it only arrives (grows) for a new wallet. */
    let miniAddr = '';
    function mini(sec, data) {
      if (!sec) return;
      w = data;
      if (!data || !priced(data)) { sec.remove(); return; }
      const W = Math.max(240, sec.clientWidth), H = sec.clientHeight || 252;
      sec.innerHTML = poolsSvg(data, W, H, true)
        + '<p class="dd-wal__bubbles-read mono" aria-live="polite"></p>'
        + '<button type="button" class="dd-chip dd-wal__full" aria-pressed="false"></button>';
      loadArt(sec);
      syncChip();
      sync();
      const addr = String(data.address || '').toLowerCase();
      if (addr !== miniAddr) { miniAddr = addr; grow(sec); }
    }
    function grow(root) {
      if (reduced() || !root.animate) return;
      const A = (n, frames, o) => n.animate(frames, Object.assign({ fill: 'backwards', easing: 'cubic-bezier(.22,1.25,.36,1)' }, o));
      const hub = root.querySelector('.dd-wg-hubin');
      if (hub) A(hub, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 480 });
      const sats = [...root.querySelectorAll('.dd-wg-sat')];
      const far = Math.max(1, ...sats.map(g => Math.hypot(+g.dataset.dx, +g.dataset.dy)));
      sats.forEach(g => {
        const inner = g.querySelector('.holder-node__inner'), dx = +g.dataset.dx * 0.35, dy = +g.dataset.dy * 0.35;
        A(inner, [{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(.3)`, opacity: 0 }, { transform: 'translate(0px, 0px) scale(1)', opacity: 1 }],
          { duration: 640, delay: 60 + Math.hypot(+g.dataset.dx, +g.dataset.dy) / far * 360 });
      });
      root.querySelectorAll('.dd-wg-pool, .dd-wg-spoke, .dd-wg-plate').forEach(n => A(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 360, easing: 'ease-out' }));
    }
    /* The list's chain filter and pick, mirrored on both sizes of bubbles. */
    function sync() {
      const f = WALLET.filter, p = WALLET.picked;
      const sec = els.walBody.querySelector('.dd-wal__bubbles');
      [el.hidden ? null : body, sec].forEach(root => {
        if (!root) return;
        root.querySelectorAll('[data-c]').forEach(n => {
          const isSat = n.classList.contains('dd-wg-sat');
          n.classList.toggle('is-dim', !!((f && n.dataset.c !== f) || (isSat && p && n.dataset.key !== p)));
          if (isSat) n.classList.toggle('is-picked', n.dataset.key === p);
        });
        readOf(root, p ? root.querySelector(`.dd-wg-sat[data-key="${CSS.escape(p)}"]`) : null);
      });
    }
    function readOf(root, sat) {
      if (!w) return;
      const out = root === body ? els.wgRead : root.querySelector('.dd-wal__bubbles-read');
      if (!out) return;
      const { usd, pctTxt } = WALLET.fmt;
      const h = sat && (w.holdings || [])[+sat.dataset.i];
      if (!h) {
        const pnl = w.pnl;
        out.innerHTML = `<b>${esc(usd(w.total_usd))}</b> · ${(w.holdings || []).length} holdings · ${(w.chains || []).length} chain${(w.chains || []).length === 1 ? '' : 's'}`
          + (root === body ? ` · ${pnl ? `<b>${esc(pctTxt(pnl.pct))}</b> unrealised` : w.pnl_pending ? 'cost basis loading' : 'no cost basis'}` : '');
        return;
      }
      const p = h.pnl && h.pnl.pct != null ? h.pnl.pct : null;
      out.innerHTML = `<b>${esc(h.symbol)}</b> · ${esc(usd(h.usd))} · ${(w.total_usd > 0 ? h.usd / w.total_usd * 100 : 0).toFixed(1)}%${root === body ? ' of the wallet' : ''} · ${esc(h.chain_label || DD.chainTag(h.chain))} · `
        + (h.native ? 'gas coin' : p != null ? `<b>${esc(pctTxt(p))}</b> vs cost` : 'no cost basis');
    }

    /* Both sizes answer the same way: a bubble opens its holding's menu, a
       plate filters to its chain, the corner chip opens or closes the full
       view. The section lives in the pane's body, so it is listened to there. */
    function onClick(ev, root) {
      if (ev.target.closest('.dd-wal__full')) { toggle(); return true; }
      const sat = ev.target.closest('.dd-wg-sat');
      if (sat) { const h = (w.holdings || [])[+sat.dataset.i]; if (h) HMENU.toggle(h, sat); return true; }
      const plate = ev.target.closest('.dd-wg-plate');
      if (plate) { HMENU.close(); WALLET.setFilter(plate.dataset.c === WALLET.filter ? null : plate.dataset.c); return true; }
      if (root === body && WALLET.picked) WALLET.pick(null);
      return false;
    }
    function onKey(ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const sat = ev.target.closest('.dd-wg-sat'), plate = ev.target.closest('.dd-wg-plate');
      if (sat) { ev.preventDefault(); const h = (w.holdings || [])[+sat.dataset.i]; if (h) HMENU.open(h, sat, true); }
      else if (plate) { ev.preventDefault(); WALLET.setFilter(plate.dataset.c === WALLET.filter ? null : plate.dataset.c); }
    }
    function onHover(ev, root) {
      const sat = ev.target.closest && ev.target.closest('.dd-wg-sat');
      readOf(root, sat || (WALLET.picked ? root.querySelector(`.dd-wg-sat[data-key="${CSS.escape(WALLET.picked)}"]`) : null));
    }
    body.addEventListener('click', ev => onClick(ev, body));
    body.addEventListener('keydown', onKey);
    body.addEventListener('pointerover', ev => onHover(ev, body));
    body.addEventListener('focusin', ev => onHover(ev, body));
    const inSection = ev => ev.target.closest && ev.target.closest('.dd-wal__bubbles');
    els.walBody.addEventListener('click', ev => { const sec = inSection(ev); if (sec) onClick(ev, sec); });
    els.walBody.addEventListener('keydown', ev => { if (inSection(ev)) onKey(ev); });
    els.walBody.addEventListener('pointerover', ev => { const sec = inSection(ev); if (sec) onHover(ev, sec); });
    els.walBody.addEventListener('focusin', ev => { const sec = inSection(ev); if (sec) onHover(ev, sec); });
    els.wgFold.addEventListener('click', toggle);
    /* A new size is a new layout; small jitters are not. */
    if (window.ResizeObserver) new ResizeObserver(() => {
      if (el.hidden || !w) return;
      const [w0, h0] = size.split('x').map(Number);
      if (Math.abs(body.clientWidth - w0) >= 8 || Math.abs(body.clientHeight - h0) >= 8) draw(false);
    }).observe(body);
    window.addEventListener('resize', place);
    return { box, place, arrive, show, hide, toggle, mini, sync, get on() { return !el.hidden; } };
  })();

  /* ---------- the layout: panes the viewer arranges ----------
     The chart, the watchlist and the wallet can be picked up by their title
     bar and put anywhere over the field. Where a pane is put is kept in this
     browser (`dido-layout:v1`, per viewer, like the theme), as a distance
     from the nearest corner, so a pane left bottom right stays bottom right
     when the window changes size. Panes snap to the 12px inset the docked
     layout uses, never leave the window and never go above the band. A
     double click on a title bar sends that pane home; `0` sends them all.
     Phones keep the sheets: nothing moves below 641px. Every move reaches
     the map as walls (syncKeepOut), so the bubbles make room wherever the
     pane lands. */
  const LAYOUT = (() => {
    const KEY = 'dido-layout:v1', GAP = 12, SNAP = 14;
    let saved = {};
    try { const r = JSON.parse(localStorage.getItem(KEY) || 'null'); if (r && r.v === 1 && r.panes) saved = r.panes; } catch (e) { /* private mode */ }
    const panes = {};
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, panes: saved })); } catch (e) { /* fine */ } };
    const phone = () => window.innerWidth <= 640;
    const band = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dd-top')) || 44) + 6;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(Math.max(lo, hi), v));
    function place(el, l, t) {
      el.style.left = `${Math.round(l)}px`; el.style.top = `${Math.round(t)}px`;
      el.style.right = 'auto'; el.style.bottom = 'auto';
    }
    function clear(el) { el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; }
    const placed = id => !!(saved[id] && panes[id] && !phone() && panes[id].movable());
    function apply(id) {
      const p = panes[id];
      if (!p) return;
      const el = p.el, L = saved[id];
      const on = placed(id);
      el.classList.toggle('is-placed', on);
      if (!on) { clear(el); return; }
      if (el.hidden) return;
      const r = el.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight, top = band();
      const l = L.ax === 'l' ? L.dx : W - r.width - L.dx;
      const t = L.ay === 't' ? L.dy : H - r.height - L.dy;
      place(el, clamp(l, 0, W - r.width), clamp(t, top, H - r.height));
    }
    function remember(id, el) {
      const r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
      const ax = r.left + r.width / 2 < W / 2 ? 'l' : 'r', ay = r.top + r.height / 2 < H / 2 ? 't' : 'b';
      saved[id] = { ax, ay, dx: Math.round(ax === 'l' ? r.left : W - r.right), dy: Math.round(ay === 't' ? r.top : H - r.bottom) };
      save();
    }
    function moved() { updateDock(); syncKeepOut(); }
    function reset(id) {
      delete saved[id]; save(); apply(id);
      if (id === 'chart') chart.render();
      moved();
    }
    /* Register a pane. `movable` says whether it may move right now (the
       chart at max fills the field and does not). */
    function bind(id, el, handle, movable) {
      panes[id] = { el, movable };
      let d = null;
      handle.addEventListener('pointerdown', ev => {
        if (ev.button !== 0 || phone() || !movable()) return;
        if (ev.target.closest('button, input, a, select, label')) return;
        const r = el.getBoundingClientRect();
        d = { x0: ev.clientX, y0: ev.clientY, l0: r.left, t0: r.top, w: r.width, h: r.height, on: false, l: r.left, t: r.top, raf: 0, rest: 0 };
        handle.setPointerCapture(ev.pointerId);
      });
      /* While carried, the pane moves by transform only (no layout), at most
         once a frame; its real place is written once, on the drop. The map
         makes room when the hand rests -- 160 ms without a move -- and where
         the pane lands, not on every frame of the motion: re-settling the
         bubbles under a moving pane cost frames (measured), and a map that
         answers the pause reads as calmer anyway. */
      const paint = () => {
        if (!d) return;
        d.raf = 0;
        el.style.transform = `translate3d(${Math.round(d.l - d.l0)}px, ${Math.round(d.t - d.t0)}px, 0)`;
        clearTimeout(d.rest);
        d.rest = setTimeout(syncKeepOut, 160);
      };
      handle.addEventListener('pointermove', ev => {
        if (!d) return;
        const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0;
        if (!d.on && Math.hypot(dx, dy) < 4) return;
        if (!d.on) {
          d.on = true;
          /* Pin it where it is, by its top-left corner, before carrying it. */
          place(el, d.l0, d.t0);
          el.classList.add('is-dragging', 'is-placed');
          if (id === 'chart') updateDock();
        }
        const W = window.innerWidth, H = window.innerHeight, top = band();
        let l = clamp(d.l0 + dx, 0, W - d.w), t = clamp(d.t0 + dy, top, H - d.h);
        if (Math.abs(l - GAP) < SNAP) l = GAP;
        if (Math.abs(W - d.w - GAP - l) < SNAP) l = W - d.w - GAP;
        if (Math.abs(t - top) < SNAP) t = top;
        if (Math.abs(H - d.h - GAP - t) < SNAP) t = H - d.h - GAP;
        d.l = l; d.t = t;
        if (!d.raf) d.raf = requestAnimationFrame(paint);
      });
      const end = () => {
        if (!d) return;
        const was = d.on, l = d.l, t = d.t;
        if (d.raf) cancelAnimationFrame(d.raf);
        clearTimeout(d.rest);
        d = null;
        el.style.transform = '';
        el.classList.remove('is-dragging');
        if (!was) return;
        place(el, l, t);
        remember(id, el);
        apply(id);
        moved();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('dblclick', ev => {
        if (ev.target.closest('button, input, a, select, label') || !saved[id]) return;
        reset(id);
      });
      apply(id);
    }
    /* A corner grip resizes against the opposite corner, so the pane is
       pinned there first. The docked chart already sits by its bottom-right
       corner; any other anchor takes it out of the dock. */
    function anchor(id, ax, ay) {
      const p = panes[id];
      if (!p || phone() || !p.movable()) return;
      if (!placed(id) && ax === 'r' && ay === 'b') return;
      const r = p.el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
      saved[id] = { ax, ay, dx: Math.round(ax === 'l' ? r.left : W - r.right), dy: Math.round(ay === 't' ? r.top : H - r.bottom) };
      save();
      p.el.classList.add('is-placed');
      clear(p.el);
      p.el.style.left = ax === 'l' ? `${saved[id].dx}px` : 'auto';
      p.el.style.right = ax === 'r' ? `${saved[id].dx}px` : 'auto';
      p.el.style.top = ay === 't' ? `${saved[id].dy}px` : 'auto';
      p.el.style.bottom = ay === 'b' ? `${saved[id].dy}px` : 'auto';
    }
    /* After a resize, keep the pane by its nearest corner again, as a move
       does. */
    function settle(id) {
      if (!placed(id)) return;
      remember(id, panes[id].el);
      apply(id);
      syncKeepOut();
    }
    window.addEventListener('resize', () => { Object.keys(panes).forEach(apply); });
    return {
      bind, apply, anchor, settle,
      placed,
      resetAll() { Object.keys(panes).forEach(id => { delete saved[id]; apply(id); }); save(); chart.render(); moved(); },
    };
  })();
  LAYOUT.bind('chart', els.chart, els.chart.querySelector('.dd-chart__hd'), () => !chart.max);
  LAYOUT.bind('wl', els.wl, els.wl.querySelector('.dd-pane__hd'), () => true);
  LAYOUT.bind('wal', els.wal, els.wal.querySelector('.dd-pane__hd'), () => true);

  /* ---------- the garden ----------
     The welcome's first screen when the server has an entry board (this
     edition has none, so it stays dormant): the board read drawn in the holder map's
     language, one level up. Every token the read looked at is a bubble --
     the board and the near tier lit, the ones let go faint -- sized by
     liquidity, lit ones placed higher the more room they have to the sell
     level, ringed when in the buy zone. The shelves scroll up over it on
     glass; the garden dims and drifts back so the two never compete.

     HOME owns the data and the words: it hands GARDEN plain node
     descriptors and the hooks (where the hero sits, the hover card's HTML,
     what a hover or an open does). GARDEN only draws, settles and reports.
     A canvas under the welcome; the hero spacer in the shelves passes its
     pointer events through to it. */
  const GARDEN = (() => {
    const cv = els.garden, peek = els.gpeek;
    const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const TAU = Math.PI * 2, KMAX = 7;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const ease = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
    let nodes = [], byKey = new Map(), W = 0, H = 0, ctx = null, raf = 0, last = 0, time = 0, frame = 0;
    let on = false, hover = null, pinned = false, focusK = null, mode = 'board', fly = null, follow = null, back = null, camReady = false;
    let A = { top: 80, bottom: 400, edge: 0, dy: 0, a: 1 };
    /* the camera: where the view looks (canvas pixels at rest) and how close */
    const cam = { x: 0, y: 0, k: 1 }, goal = { x: 0, y: 0, k: 1 };
    let hooks = { area: () => A, peekHtml: () => '', onHover: () => {}, open: () => {}, inHero: () => false, onZoom: () => {}, touchEl: () => null };
    let INK = '237,237,236', MONO = 'monospace';
    const ROLE = {};
    const ROLE_WORD = { bundle: 'funded together', sniper: 'early snipers', fresh: 'fresh wallets', insider: 'insiders' };

    function readTheme() {
      const st = getComputedStyle(els.app);
      const m = (st.getPropertyValue('--ink') || '').trim().match(/^#([0-9a-f]{6})$/i);
      if (m) INK = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(',');
      MONO = (st.getPropertyValue('--mono') || 'monospace').trim();
      /* the holder map's own role tints (its documented exception), read from
         the shared tokens: the glyph adds no hue of its own */
      for (const r of Object.keys(ROLE_WORD)) ROLE[r] = [st.getPropertyValue(`--role-${r}`).trim(), st.getPropertyValue(`--rim-${r}`).trim()];
    }
    function rng(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      return () => { h = (h + 0x6D2B79F5) | 0; let t = Math.imul(h ^ h >>> 15, 1 | h); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }
    /* far away: grain, lumpier the more the top ten hold */
    function grainOf(n) {
      const r = rng(n.k), c = clamp((n.top10 == null ? 25 : n.top10) / 100, 0.08, 0.9), pts = [];
      const lumps = c > 0.5 ? 1 : c > 0.3 ? 2 : 3;
      const cs = Array.from({ length: lumps }, () => { const a = r() * TAU, d = 0.25 + r() * 0.3; return [Math.cos(a) * d, Math.sin(a) * d, 0.1 + c * 0.2]; });
      for (let i = 0; i < 26; i++) {
        if (r() < c * 1.05) { const L = cs[Math.floor(r() * lumps)]; pts.push([L[0] + (r() - 0.5) * L[2] * 2, L[1] + (r() - 0.5) * L[2] * 2, 0.6 + r() * 1.6]); }
        else { const a = r() * TAU, d = Math.sqrt(r()) * 0.82; pts.push([Math.cos(a) * d, Math.sin(a) * d, 0.4 + r() * 0.7]); }
      }
      return pts;
    }
    /* up close: the holder glyph from the read's group shares -- one lump per
       role, its dots in proportion to the share, the loose crowd around. A
       glyph of the numbers, never the holder map itself (that opens with the
       token). */
    function glyphOf(n) {
      if (!n.groups || !n.groups.length) return null;
      const r = rng(`${n.k}:g`), lumps = [], loose = [];
      let used = 0;
      n.groups.slice(0, 4).forEach((g, i) => {
        const a = (i / Math.min(4, n.groups.length)) * TAU + r() * 0.8, d = 0.3 + r() * 0.22, share = clamp(+g.share_pct || 0, 0, 100);
        used += share;
        const spread = 0.08 + Math.sqrt(share) / 40, dots = [];
        for (let j = 0, m = clamp(Math.round(share / 2), 3, 22); j < m; j++) dots.push([Math.cos(a) * d + (r() - 0.5) * spread * 2, Math.sin(a) * d + (r() - 0.5) * spread * 2, 0.8 + r() * 1.4]);
        lumps.push({ role: g.role, hub: [Math.cos(a) * d, Math.sin(a) * d], dots });
      });
      for (let j = 0, m = clamp(Math.round((100 - used) / 4), 6, 30); j < m; j++) { const a = r() * TAU, d = Math.sqrt(r()) * 0.84; loose.push([Math.cos(a) * d, Math.sin(a) * d, 0.5 + r() * 0.7]); }
      return { lumps, loose };
    }

    const scale = () => clamp(Math.min(W, H) / 640, 0.62, 1.2);
    /* size is liquidity on a capped log scale, lit on a larger one -- and a
       lit bubble is always drawn at least LIT_OVER the largest faint one, so
       a deep pool let go never looks like a pick (faintMax, set in set()) */
    const LIT_OVER = 1.15;
    const litR = n => 6 + 4.5 * clamp(Math.log10(n.liq || 20000) - 4, 0, 6);
    const faintR = n => 2.5 + 2.2 * clamp(Math.log10(n.liq || 20000) - 4, 0, 6);
    let faintMax = 0;
    const rad = n => scale() * (n.lit ? Math.max(litR(n), faintMax * LIT_OVER) : faintR(n));
    const visible = n => mode === 'all' || n.lit;
    function targetY(n) {
      const span = Math.max(40, A.bottom - A.top);
      if (n.lit) return A.top + 24 + (1 - clamp(((n.up || 0) - 15) / 120, 0, 1)) * (span - 48) * 0.8;
      return A.top + n.ty * span;
    }
    /* world (canvas pixels at rest) <-> screen */
    const sx = x => (x - cam.x) * cam.k + W / 2;
    const sy = y => (y - A.dy - cam.y) * cam.k + H / 2;
    const wx = px => (px - W / 2) / cam.k + cam.x;
    const wy = py => (py - H / 2) / cam.k + cam.y + A.dy;
    function clampGoal() {
      goal.k = clamp(goal.k, 1, KMAX);
      const hw = W / 2 / goal.k, hh = H / 2 / goal.k;
      goal.x = clamp(goal.x, hw, W - hw); goal.y = clamp(goal.y, hh, H - hh);
    }
    function home() { follow = null; goal.k = 1; goal.x = W / 2; goal.y = H / 2; }
    function zoomAt(px, py, k) {
      const x = wx(px), y = wy(py);
      follow = null; goal.k = clamp(k, 1, KMAX);
      goal.x = x - (px - W / 2) / goal.k; goal.y = y - A.dy - (py - H / 2) / goal.k; clampGoal();
    }
    function flyTo(n, k) { follow = n; goal.k = clamp(k, 1, KMAX); goal.x = n.x; goal.y = n.y - A.dy; clampGoal(); }

    function fit() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = cv.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!camReady || w !== W || h !== H) { W = w; H = h; if (!camReady || goal.k === 1) { cam.x = goal.x = W / 2; cam.y = goal.y = H / 2; } camReady = true; }
    }

    /* New nodes from HOME. A token already in the garden keeps its place. */
    function set(list) {
      const next = new Map();
      nodes = list.map(d => {
        const old = byKey.get(d.k);
        const n = Object.assign(old || { x: -1, y: -1, vx: 0, vy: 0, ph: Math.random() * TAU, ty: 0.15 + Math.random() * 0.8, lit01: 0 }, d);
        if (!old || old.top10 !== d.top10) n.grain = n.lit ? grainOf(n) : null;
        if (!old || JSON.stringify(old.groupsSeen) !== JSON.stringify(d.groups)) { n.glyph = n.lit ? glyphOf(n) : null; n.groupsSeen = d.groups; }
        next.set(d.k, n);
        return n;
      });
      byKey = next;
      faintMax = nodes.reduce((m, n) => n.lit ? m : Math.max(m, faintR(n)), 0);
      if (hover && !byKey.has(hover.k)) setHover(null);
      if (follow && !byKey.has(follow.k)) follow = null;
    }
    /* a new node takes its place; one handed in with `rise` surfaces from a
       little under it, so a fresh read arrives as a field settling in */
    function seed() {
      for (const n of nodes) if (n.x < 0) {
        n.x = 40 + Math.random() * Math.max(1, W - 80);
        n.y = targetY(n) + (n.rise ? 40 + Math.random() * 40 : (Math.random() - 0.5) * 30);
        n.rise = false;
      }
    }
    function step(dt) {
      const s = scale(), calm = cam.k > 1.5 ? 0.35 : 1;   // the field holds still while someone looks closely
      /* a bubble with its menu open holds its place, so the buttons do too */
      const held = pinned && hover, hx = held ? hover.x : 0, hy = held ? hover.y : 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.lit01 += ((visible(n) ? 1 : 0) - n.lit01) * Math.min(1, dt * 4);
        n.vy += (targetY(n) - n.y) * 0.5 * dt;
        /* the drift: slow and small, alive without asking to be watched
           (about two thirds of its pace and reach before 0.31.0) */
        n.vx += Math.sin(time * 0.13 + i * 1.7) * 1.5 * dt;
        n.vy += Math.cos(time * 0.11 + i * 2.3) * 0.95 * dt;
        const r = rad(n), pad = n.lit ? 44 : 8;
        if (n.x < r + pad) n.vx += (r + pad - n.x) * 2 * dt;
        if (n.x > W - r - pad) n.vx -= (n.x - (W - r - pad)) * 2 * dt;
        if (!REDUCED) n.ph += dt * 0.9;   // the lit bubbles' breath, a slow one
      }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
        const m = rad(a) + rad(b) + (a.lit || b.lit ? 12 : 3) * s;
        if (d < m) {
          const push = (m - d) / d * 0.5 * Math.min(1, dt * 9);
          const wa = b.lit && !a.lit ? 1.6 : a.lit && !b.lit ? 0.4 : 1;
          a.x -= dx * push * wa; a.y -= dy * push * wa; b.x += dx * push * (2 - wa); b.y += dy * push * (2 - wa);
        }
      }
      for (const n of nodes) {
        n.vx *= 0.93; n.vy *= 0.93; n.x += n.vx * dt * 18 * calm; n.y += n.vy * dt * 18 * calm;
        n.y = clamp(n.y, A.top, A.bottom + 20);
      }
      if (held) { hover.x = hx; hover.y = hy; hover.vx = hover.vy = 0; }
    }
    function miniRange(n, X, Y, a) {
      const rb = n.rb; if (!rb) return;
      const w = 64, x0 = X - w / 2, px = p => x0 + p / 100 * w;
      ctx.fillStyle = `rgba(${INK},${0.1 * a})`; ctx.fillRect(x0, Y, w, 1);
      ctx.fillStyle = `rgba(${INK},${0.3 * a})`; ctx.fillRect(px(rb[0]), Y - 3, Math.max(2, px(rb[1]) - px(rb[0])), 7);
      ctx.setLineDash([2, 2]); ctx.strokeStyle = `rgba(${INK},${0.55 * a})`; ctx.lineWidth = 1;
      ctx.strokeRect(px(rb[2]) + 0.5, Y - 2.5, Math.max(4, px(rb[3]) - px(rb[2]) - 1), 6); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(px(rb[4]), Y + 0.5, 3, 0, TAU);
      if (n.state === 'under') { ctx.strokeStyle = `rgba(${INK},${a})`; ctx.stroke(); } else { ctx.fillStyle = `rgba(${INK},${a})`; ctx.fill(); }
    }
    function drawGlyph(n, X, Y, r, f, a) {
      const g = n.glyph;
      for (const L of g.lumps) {
        const tint = ROLE[L.role] || ROLE.bundle, hx = X + L.hub[0] * r * 0.92, hy = Y + L.hub[1] * r * 0.92;
        ctx.globalAlpha = A.a * a * f * 0.35; ctx.strokeStyle = tint[1]; ctx.lineWidth = 1; ctx.beginPath();
        for (const p of L.dots) { ctx.moveTo(hx, hy); ctx.lineTo(X + p[0] * r * 0.92, Y + p[1] * r * 0.92); }
        ctx.stroke();
        ctx.globalAlpha = A.a * a * f;
        for (const p of L.dots) {
          ctx.beginPath(); ctx.arc(X + p[0] * r * 0.92, Y + p[1] * r * 0.92, 1.2 + p[2] * r * 0.026, 0, TAU);
          ctx.fillStyle = tint[0]; ctx.fill(); ctx.strokeStyle = tint[1]; ctx.stroke();
        }
      }
      ctx.globalAlpha = A.a * a * f * 0.55; ctx.fillStyle = `rgb(${INK})`;
      for (const p of g.loose) { ctx.beginPath(); ctx.arc(X + p[0] * r * 0.92, Y + p[1] * r * 0.92, 0.9 + p[2] * r * 0.014, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = A.a;
    }
    function caption(n, X, Y, r, f) {
      ctx.textAlign = 'center'; ctx.font = `9.5px ${MONO}`; ctx.fillStyle = `rgba(${INK},${0.6 * f})`;
      const t10 = n.top10 != null ? `${n.top10Est ? 'at most ' : ''}${n.top10}%` : '–';
      if (!n.glyph) { ctx.fillText(`top 10 hold ${t10} · its holder map opens on click`, X, Y - r - 16); return; }
      ctx.fillText(`${n.glyph.lumps.length} holder group${n.glyph.lumps.length > 1 ? 's' : ''} · top 10 hold ${t10}`, X, Y - r - 30);
      const words = n.glyph.lumps.map(L => L.role).filter((v, i, s) => s.indexOf(v) === i);
      const widths = words.map(w => ctx.measureText(ROLE_WORD[w] || w).width + 22);
      let lx = X - widths.reduce((a, b) => a + b, 0) / 2;
      ctx.textAlign = 'left';
      words.forEach((w, i) => {
        const tint = ROLE[w] || ROLE.bundle;
        ctx.globalAlpha = A.a * f;
        ctx.beginPath(); ctx.arc(lx + 4, Y - r - 15, 3.5, 0, TAU); ctx.fillStyle = tint[0]; ctx.fill(); ctx.strokeStyle = tint[1]; ctx.stroke();
        ctx.fillStyle = `rgba(${INK},.62)`; ctx.fillText(ROLE_WORD[w] || w, lx + 11, Y - r - 15);
        lx += widths[i];
      });
      ctx.globalAlpha = A.a;
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      if (!nodes.length) return;
      const s = scale(), k = cam.k, fNames = ease(k, 1.5, 2.1), fMap = ease(k, 2.5, 3.6);
      const fade = fly ? 1 - ease(performance.now() - fly.t0, 0, 320) * 0.85 : 1;
      ctx.save();
      ctx.globalAlpha = A.a * fade;
      ctx.textBaseline = 'middle';
      /* the one being looked at: the followed bubble, else the lit one nearest the middle */
      let look = follow && follow.lit ? follow : null;
      if (!look && fMap > 0) { let bd = 1e9; for (const n of nodes) if (n.lit) { const d = Math.hypot(sx(n.x) - W / 2, sy(n.y) - H / 2); if (d < bd) { bd = d; look = n; } } }
      const order = nodes.slice().sort((a, b) => (a.lit - b.lit));
      /* names of the tokens let go: the bigger ones first, and none over
         another -- the rest show as the field comes closer */
      const labels = [], taken = [];
      for (const n of order) {
        const X = sx(n.x), Y = sy(n.y), hot = n === hover || (focusK && focusK === n.k);
        const r = rad(n) * k * (n.lit && !REDUCED ? 1 + 0.025 * Math.sin(n.ph) : 1);
        if (X + r < -80 || X - r > W + 80 || Y + r < -80 || Y - r > H + 80) continue;
        const a = (0.07 + 0.93 * n.lit01) * (focusK && n.lit && focusK !== n.k ? 0.35 : 1);
        if (n.lit) {
          const halo = ctx.createRadialGradient(X, Y, r * 0.6, X, Y, r * 2);
          halo.addColorStop(0, `rgba(${INK},${0.09 * a})`); halo.addColorStop(1, `rgba(${INK},0)`);
          ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(X, Y, r * 2, 0, TAU); ctx.fill();
          if (focusK === n.k) { ctx.beginPath(); ctx.arc(X, Y, r + 13 * s, 0, TAU); ctx.strokeStyle = `rgba(${INK},.55)`; ctx.lineWidth = 1; ctx.stroke(); }
          ctx.beginPath(); ctx.arc(X, Y, r, 0, TAU); ctx.fillStyle = `rgba(${INK},${0.06 * a})`; ctx.fill();
          ctx.strokeStyle = `rgba(${INK},${(hot ? 0.95 : 0.6) * a})`; ctx.lineWidth = 1; ctx.stroke();
          const gf = n.glyph ? fMap : 0;
          if (gf < 1) {
            ctx.fillStyle = `rgba(${INK},${0.8 * a * (1 - gf)})`;
            for (const p of n.grain || []) {
              if (p[0] * p[0] + p[1] * p[1] > 0.9) continue;
              ctx.beginPath(); ctx.arc(X + p[0] * r * 0.92, Y + p[1] * r * 0.92, Math.max(0.6, p[2] * r / 34), 0, TAU); ctx.fill();
            }
          }
          if (gf > 0) drawGlyph(n, X, Y, r, gf, a);
          if (n.state !== 'under') {
            ctx.beginPath(); ctx.arc(X, Y, r + 5 * s, 0, TAU);
            /* solid: in the buy zone · dotted: wait for a dip · long dashes: at support, weaker trend */
            if (n.support) ctx.setLineDash([6, 4]);
            else if (n.state !== 'go') ctx.setLineDash([1.5, 3]);
            ctx.strokeStyle = `rgba(${INK},${0.7 * a})`; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
          }
          if (fNames > 0) taken.push([X - 46, Y + r + 15 * s - 9, X + 46, Y + r + 15 * s + (n.word ? 36 : 22)]);
          ctx.textAlign = 'center'; ctx.font = `600 ${10.5 + 2 * fNames}px ${MONO}`; ctx.fillStyle = `rgba(${INK},${(hot ? 1 : 0.78) * a})`;
          ctx.fillText(`$${n.symbol}${n.up != null ? `  +${Math.round(n.up)}%` : ''}`, X, Y + r + 15 * s);
          if (fNames > 0) {
            miniRange(n, X, Y + r + 15 * s + 15, fNames * a);
            if (n.word) { ctx.font = `9.5px ${MONO}`; ctx.fillStyle = `rgba(${INK},${0.5 * fNames * a})`; ctx.fillText(n.word, X, Y + r + 15 * s + 29); }
          }
          if (fMap > 0 && n === look) caption(n, X, Y, r, fMap * a);
        } else {
          ctx.beginPath(); ctx.arc(X, Y, r, 0, TAU);
          ctx.fillStyle = `rgba(${INK},${(n.stage === 'solid' ? 0.05 : 0.09) * (0.4 + 0.6 * n.lit01) + (hot ? 0.15 : 0)})`; ctx.fill();
          ctx.strokeStyle = `rgba(${INK},${(n.stage === 'clean' ? 0.5 : 0.22) * a + (hot ? 0.5 : 0)})`; ctx.lineWidth = 1; ctx.stroke();
          if (fNames > 0 && r > 5 && (n.lit01 > 0.5 || hot)) labels.push({ t: `$${n.symbol}`, X, Y: Y + r + 10, r: hot ? 1e9 : r });
        }
      }
      if (labels.length) {
        labels.sort((p, q) => q.r - p.r);
        ctx.textAlign = 'center'; ctx.font = `9.5px ${MONO}`; ctx.fillStyle = `rgba(${INK},${0.42 * fNames})`;
        for (const l of labels) {
          const hw = l.t.length * 2.9 + 3, b = [l.X - hw, l.Y - 6, l.X + hw, l.Y + 6];
          if (taken.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
          taken.push(b); ctx.fillText(l.t, l.X, l.Y);
        }
      }
      ctx.restore();
      /* closer in, the field fades out above the foot instead of running under its controls */
      const fe = ease(k, 1, 1.3);
      if (A.edge > 0 && fe > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        const g = ctx.createLinearGradient(0, A.edge - 56, 0, A.edge);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${fe})`);
        ctx.fillStyle = g; ctx.fillRect(0, A.edge - 56, W, 56);
        ctx.fillStyle = `rgba(0,0,0,${fe})`; ctx.fillRect(0, A.edge, W, Math.max(0, H - A.edge));
        ctx.restore();
      }
    }
    let levelShown = -1, taShown = '', hookAt = 0;
    function tick(now) {
      raf = 0;
      if (!on) return;
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now; time += dt;
      A = hooks.area();
      frame++;
      /* behind the sheet the garden is only a glow: a few frames a second */
      const covered = A.a < 0.6 && !fly;
      if (!covered || frame % 6 === 0) {
        fit(); seed();
        step(dt);
        if (follow) { goal.x = follow.x; goal.y = follow.y - A.dy; clampGoal(); }
        const f = REDUCED ? 1 : 1 - Math.exp(-dt * 7);
        cam.x += (goal.x - cam.x) * f; cam.y += (goal.y - cam.y) * f; cam.k += (goal.k - cam.k) * f;
        draw();
        if (hover && A.a < 0.8) setHover(null);
        if (hover) place(hover);
        const level = cam.k >= 3 ? 2 : cam.k >= 1.7 ? 1 : 0;
        if (level !== levelShown) { levelShown = level; hooks.onZoom(cam.k, level); }
        else if (frame % 10 === 0) hooks.onZoom(cam.k, level);
        const te = hooks.touchEl(), ta = goal.k > 1.02 ? 'none' : 'pan-y';
        if (te && ta !== taShown) { taShown = ta; te.style.touchAction = ta; }
        if (now - hookAt > 200) {
          hookAt = now;
          /* test hooks: the first lit and faint bubbles on screen, and the zoom */
          const n = nodes.find(m => m.lit), f = nodes.find(m => !m.lit), b = cv.getBoundingClientRect();
          cv.dataset.lit = n ? `${Math.round(b.left + sx(n.x))},${Math.round(b.top + sy(n.y))}` : '';
          cv.dataset.faint = f ? `${Math.round(b.left + sx(f.x))},${Math.round(b.top + sy(f.y))}` : '';
          cv.dataset.n = String(nodes.length);
          cv.dataset.k = cam.k.toFixed(2);
        }
      }
      if (fly && performance.now() - fly.t0 >= 320) { const n = fly.n; fly = null; hooks.open(n); return; }
      raf = requestAnimationFrame(tick);
    }
    function place(n) {
      const b = cv.getBoundingClientRect(), x = b.left + sx(n.x), y = b.top + sy(n.y), r = rad(n) * cam.k;
      const pw = peek.offsetWidth || 240, ph = peek.offsetHeight || 150;
      let px = x + r + 14;
      if (px + pw > window.innerWidth - 12) px = x - r - 14 - pw;
      peek.style.left = `${clamp(px, 12, window.innerWidth - pw - 12)}px`;
      peek.style.top = `${clamp(y - ph / 2, b.top + 8, window.innerHeight - ph - 12)}px`;
    }
    const local = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    function pick(e) {
      if (!on || !hooks.inHero(e.target)) return null;
      const [x, y] = local(e);
      let best = null, bd = 1e9;
      for (const n of nodes) {
        if (!visible(n) && !n.lit) continue;
        const d = Math.hypot(sx(n.x) - x, sy(n.y) - y) - rad(n) * cam.k, lim = n.lit ? 6 : 3;
        if (d < lim && d < bd) { bd = d; best = n; }
      }
      return best;
    }
    /* the card beside a bubble: on hover it only reads; a click pins it as
       the bubble's menu (scan token · look closer), which follows the bubble
       until a click elsewhere, esc, or a scroll lets it go */
    const closeIn = n => follow === n && goal.k >= 2.9;
    function setHover(n, pin) {
      pin = !!(n && pin);
      if (n === hover && pin === pinned) return;
      hover = n; pinned = pin;
      hooks.onHover(n && n.lit ? n.k : null);
      if (n) { peek.innerHTML = hooks.peekHtml(n, pin, closeIn(n)); peek.hidden = false; }
      else peek.hidden = true;
      peek.classList.toggle('is-menu', pin);
      peek.setAttribute('aria-hidden', pin ? 'false' : 'true');
      if (pin) { const b = peek.querySelector('[data-gact="scan"]'); if (b) b.focus({ preventScroll: true }); }
      const cur = n ? 'pointer' : goal.k > 1.02 ? 'grab' : 'zoom-in';
      cv.style.cursor = cur;
      const te = hooks.touchEl(); if (te) te.style.cursor = cur;
    }
    function open(n) {
      setHover(null);
      back = { x: goal.x, y: goal.y, k: goal.k };
      if (REDUCED) { hooks.open(n); return; }
      fly = { n, t0: performance.now() };
      follow = n; goal.k = clamp(goal.k * 1.6, 1, KMAX);
      if (!raf) raf = requestAnimationFrame(tick);
    }
    /* a click on a bubble opens its menu where the field is (a second click
       on the same bubble scans it), a click on the ground looks closer, drag
       moves, the wheel or a pinch zooms where the pointer is, esc closes the
       menu, then steps back. The stage around the field never scrolls, so
       the wheel is the field's own (0.25.0). */
    const pointers = new Map();
    let drag = null, moved = false, pinch = null;
    addEventListener('pointerdown', e => {
      if (!on || !hooks.inHero(e.target)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }; moved = false; }
      if (pointers.size === 2) { const [p, q] = [...pointers.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, k: goal.k }; moved = true; }
    });
    addEventListener('pointermove', e => {
      if (!on) return;
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size === 2) {
          const [p, q] = [...pointers.values()], b = cv.getBoundingClientRect();
          zoomAt((p.x + q.x) / 2 - b.left, (p.y + q.y) / 2 - b.top, pinch.k * Math.hypot(p.x - q.x, p.y - q.y) / pinch.d);
          return;
        }
        if (drag && goal.k > 1.02) {
          if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) moved = true;
          if (moved) {
            follow = null;
            goal.x -= (e.clientX - drag.x) / cam.k; goal.y -= (e.clientY - drag.y) / cam.k; clampGoal();
            cam.x = goal.x; cam.y = goal.y;
          }
          drag.x = e.clientX; drag.y = e.clientY;
          return;
        }
      }
      if (e.pointerType === 'mouse' && e.buttons === 0 && !pinned) setHover(pick(e));
    }, { passive: true });
    const lift = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) drag = null; };
    addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
    addEventListener('click', e => {
      if (!on || fly || !hooks.inHero(e.target)) return;
      if (moved) { moved = false; return; }
      const n = pick(e), [x, y] = local(e);
      if (!n) { const was = pinned; setHover(null); if (!was && goal.k < KMAX) zoomAt(x, y, goal.k * 2); return; }
      if (pinned && hover === n) { open(n); return; }
      setHover(n, true);
    });
    peek.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-gact]');
      if (!b || !on || fly || !pinned || !hover) return;
      const n = hover;
      if (b.dataset.gact === 'scan') { open(n); return; }
      flyTo(n, Math.max(goal.k, n.lit ? 3.6 : 2.6));
      peek.innerHTML = hooks.peekHtml(n, true, true);
      const s = peek.querySelector('[data-gact="scan"]'); if (s) s.focus({ preventScroll: true });
    });
    addEventListener('wheel', e => {
      if (!on || fly || !hooks.inHero(e.target)) return;
      e.preventDefault();
      /* a trackpad pinch arrives as ctrl + small deltas; a mouse notch is
         about 100 px (or 3 lines), about 1.25x a notch */
      const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const [x, y] = local(e); zoomAt(x, y, goal.k * Math.exp(-d * (e.ctrlKey ? 0.012 : 0.0022)));
    }, { passive: false });
    addEventListener('keydown', e => {
      if (!on || e.key !== 'Escape') return;
      if (pinned) { setHover(null); return; }
      if (goal.k > 1) { home(); setHover(null); }
    });

    return {
      hooks(h) { hooks = Object.assign(hooks, h); },
      set,
      show(v) {
        v = !!v;
        if (v === on) return;
        on = v; cv.hidden = !v;
        if (v) {
          readTheme(); last = 0;
          /* back from a token: the view it was opened from, one step out */
          if (back) { cam.x = goal.x = back.x; cam.y = goal.y = back.y; cam.k = goal.k = back.k; follow = null; back = null; }
          if (!raf) raf = requestAnimationFrame(tick);
        } else { setHover(null); fly = null; if (raf) cancelAnimationFrame(raf); raf = 0; }
      },
      setMode(m) { mode = m === 'all' ? 'all' : 'board'; setHover(null); },
      get mode() { return mode; },
      focus(k) { focusK = k || null; },
      zoom(cmd) {
        if (cmd === 'fit') { home(); return; }
        zoomAt(W / 2, Math.max(H * 0.3, (A.top + A.bottom) / 2 - A.dy), goal.k * (cmd === 'in' ? 1.8 : 1 / 1.8));
      },
      get on() { return on; },
    };
  })();

  /* ---------- the welcome ----------
     What the field shows before a token: not "paste a token" on an empty
     page, but the trader's own desk. A greeting with the state of their book
     in one line, then three shelves, each a row of glass cards that opens a
     token in one click:
       1. pick up where you left off -- the tokens opened last in this
          browser (dido-recent:v1, nothing leaves the browser);
       2. your watchlist -- the WATCH module's own list, verdict and prices,
          the actionable ones first; nothing re-derived here;
       3. mapped here -- the tokens this server mapped most in the last
          24 h (GET /api/most-scanned, counts only, priced from Blockscout
          when first mapped), with the move since.
     Live prices for shelves 1 and 3 come from one batched DexScreener read
     per 30 tokens, every 60 s while the welcome is on screen and the tab
     visible. A shelf that cannot be read says so; it never reads as empty.
     The same recents fill the search's rows when it opens empty over a
     token, so the way back is one keystroke (/) away. */
  const HOME = (() => {
    const KEY = 'dido-recent:v1', CAP = 12, SHOW = 8, QUOTE_TTL = 60000, TREND_TTL = 120000, BOARD_TTL = 600000;
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
    let recent = read();
    if (!recent || recent.v !== 1 || !Array.isArray(recent.items)) recent = { v: 1, items: [] };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(recent)); } catch (e) { /* private mode: this session only */ } };
    const keyOf = WATCH.keyOf;
    const chainOf = c => normChain(c) || String(c || '').toLowerCase();
    const sym = v => String(v || '').replace(/^\$+/, '');

    let shown = false, timer = null, enterT = null;
    /* market reads, keyed chain:address -- { px, h24, mcap, img, ts } */
    const quotes = new Map();
    /* the groups' board: status 'idle' | 'loading' | 'ok' | 'err' */
    const trend = { status: 'idle', tokens: [], ts: 0 };
    /* The entry board (GET /api/board): tokens the engine reads at their
       entry with room to the sell level. This edition's server has none and
       answers 'feature_disabled', so status is 'off' and the shelf is simply
       not there. 'err' is a server that did not answer, and says so. */
    const board = { status: 'idle', doc: null, ts: 0 };

    /* The chain filter: which chains the discovery (the board, running hot,
       the groups' calls, the garden) shows. Kept as the chains hidden, so a
       chain added later shows until someone hides it, and the last chain
       shown cannot be hidden: an empty page says nothing. The viewer's own
       shelves (watchlist, recent) are theirs and are never filtered. */
    const CHAINS_KEY = 'dido-home-chains:v1';
    const CHAIN_LIST = [...new Set([...SUPPORTED].map(c => chainOf(c)))];
    const EVM = CHAIN_LIST.filter(c => !NON_EVM.has(c));
    let hidden = new Set((() => { try { const v = JSON.parse(localStorage.getItem(CHAINS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } })()
      .filter(c => CHAIN_LIST.includes(c)));
    if (hidden.size >= CHAIN_LIST.length) hidden = new Set();
    /* The size filter (decided 2026-10-12): the board marks every row
       "established" or "small" by its main pool's liquidity. Both show by default, on every visit -- it is a quick
       look, not a setting -- and the last size shown cannot be hidden. A row
       without a size (an older read, the groups' calls) always shows. */
    const SIZES = ['established', 'small'];
    let sizesOff = new Set();
    const sizeShows = t => !t.size || !sizesOff.has(t.size);
    const shows = t => !hidden.has(chainOf(t.chain)) && sizeShows(t);
    function toggleSize(s) {
      const next = new Set(sizesOff);
      if (next.has(s)) next.delete(s); else next.add(s);
      if (next.size >= SIZES.length) return;
      sizesOff = next;
      render();
    }
    function setHidden(next) {
      if (next.size >= CHAIN_LIST.length) return;
      hidden = next;
      try { localStorage.setItem(CHAINS_KEY, JSON.stringify([...hidden])); } catch (e) { /* private mode: this visit only */ }
      render();
      refresh();
    }

    function remember(info, pair) {
      if (!info || !info.address) return;
      const k = keyOf(info.chain, info.address);
      const prev = recent.items.find(it => keyOf(it.chain, it.address) === k);
      recent.items = recent.items.filter(it => it !== prev);
      recent.items.unshift({
        chain: chainOf(info.chain), address: info.address, symbol: sym(info.symbol), name: info.name || '',
        img: info.image_url || (prev && prev.img) || null, ts: Date.now(),
      });
      recent.items.length = Math.min(recent.items.length, CAP);
      save();
      const chg = (pair && pair.priceChange) || {};
      quotes.set(k, { px: +info.price_usd || null, h24: chg.h24 == null ? null : +chg.h24,
        mcap: info.market_cap || info.fdv || null, img: info.image_url || null, ts: Date.now() });
    }
    function forget(k) {
      recent.items = recent.items.filter(it => keyOf(it.chain, it.address) !== k);
      save(); render();
    }

    /* ── reads ── */
    /* How busy a pool is against its usual hour, from the pair answer alone:
       the geometric mean of the volume and trade-count velocities, each
       capped at 5 (1 is an ordinary hour). */
    const trades = w => (+((w || {}).buys) || 0) + (+((w || {}).sells) || 0);
    const velocity = (h1, h6, h24) => h1 / Math.max(h6 > h1 ? (h6 - h1) / 5 : h24 / 24, 1);
    function heatOf(p) {
      const v = p.volume || {}, t = p.txns || {};
      const vx = velocity(+v.h1 || 0, +v.h6 || 0, +v.h24 || 0);
      const tx = velocity(trades(t.h1), trades(t.h6), trades(t.h24));
      return Math.round(Math.sqrt(Math.min(vx, 5) * Math.min(tx, 5)) * 100) / 100;
    }
    async function readQuotes(list) {
      const due = list.filter(t => { const q = quotes.get(keyOf(t.chain, t.address)); return !q || Date.now() - q.ts > QUOTE_TTL - 5000; });
      for (let i = 0; i < due.length; i += 30) {
        const chunk = due.slice(i, i + 30);
        const addrs = [...new Set(chunk.map(t => t.address))];
        let pairs;
        try { pairs = (await getJson(`${DEXSCREENER}/tokens/${addrs.map(encodeURIComponent).join(',')}`)).pairs || []; } catch (e) { continue; }
        chunk.forEach(t => {
          const mine = pairs.filter(p => chainOf(p.chainId) === chainOf(t.chain) && pricesToken(p, t.address))
            .sort((a, b) => +((b.liquidity || {}).usd || 0) - +((a.liquidity || {}).usd || 0));
          const p = mine[0];
          /* no pool answered: keep what we had, stamped, so it is not asked again every beat */
          const old = quotes.get(keyOf(t.chain, t.address)) || {};
          if (!p) { quotes.set(keyOf(t.chain, t.address), Object.assign({}, old, { ts: Date.now() })); return; }
          const chg = p.priceChange || {}, h1 = (p.txns || {}).h1 || {};
          quotes.set(keyOf(t.chain, t.address), {
            px: +p.priceUsd > 0 ? +p.priceUsd : null, h24: chg.h24 == null ? null : +chg.h24,
            mcap: +(p.marketCap || p.fdv || 0) || null, img: ((p.info || {}).imageUrl) || old.img || null, ts: Date.now(),
            heat: heatOf(p), h1: chg.h1 == null ? null : +chg.h1, buys: +h1.buys || 0, sells: +h1.sells || 0,
          });
        });
      }
    }
    let trendBusy = false;
    async function readTrend() {
      if (trendBusy || (trend.status === 'ok' && Date.now() - trend.ts < TREND_TTL)) return;
      trendBusy = true;
      if (trend.status === 'idle') { trend.status = 'loading'; if (shown) render(); }
      await configReady;
      try {
        const j = await fetchJsonTimeout(`${CONFIG.api}/api/most-scanned`, 8000);
        if (!j || j.ok !== true || !j.data || !Array.isArray(j.data.tokens)) throw new Error('bad answer');
        trend.tokens = j.data.tokens.filter(t => t && t.address && SUPPORTED.has(chainOf(t.chain)));
        trend.status = 'ok'; trend.ts = Date.now();
      } catch (e) {
        /* a board we read before stays up; a first read that failed says so */
        if (trend.status !== 'ok') trend.status = 'err';
      }
      trendBusy = false;
    }
    let boardBusy = false;
    async function readBoard() {
      if (boardBusy || ((board.status === 'ok' || board.status === 'off') && Date.now() - board.ts < BOARD_TTL)) return;
      boardBusy = true;
      if (board.status === 'idle') { board.status = 'loading'; if (shown) render(); }
      await configReady;
      try {
        const j = await fetchJsonTimeout(`${CONFIG.api}/api/board`, 8000);
        if (j && j.ok === true && j.data && Array.isArray(j.data.board)) {
          const keep = r => r && r.address && SUPPORTED.has(chainOf(r.chain)) && Array.isArray(r.entry) && Array.isArray(r.target);
          const hotKeep = r => r && r.address && SUPPORTED.has(chainOf(r.chain)) && isFinite(+r.heat);
          board.doc = Object.assign({}, j.data, { board: j.data.board.filter(keep), near: (j.data.near || []).filter(keep),
            support: (Array.isArray(j.data.support) ? j.data.support : []).filter(keep),
            hot: (Array.isArray(j.data.hot) ? j.data.hot : []).filter(hotKeep) });
          board.status = 'ok';
        } else if (j && (j.error === 'feature_disabled' || j.error === 'unavailable')) {
          board.status = board.doc ? 'ok' : 'off';
        } else throw new Error('bad answer');
        board.ts = Date.now();
      } catch (e) {
        /* a board we read before stays up; a first read that failed says so */
        if (board.status !== 'ok') board.status = 'err';
      }
      boardBusy = false;
    }
    /* the board's rows on the chains shown (allRows: on every chain) */
    const pick = (list, f) => f ? list.filter(f) : list;
    const allRows = f => board.doc ? pick(board.doc.board.concat(board.doc.near), f).slice(0, SHOW * 2).concat(pick(board.doc.support, f).slice(0, SHOW)) : [];
    const boardRows = () => allRows(shows);
    /* A board row as a watchlist item, so its live state is WATCH.signal's own
       verdict -- the same words and the same rule as a token the viewer
       watches, never a second copy of it. */
    const boardHorizon = r => r.lane === 'day' ? 'st' : 'lt';
    function boardSignal(r) {
      const q = quotes.get(keyOf(r.chain, r.address)) || {};
      const h = boardHorizon(r);
      /* "at support": the board's third tier, score 45-54. The
         watchlist's rule would call it "not a buy" on the score alone; here
         the same rule reads where price sits, and the words say what is
         different about it: the score, and that the trend is weaker. */
      const sig = WATCH.signal({ px: q.px != null ? q.px : null,
        last: { score: r.support ? 55 : r.score, price: r.price_at_read, [h]: { lo: r.entry[0], hi: r.entry[1], tp: r.target[0] } } }, h);
      if (!r.support) return sig;
      const weak = `score ${r.score} · weaker trend`;
      if (sig.k === 'go') return Object.assign({}, sig, { word: 'at support', why: weak });
      if (sig.k === 'wait' && sig.word === 'wait for a dip') return Object.assign({}, sig, { word: 'near support', why: `${sig.why} · score ${r.score}` });
      return sig;
    }
    const trendRows = () => trend.tokens.filter(shows);
    async function refresh() {
      const tasks = [readTrend().then(() => readQuotes(trendRows().slice(0, SHOW))), readQuotes(recent.items.slice(0, SHOW).concat(WATCH.items.slice(0, SHOW))),
        readBoard().then(() => readQuotes(boardRows().concat(board.doc ? board.doc.hot.filter(shows) : [])))];
      if (WATCH.items.length) tasks.push(WATCH.refresh());
      await Promise.all(tasks.map(t => t.catch(() => {})));
      if (shown) render();
    }

    /* ── the cards ── */
    const pctTxt = v => (v == null || !isFinite(v)) ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v)).toLocaleString('en-US')}%`;
    const dirOf = v => v == null || !isFinite(v) || v === 0 ? '' : v > 0 ? 'up' : 'dn';
    /* the token's logo, or its ticker's initial on a plain disc while there is none */
    function logo(img, symbol) {
      const ini = esc((sym(symbol) || '?').slice(0, 1).toUpperCase());
      return img && IMG_OK.test(img) ? `<i class="dd-hc__logo" data-logo="${esc(img)}" aria-hidden="true"><b>${ini}</b></i>` : `<i class="dd-hc__logo" aria-hidden="true"><b>${ini}</b></i>`;
    }
    function card(t, o) {
      const k = keyOf(t.chain, t.address);
      const q = quotes.get(k) || {};
      const px = o.px != null ? o.px : q.px;
      const h24 = o.h24 !== undefined ? o.h24 : q.h24;
      const img = q.img || t.img;
      const here = current && keyOf(current.chain, current.address) === k;
      return `<article class="dd-hc${o.cls ? ` ${o.cls}` : ''}${here ? ' is-here' : ''}" tabindex="0" role="button" data-k="${esc(k)}" data-c="${esc(chainOf(t.chain))}" data-a="${esc(t.address)}" aria-label="open $${esc(t.symbol || '')}${o.aria ? `, ${esc(o.aria)}` : ''}">
        <span class="dd-hc__hd">${logo(img, t.symbol)}<span class="dd-hc__id"><b class="dd-hc__sym">$${esc(t.symbol || '?')}</b><span class="dd-hc__nm">${esc(t.name && t.name !== t.symbol ? t.name : DD.chainTag(chainOf(t.chain)))}</span></span>${o.corner || `<span class="dd-hc__ch mono">${esc(DD.chainTag(chainOf(t.chain)))}</span>`}</span>
        <span class="dd-hc__px num">${px ? esc(DD.fmtPrice(px)) : '<span class="dd-hc__na">no price</span>'}${h24 != null && isFinite(h24) ? `<span class="dd-ch${dirOf(h24) ? ` dd-ch--${dirOf(h24)}` : ''}">${esc(pctTxt(h24))}<i> 24h</i></span>` : ''}</span>
        ${o.body || ''}
        <span class="dd-hc__ft mono">${o.foot || ''}</span>
        ${o.x ? `<button type="button" class="dd-hc__x" data-x aria-label="${esc(o.x)}">✕</button>` : ''}
      </article>`;
    }
    function shelf(id, title, note, action, inner) {
      return `<section class="dd-shelf" data-shelf="${id}">
        <header class="dd-shelf__hd"><h2>${title}</h2>${note ? `<span class="dd-shelf__n mono">${note}</span>` : ''}${action || ''}</header>
        <div class="dd-shelf__row">${inner}</div>
      </section>`;
    }
    const noteCard = (html, cls) => `<p class="dd-shelf__note${cls ? ` ${cls}` : ''}">${html}</p>`;

    const clock = s => s ? new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '–';
    /* Entry band, price and sell level on one line, on a log scale. The
       positions travel as data and become CSS variables after render (the
       CSP drops inline style attributes). */
    function rbOf(r) {
      const q = quotes.get(keyOf(r.chain, r.address)) || {};
      const px = q.px || r.price_at_read;
      const lo = Math.log(r.entry[0] * 0.96), hi = Math.log((r.target[1] || r.target[0]) * 1.01);
      const at = v => (v > 0 && hi > lo) ? Math.max(0, Math.min(100, (Math.log(v) - lo) / (hi - lo) * 100)) : 0;
      return [at(r.entry[0]), at(r.entry[1]), at(r.target[0]), at(r.target[1] || r.target[0]), at(px)];
    }
    function rangeLine(r, sig) {
      const v = rbOf(r).map(x => x.toFixed(1)).join(',');
      return `<span class="dd-rbar${sig.k === 'under' ? ' is-out' : ''}" data-rb="${v}" aria-hidden="true"><i class="dd-rbar__e"></i><i class="dd-rbar__t"></i><i class="dd-rbar__p"></i></span>`;
    }
    function boardCard(r) {
      const sig = boardSignal(r), q = quotes.get(keyOf(r.chain, r.address)) || {};
      return card(r, {
        /* priced live when DexScreener answers, else at the board's own read */
        px: q.px || r.price_at_read || null,
        aria: sig.word,
        corner: r.score != null ? `<span class="dd-hc__score num" title="score at the read">${esc(String(r.score))}</span>` : '',
        body: `<span class="dd-hc__sig is-${sig.k}"><i></i><b>${esc(sig.word)}</b>${sig.why ? `<span>${esc(sig.why)}</span>` : ''}</span>${rangeLine(r, sig)}`,
        foot: `${esc(DD.chainTag(chainOf(r.chain)))} · ${r.lane === 'day' ? 'a day' : 'weeks'} · read ${esc(clock(board.doc.read_at))}`,
      });
    }
    /* ── the garden over the shelves (dormant without an entry board) ── */
    /* the stage's view (field | cards), remembered per device; the
       pop-overs over its pill; whether the bubbles have risen into a fresh
       field yet (they rise once per arrival, never on a refresh) */
    const VIEW_KEY = 'dido-home-view:v1';
    let gmode = null, risen = false, pop = null;
    const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'field'; } catch (e) { return 'field'; } })();
    /* on every chain: hiding a chain empties the field, it does not take it away */
    const gardenOn = () => board.status === 'ok' && !!board.doc && (allRows().length + (board.doc.let_go || []).length) > 0;
    const letGo = () => (board.doc.let_go || []).filter(g => g && g.address && SUPPORTED.has(chainOf(g.chain)) && shows(g));
    const usd = v => v == null ? '–' : DD.fmtLarge(v);
    /* why a token was let go, from the read's closed reason set and what it measured */
    function reasonText(g) {
      const m = g.measured || {}, lane = m.day || m.weeks || {};
      switch (g.reason) {
        case 'thin_liquidity': return `liquidity ${usd(g.liq)}`;
        case 'too_young': return m.age_d != null ? `${m.age_d} days old` : 'too young';
        case 'low_volume': return m.vol_24h != null ? `24 h volume ${usd(m.vol_24h)}` : 'too little volume';
        case 'thin_vs_mcap': return m.liq_mcap_pct != null ? `liquidity is ${m.liq_mcap_pct}% of market cap` : 'liquidity thin against market cap';
        case 'one_sided': return 'one-sided trading in the last hour';
        case 'one_way': return m.sells_1h != null ? `${m.buys_1h} buys, ${m.sells_1h} sell${m.sells_1h === 1 ? '' : 's'} in the last hour` : 'almost no sells in the last hour';
        case 'thin_exit': return m.vol_liq != null ? `a day's volume ${Math.round(m.vol_liq)}× its pool` : 'more traded than the pool can take';
        case 'few_trades': return m.trades_24h != null ? `only ${m.trades_24h} trades in 24 h` : 'too few trades';
        case 'no_pair': return 'no pool to price it';
        case 'no_info': return 'no token info or logo on its pool yet';
        case 'no_data': return 'no chart to read';
        case 'not_read': return 'not read this round';
        case 'no_setup': return 'no entry setup on the chart';
        case 'above_zone': return lane.above_pct != null ? `${lane.above_pct}% above its entry zone` : 'far above its entry zone';
        case 'under_zone': return 'under its entry zone';
        case 'small_room': return lane.upside_pct != null ? `only +${lane.upside_pct}% to the sell level` : 'too little room to the sell level';
        case 'low_score': return m.score != null ? `score ${m.score}` : 'score too low';
        case 'unchecked': return m.top10_pct == null ? 'holders could not be checked' : 'its safety could not be confirmed';
        case 'honeypot': return 'honeypot';
        case 'mint_open': return 'mint still open';
        case 'freeze_open': return 'freeze still open';
        case 'tax_high': return m.tax_pct != null ? `tax ${m.tax_pct}%` : 'tax too high';
        case 'concentrated': return m.top10_pct != null ? `ten wallets hold ${m.top10_est ? 'up to ' : ''}${m.top10_pct}%` : 'too concentrated';
        default: return g.reason || 'let go';
      }
    }
    const STEP_WORD = { solid: 'solid', entry: 'at entry', clean: 'clean holders' };
    /* everything read by default: the picks are lit among the rest, and a
       board of one or two alone made a near-empty field */
    const gardenMode = () => gmode || 'all';
    function feedGarden() {
      if (!gardenOn()) { GARDEN.set([]); return; }
      /* the first time the read lands, every bubble fades in and surfaces
         into its place (GARDEN keeps the ones it has after that) */
      const rise = !risen && viewNow() === 'field';
      const from = n => rise && !REDUCED_MOTION ? Object.assign(n, { x: -1, y: -1, rise: true, lit01: 0 }) : n;
      if (rise) risen = true;
      const lit = boardRows().map(r => {
        const sig = boardSignal(r);
        return { k: keyOf(r.chain, r.address), chain: chainOf(r.chain), address: r.address, symbol: r.symbol || '?', lit: true,
          liq: r.liq, up: r.upside_pct, top10: r.top10_pct, top10Est: !!r.top10_est, support: !!r.support, state: sig.k, word: sig.word, rb: rbOf(r), groups: r.groups || null, row: r };
      });
      const seen = new Set(lit.map(n => n.k));
      const faint = letGo().filter(g => !seen.has(keyOf(g.chain, g.address)))
        .map(g => ({ k: keyOf(g.chain, g.address), chain: chainOf(g.chain), address: g.address, symbol: g.symbol || '?', lit: false,
          liq: g.liq, stage: g.stage, g }));
      GARDEN.set(lit.concat(faint).map(from));
      GARDEN.setMode(gardenMode());
    }
    /* menu: the card was pinned by a click and carries its buttons; close:
       the field is already in on this bubble, so "look closer" is spent */
    function gardenPeek(n, menu, close) {
      const acts = menu
        ? `<span class="dd-gpeek__acts"><button type="button" class="dd-chip on" data-gact="scan">scan token</button>${close ? '' : '<button type="button" class="dd-chip" data-gact="closer">look closer</button>'}</span>`
        : `<span class="dd-gpeek__hint mono">click for scan · look closer</span>`;
      if (n.lit) {
        const r = n.row, sig = boardSignal(r);
        return `<b class="dd-gpeek__sym">$${esc(n.symbol)}</b><span class="dd-gpeek__sub mono">${esc(r.name || '')} · ${esc(DD.chainTag(n.chain))} · ${r.lane === 'day' ? 'a day' : 'weeks'}</span>
          <span class="dd-hc__sig is-${sig.k}"><i></i><b>${esc(sig.word)}</b>${sig.why ? `<span>${esc(sig.why)}</span>` : ''}</span>
          <span class="dd-gpeek__row mono">score ${esc(String(r.score))} · liquidity ${esc(usd(r.liq))}${r.top10_pct != null ? ` · top 10 hold ${r.top10_est ? 'at most ' : ''}${esc(String(r.top10_pct))}%` : ''}</span>
          ${acts}`;
      }
      return `<b class="dd-gpeek__sym">$${esc(n.symbol)}</b><span class="dd-gpeek__sub mono">${esc(DD.chainTag(n.chain))}${n.g.liq ? ` · liquidity ${esc(usd(n.g.liq))}` : ''}</span>
        <span class="dd-gpeek__why">read this round, let go at <b>${esc(STEP_WORD[n.g.stage] || n.g.stage)}</b>: ${esc(reasonText(n.g))}.</span>
        ${acts}`;
    }
    /* ── the stage ── */
    const LEGEND = 'size · liquidity &nbsp; height · room to sell level &nbsp; ring · in the buy zone &nbsp; dashed · at support';
    /* the field has something to draw, will have, or never will this visit */
    const fieldState = () => gardenOn() ? 'ok' : (board.status === 'idle' || board.status === 'loading') ? 'wait' : board.status === 'err' ? 'err' : 'none';
    const viewNow = () => fieldState() === 'none' ? 'cards' : view;
    GARDEN.hooks({
      /* the bubbles keep clear of the stage's rim and of the pill at its foot */
      area: () => { const h = els.garden.clientHeight || 300; return { top: 26, bottom: Math.max(60, h - 84), edge: 0, dy: 0, a: 1 }; },
      peekHtml: gardenPeek,
      inHero: t => t === els.garden,
      touchEl: () => els.garden,
      onZoom: (k, level) => {
        els.homeZoom.hidden = k < 1.03;
        els.homeZoom.textContent = ['the field', 'names and ranges', 'holder shapes'][level] || 'the field';
      },
      onHover: k => els.homeShelves.querySelectorAll('.dd-hc[data-k]').forEach(c => c.classList.toggle('is-twin', !!k && c.dataset.k === k)),
      open: n => goToken(n.chain, n.address),
    });
    /* The wait over an empty field is the holder map's loader: its mark fills
       from the feet while the board is read, easing toward a ceiling (the
       holderLoader rule: never 99, never early) and reaching 100 only when
       the read is in hand. On a failure it empties to the ghost, with the note. */
    const fill = { shown: 0, timer: 0, drawn: false };
    function paintFill() {
      els.homeWaitPct.firstChild.textContent = String(Math.round(fill.shown));
      els.homeWaitRect.setAttribute('y', String(512 - (512 * fill.shown) / 100));
    }
    function syncFill(fs) {
      /* HM_MARK_D is the holder block's, defined below this module: read at render, not here */
      if (!fill.drawn) { fill.drawn = true; els.homeWait.querySelectorAll('[data-mark]').forEach(p => p.setAttribute('d', HM_MARK_D)); }
      els.homeWait.classList.toggle('is-err', fs === 'err');
      if (fs === 'wait') {
        if (!fill.timer) fill.timer = setInterval(() => { fill.shown += (92 - fill.shown) * 0.02; paintFill(); }, 90);
        return;
      }
      clearInterval(fill.timer); fill.timer = 0;
      if (fs === 'ok' || fs === 'err') { fill.shown = fs === 'ok' ? 100 : 0; paintFill(); }
    }
    let flyT = 0;
    function setView(v) {
      view = v === 'cards' ? 'cards' : 'field';
      try { localStorage.setItem(VIEW_KEY, view); } catch (e) { /* private mode: this visit only */ }
      /* the cards fly in when the viewer asks for them, never on a refresh */
      els.homeStage.classList.toggle('is-fly', view === 'cards');
      clearTimeout(flyT);
      flyT = setTimeout(() => els.homeStage.classList.remove('is-fly'), 1200);
      setPop(null);
      render();
    }
    function setPop(p) {
      pop = p;
      els.homeFilters.hidden = pop !== 'filters';
      els.homeKey.hidden = pop !== 'key';
      els.homeFiltersBtn.setAttribute('aria-expanded', String(pop === 'filters'));
      els.homePill.querySelector('[data-key]').setAttribute('aria-expanded', String(pop === 'key'));
      if (pop === 'filters') els.homeFilters.innerHTML = filtersHtml();
    }
    function filtersHtml() {
      const nb = boardRows().length, nall = nb + (board.doc ? letGo().length : 0), mode = gardenMode();
      return `<div class="dd-hero__modes" role="group" aria-label="show">
          <button type="button" class="dd-chip" data-gmode="all" aria-pressed="${mode === 'all'}">everything we read <span class="num">${nall}</span></button>
          <button type="button" class="dd-chip" data-gmode="board" aria-pressed="${mode === 'board'}">the board <span class="num">${nb}</span></button>
        </div>${sizeBar()}${chainBar()}`;
    }
    function keyHtml() {
      const d = board.doc;
      return `<span>${LEGEND}</span><span>scroll to zoom · drag to move · click a token to scan it · esc steps back</span>
        ${d ? `<span>read ${esc(clock(d.read_at))} · next ${esc(clock(d.next_at))} · no paid spots</span>` : ''}`;
    }
    addEventListener('resize', () => { if (pop === 'filters') els.homeFilters.innerHTML = filtersHtml(); });

    function boardShelves() {
      const title = 'at their entry';
      if (board.status === 'off' || board.status === 'idle') return '';
      if (board.status === 'loading') return shelf('board', title, '', '', [0, 1, 2, 3].map(() => '<span class="dd-hc dd-hc--ghost" aria-hidden="true"></span>').join(''));
      if (board.status === 'err') return shelf('board', title, '', '', noteCard('the entry board is not answering right now. it comes back on its own.', 'is-err'));
      const d = board.doc, note = `read ${esc(clock(d.read_at))} · next ${esc(clock(d.next_at))} · no paid spots`;
      /* An empty board shows the work instead of vanishing: how many tokens
         were checked and how many looked solid. The bar never drops to fill
         the row; an empty board is the engine's honest answer. */
      const rows = { board: d.board.filter(shows), near: d.near.filter(shows), support: d.support.filter(shows) };
      if ((d.board.length || d.near.length || d.support.length) && !boardRows().length) {
        return shelf('board', title, note, '', noteCard(sizesOff.size ? 'nothing at its entry in what you show. the rest of the board is behind your chain or size filter.' : 'nothing at its entry on the chains you show. the rest of the board is on chains you hide.'));
      }
      if (!d.board.length && !d.near.length && !d.support.length) {
        const c = d.counts || {};
        const work = [c.read != null ? `checked ${c.read} tokens` : '', c.solid != null ? `${c.solid} solid` : '', `next read ${clock(d.next_at)}`].filter(Boolean).join(' · ');
        return shelf('board', title, note, '', `<div class="dd-board-empty"><b>nothing is at its entry right now.</b><span class="mono">${esc(work)}</span></div>`);
      }
      return (rows.board.length ? shelf('board', title, note, '', rows.board.slice(0, SHOW).map(boardCard).join('')) : '')
        + (rows.near.length ? shelf('near', 'near their entry', rows.board.length ? 'a little over the zone' : note, '', rows.near.slice(0, SHOW).map(boardCard).join('')) : '')
        + (rows.support.length ? shelf('support', 'at support', rows.board.length || rows.near.length ? 'wide room, weaker trend' : note, '', rows.support.slice(0, SHOW).map(boardCard).join('')) : '');
    }

    /* Running hot: the round's solid tokens the board did not show, by how
       busy they are against their usual hour -- live from the same quote read
       when DexScreener answers, else as at the board's read. Flow, never a
       call: no score, no zone. Only what trades above an ordinary hour. */
    const HOT_MIN = 1.2;
    function hotRows() {
      if (board.status !== 'ok' || !board.doc) return [];
      return board.doc.hot.filter(shows).map(r => {
        const q = quotes.get(keyOf(r.chain, r.address)) || {};
        const live = q.heat != null;
        return { r, q, heat: live ? q.heat : +r.heat, h1: live ? q.h1 : r.chg_1h,
          buys: live ? q.buys : r.buys_1h, sells: live ? q.sells : r.sells_1h };
      }).filter(x => x.heat >= HOT_MIN).sort((a, b) => b.heat - a.heat);
    }
    const xTxt = v => `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`;

    /* ── the strips: trending over the stage, the viewer's own under it ──
       One design for all three: a label, then a row of glass capsules, each
       with the token's logo, ticker, why it is here, its price and its move.
       A mouse wheel over a row runs it sideways. Trending is DexScreener's
       place for it, at the top: what runs hot against its usual hour, then
       what this server mapped most in 24 h. */
    const ORDER = { go: 0, wait: 1, under: 2, none: 3 };
    function cap(t, o) {
      const k = keyOf(t.chain, t.address), q = quotes.get(k) || {};
      const px = o.px != null ? o.px : q.px, img = q.img || t.img, chg = o.chg !== undefined ? o.chg : q.h24;
      /* slim (the trending ticker): logo, ticker and the one move that matters;
         the why (heat, groups, price) goes to the tooltip and the label */
      if (o.slim) {
        const hasChg = chg != null && isFinite(chg);
        return `<article class="dd-yc dd-yc--slim${o.cls ? ` ${o.cls}` : ''}" tabindex="0" role="button" data-k="${esc(k)}" data-c="${esc(chainOf(t.chain))}" data-a="${esc(t.address)}" title="${esc([o.sub, px ? DD.fmtPrice(px) : '', hasChg ? `${pctTxt(chg) || '0.0%'} ${o.chgLabel || '24h'}` : ''].filter(Boolean).join(' · '))}" aria-label="open $${esc(sym(t.symbol))}, ${esc(o.aria)}">
          ${logo(img, t.symbol)}<b class="dd-yc__t">$${esc(sym(t.symbol) || '?')}</b>${hasChg ? `<span class="dd-ch num${dirOf(chg) ? ` dd-ch--${dirOf(chg)}` : ''}">${esc(pctTxt(chg) || '0.0%')}</span>` : ''}
        </article>`;
      }
      return `<article class="dd-yc${o.cls ? ` ${o.cls}` : ''}" tabindex="0" role="button" data-k="${esc(k)}" data-c="${esc(chainOf(t.chain))}" data-a="${esc(t.address)}" aria-label="open $${esc(sym(t.symbol))}, ${esc(o.aria)}">
          ${o.rank ? `<span class="dd-yc__rank num" aria-hidden="true">${o.rank}</span>` : ''}${logo(img, t.symbol)}
          <span class="dd-yc__id"><b>$${esc(sym(t.symbol) || '?')}</b><span class="dd-yc__s mono">${o.mark ? `<i class="dd-yc__mark is-${o.mark}" aria-hidden="true"></i>` : ''}${esc(o.sub)}</span></span>
          <span class="dd-yc__v num">${px ? esc(DD.fmtPrice(px)) : ''}${chg != null && isFinite(chg) ? `<span class="dd-ch${dirOf(chg) ? ` dd-ch--${dirOf(chg)}` : ''}">${esc(pctTxt(chg) || '0.0%')}<i> ${o.chgLabel || '24h'}</i></span>` : ''}</span>
          ${o.x ? `<button type="button" class="dd-yc__x" data-x aria-label="${esc(o.x)}">✕</button>` : ''}
        </article>`;
    }
    const ghostCaps = n => Array.from({ length: n }, () => '<span class="dd-yc dd-yc--ghost" aria-hidden="true"></span>').join('');
    const sep = w => `<span class="dd-strip__sep mono">${w}</span>`;
    const hint = (html, cls) => `<p class="dd-strip__hint${cls ? ` ${cls}` : ''}">${html}</p>`;
    function trendHtml() {
      let hot;
      if (board.status === 'idle' || board.status === 'loading') hot = ghostCaps(3);
      else hot = hotRows().slice(0, SHOW).map(({ r, q, heat, h1, buys, sells }, i) => {
        const n = buys + sells, bought = n ? Math.round(buys / n * 100) : null;
        return cap(r, { slim: true, cls: 'is-hot', rank: i + 1, px: q.px || r.price_at_read || null, chg: h1 == null ? null : +h1, chgLabel: '1h',
          sub: `${xTxt(heat)} its usual hour${bought != null ? ` · ${bought}% buys` : ''}`, aria: `trading ${xTxt(heat)} its usual hour` });
      }).join('');
      let calls;
      if (trend.status === 'idle' || trend.status === 'loading') calls = ghostCaps(4);
      else if (trend.status === 'err') calls = hint('the server is not answering right now. it comes back on its own.', 'is-err');
      else if (!trend.tokens.length) calls = hint('nothing mapped here in the last 24 hours yet. paste a token.');
      else {
        const list = trendRows();
        calls = list.length ? list.slice(0, SHOW).map((t, i) => {
          const q = quotes.get(keyOf(t.chain, t.address)) || {};
          const since = q.px && t.first_price_usd > 0 ? (q.px / t.first_price_usd - 1) * 100 : null;
          return cap(t, { slim: true, cls: 'is-call', rank: i + 1, chg: since, chgLabel: 'since first map',
            sub: `mapped ${t.groups}×${t.first_at ? ` · first ${WATCH.ago(t.first_at * 1000)}` : ''}`, aria: `mapped ${t.groups} time${t.groups === 1 ? '' : 's'}` });
        }).join('') : hint('nothing mapped on the chains you show in the last 24 hours.');
      }
      return (hot ? sep('running hot') + hot : '') + sep('mapped here') + calls;
    }
    function watchHtml() {
      const h = WATCH.horizon;
      const rows = WATCH.items.map(it => ({ it, sig: WATCH.signal(it, h) }))
        .sort((a, b) => (ORDER[a.sig.k] - ORDER[b.sig.k]) || ((b.sig.profit == null ? -9 : b.sig.profit) - (a.sig.profit == null ? -9 : a.sig.profit)) || (b.it.addedAt - a.it.addedAt));
      if (!rows.length) return hint("press <kbd>s</kbd> on a token to watch it: it lands here, sorted by what to do now. the same list as the Web Analyzer's.", 'is-intro');
      const more = rows.length > SHOW ? `<button type="button" class="dd-strip__more mono" data-wl>+${rows.length - SHOW} more</button>` : '';
      return rows.slice(0, SHOW).map(({ it, sig }) => cap(it, { cls: 'is-watch', px: WATCH.livePrice(it), mark: sig.k, sub: sig.word, aria: sig.word })).join('') + more;
    }
    function recentHtml() {
      if (!recent.items.length) return hint('press <kbd>/</kbd> and search a ticker, a contract or a 0x wallet: every token you open lands here.', 'is-intro');
      return recent.items.slice(0, CAP).map(t => cap(t, { sub: `opened ${WATCH.ago(t.ts)}`, aria: `opened ${WATCH.ago(t.ts)}`, x: `forget $${sym(t.symbol)}` })).join('')
        + '<button type="button" class="dd-strip__more mono" data-clear>clear</button>';
    }
    /* each strip keeps where the viewer scrolled it through a price refresh */
    function fillStrip(el, label, inner) {
      const old = el.querySelector('.dd-strip__row'), left = old ? old.scrollLeft : 0;
      el.innerHTML = `<h2 class="dd-strip__k mono">${label}</h2><div class="dd-strip__row">${inner}</div>`;
      const row = el.querySelector('.dd-strip__row');
      row.classList.toggle('is-over', row.scrollWidth > row.clientWidth + 2);
      row.scrollLeft = left;
    }
    /* a resize changes which strips run on: redraw them, a beat later */
    let fitT = 0;
    addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(() => { if (shown) render(); }, 150); });
    /* The size filter: two small toggles in the same pop-over. */
    function sizeBar() {
      const label = { established: 'established', small: 'small' };
      const chip = s => `<button type="button" class="dd-chip" data-lp="${s}" aria-pressed="${!sizesOff.has(s)}">${label[s]}</button>`;
      return `<div class="dd-chains" role="group" aria-label="project sizes the board, running hot and the field show">
        <span class="dd-chains__k mono">size</span>${SIZES.map(chip).join('')}
      </div>`;
    }
    /* The chain filter: in the stage's filters pop-over, beside what to show. */
    function chainBar() {
      if (CHAIN_LIST.length < 2) return '';
      const on = c => !hidden.has(c), evmOn = EVM.filter(on).length;
      const chip = c => `<button type="button" class="dd-chip" data-chain="${esc(c)}" aria-pressed="${on(c)}">${esc(DD.chainTag(c))}</button>`;
      let off = 0;
      if (hidden.size) {
        const seen = new Set();
        const all = (board.doc ? allRows().concat(board.doc.hot) : []).concat(trend.tokens);
        all.forEach(t => { const k = keyOf(t.chain, t.address); if (!shows(t) && !seen.has(k)) { seen.add(k); off++; } });
      }
      return `<div class="dd-chains" role="group" aria-label="chains the board, running hot and the groups' calls show">
        <span class="dd-chains__k mono">chains</span>
        <button type="button" class="dd-chip" data-chains="all" aria-pressed="${!hidden.size}">all</button>
        ${CHAIN_LIST.filter(c => NON_EVM.has(c)).map(chip).join('')}
        ${EVM.length > 1 ? `<button type="button" class="dd-chip" data-chains="evm" aria-pressed="${evmOn === EVM.length ? 'true' : evmOn ? 'mixed' : 'false'}">evm</button><span class="dd-chains__evm">${EVM.map(chip).join('')}</span>` : EVM.map(chip).join('')}
        ${off ? `<span class="dd-chains__n mono">${off} token${off === 1 ? '' : 's'} hidden</span>` : ''}
      </div>`;
    }

    function render() {
      if (!shown) return;
      /* the stage: its view, the wait over an empty field, the pill */
      const fs = fieldState(), v = viewNow();
      els.homeStage.dataset.view = v;
      els.homeStage.classList.toggle('is-ready', fs === 'ok');
      els.homeWaitT.textContent = fs === 'err' ? 'the entry board is not answering right now. it comes back on its own.' : 'reading the field · every token the board looked at';
      syncFill(fs);
      els.homePill.querySelectorAll('[data-view]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.view === v));
        b.disabled = b.dataset.view === 'field' && fs === 'none';
      });
      const filtered = hidden.size || sizesOff.size || gardenMode() === 'board';
      els.homeFiltersBtn.innerHTML = `filters${filtered ? ` <span class="num">${hidden.size ? `${CHAIN_LIST.length - hidden.size}/${CHAIN_LIST.length}` : '1'}</span>` : ''}`;
      els.homeFiltersBtn.classList.toggle('on', !!filtered);
      if (pop === 'filters') els.homeFilters.innerHTML = filtersHtml();
      els.homeKey.innerHTML = keyHtml();
      /* the board as cards, kept in place when only the numbers move */
      const keep = els.homeShelves.scrollTop;
      els.homeShelves.innerHTML = boardShelves() || noteCard('the entry board has no read to show right now. trending and your tokens stay around the stage.');
      els.homeShelves.scrollTop = keep;
      els.homeShelves.querySelectorAll('.dd-hc').forEach((c, i) => c.style.setProperty('--i', String(Math.min(i, 12))));
      const tOld = els.homeTrend.querySelector('.dd-strip__row'), tLeft = tOld ? tOld.scrollLeft : 0;
      fillStrip(els.homeTrend, 'trending', trendHtml());
      trendLoop();
      /* the carousel carries on from where it was, through the redraw */
      const tRow = els.homeTrend.querySelector('.dd-strip__row');
      if (tRow) { tRow.scrollLeft = tRow.dataset.loop ? tLeft % +tRow.dataset.loop : tLeft; marquee.pos = tRow.scrollLeft; }
      fillStrip(els.homeWatch, '<button type="button" data-wl aria-label="open the watchlist">★ watching</button>', watchHtml());
      fillStrip(els.homeRecent, 'opened lately', recentHtml());
      feedGarden();
      GARDEN.show(shown && fs === 'ok' && v === 'field');
      els.home.querySelectorAll('[data-heat]').forEach(el => el.style.setProperty('--heat', String(Math.max(0.08, Math.min(1, +el.dataset.heat || 0)))));
      els.homeShelves.querySelectorAll('[data-rb]').forEach(el => {
        const [e0, e1, t0, t1, px] = el.dataset.rb.split(',');
        Object.entries({ e0, e1, t0, t1, px }).forEach(([k, v]) => el.style.setProperty(`--${k}`, v));
      });
      els.home.querySelectorAll('[data-logo]').forEach(mark => {
        const img = new Image();
        img.alt = ''; img.decoding = 'async'; img.referrerPolicy = 'origin';
        img.onload = () => { if (img.naturalWidth && mark.isConnected) { mark.appendChild(img); mark.classList.add('is-in'); } };
        img.src = mark.dataset.logo;
      });
    }

    /* On screen exactly when the field is idle and no note owns it. */
    function sync() {
      const on = els.app.dataset.state === 'idle' && !fieldNoted;
      /* The page ships showing the welcome (class and section in the HTML),
         so the pill is under the greeting from the first paint instead of
         sliding there; a link that names a token takes it down at once. */
      els.app.classList.toggle('has-home', on);
      els.home.hidden = !on;
      if (on) els.empty.hidden = true;
      if (!on) GARDEN.show(false);
      if (on === shown) return;
      shown = on;
      clearInterval(timer);
      if (on) {
        els.home.classList.add('is-enter');
        clearTimeout(enterT);
        enterT = setTimeout(() => els.home.classList.remove('is-enter'), 900);
        render();
        refresh();
        timer = setInterval(() => { if (!document.hidden) refresh(); }, QUOTE_TTL);
      }
    }

    function open(el) {
      const c = el.dataset.c, a = el.dataset.a;
      if (c && a) goToken(c, a);
    }
    els.home.addEventListener('click', e => {
      const t = e.target;
      const vw = t.closest('button[data-view]');
      if (vw) { if (!vw.disabled) setView(vw.dataset.view); return; }
      if (t.closest('[data-filters]')) { setPop(pop === 'filters' ? null : 'filters'); return; }
      if (t.closest('[data-key]')) { setPop(pop === 'key' ? null : 'key'); return; }
      const gm = t.closest('[data-gmode]');
      if (gm) { gmode = gm.dataset.gmode; GARDEN.setMode(gmode); render(); return; }
      const z = t.closest('[data-z]');
      if (z) { GARDEN.zoom(z.dataset.z); return; }
      const sz = t.closest('[data-lp]');
      if (sz) { toggleSize(sz.dataset.lp); return; }
      const ch = t.closest('[data-chain], [data-chains]');
      if (ch) {
        const c = ch.dataset.chain, g = ch.dataset.chains, next = new Set(hidden);
        if (g === 'all') next.clear();
        /* all of EVM shown: hide it; some or none: show all of it */
        else if (g === 'evm') EVM.forEach(x => (ch.getAttribute('aria-pressed') === 'true' ? next.add(x) : next.delete(x)));
        else if (next.has(c)) next.delete(c);
        else next.add(c);
        setHidden(next);
        return;
      }
      if (t.closest('[data-clear]')) { recent.items = []; save(); render(); return; }
      if (t.closest('[data-wl]')) { if (!WATCH.open) WATCH.toggle(); return; }
      const c = t.closest('.dd-hc[data-a], .dd-yc[data-a]');
      if (!c) return;
      if (t.closest('[data-x]')) { forget(c.dataset.k); return; }
      open(c);
    });
    els.home.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.dd-hc[data-a], .dd-yc[data-a]')) { e.preventDefault(); open(e.target); }
    });
    /* esc closes a pop-over first, wherever the focus is */
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) { e.stopImmediatePropagation(); setPop(null); } }, true);
    /* a click anywhere else closes a pop-over */
    document.addEventListener('pointerdown', e => {
      if (pop && !(e.target.closest && e.target.closest('.dd-hs__pop, #homePill'))) setPop(null);
    });
    /* Trending moves on its own, a carousel: slow enough to read without
       stopping it, lively without pulling the eye (22 px/s since 0.31.0). The mouse over it
       stops it (the wheel then runs it, as on every strip), so does focus
       inside it, a touch for a few seconds, a hidden tab and reduced motion.
       It loops on a copy of its capsules (hidden from assistive tech, out of
       the tab order) and only moves when the row is wider than its room. */
    const TREND_SPEED = 22;   // px per second
    const marquee = { until: 0, raf: 0, last: 0, pos: null };
    /* paused is read from what is true now, never from enter / leave events
       that a redraw or a trip to a token can swallow */
    const CAN_HOVER = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    const held = () => {
      const a = document.activeElement;
      return (CAN_HOVER && els.homeTrend.matches(':hover')) || (!!a && els.homeTrend.contains(a) && a.matches(':focus-visible'));
    };
    function trendLoop() {
      const row = els.homeTrend.querySelector('.dd-strip__row');
      if (!row) return;
      delete row.dataset.loop;
      if (REDUCED_MOTION || row.scrollWidth <= row.clientWidth + 8) return;
      const kids = [...row.children];
      const copies = kids.map(k => {
        const c = k.cloneNode(true);
        c.setAttribute('data-dup', ''); c.setAttribute('aria-hidden', 'true');
        [c, ...c.querySelectorAll('[tabindex], button')].forEach(n => { if (n.matches('[tabindex], button')) n.tabIndex = -1; });
        return c;
      });
      copies.forEach(c => row.appendChild(c));
      row.dataset.loop = String(copies[0].offsetLeft - kids[0].offsetLeft);
      if (!marquee.raf) marquee.raf = requestAnimationFrame(marqueeTick);
    }
    function marqueeTick(now) {
      marquee.raf = 0;
      if (!shown) return;
      const row = els.homeTrend.querySelector('.dd-strip__row'), w = row ? +row.dataset.loop || 0 : 0;
      if (!w) { marquee.pos = null; return; }
      const dt = Math.min(0.1, (now - (marquee.last || now)) / 1000);
      marquee.last = now;
      const g = glide.homeTrend;
      if (!(held() || now < marquee.until || document.hidden || (g && g.goal != null))) {
        /* pick up wherever the viewer left it */
        if (marquee.pos == null || Math.abs(marquee.pos - row.scrollLeft) > 2) marquee.pos = row.scrollLeft;
        marquee.pos += TREND_SPEED * dt;
        while (marquee.pos >= w) marquee.pos -= w;
        row.scrollLeft = marquee.pos;
      }
      marquee.raf = requestAnimationFrame(marqueeTick);
    }
    els.homeTrend.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') marquee.until = performance.now() + 4000; });

    /* a mouse wheel over a strip runs it sideways, gliding to where the
       notches add up (a trackpad's own sideways swipe is left alone). The
       strip is found again each frame: a price refresh redraws its row. */
    const glide = {};
    function glideStep(id) {
      const g = glide[id], row = document.querySelector(`#${id} .dd-strip__row`);
      if (!row || !g || g.goal == null) { if (g) { g.raf = 0; g.goal = null; } return; }
      /* the goal is held to the row as it is now, and a glide that stopped
         moving (scroll offsets snap to device pixels) ends there */
      g.goal = Math.max(0, Math.min(row.scrollWidth - row.clientWidth, g.goal));
      const d = g.goal - row.scrollLeft;
      if (Math.abs(d) < 1 || REDUCED_MOTION || row.scrollLeft === g.prev) { row.scrollLeft = g.goal; g.raf = 0; g.goal = null; g.prev = null; return; }
      g.prev = row.scrollLeft;
      row.scrollLeft += d * 0.28;
      g.raf = requestAnimationFrame(() => glideStep(id));
    }
    /* a strip scrolled off its start fades at both ends */
    els.home.addEventListener('scroll', e => {
      const row = e.target;
      if (row.classList && row.classList.contains('dd-strip__row')) row.classList.toggle('is-in', row.scrollLeft > 4);
    }, true);
    els.home.addEventListener('wheel', e => {
      const row = e.target.closest && e.target.closest('.dd-strip__row'), strip = row && row.closest('.dd-strip');
      if (!row || !strip || Math.abs(e.deltaX) > Math.abs(e.deltaY) || row.scrollWidth <= row.clientWidth) return;
      e.preventDefault();
      const g = glide[strip.id] || (glide[strip.id] = { goal: null, raf: 0 }), max = row.scrollWidth - row.clientWidth;
      g.goal = Math.max(0, Math.min(max, (g.goal == null ? row.scrollLeft : g.goal) + e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? row.clientWidth : 1)));
      if (!g.raf) g.raf = requestAnimationFrame(() => glideStep(strip.id));
    }, { passive: false });
    els.homeShelves.addEventListener('pointerover', e => {
      const c = e.target.closest && e.target.closest('.dd-hc[data-k]');
      GARDEN.focus(c ? c.dataset.k : null);
    });
    document.addEventListener('visibilitychange', () => { if (shown && !document.hidden) refresh(); });

    /* The search's rows when it opens empty over a token: the way back. */
    function searchRows() {
      if (!current || els.input.value.trim()) return false;
      const here = keyOf(current.chain, current.address);
      const list = recent.items.filter(t => keyOf(t.chain, t.address) !== here).slice(0, 6);
      if (!list.length) return false;
      els.rows.innerHTML = '<p class="dd-row dd-row--note dd-row--hd mono">recent</p>' + list.map(t =>
        `<button type="button" class="dd-row" data-c="${esc(t.chain)}" data-a="${esc(t.address)}"><span class="nm">${esc(t.name || t.symbol)}<span class="mono">$${esc(t.symbol || '?')}</span></span><span class="mt mono num">${esc(DD.chainTag(t.chain))} &middot; ${esc(WATCH.ago(t.ts))}</span></button>`).join('');
      els.rows.hidden = false;
      return true;
    }
    els.rows.addEventListener('click', e => {
      const b = e.target.closest('.dd-row[data-a]');
      if (!b) return;
      closeSearch();
      goToken(b.dataset.c, b.dataset.a);
    });
    els.input.addEventListener('focus', () => { if (els.rows.hidden) searchRows(); });
    els.input.addEventListener('input', () => {
      if (!els.input.value.trim()) searchRows();
      else if (els.rows.querySelector('.dd-row[data-a]')) { els.rows.hidden = true; els.rows.innerHTML = ''; }
    });

    return { sync, remember, render, watchChanged: () => { if (shown) render(); } };
  })();
  home = HOME;

  /* ---------- keys ----------
     The shared block owns Esc (clear the selection), the arrows (walk the
     groups), h (hide the hovered wallet) and f (reframe). DiDo adds:
       /        search
       c        fold / unfold the chart
       [ ]      chart smaller / larger
       x        chart over the whole field
       z  e     zones / emas
       m        measure
       1..4     5m 15m 1h 4h
       s        watch / unwatch the token on screen
       w        the watchlist
       l        the project's links
       0        every pane back to its home
       Esc      also closes the watchlist, a holding's menu, the wallet's
                full view, then the wallet */
  document.addEventListener('keydown', ev => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (ev.key === 'Escape') {
      if (searchOpen) { closeSearch(); return; }
      if (LINKS.open) { LINKS.close(); return; }
      if (WATCH.open) { WATCH.close(); return; }
      if (HMENU.isOpen) { HMENU.close(); return; }
      if (WGROUND.on && !typing) { WGROUND.toggle(); return; }
      if (WALLET.addr && !typing) { WALLET.close(); return; }
      if (chart.measure) { chart.setMeasure(false); return; }
      if (chart.max) { chart.toggleMax(); return; }
      return;
    }
    if (typing) return;
    if (ev.key === '/') { ev.preventDefault(); openSearch(); return; }
    if (ev.key === 'w') { ev.preventDefault(); WATCH.toggle(); return; }
    if (!current) return;
    switch (ev.key) {
      case 'c': chart.toggleFold(); break;
      case '[': chart.cycleSize(-1); break;
      case ']': chart.cycleSize(1); break;
      case 'x': chart.toggleMax(); break;
      case 'z': if (!els.zonesChip.disabled) { chart.zones = !chart.zones; chart.syncChips(); chart.render(); } break;
      case 'm': chart.setMeasure(!chart.measure); break;
      case 'l': LINKS.toggle(); break;
      case 's': WATCH.toggleStar(); break;
      case '0': LAYOUT.resetAll(); break;
      case 'e': chart.ema = !chart.ema; chart.syncChips(); chart.render(); break;
      case '1': chart.setTf('5m'); break;
      case '2': chart.setTf('15m'); break;
      case '3': chart.setTf('1h'); break;
      case '4': chart.setTf('4h'); break;
      default: return;
    }
    ev.preventDefault();
  });

  /* ---------- the holder map and its dossier ----------
     The block below is not written here. `dido/build.mjs` slices it out of
     the shipped Web Analyzer page at build time through
     shared/holdermap/extract.mjs, the same way it takes the analysis engine
     from the ENGINE markers. That is what makes DiDo's field the analyzer's
     cluster map rather than a lookalike: one implementation, one place to
     fix, nothing to keep in sync by hand.

     It expects `esc` and `DD` in scope (both are, here) and defines
     holderSectionShellHtml() / holderLoader() / initHolderMap() and the
     module slots holderMapApi / holderMapDestroy the app reads. */
{{HOLDERMAP_JS}}

  /* ---------- boot ---------- */
  function start() {
    const u = readUrl();
    chart.tf = u.tf;
    chart.unit = u.unit;
    if (u.chart === 'off') chart.folded = true;
    else chart.size = u.chart;
    chart.syncChips();
    renderTrail(null, null);
    WATCH.init(u.w);
    WALLET.init();
    if (u.w) {
      /* The list is in; the link has done its job. */
      const params = new URLSearchParams(location.search);
      params.delete('w');
      const qs = params.toString();
      try { history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`); } catch (e) { /* fine */ }
    }
    if (u.wallet) WALLET.open(u.wallet, { quiet: true });
    if (u.address) return runPinned(u.chain, u.address);
    if (u.q) { els.input.value = u.q; return run(u.q); }
    /* landed on the welcome: the first token opened from it is a step of its
       own, so back returns to the welcome instead of leaving DiDo */
    navReplace = false;
    setState('idle');
    if (u.wallet) fieldNote('pick a holding to open it.', false);
    else els.input.focus();
    return null;
  }
  /* Back and forward walk the journey: the token and the wallet the step
     names are put back on screen without adding a step of their own. */
  function toIdle() {
    LINKS.close();
    runToken++;
    current = null; currentPair = null; currentRes = null; holdersRun = null;
    els.stage.innerHTML = ''; delete els.stage.dataset.map;
    chart.reset();
    renderTrail(null, null);
    renderSecurity(null);
    renderTicker();
    placeRailControls();
    mapState(null, null);
    ground.set(null);
    setState('idle');
    WATCH.paintChips();
  }
  window.addEventListener('popstate', () => {
    TRAIL.popped();
    HMENU.close();
    const u = readUrl();
    if (u.wallet) { if (u.wallet.toLowerCase() !== String(WALLET.addr || '').toLowerCase()) WALLET.open(u.wallet, { quiet: true }); }
    else if (WALLET.addr) WALLET.close({ quiet: true });
    if (u.address) {
      const same = current && String(current.address).toLowerCase() === u.address.toLowerCase()
        && (!u.chain || normChain(current.chain) === u.chain);
      if (!same) { navReplace = true; runPinned(u.chain, u.address); }
    } else if (current) toIdle();
  });
  /* DigitalDon elsewhere: the globe opens on hover by CSS alone; a tap (touch
     has no hover) or a click pins it open until the pointer leaves, a tap
     outside or Esc. */
  const SOC = {
    set(open) { els.soc.classList.toggle('is-open', open); els.socBall.setAttribute('aria-expanded', String(open)); },
  };
  els.socBall.addEventListener('click', () => SOC.set(!els.soc.classList.contains('is-open')));
  els.soc.addEventListener('mouseenter', () => els.socBall.setAttribute('aria-expanded', 'true'));
  els.soc.addEventListener('mouseleave', () => { SOC.set(false); if (els.soc.contains(document.activeElement)) document.activeElement.blur(); });
  els.soc.addEventListener('keydown', ev => { if (ev.key === 'Escape') { SOC.set(false); els.socBall.blur(); ev.stopPropagation(); } });
  document.addEventListener('pointerdown', ev => { if (!els.soc.contains(ev.target)) SOC.set(false); });

  /* The mark goes home: the welcome with the trending shelves, as a step of
     its own so back returns to the token. A modified click keeps the link's
     own behaviour (a new tab opens the start page too). */
  els.brand.addEventListener('click', ev => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    closeSearch();
    els.input.value = '';
    if (WALLET.addr) WALLET.close({ quiet: true });
    if (current || els.app.dataset.state !== 'idle') toIdle();
    else setState('idle');
    writeUrl();
  });
  window.addEventListener('hashchange', () => {
    const u = readUrl();
    if (u.tf !== chart.tf) chart.setTf(u.tf);
    if (u.unit !== chart.unit) chart.setUnit(u.unit);
  });
  start();
})(DD);
