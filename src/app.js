/* CryptoRisk UI v2 */
(function () {
  'use strict';
  const C = window.PulseCore, D = window.PulseData, LWC = window.LightweightCharts;
  const $ = id => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const col = n => css.getPropertyValue(n).trim();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = v => v == null || isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`;
  const toneCol = t => t === 'bull' ? col('--bull') : t === 'bear' ? col('--bear') : col('--wait');
  const scoreTone = s => s >= 56 ? 'bull' : s <= 44 ? 'bear' : 'neutral';

  const EXAMPLES = {
    crypto: { ph: 'Search any coin — BTC, ETH, SOL…', list: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK', 'SUI'] },
    meme: { ph: 'Token name, $TICKER or contract address…', list: ['BONK', 'WIF', 'POPCAT', 'BRETT', 'PEPE', 'MOG'] },
  };
  const TYPE_LABEL = { crypto: 'Crypto', meme: 'Meme' };
  const DEFAULT_WL = [
    { type: 'crypto', q: 'BTC' }, { type: 'crypto', q: 'ETH' }, { type: 'crypto', q: 'SOL' },
    { type: 'crypto', q: 'XRP' }, { type: 'meme', q: 'BONK' }, { type: 'meme', q: 'WIF' },
  ];
  const TFS = ['1h', '4h', '1d'];

  const state = { type: 'crypto', tf: '4h', demo: false, current: null, scan: {}, mtf: {}, stopLive: null, shownScore: 50, cs: [], showLevels: true, symbols: [] };
  let currentQuery = 'BTC';

  // ---------- storage (best effort) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  let watchlist = store.get('pulsescan.wl', DEFAULT_WL).filter(w => w.type === 'crypto' || w.type === 'meme');
  const wlKey = it => `${it.type}:${String(it.q).toUpperCase()}`;

  // ---------- small UI helpers ----------
  const progress = {
    start() { const p = $('progress'); p.style.opacity = 1; p.style.width = '35%'; clearTimeout(this.t); this.t = setTimeout(() => { p.style.width = '75%'; }, 300); },
    done() { const p = $('progress'); p.style.width = '100%'; clearTimeout(this.t); this.t = setTimeout(() => { p.style.opacity = 0; setTimeout(() => { p.style.width = 0; }, 400); }, 250); },
  };
  let toastT;
  function toast(msg, err) {
    const t = $('toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, err ? 4500 : 2200);
  }
  function hashStr(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
  function avatarStyle(s) {
    const h = hashStr(s) % 360;
    return `background:linear-gradient(135deg,hsl(${h} 70% 55%),hsl(${(h + 50) % 360} 75% 45%));color:#fff`;
  }

  // ---------- charts ----------
  const baseOpts = {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: col('--ink2'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } },
    rightPriceScale: { borderColor: col('--line') },
    timeScale: { borderColor: col('--line'), timeVisible: true, secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: 0, vertLine: { color: 'rgba(255,255,255,.25)', labelBackgroundColor: '#273142' }, horzLine: { color: 'rgba(255,255,255,.25)', labelBackgroundColor: '#273142' } },
    localization: { locale: 'en-US' },
  };
  const chart = LWC.createChart($('chart'), baseOpts);
  const candleS = chart.addCandlestickSeries({
    upColor: col('--bull'), downColor: col('--bear'), borderVisible: false,
    wickUpColor: col('--bull'), wickDownColor: col('--bear'),
  });
  candleS.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
  const lineOpt = c => ({ color: c, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const lines = { e20: chart.addLineSeries(lineOpt(col('--e20'))), e50: chart.addLineSeries(lineOpt(col('--e50'))), e200: chart.addLineSeries(lineOpt(col('--e200'))) };
  const volS = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  let priceLines = [];

  const rsiChart = LWC.createChart($('rsiChart'), Object.assign({}, baseOpts, { timeScale: { visible: false, borderColor: col('--line'), rightOffset: 4 } }));
  const rsiS = rsiChart.addLineSeries({ color: col('--accent'), lineWidth: 2, priceLineVisible: false });
  rsiS.createPriceLine({ price: 70, color: col('--bear'), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: '' });
  rsiS.createPriceLine({ price: 30, color: col('--bull'), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: '' });

  let syncing = false;
  const sync = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (syncing || !r) return; syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
  });
  sync(chart, rsiChart); sync(rsiChart, chart);

  function priceFormatFor(p) {
    if (p >= 1000) return { type: 'price', precision: 2, minMove: 0.01 };
    if (p >= 1) return { type: 'price', precision: 3, minMove: 0.001 };
    const dec = Math.min(12, Math.max(4, Math.ceil(-Math.log10(p)) + 3));
    return { type: 'price', precision: dec, minMove: Math.pow(10, -dec) };
  }
  const cleanCandles = candles => {
    const seen = new Set();
    return candles.filter(c => c && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
  };
  const volBar = c => ({ time: c.t, value: c.v, color: c.c >= c.o ? 'rgba(34,197,94,.32)' : 'rgba(244,63,94,.32)' });

  function setIndicatorLines(cs) {
    const s = cs.length >= 30 ? C.analyze(cs).series : null;
    const toLine = arr => arr ? cs.map((c, i) => arr[i] == null ? null : { time: c.t, value: arr[i] }).filter(Boolean) : [];
    lines.e20.setData(s ? toLine(s.e20) : []);
    lines.e50.setData(s ? toLine(s.e50) : []);
    lines.e200.setData(s ? toLine(s.e200) : []);
    rsiS.setData(s ? toLine(s.rsi) : []);
  }
  function setLevels(ta) {
    priceLines.forEach(l => candleS.removePriceLine(l)); priceLines = [];
    if (!ta || !ta.levels || !state.showLevels) return;
    priceLines.push(candleS.createPriceLine({ price: ta.levels.resistance, color: 'rgba(244,63,94,.75)', lineStyle: 2, lineWidth: 1, title: 'Resistance' }));
    priceLines.push(candleS.createPriceLine({ price: ta.levels.support, color: 'rgba(34,197,94,.75)', lineStyle: 2, lineWidth: 1, title: 'Support' }));
  }
  function drawChart(cs, ta) {
    state.cs = cs;
    if (!cs.length) {
      [candleS, lines.e20, lines.e50, lines.e200, volS, rsiS].forEach(s => s.setData([]));
      setLevels(null);
      return;
    }
    candleS.applyOptions({ priceFormat: priceFormatFor(cs[cs.length - 1].c) });
    candleS.setData(cs.map(c => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
    volS.setData(cs.map(volBar));
    setIndicatorLines(cs);
    setLevels(ta);
    const n = cs.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 4 });
  }

  // ---------- gauge ----------
  function gaugeSVG(score, tone) {
    const cx = 120, cy = 118, r = 96;
    const pt = (v, rad = r) => { const a = Math.PI * (1 - v / 100); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
    const arc = (a, b, rad = r) => { const [x1, y1] = pt(a, rad), [x2, y2] = pt(b, rad); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${rad} ${rad} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
    const segs = [[0, 33, col('--bear')], [33.8, 44, '#fb7185'], [44.8, 55, col('--wait')], [55.8, 67, '#86efac'], [67.8, 100, col('--bull')]];
    const tc = toneCol(tone);
    const ticks = [0, 25, 50, 75, 100].map(v => { const [x1, y1] = pt(v, r + 12), [x2, y2] = pt(v, r + 16); return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${col('--line2')}" stroke-width="2" stroke-linecap="round"/>`; }).join('');
    const [kx, ky] = pt(Math.max(0.5, score));
    return `
      <defs><filter id="gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs>
      ${ticks}
      ${segs.map(([a, b, c]) => `<path d="${arc(a, b)}" stroke="${c}" stroke-opacity=".16" stroke-width="15" fill="none"/>`).join('')}
      <path d="${arc(0, Math.max(0.5, score))}" stroke="${tc}" stroke-width="15" fill="none" stroke-linecap="round" filter="url(#gl)" opacity=".55"/>
      <path d="${arc(0, Math.max(0.5, score))}" stroke="${tc}" stroke-width="15" fill="none" stroke-linecap="round"/>
      <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="9" fill="${col('--ink')}" stroke="${col('--panel')}" stroke-width="4"/>
      <text x="${cx}" y="${cy - 18}" text-anchor="middle" font-family="Space Grotesk, Inter, sans-serif" font-weight="700" font-size="46" fill="${col('--ink')}">${Math.round(score)}</text>
      <text x="${cx}" y="${cy + 2}" text-anchor="middle" font-size="10.5" letter-spacing="1.5" fill="${col('--muted')}">SIGNAL SCORE</text>`;
  }
  let gaugeAnim;
  function animateGauge(to, tone) {
    cancelAnimationFrame(gaugeAnim);
    const from = state.shownScore, t0 = performance.now(), dur = 700;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * e;
      $('gauge').innerHTML = gaugeSVG(v, tone);
      if (k < 1) gaugeAnim = requestAnimationFrame(step); else state.shownScore = to;
    };
    gaugeAnim = requestAnimationFrame(step);
  }

  // ---------- render ----------
  const ICON = { bull: '↑', good: '✓', bear: '↓', bad: '✕', neutral: '•', warn: '!', unknown: '?' };

  function renderHeader(asset) {
    $('avatar').textContent = asset.title.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
    $('avatar').setAttribute('style', avatarStyle(asset.title));
    $('aName').textContent = asset.title;
    $('aSub').textContent = asset.subtitle; $('aSub').title = asset.subtitle;
    $('aPx').textContent = '$' + C.fmtPrice(asset.price);
    renderChange(asset.change24);
    $('extLink').href = asset.link || '#';
    $('extLink').classList.toggle('hidden', !asset.link || asset.link === '#');
    $('extLink').textContent = asset.type === 'crypto' ? 'Binance ↗' : 'DexScreener ↗';
    $('stats').innerHTML = asset.stats.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v" title="${esc(v)}">${esc(v)}</div></div>`).join('');
  }
  function renderChange(chg) {
    const el = $('aChg');
    el.textContent = chg == null ? '' : pct(chg) + ' · 24h';
    el.className = 'chg ' + ((chg || 0) >= 0 ? 'up' : 'down');
  }

  function renderSignal(ta) {
    animateGauge(ta.score, ta.tone);
    $('sig').textContent = ta.signal; $('sig').className = 'sig ' + ta.tone;
    $('sigcard').style.setProperty('--glow', toneCol(ta.tone));
    $('action').innerHTML = `<b>What it means:</b> ${esc(ta.action)}`;
    $('reasons').innerHTML = ta.reasons.map((r, i) => `<li style="animation-delay:${i * 40}ms"><span class="ic ${r.type}">${ICON[r.type]}</span><span>${esc(r.text)}</span></li>`).join('');

    const i = ta.ind;
    const meter = (v, c) => `<div class="meter"><i style="width:${Math.max(3, Math.min(100, v))}%;background:${c}"></i></div>`;
    const tiles = ta.ok ? [
      ['Trend', i.trend, i.ema200 != null ? 'vs EMA 200' : 'vs EMA 50', ''],
      ['RSI 14', i.rsi?.toFixed(1), i.rsi >= 70 ? 'Overbought' : i.rsi <= 30 ? 'Oversold' : 'Neutral zone', meter(i.rsi, i.rsi >= 70 ? col('--bear') : i.rsi <= 30 ? col('--bull') : col('--accent'))],
      ['MACD', i.macdHist == null ? '—' : (i.macdHist >= 0 ? '+' : '−') + Math.abs(i.macdHist / i.price * 100).toFixed(3) + '%', i.macdHist >= 0 ? 'Bullish momentum' : 'Bearish momentum', ''],
      ['Volatility', i.atrPct == null ? '—' : i.atrPct.toFixed(2) + '%', 'Avg move per candle', meter((i.atrPct || 0) * 15, col('--accent2'))],
      ['Volume', i.volRatio == null ? '—' : i.volRatio.toFixed(2) + '×', 'vs 20-candle avg', meter((i.volRatio || 0) * 40, col('--e50'))],
    ] : [];
    $('tiles').innerHTML = tiles.map(([k, v, h, m]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v ?? '—')}</div><div class="h">${esc(h)}</div>${m}</div>`).join('');

    const sc = C.scenarios(ta);
    $('scenCard').classList.toggle('hidden', !sc);
    if (sc) {
      const f = C.fmtPrice;
      $('scen').innerHTML = `
        <div class="sc bull"><div class="t"><span class="ic bull">↑</span>Bullish breakout</div>
          <div class="row"><span>Trigger: close above</span><b>${f(sc.bull.trigger)} <small class="up">${pct(sc.bull.pTrigger)}</small></b></div>
          <div class="row"><span>Next target zone</span><b>${f(sc.bull.target)} <small class="up">${pct(sc.bull.pTarget)}</small></b></div>
          <p>${esc(sc.bull.text)}</p></div>
        <div class="sc bear"><div class="t"><span class="ic bear">↓</span>Bearish breakdown</div>
          <div class="row"><span>Trigger: close below</span><b>${f(sc.bear.trigger)} <small class="down">${pct(sc.bear.pTrigger)}</small></b></div>
          <div class="row"><span>Next target zone</span><b>${f(sc.bear.target)} <small class="down">${pct(sc.bear.pTarget)}</small></b></div>
          <p>${esc(sc.bear.text)}</p></div>`;
      $('scenFoot').innerHTML = `<span>Bull setup invalid below <b>${f(sc.invalidation)}</b> (${pct(sc.pInvalidation)})</span><span>Upside / downside ratio <b>${sc.rr.toFixed(2)}</b></span>`;
    }
  }

  function renderRisk(asset) {
    const rc = $('riskCard');
    if (!asset.risk) { rc.classList.add('hidden'); return; }
    rc.classList.remove('hidden');
    const lv = asset.risk.level;
    const c = lv === 'LOW' ? col('--bull') : lv === 'HIGH' ? col('--bear') : col('--wait');
    $('riskLv').innerHTML = `<span style="color:${c}">${lv} RISK · ${asset.risk.risk}/100</span>`;
    $('riskDot').style.left = Math.max(2, Math.min(98, asset.risk.risk)) + '%';
    $('checks').innerHTML = asset.risk.checks.map(c => `<div class="check"><span class="ic ${c.status}">${ICON[c.status]}</span><div><div class="t">${esc(c.label)}</div><div class="d">${esc(c.detail)}</div></div></div>`).join('');
  }

  function renderMTF(scores) {
    $('mtf').innerHTML = TFS.map(tf => {
      const s = scores[tf];
      const tone = s == null ? 'neutral' : scoreTone(s);
      const txt = s === undefined ? '—' : s === null ? '00' : s;
      return `<div class="${tf === state.tf ? 'on' : ''}"><div class="k">${tf.toUpperCase()}</div><div class="v ${s === null ? 'skel' : ''}" style="color:${s == null ? 'var(--muted)' : toneCol(tone)}">${txt}</div></div>`;
    }).join('');
    const cons = C.consensus(scores);
    let note = '';
    if (cons && Object.values(scores).filter(v => v != null).length === 3) {
      note = cons.aligned === 'up' ? '✅ All timeframes agree: bullish' : cons.aligned === 'down' ? '⛔ All timeframes agree: bearish' : '⚖️ Timeframes disagree — lower conviction';
    }
    $('mtfNote').textContent = note;
  }

  // ---------- track record ----------
  const HUMAN_H = { '1h': '12 hours', '4h': '2 days', '1d': '12 days' };
  function renderBacktest(candles) {
    const card = $('btCard');
    const b = C.backtest(candles, 12, 2);
    if (!b || (b.bull.n + b.bear.n) < 8) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const box = (k, label, good) => {
      const x = b[k];
      if (!x.n) return `<div class="b"><div class="s">${label}</div><div class="big" style="color:var(--muted)">—</div><div class="s">No ${k === 'bull' ? 'bullish' : 'bearish'} readings in this period.</div></div>`;
      const c = x.rate >= 55 ? col('--bull') : x.rate >= 45 ? col('--wait') : col('--bear');
      return `<div class="b"><div class="s">${label}</div><div class="big" style="color:${c}">${x.rate.toFixed(0)}%</div>
        <div class="s">${good} ${HUMAN_H[state.tf]} later in <b>${x.hit}</b> of <b>${x.n}</b> cases · avg move <b class="${x.avg >= 0 ? 'up' : 'down'}">${pct(x.avg)}</b></div></div>`;
    };
    $('bt').innerHTML = box('bull', 'When the score was BULLISH (56+)', 'Price was higher') + box('bear', 'When the score was BEARISH (44 or less)', 'Price was lower');
    $('btFoot').textContent = `Tested on the ${candles.length} candles shown above. For comparison, price was higher ${HUMAN_H[state.tf]} later ${b.baseUp.toFixed(0)}% of the time overall. Past behaviour does not guarantee future results.`;
  }

  // ---------- price alerts ----------
  let alerts = store.get('pulsescan.alerts', []);
  const curKey = () => wlKey({ type: state.type, q: currentQuery });
  function renderAlerts() {
    const mine = alerts.filter(a => a.key === curKey());
    $('alertList').innerHTML = mine.map(a => `<div><span>${a.dir === 'above' ? '↑ Above' : '↓ Below'} <b>$${C.fmtPrice(a.price)}</b></span><button class="x" data-ad="${a.id}" aria-label="Delete alert">×</button></div>`).join('');
    const n = mine.length;
    $('alertBtn').textContent = n ? `🔔 ${n} alert${n > 1 ? 's' : ''}` : '🔔 Alert';
    $('alertBtn').classList.toggle('on', n > 0);
  }
  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach(t => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, ac.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.15);
        o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.16);
      });
    } catch (e) { /* audio not available */ }
  }
  function checkAlerts(key, price) {
    if (!price) return;
    const hit = alerts.filter(a => a.key === key && (a.dir === 'above' ? price >= a.price : price <= a.price));
    if (!hit.length) return;
    alerts = alerts.filter(a => !hit.includes(a));
    store.set('pulsescan.alerts', alerts);
    hit.forEach(a => {
      const msg = `${a.title} is ${a.dir === 'above' ? 'above' : 'below'} $${C.fmtPrice(a.price)} — now $${C.fmtPrice(price)}`;
      toast('🔔 ' + msg);
      beep();
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('CryptoRisk alert', { body: msg }); } catch (e) { /* ignore */ }
    });
    renderAlerts();
  }
  async function pollAlerts() {
    if (document.hidden) return;
    const keys = [...new Set(alerts.map(a => a.key))].filter(k => k !== curKey());
    for (const k of keys) {
      const a = alerts.find(x => x.key === k);
      try { const asset = await D.load(a.type, a.q, '1h', state.demo); checkAlerts(k, asset.price); } catch (e) { /* try later */ }
    }
  }

  // ---------- live ----------
  function stopLive() { if (state.stopLive) { state.stopLive(); state.stopLive = null; } $('livePill').classList.add('hidden'); }
  let lastRecalc = 0, lastPrice = null, flashT;
  function startLive(asset) {
    stopLive();
    lastPrice = asset.price; lastRecalc = Date.now();
    const base24 = asset.change24 != null ? asset.price / (1 + asset.change24 / 100) : null;
    state.stopLive = D.subscribeLive(asset, state.tf, ({ price, candle }) => {
      if (!state.current || state.current.asset !== asset || !price) return;
      asset.price = price;
      const px = $('aPx');
      px.textContent = '$' + C.fmtPrice(price);
      if (lastPrice != null && price !== lastPrice) {
        px.classList.remove('flash-up', 'flash-down'); void px.offsetWidth;
        px.classList.add(price > lastPrice ? 'flash-up' : 'flash-down');
        clearTimeout(flashT); flashT = setTimeout(() => px.classList.remove('flash-up', 'flash-down'), 450);
      }
      lastPrice = price;
      checkAlerts(curKey(), price);
      if (base24) renderChange((price / base24 - 1) * 100);
      $('livePill').classList.remove('hidden');
      if (candle && state.cs.length) {
        const cs = state.cs, last = cs[cs.length - 1];
        if (candle.t === last.t) cs[cs.length - 1] = candle;
        else if (candle.t > last.t) cs.push(candle);
        else return;
        candleS.update({ time: candle.t, open: candle.o, high: candle.h, low: candle.l, close: candle.c });
        volS.update(volBar(candle));
      }
      // refresh the analysis every ~20s with the live candle
      if (Date.now() - lastRecalc > 20000 && state.cs.length >= 30) {
        lastRecalc = Date.now();
        asset.candles = state.cs;
        const ta = C.combine(C.analyze(state.cs), asset.risk);
        state.current.ta = ta;
        renderSignal(ta);
        setIndicatorLines(state.cs);
        setLevels(ta);
        state.mtf[state.tf] = ta.score; renderMTF(state.mtf);
      }
    }, state.demo);
  }

  // ---------- main flow ----------
  let runId = 0;
  async function run(query) {
    query = (query || $('query').value).trim();
    if (!query) return;
    const id = ++runId;
    currentQuery = query; $('query').value = query;
    $('msg').innerHTML = '';
    document.body.classList.add('loading'); $('app').classList.add('loading');
    progress.start();
    try {
      const asset = await D.load(state.type, query, state.tf, state.demo);
      if (id !== runId) return;
      if (asset.note) $('msg').innerHTML = `<div class="note">${esc(asset.note)}</div>`;
      asset.candles = cleanCandles(asset.candles);
      const ta = C.combine(C.analyze(asset.candles), asset.risk);
      state.current = { asset, ta };
      renderHeader(asset);
      renderSignal(ta);
      renderRisk(asset);
      drawChart(asset.candles, ta);
      updateStar();
      state.scan[wlKey({ type: state.type, q: currentQuery })] = { asset, ta };
      renderWatchlist();
      startLive(asset);
      renderAlerts();
      setTimeout(() => { if (id === runId) renderBacktest(asset.candles); }, 30);
      try { history.replaceState(null, '', `#${state.type}-${encodeURIComponent(currentQuery.toUpperCase())}-${state.tf}`); } catch (e) { /* ignore */ }
      document.title = `${asset.title} ${ta.signal} · CryptoRisk`;
      // multi-timeframe consensus
      state.mtf = { [state.tf]: ta.ok ? ta.score : null };
      TFS.forEach(tf => { if (tf !== state.tf) state.mtf[tf] = null; });
      renderMTF(state.mtf);
      await Promise.all(TFS.filter(tf => tf !== state.tf).map(async tf => {
        try {
          const cs = cleanCandles(await D.loadCandles(asset, tf, state.demo));
          const t = C.analyze(cs);
          if (id === runId && t.ok) { state.mtf[tf] = t.score; renderMTF(state.mtf); }
        } catch (e) { /* leave empty */ }
      }));
      if (id === runId) { TFS.forEach(tf => { if (state.mtf[tf] == null) state.mtf[tf] = undefined; }); renderMTF(state.mtf); }
    } catch (e) {
      if (id !== runId) return;
      toast(e.message || 'Something went wrong. Try again in a few seconds.', true);
    } finally {
      if (id === runId) { document.body.classList.remove('loading'); $('app').classList.remove('loading'); progress.done(); }
    }
  }

  function setType(t, autorun = true) {
    state.type = t;
    document.querySelectorAll('#types button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    $('query').placeholder = EXAMPLES[t].ph;
    $('chips').innerHTML = EXAMPLES[t].list.map(s => `<span class="chip" data-q="${s}">${s}</span>`).join('');
    $('symlist').innerHTML = t === 'crypto' ? state.symbols.map(s => `<option value="${esc(s)}">`).join('') : '';
    if (autorun) run(EXAMPLES[t].list[0]);
  }

  function updateStar() {
    const on = watchlist.some(w => wlKey(w) === wlKey({ type: state.type, q: currentQuery }));
    const b = $('star'); b.classList.toggle('on', on); b.textContent = on ? '★ Watching' : '☆ Watch';
  }

  // ---------- watchlist ----------
  function sparkline(cs) {
    if (!cs || cs.length < 3) return '';
    const per = Math.round(7 * 86400 / D.TF[state.tf].sec);
    const pts = cs.slice(-Math.max(7, Math.min(per, 120))).map(c => c.c);
    const mn = Math.min(...pts), mx = Math.max(...pts), w = 96, h = 28;
    const d = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 2 - (mx === mn ? .5 : (v - mn) / (mx - mn)) * (h - 4)).toFixed(1)}`).join(' ');
    const c = pts[pts.length - 1] >= pts[0] ? col('--bull') : col('--bear');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${d}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function renderWatchlist() {
    if (!watchlist.length) { $('wl').innerHTML = `<tr><td colspan="8" class="empty">Your watchlist is empty — analyze an asset and press "Watch".</td></tr>`; return; }
    $('wl').innerHTML = watchlist.map((w, idx) => {
      const r = state.scan[wlKey(w)];
      const a = r?.asset, ta = r?.ta;
      const sk = !a && !r?.error;
      return `<tr class="row" data-i="${idx}">
        <td><div style="display:flex;gap:9px;align-items:center"><div class="avatar" style="${avatarStyle(a?.title || w.q)};width:28px;height:28px;flex:0 0 28px;border-radius:8px;font-size:10px">${esc((a?.title || w.q).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase())}</div><b>${esc(a?.title || w.q.toUpperCase())}</b></div></td>
        <td><span class="tag">${TYPE_LABEL[w.type]}</span></td>
        <td class="mono">${a ? '$' + C.fmtPrice(a.price) : `<span class="${sk ? 'skel' : ''}">$00.00</span>`}</td>
        <td class="mono ${a && a.change24 >= 0 ? 'up' : 'down'}">${a ? pct(a.change24) : ''}</td>
        <td>${a ? sparkline(a.candles) : ''}</td>
        <td>${ta ? `<div class="scorebar"><b class="mono">${ta.score}</b><div class="m"><i style="width:${ta.score}%;background:${toneCol(ta.tone)}"></i></div></div>` : r?.error ? '—' : `<span class="skel">00</span>`}</td>
        <td>${ta ? `<span class="pill ${ta.tone}">${esc(ta.signal)}</span>` : r?.error ? `<span class="tag">unavailable</span>` : ''}</td>
        <td style="text-align:right"><button class="x" data-del="${idx}" title="Remove" aria-label="Remove">×</button></td></tr>`;
    }).join('');
  }

  let scanning = false;
  async function scanAll() {
    if (scanning) return; scanning = true;
    const btn = $('scanAll'); btn.disabled = true; btn.textContent = 'Scanning…';
    for (const w of watchlist) {
      try {
        const asset = await D.load(w.type, w.q, state.tf, state.demo);
        asset.candles = cleanCandles(asset.candles);
        state.scan[wlKey(w)] = { asset, ta: C.combine(C.analyze(asset.candles), asset.risk) };
      } catch (e) { state.scan[wlKey(w)] = { error: true }; }
      renderWatchlist();
    }
    btn.disabled = false; btn.textContent = '↻ Scan all'; scanning = false;
  }

  // ---------- market bar & trending ----------
  async function loadOverview() {
    try {
      const o = await D.loadOverview(state.demo);
      if (o.tickers.length) {
        const items = o.tickers.map(t => `<span class="tk" data-q="${esc(t.sym)}"><b>${esc(t.sym)}</b><span class="p">$${C.fmtPrice(t.price)}</span><span class="${t.chg >= 0 ? 'up' : 'down'}">${pct(t.chg)}</span></span>`).join('');
        $('ticker').innerHTML = items + items;
      }
      if (o.fng) {
        $('fngBox').classList.remove('hidden');
        $('fngDot').style.left = o.fng.value + '%';
        $('fngVal').textContent = `${o.fng.value} ${o.fng.label}`;
        $('fngVal').style.color = o.fng.value < 40 ? col('--bear') : o.fng.value > 60 ? col('--bull') : col('--wait');
      }
      if (o.global && o.global.mcap) {
        $('mcapBox').classList.remove('hidden');
        $('mcapVal').innerHTML = `$${C.compact(o.global.mcap)} <span class="${o.global.chg >= 0 ? 'up' : 'down'}" style="font-weight:600">${pct(o.global.chg)}</span>`;
      }
      if (o.global && o.global.btcDom) { $('domBox').classList.remove('hidden'); $('domVal').textContent = o.global.btcDom.toFixed(1) + '%'; }
    } catch (e) { /* the bar is optional */ }
  }
  async function loadTrending() {
    try {
      const list = await D.loadTrending(state.demo);
      $('trend').innerHTML = list.map(t => `<div class="tcard" data-q="${esc(t.sym)}">
        <div class="h">${t.thumb ? `<img src="${esc(t.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph" style="${avatarStyle(t.sym)}">${esc(t.sym.slice(0, 3))}</div>`}
          <div style="min-width:0"><div class="s">${esc(t.sym)}</div><div class="n">${esc(t.name)}</div></div></div>
        <div class="pr">${t.price != null ? '$' + C.fmtPrice(t.price) : '—'}</div>
        <div class="c ${t.chg >= 0 ? 'up' : 'down'}">${t.chg != null ? pct(t.chg) : ''}</div>
        <div class="rk">${t.rank ? 'Rank #' + t.rank : 'Unranked'}</div></div>`).join('');
    } catch (e) { $('trend').innerHTML = `<div class="empty">Trending data is unavailable right now.</div>`; }
  }

  // ---------- events ----------
  $('form').addEventListener('submit', e => { e.preventDefault(); run(); });
  $('types').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.t !== state.type) setType(b.dataset.t); });
  $('tfs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.tf === state.tf) return;
    state.tf = b.dataset.tf; state.scan = {};
    document.querySelectorAll('#tfs button').forEach(x => x.classList.toggle('on', x === b));
    run(currentQuery).then(scanAll);
  });
  $('chips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) run(c.dataset.q); });
  const analyzeCrypto = q => { if (state.type !== 'crypto') setType('crypto', false); run(q); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  $('ticker').addEventListener('click', e => { const t = e.target.closest('.tk'); if (t) analyzeCrypto(t.dataset.q); });
  $('trend').addEventListener('click', e => { const t = e.target.closest('.tcard'); if (t) analyzeCrypto(t.dataset.q); });
  $('legend').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    b.classList.toggle('off');
    const on = !b.classList.contains('off');
    if (b.dataset.s === 'lv') { state.showLevels = on; setLevels(state.current?.ta); }
    else lines[b.dataset.s].applyOptions({ visible: on });
  });
  $('star').addEventListener('click', () => {
    const it = { type: state.type, q: currentQuery.toUpperCase() };
    const k = wlKey(it);
    if (watchlist.some(w => wlKey(w) === k)) { watchlist = watchlist.filter(w => wlKey(w) !== k); toast('Removed from watchlist'); }
    else { watchlist.push(it); if (state.current) state.scan[k] = { asset: state.current.asset, ta: state.current.ta }; toast('Added to watchlist ⭐'); }
    store.set('pulsescan.wl', watchlist); updateStar(); renderWatchlist();
  });
  $('copy').addEventListener('click', async () => {
    if (!state.current) return;
    const { asset, ta } = state.current;
    const m = state.mtf || {};
    const txt = [
      `${asset.title} (${state.tf.toUpperCase()}) — ${ta.signal} ${ta.score}/100`,
      `Price: $${C.fmtPrice(asset.price)}${asset.change24 != null ? ` (${pct(asset.change24)} 24h)` : ''}`,
      ta.ok ? `Trend: ${ta.ind.trend} · RSI ${ta.ind.rsi.toFixed(0)}` : '',
      `Timeframes: ${TFS.map(tf => `${tf.toUpperCase()} ${m[tf] ?? '—'}`).join(' · ')}`,
      ta.levels ? `Support ${C.fmtPrice(ta.levels.support)} / Resistance ${C.fmtPrice(ta.levels.resistance)}` : '',
      asset.risk ? `Risk check: ${asset.risk.level} (${asset.risk.risk}/100)` : '',
      `Scanned with CryptoRisk · not financial advice`,
      location.protocol.startsWith('http') ? location.href : '',
    ].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Signal copied — paste it anywhere 📋'); }
    catch (e) { toast('Copy is blocked in this browser', true); }
  });
  $('wl').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { watchlist.splice(+del.dataset.del, 1); store.set('pulsescan.wl', watchlist); renderWatchlist(); updateStar(); return; }
    const row = e.target.closest('tr.row'); if (!row) return;
    const w = watchlist[+row.dataset.i];
    if (w.type !== state.type) setType(w.type, false);
    run(w.q); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('scanAll').addEventListener('click', scanAll);
  $('alertBtn').addEventListener('click', () => {
    const box = $('alertBox'); box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) { $('alertPrice').value = state.current ? C.fmtPrice(state.current.asset.price).replace(/,/g, '') : ''; $('alertPrice').focus(); $('alertPrice').select(); }
  });
  $('alertForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!state.current) return;
    const price = parseFloat(String($('alertPrice').value).replace(/[, $]/g, ''));
    const now = state.current.asset.price;
    if (!(price > 0)) { toast('Enter a valid price', true); return; }
    if (Math.abs(price / now - 1) < 0.0005) { toast('That is the current price — pick a level above or below', true); return; }
    alerts.push({ id: Date.now().toString(36), key: curKey(), type: state.type, q: currentQuery.toUpperCase(), title: state.current.asset.title, price, dir: price > now ? 'above' : 'below' });
    store.set('pulsescan.alerts', alerts);
    renderAlerts();
    toast(`Alert set: ${state.current.asset.title} ${price > now ? 'above' : 'below'} $${C.fmtPrice(price)}`);
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignore */ }
  });
  $('alertList').addEventListener('click', e => {
    const b = e.target.closest('[data-ad]'); if (!b) return;
    alerts = alerts.filter(a => a.id !== b.dataset.ad); store.set('pulsescan.alerts', alerts); renderAlerts();
  });

  // ---------- system status ----------
  async function openStatus() {
    $('statusModal').classList.remove('hidden');
    $('stSum').classList.add('hidden');
    $('stRows').innerHTML = `<div class="empty">Running checks…</div>`;
    $('stRerun').disabled = true;
    const render = rows => {
      $('stRows').innerHTML = rows.map(r => `<div class="srow"><span class="ic ${r.ok ? 'good' : 'bad'}">${r.ok ? '✓' : '✕'}</span>
        <div><div class="n">${esc(r.name)} <span class="u">· ${esc(r.used)}</span></div><div class="d">${esc(r.detail)}</div></div><span class="ms">${r.ms} ms</span></div>`).join('')
        + (rows.length < 8 ? `<div class="empty">Checking ${8 - rows.length} more…</div>` : '');
    };
    const rows = await D.runDiagnostics(render);
    render(rows);
    const bad = rows.filter(r => !r.ok).length;
    const sum = $('stSum'); sum.classList.remove('hidden');
    sum.style.background = bad ? 'var(--bear-bg)' : 'var(--bull-bg)';
    sum.style.color = bad ? '#fda4af' : '#86efac';
    sum.textContent = bad ? `${bad} of ${rows.length} sources failed — screenshot this and send it over` : `All ${rows.length} data sources are working ✓`;
    $('stRerun').disabled = false;
  }
  $('statusBtn').addEventListener('click', openStatus);
  $('statusLink').addEventListener('click', e => { e.preventDefault(); openStatus(); });
  $('stRerun').addEventListener('click', openStatus);
  $('stClose').addEventListener('click', () => $('statusModal').classList.add('hidden'));
  $('statusModal').addEventListener('click', e => { if (e.target === $('statusModal')) $('statusModal').classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('statusModal').classList.add('hidden'); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('query')) { e.preventDefault(); $('query').focus(); $('query').select(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLive(); else if (state.current) startLive(state.current.asset);
  });

  // ---------- boot ----------
  (async function boot() {
    setType('crypto', false);
    renderWatchlist();
    TFS.forEach(tf => { state.mtf[tf] = null; }); renderMTF(state.mtf);
    $('gauge').innerHTML = gaugeSVG(50, 'neutral');
    const live = await D.probeLive();
    state.demo = !live;
    const m = $('mode');
    m.classList.toggle('demo', state.demo);
    $('modeTxt').textContent = state.demo ? 'DEMO DATA' : 'LIVE DATA';
    if (state.demo) m.title = 'Live market APIs are not reachable from this preview. Open the deployed site for live data.';
    loadOverview();
    setInterval(loadOverview, 60000);
    D.loadSymbols(state.demo).then(s => { state.symbols = s; if (state.type === 'crypto') setType('crypto', false); }).catch(() => {});
    // deep link: #crypto-BTC-4h / #meme-BONK-1h
    let first = 'BTC';
    const m2 = decodeURIComponent(location.hash.slice(1)).match(/^(crypto|meme)-(.+)-(1h|4h|1d)$/);
    if (m2) {
      state.tf = m2[3];
      document.querySelectorAll('#tfs button').forEach(x => x.classList.toggle('on', x.dataset.tf === state.tf));
      if (m2[1] !== state.type) setType(m2[1], false);
      first = m2[2];
    }
    await run(first);
    loadTrending();
    scanAll();
    setInterval(() => { if (!document.hidden) scanAll(); }, 180000);
    setInterval(pollAlerts, 60000);
  })();
})();
