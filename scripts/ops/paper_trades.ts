#!/usr/bin/env tsx
/**
 * paper_trades.ts — paper mode (Opción A, 09-nov-2026).
 *
 * Para los activos APAGADOS del universo de optimización (active_tickers) replica la
 * ventana reciente con el motor SMC COMPLETO (todas las temporalidades M5→D1, vía
 * eval_production → jarvis_hyperopt_worker) y guarda los trades individuales simulados
 * como evidencia `paper`. NUNCA ejecuta en cTrader ni toca enabled/roster/riesgo.
 *
 * El roster usa esta evidencia (n≥8, WR≥40%, expectativa>0) para PROPONER activar un
 * activo apagado; la activación real sigue siendo decisión del operador.
 *
 * Uso:  npx tsx scripts/ops/paper_trades.ts            # dry-run
 *       npx tsx scripts/ops/paper_trades.ts --apply    # escribe paper_trades/{ticker}
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const EVAL = path.join(REPO, 'scripts/periodic_opt/eval_production.ts');
const APPLY = process.argv.includes('--apply');
const WARMUP_DAYS = 60;    // contexto previo a la ventana paper (mismo criterio que prospective_test)
const PAPER_WINDOW_DAYS = 90; // ventana reciente de evidencia (trimestre, para juntar muestra suficiente)

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

function trading(cfg: any): boolean {
  return cfg?.enabled === true && !String(cfg?.disabledReason || '').trim();
}

async function paperOne(ticker: string, cfg: any): Promise<void> {
  const snapFile = path.join(REPO, 'scripts', 'periodic_opt', 'opt_out', 'paper', ticker, 'production.json');
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  fs.writeFileSync(snapFile, JSON.stringify({ ...cfg, ticker }, null, 2));

  const now = Date.now();
  const windowStart = now - PAPER_WINDOW_DAYS * 864e5;
  const from = windowStart - WARMUP_DAYS * 864e5;
  const manifest = { version: 1, ticker, from_ms: from, train_end_ms: windowStart,
    validation_end_ms: now, test_end_ms: now, test_independence: 'unverified' };
  const manifestFile = path.join(path.dirname(snapFile), 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const outFile = path.join(path.dirname(snapFile), 'out.json');
  const r = spawnSync(`${REPO}/node_modules/.bin/tsx`, [EVAL, ticker, '--config-file', snapFile,
    '--evaluation-manifest', manifestFile, '--logs-dir', `${REPO}/logs/${ticker.toLowerCase()}/history_exported`,
    '--save', outFile], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`eval falló: ${(r.stderr || r.stdout || '').slice(-400)}`);
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  const trades = (Array.isArray(out.validation_trades) ? out.validation_trades : []).map((t: any) => {
    const rMultiple = Number(t.rMultiple);
    return {
      ticker,
      timestamp: t.timestamp ?? t.entryTs ?? t.entryTimestamp ?? null,
      direction: t.direction ?? null,
      entryPrice: t.entryPrice ?? null,
      slPrice: t.slPrice ?? null,
      rMultiple: Number.isFinite(rMultiple) ? rMultiple : null,
      result: Number.isFinite(rMultiple) ? (rMultiple > 0 ? 'WIN' : rMultiple < 0 ? 'LOSS' : 'BREAKEVEN') : null,
      closedAt: t.closeTimestamp ?? null,
      mode: 'paper', isPaper: true,
    };
  }).filter((t: any) => t.result !== null);

  const n = trades.length;
  const wins = trades.filter((t: any) => t.result === 'WIN').length;
  const wr = n ? wins / n : 0;
  const sumR = trades.reduce((s: number, t: any) => s + (t.rMultiple ?? 0), 0);
  const expectancy = n ? sumR / n : 0;
  console.log(`  ${ticker}: ${n} trades paper · WR ${(wr * 100).toFixed(0)}% · ΣR ${sumR.toFixed(2)} · exp ${expectancy.toFixed(3)}`);

  if (!APPLY) { console.log('  [dry-run] no se escribió'); return; }
  await db.collection('paper_trades').doc(ticker).set({
    ticker, generatedAt: new Date().toISOString(),
    window: { from_ms: windowStart, to_ms: now, warmup_days: WARMUP_DAYS },
    n, wins, wr, sumR, expectancy,
    trades,
  });
  console.log(`  ✅ ${ticker}: paper_trades guardado`);
}

async function main() {
  const atSnap = await db.collection('optimization_config').doc('active_tickers').get();
  const atData = atSnap.data() || {};
  const active: string[] = Array.isArray(atData.tickers) ? atData.tickers : [];
  const cfgs = await db.collection('asset_configs').get();
  const cfgMap = new Map(cfgs.docs.map((d) => [d.id, d.data()]));
  const offTickers = active.filter((t) => !trading(cfgMap.get(t)));
  console.log(`paper mode: ${offTickers.length} activo(s) apagados a simular (ventana ${PAPER_WINDOW_DAYS}d)${APPLY ? '' : ' [dry-run]'}`);
  for (const ticker of offTickers) {
    try { await paperOne(ticker, cfgMap.get(ticker) || {}); }
    catch (e: any) { console.error(`  ${ticker}: ERROR ${e.message}`); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
