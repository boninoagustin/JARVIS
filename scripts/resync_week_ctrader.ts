// resync_week_ctrader.ts — sincroniza trade_journal con los deals REALES de cTrader
// desde el corte del 14/09/2026 00:00 ARG (03:00 UTC). Ese es el punto de partida del
// nuevo diario: todo lo anterior se descarta a propósito (decisión Bon, sep-2026).
//
// Por cada posición cerrada en la ventana:
//   - PnL neto = Σ (grossProfit + commission + swap) de TODOS los deals (apertura+parciales+cierre).
//   - Si el doc ya existe (por ctraderPositionId): corrige pnl/rMultiple/balanceAfter/result (respeta manualResult).
//   - Si no existe: crea el doc con datos reales del deal (rMultiple null: sin SL inicial no se inventa riesgo).
//
// Conecta cTrader unos segundos (el bot se reconecta solo). Correr en ventana sin posiciones abiertas.
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { computeRMultipleFromPnlUsd } from '../src/engine/FrictionModel.js';

const { connect } = await import('ctrader-ts');
const adminModule = await import('firebase-admin');
const admin = adminModule.default ?? adminModule;
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const DRY = process.argv.includes('--dry-run');
// 🛡️ 24-sep-2026: corte alineado con el del panel (20/09 00:00 ARG). Los docs previos
// fueron borrados a pedido de Bon — este corte evita que el resync los re-cree.
const CORTE_UTC = Date.parse('2026-09-20T03:00:00Z'); // 20/09 00:00 ARG

console.log(`[RESYNC] ${DRY ? 'DRY-RUN' : 'APLICANDO'} — ventana desde ${new Date(CORTE_UTC).toISOString()}`);
console.log('[RESYNC] conectando a cTrader (el bot se reconecta solo)...');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID,
  clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN,
  accountId: parseInt(process.env.CTRADER_ACCOUNT_ID!, 10) || 0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
});
console.log('[RESYNC] ✅ conectado.');

const state = await client.getState();
console.log(`[RESYNC] saldo actual: $${state.balance} | equity: $${state.equity} | abiertas: ${state.positions?.length ?? 0}`);

const dealsResp: any = await client.getDeals({ from: CORTE_UTC, to: Date.now(), maxRows: 5000 });
const deals: any[] = dealsResp?.deals ?? dealsResp ?? [];
console.log(`[RESYNC] deals en ventana: ${deals.length}`);

// símbolos → ticker (catálogo cacheado del SDK)
let symNames: Record<number, string> = {};
try {
  const syms: any[] = await client.getSymbols();
  for (const s of syms) symNames[Number(s.symbolId)] = String(s.symbolName ?? s.name ?? '').toUpperCase();
} catch (e: any) { console.warn('[RESYNC] no se pudieron resolver símbolos:', e.message); }
console.log('[RESYNC] símbolos en catálogo:', Object.keys(symNames).length);

try { await (client as any).disconnect?.(); } catch { }
console.log('[RESYNC] desconectado.\n');

// ─── agrupar por posición ───
type P = { pid: number; open?: any; closes: any[] };
const byPid = new Map<number, P>();
for (const d of deals) {
  const pid = Number(d.positionId);
  if (!byPid.has(pid)) byPid.set(pid, { pid, closes: [] });
  const p = byPid.get(pid)!;
  if (d.closePositionDetail) p.closes.push(d);
  else if (!p.open) p.open = d;
}

// ─── journal actual ───
const snap = await db.collection('trade_journal').get();
const byPosId = new Map<string, any>();
for (const d of snap.docs) {
  const x = d.data();
  if (x.ctraderPositionId) byPosId.set(String(x.ctraderPositionId), { id: d.id, ref: d.ref, ...x });
}

const rows = [...byPid.values()].filter(p => p.closes.length > 0)
  .sort((a, b) => Number(a.open?.executionTimestamp ?? 0) - Number(b.open?.executionTimestamp ?? 0));

let creados = 0, corregidos = 0, saltados = 0;
console.log(`Posiciones cerradas en la ventana: ${rows.length}\n`);

for (const p of rows) {
  const pid = String(p.pid);
  const open = p.open;
  // 🛡️ FIX 24-sep-2026: el cierre FINAL es el deal con mayor balanceVersion, NO el último
  // del array (cTrader devuelve deals en orden descendente → el último es el parcial TP1).
  const lastClose = p.closes.reduce((best: any, d: any) => {
    if (!best) return d;
    return Number(d.closePositionDetail?.balanceVersion ?? 0) > Number(best.closePositionDetail?.balanceVersion ?? 0) ? d : best;
  }, null as any);
  const cp = lastClose.closePositionDetail;
  const md = Number(lastClose.moneyDigits ?? cp.moneyDigits ?? 2);
  let raw = 0;
  for (const d of deals.filter((x: any) => Number(x.positionId) === p.pid)) {
    const c = d.closePositionDetail;
    // 🛡️ 24-sep-2026: solo deals de CIERRE — la comisión del deal de apertura NO se debita
    // del saldo en esta cuenta (medido con balanceVersion: NCBETA 3972.48→3983.00 = gross−comm).
    raw += c ? Number(c.grossProfit || 0) + Number(c.commission || 0) + Number(c.swap || 0) : 0;
  }
  const netUsd = Math.round((raw / Math.pow(10, md)) * 100) / 100;
  const balanceAfterUsd = cp?.balance != null ? Math.round((Number(cp.balance) / Math.pow(10, md)) * 100) / 100 : null;
  const ticker = symNames[Number(open?.symbolId)] || `SYM${open?.symbolId}`;
  const direction = Number(open?.tradeSide) === 1 ? 'BUY' : Number(open?.tradeSide) === 2 ? 'SELL' : null;
  const entryPrice = open?.executionPrice ?? cp?.entryPrice ?? null;
  const openTs = Number(open?.executionTimestamp ?? open?.createTimestamp ?? 0) || null;
  // 🛡️ 24-sep-2026: divisor de lotes POR CLASE de activo (espejo de getLotSizeCents del bot).
  // Antes /10^7 fijo → XAU quedaba en 0.00001 lotes y el R salía inflado 1000× (HIKZ94 -1019R).
  const tn = (ticker || '').toUpperCase().replace(/\s+/g, '');
  const lotSizeCents = tn.includes('XAU') || tn.includes('GOLD') ? 10000
    : tn.includes('BTC') || tn.includes('ETH') || tn.includes('US30') || tn.includes('NAS')
      || tn.includes('SPX') || tn.includes('US100') || tn.includes('USTEC') || tn.includes('US500')
      || tn.includes('GER') || tn.includes('DE40') || tn.includes('DAX') || tn.includes('JP225') ? 100
    : tn.includes('XAG') || tn.includes('SILVER') ? 500000
    : tn.includes('OIL') || tn.includes('WTI') || tn.includes('BRENT') || tn.includes('XTI') ? 10000
    : 10000000;
  const lots = open?.filledVolume ? Number(open.filledVolume) / lotSizeCents : 0;
  const result = netUsd > 0.1 ? 'WIN' : netUsd < -0.1 ? 'LOSS' : 'BREAKEVEN';

  if (!open || !direction || !entryPrice || !openTs) {
    console.log(`⏭️  posID ${pid}: sin deal de apertura completo en ventana — se salta (abierta antes del corte).`);
    saltados++;
    continue;
  }

  const doc = byPosId.get(pid);
  if (doc) {
    if (doc.manualResult) {
      console.log(`⏭️  #${doc.id} ${ticker}: manualResult — se respeta resultado manual.`);
      saltados++;
      continue;
    }
    const slInicial = Number(doc.initialSlPrice ?? doc.originalSlPrice ?? doc.slPrice ?? 0);
    const entryNum = Number(entryPrice);
    // 🛡️ sanidad: SL del lado correcto (BUY: SL<entry | SELL: SL>entry). Si no, riesgo no
    // computable → rMultiple null (no se inventa R).
    const slValido = slInicial > 0 && entryNum > 0
      && (direction === 'BUY' ? slInicial < entryNum : slInicial > entryNum)
      && lots > 0;
    const rMultiple = slValido
      ? computeRMultipleFromPnlUsd(ticker, entryNum, slInicial, lots || Number(doc.ctraderLots ?? 0), netUsd)
      : null;
    const data: any = { ctrader_real_pnl: netUsd, balanceAfterUsd, result, rMultiple, resyncedAt: Date.now() };
    if (doc.result === 'REVERSAL') data.reversalClosed = true; // 🛡️ marcar cierres por reversión
    if (DRY) {
      console.log(`[DRY] #${doc.id} ${ticker} ${doc.result ?? '?'}→${result} pnl $${doc.ctrader_real_pnl ?? '?'}→$${netUsd} R ${doc.rMultiple ?? '?'}→${rMultiple}`);
    } else {
      await doc.ref.update(data);
      console.log(`✅ #${doc.id} ${ticker}: ${result} pnl=$${netUsd} R=${rMultiple} (corregido)`);
    }
    corregidos++;
  } else {
    const id = `CTR${pid}`;
    const data = {
      id, ticker, direction, grade: 'Reconciliado', points: 0,
      timestamp: openTs, entryPrice, ctraderLots: lots,
      ctraderStatus: 'EXECUTED', ctraderPositionId: pid,
      result, ctrader_real_pnl: netUsd, balanceAfterUsd,
      rMultiple: null, // sin SL inicial histórico → no se inventa riesgo
      reconciled: true, closedAt: new Date(lastClose.executionTimestamp ?? Date.now()).toISOString(),
      resyncedAt: Date.now(),
    };
    if (DRY) {
      console.log(`[DRY] CREAR #${id} ${ticker} ${direction} ${result} pnl=$${netUsd} lots=${lots} saldo=$${balanceAfterUsd}`);
    } else {
      await db.collection('trade_journal').doc(id).set(data);
      console.log(`🆕 #${id} ${ticker} ${direction} ${result} pnl=$${netUsd} lots=${lots} saldo=$${balanceAfterUsd} (creado)`);
    }
    creados++;
  }
}

console.log(`\n[RESYNC] creados=${creados} corregidos=${corregidos} saltados=${saltados} ${DRY ? '(DRY-RUN — nada escrito)' : ''}`);
process.exit(0);
