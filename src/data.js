/* CryptoRisk data layer — free public APIs only.
   Crypto:    Binance public market data (no key)
   Memecoins: DexScreener (pairs) + GeckoTerminal (candles) + GoPlus (contract security)
   Everything is fetched straight from the browser — no server needed.          */
(function (root) {
  'use strict';
  const C = root.PulseCore;
  const BINANCE = 'https://data-api.binance.vision/api/v3';

  const TF = {
    '1h': { binance: '1h', gecko: ['hour', 1], sec: 3600 },
    '4h': { binance: '4h', gecko: ['hour', 4], sec: 14400, resample: true },
    '1d': { binance: '1d', gecko: ['day', 1], sec: 86400 },
  };

  const GECKO_NET = { solana: 'solana', ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum',
    polygon: 'polygon_pos', avalanche: 'avax', sui: 'sui-network', ton: 'ton', optimism: 'optimism', blast: 'blast' };
  const GOPLUS_CHAIN = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, avalanche: 43114, optimism: 10, blast: 81457 };

  class DataError extends Error {}

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new DataError(`HTTP ${r.status}`);
    return r.json();
  }

  // ---------- crypto (Binance) ----------
  function binanceSymbol(q) {
    let s = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/(USDT|USDC|FDUSD|BTC|ETH|EUR)$/.test(s) || s === 'BTC' || s === 'ETH') s += 'USDT';
    return s;
  }

  const parseKlines = kl => kl.map(k => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  async function binanceCandles(sym, tf) {
    return parseKlines(await getJSON(`${BINANCE}/klines?symbol=${sym}&interval=${TF[tf].binance}&limit=500`));
  }
  async function geckoCandles(pair, tf) {
    const net = GECKO_NET[pair.chainId];
    if (!net) return [];
    const [unit, agg] = TF[tf].gecko;
    const g = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pair.pairAddress}/ohlcv/${unit}?aggregate=${agg}&limit=500&currency=usd`);
    return (g?.data?.attributes?.ohlcv_list || [])
      .map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
      .sort((a, b) => a.t - b.t);
  }

  async function loadCrypto(query, tf) {
    const sym = binanceSymbol(query);
    let klines, ticker;
    try {
      [klines, ticker] = await Promise.all([
        getJSON(`${BINANCE}/klines?symbol=${sym}&interval=${TF[tf].binance}&limit=500`),
        getJSON(`${BINANCE}/ticker/24hr?symbol=${sym}`),
      ]);
    } catch (e) {
      if (e instanceof DataError) {
        // Not on Binance -> try the DEX universe instead
        const meme = await loadMeme(query, tf).catch(() => null);
        if (meme) { meme.note = `${query.toUpperCase()} isn't listed on Binance — showing its main DEX pair instead.`; return meme; }
        throw new Error(`"${query}" not found. Try a ticker like BTC, ETH, SOL.`);
      }
      throw e;
    }
    const candles = parseKlines(klines);
    return {
      type: 'crypto', id: sym, title: sym.replace(/USDT$/, ''), subtitle: `${sym} · Binance`,
      price: +ticker.lastPrice, change24: +ticker.priceChangePercent,
      stats: [
        ['24h high', C.fmtPrice(+ticker.highPrice)],
        ['24h low', C.fmtPrice(+ticker.lowPrice)],
        ['24h volume', '$' + C.compact(+ticker.quoteVolume)],
      ],
      candles, link: `https://www.binance.com/en/trade/${sym.replace(/USDT$/, '_USDT')}`,
    };
  }

  // ---------- memecoins (DEX) ----------
  async function loadMeme(query, tf) {
    const s = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`);
    const pairs = (s.pairs || []).filter(p => p.liquidity && p.liquidity.usd > 0);
    if (!pairs.length) throw new Error(`No DEX pair found for "${query}". Paste the token contract address for exact results.`);
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    // Exact symbol / address matches first
    let pool = pairs.filter(p => p.baseToken.symbol.toLowerCase() === q || p.baseToken.address.toLowerCase() === q);
    if (!pool.length) pool = pairs;
    // Scam clones often show huge "liquidity" but zero real trading.
    // Rank tokens by real activity: total 24h volume + trades across all their pairs.
    const vol = p => p.volume?.h24 || 0;
    const trades = p => (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
    const byToken = new Map();
    for (const p of pool) {
      const k = p.chainId + ':' + p.baseToken.address.toLowerCase();
      const t = byToken.get(k) || { vol: 0, trades: 0, pairs: [] };
      t.vol += vol(p); t.trades += trades(p); t.pairs.push(p);
      byToken.set(k, t);
    }
    const tokens = [...byToken.values()].sort((a, b) => (b.vol + b.trades * 50) - (a.vol + a.trades * 50));
    const best = tokens[0];
    // Within the token, use its most active pair (volume first, liquidity as tie-break)
    const pair = best.pairs.sort((a, b) => (vol(b) - vol(a)) || (b.liquidity.usd - a.liquidity.usd))[0];


    let candles = [];
    try { candles = await geckoCandles(pair, tf); } catch (e) { /* candles stay empty; risk scan still works */ }

    let sec = null;
    try {
      const addr = pair.baseToken.address;
      if (pair.chainId === 'solana') {
        const r = await getJSON(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`);
        sec = C.normalizeGoPlus(r?.result?.[addr] || null, true);
      } else if (GOPLUS_CHAIN[pair.chainId]) {
        const r = await getJSON(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN[pair.chainId]}?contract_addresses=${addr}`);
        sec = C.normalizeGoPlus(r?.result?.[addr.toLowerCase()] || null, false);
      }
    } catch (e) { sec = null; }

    return fromPair(pair, candles, sec);
  }

  function fromPair(pair, candles, sec) {
    return {
      type: 'meme', id: pair.baseToken.address, title: pair.baseToken.symbol,
      subtitle: `${pair.baseToken.name} · ${pair.chainId} · ${pair.dexId}`,
      price: +pair.priceUsd, change24: pair.priceChange?.h24 ?? null,
      stats: [
        ['Liquidity', '$' + C.compact(pair.liquidity?.usd)],
        ['Market cap', '$' + C.compact(pair.marketCap ?? pair.fdv)],
        ['24h volume', '$' + C.compact(pair.volume?.h24)],
      ],
      candles, pair, risk: C.memeRisk(pair, sec), link: pair.url,
    };
  }

  // ---------- demo mode (sandbox previews without network) ----------
  function hash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
  function synth(seedStr, n, sec, start, drift) {
    let s = hash(seedStr) || 1;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const now = Math.floor(Date.now() / 1000 / sec) * sec;
    let p = start, out = [];
    const regime = (rnd() - 0.5) * 2 * drift;
    for (let i = 0; i < n; i++) {
      const phase = Math.sin(i / (n / 3) + rnd() * 0.2);
      const o = p;
      p = Math.max(p * (1 + regime + phase * drift * 0.8 + (rnd() - 0.5) * 0.028), start * 0.05);
      const hi = Math.max(o, p) * (1 + rnd() * 0.01), lo = Math.min(o, p) * (1 - rnd() * 0.01);
      out.push({ t: now - (n - 1 - i) * sec, o, h: hi, l: lo, c: p, v: (800 + rnd() * 900) * (1 + Math.abs(p - o) / o * 40) });
    }
    return out;
  }
  const DEMO_BASE = { BTC: 64000, ETH: 3200, SOL: 150, AAPL: 225, NVDA: 130, TSLA: 240, MSFT: 420 };

  function demoLoad(type, query, tf) {
    const q = query.trim().toUpperCase().replace(/USDT$/, '').replace(/^\$/, '');
    const sec = TF[tf].sec;
    if (type === 'meme') {
      const candles = synth(q + tf, 300, sec, 0.00042, 0.006);
      const h = hash(q);
      const pair = {
        chainId: ['solana', 'base', 'ethereum'][h % 3], dexId: 'raydium', url: '#',
        pairAddress: 'demo', baseToken: { symbol: q, name: q + ' (demo)', address: 'demo-' + q },
        priceUsd: candles[candles.length - 1].c, priceChange: { h24: ((h % 400) - 150) / 10 },
        liquidity: { usd: 8000 + (h % 900000) }, fdv: 200000 + (h % 30000000), marketCap: 200000 + (h % 30000000),
        volume: { h24: 50000 + (h % 4000000) }, txns: { h24: { buys: 300 + (h % 900), sells: 250 + (h % 700) } },
        pairCreatedAt: Date.now() - (h % 90 + 1) * 86400000,
      };
      const sec2 = { honeypot: false, buyTax: 0, sellTax: h % 5 === 0 ? 12 : 0, mintable: h % 4 === 0, freezable: false, ownerPowers: false, topHoldersPct: 15 + (h % 45), lpLockedPct: 40 + (h % 60) };
      return fromPair(pair, candles, sec2);
    }
    const start = DEMO_BASE[q] || 20 + (hash(q) % 400);
    const candles = synth(q + tf, 500, sec, start, 0.0012);
    const last = candles[candles.length - 1].c;
    const dayAgo = candles[Math.max(0, candles.length - 1 - Math.round(86400 / sec))].c;
    return {
      type, id: q, title: q, subtitle: `${q}USDT · Demo`,
      price: last, change24: (last / dayAgo - 1) * 100,
      stats: [['High', C.fmtPrice(Math.max(...candles.slice(-50).map(c => c.h)))], ['Low', C.fmtPrice(Math.min(...candles.slice(-50).map(c => c.l)))], ['Volume', C.compact(candles.slice(-24).reduce((a, c) => a + c.v, 0))]],
      candles, link: '#',
    };
  }

  // ---------- extra timeframes for the consensus ----------
  async function loadCandles(asset, tf, demo) {
    if (demo) return demoLoad(asset.type, asset.title, tf).candles;
    if (asset.type === 'crypto') return binanceCandles(asset.id, tf);
    if (asset.pair) return geckoCandles(asset.pair, tf);
    return [];
  }

  // ---------- market overview ----------
  const BAR = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TON', 'AVAX', 'LINK', 'SUI', 'PEPE'];
  async function loadOverview(demo) {
    if (demo) {
      return {
        tickers: BAR.map(s => { const a = demoLoad('crypto', s, '1h'); return { sym: s, price: a.price, chg: a.change24 }; }),
        fng: { value: 38, label: 'Fear' },
        global: { mcap: 2.31e12, chg: -2.4, btcDom: 57.8 },
      };
    }
    const out = { tickers: [], fng: null, global: null };
    const syms = BAR.map(s => s + 'USDT');
    await Promise.all([
      getJSON(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`)
        .then(r => { out.tickers = r.map(t => ({ sym: t.symbol.replace(/USDT$/, ''), price: +t.lastPrice, chg: +t.priceChangePercent }))
          .sort((a, b) => BAR.indexOf(a.sym) - BAR.indexOf(b.sym)); }).catch(() => {}),
      getJSON('https://api.alternative.me/fng/?limit=1')
        .then(r => { const d = r?.data?.[0]; if (d) out.fng = { value: +d.value, label: d.value_classification }; }).catch(() => {}),
      getJSON('https://api.coingecko.com/api/v3/global')
        .then(r => { const d = r?.data; if (d) out.global = { mcap: d.total_market_cap?.usd, chg: d.market_cap_change_percentage_24h_usd, btcDom: d.market_cap_percentage?.btc }; }).catch(() => {}),
    ]);
    return out;
  }

  // ---------- trending ----------
  async function loadTrending(demo) {
    if (demo) {
      return ['PEPE', 'WIF', 'SUI', 'BONK', 'TAO', 'POPCAT', 'ENA'].map((s, i) => {
        const a = demoLoad('crypto', s, '1h');
        return { sym: s, name: s.charAt(0) + s.slice(1).toLowerCase(), thumb: null, price: a.price / (i % 2 ? 900 : 1), chg: a.change24 * 3, rank: 20 + i * 37 };
      });
    }
    const r = await getJSON('https://api.coingecko.com/api/v3/search/trending');
    return (r?.coins || []).slice(0, 10).map(c => ({
      sym: c.item.symbol.toUpperCase(), name: c.item.name, thumb: c.item.small || c.item.thumb,
      price: c.item.data?.price, chg: c.item.data?.price_change_percentage_24h?.usd, rank: c.item.market_cap_rank,
    }));
  }

  // ---------- live updates ----------
  // Calls onTick({ price, candle? }) until the returned stop() is called.
  function subscribeLive(asset, tf, onTick, demo) {
    let stopped = false;
    if (demo) {
      const last = asset.candles[asset.candles.length - 1];
      if (!last) return () => {};
      const c = Object.assign({}, last);
      const iv = setInterval(() => {
        if (stopped) return;
        c.c = c.c * (1 + (Math.random() - 0.5) * 0.002);
        c.h = Math.max(c.h, c.c); c.l = Math.min(c.l, c.c); c.v += Math.random() * 30;
        onTick({ price: c.c, candle: Object.assign({}, c) });
      }, 1500);
      return () => { stopped = true; clearInterval(iv); };
    }
    if (asset.type === 'crypto' && 'WebSocket' in window) {
      let ws, retry;
      const open = () => {
        ws = new WebSocket(`wss://data-stream.binance.vision/ws/${asset.id.toLowerCase()}@kline_${TF[tf].binance}`);
        ws.onmessage = ev => {
          try {
            const k = JSON.parse(ev.data).k;
            onTick({ price: +k.c, candle: { t: k.t / 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v } });
          } catch (e) { /* ignore malformed frames */ }
        };
        ws.onclose = () => { if (!stopped) retry = setTimeout(open, 3000); };
      };
      open();
      return () => { stopped = true; clearTimeout(retry); try { ws.close(); } catch (e) {} };
    }
    if (asset.pair) {
      const iv = setInterval(async () => {
        try {
          const r = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/${asset.pair.chainId}/${asset.pair.pairAddress}`);
          const p = r?.pairs?.[0] || r?.pair;
          if (p && !stopped) onTick({ price: +p.priceUsd });
        } catch (e) { /* try again next tick */ }
      }, 20000);
      return () => { stopped = true; clearInterval(iv); };
    }
    return () => {};
  }

  // Ticker list for search suggestions
  async function loadSymbols(demo) {
    if (demo) return BAR.concat(['DOT', 'LTC', 'NEAR', 'APT', 'ARB', 'OP', 'TRX', 'SHIB', 'WIF', 'BONK']);
    const r = await getJSON(`${BINANCE}/ticker/price`);
    return r.filter(t => t.symbol.endsWith('USDT')).map(t => t.symbol.slice(0, -4)).filter(s => !/(UP|DOWN|BULL|BEAR)$/.test(s));
  }

  // ---------- self-test: checks every data source the app depends on ----------
  async function runDiagnostics(onUpdate) {
    const results = [];
    const push = r => { results.push(r); onUpdate && onUpdate(results.slice()); };
    const timed = async (name, used, fn) => {
      const t0 = performance.now();
      try {
        const detail = await fn();
        push({ name, used, ok: true, ms: Math.round(performance.now() - t0), detail });
      } catch (e) {
        push({ name, used, ok: false, ms: Math.round(performance.now() - t0), detail: e && e.message ? e.message : String(e) });
      }
    };
    const must = (cond, msg) => { if (!cond) throw new Error(msg); };

    await timed('Binance REST', 'Crypto prices & candles', async () => {
      const k = await binanceCandles('BTCUSDT', '4h');
      must(k.length > 100 && k[k.length - 1].c > 0, 'unexpected candle data');
      return `BTC $${C.fmtPrice(k[k.length - 1].c)} · ${k.length} candles`;
    });
    await timed('Binance live stream', 'Real-time price updates', () => new Promise((resolve, reject) => {
      if (!('WebSocket' in window)) return reject(new Error('WebSocket not supported'));
      const ws = new WebSocket('wss://data-stream.binance.vision/ws/btcusdt@kline_1m');
      const to = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('no message within 8s')); }, 8000);
      ws.onmessage = ev => { clearTimeout(to); try { const k = JSON.parse(ev.data).k; resolve(`tick BTC $${C.fmtPrice(+k.c)}`); } catch (e) { reject(e); } ws.close(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error('connection error')); };
    }));
    let pair = null;
    await timed('DexScreener', 'Memecoin search & pairs', async () => {
      const s = await getJSON('https://api.dexscreener.com/latest/dex/search?q=BONK');
      must(Array.isArray(s.pairs) && s.pairs.length, 'no pairs returned');
      pair = s.pairs.filter(p => p.chainId === 'solana' && p.baseToken.symbol.toUpperCase() === 'BONK')
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0] || s.pairs[0];
      return `${s.pairs.length} pairs · BONK $${C.fmtPrice(+pair.priceUsd)} on ${pair.chainId}`;
    });
    await timed('GeckoTerminal', 'Memecoin candles', async () => {
      must(pair, 'skipped — DexScreener failed');
      const c = await geckoCandles(pair, '4h');
      must(c.length > 0, 'empty candle list');
      return `${c.length} candles · last close $${C.fmtPrice(c[c.length - 1].c)}`;
    });
    await timed('GoPlus Security', 'Memecoin contract checks', async () => {
      must(pair, 'skipped — DexScreener failed');
      const addr = pair.baseToken.address;
      const r = pair.chainId === 'solana'
        ? await getJSON(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`)
        : await getJSON(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN[pair.chainId] || 1}?contract_addresses=${addr}`);
      const item = r?.result?.[addr] || r?.result?.[addr.toLowerCase()];
      must(item, `no result (code ${r?.code ?? '?'}: ${r?.message || 'unknown'})`);
      return 'security data received';
    });
    await timed('CoinGecko trending', 'Trending section', async () => {
      const r = await getJSON('https://api.coingecko.com/api/v3/search/trending');
      must(r?.coins?.length, 'no coins');
      return `${r.coins.length} coins · #1 ${r.coins[0].item.symbol}`;
    });
    await timed('CoinGecko global', 'Market cap & BTC dominance', async () => {
      const r = await getJSON('https://api.coingecko.com/api/v3/global');
      must(r?.data?.total_market_cap?.usd, 'missing market cap');
      return `MCap $${C.compact(r.data.total_market_cap.usd)}`;
    });
    await timed('Fear & Greed', 'Market mood index', async () => {
      const r = await getJSON('https://api.alternative.me/fng/?limit=1');
      must(r?.data?.[0]?.value, 'missing value');
      return `${r.data[0].value} · ${r.data[0].value_classification}`;
    });
    return results;
  }

  // Probe whether live APIs are reachable from this page
  async function probeLive() {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(`${BINANCE}/ping`, { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch { return false; }
  }

  async function load(type, query, tf, demo) {
    if (demo) return demoLoad(type, query, tf);
    if (type === 'crypto') return loadCrypto(query, tf);
    return loadMeme(query, tf);
  }

  root.PulseData = { load, probeLive, runDiagnostics, loadCandles, loadOverview, loadTrending, subscribeLive, loadSymbols, TF };
})(window);
