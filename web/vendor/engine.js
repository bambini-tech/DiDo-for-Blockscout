/*ENGINE-START*/
const DD = (() => {
  'use strict';

  const PROFILE_FRESH = 'FRESH', PROFILE_EARLY = 'EARLY', PROFILE_ESTABLISHED = 'ESTABLISHED';
  /* A tokenized equity. Not an age bucket like the other three: it is selected
     by WHAT the token is, never by how old its pool is. Robinhood minted its
     stock tokens months ago and the companies behind them have traded for
     decades, so profiling by pool age put AAPL in EARLY — where the engine
     strips the first 24h of candles as a "launch", weights DEX swap counts at
     10, and reads a two-month pool as the asset's entire life. 1:1 with
     PROFILE_STOCK / ASSET_CLASS_STOCK in crypto_bot/analysis.py. */
  const PROFILE_STOCK = 'STOCK';
  const ASSET_CLASS_STOCK = 'stock';

  const PROFILE_LABELS = {
    FRESH: 'Fresh Launch (<14d)',
    EARLY: 'Early Stage (14-60d)',
    ESTABLISHED: 'Established (60d+)',   /* band starts at 60, not 90 */
    STOCK: 'Tokenized equity',
  };

  /* ---------- the project's own token ----------
     1:1 with crypto_bot/analysis.py (NATIVE_TOKENS / NATIVE_SCORE_* /
     nativeScore / nativeToken). Read the long comment there for why this
     exists at all; the short version is that two facts about our own token
     are known to us and unknowable to the engine — the largest wallet group
     is the treasury, and a 1d scalp plan on it is a jeet button aimed at our
     own holders — and this is the one declared, disclosed place we say so.

     Same table, same constants, same result on the bot card, the Web Analyzer
     and a partner's widget: the widget takes this block at build time, so
     there is nothing to keep in step but the Python port, which the parity
     gate does (`native_policy` in shared/engine/fixtures.json). */
  const NATIVE_TOKENS = {
    'robinhood:0x0b551573d731090b3f57129c11b0a4a9e4d0a69c': {
      symbol: 'DON',
      label: 'official DigitalDon token',
      badge: 'our token \u00b7 house view',
    },
  };
  const NATIVE_SCORE_LIFT = 8;    /* points added to the computed score */
  const NATIVE_SCORE_FLOOR = 50;  /* ... and it never prints below "Neutral, wait and see" */

  const nativeScore = score => Math.max(NATIVE_SCORE_FLOOR, Math.min(100, score + NATIVE_SCORE_LIFT));

  function nativeToken(chain, address) {
    if (!chain || !address) return null;
    return NATIVE_TOKENS[`${String(chain).trim().toLowerCase()}:${String(address).trim().toLowerCase()}`] || null;
  }

  const nativeTokenFor = info => (info ? nativeToken(info.chain, info.address) : null);

  /* ---------- small array helpers (pandas-ish semantics) ---------- */
  const lastOf = a => a[a.length - 1];
  const tail = (a, n) => a.slice(Math.max(0, a.length - n));
  const mean = a => { let s = 0, c = 0; for (const v of a) { if (!Number.isNaN(v)) { s += v; c++; } } return c ? s / c : NaN; };
  const maxOf = a => { let m = -Infinity; for (const v of a) if (!Number.isNaN(v) && v > m) m = v; return m === -Infinity ? NaN : m; };
  const minOf = a => { let m = Infinity; for (const v of a) if (!Number.isNaN(v) && v < m) m = v; return m === Infinity ? NaN : m; };

  // df = { t: [ms], o, h, l, c, v : number[] }
  const dfLen = df => df.c.length;
  function dfSlice(df, start, end) {
    return { t: df.t.slice(start, end), o: df.o.slice(start, end), h: df.h.slice(start, end),
             l: df.l.slice(start, end), c: df.c.slice(start, end), v: df.v.slice(start, end) };
  }
  const dfTail = (df, n) => dfSlice(df, Math.max(0, dfLen(df) - n));

  /* ---------- indicators ---------- */
  // pandas ewm(span=p, adjust=False)
  function emaSpan(vals, span) {
    const a = 2 / (span + 1), out = new Array(vals.length);
    let prev = NaN;
    for (let i = 0; i < vals.length; i++) {
      const x = vals[i];
      if (Number.isNaN(prev)) prev = x;
      else if (!Number.isNaN(x)) prev = x * a + prev * (1 - a);
      out[i] = prev;
    }
    return out;
  }

  // pandas ewm(com=c, adjust=True(default), min_periods=mp).mean(), ignore_na=False
  function ewmAdjusted(vals, alpha, minPeriods) {
    const out = new Array(vals.length).fill(NaN);
    let num = 0, den = 0, count = 0;
    for (let i = 0; i < vals.length; i++) {
      const x = vals[i];
      if (Number.isNaN(x)) { num *= (1 - alpha); den *= (1 - alpha); out[i] = count >= minPeriods && den > 0 ? num / den : NaN; continue; }
      num = x + (1 - alpha) * num;
      den = 1 + (1 - alpha) * den;
      count++;
      out[i] = count >= minPeriods ? num / den : NaN;
    }
    return out;
  }

  function calcRsi(close, period = 14) {
    const n = close.length;
    const gain = new Array(n).fill(NaN), loss = new Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      const d = close[i] - close[i - 1];
      gain[i] = d > 0 ? d : 0;
      loss[i] = d < 0 ? -d : 0;
    }
    const alpha = 1 / period; // com = period-1
    const ag = ewmAdjusted(gain, alpha, period);
    const al = ewmAdjusted(loss, alpha, period);
    const out = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(ag[i]) || Number.isNaN(al[i]) || al[i] === 0) continue; // 0 -> NaN like pandas replace(0, nan)
      const rs = ag[i] / al[i];
      out[i] = 100 - 100 / (1 + rs);
    }
    return out;
  }

  function rollingApply(vals, w, fn) {
    const out = new Array(vals.length).fill(NaN);
    for (let i = w - 1; i < vals.length; i++) {
      let ok = true;
      for (let j = i - w + 1; j <= i; j++) if (Number.isNaN(vals[j])) { ok = false; break; }
      if (ok) out[i] = fn(vals, i - w + 1, i + 1);
    }
    return out;
  }
  const winMin = (a, s, e) => { let m = Infinity; for (let i = s; i < e; i++) if (a[i] < m) m = a[i]; return m; };
  const winMax = (a, s, e) => { let m = -Infinity; for (let i = s; i < e; i++) if (a[i] > m) m = a[i]; return m; };
  const winMean = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i]; return t / (e - s); };
  const winStd = (a, s, e) => { const m = winMean(a, s, e); let t = 0; for (let i = s; i < e; i++) t += (a[i] - m) ** 2; return Math.sqrt(t / (e - s - 1)); };
  const rollingMin = (v, w) => rollingApply(v, w, winMin);
  const rollingMax = (v, w) => rollingApply(v, w, winMax);
  const rollingMean = (v, w) => rollingApply(v, w, winMean);
  const rollingStd = (v, w) => rollingApply(v, w, winStd);

  // pandas rolling(window=w, center=True): at label i the window covers
  // [i - (w - 1 - s), i + s] with s = (w-1)>>1 (full window required).
  function centeredApply(vals, w, fn) {
    const s = (w - 1) >> 1;
    const out = new Array(vals.length).fill(NaN);
    for (let i = 0; i < vals.length; i++) {
      const lo = i - (w - 1 - s), hi = i + s;
      if (lo < 0 || hi >= vals.length) continue;
      let ok = true;
      for (let j = lo; j <= hi; j++) if (Number.isNaN(vals[j])) { ok = false; break; }
      if (ok) out[i] = fn(vals, lo, hi + 1);
    }
    return out;
  }

  function calcStochRsi(close, rsiP = 14, stochP = 14, kS = 3, dS = 3) {
    const rsi = calcRsi(close, rsiP);
    const rmin = rollingMin(rsi, stochP), rmax = rollingMax(rsi, stochP);
    const raw = rsi.map((r, i) => {
      const rng = rmax[i] - rmin[i];
      if (Number.isNaN(rng) || rng === 0) return NaN;
      return (r - rmin[i]) / rng * 100;
    });
    const k = rollingMean(raw, kS);
    const d = rollingMean(k, dS);
    return [k, d];
  }

  function calcMacd(close, fast = 12, slow = 26, signal = 9) {
    const ef = emaSpan(close, fast), es = emaSpan(close, slow);
    const ml = ef.map((v, i) => v - es[i]);
    const sl = emaSpan(ml, signal);
    const hist = ml.map((v, i) => v - sl[i]);
    return [ml, sl, hist];
  }

  function calcBollinger(close, period = 20, stdDev = 2) {
    const sma = rollingMean(close, period), std = rollingStd(close, period);
    return [sma.map((v, i) => v + stdDev * std[i]), sma.map((v, i) => v - stdDev * std[i])];
  }

  function volumeConfirmed(df, window = 20) {
    if (!df.v || dfLen(df) < window) return true;
    const avg = mean(tail(df.v, window)), now = lastOf(df.v);
    return avg > 0 && now >= avg * 1.2;
  }

  /* ---------- structure ---------- */
  function findSupportResistance(df, window = 8) {
    const highsRoll = centeredApply(df.h, window, winMax);
    const lowsRoll = centeredApply(df.l, window, winMin);
    const cur = lastOf(df.c);
    const ph = [], pl = [];
    for (let i = 0; i < dfLen(df); i++) {
      if (!Number.isNaN(highsRoll[i]) && df.h[i] === highsRoll[i]) ph.push(df.h[i]);
      if (!Number.isNaN(lowsRoll[i]) && df.l[i] === lowsRoll[i]) pl.push(df.l[i]);
    }
    const plBelow = pl.filter(v => v < cur), phAbove = ph.filter(v => v > cur);
    const sup = plBelow.length ? Math.max(...plBelow) : minOf(df.l);
    const res = phAbove.length ? Math.min(...phAbove) : maxOf(df.h);
    return [sup, res];
  }

  // swing points: value equals centered rolling extreme over w*2+1
  function swingLows(vals, w = 5) {
    const roll = centeredApply(vals, w * 2 + 1, winMin);
    const out = [];
    for (let i = 0; i < vals.length; i++) if (!Number.isNaN(roll[i]) && vals[i] === roll[i]) out.push({ i, v: vals[i] });
    return out;
  }
  function swingHighs(vals, w = 5) {
    const roll = centeredApply(vals, w * 2 + 1, winMax);
    const out = [];
    for (let i = 0; i < vals.length; i++) if (!Number.isNaN(roll[i]) && vals[i] === roll[i]) out.push({ i, v: vals[i] });
    return out;
  }

  function resistanceLadder(df, window, curPrice) {
    const highsRoll = centeredApply(df.h, window, winMax);
    const vals = [];
    for (let i = 0; i < dfLen(df); i++) if (!Number.isNaN(highsRoll[i]) && df.h[i] === highsRoll[i]) vals.push(df.h[i]);
    vals.sort((a, b) => a - b);
    const groups = [];
    for (const v of vals) {
      let placed = false;
      for (const g of groups) {
        const gm = mean(g);
        if (Math.abs(v - gm) / gm <= 0.03) { g.push(v); placed = true; break; }
      }
      if (!placed) groups.push([v]);
    }
    return groups.map(g => mean(g)).filter(p => p > curPrice * 1.01);
  }

  function analyzeEma(df) {
    const close = df.c, n = close.length;
    if (n < 25) return ['', '', false];
    const ema20 = emaSpan(close, 20);
    const cur = lastOf(close);
    const labels = [cur > lastOf(ema20) ? 'above EMA20' : 'below EMA20'];
    let cross = '', crossVol = false;
    if (n >= 55) {
      const ema50 = emaSpan(close, 50);
      const e50 = lastOf(ema50), e50p = ema50[n - 2];
      const e20 = lastOf(ema20), e20p = ema20[n - 2];
      labels.push(cur > e50 ? 'above EMA50' : 'below EMA50');
      if (e20p <= e50p && e20 > e50) { cross = 'golden cross'; crossVol = volumeConfirmed(df); }
      else if (e20p >= e50p && e20 < e50) { cross = 'death cross'; crossVol = volumeConfirmed(df); }
    }
    if (n >= 205) {
      const ema200 = emaSpan(close, 200);
      labels.push(cur > lastOf(ema200) ? 'above EMA200' : 'below EMA200');
    }
    return [labels.join(', '), cross, crossVol];
  }

  function detectRsiDivergence(df, rsiPeriod = 14) {
    const n = dfLen(df);
    if (n < rsiPeriod * 3) return '';
    const lb = dfTail(df, Math.min(80, n));
    const close = lb.c;
    const rsi = calcRsi(close, Math.min(rsiPeriod, Math.floor(close.length / 3)));
    const pl = swingLows(close, 3), rl = swingLows(rsi, 3);
    if (pl.length >= 2 && rl.length >= 2) {
      const p1 = pl[pl.length - 2].v, p2 = pl[pl.length - 1].v;
      const anchor = pl[pl.length - 2].i;
      const cand = rl.filter(s => s.i <= anchor);
      if (cand.length) {
        const cMax = cand[cand.length - 1];
        const r1 = cMax.v, r2 = rl[rl.length - 1].v;
        if (cMax.i < rl[rl.length - 1].i && p2 < p1 * 0.98 && r2 > r1 * 1.02) return 'bullish';
      }
    }
    const ph = swingHighs(close, 3), rh = swingHighs(rsi, 3);
    if (ph.length >= 2 && rh.length >= 2) {
      const p1 = ph[ph.length - 2].v, p2 = ph[ph.length - 1].v;
      const anchor = ph[ph.length - 2].i;
      const cand = rh.filter(s => s.i <= anchor);
      if (cand.length) {
        const cMax = cand[cand.length - 1];
        const r1 = cMax.v, r2 = rh[rh.length - 1].v;
        if (cMax.i < rh[rh.length - 1].i && p2 > p1 * 1.02 && r2 < r1 * 0.98) return 'bearish';
      }
    }
    return '';
  }

  /* ---------- trends & patterns ---------- */
  function detectTrendLong(df4) {
    if (!df4 || dfLen(df4) < 20) return ['Sideways', 'insufficient data'];
    const close = df4.c;
    const n = Math.min(300, dfLen(df4));
    const cur = lastOf(close);
    const ath = maxOf(df4.h);
    const pct = (cur - ath) / ath * 100;
    const ema20 = emaSpan(close, Math.min(20, n));
    const ema50 = n >= 50 ? emaSpan(close, Math.min(50, n)) : null;
    const e20 = lastOf(ema20);
    const e50 = ema50 ? lastOf(ema50) : null;
    const slope = n >= 15 ? (lastOf(ema20) - ema20[ema20.length - 10]) / ema20[ema20.length - 10] * 100 : 0;
    if (cur > e20 && (e50 === null || cur > e50) && slope > 2) return ['Uptrend', 'above EMA20/50, rising'];
    if (cur > e20 && slope > 0) return ['Weak uptrend', 'above EMA20, flat slope'];
    if (cur < e20 && (e50 === null || cur < e50) && slope < -2) return ['Downtrend', `${Math.abs(pct).toFixed(0)}% below ATH, below EMA20/50`];
    if (cur < e20 && slope < 0) return ['Weak downtrend', `${Math.abs(pct).toFixed(0)}% below ATH`];
    return ['Sideways', 'near EMA, no clear slope'];
  }

  function detectTrendShort(df1) {
    if (!df1 || dfLen(df1) < 6) return ['Sideways', 'insufficient data'];
    const n = Math.min(72, dfLen(df1));
    const close = tail(df1.c, n);
    const cur = lastOf(close), start = close[0];
    const low = minOf(tail(df1.l, n)), high = maxOf(tail(df1.h, n));
    const rng = high - low;
    const pct = start > 0 ? (cur - start) / start * 100 : 0;
    const pos = rng > 0 ? (cur - low) / rng : 0.5;
    if (pct > 8) return ['Uptrend', 'strong 3d move'];
    if (pct > 3) return ['Uptrend', 'recovering'];
    if (pct < -8) return ['Downtrend', 'selling pressure'];
    if (pct < -3) return ['Downtrend', 'weak momentum'];
    if (pos > 0.6) return ['Sideways', 'near top of range'];
    if (pos < 0.4) return ['Sideways', 'holding support'];
    return ['Sideways', 'no clear direction'];
  }

  function detectChartPattern(df) {
    if (dfLen(df) < 15) return ['', 'neu'];
    const n = Math.min(60, dfLen(df));
    const recent = dfTail(df, n);
    const rh = maxOf(recent.h), rl = minOf(recent.l);
    const rngPct = rl > 0 ? (rh - rl) / rl * 100 : 100;
    const cur = lastOf(recent.c);
    const w = Math.max(3, Math.floor(n / 8));

    const sl = swingLows(recent.l, w);
    const sh = swingHighs(recent.h, w);

    if (sl.length >= 2) {
      const l1 = sl[sl.length - 2].v, l2 = sl[sl.length - 1].v;
      if (l1 > 0 && Math.abs(l1 - l2) / Math.max(l1, l2) < 0.05 && cur > l2 * 1.03)
        return ['Double Bottom -- potential bullish reversal', 'pos'];
    }
    if (sh.length >= 3) {
      const h1 = sh[sh.length - 3].v, h2 = sh[sh.length - 2].v, h3 = sh[sh.length - 1].v;
      if (h2 > h1 * 1.02 && h2 > h3 * 1.02 && Math.abs(h1 - h3) / Math.max(h1, h3) < 0.10 && cur < h3 * 0.98)
        return ['Head & Shoulders -- bearish reversal signal', 'neg'];
    }

    const shv = sh.length >= 2 ? sh.slice(-4).map(s => s.v) : [];
    const slv = sl.length >= 2 ? sl.slice(-4).map(s => s.v) : [];
    const strictly = (arr, cmp) => arr.every((v, i) => i === 0 || cmp(arr[i - 1], v));

    if (shv.length >= 2 && slv.length >= 2) {
      const flatRes = (Math.max(...shv) - Math.min(...shv)) / Math.max(...shv) < 0.04;
      const risingSup = strictly(slv, (a, b) => a < b);
      if (flatRes && risingSup) return ['Ascending Triangle -- bullish continuation pattern', 'pos'];
    }
    if (shv.length >= 2 && slv.length >= 2) {
      const highsFall = strictly(shv, (a, b) => a > b);
      const lowsFall = strictly(slv, (a, b) => a > b);
      if (highsFall && lowsFall && shv[0] > 0 && slv[0] > 0) {
        const highDrop = (shv[0] - shv[shv.length - 1]) / shv[0];
        const lowDrop = (slv[0] - slv[slv.length - 1]) / slv[0];
        if (highDrop > lowDrop * 1.15 && rngPct < 50) return ['Falling Wedge -- potential bullish breakout', 'pos'];
      }
    }
    if (shv.length >= 2 && slv.length >= 2) {
      const highsRise = strictly(shv, (a, b) => a < b);
      const lowsRise = strictly(slv, (a, b) => a < b);
      if (highsRise && lowsRise && shv[0] > 0 && slv[0] > 0) {
        const highGain = (shv[shv.length - 1] - shv[0]) / shv[0];
        const lowGain = (slv[slv.length - 1] - slv[0]) / slv[0];
        if (lowGain > highGain * 1.15 && rngPct < 50) return ['Rising Wedge -- potential bearish reversal', 'neg'];
      }
    }

    const hl = sl.length >= 3 && sl.every((s, i) => i === 0 || s.v > sl[i - 1].v);
    let vdecl = false;
    if (recent.v && n >= 10) {
      const half = Math.floor(n / 2);
      const vf = mean(recent.v.slice(0, half)), vs = mean(recent.v.slice(half));
      vdecl = vf > 0 ? vs < vf * 0.8 : false;
    }
    const l5 = minOf(tail(recent.l, 5));
    const lp = dfLen(recent) > 5 ? minOf(recent.l.slice(0, -5)) : l5;
    const hold = l5 >= lp * 0.97;

    if (hl && rngPct < 20) return ['Strong base forming - higher lows, tight consolidation', 'pos'];
    if (hl) return ['Higher lows detected - potential accumulation', 'pos'];
    if (rngPct < 10 && vdecl) return ['Tight consolidation, declining volume - possible breakout setup', 'pos'];
    if (rngPct < 15 && hold) return ['Consolidating above support - holding well', 'neu'];
    if (hold) return ['Holding lows - no clear direction yet', 'neu'];
    if (rngPct > 50) return ['High volatility - no clear base', 'neg'];
    return ['', 'neu'];
  }

  /* ---------- score ---------- */
  const WEIGHTS = {
    FRESH: {
      rsi: [15, 15], stoch_rsi: [15, 15], macd: [10, 10], bollinger: [10, 10],
      volume_trend: [20, 10], buy_sell_ratio: [20, 10],
      trend_long: [5, 5], trend_short: [5, 5],
      pattern: [5, 5], ema: [5, 5], rsi_divergence: [10, 10],
    },
    EARLY: {
      rsi: [20, 20], stoch_rsi: [15, 15], macd: [15, 15], bollinger: [10, 10],
      volume_trend: [10, 5], buy_sell_ratio: [10, 5],
      trend_long: [10, 10], trend_short: [5, 5],
      pattern: [10, 10], ema: [15, 15], rsi_divergence: [15, 15],
    },
    ESTABLISHED: {
      rsi: [25, 25], stoch_rsi: [15, 15], macd: [20, 20], bollinger: [15, 15],
      volume_trend: [5, 5], buy_sell_ratio: [5, 5],
      trend_long: [15, 15], trend_short: [10, 10],
      pattern: [10, 10], ema: [20, 20], rsi_divergence: [20, 20],
    },
    /* Tokenized equity. The price series belongs to the company, so every
       price-derived indicator keeps its ESTABLISHED weight and the two
       DEX-derived ones are nearly muted: volume_trend and buy_sell_ratio are
       counted off a few hundred swaps a day against the billions the same
       share turns over on its home exchange. Trend and the EMA stack take that
       weight instead — the moving-average structure is what equity traders
       actually read, and unlike a swap count it is computed from the price
       arbitrage keeps honest. */
    STOCK: {
      rsi: [25, 25], stoch_rsi: [15, 15], macd: [20, 20], bollinger: [15, 15],
      volume_trend: [2, 2], buy_sell_ratio: [2, 2],
      trend_long: [20, 20], trend_short: [10, 10],
      pattern: [10, 10], ema: [25, 25], rsi_divergence: [20, 20],
    },
  };

  function weightedScore(signals, profile) {
    const w = WEIGHTS[profile] || WEIGHTS.ESTABLISHED;
    let totalMax = 0, totalMinAbs = 0;
    for (const k in w) { totalMax += w[k][0]; totalMinAbs += w[k][1]; }
    const totalMin = -totalMinAbs;
    let raw = 0;
    for (const k in signals) {
      if (!(k in w)) continue;
      const v = signals[k];
      raw += (v >= 0 ? w[k][0] : w[k][1]) * v;
    }
    return Math.max(0, Math.min(100, Math.round((raw - totalMin) / (totalMax - totalMin) * 100)));
  }

  /* ---------- short-term setup guard (1:1 with analysis.py) ----------
     Minimum upside for a short-term setup to be worth quoting. The zones are
     padded by a fixed +1% (entry ceiling) and -1% (target floor) around the 72h
     support/resistance; on a band narrower than ~2% that padding makes them
     CROSS (buy up to X, sell below X), and between 2% and ~5% they are ordered
     but the upside does not survive slippage and fees. Same finding either way:
     this token has no short-term trade. */
  const ST_MIN_UPSIDE_PCT = 3.0;
  /* The same floor for a tokenized equity. 3% is a sane bar for a memecoin that
     routinely moves 30% in a day and a nonsense one for a large-cap share:
     Apple moving 3% is a news event, so the generic threshold answered "no
     tradable range" on virtually every stock on virtually every day — the
     engine reporting its own mis-calibration as a finding about the asset. 1%
     is a real swing on an equity and still clears the ±1% zone padding, so the
     zones stay ordered rather than crossing. */
  const ST_MIN_UPSIDE_PCT_STOCK = 1.0;

  /* How far the short-term zones are padded around the measured support and
     resistance: [entryLow, entryHigh, tpLow, tpHigh] multipliers.

     The token pads are wide on purpose — a memecoin's fill is imprecise and
     its levels move while you read them. That width is a bug on an equity, and
     an expensive one: it costs about TWO PERCENTAGE POINTS of band, while a
     large-cap's 72h band is typically one to three. Measured on the live
     catalogue: TSLAx showed a 1.9% band, which the token pads turn into −0.1%
     of upside — crossed zones. The engine then said "no tradable range", when
     what happened is that the padding ate the trade. Lowering the upside floor
     alone cannot rescue that, because the arithmetic is already below zero
     before the floor is consulted. 1:1 with _ST_ZONE_PADS in analysis.py. */
  const ST_ZONE_PADS = {
    token: [0.98,  1.01,  0.99,  1.02],
    stock: [0.995, 1.003, 0.997, 1.005],
  };

  const stZonePads = assetClass =>
    ST_ZONE_PADS[assetClass === ASSET_CLASS_STOCK ? 'stock' : 'token'];

  const stMinUpsidePct = assetClass =>
    (assetClass === ASSET_CLASS_STOCK ? ST_MIN_UPSIDE_PCT_STOCK : ST_MIN_UPSIDE_PCT);

  function stSetupUpside(entryHigh, tpLow) {
    if (!entryHigh || entryHigh <= 0 || tpLow === null || tpLow === undefined) return null;
    return (tpLow - entryHigh) / entryHigh * 100;
  }

  function stSetupTradable(entryHigh, tpLow, assetClass = null) {
    const up = stSetupUpside(entryHigh, tpLow);
    return up !== null && up >= stMinUpsidePct(assetClass);
  }

  function bandPct(support, resistance) {
    if (!support || support <= 0 || !resistance) return null;
    return (resistance / support - 1) * 100;
  }

  /* `native`: the other reason zones can be missing — on our own token the
     short-term plan is withheld by policy, not by the data, and saying so is
     the point. A card that just went quiet there reads as a broken analysis. */
  function stNoSetupNote(rangePct, native = false, stock = false) {
    if (native) return 'No short-term plan on our own token — long-term zones only.';
    if (rangePct === null || rangePct === undefined) {
      return stock ? 'No swing setup — see the position zones below.'
                   : 'No tradable short-term range right now.';
    }
    /* Equity wording, equity bar, and a pointer rather than a dead end.
       Measured across the live catalogue: the nearest structure around spot on
       a tokenized large-cap is 0.3–1.2% wide and does not widen with a longer
       lookback (AAPL 0.81%, SPY 0.61%, COST 0.40%). "No swing setup" is the
       NORMAL answer for a blue chip, not a fault, and the position zones are
       always quoted — so the line points at them. */
    if (stock) return `No swing setup — 72h band is only ${rangePct.toFixed(1)}% wide. The position zones are the horizon here.`;
    return `No tradable range — 72h band is only ${rangePct.toFixed(1)}% wide.`;
  }

  /* ---------- profile / launch handling ---------- */
  /* The declared asset class on a {chain, address, asset_class} dict. One
     reader, so 'stock' is compared in exactly one place in each language. */
  function assetClassOf(token) {
    if (!token || !token.asset_class) return null;
    return String(token.asset_class).trim().toLowerCase();
  }

  function getTokenProfile(ageDays, assetClass = null) {
    if (assetClass === ASSET_CLASS_STOCK) return PROFILE_STOCK;
    if (ageDays === null || ageDays === undefined) return PROFILE_ESTABLISHED;
    if (ageDays < 14) return PROFILE_FRESH;
    if (ageDays < 60) return PROFILE_EARLY;
    return PROFILE_ESTABLISHED;
  }

  /* A tokenized equity has no launch to strip. Its first on-chain candles are
     an ordinary trading day for a company already priced by an exchange, so
     trimming them deletes real history and manufactures a spike that never
     happened — which also makes detectLaunchSpikeAth answer false for free,
     since it then compares the frame against itself. */
  function stripLaunchCandles(df, ageDays, assetClass = null) {
    if (!df || dfLen(df) === 0) return df;
    const profile = getTokenProfile(ageDays, assetClass);
    if (profile === PROFILE_ESTABLISHED || profile === PROFILE_STOCK) return df;
    const hours = profile === PROFILE_FRESH ? 48 : 24;
    const cutoff = Math.min(...df.t) + hours * 3600 * 1000;
    let start = 0;
    while (start < df.t.length && df.t[start] < cutoff) start++;
    const trimmed = dfSlice(df, start);
    return dfLen(trimmed) >= 20 ? trimmed : df;
  }

  function detectLaunchSpikeAth(dfFull, dfTrimmed) {
    if (!dfFull || !dfTrimmed || dfLen(dfFull) === 0) return false;
    const athFull = maxOf(dfFull.h);
    const athTrim = dfLen(dfTrimmed) > 0 ? maxOf(dfTrimmed.h) : 0;
    return athTrim < athFull * 0.80;
  }

  /* ---------- main analyze ---------- */
  /* `token` is `{chain, address}` when the caller knows which token these
     candles belong to. It changes nothing for any token outside NATIVE_TOKENS
     — it exists so the project's own token can be recognised and carry the
     declared house policy (see applyNativePolicy). */
  /* Hourly bars below which analyze() refuses to produce a reading at all. THE
     floor for the whole product: every surface's "no technical analysis" card
     is this number, and each one reads it from here rather than carrying its
     own copy.

     15 is where the engine stops degrading gracefully and starts guessing.
     Below it the indicators have nothing to work with; at and above it they
     adapt -- the RSI period is `min(14, n/3)` rather than a flat 14, so a
     short series gets a shorter, honest indicator instead of a padded one --
     and the result carries a "limited data" quality label so the caveat
     travels with the card.

     Not to be confused with the 15s and 20s inside individual indicators
     (detectChartPattern's 15, the >= 20 that picks the 4h frame as the long
     one); those are one indicator's own minimum, this is the product's.

     The bot used to gate at 20 in its pipeline while this page gated at 15, so
     a token with 15-19 bars scored here and showed no score in Telegram. Both
     derive from this now. Bot twin: analysis.MIN_ANALYSIS_BARS. */
  const MIN_ANALYSIS_BARS = 15;

  function analyze(df1h, df4h, volMcapRatio = 0, ageDays = null, buys24h = 0, sells24h = 0, token = null) {
    const result = {
      score: 50, profile: PROFILE_ESTABLISHED, launchSpikeAth: false,
      trendLong: 'Sideways', trendLongDetail: '', trendShort: 'Sideways', trendShortDetail: '',
      emaPosition: '', emaCrossSignal: '', emaCrossConfirmed: false,
      rsiValue: null, rsiDivergence: '', stochK: null, stochD: null, stochSignal: '',
      chartPattern: '', chartPatternTone: 'neu',
      stEntryLow: null, stEntryHigh: null, stTpLow: null, stTpHigh: null,
      stNoSetup: false, stNoSetupNative: false, stNoSetupStock: false, stRangePct: null,
      native: false, nativeSymbol: '', nativeLabel: '', nativeBadge: '',
      ltEntryLow: null, ltEntryHigh: null, ltTpLow: null, ltTpHigh: null, ltStretch: false,
      thesis: '', volumeTrendRatio: null,
      pctAboveChartLow: null, pctBelowChartHigh: null, rangePosition: null,
      dataQuality: '', volMcapLabel: '',
      df1Used: null, dfLongUsed: null,
    };

    const assetClass = assetClassOf(token);
    const profile = getTokenProfile(ageDays, assetClass);
    result.profile = profile;

    if (!df1h || dfLen(df1h) < MIN_ANALYSIS_BARS) {
      result.thesis = 'Not enough chart data for analysis.';
      return result;
    }

    const df1 = stripLaunchCandles(df1h, ageDays, assetClass);
    let df4 = null;
    if (df4h) {
      df4 = stripLaunchCandles(df4h, ageDays, assetClass);
      result.launchSpikeAth = detectLaunchSpikeAth(df4h, df4);
    } else {
      result.launchSpikeAth = detectLaunchSpikeAth(df1h, df1);
    }

    const dfLong = (df4 && dfLen(df4) >= 20) ? df4 : df1;
    const n = dfLen(df1);
    const close = df1.c;
    const curPrice = lastOf(close);
    result.dataQuality = `${n} candles${n < 50 ? ' -- limited data' : ''}`;
    result.df1Used = df1;
    result.dfLongUsed = dfLong;

    const sig = {};

    const rp = Math.min(14, Math.floor(n / 3));
    if (n >= rp * 2) {
      const rv = lastOf(calcRsi(close, rp));
      if (!Number.isNaN(rv)) {
        result.rsiValue = Math.round(rv * 10) / 10;
        sig.rsi = rv < 25 ? 1.0 : rv < 35 ? 0.7 : rv < 45 ? 0.2 : rv < 55 ? 0.0 : rv < 65 ? -0.2 : rv < 75 ? -0.7 : -1.0;
      }
    }

    if (n >= 40) {
      const [kArr, dArr] = calcStochRsi(close);
      const kv = lastOf(kArr), dv = lastOf(dArr);
      if (!Number.isNaN(kv) && !Number.isNaN(dv)) {
        result.stochK = Math.round(kv * 10) / 10;
        result.stochD = Math.round(dv * 10) / 10;
        if (kv < 20 && dv < 20) { sig.stoch_rsi = 1.0; result.stochSignal = 'oversold'; }
        else if (kv < 30) { sig.stoch_rsi = 0.5; result.stochSignal = 'oversold'; }
        else if (kv > 80 && dv > 80) { sig.stoch_rsi = -1.0; result.stochSignal = 'overbought'; }
        else if (kv > 70) { sig.stoch_rsi = -0.5; result.stochSignal = 'overbought'; }
        else { sig.stoch_rsi = 0.0; result.stochSignal = 'neutral'; }
      }
    }

    if (n >= 35) {
      const [ml, sl2, hist] = calcMacd(close);
      const hp = hist.length > 1 ? hist[hist.length - 2] : 0;
      const hc = lastOf(hist);
      const vok = volumeConfirmed(df1);
      if (hp < 0 && hc >= 0) sig.macd = vok ? 1.0 : 0.5;
      else if (hp > 0 && hc <= 0) sig.macd = vok ? -1.0 : -0.5;
      else if (lastOf(ml) > lastOf(sl2)) sig.macd = 0.3;
      else sig.macd = -0.3;
    }

    const bp = Math.min(20, Math.floor(n / 2));
    let bbUpperVal = null, bbLowerVal = null;
    if (n >= bp * 2) {
      const [buS, blS] = calcBollinger(close, bp);
      const bu = lastOf(buS), bl = lastOf(blS);
      if (!Number.isNaN(bu) && !Number.isNaN(bl)) {
        bbUpperVal = bu; bbLowerVal = bl;
        const rng = bu - bl;
        if (rng > 0) {
          const pct = (curPrice - bl) / rng;
          sig.bollinger = pct <= 0.10 ? 1.0 : pct <= 0.20 ? 0.5 : pct >= 0.90 ? -1.0 : pct >= 0.80 ? -0.5 : 0.0;
        }
      }
    }

    const [ep, ec, ecv] = analyzeEma(df1);
    result.emaPosition = ep;
    result.emaCrossSignal = ec;
    result.emaCrossConfirmed = ecv;
    const ab = (ep.match(/above/g) || []).length, blC = (ep.match(/below/g) || []).length;
    if (ab + blC > 0) {
      let es = (ab - blC) / (ab + blC);
      if (ec === 'golden cross') es = Math.min(1.0, es + (ecv ? 0.4 : 0.2));
      else if (ec === 'death cross') es = Math.max(-1.0, es - (ecv ? 0.4 : 0.2));
      sig.ema = Math.round(Math.max(-1.0, Math.min(1.0, es)) * 100) / 100;
    }

    const div = detectRsiDivergence(df1);
    result.rsiDivergence = div;
    if (div === 'bullish') sig.rsi_divergence = 1.0;
    else if (div === 'bearish') sig.rsi_divergence = -1.0;

    let support = null, resistance = null;
    try { [support, resistance] = findSupportResistance(df1, Math.max(5, Math.min(10, Math.floor(n / 8)))); } catch (e) {}

    const [pat, patTone] = detectChartPattern(df1);
    result.chartPattern = pat;
    result.chartPatternTone = patTone;
    if (pat.includes('Double Bottom') || pat.includes('Strong base') || pat.includes('Higher lows')) sig.pattern = 0.8;
    else if (pat.includes('Ascending Triangle') || pat.includes('Falling Wedge')) sig.pattern = 0.6;
    else if (pat.toLowerCase().includes('consolidat') || pat.toLowerCase().includes('breakout')) sig.pattern = 0.4;
    else if (pat.includes('Head & Shoulders')) sig.pattern = -0.7;
    else if (pat.includes('Rising Wedge') || pat.toLowerCase().includes('volatility')) sig.pattern = -0.5;
    else sig.pattern = 0.0;

    const [tl, tld] = detectTrendLong(dfLong);
    const [ts, tsd] = detectTrendShort(df1);
    result.trendLong = tl; result.trendLongDetail = tld;
    result.trendShort = ts; result.trendShortDetail = tsd;
    const tlMap = { 'Uptrend': 0.6, 'Weak uptrend': 0.2, 'Sideways': 0.0, 'Weak downtrend': -0.2, 'Downtrend': -0.6 };
    sig.trend_long = tlMap[tl] !== undefined ? tlMap[tl] : 0.0;
    sig.trend_short = ts.includes('Uptrend') ? 0.6 : ts.includes('Downtrend') ? -0.6 : 0.0;

    if (df1.v && n >= 20) {
      const vr = mean(tail(df1.v, 12));
      const vp = n >= 48 ? mean(tail(df1.v, 48).slice(0, 36)) : vr;
      if (vp > 0) {
        const ratio = vr / vp;
        sig.volume_trend = ratio >= 1.5 ? 0.8 : ratio >= 1.1 ? 0.3 : ratio < 0.6 ? -0.5 : 0.0;
        result.volumeTrendRatio = Math.round(ratio * 100) / 100;
      }
    }

    const tt = buys24h + sells24h;
    if (tt > 0) {
      const br = buys24h / tt;
      sig.buy_sell_ratio = br >= 0.65 ? 1.0 : br >= 0.55 ? 0.4 : br <= 0.35 ? -1.0 : br <= 0.45 ? -0.4 : 0.0;
    }

    result.score = weightedScore(sig, profile);

    if (volMcapRatio > 0) {
      if (volMcapRatio > 1.0) result.volMcapLabel = `Very high (${volMcapRatio.toFixed(0)}x mcap) - possible manipulation`;
      else if (volMcapRatio > 0.3) result.volMcapLabel = `High (${Math.round(volMcapRatio * 100)}%) - strong interest`;
      else if (volMcapRatio > 0.05) result.volMcapLabel = `Normal (${Math.round(volMcapRatio * 100)}%)`;
      else result.volMcapLabel = `Low (${Math.round(volMcapRatio * 100)}%) - little activity`;
    }

    /* short-term entry / exit */
    let stSup = null, stRes = null;
    try {
      [stSup, stRes] = findSupportResistance(dfTail(df1, 72), Math.max(3, Math.min(8, Math.floor(n / 10))));
    } catch (e) { stSup = support; stRes = resistance; }

    const r8 = x => Math.round(x * 1e8) / 1e8;
    /* How wide a zone is depends on what is being traded — see ST_ZONE_PADS. */
    const [padEl, padEh, padTl, padTh] = stZonePads(assetClass);
    if (stSup) { result.stEntryLow = r8(stSup * padEl); result.stEntryHigh = r8(stSup * padEh); }
    /* Bollinger fallback: the band edge IS the entry ceiling, so only the floor
       is padded — half the outer pad, for the same reason. */
    else if (bbLowerVal) { result.stEntryLow = r8(bbLowerVal * (1 - (1 - padEl) / 2)); result.stEntryHigh = r8(bbLowerVal); }
    if (stRes) { result.stTpLow = r8(stRes * padTl); result.stTpHigh = r8(stRes * padTh); }
    else if (bbUpperVal) { result.stTpLow = r8(bbUpperVal); result.stTpHigh = r8(bbUpperVal * padTh); }

    /* long-term entry / exit */
    const ltAth = maxOf(dfLong.h);
    let ltSup;
    try {
      [ltSup] = findSupportResistance(dfLong, Math.max(8, Math.min(20, Math.floor(dfLen(dfLong) / 6))));
    } catch (e) { ltSup = support || curPrice * 0.80; }

    const ltBase = stSup ? Math.min(ltSup, stSup) : ltSup;
    result.ltEntryLow = r8(ltBase * 0.95);
    let ltEntryHigh = ltBase * 1.02;
    if (result.stEntryHigh !== null) ltEntryHigh = Math.min(ltEntryHigh, result.stEntryHigh);
    result.ltEntryHigh = r8(ltEntryHigh);

    let resLadder = [];
    try { resLadder = resistanceLadder(dfLong, Math.max(8, Math.min(20, Math.floor(dfLen(dfLong) / 6))), curPrice); } catch (e) {}
    let ltTpLow, ltTpHigh;
    if (resLadder.length >= 2) { ltTpLow = resLadder[0]; ltTpHigh = resLadder[1]; }
    else if (resLadder.length === 1) { ltTpLow = resLadder[0]; ltTpHigh = Math.min(resLadder[0] * 1.5, ltAth * 0.90); }
    else { ltTpLow = ltAth * 1.05; ltTpHigh = ltAth * 1.25; }
    if (resLadder.length) {
      ltTpHigh = Math.min(ltTpHigh, ltAth * 0.90);
      ltTpLow = Math.min(ltTpLow, ltAth * 0.90);
    }
    const ltExitFloor = Math.max(curPrice, result.stTpHigh || 0, result.stTpLow || 0);
    if (ltTpLow <= ltExitFloor) ltTpLow = ltExitFloor * 1.05;
    if (ltTpHigh <= ltTpLow) ltTpHigh = ltTpLow * 1.15;
    result.ltTpLow = r8(ltTpLow);
    result.ltTpHigh = r8(ltTpHigh);
    result.ltStretch = ltTpHigh >= ltAth * 0.85;

    const ath = ltAth, atl = minOf(dfLong.l);
    const pa = (curPrice - ath) / ath * 100;
    const pb = (curPrice - atl) / atl * 100;
    result.pctAboveChartLow = Math.round(pb * 10) / 10;
    result.pctBelowChartHigh = Math.round(Math.abs(pa) * 10) / 10;
    result.rangePosition = ath > atl ? Math.round((curPrice - atl) / (ath - atl) * 1000) / 1000 : 0.5;

    /* Short-term setup guard (v1.24.0). Runs AFTER the long-term block, which
       reads stEntryHigh/stTp* for its own ordering invariants -- suppressing
       earlier would silently change long-term output too. Not repaired by
       widening the zones: there is no higher structure to aim at, so any "fix"
       would invent a resistance the data does not contain. */
    if (result.stEntryHigh !== null && result.stTpLow !== null) {
      if (!stSetupTradable(result.stEntryHigh, result.stTpLow, assetClass)) {
        result.stNoSetup = true;
        result.stNoSetupStock = profile === PROFILE_STOCK;
        result.stRangePct = bandPct(stSup, stRes);
        result.stEntryLow = result.stEntryHigh = null;
        result.stTpLow = result.stTpHigh = null;
      }
    }
    /* The project's own token, last of all: every number above was computed
       for it exactly as for any other token, and the declared adjustment sits
       on top of the finished result rather than inside the indicators. */
    applyNativePolicy(result, nativeTokenFor(token));

    result.thesis = scoreLabel(result.score);

    return result;
  }

  /* Apply the house policy for a token in NATIVE_TOKENS. No-op otherwise.
     1:1 with analysis._apply_native_policy.

     Two effects, both disclosed on the card by `nativeBadge`: the score is
     lifted and floored, so the verdict on our own token never reads worse than
     "Neutral, wait and see"; and the short-term (1d) trade plan is withheld,
     because a +4% scalp range on the token whose own holders are reading the
     card is an instruction to sell it. The long-term zones are untouched.

     Deliberately runs after the long-term block and the short-term guard: both
     read the ST zones for their own invariants, so clearing them any earlier
     would silently move long-term numbers too. */
  function applyNativePolicy(result, native) {
    if (!native) return;
    result.native = true;
    result.nativeSymbol = native.symbol || '';
    result.nativeLabel = native.label || '';
    result.nativeBadge = native.badge || '';
    result.score = nativeScore(result.score);
    result.stNoSetup = true;
    result.stNoSetupNative = true;
    result.stEntryLow = result.stEntryHigh = null;
    result.stTpLow = result.stTpHigh = null;
  }

  /* ---------- labels & categories ---------- */
  function scoreLabel(score) {
    if (score >= 70) return 'Strong buy signal';
    if (score >= 55) return 'Bullish, accumulation zone';
    if (score >= 45) return 'Neutral, wait and see';
    if (score >= 30) return 'Bearish, wait for better entry';
    return 'High risk, avoid for now';
  }

  function rangePositionLabel(pos) {
    if (pos === null || pos === undefined) return '';
    if (pos <= 0.15) return 'near chart low';
    if (pos <= 0.35) return 'lower range';
    if (pos <= 0.65) return 'mid-range';
    if (pos <= 0.85) return 'upper range';
    return 'near chart high';
  }

  function momentumCategory(r) {
    const rsi = r.rsiValue, stoch = r.stochSignal;
    if (rsi === null && !stoch) return ['na', 'not enough data'];
    let bullish = 0, bearish = 0;
    if (rsi !== null) { if (rsi < 35) bullish++; else if (rsi > 65) bearish++; }
    if (stoch === 'oversold') bullish++; else if (stoch === 'overbought') bearish++;
    const tone = bullish && !bearish ? 'pos' : bearish && !bullish ? 'neg' : 'neu';
    const verdict = bullish && !bearish ? 'oversold' : bearish && !bullish ? 'overbought' : 'neutral';
    const parts = [];
    if (rsi !== null) parts.push(`RSI ${rsi.toFixed(0)}`);
    if (stoch) parts.push(`Stoch ${stoch}`);
    return [tone, `${verdict} (${parts.length ? parts.join(', ') : 'n/a'})`];
  }

  function trendCategory(r) {
    const dir = t => t.includes('Uptrend') ? 'up' : t.includes('Downtrend') ? 'down' : 'sideways';
    const dl = dir(r.trendLong), ds = dir(r.trendShort);
    if (dl === ds && dl === 'up') return ['pos', 'uptrend (short & long-term)'];
    if (dl === ds && dl === 'down') return ['neg', 'downtrend (short & long-term)'];
    if (dl === ds) return ['neu', 'sideways (short & long-term)'];
    const tone = ([dl, ds].includes('up') && ![dl, ds].includes('down')) ? 'pos'
               : ([dl, ds].includes('down') && ![dl, ds].includes('up')) ? 'neg' : 'neu';
    return [tone, `short-term ${ds}, long-term ${dl}`];
  }

  function structureCategory(r) {
    const tone = r.chartPattern ? r.chartPatternTone : 'na';
    const pat = r.chartPattern;
    if (!pat) return ['na', 'no clear pattern'];
    for (const sep of [' -- ', ' - ']) {
      if (pat.includes(sep)) {
        const name = pat.slice(0, pat.indexOf(sep));
        const desc = pat.slice(pat.indexOf(sep) + sep.length);
        return [tone, `${name.toLowerCase()}, ${desc.toLowerCase()}`];
      }
    }
    return [tone, pat.toLowerCase()];
  }

  function volumeCategory(r) {
    const v = r.volumeTrendRatio;
    if (v === null || v === undefined) return ['na', 'not enough data'];
    const pct = (v - 1) * 100;
    const sign = pct >= 0 ? '+' : '';
    if (v >= 1.5) return ['pos', `rising sharply (${sign}${pct.toFixed(0)}% vs avg)`];
    if (v >= 1.1) return ['pos', `rising (${sign}${pct.toFixed(0)}% vs avg)`];
    if (v < 0.6) return ['neg', `declining (${sign}${pct.toFixed(0)}% vs avg)`];
    return ['na', 'unremarkable'];
  }

  /* ---------- on-chain sentiment ---------- */
  function onchainSentiment(info) {
    const mcap = +info.market_cap || 0, fdv = +info.fdv || 0, liq = +info.liquidity_usd || 0;
    const notes = [];
    let fdvLabel = '', fdvRisk = '', liqLabel = '', liqRisk = '';
    if (mcap > 0 && fdv > 0) {
      const ratio = fdv / mcap;
      if (ratio < 1.2) { fdvLabel = `FDV ~= MCap (${ratio.toFixed(1)}x) -- fully circulating`; fdvRisk = 'low'; }
      else if (ratio < 2.0) { fdvLabel = `FDV ${ratio.toFixed(1)}x MCap -- moderate unlock risk`; fdvRisk = 'medium'; }
      else if (ratio < 5.0) {
        fdvLabel = `FDV ${ratio.toFixed(1)}x MCap -- significant unlock overhang`; fdvRisk = 'high';
        notes.push('Large FDV vs MCap -- potential future sell pressure from unlocks');
      } else {
        fdvLabel = `FDV ${ratio.toFixed(1)}x MCap -- extreme unlock risk`; fdvRisk = 'high';
        notes.push('Very high FDV ratio -- most supply still locked, heavy dilution risk');
      }
    }
    if (mcap > 0 && liq > 0) {
      const lr = liq / mcap * 100;
      if (lr >= 10) { liqLabel = `Liq ${lr.toFixed(1)}% of MCap -- very healthy`; liqRisk = 'healthy'; }
      else if (lr >= 5) { liqLabel = `Liq ${lr.toFixed(1)}% of MCap -- healthy`; liqRisk = 'healthy'; }
      else if (lr >= 2) {
        liqLabel = `Liq ${lr.toFixed(1)}% of MCap -- low`; liqRisk = 'low';
        notes.push('Low liquidity ratio -- price impact on large trades will be high');
      } else {
        liqLabel = `Liq ${lr.toFixed(1)}% of MCap -- critical`; liqRisk = 'critical';
        notes.push('Critical liquidity -- high rug/manipulation risk');
      }
    }
    return { fdvLabel, fdvRisk, liqLabel, liqRisk, notes };
  }

  /* ---------- fresh launches (1:1 with analysis.py) ----------
     A token needs roughly a day of candles before any of the TA is meaningful.
     Below this age "no chart data" means the token is new; above it the same
     emptiness means the OHLCV source failed, which must NOT be dressed up as a
     fresh launch. Unknown age counts as NOT fresh, deliberately. */
  const FRESH_LAUNCH_MAX_AGE_DAYS = 3.0;

  function isFreshLaunch(info) {
    const age = info && info.age_days;
    if (age === null || age === undefined) return false;
    const n = Number(age);
    return Number.isFinite(n) && n <= FRESH_LAUNCH_MAX_AGE_DAYS;
  }

  const RISK_ICONS = { healthy: '✅', low: '⚠️', medium: '⚠️', high: '⚠️', critical: '🛑' };

  /* Liquidity bands for a tokenized equity, in USD of on-chain depth. An
     EXECUTION read — how much size the listing absorbs — not a health verdict.
     1:1 with _STOCK_LIQ_BANDS in crypto_bot/analysis.py. */
  const STOCK_LIQ_BANDS = [
    [5000,   'very thin, a retail order moves the price'],
    [50000,  'thin, expect slippage on size'],
    [500000, 'moderate depth'],
  ];
  const STOCK_LIQ_DEEP = 'deep enough for retail size';

  function stockLiqNote(liq) {
    for (const [ceiling, note] of STOCK_LIQ_BANDS) if (liq < ceiling) return note;
    return STOCK_LIQ_DEEP;
  }

  /* The on-chain block for a tokenized equity. Everything the generic reader
     says here is wrong for a stock, and wrong in the confident direction:
     "FDV 1.0x MCap — fully circulating" describes the minted supply of a
     wrapper, which is custody inventory the issuer expands and redeems on
     demand — not a cap table, and carrying no unlock overhang. "Liq 0.8% of
     MCap — critical, rug risk" is the same mistake with teeth: nobody can rug
     Apple. What a thin listing DOES cost is slippage, which is an execution
     fact and is what this block reports instead. */
  function stockOnchainRead(info) {
    const out = [];
    const liq = +info.liquidity_usd || 0;
    const vol = +info.volume_24h || 0;

    if (liq > 0) out.push(['\u{1F4A7}', `Liq ${fmtLarge(liq)} — ${stockLiqNote(liq)}`]);
    if (vol > 0) out.push(['\u{1F4E6}', `Vol 24h ${fmtLarge(vol)} on-chain`]);

    const buys = +info.buys_24h || 0, sells = +info.sells_24h || 0;
    if (buys + sells > 0) {
      const pct = buys / (buys + sells) * 100;
      /* "on-chain flow", not "buy pressure": a few hundred swaps is not
         sentiment about the company, and the wording must not imply it is. */
      out.push(['\u{1F4CA}', `${buys} buys / ${sells} sells — ${pct.toFixed(0)}% of on-chain flow`]);
    }
    out.push(['\u{1F3DB}', 'Supply is custodial — held by the issuer, not a cap table']);
    return out;
  }

  function onchainRead(info) {
    if (info && info.asset_class === ASSET_CLASS_STOCK) return stockOnchainRead(info);
    const s = onchainSentiment(info);
    const out = [];
    const dash = t => t.split(' -- ').join(' — ');
    const liq = +info.liquidity_usd || 0;
    const fdv = +info.fdv || 0;

    if (s.liqLabel) {
      out.push([RISK_ICONS[s.liqRisk] || '•', dash(s.liqLabel)]);
    } else if (liq > 0 && fdv > 0) {
      // No market cap reported -- common for a token this young, and it used to
      // remove the liquidity verdict from exactly the cards that need it most.
      // Re-run the same thresholds against FDV rather than duplicating them.
      const alt = onchainSentiment({ ...info, market_cap: fdv });
      if (alt.liqLabel) {
        out.push([RISK_ICONS[alt.liqRisk] || '•',
                  dash(alt.liqLabel).split('of MCap').join('of FDV')]);
      }
    } else if (liq > 0) {
      out.push(['•', `Liq ${fmtLarge(liq)}`]);
    }

    if (s.fdvLabel) out.push([RISK_ICONS[s.fdvRisk] || '•', dash(s.fdvLabel)]);

    const buys = +info.buys_24h || 0, sells = +info.sells_24h || 0;
    if (buys + sells > 0) {
      const pct = buys / (buys + sells) * 100;
      out.push(['\u{1F4CA}', `${buys} buys / ${sells} sells — ${pct.toFixed(0)}% buy pressure`]);
    }
    return out;
  }

  /* ---------- formatting ---------- */
  function fmtPrice(p) {
    if (!p) return '$0';
    if (p < 0.0001) return '$' + p.toFixed(8);
    if (p < 0.01) return '$' + p.toFixed(6);
    if (p < 1) return '$' + p.toFixed(4);
    return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtLarge(x) {
    if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
    if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
    if (x >= 1e3) return '$' + (x / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(x);
  }

  /* ---------- age label (1:1 port of analysis.format_age_label) ---------- */
  // Two units of real precision ("33m old", "1h 35m old", "4d 7h old").
  // Integer minutes, floored -- never Math.round, which would disagree with
  // Python's round-half-to-even on a boundary.
  function formatAgeLabel(ageSeconds) {
    const totalMin = Math.floor(ageSeconds / 60);
    if (totalMin < 1) return '<1m old';
    if (totalMin < 60) return `${totalMin}m old`;
    if (totalMin < 1440) {
      const h = Math.floor(totalMin / 60), m = totalMin % 60;
      return m === 0 ? `${h}h old` : `${h}h ${m}m old`;
    }
    const totalH = Math.floor(totalMin / 60);
    if (totalH < 720) {                                 // < 30d
      const d = Math.floor(totalH / 24), h = totalH % 24;
      return h === 0 ? `${d}d old` : `${d}d ${h}h old`;
    }
    const totalD = Math.floor(totalH / 24);
    if (totalD < 365) {
      const mo = Math.floor(totalD / 30), d = totalD % 30;
      return d === 0 ? `${mo}mo old` : `${mo}mo ${d}d old`;
    }
    const y = Math.floor(totalD / 365), mo = Math.floor((totalD % 365) / 30);
    return mo === 0 ? `${y}y old` : `${y}y ${mo}mo old`;
  }

  /* ---------- token info (DexScreener pair -> info) ---------- */
  function tokenInfo(pair) {
    const base = pair.baseToken || {};
    const chg = pair.priceChange || {};
    const vol = pair.volume || {};
    const liq = pair.liquidity || {};
    const h24 = (pair.txns || {}).h24 || {};

    let ageDays = null, ageLabel = 'Unknown';
    if (pair.pairCreatedAt) {
      const ageSeconds = (Date.now() - pair.pairCreatedAt) / 1000;
      ageDays = ageSeconds / 86400;
      ageLabel = formatAgeLabel(ageSeconds);
    }
    const priceUsd = +pair.priceUsd || 0;
    const volume24 = +(vol.h24 || 0);
    const mcap = +(pair.marketCap || 0);
    return {
      name: base.name || 'Unknown', symbol: base.symbol || '???',
      address: base.address || '', chain: pair.chainId || '', dex: pair.dexId || '',
      pair_address: pair.pairAddress || '',
      price_usd: priceUsd,
      price_change_24h: +(chg.h24 || 0),
      volume_24h: volume24,
      liquidity_usd: +(liq.usd || 0),
      market_cap: mcap,
      fdv: +(pair.fdv || 0),
      buys_24h: +(h24.buys || 0), sells_24h: +(h24.sells || 0),
      age_days: ageDays, age_label: ageLabel,
      vol_mcap_ratio: mcap > 0 ? volume24 / mcap : 0,
      url: pair.url || '',
      x_url: extractXUrl(pair),
    };
  }

  function extractXUrl(pair) {
    const info = pair.info || {};
    for (const s of (info.socials || [])) {
      const t = (s.type || '').toLowerCase(), u = s.url || '';
      if (t === 'twitter' || t === 'x' || u.includes('twitter.com') || u.includes('x.com')) return u;
    }
    for (const w of (info.websites || [])) {
      const u = w.url || '';
      if (u.includes('twitter.com') || (u.includes('x.com') && !u.includes('x.com/i/'))) return u;
    }
    return null;
  }

  /* Chain tag printed in the card header. The Python engine carries the
     identical map as `_CHAIN_TAGS` (crypto_bot/analysis.py) -- the two cards
     are read side by side, so a chain that reads "RH" here and "ROBINHOOD"
     in the bot is exactly the drift the parity rule exists to stop. Adding a
     chain means adding it to BOTH. */
  const CHAIN_TAG = { solana: 'SOL', eth: 'ETH', ethereum: 'ETH', base: 'BASE', bsc: 'BSC', robinhood: 'RH', arbitrum: 'ARB', mantle: 'MNT', arc: 'ARC' };
  const chainTag = c => CHAIN_TAG[(c || '').toLowerCase()] || (c || '').toUpperCase();

  return {
    PROFILE_LABELS, analyze, scoreLabel, rangePositionLabel,
    momentumCategory, trendCategory, structureCategory, volumeCategory,
    onchainSentiment, fmtPrice, fmtLarge, tokenInfo, chainTag,
    getTokenProfile, dfLen, dfTail, stNoSetupNote, isFreshLaunch, onchainRead,
    formatAgeLabel, nativeToken, MIN_ANALYSIS_BARS,
    _internals: { calcRsi, calcStochRsi, calcMacd, calcBollinger, emaSpan, findSupportResistance, resistanceLadder, detectChartPattern, detectTrendLong, detectTrendShort, detectRsiDivergence, weightedScore, swingLows, swingHighs, stSetupUpside, stSetupTradable, bandPct, ST_MIN_UPSIDE_PCT, ST_MIN_UPSIDE_PCT_STOCK, stMinUpsidePct, stZonePads, nativeScore },
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DD;
/*ENGINE-END*/
