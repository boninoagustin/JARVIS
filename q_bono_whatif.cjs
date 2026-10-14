// What-if bono escalonado: recalcula el bono de alineación sobre el journal histórico
// y mide qué entradas habrían quedado bloqueadas (y su PnL real).
const adminModule = require("firebase-admin");
const fs = require("node:fs");
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (adminModule.apps.length === 0) adminModule.initializeApp({ credential: adminModule.credential.cert(sa) });
const db = adminModule.firestore();
db.settings({ ignoreUndefinedProperties: true });

function bonusViejo(n) { return n >= 1 ? 5 : 0; }
function bonusNuevo(n) { return n >= 3 ? 5 : n === 2 ? 2 : 0; }

(async () => {
  // 1) minScore por ticker/sesión/gatillo desde asset_configs
  const cfgSnap = await db.collection('asset_configs').get();
  const cfgs = {};
  for (const d of cfgSnap.docs) {
    const x = d.data();
    cfgs[d.id] = {
      sessions: (x.sessions || {}),
      minBuy: x.minPointsForBuy ?? 8,
      minSell: x.minPointsForSell ?? 8,
    };
  }
  function minScoreFor(ticker, session, triggerKey, direction) {
    const c = cfgs[ticker];
    if (!c) return direction === 'BUY' ? 8 : 8;
    const t = c.sessions[session]?.[triggerKey] || c.sessions['ALL']?.[triggerKey];
    if (t && t.minScore !== undefined && t.minScore !== null) {
      const m = direction === 'BUY' ? (t.minScoreBuy ?? t.minScore) : (t.minScoreSell ?? t.minScore);
      if (m !== undefined && m !== null) return m;
    }
    return direction === 'BUY' ? c.minBuy : c.minSell;
  }

  // 2) journal: export + Firestore
  const trades = [];
  const exp = JSON.parse(fs.readFileSync('/opt/JARVIS/logs/trade_journal_export.json', 'utf8'));
  for (const t of exp) trades.push(t);
  const fsSnap = await db.collection('trade_journal').get();
  for (const d of fsSnap.docs) {
    const x = d.data();
    if (!x.macroContext) continue;
    if (trades.some(t => t.id === d.id)) continue;
    trades.push(x);
  }
  console.log('total trades con datos:', trades.length);

  // 3) what-if
  const blocked = [];
  let skipped = 0;
  for (const t of trades) {
    const mc = t.macroContext;
    const dir = t.direction;
    const pts = t.points;
    if (!mc || dir === undefined || pts === undefined || pts === null) { skipped++; continue; }
    let aligned = 0;
    for (const tf of ['D', '240', '60']) if (mc[tf] === dir) aligned++;
    const bv = bonusViejo(aligned);
    const bn = bonusNuevo(aligned);
    const delta = bn - bv;
    if (delta === 0) continue; // sin cambio
    const newPts = pts + delta;
    const session = t.session || 'ALL';
    const trig = t.triggerKey || 'choch5m';
    const minScore = minScoreFor(t.ticker, session, trig, dir);
    const threshold = Math.min(minScore, 8);
    const wouldBlock = newPts < threshold;
    if (!wouldBlock) continue;
    blocked.push({ ...t, aligned, oldPts: pts, newPts, minScore, threshold, delta, session, trig });
  }

  console.log(`\n=== Operaciones que la regla escalonada HABRÍA BLOQUEADO: ${blocked.length} (skipped ${skipped}) ===`);
  let savedUsd = 0, lostWinUsd = 0, savedLossCount = 0, lostWinCount = 0, otherCount = 0;
  for (const b of blocked) {
    const res = b.result || '?';
    const pnl = typeof b.ctrader_real_pnl === 'number' ? b.ctrader_real_pnl : null;
    const date = b.date || (b.timestamp ? new Date(b.timestamp).toISOString().slice(0, 10) : '?');
    console.log(`${date} ${b.ticker} ${b.direction} | pts ${b.oldPts}→${b.newPts} (bono ${b.aligned}/3) | umbral ${b.threshold} (${b.session}/${b.trig}) | real: ${res}${pnl !== null ? ' $' + pnl.toFixed(2) : ''}`);
    if (res === 'LOSS') { savedLossCount++; if (pnl !== null) savedUsd += pnl; }
    else if (res === 'WIN') { lostWinCount++; if (pnl !== null) lostWinUsd += pnl; }
    else otherCount++;
  }
  console.log(`\n=== RESUMEN ===`);
  console.log(`Bloqueadas: ${blocked.length} | LOSS evitadas: ${savedLossCount} ($${savedUsd.toFixed(2)}) | WIN sacrificadas: ${lostWinCount} ($${lostWinUsd.toFixed(2)}) | otros: ${otherCount}`);
  console.log(`Neto $: ${(savedUsd + lostWinUsd).toFixed(2)} (ahorro − wins perdidos)`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
