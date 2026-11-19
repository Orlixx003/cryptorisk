/* CryptoRisk core — indicators, scoring and risk checks.
   Pure functions, no DOM. Works in the browser and in Node (for tests). */
(function (root) {
  'use strict';

  // ---------- basic series helpers ----------
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder's RSI
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const firstIdx = line.findIndex(v => v != null);
    const sig = new Array(closes.length).fill(null);
    if (firstIdx >= 0) {
      const compact = line.slice(firstIdx);
      const s = ema(compact, signal);
      s.forEach((v, j) => { sig[firstIdx + j] = v; });
    }
    const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
    return { line, signal: sig, hist };
  }

  function bollinger(closes, period = 20, mult = 2) {
    const mid = sma(closes, period);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / period);
      upper.push(mid[i] + mult * sd);
      lower.push(mid[i] - mult * sd);
    }
    return { mid, upper, lower };
  }

  function atr(candles, period = 14) {
    const tr = candles.map((c, i) => {
      if (i === 0) return c.h - c.l;
      const pc = candles[i - 1].c;
      return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    });
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    let prev = 0;
    for (let i = 1; i <= period; i++) prev += tr[i];
    prev /= period;
    out[period] = prev;
    for (let i = period + 1; i < candles.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  // Swing-based support / resistance from the recent window
  function keyLevels(candles, lookback = 120, wing = 3) {
    const start = Math.max(0, candles.length - lookback);
    const last = candles[candles.length - 1].c;
    const highs = [], lows = [];
    for (let i = start + wing; i < candles.length - wing; i++) {
      let isH = true, isL = true;
      for (let j = i - wing; j <= i + wing; j++) {
        if (candles[j].h > candles[i].h) isH = false;
        if (candles[j].l < candles[i].l) isL = false;
      }
      if (isH) highs.push(candles[i].h);
      if (isL) lows.push(candles[i].l);
    }
    const window = candles.slice(start);
    const res = highs.filter(h => h > last).sort((a, b) => a - b)[0]
      ?? Math.max(...window.map(c => c.h));
    const sup = lows.filter(l => l < last).sort((a, b) => b - a)[0]
      ?? Math.min(...window.map(c => c.l));
    return { support: sup, resistance: res };
  }

  const lastVal = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const valAt = (arr, back) => { const v = arr[arr.length - 1 - back]; return v == null ? null : v; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- technical analysis ----------
  function analyze(candles) {
    if (!candles || candles.length < 30) {
      return {
        ok: false, score: 50, signal: 'WAIT', tone: 'neutral',
        action: 'Not enough price history yet for a reliable read. Very new assets are pure speculation — wait for more data.',
        reasons: [{ type: 'neutral', text: `Only ${candles ? candles.length : 0} candles available (need 30+).` }],
        ind: {}, levels: null, series: null
      };
    }
    const closes = candles.map(c => c.c);
    const vols = candles.map(c => c.v);
    const price = closes[closes.length - 1];

    const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
    const r = rsi(closes, 14);
    const m = macd(closes);
    const bb = bollinger(closes);
    const a = atr(candles);
    const vAvg = sma(vols, 20);
    const levels = keyLevels(candles);

    const E20 = lastVal(e20), E50 = lastVal(e50), E200 = e200[e200.length - 1];
    const RSI = lastVal(r);
    const H = valAt(m.hist, 0), Hp = valAt(m.hist, 1);
    const ATR = lastVal(a);
    const volRatio = vAvg[vAvg.length - 2] ? vols[vols.length - 1] / vAvg[vAvg.length - 2] : null;
    const lastC = candles[candles.length - 1];
    const green = lastC.c >= lastC.o;

    let score = 50;
    const reasons = [];
    const add = (pts, type, text) => { score += pts; reasons.push({ type, text, pts }); };

    // Trend
    const longMA = E200 != null ? E200 : E50;
    const longName = E200 != null ? 'EMA 200' : 'EMA 50';
    if (longMA != null) {
      if (price > longMA) add(10, 'bull', `Price is above the ${longName} — long-term trend is up.`);
      else add(-10, 'bear', `Price is below the ${longName} — long-term trend is down.`);
    }
    if (E20 != null && E50 != null) {
      if (E20 > E50) add(8, 'bull', 'EMA 20 is above EMA 50 — short-term momentum is bullish.');
      else add(-8, 'bear', 'EMA 20 is below EMA 50 — short-term momentum is bearish.');
      const e50prev = valAt(e50, 10);
      if (e50prev != null) {
        const slope = (E50 - e50prev) / e50prev;
        if (slope > 0.01) add(4, 'bull', 'EMA 50 is rising.');
        else if (slope < -0.01) add(-4, 'bear', 'EMA 50 is falling.');
      }
    }

    // MACD
    if (H != null && Hp != null) {
      if (H > 0 && Hp <= 0) add(8, 'bull', 'Fresh MACD bullish crossover.');
      else if (H < 0 && Hp >= 0) add(-8, 'bear', 'Fresh MACD bearish crossover.');
      else if (H > 0) add(H > Hp ? 6 : 2, 'bull', H > Hp ? 'MACD histogram positive and growing.' : 'MACD positive but momentum is fading.');
      else add(H < Hp ? -6 : -2, 'bear', H < Hp ? 'MACD histogram negative and falling.' : 'MACD negative but selling is slowing.');
    }

    // RSI
    if (RSI != null) {
      if (RSI >= 80) add(-12, 'bear', `RSI ${RSI.toFixed(0)} — extremely overbought, pullback risk is high.`);
      else if (RSI >= 70) add(-7, 'bear', `RSI ${RSI.toFixed(0)} — overbought.`);
      else if (RSI <= 30 && longMA != null && price < longMA) add(2, 'neutral', `RSI ${RSI.toFixed(0)} — oversold, but inside a downtrend bounces often fail.`);
      else if (RSI <= 20) add(9, 'bull', `RSI ${RSI.toFixed(0)} — extremely oversold, bounce potential.`);
      else if (RSI <= 30) add(6, 'bull', `RSI ${RSI.toFixed(0)} — oversold, bounce potential.`);
      else if (RSI >= 50) add(3, 'bull', `RSI ${RSI.toFixed(0)} — healthy bullish zone.`);
      else add(-3, 'bear', `RSI ${RSI.toFixed(0)} — below 50, buyers are weak.`);
    }

    // Bollinger
    const BBu = lastVal(bb.upper), BBl = lastVal(bb.lower);
    if (BBu != null && price > BBu) add(-4, 'bear', 'Price is above the upper Bollinger Band — stretched.');
    else if (BBl != null && price < BBl) add(longMA != null && price < longMA ? 1 : 4, 'bull', 'Price is below the lower Bollinger Band — stretched to the downside.');

    // Volume
    if (volRatio != null && volRatio >= 1.5) {
      if (green) add(6, 'bull', `Volume ${volRatio.toFixed(1)}× average on a green candle — buyers are stepping in.`);
      else add(-6, 'bear', `Volume ${volRatio.toFixed(1)}× average on a red candle — strong selling.`);
    }

    // Levels
    const distRes = (levels.resistance - price) / price;
    const distSup = (price - levels.support) / price;
    if (distRes >= 0 && distRes < 0.02) add(-4, 'bear', 'Price is right under resistance — breakout needed.');
    if (distSup >= 0 && distSup < 0.02) add(4, 'bull', 'Price is sitting near support.');

    score = Math.round(clamp(score, 0, 100));

    let signal, tone, action;
    if (score >= 68) {
      signal = 'BULLISH'; tone = 'bull';
      action = 'Trend and momentum are aligned up. Traders typically look for entries on pullbacks toward support rather than chasing green candles.';
    } else if (score >= 56) {
      signal = 'LEAN BULLISH'; tone = 'bull';
      action = 'Leaning positive, but not every signal agrees. Wait for confirmation — a close above resistance or a MACD cross.';
    } else if (score >= 45) {
      signal = 'WAIT'; tone = 'neutral';
      action = 'No clear edge right now. Wait for a breakout above resistance or a clean bounce from support.';
    } else if (score >= 33) {
      signal = 'LEAN BEARISH'; tone = 'bear';
      action = 'Sellers have the upper hand. Patience — wait for momentum to turn before considering entries.';
    } else {
      signal = 'BEARISH'; tone = 'bear';
      action = 'Downtrend in control. Avoid catching a falling knife; wait for reversal signs (higher low, RSI recovery, MACD cross).';
    }

    // Sort strongest reasons first
    reasons.sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts));

    return {
      ok: true, score, signal, tone, action, reasons, levels,
      ind: {
        price, rsi: RSI, macdHist: H, ema20: E20, ema50: E50, ema200: E200,
        atrPct: ATR != null ? (ATR / price) * 100 : null,
        volRatio, bbUpper: BBu, bbLower: BBl,
        trend: longMA == null ? 'n/a' : price > longMA ? 'Uptrend' : 'Downtrend'
      },
      series: { e20, e50, e200, rsi: r, macd: m }
    };
  }

  // ---------- memecoin risk checks ----------
  // pair: DexScreener pair object; sec: normalized security info (or null)
  function memeRisk(pair, sec) {
    let risk = 0;
    const checks = [];
    const chk = (pts, status, label, detail) => { risk += pts; checks.push({ status, label, detail }); };
    const usd = n => '$' + compact(n);

    const liq = pair?.liquidity?.usd ?? 0;
    if (liq < 10000) chk(25, 'bad', 'Liquidity', `${usd(liq)} — very thin, easy to manipulate`);
    else if (liq < 50000) chk(12, 'warn', 'Liquidity', `${usd(liq)} — low`);
    else chk(0, 'good', 'Liquidity', `${usd(liq)}`);

    if (pair?.pairCreatedAt) {
      const ageH = (Date.now() - pair.pairCreatedAt) / 3.6e6;
      const ageTxt = ageH < 48 ? `${ageH.toFixed(0)} hours` : `${(ageH / 24).toFixed(0)} days`;
      if (ageH < 24) chk(20, 'bad', 'Pair age', `${ageTxt} — brand new, extreme risk`);
      else if (ageH < 24 * 7) chk(10, 'warn', 'Pair age', `${ageTxt} — young`);
      else chk(0, 'good', 'Pair age', ageTxt);
    }

    const fdv = pair?.fdv ?? pair?.marketCap;
    if (fdv && liq) {
      const ratio = fdv / liq;
      if (ratio > 50) chk(10, 'warn', 'FDV / liquidity', `${ratio.toFixed(0)}× — valuation far above liquidity`);
      else chk(0, 'good', 'FDV / liquidity', `${ratio.toFixed(1)}×`);
    }

    const v24 = pair?.volume?.h24 ?? 0;
    if (v24 < 1000) chk(50, 'bad', '24h volume', `$${compact(v24)} — no real trading. Possibly a fake clone or dead token`);
    else if (liq > 0 && v24 / liq < 0.01) chk(10, 'warn', '24h volume', `$${compact(v24)} — very low vs liquidity`);
    else chk(0, 'good', '24h volume', `$${compact(v24)}`);

    const tx = pair?.txns?.h24;
    if (tx && tx.buys + tx.sells > 20) {
      const sellShare = tx.sells / (tx.buys + tx.sells);
      if (sellShare > 0.65) chk(10, 'warn', '24h order flow', `${(sellShare * 100).toFixed(0)}% sells — heavy distribution`);
      else if (tx.sells === 0) chk(15, 'bad', '24h order flow', 'Buys but zero sells — possible honeypot');
      else chk(0, 'good', '24h order flow', `${tx.buys} buys / ${tx.sells} sells`);
    }

    if (sec) {
      if (sec.honeypot === true) chk(40, 'bad', 'Honeypot', 'Detected — you may not be able to sell');
      else if (sec.honeypot === false) chk(0, 'good', 'Honeypot', 'Not detected');
      if (sec.sellTax != null) {
        if (sec.sellTax > 10 || sec.buyTax > 10) chk(15, 'bad', 'Taxes', `Buy ${sec.buyTax}% / Sell ${sec.sellTax}%`);
        else chk(0, 'good', 'Taxes', `Buy ${sec.buyTax}% / Sell ${sec.sellTax}%`);
      }
      if (sec.mintable === true) chk(12, 'warn', 'Mint authority', 'Supply can still be increased');
      else if (sec.mintable === false) chk(0, 'good', 'Mint authority', 'Renounced / not mintable');
      if (sec.freezable === true) chk(12, 'warn', 'Freeze authority', 'Dev can freeze wallets');
      if (sec.ownerPowers === true) chk(12, 'warn', 'Owner powers', 'Owner can modify balances or trading');
      if (sec.topHoldersPct != null) {
        if (sec.topHoldersPct > 50) chk(15, 'bad', 'Top 10 holders', `${sec.topHoldersPct.toFixed(0)}% of supply — concentrated`);
        else if (sec.topHoldersPct > 30) chk(7, 'warn', 'Top 10 holders', `${sec.topHoldersPct.toFixed(0)}% of supply`);
        else chk(0, 'good', 'Top 10 holders', `${sec.topHoldersPct.toFixed(0)}% of supply`);
      }
      if (sec.lpLockedPct != null) {
        if (sec.lpLockedPct < 50) chk(12, 'warn', 'LP locked/burned', `${sec.lpLockedPct.toFixed(0)}% — rug-pull risk`);
        else chk(0, 'good', 'LP locked/burned', `${sec.lpLockedPct.toFixed(0)}%`);
      }
    } else {
      checks.push({ status: 'unknown', label: 'Contract security', detail: 'Security scan unavailable for this token' });
    }

    risk = Math.round(clamp(risk, 0, 100));
    const level = risk >= 50 ? 'HIGH' : risk >= 25 ? 'MEDIUM' : 'LOW';
    return { risk, level, checks };
  }

  // Combine technical read with meme risk
  function combine(ta, mr) {
    if (!mr) return ta;
    if (mr.level === 'HIGH') {
      return Object.assign({}, ta, {
        signal: 'HIGH RISK', tone: 'bear',
        action: 'Risk checks failed. Whatever the chart says, the token itself looks dangerous — most traders would stay away.'
      });
    }
    return ta;
  }

  // Normalize GoPlus responses (EVM + Solana)
  function normalizeGoPlus(raw, isSolana) {
    if (!raw) return null;
    const n = v => (v == null || v === '' ? null : Number(v));
    const b = v => (v == null || v === '' ? null : String(v) === '1');
    const sumTop = holders => Array.isArray(holders) && holders.length
      ? holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100 : null;
    if (isSolana) {
      return {
        honeypot: null,
        buyTax: null, sellTax: null,
        mintable: raw.mintable ? raw.mintable.status === '1' : null,
        freezable: raw.freezable ? raw.freezable.status === '1' : null,
        ownerPowers: raw.balance_mutable_authority ? raw.balance_mutable_authority.status === '1' : null,
        topHoldersPct: sumTop(raw.holders),
        lpLockedPct: null
      };
    }
    const lp = Array.isArray(raw.lp_holders) && raw.lp_holders.length
      ? raw.lp_holders.filter(h => Number(h.is_locked) === 1 || /^0x0{30,}|dead$/i.test(h.address || ''))
        .reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100 : null;
    return {
      honeypot: b(raw.is_honeypot),
      buyTax: raw.buy_tax != null && raw.buy_tax !== '' ? +(n(raw.buy_tax) * 100).toFixed(1) : null,
      sellTax: raw.sell_tax != null && raw.sell_tax !== '' ? +(n(raw.sell_tax) * 100).toFixed(1) : null,
      mintable: b(raw.is_mintable),
      freezable: null,
      ownerPowers: b(raw.owner_change_balance) || b(raw.hidden_owner) || b(raw.can_take_back_ownership) || null,
      topHoldersPct: sumTop(raw.holders),
      lpLockedPct: lp
    };
  }

  // Resample candles to a larger interval (e.g. 1h -> 4h)
  function resample(candles, sec) {
    const out = [];
    for (const c of candles) {
      const bucket = Math.floor(c.t / sec) * sec;
      const last = out[out.length - 1];
      if (last && last.t === bucket) {
        last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.v += c.v;
      } else out.push({ t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
    return out;
  }

  function compact(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  function fmtPrice(p) {
    if (p == null || isNaN(p)) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    // tiny memecoin prices: keep 4 significant digits
    return p.toPrecision(4);
  }

  // Bull / bear scenarios from key levels and volatility
  function scenarios(ta) {
    if (!ta || !ta.ok || !ta.levels) return null;
    const p = ta.ind.price;
    let { support: S, resistance: R } = ta.levels;
    const atrAbs = ta.ind.atrPct != null ? (ta.ind.atrPct / 100) * p : p * 0.02;
    if (!(R > p)) R = p + 2 * atrAbs;
    if (!(S < p)) S = p - 2 * atrAbs;
    const range = Math.max(R - S, 2 * atrAbs);
    const pctOf = v => (v / p - 1) * 100;
    return {
      bull: { trigger: R, target: R + range, pTrigger: pctOf(R), pTarget: pctOf(R + range),
        text: 'A candle close above resistance opens the way to the next zone.' },
      bear: { trigger: S, target: Math.max(S - range, p * 0.01), pTrigger: pctOf(S), pTarget: pctOf(Math.max(S - range, p * 0.01)),
        text: 'Losing support usually brings another leg down.' },
      invalidation: S - atrAbs, pInvalidation: pctOf(S - atrAbs),
      rr: (R + range - p) / Math.max(p - (S - atrAbs), 1e-12),
    };
  }

  // Combine several timeframe scores into one verdict (higher timeframes weigh more)
  function consensus(scores) {
    const w = { '1h': 1, '4h': 1.5, '1d': 2 };
    let s = 0, tw = 0;
    for (const [tf, sc] of Object.entries(scores)) if (sc != null) { s += sc * (w[tf] || 1); tw += w[tf] || 1; }
    if (!tw) return null;
    const v = Math.round(s / tw);
    const vals = Object.values(scores).filter(x => x != null);
    const aligned = vals.every(x => x >= 56) ? 'up' : vals.every(x => x <= 44) ? 'down' : 'mixed';
    return { score: v, aligned };
  }

  // Historical track record of the score on this very chart:
  // every time the score was bullish / bearish, what happened `horizon` candles later?
  function backtest(candles, horizon = 12, step = 2) {
    const n = candles.length;
    if (n < 120 + horizon) return null;
    const res = { bull: { n: 0, hit: 0, ret: 0 }, bear: { n: 0, hit: 0, ret: 0 }, horizon };
    for (let i = 100; i < n - horizon; i += step) {
      const win = candles.slice(Math.max(0, i - 299), i + 1);
      const a = analyze(win);
      if (!a.ok) continue;
      const r = candles[i + horizon].c / candles[i].c - 1;
      if (a.score >= 56) { res.bull.n++; res.bull.ret += r; if (r > 0) res.bull.hit++; }
      else if (a.score <= 44) { res.bear.n++; res.bear.ret += r; if (r < 0) res.bear.hit++; }
    }
    for (const k of ['bull', 'bear']) {
      const b = res[k];
      b.rate = b.n ? b.hit / b.n * 100 : null;
      b.avg = b.n ? b.ret / b.n * 100 : null;
    }
    // baseline: how often was price simply higher after `horizon` candles
    let up = 0, tot = 0;
    for (let i = 100; i < n - horizon; i += step) { tot++; if (candles[i + horizon].c > candles[i].c) up++; }
    res.baseUp = tot ? up / tot * 100 : null;
    return res;
  }

  const api = { backtest, scenarios, consensus, sma, ema, rsi, macd, bollinger, atr, keyLevels, analyze, memeRisk, combine, normalizeGoPlus, resample, compact, fmtPrice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
