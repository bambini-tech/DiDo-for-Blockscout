  /*HOLDERMAP-START*/
  /* ── the holder map and its dossier panel ───────────────────────────────
     Everything between these markers is the shared holder-map implementation:
     the SVG cluster map, the index cards, the drawer (wallets / evidence /
     impact), the filter chips, hide-and-restore and the
     since-your-last-scan memory. The Web Analyzer runs it from here; the
     embeddable widget takes the same source at build time through
     shared/holdermap/extract.mjs, exactly as it takes the analysis engine
     from the ENGINE markers. Never hand-copy it: a vendored second copy is
     invisible to the build gate and drifts in silence.

     What the host page must provide (everything else is self-contained):
       esc(s)         HTML-escape, returning a string
       DD.fmtLarge(n) compact USD formatter, from the analysis engine
       base styles the markup leans on: .mono, .flag, .link-quiet, and the
       design tokens (--ink, --card, --line, --hair, --faint, --mute,
       --hover-bg, --dot, --mono, --shadow-soft, --btn-ink, --role-*)
     The CSS lives in its own HOLDERMAP-CSS block in this file's <style>. */
  const CLUSTER_LETTERS = 'ABCDE';
  const CLUSTER_MIN_PCT = 5.0;   // mirrors cluster.py's CLUSTER_MIN_PCT default
  const CLUSTER_OPACITY = [1, 0.62, 0.44, 0.32, 0.24];

  let holderMapDestroy = null;   // cleanup for the previously mounted map (document-level Esc listener etc.)
  /* The live map's public surface: { selectCluster, setFullscreen }. The
     group cards, the keyboard handlers and both test harnesses
     (tools/audit_holder_panel.mjs, tools/capture_holder_shots.page.html)
     drive the panel through it. */
  let holderMapApi = null;

  const truncAddr = a => (!a || a.length <= 12) ? (a || '') : `${a.slice(0, 4)}…${a.slice(-4)}`;



function holderGroupsLine(clusters) {
  // The groups are separate -- no summed "connected supply", which read as
  // one hand holding it. How many groups, and how big the largest is.
  const n = clusters.length;
  if (!n) return '\u2192 no connected groups among top holders';
  const largest = clusters.reduce((m, c) => Math.max(m, Number(c.pct) || 0), 0);
  const w = clusters.find(c => (Number(c.pct) || 0) === largest);
  // When the biggest group is the project's own supply, say so here rather than
  // leaving the number to speak for itself — this line sits next to the risk
  // grade, and "largest 14.2%" alone reads as the finding.
  // Labels are Blockscout's tags: third-party text, escaped (this line is set as HTML).
  const own = w && w.owner ? ` \u00b7 ${esc(w.owner_label || 'project treasury')}`
    : w && w.label ? ` \u00b7 ${esc(w.label)}${w.exchange && w.label !== 'exchange wallets' ? ', exchange' : ''}` : '';
  return `\u2192 ${n} separate group${n === 1 ? '' : 's'} \u00b7 largest ${largest.toFixed(1)}% (${w && w.wallets ? w.wallets : '?'} wallets${own})`;
}


  /* ---- small helpers for the dossier panel ---- */
  const HM_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const HM_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l18 18M10.6 10.6a2.6 2.6 0 003.7 3.7M6.6 6.7C3.9 8.4 2 12 2 12s3.5 6 10 6c1.6 0 3-.3 4.2-.9M9.5 6.2C10.3 6.1 11.1 6 12 6c6.5 0 10 6 10 6s-.9 1.6-2.6 3.2"/></svg>';

  // "32 s" / "4 min" / "2.5 h" / "3 d" -- a span, not a clock time.
  function fmtSpan(sec) {
    sec = Math.max(0, sec);
    if (sec < 60) return `${Math.round(sec)} s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec < 86400) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`;
    if (sec < 86400 * 30) return `${(sec / 86400).toFixed(sec < 864000 ? 1 : 0)} d`;
    return `${Math.round(sec / 86400 / 30)} mo`;
  }

  /* What changed since this browser last saw this token's holder set. Kept
     in localStorage, private to the viewer, no backend. Groups are matched by
     member overlap, not by letter -- letters are rank order and reshuffle. A
     rescan within five minutes neither reports nor moves the baseline. */
  function holderDelta(fullData, info) {
    const key = `dd-holders:${(info && info.chain) || ''}:${fullData.token || ''}`;
    // Top holders only: group members drawn from below the cap (`beyond`)
    // come and go with the groups and are not "new" or "gone" holders.
    const owners = (fullData.top_owners || []).filter(o => !o.beyond);
    const clusters = (fullData.clusters || []).slice(0, 5);
    let prior = null;
    try { const raw = localStorage.getItem(key); if (raw) prior = JSON.parse(raw); } catch (e) { prior = null; }
    const fresh = prior && Array.isArray(prior.owners) && prior.ts && (Date.now() - prior.ts) < 5 * 60 * 1000;
    if (!fresh) {
      try {
        localStorage.setItem(key, JSON.stringify({
          ts: Date.now(),
          owners: owners.map(o => [o.address, o.pct]),
          clusters: clusters.map(c => ({ members: c.members || [], pct: c.pct || 0 })),
        }));
      } catch (e) { /* storage full or blocked: the map works without a memory */ }
    }
    if (!prior || !Array.isArray(prior.owners) || !prior.ts || fresh) return null;
    const before = new Set(prior.owners.map(x => x[0])), now = new Set(owners.map(o => o.address));
    let added = 0, gone = 0;
    now.forEach(a => { if (!before.has(a)) added++; });
    before.forEach(a => { if (!now.has(a)) gone++; });
    const byCluster = new Map();
    clusters.forEach((c, ci) => {
      const mem = new Set(c.members || []);
      let best = null, bestN = 0;
      (prior.clusters || []).forEach(p => {
        const n = (p.members || []).filter(m => mem.has(m)).length;
        if (n > bestN) { bestN = n; best = p; }
      });
      if (best) byCluster.set(ci, (c.pct || 0) - (best.pct || 0));
    });
    return { ago: `${fmtSpan((Date.now() - prior.ts) / 1000)} ago`, clusters: byCluster, added, gone };
  }

  function holderSignalsHtml(full) {
    const parts = [];
    if (full.fresh_pct != null) parts.push(['fresh', `${full.fresh_pct.toFixed(0)}%`, full.fresh_pct >= 30]);
    if (full.sniper_launch_pct != null || full.sniper_now_pct != null) {
      const label = full.sniper_launch_pct != null
        ? `${full.sniper_launch_pct.toFixed(0)}%&rarr;${(full.sniper_now_pct || 0).toFixed(0)}%`
        : `${full.sniper_now_pct.toFixed(0)}%`;
      parts.push(['snipers', label, (full.sniper_launch_pct || 0) >= 20]);
    }
    if (full.bundle_launch_pct != null || full.bundle_now_pct != null) {
      const label = full.bundle_launch_pct != null
        ? `${full.bundle_launch_pct.toFixed(0)}%&rarr;${(full.bundle_now_pct || 0).toFixed(0)}%`
        : `${full.bundle_now_pct.toFixed(0)}%`;
      parts.push(['bundle', label, (full.bundle_launch_pct || 0) >= 20]);
    }
    if (full.insider_pct != null) parts.push(['insiders', `${full.insider_pct.toFixed(1)}%`, full.insider_pct >= 10]);
    if (!parts.length) return '';
    const flags = parts.map(([k, v, warn]) => `<span class="flag${warn ? ' flag--warn' : ''}">${k} ${v}</span>`).join('');
    return `<div class="flags holder-signals">${flags}</div>`;
  }

  /* How to drive the map, on request rather than permanently.
     This used to be a line of forty words above the panel -- every
     interaction spelled out, read once, then furniture forever. A reader who
     needs it hovers the mark; everyone else gets the panel back. Hover opens
     it on a pointer, focus opens it on a keyboard, and the delegated click
     handler toggles it on a touch screen where there is no hover at all. */
  const HM_HELP_ROWS = [
    ['click', 'a wallet\u2019s menu'],
    ['drag', 'move a bubble'],
    ['scroll', 'zoom'],
    ['\u2190 \u2192', 'cycle groups'],
    ['h', 'hide the hovered wallet'],
    ['f', 'refit the view'],
    ['esc', 'clear the selection'],
  ];
  function holderHelpHtml() {
    return `<span class="hm-help">
      <button type="button" class="holder-map-chip hm-help__btn" data-hm="help"
        aria-expanded="false" aria-label="how to read and drive this map">?</button>
      <span class="hm-help__pop" role="tooltip">${HM_HELP_ROWS.map(
        ([k, v]) => `<span class="hm-help__k mono">${k}</span><span class="hm-help__v">${v}</span>`).join('')}</span>
    </span>`;
  }

  /* The DigitalDon mark, as a path rather than an <img>. The loader fills it
     from the feet up, which needs the geometry -- and the widget serves its
     page under `img-src 'self' data:` on a different origin, so pointing at
     website/assets/ would 404 there. One copy, extracted with the block. */
  const HM_MARK_D = 'M152.6 0Q155.93 0 157.68 0.58Q159.43 1.17 161.58 2.46Q163.73 3.75 165.75 5.92Q167.78 8.09 169.36 11.1Q170.94 14.11 174.11 24.52Q177.28 34.94 180.15 41.25Q183.02 47.56 186.48 52.02Q189.94 56.49 193.38 58.78Q196.82 61.08 198.43 61.52Q200.03 61.96 202.94 61.81Q205.84 61.67 208.02 60.8Q210.2 59.93 213.37 57.33Q216.54 54.73 218.69 51.86Q220.84 48.99 222.71 45.41Q224.57 41.82 227.44 34.37Q230.31 26.91 232.19 20.22Q234.08 13.54 235.65 10.67Q237.23 7.8 239.26 5.77Q241.28 3.75 244.01 2.17Q246.73 0.59 247.76 0.3Q248.79 0 252.41 0Q256.04 0 258.79 1.3Q261.54 2.6 263.28 4.34Q265.02 6.08 266.32 8.69Q267.62 11.29 268.05 14.02Q268.48 16.74 268.05 20.22Q267.62 23.7 262.89 34.82Q258.17 45.95 256.87 50.99Q255.57 56.04 255.57 58.94Q255.57 61.85 256.15 64.46Q256.74 67.07 257.74 68.93Q258.74 70.79 260.48 72.53Q262.22 74.27 264.83 75.57Q267.44 76.87 270.45 77.3Q273.46 77.73 279.09 77.02Q284.72 76.3 291.63 73.13Q298.54 69.97 307.77 64.68Q317.01 59.39 320.48 58.52Q323.94 57.65 327.42 57.8Q330.9 57.94 332.93 58.67Q334.97 59.39 337.57 61.56Q340.17 63.73 341.17 65.31Q342.18 66.89 342.76 68.78Q343.34 70.67 343.34 73.57Q343.34 76.48 342.62 78.66Q341.89 80.83 340.89 82.41Q339.88 83.99 336.28 87.02Q332.67 90.05 323.12 94.51Q313.56 98.98 308.26 102.56Q302.95 106.15 300.93 108.32Q298.9 110.49 297.75 112.49Q296.61 114.5 296.17 117.58Q295.73 120.65 296.17 122.4Q296.61 124.15 297.61 125.87Q298.61 127.59 302.36 130.62Q306.11 133.65 313.73 136.81Q321.36 139.98 330.89 142.28Q340.42 144.58 343.14 145.73Q345.87 146.88 348.02 148.45Q350.17 150.03 352.05 152.35Q353.94 154.66 354.95 157.41Q355.96 160.16 355.68 163.64Q355.39 167.12 354.09 169.44Q352.79 171.76 351.34 173.21Q349.88 174.66 347.59 175.96Q345.3 177.25 341.07 177.97Q336.85 178.7 332.98 177.98Q329.11 177.26 315.09 172.24Q301.07 167.22 297.91 166.65Q294.76 166.08 289.7 166.36Q284.65 166.65 280.17 168.24Q275.7 169.82 263.03 176.69Q250.35 183.56 244.88 185.43Q239.4 187.3 233.17 188.75Q226.94 190.19 226.21 190.78Q225.47 191.37 224.74 192.83Q224.02 194.29 224.02 196.77Q224.02 199.24 225.03 202.42Q226.04 205.61 227.07 206.49Q228.09 207.36 240.91 210.38Q253.74 213.41 263.95 216.86Q274.16 220.31 285.06 225.33Q295.96 230.35 311.07 238.5Q326.18 246.66 332.64 249.1Q339.09 251.54 352.23 255.71Q365.37 259.89 374.98 263.76Q384.59 267.63 389.75 271.08Q394.92 274.52 396.51 276.4Q398.11 278.28 399.97 281.58Q401.84 284.88 402.85 288.35Q403.86 291.82 404.15 297.3Q404.44 302.79 403.29 308.38Q402.14 313.98 399.84 319.17Q397.54 324.36 394.09 329.52Q390.65 334.68 386.9 338.29Q383.16 341.89 379 344.04Q374.84 346.19 371.51 346.92Q368.19 347.64 363.71 347.36Q359.22 347.07 356.19 346.06Q353.15 345.04 349.42 342.89Q345.69 340.74 342.52 337.86Q339.34 334.97 332.6 325.5Q325.86 316.04 316.67 300.75Q307.47 285.45 305.89 283.45Q304.31 281.44 301.14 278.55Q297.97 275.67 294.64 274.37Q291.32 273.07 289.13 273.07Q286.94 273.07 285.19 273.51Q283.45 273.95 281.3 275.24Q279.14 276.53 277.69 278.12Q276.24 279.72 274.8 283.62Q273.35 287.52 272.92 289.95Q272.49 292.39 272.64 295.87Q272.78 299.35 273.64 303.08Q274.5 306.81 277.37 315.66Q280.24 324.52 281.38 330.11Q282.53 335.7 282.96 339.43Q283.39 343.16 283.68 355.1Q283.97 367.04 285.27 371.66Q286.57 376.27 287.86 379Q289.15 381.72 296.61 392.62Q304.06 403.52 311.11 411.57Q318.15 419.62 323.03 423.35Q327.91 427.08 338.61 432.55Q349.31 438.01 353.92 442.19Q358.53 446.37 362.54 451.96Q366.56 457.56 369.14 462.86Q371.72 468.17 372.73 472.5Q373.75 476.83 373.6 480.88Q373.46 484.93 372.59 487.97Q371.72 491.01 370.14 493.88Q368.56 496.74 366.25 499.34Q363.94 501.94 362.36 503.09Q360.78 504.24 357.63 505.67Q354.47 507.11 349.14 508.41Q343.81 509.71 335.35 510.71Q326.88 511.71 312.65 511.71Q298.42 511.71 286.8 510.14Q275.18 508.56 272.43 507.69Q269.68 506.82 266.38 505.1Q263.08 503.38 260.63 501.06Q258.17 498.75 256.88 496.89Q255.59 495.02 254.58 492.87Q253.58 490.72 252.42 486.53Q251.27 482.35 250.84 475.14Q250.41 467.94 251.41 456.61Q252.41 445.28 250.26 435.24Q248.11 425.2 245.52 418.29Q242.93 411.37 241.35 408.94Q239.78 406.5 237.89 404.62Q236.01 402.73 233.29 401.16Q230.56 399.58 225.8 398.28Q221.04 396.98 214.73 396.26Q208.42 395.55 200.5 395.69Q192.57 395.83 185.69 396.98Q178.81 398.13 174.05 400.29Q169.29 402.45 166.4 405.48Q163.51 408.51 160.64 414.84Q157.76 421.18 155.18 431.79Q152.6 442.41 152.45 444.45Q152.31 446.49 153.17 454.78Q154.03 463.06 154.03 469.98Q154.03 476.9 153.31 481.34Q152.6 485.79 151.44 489.12Q150.28 492.44 148.71 495.17Q147.13 497.89 145.39 499.77Q143.65 501.66 140.93 503.52Q138.2 505.38 132.29 507.26Q126.39 509.13 116.2 510.42Q106.02 511.71 95.23 511.86Q84.44 512 75.26 511.28Q66.08 510.57 60.34 509.56Q54.61 508.56 49.56 506.68Q44.51 504.81 41.34 502.21Q38.17 499.61 35.44 495.17Q32.72 490.72 31.85 487.68Q30.98 484.64 30.83 482.03Q30.69 479.41 31.12 475.82Q31.55 472.24 33.43 467.33Q35.3 462.43 38.88 456.55Q42.47 450.67 44.19 448.52Q45.91 446.37 49.8 442.77Q53.69 439.16 57.13 437.01Q60.58 434.86 68.98 430.68Q77.39 426.51 82.55 422.35Q87.72 418.19 91.46 414.15Q95.21 410.12 99.37 404.81Q103.53 399.51 108.12 392.77Q112.71 386.03 115 381.87Q117.3 377.71 118.6 373.95Q119.9 370.2 120.33 367.61Q120.76 365.03 120.76 355.68Q120.76 346.32 121.33 340.29Q121.9 334.27 123.05 329.39Q124.2 324.52 127.78 313.22Q131.37 301.93 131.8 298.92Q132.23 295.91 132.09 293.29Q131.94 290.67 130.64 285.91Q129.34 281.15 128.48 279.72Q127.62 278.28 126.03 276.83Q124.43 275.38 122.11 274.37Q119.79 273.35 117.17 273.21Q114.55 273.07 110.94 274.37Q107.33 275.67 105.61 276.96Q103.89 278.25 100.14 282.42Q96.39 286.6 87.63 301.32Q78.86 316.04 73.84 323.35Q68.82 330.67 66.53 333.39Q64.23 336.12 61.63 338.43Q59.03 340.74 56.02 342.61Q53.01 344.47 49.83 345.63Q46.65 346.78 44.21 347.21Q41.77 347.64 37.43 347.36Q33.09 347.07 29.48 345.77Q25.87 344.47 22.28 341.89Q18.7 339.31 15.38 335.56Q12.06 331.81 9.48 327.65Q6.9 323.5 4.45 317.73Q2.01 311.97 1 306.95Q0 301.93 0.29 297.16Q0.57 292.39 1.87 288.21Q3.17 284.02 5.61 280.29Q8.05 276.56 10.22 274.54Q12.39 272.51 17.84 269.36Q23.29 266.2 31.32 263.05Q39.35 259.89 58.66 253.28Q77.97 246.66 84.42 243.5Q90.87 240.35 98.67 235.92Q106.47 231.49 118.52 225.9Q130.56 220.31 140.63 216.86Q150.7 213.41 161.92 210.82Q173.14 208.24 174.89 207.52Q176.64 206.79 177.66 205.77Q178.68 204.75 179.55 202.42Q180.42 200.1 180.56 197.49Q180.71 194.87 180.27 193.41Q179.83 191.95 178.95 191.07Q178.07 190.19 171.27 188.75Q164.46 187.3 159.85 185.72Q155.23 184.13 144.42 178.12Q133.61 172.12 127.13 169.38Q120.65 166.65 119.07 166.36Q117.49 166.08 112.15 166.36Q106.81 166.65 90.21 172.24Q73.61 177.84 68.55 178.12Q63.5 178.41 60.89 177.54Q58.28 176.67 55.39 174.36Q52.51 172.05 51.22 170.04Q49.93 168.03 49.34 165.71Q48.76 163.39 48.91 161.06Q49.05 158.73 49.77 156.84Q50.5 154.94 51.5 153.51Q52.51 152.08 54.82 150.05Q57.13 148.02 59.86 146.59Q62.58 145.16 72.83 142.57Q83.07 139.98 89.7 137.38Q96.32 134.79 99.33 132.93Q102.35 131.07 104.23 129.18Q106.11 127.3 107.55 124.12Q109 120.94 109 119.18Q109 117.42 108.13 114.96Q107.26 112.49 105.68 110.34Q104.1 108.19 102.51 106.74Q100.91 105.29 96.04 102.13Q91.16 98.98 81.03 94.23Q70.9 89.47 68.02 86.88Q65.13 84.28 63.84 82.12Q62.55 79.97 61.97 77.94Q61.38 75.9 61.38 73.14Q61.38 70.38 62.54 67.49Q63.7 64.59 65.29 62.85Q66.89 61.11 68.75 59.97Q70.62 58.82 72.94 58.24Q75.26 57.65 78.88 57.8Q82.5 57.94 85.97 59.24Q89.44 60.54 100.82 66.83Q112.21 73.12 116.97 75Q121.73 76.87 124.88 77.3Q128.04 77.73 131.23 77.59Q134.42 77.45 136.74 76.86Q139.06 76.28 140.78 75.28Q142.5 74.27 144.1 72.68Q145.69 71.08 146.99 68.62Q148.29 66.15 148.72 63.71Q149.15 61.28 149.01 57.94Q148.87 54.61 146.99 48.56Q145.12 42.51 141.4 34.39Q137.68 26.28 136.96 23.27Q136.25 20.26 136.25 17.5Q136.25 14.74 136.83 12.41Q137.41 10.09 138.56 8.09Q139.71 6.08 142.02 4.05Q144.33 2.03 146.77 1.02Q149.21 0.02 149.23 0.01Q149.26 0 152.6 0Z M189.88 100.25Q183.68 100.97 179.67 101.83Q175.65 102.69 168.02 105.56Q160.39 108.44 157.96 110.02Q155.52 111.6 152.78 114.48Q150.03 117.37 148.88 120.12Q147.72 122.87 147.72 125.63Q147.72 128.39 148.73 130.86Q149.75 133.32 151.18 135.19Q152.61 137.05 154.78 138.94Q156.95 140.82 160.25 142.68Q163.55 144.55 167.59 146.13Q171.63 147.72 175.94 148.87Q180.24 150.01 189.28 151.31Q198.31 152.6 202.79 152.6Q207.27 152.6 212.15 152.02Q217.03 151.45 222.91 150.16Q228.79 148.87 234.26 146.99Q239.74 145.12 243.18 143.26Q246.62 141.39 249.51 138.94Q252.4 136.48 254.55 132.75Q256.7 129.02 256.85 126.52Q257 124.02 255.85 120.84Q254.69 117.66 252.24 114.91Q249.78 112.17 246.48 110.02Q243.18 107.87 240.31 106.58Q237.45 105.29 232.11 103.7Q226.78 102.11 222.05 101.25Q217.31 100.39 213.3 99.96Q209.28 99.53 202.72 99.53Q196.16 99.53 196.12 99.53Q196.09 99.53 189.88 100.25Z';

  /* The window opens empty and fills. Before this, the map section did not
     exist until the cluster call came back, so a twenty-second scan showed a
     paragraph of text and then a panel appeared out of nowhere. Now the frame
     is there from the first click and the mark fills as the two requests
     land -- same wait, but the reader can see what they are waiting for.

     The percentage is honest about being an estimate: it eases toward a
     ceiling per phase and only reaches 100 when the data is actually in
     hand, so it never sits at 99 and never claims to be finished early. */
  function holderLoaderHtml() {
    return `<div class="hm-loader" id="holderLoader">
      <div class="hm-loader__sk hm-loader__sk--rail"><i></i><i></i><i></i><i></i></div>
      <div class="hm-loader__sk hm-loader__sk--bar"></div>
      <div class="hm-loader__c">
        <svg class="hm-loader__mark" viewBox="0 0 404.44 512" aria-hidden="true" focusable="false">
          <defs><clipPath id="hmLoadClip"><rect id="hmLoadRect" x="-10" y="512" width="425" height="512"></rect></clipPath></defs>
          <path class="hm-loader__ghost" fill-rule="evenodd" d="${HM_MARK_D}"></path>
          <path class="hm-loader__fill" fill-rule="evenodd" clip-path="url(#hmLoadClip)" d="${HM_MARK_D}"></path>
        </svg>
        <div class="hm-loader__pct num"><b id="holderLoadPct">0</b><span>%</span></div>
        <div class="hm-loader__lbl mono" id="holderLoadLbl">reading the holder base</div>
          <div class="hm-loader__note" id="holderLoadNote" hidden></div>
      </div>
    </div>`;
  }

  /* Phase ceilings. The bar can only ever approach the ceiling of the phase
     it is in, so arriving early looks fast and arriving late looks slow --
     which is the truth -- and nothing ever moves backwards. */
  const HM_LOAD_PHASES = {
    base: {
      to: 48, rate: 0.02, label: 'reading the holder base',
      after: 14000, note: 'a wide holder base takes longer',
    },
    cluster: {
      /* The slowest easing here, because this is the slow half: the engine
         walks the funding graph of the top forty wallets. It is tuned so the
         figure is still visibly climbing at a minute rather than parked at
         90 -- a number that has stopped moving reads as a hang, and on a
         cold scan of a wide token this phase genuinely takes that long. */
      to: 92, rate: 0.006, label: 'mapping wallet clusters',
      after: 14000, note: 'a cold scan can take a minute',
    },
  };

  function holderLoader(root) {
    if (!root) return { phase() {}, finish(cb) { if (cb) cb(); } };
    const rect = root.querySelector('#hmLoadRect');
    const pctEl = root.querySelector('#holderLoadPct');
    const lblEl = root.querySelector('#holderLoadLbl');
    const noteEl = root.querySelector('#holderLoadNote');
    let shown = 0, ceiling = 0, rate = 0.05, timer = null, stopped = false;
    let phaseAt = 0, phaseCfg = null;
    const paint = () => {
      const p = Math.max(0, Math.min(100, shown));
      if (pctEl) pctEl.textContent = String(Math.round(p));
      // The mark is 512 tall in its own units; the clip rect slides up from
      // below the feet to above the head.
      if (rect) rect.setAttribute('y', String(512 - (512 * p) / 100));
    };
    const tick = () => {
      if (stopped) return;
      shown += (ceiling - shown) * rate;
      paint();
      /* Say so once the wait stops being an ordinary one. Silence through a
         minute is what makes a slow scan feel broken; naming it costs a line
         and is the truth. */
      if (noteEl && phaseCfg && noteEl.hidden && Date.now() - phaseAt > phaseCfg.after) {
        noteEl.textContent = phaseCfg.note;
        noteEl.hidden = false;
      }
    };
    const phase = key => {
      const ph = HM_LOAD_PHASES[key];
      if (!ph || stopped) return;
      ceiling = Math.max(ceiling, ph.to);
      rate = ph.rate;
      phaseCfg = ph;
      phaseAt = Date.now();
      if (noteEl) { noteEl.hidden = true; noteEl.textContent = ''; }
      if (lblEl) lblEl.textContent = ph.label;
      if (!timer) timer = setInterval(tick, 90);
    };
    /* `cb` fires part-way into the fade, not after it: the bubbles' own
       entrance animation is the thing that should be visible through the
       thinning veil. Running it after the fade leaves a blank window for
       half a second, which reads as a second load. */
    const finish = cb => {
      if (stopped) { if (cb) cb(); return; }
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      shown = 100; paint();
      if (lblEl) lblEl.textContent = 'done';
      setTimeout(() => {
        root.classList.add('is-done');
        const wrap = root.closest('.holder-map-wrap');
        if (wrap) wrap.classList.remove('is-loading');
        setTimeout(() => { if (cb) cb(); }, 120);
        setTimeout(() => { if (root.parentNode) root.parentNode.removeChild(root); }, 700);
      }, 260);
    };
    /* Tear-down without the flourish. Every failure path replaces the whole
       panel with an error, which detaches these nodes -- the interval has to
       be cleared or it ticks against nothing for the life of the page. */
    const stop = () => {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    };
    paint();
    return { phase, finish, stop };
  }

  /* The static half of the section -- everything that does not need the
     cluster payload. It is rendered on the first click so the window is
     there while the scan runs; holderSectionFill() drops the numbers in
     when they land, without rebuilding the wrap the loader lives in. */
  function holderSectionShellHtml(loading) {
    return `
      <span class="mono cap holder-map-title">wallet cluster map</span>
      <div class="holder-map-wrap${loading ? ' is-loading' : ''}" id="holderMapWrap">
        <div id="holderMapCanvas" class="holder-map-canvas"></div>
        <div class="holder-tooltip" id="holderTooltip" hidden></div>
        <div class="hm-tl">
          <button type="button" class="holder-map-chip" id="holderFullscreen">fullscreen</button>
          <span class="holder-map-chip hm-summary" id="holderSummary"></span>
        </div>
        <div class="hm-chips" id="holderChips"></div>
        <div class="hm-tr">
          <button type="button" class="holder-map-chip" id="holderMapReset" hidden>reset view</button>
          ${holderHelpHtml()}
        </div>
        <div class="hm-rail" id="holderRail">
          <div class="hm-token" id="holderToken" hidden></div>
          <div class="hm-index" id="holderIndex"></div>
        </div>
        <aside class="hm-drawer" id="holderDrawer" role="dialog" aria-label="cluster dossier" aria-hidden="true"></aside>
        <div class="hm-bar">
          <div class="holder-map-controls">
            <button type="button" class="holder-map-chip" id="holderZoomOut" aria-label="zoom out">&minus;</button>
            <span class="holder-map-chip holder-map-zoomlabel" id="holderZoomLabel">100%</span>
            <button type="button" class="holder-map-chip" id="holderZoomIn" aria-label="zoom in">+</button>
          </div>
        </div>
        ${loading ? holderLoaderHtml() : ''}
      </div>
      <div class="holder-legend" id="holderLegend"></div>
      <div class="holder-map-foot" id="holderMapFoot"></div>
      <div class="holder-export-row" id="holderExportRow" hidden>
        <button type="button" class="link-quiet" id="holderExportPng">export png</button>
        <button type="button" class="link-quiet" id="holderExportCsv">export csv</button>
      </div>
      <div id="holderSignalsSlot"></div>`;
  }

  /* The data half: the groups line, the verdict chips, the export row and the
     signal flags. Written into the shell that is already on screen. */
  function holderSectionFill(root, full) {
    if (!root || !full) return;
    const foot = root.querySelector('#holderMapFoot');
    /* A pending map (the holders before their clusters, see initHolderMap)
       claims nothing it has not measured: no group line, no risk grade, no
       signal flags, no export of a half answer -- just that it is mapping. */
    if (full.pending) {
      if (foot) foot.innerHTML = '<span class="mono">\u2192 mapping wallet clusters\u2026</span>';
      const r = root.querySelector('#holderExportRow');
      if (r) r.hidden = true;
      const sg = root.querySelector('#holderSignalsSlot');
      if (sg) sg.innerHTML = '';
      return;
    }
    const risk = full.bubble_risk || 'Low';
    if (foot) {
      foot.innerHTML = `<span class="mono">${holderGroupsLine(full.clusters || [])}</span>
        <span class="holder-map-foot__flags">
          <span class="flag${risk !== 'Low' ? ' flag--warn' : ''}">bubble risk: ${esc(risk.toUpperCase())}</span>
          ${full.bubble_risk_note ? `<span class="flag flag--own">${esc(full.bubble_risk_note)}</span>` : ''}
        </span>`;
    }
    const row = root.querySelector('#holderExportRow');
    if (row) row.hidden = false;
    const sig = root.querySelector('#holderSignalsSlot');
    if (sig) sig.innerHTML = holderSignalsHtml(full);
  }

  /* The panel's markup. Data-free by design: initHolderMap fills the foot,
     the export row and the signal flags from the payload it is handed, so a
     host that renders this string and then calls init gets the finished
     panel in the two steps it already takes -- and the analyzer, which has a
     twenty-second wait between those two steps, can put a loader in it.
     `full` is accepted and ignored so existing callers keep working. */
  function holderFullSectionHtml(full) {
    return holderSectionShellHtml(false);
  }


  /* ---- deterministic seed + tiny custom force layout (no libraries) ---- */

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function seededPos(id, i, n, W, H) {
    const h = hashStr(id);
    const angle = (h % 1000) / 1000 * Math.PI * 2;
    const radius = 30 + (i / Math.max(1, n)) * (Math.min(W, H) / 2 - 50);
    return { x: W / 2 + radius * Math.cos(angle), y: H / 2 + radius * Math.sin(angle) };
  }

  // Same deterministic scatter, but seeded around a cluster's anchor point so
  // members start inside their own group -- the layout settles into separated
  // blobs instead of one central ball.
  function seededPosAround(id, cx, cy, spread) {
    const h = hashStr(id);
    const angle = (h % 997) / 997 * Math.PI * 2;
    const radius = Math.sqrt(((h >>> 9) % 1024) / 1024) * spread;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  }

  // Andrew's monotone chain. The cluster body itself is drawn by a filter
  // now; the hull only finds where a group's nameplate rests.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const pt = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // Highest tier wins the bubble's fill when a wallet carries several roles.
  // "dev" renders with the same tint as "insider" (cabal-funder red) -- see
  // --role-insider in the palette.
  const ROLE_TIER = { insider: 3, dev: 3, sniper: 2, bundle: 1, fresh: 0 };
  function primaryRole(roles) {
    if (!roles || !roles.length) return null;
    let best = null, bestTier = -1;
    for (const r of roles) {
      const tier = ROLE_TIER[r] ?? -1;
      if (tier > bestTier) { bestTier = tier; best = (r === 'dev') ? 'insider' : r; }
    }
    return best;
  }

  function pctLabelText(pct, r) {
    /* One format, everywhere. The map used to mix `2%`, `1.9%` and `<1%` by
       bubble size, which turned forty labels into noise instead of a column of
       figures. Below the size that can hold a figure there is no label at all
       -- the tooltip and the dossier carry it. */
    if (r < 11) return null;
    return `${pct.toFixed(1)}%`;
  }

  // Pure and reusable so a test harness can exercise the PNG-export var()
  // resolution step without a real canvas/Image.
  function resolveCssVarsInSvgXml(xml, varMap) {
    return xml.replace(/var\((--[a-z-]+)\)/g, (m, name) => (varMap[name] || m));
  }

  /* Progressive maps. A host may draw the holders before their clusters
     exist: pass the base payload with `pending: true` (and no clusters or
     links) and the map shows the bubbles, says it is mapping, and records
     nothing as a visit. When the full payload lands, take
     holderMapApi.snapshot() and init again with `hooks.seed` / `hooks.view`
     from it: every wallet starts where it already is and the camera where it
     already looks, so the clusters gather out of the bubbles on screen
     instead of the map being redrawn. DiDo does this; the analyzer and the
     widget init once, with the full payload, as before.

     `hooks` lets a host that cannot use the native Fullscreen API drive the
     expanded state itself -- an embedded widget in a cross-origin iframe is
     the case that needs it. Pass { onFullscreen(want) } and the button calls
     that instead of the browser; the host then calls back through
     holderMapApi.setFullscreen(on) once it has actually resized. Omit it and
     the native API is used, gated on document.fullscreenEnabled. */
  function initHolderMap(container, fullData, info, hooks) {
    if (holderMapDestroy) { holderMapDestroy(); holderMapDestroy = null; }
    holderMapApi = null;
    if (!container) return;
    // The foot, export row and signal flags come from the same payload, so
    // they are filled here rather than left to every host to remember.
    const section = container.parentNode ? container.parentNode.parentNode : null;
    holderSectionFill(section, fullData);
    // Panel state. One object; applyEmphasis reads it, the dossier renders
    // from it. `hidden` is the viewer's own list, `dtab` the drawer tab.
    const S = { hidden: new Set(), roles: new Set(), minPct: 0, dtab: 'wallets' };

    const owners = fullData.top_owners || [];
    const pending = !!fullData.pending;
    const seedAt = (hooks && hooks.seed) || null;
    if (!owners.length) {
      container.innerHTML = `<p class="xintel__err holder-map-empty">no holder data to map.</p>`;
      return;
    }
    const clusters = (fullData.clusters || []).slice(0, 5);
    const links = fullData.links || [];

    /* ---- Blockscout: what the map claims, one click from its proof ----
       Every address, transaction and the token open in the chain's own
       Blockscout explorer (fullData.explorer), and every address carries the
       label Blockscout gives it ("Binance: Hot Wallet 20"). Labels come from
       the owner rows, and from fullData.labels for the funders and the
       deployer the map names but does not draw. */
    const explorer = /^https:\/\/[^\s"<>]+$/.test(String(fullData.explorer || '')) ? String(fullData.explorer).replace(/\/+$/, '') : '';
    const HEX = /^0x[0-9a-fA-F]+$/;
    const bsHref = (kind, id) => (explorer && HEX.test(String(id || ''))) ? `${explorer}/${kind}/${id}` : '';
    const bsLink = (kind, id, text, cls) => {
      const h = bsHref(kind, id);
      return h ? `<a class="hm-bs${cls ? ` ${cls}` : ''}" href="${esc(h)}" target="_blank" rel="noopener" title="open in Blockscout">${text}</a>` : '';
    };
    const whoBy = new Map(Object.entries(fullData.labels || {}));
    owners.forEach(o => { if (o.label) whoBy.set(o.address, o.label); });
    const whoOf = a => whoBy.get(a) || '';
    /* An address as the evidence shows it: short form, Blockscout label, link. */
    const addrHtml = a => `<b>${esc(truncAddr(a))}</b>${whoOf(a) ? ` <span class="hm-who">${esc(whoOf(a))}</span>` : ''}${bsLink('address', a, '&nearr;')}`;
    const tokenSym = (info && info.symbol && info.symbol !== '???') ? `$${String(info.symbol).toUpperCase()}` : 'the token';
    const nativeSym = fullData.native ? String(fullData.native) : 'native coin';
    // Simulation domain. The camera (see "framing" below) decides how much of
    // it the viewer actually sees, so this stays a fixed coordinate space.
    // viewH is the *viewport* height in those units -- it tracks the panel's
    // real aspect ratio, which both the layout and the camera aim at.
    const W = 560, H = 380;
    let viewH = H;
    const wrap = container.parentElement;

    // Cluster anchors sit on an ellipse around the middle: each group gets its
    // own territory, which is what makes the map scannable once it settles.
    const memberOf = new Map();
    clusters.forEach((c, ci) => (c.members || []).forEach(addr => memberOf.set(addr, ci)));
    const anchorAngles = clusters.map((c, ci) => (ci / Math.max(1, clusters.length)) * Math.PI * 2 - Math.PI / 2);
    let anchors = [];
    function layoutAnchors() {
      anchors = anchorAngles.map(ang => (clusters.length === 1)
        ? { x: W / 2, y: H / 2 }
        : { x: W / 2 + Math.cos(ang) * W * 0.23, y: H / 2 + Math.sin(ang) * Math.min(H, viewH) * 0.25 });
    }
    layoutAnchors();

    /* Group members that rank below the bubble cap: the bot sends them after
       the top rows, flagged `beyond`, so a group is drawn whole instead of
       "3 wallets" with one on the map. `rank` is the wallet's place in the
       whole holder list; older payloads lack it and fall back to list order. */
    const topN = owners.filter(o => !o.beyond).length;
    const rankOf = o => (o && o.rank) || (owners.indexOf(o) + 1);

    const nodeById = new Map();
    const nodes = owners.map((o, i) => {
      const r = Math.max(6, Math.sqrt(Math.max(o.pct, 0.05)) * 9);
      const ci = memberOf.has(o.address) ? memberOf.get(o.address) : -1;
      const seed = (seedAt && seedAt[o.address]) || (ci >= 0
        ? seededPosAround(o.address, anchors[ci].x, anchors[ci].y, 46)
        : seededPos(o.address, i, owners.length, W, H));
      // fundTs: when the wallet was funded (EVM: first native inflow) or,
      // failing that, first seen on chain. Epoch seconds; null when the
      // engine has no timestamp for it. The dossier reads it.
      const fundTs = (typeof o.fund_ts === 'number' && o.fund_ts > 0) ? o.fund_ts
        : (typeof o.first_ts === 'number' && o.first_ts > 0) ? o.first_ts : null;
      return { id: o.address, pct: o.pct, r, x: seed.x, y: seed.y, vx: 0, vy: 0,
               clusterIndex: ci, fixed: false, roles: o.roles || [], isLp: false,
               hidden: false, fundTs, kind: o.kind || null, team: !!o.team,
               beyond: !!o.beyond };
    });
    nodes.forEach(n => nodeById.set(n.id, n));

    // Optional LP/pool bubble -- not a wallet, excluded from clusters/links/export.
    if (fullData.lp_pct != null && fullData.lp_pct > 0) {
      const r = Math.max(6, Math.sqrt(Math.max(fullData.lp_pct, 0.05)) * 9);
      const seed = (seedAt && seedAt.__lp__) || seededPos('__lp__', owners.length, owners.length + 1, W, H);
      nodes.push({ id: '__lp__', pct: fullData.lp_pct, r, x: seed.x, y: seed.y, vx: 0, vy: 0,
                   clusterIndex: -1, fixed: false, roles: [], isLp: true, hidden: false, fundTs: null, kind: null });
    }

    const nodeLinks = links
      .map(l => ({ a: nodeById.get(l.source), b: nodeById.get(l.target), kind: l.kind, reason: l.reason || '', tx: l.tx || '', txA: l.tx_a || '', via: l.via || '', asset: l.asset || '' }))
      .filter(l => l.a && l.b);
    const clusterGroups = clusters.map((c, ci) => ({ nodes: nodes.filter(n => n.clusterIndex === ci) }));
    const largest = nodes.reduce((best, n) => (!n.isLp && (!best || n.pct > best.pct) ? n : best), null);
    // "funder wallet" marker: a node that funded another top holder directly
    // (kind:"funder" edges point target=funder -> source=recipient), or that
    // a cluster names as its dominant funder (funder_is_holder case).
    const funderNodeIds = new Set();
    nodeLinks.forEach(l => { if (l.kind === 'funder') funderNodeIds.add(l.b.id); });
    clusters.forEach(c => { if (c.funder) funderNodeIds.add(c.funder); });
    const fundedCount = new Map();
    nodeLinks.forEach(l => { if (l.kind === 'funder') fundedCount.set(l.b.id, (fundedCount.get(l.b.id) || 0) + 1); });
    // Token-transfer edges (kind:"transfer") are the other directed kind, and
    // the only one whose payload already reads source -> target: the sender
    // moved this token straight to the recipient. Counted per sender for the
    // tooltip, the way funder edges are counted per funder.
    const sentCount = new Map();
    nodeLinks.forEach(l => { if (l.kind === 'transfer') sentCount.set(l.a.id, (sentCount.get(l.a.id) || 0) + 1); });
    // Adjacency, so hovering a wallet can light up everything it is wired to.
    const neighbours = new Map();
    const linkNeighbour = (x, y) => {
      if (!neighbours.has(x)) neighbours.set(x, new Set());
      neighbours.get(x).add(y);
    };
    nodeLinks.forEach(l => { linkNeighbour(l.a.id, l.b.id); linkNeighbour(l.b.id, l.a.id); });

    const svgns = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const e = document.createElementNS(svgns, tag);
      if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };

    container.innerHTML = '';
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'holder-map',
      role: 'img',
      'aria-label': 'Interactive map of the top holders and connected wallet clusters',
    });

    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: 'holderArrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--mute)' }));
    defs.appendChild(marker);

    // Every bubble is filled with a radial gradient lit from the top-left
    // instead of a flat tint -- same palette, but the map reads as spheres
    // with depth rather than stickers. Gradients live in <defs> (attributes,
    // not stylesheet rules) so the PNG export keeps them.
    function sphereFill(id, color, inner, outer) {
      const g = svgEl('radialGradient', { id, cx: '0.36', cy: '0.28', r: '0.94' });
      g.appendChild(svgEl('stop', { offset: '0', 'stop-color': color, 'stop-opacity': String(inner) }));
      g.appendChild(svgEl('stop', { offset: '0.55', 'stop-color': color, 'stop-opacity': String((inner + outer) / 2) }));
      g.appendChild(svgEl('stop', { offset: '1', 'stop-color': color, 'stop-opacity': String(outer) }));
      defs.appendChild(g);
      return `url(#${id})`;
    }
    /* The body carries share of supply and NOTHING else. It used to carry
       cluster membership through ink opacity -- unless the wallet had a role,
       in which case the tint took the whole body and the cluster signal was
       lost. Group identity is the hull's job; role is the rim's. Six reused
       gradients rather than one per wallet, so the sphere shading survives. */
    /* Glass, not paint: the steps stop at about half ink, so even the largest
       holder stays a translucent body with the rim and the highlight on top
       reading through it. Size already carries most of the share. */
    const SHARE_STEPS = [0.08, 0.14, 0.2, 0.27, 0.34, 0.42];
    const shareFills = SHARE_STEPS.map((o, i) =>
      sphereFill(`holderSphereS${i}`, 'var(--ink)', Math.min(1, o * 1.25), o * 0.6));
    const shareMax = Math.max(0.05, ...nodes.filter(n => !n.isLp).map(n => n.pct || 0));
    const shareStep = pct => Math.min(SHARE_STEPS.length - 1, Math.max(0,
      Math.round(Math.pow(Math.min(pct, shareMax) / shareMax, 0.55) * (SHARE_STEPS.length - 1))));
    const roleFill = {};
    ['insider', 'sniper', 'bundle', 'fresh'].forEach(r => {
      roleFill[r] = sphereFill(`holderSphere${r}`, `var(--role-${r})`, 1, 0.42);
    });
    const plainFill = sphereFill('holderSpherePlain', 'var(--ink)', 0.12, 0.02);
    const lpFill = sphereFill('holderSphereLp', 'var(--ink)', 0.06, 0.01);
    /* The glass rim: light along the top edge, fading down the sides and
       catching again at the bottom -- the same top-lit edge the analyzer's
       cards and pills carry. One gradient, every bubble. */
    const rimGrad = svgEl('linearGradient', { id: 'holderGlassRim', x1: '0', y1: '0', x2: '0', y2: '1' });
    [['0', '0.95'], ['0.5', '0.14'], ['1', '0.4']].forEach(([o, a]) =>
      rimGrad.appendChild(svgEl('stop', { offset: o, 'stop-color': '#ffffff', 'stop-opacity': a })));
    defs.appendChild(rimGrad);
    /* Liquid cluster bodies. Every member is drawn as a padded disc in ink,
       blurred together and cut back to a hard edge at an alpha threshold, so
       the group fuses into one body instead of being wrapped in a hull. The
       result is split into a faint fill, an edge and a white glint along the
       top. A strong group gets the firmer edge -- the job the solid-versus-
       dashed hull outline used to do (the nameplate keeps the dash). One
       filter per evidence level, applied per group, never per wallet. The
       region is relative to each group's box; 60% covers the blur's reach
       even for the smallest pair. */
    function gooFilter(id, edgeAlpha) {
      const f = svgEl('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' });
      const add = (tag, attrs) => { const e = svgEl(tag, attrs); f.appendChild(e); return e; };
      add('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '5', result: 'blur' });
      add('feColorMatrix', { in: 'blur', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8', result: 'goo' });
      add('feMorphology', { in: 'goo', operator: 'erode', radius: '0.9', result: 'core' });
      add('feComposite', { in: 'goo', in2: 'core', operator: 'out', result: 'edge' });
      add('feOffset', { in: 'goo', dy: '1.6', result: 'low' });
      add('feComposite', { in: 'goo', in2: 'low', operator: 'out', result: 'top' });
      add('feFlood', { 'flood-color': '#ffffff', 'flood-opacity': '0.55', result: 'white' });
      add('feComposite', { in: 'white', in2: 'top', operator: 'in', result: 'glint' });
      const fill = add('feComponentTransfer', { in: 'goo', result: 'fillA' });
      fill.appendChild(svgEl('feFuncA', { type: 'linear', slope: '0.075' }));
      const edge = add('feComponentTransfer', { in: 'edge', result: 'edgeA' });
      edge.appendChild(svgEl('feFuncA', { type: 'linear', slope: String(edgeAlpha) }));
      const merge = add('feMerge', {});
      ['fillA', 'edgeA', 'glint'].forEach(k => merge.appendChild(svgEl('feMergeNode', { in: k })));
      defs.appendChild(f);
      return `url(#${id})`;
    }
    const gooStrong = gooFilter('holderGooStrong', 0.42);
    const gooWeak = gooFilter('holderGooWeak', 0.2);
    svg.appendChild(defs);

    const viewport = svgEl('g');
    const hullLayer = svgEl('g');
    const linkLayer = svgEl('g');
    const nodeLayer = svgEl('g');
    const labelLayer = svgEl('g');   // cluster tags ride above the bubbles
    viewport.appendChild(hullLayer);
    viewport.appendChild(linkLayer);
    viewport.appendChild(nodeLayer);
    viewport.appendChild(labelLayer);
    svg.appendChild(viewport);
    container.appendChild(svg);

    // Cluster bodies: the group's wallets fused into one liquid shape behind
    // them (see gooFilter). One padded disc per member; render_ moves them.
    const hullEls = clusterGroups.map((grp, ci) => {
      if (grp.nodes.length < 2) return null;
      const g = svgEl('g', { class: 'holder-hull' });
      const strongHull = (clusters[ci] || {}).evidence === 'strong';
      const body = svgEl('g', { filter: strongHull ? gooStrong : gooWeak, 'pointer-events': 'none' });
      const discs = new Map(grp.nodes.map(n => {
        const d = svgEl('circle', { r: String(n.r + 7), fill: 'var(--ink)' });
        body.appendChild(d);
        return [n, d];
      }));
      g.appendChild(body);
      // The tag sits in its own layer above the nodes and carries a
      // card-coloured halo (paint-order), so a bubble drifting underneath it
      // can never swallow the label.
      const tag = svgEl('g', { class: 'holder-hull holder-hull__tag' });
      const plate = svgEl('rect', {
        class: 'holder-hull__plate', x: '-30', y: '-9', width: '60', height: '18', rx: '9',
        fill: 'var(--card)', stroke: 'var(--ink)', 'stroke-opacity': strongHull ? '0.4' : '0.26',
        'stroke-width': '1', 'pointer-events': 'none',
      });
      /* Dashed means circumstantial. The body has no outline left to dash, so
         the nameplate carries it: a strong group's plate is solid, the rest
         dashed, and evidence strength stays legible on the map itself rather
         than only inside the dossier's evidence tab. */
      if (!strongHull) plate.setAttribute('stroke-dasharray', '3 3');
      const label = svgEl('text', {
        'text-anchor': 'middle', y: '3.6', 'font-family': 'ui-monospace, Menlo, monospace',
        'font-size': '10', 'letter-spacing': '0.6', fill: 'var(--ink)', 'fill-opacity': '0.8',
        'pointer-events': 'none',
      });
      // Short form on the map itself: the tag floats free above the group with
      // no room to grow, and the legend, the group card and the foot all spell
      // "project treasury" out in full.
      label.textContent = `${CLUSTER_LETTERS[ci]} · ${(clusters[ci].pct || 0).toFixed(1)}%`
        + (clusters[ci].owner === 'team' ? ' · team' : '');
      // Mono at 10px is ~6px per character; the plate is sized to its own text
      // so "A · 3.0%" and "A · 3.0% · team" both sit centred in a snug pill.
      const plateW = Math.max(52, label.textContent.length * 6 + 18);
      plate.setAttribute('x', String(-plateW / 2));
      plate.setAttribute('width', String(plateW));
      tag.appendChild(plate);
      tag.appendChild(label);
      hullLayer.appendChild(g);
      labelLayer.appendChild(tag);
      return { g, tag, discs, label, plate, grp, anchor: null };
    });

    // Funder links are drawn funder -> recipient (arrowhead at the recipient)
    // even though the payload's {source,target} = {recipient,funder} -- see
    // linkPath()'s endpoint swap below. Token-transfer links are directed too
    // (sender -> recipient, payload already in that order) and drawn heavier:
    // someone moved THIS token between two of the wallets on the map, the
    // strongest link the engine draws. Shared-funder links are undirected.
    const linkEls = nodeLinks.map(l => {
      const isFunder = l.kind === 'funder';
      const isTransfer = l.kind === 'transfer';
      const path = svgEl('path', {
        class: 'holder-link', fill: 'none', 'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      });
      let flow = null;
      if (isTransfer) {
        path.setAttribute('stroke', 'var(--ink)');
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('stroke-opacity', '0.55');
        path.setAttribute('marker-end', 'url(#holderArrow)');
        flow = svgEl('path', {
          class: 'holder-link holder-flow', fill: 'none', stroke: 'var(--ink)',
          'stroke-width': '2', 'stroke-opacity': '0.55', 'stroke-linecap': 'round',
          'stroke-dasharray': '1.5 9', 'vector-effect': 'non-scaling-stroke',
          'pointer-events': 'none',
        });
      } else if (isFunder) {
        path.setAttribute('stroke', 'var(--mute)');
        path.setAttribute('stroke-width', '1.2');
        path.setAttribute('stroke-opacity', '0.5');
        path.setAttribute('marker-end', 'url(#holderArrow)');
        // Second pass over the same curve: a dotted overlay that animates
        // along the path, so funding direction is readable without hovering.
        flow = svgEl('path', {
          class: 'holder-link holder-flow', fill: 'none', stroke: 'var(--ink)',
          'stroke-width': '1.6', 'stroke-opacity': '0.5', 'stroke-linecap': 'round',
          'stroke-dasharray': '1.5 9', 'vector-effect': 'non-scaling-stroke',
          'pointer-events': 'none',
        });
      } else {
        path.setAttribute('stroke', 'var(--mute)');
        path.setAttribute('stroke-width', '1');
        path.setAttribute('stroke-opacity', '0.26');
        path.setAttribute('stroke-dasharray', '2 5');
      }
      linkLayer.appendChild(path);
      if (flow) linkLayer.appendChild(flow);
      return { el: path, flow, l };
    });

    const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const nodeEls = nodes.map((n, i) => {
      const g = svgEl('g', { class: 'holder-node', tabindex: '0', role: 'button' });
      const inner = svgEl('g', { class: 'holder-node__inner' });
      const isClustered = n.clusterIndex >= 0;
      const primary = primaryRole(n.roles);
      const isFunderNode = funderNodeIds.has(n.id);
      const roleTxt = n.roles.length ? `, ${n.roles.join(' + ')}` : '';
      g.setAttribute('aria-label', n.isLp
        ? `Liquidity pool, ${n.pct.toFixed(2)} percent of supply`
        : `${truncAddr(n.id)}, ${n.pct.toFixed(2)} percent${isClustered ? `, cluster ${CLUSTER_LETTERS[n.clusterIndex]}` : ', independent'}${roleTxt}`);

      // Hover halo. Hidden via an attribute (not a stylesheet rule) so the PNG
      // export -- which loses the page's CSS -- never renders it.
      const halo = svgEl('circle', {
        class: 'holder-node__halo', r: String(n.r + 6), fill: 'none',
        stroke: 'var(--ink)', 'stroke-width': '1.2', 'stroke-opacity': '0.4',
        opacity: '0', 'pointer-events': 'none',
      });
      inner.appendChild(halo);

      const circle = svgEl('circle', { class: 'holder-node__body', r: String(n.r) });
      if (n.isLp) {
        circle.setAttribute('fill', lpFill);
        circle.setAttribute('stroke', 'var(--faint)');
        circle.setAttribute('stroke-width', '1.5');
        circle.setAttribute('stroke-dasharray', '4 3');
      } else {
        circle.setAttribute('fill', shareFills[shareStep(n.pct)]);
        circle.setAttribute('stroke', isClustered ? 'var(--ink)' : 'var(--faint)');
        circle.setAttribute('stroke-opacity', isClustered ? '0.42' : '1');
        circle.setAttribute('stroke-width', isClustered ? '1' : '1.4');
      }
      inner.appendChild(circle);
      /* The glass: a top-lit rim just inside the edge and one specular arc
         across the upper left, the analyzer's card highlight in miniature.
         Both are paint only -- the body circle stays the hit target. */
      if (!n.isLp && n.r >= 4) {
        inner.appendChild(svgEl('circle', {
          class: 'holder-node__glass', r: String(Math.max(1, n.r - 0.6)), fill: 'none',
          stroke: 'url(#holderGlassRim)', 'stroke-width': String(Math.min(1.3, Math.max(0.7, n.r * 0.07))),
          'pointer-events': 'none',
        }));
        const ar = n.r * 0.8, a0 = 205 * Math.PI / 180, a1 = 295 * Math.PI / 180;
        inner.appendChild(svgEl('path', {
          class: 'holder-node__glass',
          d: `M${(ar * Math.cos(a0)).toFixed(2)},${(ar * Math.sin(a0)).toFixed(2)} A${ar.toFixed(2)},${ar.toFixed(2)} 0 0 1 ${(ar * Math.cos(a1)).toFixed(2)},${(ar * Math.sin(a1)).toFixed(2)}`,
          fill: 'none', stroke: '#ffffff', 'stroke-opacity': '0.5', 'stroke-linecap': 'round',
          'stroke-width': String(Math.min(2, Math.max(0.8, n.r * 0.1))), 'pointer-events': 'none',
        }));
      }

      /* Role moves to the RIM. It used to be the whole fill, which meant a
         sniper inside cluster A could not also look like a member of cluster A.
         A ring inside the edge plus one pip at one o'clock says the same thing
         and leaves the body free to say how much supply this is. */
      if (primary && !n.isLp) {
        const rw = Math.min(1.7, Math.max(0.9, n.r * 0.085));
        inner.appendChild(svgEl('circle', {
          class: 'holder-node__role', r: String(Math.max(2, n.r - rw / 2)), fill: 'none',
          stroke: `var(--rim-${primary})`, 'stroke-width': String(rw), 'pointer-events': 'none',
        }));
        inner.appendChild(svgEl('circle', {
          class: 'holder-node__pip',
          cx: ((n.r + 2.2) * Math.cos(-1.05)).toFixed(2),
          cy: ((n.r + 2.2) * Math.sin(-1.05)).toFixed(2),
          r: String(Math.min(2.6, Math.max(1.7, n.r * 0.16))),
          fill: `var(--rim-${primary})`, stroke: 'var(--card)', 'stroke-width': '0.9', 'pointer-events': 'none',
        }));
      }

      /* One ring vocabulary. A funder is a single heavier rim with a hub dot
         -- two concentric halos said the same thing twice. The largest wallet
         gets nothing extra at all: it is already the biggest bubble and, now
         that the body encodes share, the darkest one. That pulsing crown was
         a third ring meaning competing with the funder's two. */
      if (isFunderNode && !n.isLp) {
        inner.appendChild(svgEl('circle', {
          r: String(n.r + 1.8), fill: 'none', stroke: 'var(--ink)',
          'stroke-width': '2', 'stroke-opacity': '0.7', 'pointer-events': 'none',
        }));
        inner.appendChild(svgEl('circle', {
          r: '2.6', fill: 'var(--card)', stroke: 'var(--ink)',
          'stroke-width': '1.4', 'pointer-events': 'none',
        }));
      }
      /* A declared project wallet. Marked per WALLET, not per group: supply the
         project holds openly is the opposite of the thing a cluster map exists
         to warn about, and it has to read that way at a glance — including for
         a treasury wallet sitting on its own outside any group. Two crisp ink
         rings, the heaviest marker on the map; the legend names it. */
      /* A group member from below the top holders: one dotted ink ring, so the
         group reads whole while the map still says which wallets are the
         top. Lighter than the treasury's double ring; the legend names it. */
      if (n.beyond && !n.isLp) {
        inner.appendChild(svgEl('circle', {
          class: 'holder-node__beyond', r: String(n.r + 3), fill: 'none',
          stroke: 'var(--ink)', 'stroke-width': '1.2', 'stroke-opacity': '0.55',
          'stroke-dasharray': '1 3', 'stroke-linecap': 'round',
          'pointer-events': 'none',
        }));
      }
      if (n.team && !n.isLp) {
        [[3.2, '0.9', '1.6'], [6.4, '0.4', '1']].forEach(([off, op, w]) => {
          inner.appendChild(svgEl('circle', {
            class: 'holder-node__team', r: String(n.r + off), fill: 'none',
            stroke: 'var(--ink)', 'stroke-width': w, 'stroke-opacity': op,
            'pointer-events': 'none',
          }));
        });
      }

      // Ink on every body: the glass fills stop at half ink, so knocked-out
      // card-coloured type would vanish into the larger bubbles.
      const labelFill = 'var(--ink)';
      if (n.isLp) {
        if (n.r >= 9) {
          const label = svgEl('text', {
            'text-anchor': 'middle', dy: '0.32em',
            'font-family': 'ui-monospace, Menlo, monospace',
            'font-size': String(Math.min(11, n.r * 0.55)),
            fill: 'var(--ink)', 'pointer-events': 'none',
          });
          label.textContent = 'LP';
          inner.appendChild(label);
        }
      } else {
        const pLabel = pctLabelText(n.pct, n.r);
        const showLetter = isClustered && n.r >= 14;
        if (showLetter && pLabel) {
          const text = svgEl('text', {
            'text-anchor': 'middle', 'font-family': 'ui-monospace, Menlo, monospace',
            fill: labelFill, 'pointer-events': 'none',
          });
          const tsLetter = svgEl('tspan', { x: '0', dy: '-0.15em', 'font-size': String(Math.min(11, n.r * 0.5)) });
          tsLetter.textContent = CLUSTER_LETTERS[n.clusterIndex];
          const tsPct = svgEl('tspan', { x: '0', dy: '1.1em', 'font-size': String(Math.min(9, n.r * 0.38)) });
          tsPct.textContent = pLabel;
          text.appendChild(tsLetter); text.appendChild(tsPct);
          inner.appendChild(text);
        } else if (pLabel) {
          const text = svgEl('text', {
            'text-anchor': 'middle', dy: '0.32em',
            'font-family': 'ui-monospace, Menlo, monospace',
            'font-size': String(Math.min(11, n.r * 0.5)),
            fill: labelFill, 'pointer-events': 'none',
          });
          text.textContent = pLabel;
          inner.appendChild(text);
        }
      }
      g.appendChild(inner);
      if (!reducedMotion) {
        g.classList.add('holder-node--enter');
        inner.style.animationDelay = `${Math.min(i, 44) * 16}ms`;
      }
      nodeLayer.appendChild(g);
      return { el: g, n };
    });

    /* ---- geometry ---- */

    // Quadratic arc between two bubbles, trimmed to their rims. Curves read as
    // relationships; straight lines through a dense field read as noise.
    function linkPath(l) {
      const isFunder = l.kind === 'funder';
      const directed = isFunder || l.kind === 'transfer';
      const from = isFunder ? l.b : l.a;   // funder -> recipient when directed
      const to = isFunder ? l.a : l.b;     // transfer: payload is already sender -> recipient
      const dx = to.x - from.x, dy = to.y - from.y;
      const dist = Math.hypot(dx, dy) || 1;
      const bow = Math.min(24, dist * 0.15);
      const cx = (from.x + to.x) / 2 - (dy / dist) * bow;
      const cy = (from.y + to.y) / 2 + (dx / dist) * bow;
      // Tangents of a quadratic curve at its ends point at the control point.
      const inX = cx - from.x, inY = cy - from.y;
      const inL = Math.hypot(inX, inY) || 1;
      const outX = to.x - cx, outY = to.y - cy;
      const outL = Math.hypot(outX, outY) || 1;
      const startTrim = from.r + 2;
      const endTrim = to.r + (directed ? 7 : 2);   // room for the arrowhead
      const sx = from.x + (inX / inL) * startTrim, sy = from.y + (inY / inL) * startTrim;
      const ex = to.x - (outX / outL) * endTrim, ey = to.y - (outY / outL) * endTrim;
      return `M${sx.toFixed(2)},${sy.toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${ex.toFixed(2)},${ey.toFixed(2)}`;
    }

    function boundsOf(list, pad) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of list) {
        const r = n.r + pad;
        if (n.x - r < minX) minX = n.x - r;
        if (n.x + r > maxX) maxX = n.x + r;
        if (n.y - r < minY) minY = n.y - r;
        if (n.y + r > maxY) maxY = n.y + r;
      }
      return { minX, minY, maxX, maxY, ok: isFinite(minX) };
    }

    const HULL_RING = 8;
    function hullGeometry(grpNodes) {
      const pts = [];
      for (const n of grpNodes) {
        const pad = n.r + 15;
        for (let i = 0; i < HULL_RING; i++) {
          const a = (i / HULL_RING) * Math.PI * 2;
          pts.push([n.x + pad * Math.cos(a), n.y + pad * Math.sin(a)]);
        }
      }
      const hull = convexHull(pts);
      // Tag anchor: centred on the blob, resting on its highest point -- the
      // topmost *vertex* alone can sit way off to one side of a lopsided hull.
      let minY = Infinity, sumX = 0;
      for (const p of hull) { if (p[1] < minY) minY = p[1]; sumX += p[0]; }
      const top = hull.length ? [sumX / hull.length, minY] : null;
      return { top };
    }

    // Hidden via an attribute, not a class: the PNG export serialises the SVG
    // without the page's CSS, and a hidden wallet must stay hidden there too.
    const setShown = (el, shown) => { if (shown) el.removeAttribute('display'); else el.setAttribute('display', 'none'); };
    function render_(withHulls) {
      nodeEls.forEach(({ el, n }) => {
        // Two places: zoomed in, a tenth of a unit is a visible pixel step,
        // and the last slow frames of a settle stuttered instead of gliding.
        el.setAttribute('transform', `translate(${n.x.toFixed(2)},${n.y.toFixed(2)})`);
        setShown(el, !n.hidden);
      });
      linkEls.forEach(({ el, flow, l }) => {
        const d = linkPath(l);
        el.setAttribute('d', d);
        if (flow) flow.setAttribute('d', d);
        setShown(el, !(l.a.hidden || l.b.hidden));
        if (flow) setShown(flow, !(l.a.hidden || l.b.hidden));
      });
      if (withHulls === false) return;
      hullEls.forEach(h => {
        if (!h) return;
        const shown = h.grp.nodes.filter(n => !n.hidden);
        setShown(h.g, shown.length >= 2); setShown(h.tag, shown.length >= 2);
        if (shown.length < 2) return;
        h.discs.forEach((d, n) => {
          setShown(d, !n.hidden);
          if (!n.hidden) { d.setAttribute('cx', n.x.toFixed(2)); d.setAttribute('cy', n.y.toFixed(2)); }
        });
        const geo = hullGeometry(shown);
        // +10 lands on the liquid body's top edge: the raw hull is padded
        // wider than the fused discs, and geo.top is measured from it. The
        // plate itself is placed by applyViewport, which is the only place
        // that knows the camera's scale.
        if (geo.top) h.anchor = { x: geo.top[0], y: geo.top[1] + 10 };
      });
    }

    /* ---- keep-out: the host's panes as walls ----
       A host that floats its own panes over a fullscreen map (DiDo docks a
       chart over it) passes their boxes through holderMapApi.setKeepOut, and
       the map's own furniture -- the summary, the chips, the rail, the zoom
       pill, an open dossier -- joins them. While the camera frames the whole
       map, every wall is a box the bubbles settle around (the push in tick)
       and part of what the camera frames, so the cloud fills the room left
       over instead of sliding under a pane. Framing one group, the camera
       aims into the largest free rectangle instead. Off until a host asks:
       the analyzer and the widget are untouched by all of this.
       Client rects in, two forms kept: `vb` in viewBox units (for framing)
       and `sim` in simulation units (for the physics), re-read at most every
       200 ms while the map moves. */
    let keepOutOn = false, keepOutHost = [], keepOutAt = 0;
    let keepOutVb = [], keepOutSim = [];
    const KEEP_OUT_FURNITURE = ['.hm-tl', '.hm-chips', '.hm-tr', '.hm-rail:not(.is-gone)', '.hm-bar .holder-map-controls', '.hm-drawer.is-open'];
    const KEEP_OUT_FILL = 0.93;   // the overview's framing fill, see updateCamera
    function keepOutClientRects() {
      const out = keepOutHost.slice();
      KEEP_OUT_FURNITURE.forEach(sel => wrap.querySelectorAll(sel).forEach(el => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 1 && r.height > 1)) return;
        // Where the piece rests, not where its slide-in is right now: the
        // drawer arrives with a short translate, and measured mid-slide it
        // nudged the camera's aim twice on the way in.
        let ex = 0, ey = 0;
        const tf = getComputedStyle(el).transform;
        if (tf && tf !== 'none' && typeof DOMMatrixReadOnly === 'function') {
          try { const m = new DOMMatrixReadOnly(tf); ex = m.e; ey = m.f; } catch (err) { /* keep the measured box */ }
        }
        out.push({ left: r.left - ex, top: r.top - ey, right: r.right - ex, bottom: r.bottom - ey });
      }));
      return out;
    }
    function wallsActive() { return keepOutOn && follow && focusIdx === null; }
    function refreshKeepOut(force) {
      if (!keepOutOn) { keepOutVb = []; keepOutSim = []; return; }
      const now = Date.now();
      if (!force && now - keepOutAt < 200) return;
      keepOutAt = now;
      const R = svg.getBoundingClientRect();
      if (!(R.width > 0 && R.height > 0)) return;
      // The viewBox is fitted to the element (syncViewBox), but clamped, so
      // allow for a letterbox all the same.
      const k = Math.min(R.width / W, R.height / viewH);
      const ox = R.left + (R.width - W * k) / 2, oy = R.top + (R.height - viewH * k) / 2;
      const mx = W * (1 - KEEP_OUT_FILL) / 2, my = viewH * (1 - KEEP_OUT_FILL) / 2;
      const c = cam;
      keepOutVb = []; keepOutSim = [];
      keepOutClientRects().forEach(r => {
        const v = { x0: (r.left - ox) / k, y0: (r.top - oy) / k, x1: (r.right - ox) / k, y1: (r.bottom - oy) / k };
        if (v.x1 <= 0 || v.y1 <= 0 || v.x0 >= W || v.y0 >= viewH) return;
        keepOutVb.push(v);
        // Clamped to the framed area before it becomes a wall: the camera
        // frames walls too, and a wall reaching past the fill margin would
        // push the frame out a little more on every refresh.
        const cx0 = Math.max(mx, v.x0), cy0 = Math.max(my, v.y0), cx1 = Math.min(W - mx, v.x1), cy1 = Math.min(viewH - my, v.y1);
        if (cx1 - cx0 < 2 || cy1 - cy0 < 2) return;
        keepOutSim.push({ x0: (cx0 - c.tx) / c.scale, y0: (cy0 - c.ty) / c.scale, x1: (cx1 - c.tx) / c.scale, y1: (cy1 - c.ty) / c.scale });
      });
    }
    // The largest box of the viewBox no wall covers, cut greedily one wall at
    // a time. Used to frame one group; falls back to the whole field when the
    // walls leave too little to aim at.
    function freeBox() {
      let b = { x0: 0, y0: 0, x1: W, y1: viewH };
      for (const o of keepOutVb) {
        if (o.x1 <= b.x0 || o.x0 >= b.x1 || o.y1 <= b.y0 || o.y0 >= b.y1) continue;
        const cands = [
          { x0: b.x0, y0: b.y0, x1: Math.min(b.x1, o.x0), y1: b.y1 },
          { x0: Math.max(b.x0, o.x1), y0: b.y0, x1: b.x1, y1: b.y1 },
          { x0: b.x0, y0: b.y0, x1: b.x1, y1: Math.min(b.y1, o.y0) },
          { x0: b.x0, y0: Math.max(b.y0, o.y1), x1: b.x1, y1: b.y1 },
        ].filter(c => c.x1 - c.x0 > 0 && c.y1 - c.y0 > 0);
        if (!cands.length) continue;
        b = cands.reduce((best, c) => ((c.x1 - c.x0) * (c.y1 - c.y0) > (best.x1 - best.x0) * (best.y1 - best.y0) ? c : best));
      }
      return (b.x1 - b.x0) * (b.y1 - b.y0) >= W * viewH * 0.25 ? b : { x0: 0, y0: 0, x1: W, y1: viewH };
    }

    /* ---- force layout ---- */

    // Returns how far the busiest bubble moved this tick (sim units), so the
    // loop can tell a layout that has come to rest from one still settling.
    function tick(alpha) {
      const cx = W / 2, cy = H / 2;
      const live = nodes.filter(n => !n.hidden);   // hidden wallets sit out the physics
      for (const n of live) { n.px = n.x; n.py = n.y; }
      for (const n of live) {
        if (n.fixed) continue;
        const anchor = n.clusterIndex >= 0 ? anchors[n.clusterIndex] : null;
        if (anchor) {
          n.vx += (anchor.x - n.x) * 0.019 * alpha;
          n.vy += (anchor.y - n.y) * 0.019 * alpha;
        } else {
          n.vx += (cx - n.x) * 0.0016 * alpha;
          n.vy += (cy - n.y) * 0.0016 * alpha;
        }
      }
      for (const l of nodeLinks) {
        if (l.a.hidden || l.b.hidden) continue;
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const target = l.a.r + l.b.r + 24;
        const diff = (dist - target) / dist * 0.045 * alpha;
        const fx = dx * diff, fy = dy * diff;
        if (!l.a.fixed) { l.a.vx += fx; l.a.vy += fy; }
        if (!l.b.fixed) { l.b.vx -= fx; l.b.vy -= fy; }
      }
      for (const grp of clusterGroups) {
        const gn = grp.nodes.filter(n => !n.hidden);
        if (gn.length < 2) continue;
        let mx = 0, my = 0;
        for (const n of gn) { mx += n.x; my += n.y; }
        mx /= gn.length; my /= gn.length;
        for (const n of gn) {
          if (n.fixed) continue;
          n.vx += (mx - n.x) * 0.010 * alpha;
          n.vy += (my - n.y) * 0.010 * alpha;
        }
      }
      // Unconnected wallets keep out of cluster territory, so the groups stay
      // legible instead of being peppered with unrelated bubbles.
      for (const n of live) {
        if (n.fixed || n.clusterIndex >= 0) continue;
        for (const a of anchors) {
          const dx = n.x - a.x, dy = n.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist < 96) {
            const f = (96 - dist) / dist * 0.011 * alpha;
            n.vx += dx * f; n.vy += dy * f;
          }
        }
      }
      // Match the cloud's shape to the field's. The camera frames the bounding
      // box, so a square cloud inside a wide panel is framed by its height and
      // leaves dead margins left and right -- a gentle anisotropic push spreads
      // it along the axis with room to spare instead. Self-limiting: once the
      // ratios agree the force is zero.
      const cloud = boundsOf(live, 0);
      if (cloud.ok) {
        const bw = Math.max(1, cloud.maxX - cloud.minX), bh = Math.max(1, cloud.maxY - cloud.minY);
        const want = W / viewH, have = bw / bh;
        const bx = (cloud.minX + cloud.maxX) / 2, by = (cloud.minY + cloud.maxY) / 2;
        // One signed term: positive spreads sideways and draws in vertically,
        // negative does the reverse. Collisions and the domain walls stop it
        // from running away, and it goes quiet as soon as the shapes agree.
        const k = Math.max(-0.05, Math.min(0.05, Math.log(want / have) * 0.03)) * alpha;
        if (Math.abs(k) > 0.0004) {
          for (const n of live) {
            if (n.fixed) continue;
            n.vx += (n.x - bx) * k;
            n.vy -= (n.y - by) * k;
          }
        }
      }
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          const min = a.r + b.r + 5;
          if (dist < min) {
            if (dist < 0.01) dist = 0.01;
            const overlap = (min - dist) / dist * 0.5;
            const ox = dx * overlap, oy = dy * overlap;
            if (!a.fixed) { a.x -= ox; a.y -= oy; }
            if (!b.fixed) { b.x += ox; b.y += oy; }
          }
        }
      }
      // Walls (see keep-out above): a bubble inside one, padded by its radius,
      // is moved toward the nearest side that stays inside the domain. A
      // positional push like the collisions above, so the walls hold however
      // cool the simulation is.
      if (keepOutSim.length && wallsActive()) {
        for (const n of live) {
          if (n.fixed) continue;
          for (const o of keepOutSim) {
            const pad = n.r + 6;
            const x0 = o.x0 - pad, x1 = o.x1 + pad, y0 = o.y0 - pad, y1 = o.y1 + pad;
            if (n.x <= x0 || n.x >= x1 || n.y <= y0 || n.y >= y1) continue;
            const sides = [
              [x0 - n.x, 0, x0 >= n.r], [x1 - n.x, 0, x1 <= W - n.r],
              [0, y0 - n.y, y0 >= n.r], [0, y1 - n.y, y1 <= H - n.r],
            ].filter(sd => sd[2]);
            if (!sides.length) continue;
            const best = sides.reduce((a, b2) => (Math.abs(b2[0]) + Math.abs(b2[1]) < Math.abs(a[0]) + Math.abs(a[1]) ? b2 : a));
            n.x += best[0] * 0.35; n.y += best[1] * 0.35;
            if (best[0]) n.vx = 0;
            if (best[1]) n.vy = 0;
          }
        }
      }
      let moved = 0;
      for (const n of live) {
        if (n.fixed) continue;
        n.vx *= 0.8; n.vy *= 0.8;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(n.r, Math.min(W - n.r, n.x));
        n.y = Math.max(n.r, Math.min(H - n.r, n.y));
        moved = Math.max(moved, Math.abs(n.x - n.px) + Math.abs(n.y - n.py));
      }
      return moved;
    }

    /* ---- framing: the map fills its field by itself ----
       The bubbles are laid out in a fixed W x H space, but nobody wants to
       stare at a small constellation floating in the middle of a big panel.
       A camera tracks the bounding box of whatever is worth looking at (every
       node, or one cluster when it is selected) and eases the viewport onto
       it. The user taking over -- wheel, pinch, pan, drag -- switches the
       camera off until they ask for a refit. */

    const zoomLabel = document.getElementById('holderZoomLabel');
    const resetBtn = document.getElementById('holderMapReset');
    const view = Object.assign({ scale: 1, tx: 0, ty: 0 }, (hooks && hooks.view) || {});
    const cam = { scale: 1, tx: 0, ty: 0 };
    let fitScale = 1, follow = true, focusIdx = null;

    function clampScale(s) {
      const f = fitScale || 1;
      return Math.max(Math.min(0.5, f * 0.5), Math.min(f * 6, s));
    }
    let pxPerUnit = 1;
    function applyViewport() {
      // Full precision: a scale rounded to 3 places moves the far side of a
      // zoomed map in whole-pixel steps while the translate creeps smoothly,
      // and the picture shivers as the camera lands.
      viewport.setAttribute('transform', `translate(${view.tx.toFixed(3)},${view.ty.toFixed(3)}) scale(${view.scale.toFixed(5)})`);
      /* Nameplates ride inside the transformed viewport so they stay glued to
         their group, but they are counter-scaled so their type never grows.
         Before this they were plain SVG text in the same space as the bubbles,
         which made a zoomed-in group's label the largest object on screen. */
      const inv = 1 / ((view.scale || 1) * (pxPerUnit || 1));
      hullEls.forEach(h => {
        if (!h || !h.anchor) return;
        h.tag.setAttribute('transform',
          `translate(${h.anchor.x.toFixed(2)},${h.anchor.y.toFixed(2)}) scale(${inv.toFixed(5)})`);
      });
      // 100% is "the whole map, framed" -- the number people actually care
      // about is how far in they are relative to that, not the raw transform.
      // Written only on change: this runs every animation frame, and a text
      // write outside the SVG costs the page a layout each time.
      const zl = `${Math.round((view.scale / (fitScale || 1)) * 100)}%`;
      if (zoomLabel && zoomLabel.textContent !== zl) zoomLabel.textContent = zl;
      const rh = follow && focusIdx === null;
      if (resetBtn && resetBtn.hidden !== rh) resetBtn.hidden = rh;
    }
    // The SVG viewBox follows the element's real aspect ratio, so a fullscreen
    // map uses the whole screen instead of letterboxing a 560x380 window.
    function syncViewBox() {
      const rect = svg.getBoundingClientRect();
      // One user unit in CSS pixels. The nameplates counter-scale by this as
      // well as by the camera, or they grow with the window as well as the zoom.
      pxPerUnit = rect.width > 0 ? rect.width / W : 1;
      const ar = (rect.width > 0 && rect.height > 0) ? rect.width / rect.height : W / H;
      const next = Math.max(200, Math.min(900, Math.round(W / ar)));
      if (next === viewH) return false;
      viewH = next;
      svg.setAttribute('viewBox', `0 0 ${W} ${viewH}`);
      layoutAnchors();   // the field changed shape -- so should the layout
      return true;
    }
    const shownNodes = () => nodes.filter(n => !n.hidden);
    function framedNodes() {
      const all = shownNodes();
      if (focusIdx === null) return all;
      const grp = clusterGroups[focusIdx];
      const g = grp ? grp.nodes.filter(n => !n.hidden) : [];
      return g.length ? g : all;
    }
    // `walls` (simulation units) are framed with the bubbles; `box` (viewBox
    // units) is where to aim, the whole field when absent.
    function frameFor(list, fill, walls, box) {
      // +12: rings, halos and hull padding all live outside a node's radius.
      const b = boundsOf(list, 12);
      if (!b.ok) return { scale: 1, tx: 0, ty: 0 };
      (walls || []).forEach(o => {
        b.minX = Math.min(b.minX, o.x0); b.minY = Math.min(b.minY, o.y0);
        b.maxX = Math.max(b.maxX, o.x1); b.maxY = Math.max(b.maxY, o.y1);
      });
      const f = box || { x0: 0, y0: 0, x1: W, y1: viewH };
      const fw = f.x1 - f.x0, fh = f.y1 - f.y0;
      const bw = Math.max(40, b.maxX - b.minX), bh = Math.max(40, b.maxY - b.minY);
      const s = Math.max(0.5, Math.min(3.4, Math.min((fw * fill) / bw, (fh * fill) / bh)));
      return { scale: s, tx: (f.x0 + f.x1) / 2 - ((b.minX + b.maxX) / 2) * s, ty: (f.y0 + f.y1) / 2 - ((b.minY + b.maxY) / 2) * s };
    }
    /* `soft` is the per-frame re-aim while the bubbles settle. A settling
       cloud's bounding box twitches by fractions of a unit every frame
       (collisions, the shape push), and a camera that chased every twitch
       never came to rest: it shivered for seconds after each zoom. So once
       the layout has cooled past its big moves, a soft re-aim only lands when
       the frame is meaningfully off -- otherwise the camera holds still.
       Everything else (a refit, hidden wallets, walls, a resize) re-aims hard. */
    const CAM_HOLD_SCALE = 0.025, CAM_HOLD_SHIFT = W * 0.012;
    function updateCamera(soft) {
      const walls = wallsActive() ? keepOutSim : null;
      const fit = frameFor(shownNodes(), KEEP_OUT_FILL, walls);
      const t = focusIdx === null ? fit : frameFor(framedNodes(), 0.62, null, keepOutOn ? freeBox() : null);
      if (soft && alpha < 0.3 && Math.abs(Math.log(t.scale / cam.scale)) < CAM_HOLD_SCALE
        && Math.abs(t.tx - cam.tx) < CAM_HOLD_SHIFT && Math.abs(t.ty - cam.ty) < CAM_HOLD_SHIFT) return;
      fitScale = fit.scale;
      cam.scale = t.scale; cam.tx = t.tx; cam.ty = t.ty;
    }
    /* One step of the camera toward its target, `k` of the way (time-based,
       see frame). A change of zoom is flown as a straight dolly about the one
       screen point both views agree on -- for a wheel notch that is the
       cursor -- with the scale eased in log space, so a zoom reads as moving
       in, not as a slide plus a swell. A pure pan just glides. */
    function stepCamera(k) {
      const s0 = view.scale, ls = Math.log(cam.scale / s0);
      const dx = cam.tx - view.tx, dy = cam.ty - view.ty;
      if (Math.abs(ls) < 0.0004 && Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) {
        if (ls || dx || dy) { view.scale = cam.scale; view.tx = cam.tx; view.ty = cam.ty; applyViewport(); }
        return false;
      }
      if (Math.abs(ls) > 0.002) {
        const d = cam.scale - s0;
        const px = (cam.scale * view.tx - s0 * cam.tx) / d, py = (cam.scale * view.ty - s0 * cam.ty) / d;
        const s = s0 * Math.exp(ls * k);
        view.tx = px - (px - view.tx) * (s / s0);
        view.ty = py - (py - view.ty) * (s / s0);
        view.scale = s;
      } else {
        view.scale += (cam.scale - s0) * k; view.tx += dx * k; view.ty += dy * k;
      }
      applyViewport();
      return true;
    }
    function snapCamera() {
      updateCamera();
      view.scale = cam.scale; view.tx = cam.tx; view.ty = cam.ty;
      applyViewport();
    }
    function takeOver() {
      glide = false;
      if (!follow) return;
      follow = false;
      applyViewport();
    }
    let wallsMoved = false;   // walls changed while they were not pushing (setKeepOut)
    function refit(idx) {
      focusIdx = (idx === undefined) ? focusIdx : idx;
      follow = true; glide = false;
      if (wallsMoved && wallsActive()) { wallsMoved = false; alpha = Math.max(alpha, 0.35); }
      updateCamera();
      ensureFrame();
    }

    syncViewBox();
    applyViewport();

    /* ---- animation loop ---- */

    // A seeded map is already laid out: it only has to settle into groups.
    let rafId = null, alpha = seedAt ? 0.55 : 1;
    // `glide`: a wheel zoom eases onto its target like the camera does, though
    // the viewer is driving (follow is off). `lastTs` times the camera's steps.
    let glide = false, lastTs = 0, quiet = 0;
    function stopSim() { if (rafId) cancelAnimationFrame(rafId); rafId = null; lastTs = 0; }
    function ensureFrame() { if (!rafId) rafId = requestAnimationFrame(frame); }
    function reheat() { alpha = Math.max(alpha, 0.7); quiet = 0; ensureFrame(); }
    // The camera's time constant: ~95% of a move in a quarter second, then it
    // lands. Time-based, so a slow frame does not stall the move and then jump.
    const CAM_TAU = 0.085;
    function frame(ts) {
      rafId = null;
      const dt = lastTs && ts > lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 1 / 60;
      const simming = alpha > 0.02;
      if (keepOutOn) refreshKeepOut(false);
      if (simming) {
        const moved = tick(alpha);
        // The tail cools quicker than the start: below ~0.12 the forces only
        // nudge, and a long faint tail is what read as bubbles that never
        // quite stop. Once nothing moves more than a hair for a few frames in
        // a row, the layout is at rest and the simulation ends there.
        alpha *= alpha > 0.12 ? 0.985 : 0.95;
        quiet = (alpha < 0.3 && moved < 0.02) ? quiet + 1 : 0;
        if (quiet >= 6) alpha = 0;
      }
      if (follow) updateCamera(true);
      const panning = (follow || glide) ? stepCamera(1 - Math.exp(-dt / CAM_TAU)) : false;
      if (!panning) glide = false;
      // Bubbles only move while the simulation runs (a drag renders itself).
      if (simming) render_(true);
      if (simming || panning) { lastTs = ts; rafId = requestAnimationFrame(frame); } else lastTs = 0;
    }

    if (reducedMotion) {
      let a = 1;
      for (let i = 0; i < 260; i++) { tick(a); a *= 0.985; }
      render_();
      snapCamera();
    } else {
      render_();
      ensureFrame();
    }
    const onVisibility = () => { if (document.hidden) stopSim(); else ensureFrame(); };
    document.addEventListener('visibilitychange', onVisibility);

    const resizeObs = ('ResizeObserver' in window) ? new ResizeObserver(() => {
      if (!syncViewBox()) return;
      // Re-settle into the new shape, unless the viewer is driving the camera
      // themselves -- then moving the bubbles under them would be rude.
      if (follow) { reheat(); updateCamera(); } else applyViewport();
    }) : null;
    if (resizeObs) resizeObs.observe(container);

    /* ---- interactions: hover tooltip, click-select, drag, pan/zoom, keyboard ---- */
    const tooltip = document.getElementById('holderTooltip');

    function showTooltip(n, clientX, clientY) {
      if (menuId !== null) return;   // the open menu already says it
      if (!tooltip) return;
      const wrapRect = wrap.getBoundingClientRect();
      if (n.isLp) {
        tooltip.innerHTML = `<strong>liquidity pool</strong><span>${n.pct.toFixed(2)}% of supply</span>`;
      } else {
        const fc = fundedCount.get(n.id);
        const sc = sentCount.get(n.id);
        const funderTxt = [
          fc ? `funder of ${fc} wallet${fc > 1 ? 's' : ''}` : null,
          sc ? `sent tokens to ${sc} wallet${sc > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(' · ') || null;
        const clusterTxt = n.clusterIndex >= 0 ? `cluster ${CLUSTER_LETTERS[n.clusterIndex]}` : 'independent';
        const roleTxt = n.roles.length ? n.roles.join(' &middot; ') : null;
        const whenTxt = (n.fundTs != null && launchTs)
          ? (n.fundTs >= launchTs ? `funded ${fmtSpan(n.fundTs - launchTs)} after launch` : `active ${fmtSpan(launchTs - n.fundTs)} before launch`)
          : null;
        const beyondTxt = n.beyond ? `holder #${rankOf(ownerById.get(n.id))} &middot; outside the top ${topN}, shown with its group` : null;
        const whoTxt = whoOf(n.id) ? `<span class="hm-tip-who">${esc(whoOf(n.id))}${(ownerById.get(n.id) || {}).exchange ? ' &middot; exchange' : ''}</span>` : '';
        tooltip.innerHTML = `<strong>${esc(truncAddr(n.id))}</strong>${whoTxt}${n.team ? '<span class="hm-tip-own">project treasury &middot; not for sale</span>' : ''}${beyondTxt ? `<span>${beyondTxt}</span>` : ''}<span>${n.pct.toFixed(2)}% &middot; ${clusterTxt}${n.kind ? ` &middot; ${esc(n.kind)}` : ''}</span>${roleTxt ? `<span>${roleTxt}</span>` : ''}${funderTxt ? `<span>${esc(funderTxt)}</span>` : ''}${whenTxt ? `<span>${esc(whenTxt)}</span>` : ''}`;
      }
      tooltip.hidden = false;
      // Flip near the edges -- the wrap clips its overflow, so a tooltip that
      // runs off the panel is a tooltip nobody can read.
      const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
      let x = clientX - wrapRect.left + 16, y = clientY - wrapRect.top + 16;
      if (x + tw > wrapRect.width - 8) x = clientX - wrapRect.left - tw - 16;
      if (y + th > wrapRect.height - 8) y = clientY - wrapRect.top - th - 16;
      tooltip.style.left = `${Math.max(8, x)}px`;
      tooltip.style.top = `${Math.max(8, y)}px`;
    }
    function hideTooltip() { if (tooltip) tooltip.hidden = true; }

    /* ---- emphasis: one place decides what is lit and what recedes ----
       Three things can ask for focus -- the legend (hover a swatch), the map
       (hover a bubble) and the cluster list (select a cluster). They are
       resolved in that order so they can never fight each other. */
    let selected = null, hoverId = null, legendKey = null;
    // The wallet picked by a click on its bubble (or its address in a group's
    // list): the drawer shows that wallet's card instead of a group.
    let pickedId = null;
    // The wallet whose context menu is open (a click on its bubble). Nothing
    // runs until an item in the menu is chosen.
    let menuId = null;
    const onWallet = hooks && typeof hooks.onWallet === 'function' ? hooks.onWallet : null;
    const walletOk = hooks && typeof hooks.walletOk === 'function' ? hooks.walletOk : () => true;

    function nodeMatchesLegend(n, key) {
      const [kind, val] = key.split(':');
      if (kind === 'role') return primaryRole(n.roles) === val;
      if (val === 'holder') return !n.isLp && n.clusterIndex >= 0 && !primaryRole(n.roles);
      if (val === 'independent') return !n.isLp && n.clusterIndex < 0 && !primaryRole(n.roles);
      if (val === 'funder') return funderNodeIds.has(n.id);
      if (val === 'team') return !!n.team;
      if (val === 'beyond') return !!n.beyond;
      if (val === 'lp') return !!n.isLp;
      return false;
    }
    function applyEmphasis() {
      let keepNode = null, keepLink = null, hot = null;
      if (legendKey) {
        if (legendKey.indexOf('edge:') === 0) {
          const wantKind = legendKey === 'edge:funder' ? 'funder'
            : legendKey === 'edge:transfer' ? 'transfer' : 'shared_funder';
          keepLink = l => l.kind === wantKind;
        } else {
          keepNode = n => nodeMatchesLegend(n, legendKey);
        }
      } else if (hoverId || menuId || pickedId) {
        const fid = hoverId || menuId || pickedId;
        const hovered = nodeById.get(fid);
        const nb = neighbours.get(fid) || new Set();
        const grp = hovered && hovered.clusterIndex >= 0 ? hovered.clusterIndex : null;
        keepNode = n => n.id === fid || nb.has(n.id) || (grp !== null && n.clusterIndex === grp);
        keepLink = l => l.a.id === fid || l.b.id === fid;
        hot = n => n.id === fid || nb.has(n.id);
      } else if (selected !== null) {
        keepNode = n => n.clusterIndex === selected;
        keepLink = l => l.a.clusterIndex === selected && l.b.clusterIndex === selected;
      }
      // Filter chips are persistent, unlike the legend's hover: a wallet that
      // fails them recedes until the chip is turned off again.
      const filtering = S.roles.size > 0 || S.minPct > 0;
      const passes = n => n.isLp || ((!S.roles.size || n.roles.some(r => S.roles.has(r))) && n.pct >= S.minPct);
      nodeEls.forEach(({ el, n }) => {
        el.classList.toggle('is-dim', (!!keepNode && !keepNode(n)) || (filtering && !passes(n)));
        el.classList.toggle('is-hot', !!hot && hot(n));
      });
      linkEls.forEach(({ el, flow, l }) => {
        const dim = (!!keepLink && !keepLink(l)) || (filtering && !(passes(l.a) && passes(l.b)));
        el.classList.toggle('is-dim', dim);
        el.classList.toggle('is-hot', !!keepLink && !dim);
        if (flow) { flow.classList.toggle('is-dim', dim); flow.classList.toggle('is-hot', !!keepLink && !dim); }
      });
      hullEls.forEach((h, ci) => {
        if (!h) return;
        const dim = (selected !== null && selected !== ci) ||
                    (legendKey !== null) ||
                    ((hoverId || menuId || pickedId) !== null && (nodeById.get(hoverId || menuId || pickedId) || {}).clusterIndex !== ci);
        h.g.classList.toggle('is-dim', dim);
        h.tag.classList.toggle('is-dim', dim);
      });
    }

    function applySelection() {
      applyEmphasis();
      wrap.classList.toggle('has-drawer', selected !== null || pickedId !== null);
      renderIndex();
      renderDrawer();
    }
    function selectCluster(idx) {
      pickedId = null;
      if (menuId !== null) { menuId = null; ctx.hidden = true; }
      selected = (idx === null || idx === selected) ? null : idx;
      applySelection();
      // Selecting a cluster flies the camera to it; clearing the selection
      // only refits if the camera was still driving itself, so a viewer who
      // panned somewhere on purpose keeps their view.
      if (selected !== null) refit(selected);
      else if (follow) refit(null);
      else { focusIdx = null; applyViewport(); }
    }
    /* One wallet, picked: its card in the drawer, it and everything it is
       wired to lit on the map. Picking it again, or anything else, lets go. */
    function selectWallet(addr) {
      const n = addr ? nodeById.get(addr) : null;
      pickedId = (!n || n.isLp || addr === pickedId) ? null : addr;
      selected = null;
      applySelection();
    }
    /* The bubble's context menu: a small panel beside the bubble with the
       wallet's rank, share and what it is worth, and what can be done with
       it -- scan it (the host's onWallet, where offered), see its card,
       open its group, copy, hide. A click on a bubble opens this and nothing
       else; a click on the empty field, Esc, a pan or a zoom closes it. */
    wrap.querySelectorAll('.hm-ctx').forEach(el => el.remove());   // a previous init's
    const ctx = document.createElement('div');
    ctx.className = 'hm-ctx';
    ctx.hidden = true;
    ctx.setAttribute('role', 'menu');
    wrap.appendChild(ctx);
    function closeMenu() {
      if (menuId === null) return;
      menuId = null;
      ctx.hidden = true;
      applyEmphasis();
    }
    function openMenu(n, viaKeyboard) {
      if (!n || n.isLp) { closeMenu(); return; }
      const o = ownerById.get(n.id);
      if (!o) { closeMenu(); return; }
      menuId = n.id;
      const rank = rankOf(o), pct = +o.pct || 0, ci = n.clusterIndex;
      const facts = [];
      if (market.mcap > 0) {
        const value = pct / 100 * market.mcap;
        facts.push(`holds ${esc(DD.fmtLarge(value))}`);
        if (market.liq > 0) {
          const impact = value / (market.liq / 2 + value);
          facts.push(`sells &minus;${Math.max(0.1, impact * 100).toFixed(impact < 0.1 ? 1 : 0)}%`);
        }
      }
      if ((n.roles || []).length) facts.push(esc(n.roles.map(r => ROLE_WORDS[r] || r).join(', ')));
      const item = (act, label, extra) =>
        `<button type="button" role="menuitem" class="hm-ctx__i" data-hm="${act}" data-addr="${esc(n.id)}"${extra || ''}>${label}</button>`;
      const items = [
        onWallet && walletOk(n.id) ? item('wallet-open', 'scan wallet <span>&rarr;</span>') : '',
        item('pick', 'details'),
        ci >= 0 ? item('cluster', `cluster ${CLUSTER_LETTERS[ci]} <span>${(+clusters[ci].pct || 0).toFixed(1)}%</span>`, ` data-idx="${ci}"`) : '',
        item('copy', 'copy address'),
        item('hide', 'hide'),
      ].join('');
      ctx.innerHTML = `<div class="hm-ctx__h"><b>#${rank} &middot; ${pct.toFixed(2)}%</b><span>${esc(truncAddr(n.id))}</span></div>`
        + (facts.length ? `<div class="hm-ctx__f">${facts.join(' &middot; ')}</div>` : '')
        + `<div class="hm-ctx__m">${items}</div>`;
      hideTooltip();
      ctx.hidden = false;
      // Beside the bubble, on the side with room, inside the panel.
      const ne = nodeEls.find(x => x.n === n);
      const wr = wrap.getBoundingClientRect();
      const br = ne ? ne.el.getBoundingClientRect() : { left: wr.left + wr.width / 2, right: wr.left + wr.width / 2, top: wr.top + wr.height / 2, height: 0 };
      const w = ctx.offsetWidth, h = ctx.offsetHeight;
      let x = br.right - wr.left + 10;
      if (x + w > wr.width - 8) x = br.left - wr.left - 10 - w;
      let y = br.top - wr.top + br.height / 2 - h / 2;
      x = Math.max(8, Math.min(wr.width - w - 8, x));
      y = Math.max(8, Math.min(wr.height - h - 8, y));
      ctx.style.left = `${Math.round(x)}px`;
      ctx.style.top = `${Math.round(y)}px`;
      applyEmphasis();
      if (viaKeyboard) { const first = ctx.querySelector('[role="menuitem"]'); if (first) first.focus(); }
    }
    holderMapApi = { selectCluster, selectWallet, openMenu: id => openMenu(nodeById.get(id)) };
    // Where every wallet is and where the camera looks, for a host that is
    // about to init again with more data (see "Progressive maps" above).
    holderMapApi.snapshot = () => {
      const seed = {};
      nodes.forEach(n => { seed[n.id] = { x: n.x, y: n.y }; });
      return { seed, view: { scale: view.scale, tx: view.tx, ty: view.ty } };
    };
    /* A host's panes as walls (see keep-out). `rects` are client rects
       ({left, top, right, bottom}) of whatever the host floats over the map;
       an empty array still walls off the map's own furniture; null turns the
       whole behaviour off again. Call it whenever a pane moves or resizes. */
    holderMapApi.setKeepOut = rects => {
      const on = Array.isArray(rects);
      const next = on ? rects.filter(r => r && isFinite(r.left) && isFinite(r.top) && r.right > r.left && r.bottom > r.top)
        .map(r => ({ left: +r.left, top: +r.top, right: +r.right, bottom: +r.bottom })) : [];
      // The same walls again (a host re-reporting on every render) change
      // nothing, so they wake nothing: no re-settle, no camera move.
      const same = on === keepOutOn && next.length === keepOutHost.length
        && next.every((r, i) => ['left', 'top', 'right', 'bottom'].every(k => Math.abs(r[k] - keepOutHost[i][k]) < 2));
      if (same) return;
      keepOutOn = on;
      keepOutHost = next;
      refreshKeepOut(true);
      if (follow) updateCamera();
      // A wall that moved needs the bubbles near it to step aside, not the
      // whole map to start over: a gentle warm-up, not a full reheat. Only
      // while the walls push, though (the overview, camera driving itself):
      // framing one group or held by the viewer, a warm-up only jiggles the
      // bubbles under a camera that should be still. The step-aside waits for
      // the way back to the overview (refit).
      if (wallsActive()) { alpha = Math.max(alpha, 0.35); wallsMoved = false; } else wallsMoved = true;
      ensureFrame();
    };

    /* ---- the dossier ----
       Index cards down the right list the groups; one click slides out a
       drawer with three tabs (wallets, evidence, impact). Chips on top are
       persistent filters.
       Every piece lives inside `wrap`, so fullscreen carries it all. */
    const els = {
      summary: document.getElementById('holderSummary'),
      chips: document.getElementById('holderChips'),
      rail: document.getElementById('holderRail'),
      index: document.getElementById('holderIndex'),
      token: document.getElementById('holderToken'),
      drawer: document.getElementById('holderDrawer'),
    };
    const ownerById = new Map(owners.map(o => [o.address, o]));
    const market = {
      mcap: +((info && (info.market_cap || info.fdv)) || 0),
      liq: +((info && info.liquidity_usd) || 0),
    };
    const launchTs = (typeof fullData.launch_ts === 'number' && fullData.launch_ts > 0) ? fullData.launch_ts : null;
    const delta = pending ? null : holderDelta(fullData, info);

    function syncHidden() {
      let changed = false;
      for (const n of nodes) {
        const h = S.hidden.has(n.id);
        if (h !== n.hidden) { n.hidden = h; changed = true; }
      }
      if (changed) { reheat(); if (follow) updateCamera(); }
      applyEmphasis();
      render_();
    }

    function ringSvg(pct) {
      const r = 12, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, (+pct || 0) / 10));   // 10% of supply fills the ring
      return `<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="${r}" fill="none" stroke="var(--line)" stroke-width="2"/><circle cx="15" cy="15" r="${r}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 15 15)"/></svg>`;
    }

    function renderSummary() {
      if (!els.summary) return;
      const n = clusters.length;
      // Pending: the count it can stand behind; the "mapping" status is the
      // foot line's and the host's (DiDo's state chip) to say.
      if (pending) { els.summary.textContent = `${owners.length} holders`; return; }
      let txt = n
        ? `${n} group${n === 1 ? '' : 's'} \u00b7 largest ${Math.max(...clusters.map(c => +c.pct || 0)).toFixed(1)}%`
        : 'no connected groups';
      if (delta) {
        const bits = [];
        if (delta.added) bits.push(`${delta.added} new`);
        if (delta.gone) bits.push(`${delta.gone} gone`);
        if (bits.length) txt += ` \u00b7 since ${delta.ago}: ${bits.join(', ')}`;
      }
      els.summary.textContent = txt;
    }

    function renderChips() {
      if (!els.chips) return;
      const present = new Set();
      nodes.forEach(n => n.roles.forEach(r => present.add(r)));
      const rows = ['insider', 'sniper', 'bundle', 'fresh'].filter(r => present.has(r)).map(r =>
        `<button type="button" class="holder-map-chip chip--dash${S.roles.has(r) ? ' on' : ''}" data-hm="role" data-role="${r}" aria-pressed="${S.roles.has(r)}">${r}</button>`);
      rows.push(`<button type="button" class="holder-map-chip chip--dash${S.minPct ? ' on' : ''}" data-hm="minpct" aria-pressed="${!!S.minPct}">&ge; 1%</button>`);
      if (S.hidden.size) rows.push(`<button type="button" class="holder-map-chip on" data-hm="unhideall">${S.hidden.size} hidden &middot; restore</button>`);
      els.chips.innerHTML = rows.join('');
    }

    /* The nameplate. Built once, in DOM rather than markup, because the
       image needs an error path and the widget's CSP forbids an inline
       `onerror` attribute -- so the monogram is rendered first and the image
       swapped in only after it has actually decoded. A blocked, missing or
       slow logo therefore never shows a broken-image box; the row just keeps
       its initial. */
    function renderToken() {
      if (!els.token) return;
      const name = (info && info.name && info.name !== 'Unknown') ? String(info.name) : '';
      const sym = (info && info.symbol && info.symbol !== '???') ? String(info.symbol) : '';
      if (!name && !sym) { els.token.hidden = true; return; }
      const mono = (sym || name).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
      els.token.hidden = false;
      els.token.innerHTML =
        `<span class="hm-token__mark"><span class="hm-token__mono">${esc(mono)}</span></span>` +
        `<span class="hm-token__t"><b>${esc(name || sym)}</b>` +
        `${sym ? `<span>$${esc(sym.toUpperCase())}</span>` : ''}</span>` +
        bsLink('token', fullData.token, 'Blockscout&nbsp;&nearr;', 'hm-token__bs');
      const src = (info && info.image_url) ? String(info.image_url) : '';
      if (!/^https:\/\//.test(src)) return;
      const probe = new Image();
      probe.decoding = 'async';
      /* `origin`, not `no-referrer`: image CDNs commonly refuse a request
         with no Referer at all as hotlinking, and the origin alone leaks
         nothing the page has not already told DexScreener -- it asked their
         API for this exact token a moment ago. The query string, which does
         name the token, is not sent. */
      probe.referrerPolicy = 'origin';
      probe.alt = '';
      probe.onload = () => {
        const mark = els.token && els.token.querySelector('.hm-token__mark');
        if (!mark || !probe.naturalWidth) return;
        mark.textContent = '';
        mark.appendChild(probe);
      };
      probe.onerror = () => {};
      probe.src = src;
    }

    function renderIndex() {
      if (!els.index) return;
      els.index.innerHTML = clusters.map((c, ci) => {
        const off = (c.members || []).every(m => S.hidden.has(m));
        const d = delta && delta.clusters.has(ci) ? delta.clusters.get(ci) : null;
        const sub = (d !== null && Math.abs(d) >= 0.05)
          ? `${d > 0 ? '+' : '\u2212'}${Math.abs(d).toFixed(1)} pts since ${delta.ago}`
          // The badge above carries the ownership now, so the sub-line goes
          // back to being the same wallet count every other card shows.
          : `${c.wallets} wallets${c.evidence === 'weak' ? ' \u00b7 weak' : ''}`;
        // The treasury says so in words, on the card, next to the letter. An
        // icon in the legend is something a reader has to go and decode first;
        // this is the line their eye lands on when the grade looks wrong.
        const own = c.owner === 'team' ? 'team supply'
          : c.owner === 'team_partial' ? `${(c.owner_label || '').split(' ')[0]} team supply`
          : c.label ? `${c.label}${c.exchange && c.label !== 'exchange wallets' ? ' \u00b7 exchange' : ''}`
          : '';
        return `<button type="button" class="hm-idx${selected === ci ? ' is-active' : ''}${off ? ' is-off' : ''}" data-hm="cluster" data-idx="${ci}" aria-pressed="${selected === ci}">${ringSvg(c.pct)}<span class="n">cluster ${CLUSTER_LETTERS[ci]}${own ? `<b class="hm-idx__own">${esc(own)}</b>` : ''}<span>${esc(sub)}</span></span><span class="p num">${(+c.pct || 0).toFixed(1)}%</span></button>`;
      }).join('');
      // The rail carries the nameplate too, so it only disappears when it has
      // nothing at all to show.
      if (els.rail) els.rail.classList.toggle('is-gone', !clusters.length && (!els.token || els.token.hidden));
    }

    function walletRowHtml(addr) {
      const o = ownerById.get(addr);
      if (!o) return '';
      const hidden = S.hidden.has(addr);
      const prim = primaryRole(o.roles || []);
      const dot = prim
        ? `<span class="holder-legend-swatch holder-legend-swatch--role-${prim}"></span>`
        : `<span class="holder-legend-swatch holder-legend-swatch--ink"></span>`;
      return `<div class="hm-row${hidden ? ' is-off' : ''}" data-addr="${esc(addr)}">
        <span class="rk num">${rankOf(o)}</span>
        <span class="a">${dot}<button type="button" class="addr" data-hm="pick" data-addr="${esc(addr)}" title="open this wallet's card">${esc(truncAddr(addr))}</button>${o.label ? `<span class="k hm-who" title="${esc(o.label)}">${esc(o.label)}</span>` : o.kind ? `<span class="k">${esc(o.kind)}</span>` : ''}${bsLink('address', addr, '&nearr;')}</span>
        <span class="p num">${(+o.pct || 0).toFixed(2)}%</span>
        <button type="button" class="hm-copy" data-hm="copy" data-addr="${esc(addr)}" aria-label="copy address">copy</button>
        <button type="button" class="hm-eye" data-hm="${hidden ? 'unhide' : 'hide'}" data-addr="${esc(addr)}" aria-label="${hidden ? 'show' : 'hide'} wallet">${hidden ? HM_EYE_OFF : HM_EYE}</button>
      </div>`;
    }

    // Why these wallets are grouped: every edge among them, the funder, and
    // -- when every member carries a timestamp -- how close together they
    // were funded. Filled square: an edge the engine rates strong. Dashed:
    // weak or circumstantial. Nothing here is inferred on the client.
    function evidenceHtml(c) {
      const set = new Set(c.members || []);
      // The engine rates a group 'strong' or 'weak'. Absent means the bot has
      // not published a rating (before 2.104.0, and during the window where
      // the analyzer is newer than the bot) -- and no rating is not evidence
      // of a strong one. An unrated group draws its circumstantial edges
      // dashed, exactly like a weak one, so nothing here overstates the
      // engine. Direct transfer and funding edges stay filled either way:
      // those are facts from links[].kind, not a judgement about the group.
      const strongGroup = c.evidence === 'strong';
      const items = [];
      /* Ownership is a declared fact about the token, not something read off
         the chain, so it leads the evidence and says what it changed: the
         group is grouped exactly as the engine found it, and only the risk
         verdict treats it differently. */
      if (c.owner === 'team') {
        items.push([true, `declared <b>${esc(c.owner_label || 'team')}</b> \u2014 supply the project holds for scheduled burns and partner deals, and the only group left out of the bubble-risk verdict`]);
      }
      /* Exchange custody: Blockscout labels the wallets, so the group is named
         for what it is -- many users' coins in one place, not one hand -- and,
         like the team exception, it says what that changed. */
      if (c.exchange) {
        items.push([true, `Blockscout labels these wallets <b>${esc(c.label || 'exchange wallets')}</b>: exchange custody, many users' coins rather than one holder. Drawn as found, and left out of the bubble-risk verdict`]);
      } else if (c.label && c.label_from === 'members') {
        items.push([true, `Blockscout labels most of these wallets <b>${esc(c.label)}</b>`]);
      }
      const HOW = {
        'shared funder': 'by the same sender',
        'same block': 'in the same block',
        'identical amounts': 'with the exact same amount',
        'funded together': 'within minutes of each other',
        'funded by deployer': 'by the deployer',
      };
      /* Group links from one sender read as one line: the wallets it paid,
         how (same sender, same block, minutes apart), and every payment as a
         transaction to open on Blockscout. */
      const groups = new Map();
      nodeLinks.forEach(l => {
        if (!set.has(l.a.id) || !set.has(l.b.id)) return;
        const asset = l.asset === 'token' ? tokenSym : nativeSym;
        const tx = bsLink('tx', l.tx, 'tx&nbsp;&nearr;', 'hm-bs--tx');
        if (l.kind === 'transfer') { items.push([true, `${addrHtml(l.a.id)} and ${addrHtml(l.b.id)} sent each other ${esc(asset)} directly ${tx}`]); return; }
        if (l.kind === 'funder') { items.push([true, `${addrHtml(l.b.id)} (the deployer) funded ${addrHtml(l.a.id)} with ${esc(asset)} ${tx}`]); return; }
        const key = `${l.reason}|${l.via}|${l.asset}`;
        if (!groups.has(key)) groups.set(key, { reason: l.reason, via: l.via, asset, wallets: new Set(), txs: new Set() });
        const g = groups.get(key);
        g.wallets.add(l.a.id); g.wallets.add(l.b.id);
        if (l.txA) g.txs.add(l.txA);
        if (l.tx) g.txs.add(l.tx);
      });
      groups.forEach(g => {
        const ws = [...g.wallets];
        const who = ws.length === 2 ? `${addrHtml(ws[0])} and ${addrHtml(ws[1])}` : `${ws.length} wallets (${ws.map(addrHtml).join(', ')})`;
        const txs = [...g.txs].map((t, i) => bsLink('tx', t, `tx${g.txs.size > 1 ? `&nbsp;${i + 1}` : ''}&nbsp;&nearr;`, 'hm-bs--tx')).join(' ');
        items.push([strongGroup || g.reason === 'shared funder' || g.reason === 'same block',
          `${who} were funded with ${esc(g.asset)} ${HOW[g.reason] || 'by the same sender'}${g.via ? `: ${addrHtml(g.via)}` : ''} ${txs}`]);
      });
      if (c.funder) items.push([strongGroup, `funder ${addrHtml(c.funder)} ${c.funder_is_holder ? 'is itself a top holder' : 'is not among the top holders'}`]);
      const ts = (c.members || []).map(m => (nodeById.get(m) || {}).fundTs).filter(t => t != null);
      if (ts.length >= 2 && ts.length === (c.members || []).length) {
        const span = Math.max(...ts) - Math.min(...ts);
        items.push([span <= 600, `all ${ts.length} wallets funded within <b>${esc(fmtSpan(span))}</b> of each other`]);
      }
      if (c.weak_reason) items.push([false, `rated weak: ${esc(c.weak_reason)}`]);
      if (!items.length) items.push([false, `grouped as \u201c${esc(c.reason || '')}\u201d \u2014 no edge between the drawn wallets`]);
      return `<div class="hm-ev">${items.map(([strong, html]) => `<div class="hm-ev__i"><i class="${strong ? '' : 'w'}"></i><div>${html}</div></div>`).join('')}
        <p class="hm-ev__note">filled square: an on-chain edge the engine rates strong &middot; dashed: weak or circumstantial</p></div>`;
    }

    // "If this group sells": a constant-product estimate of the price impact
    // of the whole group exiting into the pool on the card. Market cap and
    // liquidity are the pair's numbers already shown above; nothing is fetched.
    function impactHtml(c, letter) {
      if (!(market.mcap > 0 && market.liq > 0)) {
        return `<div class="hm-impact"><p>not enough market data on this card to estimate a sell impact &mdash; it needs the pair's market cap and pool liquidity.</p></div>`;
      }
      const value = (+c.pct || 0) / 100 * market.mcap, side = market.liq / 2, impact = value / (side + value);
      return `<div class="hm-impact">
        <div class="big num">&minus;${Math.round(impact * 100)}%<small>est. price impact</small></div>
        <p>if all ${c.wallets} wallets in group ${letter} sold into the current pool at once. constant-product estimate against the pair's liquidity, before slippage settings or MEV.</p>
        <div class="kv"><span>group holds</span><span class="num">${esc(DD.fmtLarge(value))}</span><span>pool depth (one side)</span><span class="num">${esc(DD.fmtLarge(side))}</span><span>market cap</span><span class="num">${esc(DD.fmtLarge(market.mcap))}</span></div>
      </div>`;
    }

    /* The wallet card: what the map knows about one wallet, and the way
       further in. Its share as money and as a sell (the group impact model,
       for one wallet), its roles, when it was funded, what it is wired to,
       and the group it belongs to. "open wallet" is the host's: shown only
       when the host passed hooks.onWallet (the analyzer's and DiDo's wallet
       scan) and the host says this address can be opened. */
    const ROLE_WORDS = { insider: 'insider / dev-funded', sniper: 'sniper', bundle: 'bundle', fresh: 'fresh wallet', dev: 'dev' };
    function walletCardHtml(addr) {
      const o = ownerById.get(addr), n = nodeById.get(addr);
      if (!o || !n) return '';
      const rank = rankOf(o), pct = +o.pct || 0, ci = n.clusterIndex;
      const head = `<div class="hm-drawer__h"><span class="hm-letter">${ci >= 0 ? CLUSTER_LETTERS[ci] : '#'}</span><div class="t"><b>wallet #${rank} &middot; ${pct.toFixed(2)}%</b><span>${esc(truncAddr(addr))}${o.label ? ` &middot; ${esc(o.label)}` : ''}${o.kind ? ` &middot; ${esc(o.kind)}` : ''}${o.exchange ? ' &middot; exchange' : ''}${o.team ? ' &middot; team supply' : ''}</span></div><button type="button" class="holder-map-chip" data-hm="close">close</button></div>`;
      const kv = [];
      if (market.mcap > 0) {
        const value = pct / 100 * market.mcap;
        kv.push(['holds', esc(DD.fmtLarge(value))]);
        if (market.liq > 0) {
          const side = market.liq / 2, impact = value / (side + value);
          kv.push(['if it sold at once', `&minus;${Math.max(0.1, impact * 100).toFixed(impact < 0.1 ? 1 : 0)}% price`]);
        }
      }
      const roles = (n.roles || []).map(r => ROLE_WORDS[r] || r);
      kv.push(['roles', roles.length ? esc(roles.join(', ')) : 'none flagged']);
      if (n.fundTs) kv.push(['funded', `${esc(fmtSpan(Math.max(0, Date.now() / 1000 - n.fundTs)))} ago`]);
      if (o.funder) {
        const by = o.funding_kind === 'first-tx' ? 'first transaction with' : o.funding_kind === 'token' ? `sent it ${esc(tokenSym)}` : `sent it ${esc(nativeSym)}`;
        kv.push(['funded by', `${addrHtml(o.funder)} <span class="hm-who">${by}</span> ${bsLink('tx', o.fund_tx, 'tx&nbsp;&nearr;', 'hm-bs--tx')}`]);
      }
      const wired = (neighbours.get(addr) || new Set()).size;
      const fc = fundedCount.get(addr) || 0, sc = sentCount.get(addr) || 0;
      const ties = [wired ? `${wired} linked wallet${wired > 1 ? 's' : ''}` : null,
        fc ? `funded ${fc}` : null, sc ? `sent tokens to ${sc}` : null].filter(Boolean);
      kv.push(['links', ties.length ? esc(ties.join(' \u00b7 ')) : 'none on this map']);
      kv.push(['group', ci >= 0 ? `cluster ${CLUSTER_LETTERS[ci]} &middot; ${(+clusters[ci].pct || 0).toFixed(1)}%` : (pending ? 'mapping\u2026' : 'not in a group')]);
      const canOpen = onWallet && walletOk(addr);
      const acts = `<div class="hm-wcard__acts">
        ${canOpen ? `<button type="button" class="holder-map-chip hm-wcard__open" data-hm="wallet-open" data-addr="${esc(addr)}">open wallet &rarr;</button>` : ''}
        ${ci >= 0 ? `<button type="button" class="holder-map-chip" data-hm="cluster" data-idx="${ci}">cluster ${CLUSTER_LETTERS[ci]}</button>` : ''}
        ${bsLink('address', addr, 'open in Blockscout &nearr;', 'holder-map-chip')}
        <button type="button" class="holder-map-chip" data-hm="copy" data-addr="${esc(addr)}">copy</button>
        <button type="button" class="holder-map-chip chip--dash" data-hm="hide" data-addr="${esc(addr)}">hide</button>
      </div>`;
      return `${head}<div class="hm-drawer__b"><div class="hm-impact hm-wcard"><div class="kv">${kv.map(([k, v]) => `<span>${k}</span><span class="num">${v}</span>`).join('')}</div>${acts}</div></div>`;
    }

    function renderDrawer() {
      if (!els.drawer) return;
      if (pickedId !== null && selected === null) {
        const html = walletCardHtml(pickedId);
        els.drawer.classList.toggle('is-open', !!html);
        els.drawer.setAttribute('aria-hidden', html ? 'false' : 'true');
        els.drawer.innerHTML = html;
        return;
      }
      const c = selected !== null ? clusters[selected] : null;
      els.drawer.classList.toggle('is-open', !!c);
      els.drawer.setAttribute('aria-hidden', c ? 'false' : 'true');
      if (!c) return;
      const letter = CLUSTER_LETTERS[selected];
      const allOff = (c.members || []).every(m => S.hidden.has(m));
      const head = `<div class="hm-drawer__h"><span class="hm-letter">${letter}</span><div class="t"><b>cluster ${letter} &middot; ${(+c.pct || 0).toFixed(1)}%</b><span>${c.wallets} wallets${c.owner ? ` &middot; ${esc(c.owner_label || 'team')}` : c.label ? ` &middot; ${esc(c.label)}` : ''} &middot; ${esc(c.reason || '')}${c.evidence === 'weak' ? ' &middot; weak' : ''}</span></div><button type="button" class="holder-map-chip" data-hm="close">close</button></div>`;
      const tabs = `<div class="hm-drawer__tabs">${['wallets', 'evidence', 'impact'].map(t =>
        `<button type="button" class="holder-map-chip${S.dtab === t ? ' on' : ''}" data-hm="dtab" data-tab="${t}" aria-pressed="${S.dtab === t}">${t}</button>`).join('')}<span class="sp"></span><button type="button" class="holder-map-chip chip--dash" data-hm="${allOff ? 'showall' : 'hideall'}" data-idx="${selected}">${allOff ? 'show all' : 'hide all'}</button></div>`;
      let body;
      if (S.dtab === 'wallets') {
        const members = (c.members || []).slice().sort((a, b) => ((ownerById.get(b) || {}).pct || 0) - ((ownerById.get(a) || {}).pct || 0));
        body = members.map(walletRowHtml).join('') || `<div class="hm-empty">no drawn wallets in this group</div>`;
      } else if (S.dtab === 'evidence') body = evidenceHtml(c);
      else body = impactHtml(c, letter);
      els.drawer.innerHTML = `${head}${tabs}<div class="hm-drawer__b">${body}</div>`;
    }

    function refreshPanel() { renderChips(); renderIndex(); renderDrawer(); syncHidden(); }

    // One delegated handler for every control inside the wrap.
    const onWrapClick = e => {
      const b = e.target.closest('[data-hm]');
      if (!b || !wrap.contains(b)) return;
      const act = b.dataset.hm;
      if (act === 'role') { const r = b.dataset.role; if (S.roles.has(r)) S.roles.delete(r); else S.roles.add(r); refreshPanel(); }
      else if (act === 'minpct') { S.minPct = S.minPct ? 0 : 1; refreshPanel(); }
      else if (act === 'hide') { closeMenu(); S.hidden.add(b.dataset.addr); refreshPanel(); }
      else if (act === 'unhide') { S.hidden.delete(b.dataset.addr); refreshPanel(); }
      else if (act === 'unhideall') { S.hidden.clear(); refreshPanel(); }
      else if (act === 'hideall') { (clusters[+b.dataset.idx] || {}).members?.forEach(m => S.hidden.add(m)); refreshPanel(); }
      else if (act === 'showall') { (clusters[+b.dataset.idx] || {}).members?.forEach(m => S.hidden.delete(m)); refreshPanel(); }
      else if (act === 'cluster') { closeMenu(); selectCluster(+b.dataset.idx); }
      else if (act === 'close') { pickedId = null; selectCluster(null); }
      else if (act === 'pick') { closeMenu(); selectWallet(b.dataset.addr); }
      else if (act === 'wallet-open') { closeMenu(); if (onWallet) onWallet(b.dataset.addr); }
      else if (act === 'dtab') { S.dtab = b.dataset.tab; renderDrawer(); }
      else if (act === 'help') {
        const pop = b.parentNode;
        const on = pop.classList.toggle('is-open');
        b.setAttribute('aria-expanded', String(on));
      }
      else if (act === 'copy') {
        const addr = b.dataset.addr;
        (navigator.clipboard ? navigator.clipboard.writeText(addr) : Promise.reject())
          .then(() => {
            const was = b.textContent;
            b.textContent = 'copied';
            setTimeout(() => { b.textContent = was; if (ctx.contains(b)) closeMenu(); }, 900);
          })
          .catch(() => {});
      }
    };
    wrap.addEventListener('click', onWrapClick);
    // Hovering a row in the drawer lights its bubble, the way hovering the bubble does.
    const onDrawerOver = e => { const row = e.target.closest('.hm-row'); if (row && row.dataset.addr && hoverId !== row.dataset.addr) { hoverId = row.dataset.addr; applyEmphasis(); } };
    const onDrawerLeave = () => { if (hoverId && ownerById.has(hoverId)) { hoverId = null; applyEmphasis(); } };
    if (els.drawer) { els.drawer.addEventListener('pointerover', onDrawerOver); els.drawer.addEventListener('pointerleave', onDrawerLeave); }

    renderSummary();
    renderToken();
    refreshPanel();

    /* ---- encoding legend: hover/focus a row to highlight matching nodes/edges ---- */
    const legendEl = document.getElementById('holderLegend');
    function legendHighlight(key) { legendKey = key; applyEmphasis(); }
    function legendClear() { legendKey = null; applyEmphasis(); }
    if (legendEl) {
      const roleLabel = { insider: 'insider / dev-funded', sniper: 'sniper', bundle: 'bundle', fresh: 'fresh wallet' };
      const presentRoles = new Set();
      nodes.forEach(n => { const p = primaryRole(n.roles); if (p) presentRoles.add(p); });
      const rows = [];
      ['insider', 'sniper', 'bundle', 'fresh'].forEach(r => {
        if (presentRoles.has(r)) {
          rows.push(`<button type="button" class="holder-legend-row holder-legend-swatch--role-${r}" data-legend="role:${r}"><span class="holder-legend-swatch holder-legend-swatch--role-${r}"></span>${roleLabel[r]}</button>`);
        }
      });
      if (nodes.some(n => nodeMatchesLegend(n, 'struct:holder'))) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:holder"><span class="holder-legend-swatch holder-legend-swatch--ink"></span>holder</button>`);
      }
      if (nodes.some(n => nodeMatchesLegend(n, 'struct:independent'))) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:independent"><span class="holder-legend-swatch holder-legend-swatch--outline"></span>independent</button>`);
      }
      if (nodes.some(n => n.team)) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:team"><span class="holder-legend-swatch holder-legend-swatch--team"></span>project treasury</button>`);
      }
      if (nodes.some(n => n.beyond)) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:beyond"><span class="holder-legend-swatch holder-legend-swatch--beyond"></span>group wallet outside the top ${topN}</button>`);
      }
      if (funderNodeIds.size > 0) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:funder"><span class="holder-legend-swatch holder-legend-swatch--funder"></span>funder wallet</button>`);
      }
      if (nodes.some(n => n.isLp)) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="struct:lp"><span class="holder-legend-swatch holder-legend-swatch--lp"></span>lp</button>`);
      }
      if (nodeLinks.some(l => l.kind === 'transfer')) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="edge:transfer"><span class="holder-legend-swatch holder-legend-swatch--edge-heavy"></span>token transfer (sender &rarr; recipient)</button>`);
      }
      if (nodeLinks.some(l => l.kind === 'funder')) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="edge:funder"><span class="holder-legend-swatch holder-legend-swatch--edge-solid"></span>funding (funder &rarr; recipient)</button>`);
      }
      if (nodeLinks.some(l => l.kind === 'shared_funder')) {
        rows.push(`<button type="button" class="holder-legend-row" data-legend="edge:shared"><span class="holder-legend-swatch holder-legend-swatch--edge-dashed"></span>grouped (no funding tx)</button>`);
      }
      legendEl.innerHTML = rows.join('');
      legendEl.querySelectorAll('.holder-legend-row').forEach(row => {
        const key = row.dataset.legend;
        row.addEventListener('mouseenter', () => legendHighlight(key));
        row.addEventListener('focus', () => legendHighlight(key));
        row.addEventListener('mouseleave', legendClear);
        row.addEventListener('blur', legendClear);
      });
    }

    /* ---- zoom / pan ---- */
    function svgPoint(evt) {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
    // viewBox point -> simulation point (the viewport carries the camera).
    const toSim = p => ({ x: (p.x - view.tx) / view.scale, y: (p.y - view.ty) / view.scale });
    /* A zoom by the viewer (wheel, the +/- buttons), anchored on (px, py). It
       glides onto its target through the camera's own easing (stepCamera
       flies it as a dolly about that point) instead of jumping, and a zoom
       that lands mid-glide stacks on the target, not on the frame in flight. */
    function zoomAt(px, py, factor) {
      const base = glide ? cam : view;
      takeOver();
      const newScale = clampScale(base.scale * factor);
      const ux = (px - base.tx) / base.scale, uy = (py - base.ty) / base.scale;
      cam.scale = newScale; cam.tx = px - ux * newScale; cam.ty = py - uy * newScale;
      if (reducedMotion) { view.scale = cam.scale; view.tx = cam.tx; view.ty = cam.ty; applyViewport(); return; }
      glide = true;
      ensureFrame();
    }
    // In proportion to how far the wheel turned: a trackpad sends many small
    // deltas, a mouse a few big notches, and one fixed 12% per event made a
    // trackpad lurch. A mouse notch (~100) is still about 12%.
    const onWheel = e => {
      e.preventDefault();
      closeMenu();
      const p = svgPoint(e);
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAt(p.x, p.y, Math.exp(Math.max(-0.4, Math.min(0.4, -dy * 0.0012))));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    const onReset = () => { selected = null; applySelection(); refit(null); };
    if (resetBtn) resetBtn.addEventListener('click', onReset);
    const onDblClick = e => { e.preventDefault(); refit(focusIdx); };
    svg.addEventListener('dblclick', onDblClick);

    const zoomInBtn = document.getElementById('holderZoomIn');
    const zoomOutBtn = document.getElementById('holderZoomOut');
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomAt(W / 2, viewH / 2, 1.2));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomAt(W / 2, viewH / 2, 1 / 1.2));

    /* ---- fullscreen ---- */
    const fullscreenBtn = document.getElementById('holderFullscreen');
    const hostFullscreen = hooks && typeof hooks.onFullscreen === 'function' ? hooks.onFullscreen : null;
    /* document.fullscreenEnabled is the permission-aware flag: in a
       cross-origin iframe without allow="fullscreen" the request method still
       exists but the request is refused, so testing for the method alone
       shipped a button that did nothing. A host that supplies onFullscreen
       takes over entirely and the flag is not consulted. */
    const fsSupported = !!hostFullscreen
      || (document.fullscreenEnabled !== false && !!(wrap.requestFullscreen || wrap.webkitRequestFullscreen));
    /* Who owns the expanded state: the browser, or a host driving it itself.
       `hostDriven` latches the moment holderMapApi.setFullscreen is called, so
       a host that expands the panel without having passed an onFullscreen hook
       is still believed -- before this, setFullscreen set the class and the
       repaint that followed read the native API, found nothing, and stripped
       the class straight back off. */
    let hostDriven = !!hostFullscreen;
    function isFullscreenActive() {
      return hostDriven
        ? wrap.classList.contains('is-fullscreen')
        : (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap);
    }
    function toggleFullscreen() {
      const want = !isFullscreenActive();
      if (hostFullscreen) { hostFullscreen(want); return; }
      if (want) {
        const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
        // Refusal is a rejected promise in every current engine; if it is
        // refused anyway the button is useless, so retire it rather than
        // leave something on screen that does nothing.
        try {
          const r = req.call(wrap);
          if (r && typeof r.catch === 'function') r.catch(() => { if (fullscreenBtn) fullscreenBtn.hidden = true; });
        } catch (e) { if (fullscreenBtn) fullscreenBtn.hidden = true; }
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      }
    }
    /* Repaint for whatever state the wrap is now in. Called by the browser's
       fullscreenchange, and by a host driving the expanded state itself. */
    function syncFullscreenUi() {
      const isFs = isFullscreenActive();
      wrap.classList.toggle('is-fullscreen', isFs);
      if (fullscreenBtn) fullscreenBtn.textContent = isFs ? 'exit fullscreen' : 'fullscreen';
      // The field just changed shape -- re-settle the layout and reframe.
      requestAnimationFrame(() => { syncViewBox(); reheat(); refit(focusIdx); });
    }
    const onFsChange = syncFullscreenUi;
    if (fullscreenBtn) {
      if (!fsSupported) fullscreenBtn.hidden = true;
      else fullscreenBtn.addEventListener('click', toggleFullscreen);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    holderMapApi.setFullscreen = on => {
      hostDriven = true;
      wrap.classList.toggle('is-fullscreen', !!on);
      syncFullscreenUi();
    };

    /* ---- export: client-side only, nothing leaves the page ---- */
    /* Every custom property the SVG itself references. Miss one and the
       export guard below rejects the whole PNG for an unresolved var() --
       which is the right failure, but it means this list has to grow with
       the encoding. The role rims are drawn on every flagged bubble. */
    const EXPORT_CSS_VARS = ['--ink', '--card', '--line', '--faint', '--mute',
                              '--role-sniper', '--role-bundle', '--role-insider', '--role-fresh',
                              '--rim-sniper', '--rim-bundle', '--rim-insider', '--rim-fresh'];
    function downloadBlob(content, filename, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function csvEscape(v) {
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    function holderCsvText() {
      const clusterOf = new Map(), funderOfAddr = new Map();
      clusters.forEach((c, i) => (c.members || []).forEach(addr => {
        clusterOf.set(addr, CLUSTER_LETTERS[i] || '');
        funderOfAddr.set(addr, c.funder || '');
      }));
      const rows = [['address', 'pct', 'cluster', 'roles', 'funder', 'first_ts', 'fund_ts', 'kind', 'hidden', 'rank']];
      owners.forEach(o => rows.push([
        o.address, o.pct.toFixed(2), clusterOf.get(o.address) || '',
        (o.roles || []).join('|'), funderOfAddr.get(o.address) || '',
        o.first_ts != null ? String(o.first_ts) : '', o.fund_ts != null ? String(o.fund_ts) : '',
        o.kind || '', S.hidden.has(o.address) ? 'yes' : '', String(rankOf(o)),
      ]));
      if (fullData.lp_pct != null && fullData.lp_pct > 0) {
        rows.push(['LP pool', fullData.lp_pct.toFixed(2), '', '', '', '', '', 'pool', '', '']);
      }
      return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    }
    function svgToPngBlob(scale) {
      return new Promise((resolve, reject) => {
        const style = getComputedStyle(document.documentElement);
        const varMap = {};
        EXPORT_CSS_VARS.forEach(v => { varMap[v] = style.getPropertyValue(v).trim(); });
        const clone = svg.cloneNode(true);
        let xml = resolveCssVarsInSvgXml(new XMLSerializer().serializeToString(clone), varMap);
        if (xml.indexOf('var(') !== -1) { reject(new Error('unresolved css var in export')); return; }
        const w = W * scale, h = viewH * scale;
        const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = varMap['--card'] || '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
        img.src = url;
      });
    }
    const csvBtn = document.getElementById('holderExportCsv');
    if (csvBtn) csvBtn.addEventListener('click', () => {
      downloadBlob(holderCsvText(), `holders-${fullData.token || 'token'}.csv`, 'text/csv;charset=utf-8');
    });
    const pngBtn = document.getElementById('holderExportPng');
    if (pngBtn) pngBtn.addEventListener('click', () => {
      svgToPngBlob(2).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `holders-${fullData.token || 'token'}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }).catch(() => {
        const original = pngBtn.textContent;
        pngBtn.textContent = 'export failed';
        setTimeout(() => { pngBtn.textContent = original; }, 1500);
      });
    });

    /* ---- pointer: drag a bubble, pan the field, pinch to zoom ---- */
    const activePointers = new Map();
    let dragNode = null, panStart = null, pinchStart = null, downInfo = null;
    const pointerToNode = evt => {
      const g = evt.target.closest && evt.target.closest('.holder-node');
      return g ? nodeEls.find(ne => ne.el === g) : null;
    };
    const onPointerDown = e => {
      svg.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const hit = pointerToNode(e);
      // A press anywhere on the map closes an open menu; a click on a bubble
      // opens the new one on release.
      closeMenu();
      // The bubble under the press, remembered: the SVG captures the pointer
      // below, so the release's target is the SVG, never the bubble -- read
      // there, every click on a bubble looked like a click on empty field.
      downInfo = { x: e.clientX, y: e.clientY, moved: false, hit };
      if (activePointers.size === 1) {
        // No reheat here: a plain click on a bubble must not set the whole map
        // swaying. The layout wakes once the press turns into a drag.
        if (hit) { dragNode = hit.n; dragNode.fixed = true; }
        else { const p = svgPoint(e); panStart = { x: p.x, y: p.y, tx: view.tx, ty: view.ty }; }
      } else if (activePointers.size === 2) {
        dragNode = null; panStart = null;
        const pts = [...activePointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const midSvg = svgPoint({ clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 });
        pinchStart = { dist, ux: (midSvg.x - view.tx) / view.scale, uy: (midSvg.y - view.ty) / view.scale };
        takeOver();
      }
    };
    const onPointerMove = e => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (downInfo && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 4) downInfo.moved = true;
      if (dragNode && activePointers.size === 1) {
        if (!downInfo || !downInfo.moved) return;   // hand tremor on a click is not a drag
        takeOver();   // the camera must not chase a bubble the viewer is holding
        const p = toSim(svgPoint(e));
        dragNode.x = Math.max(dragNode.r, Math.min(W - dragNode.r, p.x));
        dragNode.y = Math.max(dragNode.r, Math.min(H - dragNode.r, p.y));
        dragNode.vx = 0; dragNode.vy = 0;
        reheat(); render_();
      } else if (pinchStart && activePointers.size === 2) {
        const pts = [...activePointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        const newScale = clampScale(view.scale * (dist / pinchStart.dist));
        const midSvg = svgPoint({ clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 });
        view.scale = newScale;
        view.tx = midSvg.x - pinchStart.ux * newScale;
        view.ty = midSvg.y - pinchStart.uy * newScale;
        applyViewport();
      } else if (panStart && activePointers.size === 1) {
        if (downInfo && !downInfo.moved) return;   // under the drag threshold: still a click
        const p = svgPoint(e);
        // The camera (or a wheel glide) may have moved the view since the
        // press: the pan starts from where the picture is now, not with a jump.
        if (follow || glide) { takeOver(); panStart = { x: p.x, y: p.y, tx: view.tx, ty: view.ty }; }
        view.tx = panStart.tx + (p.x - panStart.x);
        view.ty = panStart.ty + (p.y - panStart.y);
        applyViewport();
      }
    };
    const onPointerEnd = e => {
      activePointers.delete(e.pointerId);
      if (dragNode && activePointers.size === 0) { dragNode.fixed = false; dragNode = null; }
      if (activePointers.size < 2) pinchStart = null;
      if (activePointers.size === 0) {
        panStart = null;
        if (downInfo && !downInfo.moved) {
          /* A bubble is a wallet: a click opens its card (with the way into
             its group). The empty field lets go of whatever was open. */
          const hit = downInfo.hit || pointerToNode(e);
          if (hit && !hit.n.isLp) openMenu(hit.n);
          else { closeMenu(); pickedId = null; selectCluster(null); }
        }
        downInfo = null;
      } else if (activePointers.size === 1) {
        const remaining = [...activePointers.values()][0];
        const p = svgPoint({ clientX: remaining.x, clientY: remaining.y });
        panStart = { x: p.x, y: p.y, tx: view.tx, ty: view.ty };
      }
    };
    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerEnd);
    svg.addEventListener('pointercancel', onPointerEnd);

    nodeEls.forEach(({ el, n }) => {
      const enter = () => { hoverId = n.id; applyEmphasis(); };
      const leave = () => { if (hoverId === n.id) { hoverId = null; applyEmphasis(); } };
      el.addEventListener('pointerenter', e => {
        if (e.pointerType === 'touch') return;
        enter();
        showTooltip(n, e.clientX, e.clientY);
      });
      el.addEventListener('pointermove', e => { if (e.pointerType !== 'touch' && tooltip && !tooltip.hidden) showTooltip(n, e.clientX, e.clientY); });
      el.addEventListener('pointerleave', () => { leave(); hideTooltip(); });
      el.addEventListener('focus', () => {
        enter();
        const rect = el.getBoundingClientRect();
        showTooltip(n, rect.left + rect.width / 2, rect.top);
      });
      el.addEventListener('blur', () => { leave(); hideTooltip(); });
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (n.isLp) selectCluster(null); else openMenu(n, true); }
        else if (e.key === 'Escape') { closeMenu(); pickedId = null; selectCluster(null); }
      });
    });

    const onDocKeydown = e => {
      if (e.key === 'Escape') {
        if (menuId !== null) { closeMenu(); return; }
        pickedId = null; selectCluster(null); return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // The rest only while the map has the viewer's attention -- fullscreen,
      // hovered, or holding focus -- so arrows elsewhere on the page stay arrows.
      const engaged = isFullscreenActive() || wrap.matches(':hover') || wrap.contains(document.activeElement);
      if (!engaged) return;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && clusters.length) {
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const next = selected === null ? (step > 0 ? 0 : clusters.length - 1) : (selected + step + clusters.length) % clusters.length;
        selected = null; selectCluster(next);
      } else if (e.key === 'h' && hoverId && ownerById.has(hoverId)) {
        S.hidden.add(hoverId); hoverId = null; hideTooltip(); refreshPanel();
      } else if (e.key === 'f') { onReset(); }
    };
    document.addEventListener('keydown', onDocKeydown);

    holderMapDestroy = () => {
      ctx.remove();
      stopSim();
      wrap.removeEventListener('click', onWrapClick);
      if (resizeObs) resizeObs.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onDocKeydown);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }
  /*HOLDERMAP-END*/
