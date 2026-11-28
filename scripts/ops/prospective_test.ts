#!/usr/bin/env tsx
/**
 * TEST PROSPECTIVO (forward/shadow) — 02-nov-2026
 *
 * Problema que resuelve: el ciclo semanal solo puede aplicar si el reporte trae un
 * Test independiente (`test_independence='prospective'`), que hoy NUNCA se produce
 * (siempre 'unverified'). Y con 2-4 trades por activo/semana el Montecarlo casi nunca
 * alcanza a certificar nada. Resultado: todo queda en HOLD para siempre.
 *
 * Este módulo registra un candidato RECOMMEND y lo evalúa **hacia adelante**, sobre
 * datos que no existían cuando se eligió: congela el corte (train_end = fecha de
 * registro) y compara candidato vs producción sobre lo que vino después. No toca la
 * configuración viva: es solo evidencia.
 *
 * Uso:
 *   npx tsx scripts/ops/prospective_test.ts register XPDUSD [--since YYYY-MM-DD]
 *   npx tsx scripts/ops/prospective_test.ts evaluate [--ticker XPDUSD] [--apply]
 *   npx tsx scripts/ops/prospective_test.ts status
 *
 * Criterio de certificación (igual de conservador que el resto del sistema):
 *   - ≥ 8 trades forward para cada lado
 *   - expectancy(candidato) ≥ expectancy(producción) + 0.05 R/trade
 *   - se rechaza si el candidato pierde con ≥ 8 trades, o a las 6 semanas sin muestra
 *
 * `--apply` escribe la evidencia en Firestore. Sin él, todo es dry-run. Nunca aplica
 * configuración: la aplicación sigue pasando por apply_weekly.ts (--weekly-rollout).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const COLL = 'prospective_tests';
const EVAL = path.join(REPO, 'scripts/periodic_opt/eval_production.ts');
const WORK = '/tmp/prospective_test';
const MIN_FWD_TRADES = 8;
const MIN_DELTA_R = 0.05;
const MAX_WEEKS = 6;
const WARMUP_DAYS = 60;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const has = (name: string) => argv.includes(name);
const APPLY = has('--apply');
const DAY = 864e5;

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const assetRef = (t: string) => db.collection('asset_configs').doc(t);
const testRef = (t: string) => db.collection(COLL).doc(t);
const reportsDir = path.join(REPO, 'scripts/periodic_opt/reports');
const logsDir = (t: string) => path.join(REPO, 'logs', t.toLowerCase(), 'history_exported');

// Los CSV se refrescan el sábado: la ventana forward no puede pasar del último dato real.
function dataEndMs(ticker: string): number | null {
  const f = path.join(logsDir(ticker), 'pine-logs-SMC Master_M5.csv');
  if (!fs.existsSync(f)) return null;
  const r = spawnSync('tail', ['-1', f], { encoding: 'utf8' });
  const m = /^"?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2})?)/.exec((r.stdout || '').trim());
  const ms = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function runEval(ticker: string, snapshotFile: string, manifestFile: string, outFile: string) {
  const r = spawnSync(`${REPO}/node_modules/.bin/tsx`, [EVAL, ticker, '--config-file', snapshotFile,
    '--evaluation-manifest', manifestFile, '--logs-dir', logsDir(ticker), '--save', outFile],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`eval falló (${ticker}): ${(r.stderr || r.stdout || '').slice(-400)}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

function digest(m: any) {
  const n = m?.trade_count;
  return { n: Number.isInteger(n) ? n : 0, expectancy: Number.isFinite(m?.expectancy) ? m.expectancy : null };
}

async function register(ticker: string) {
  const reportFile = path.join(reportsDir, `${ticker}.json`);
  if (!fs.existsSync(reportFile)) throw new Error(`no hay reporte semanal para ${ticker}`);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (report.status !== 'RECOMMEND') throw new Error(`${ticker}: el reporte está en ${report.status}, solo se registran RECOMMEND`);
  const candidate = report.final_asset_config;
  if (!candidate || typeof candidate !== 'object') throw new Error(`${ticker}: reporte sin final_asset_config`);

  const existing = await testRef(ticker).get();
  if (existing.exists && !has('--force')) {
    console.log(`[register] ${ticker}: ya registrado (${(existing.data() as any).status}) — usá --force para reiniciar`);
    return;
  }

  const prod = (await assetRef(ticker).get()).data() || {};
  const sinceArg = flag('--since');
  const registeredAt = sinceArg ? Date.parse(`${sinceArg}T00:00:00Z`) : Date.now();
  if (!Number.isFinite(registeredAt)) throw new Error('--since inválido (YYYY-MM-DD)');

  // Captura del candidato CONGELADO + proveniencia para el paper forward (09-nov-2026).
  // Sin esto, paper_replay invalida el registro (fail-closed) en vez de simular.
  const { mapAssetConfig } = await import('../periodic_opt/selection_context.js');
  const { configFingerprint } = await import('../hyperopt/evaluation_protocol.js');
  const { RpcWorker } = await import('../periodic_opt/eval_production.js');
  const { registrationIdentity } = await import('./paper_replay.js');
  const logsDir = path.join(REPO, 'logs', ticker.toLowerCase(), 'history_exported');
  let cache: string | undefined;
  if (candidate.timesfm?.enabled) {
    const p = candidate.timesfm.cachePath ?? path.join(REPO, 'logs', ticker.toLowerCase(), 'forecasts', 'forecasts_m5.jsonl');
    if (fs.existsSync(p)) cache = path.resolve(p);
  }
  const engineConfig = mapAssetConfig(ticker, candidate, cache);
  const w = new RpcWorker();
  let init: any;
  try { init = await w.call('init', { ticker, log_dir: logsDir }); } finally { w.close(); }
  const canonical = (xs: any[]) => (xs || []).map((x: any) => ({ path: x.path, sha256: x.sha256 }));

  const doc: any = {
    ticker, status: 'SHADOW',
    registered_at_ms: registeredAt,
    source_report_timestamp: report.timestamp,
    candidate_asset_snapshot: candidate,
    candidate_fingerprint: report.final_asset_fingerprint ?? null,
    candidate_engine_snapshot: engineConfig,
    candidate_engine_fingerprint: configFingerprint(engineConfig),
    source_files: canonical(init?.provenance?.source_files),
    model_files: canonical(init?.provenance?.model_files),
    cache_files: canonical(init?.provenance?.cache_files),
    production_asset_snapshot: JSON.parse(JSON.stringify(prod)),
    baseline: digest(report.production_validation),
    evaluations: [], weeks_elapsed: 0,
  };
  doc.registration_fingerprint = configFingerprint(registrationIdentity(doc));
  console.log(`[register] ${ticker} · RECOMMEND de ${new Date(report.timestamp).toISOString().slice(0, 10)} · corte forward desde ${new Date(registeredAt).toISOString().slice(0, 10)}`);
  console.log(`[register] baseline producción: n=${doc.baseline.n} exp=${doc.baseline.expectancy}`);
  if (!APPLY) { console.log('[dry-run] agregá --apply para registrar en Firestore'); return; }
  await testRef(ticker).set(doc);
  console.log(`[register] ✅ ${COLL}/${ticker} creado (SHADOW)`);
}

async function evaluate(ticker: string) {
  const snap = await testRef(ticker).get();
  if (!snap.exists) { console.log(`  ${ticker}: sin test registrado`); return; }
  const t = snap.data() as any;
  if (t.status === 'CERTIFIED' || t.status === 'REJECTED') { console.log(`  ${ticker}: ${t.status} (nada que evaluar)`); return; }

  const now = Math.min(Date.now(), dataEndMs(ticker) ?? Date.now());
  const registeredAt = t.registered_at_ms;
  if (now <= registeredAt) {
    const last = new Date(now).toISOString().slice(0, 10);
    console.log(`  ${ticker}: sin datos forward todavía (el último dato es del ${last}, el registro del ${new Date(registeredAt).toISOString().slice(0, 10)}) — se reevalúa tras el próximo refresh del sábado`);
    return;
  }
  if (now - registeredAt < 7 * DAY) {
    const days = ((now - registeredAt) / DAY).toFixed(1);
    console.log(`  ${ticker}: ${days} días de forward (< 7), se omite`);
    return;
  }
  const weeks = Math.floor((now - registeredAt) / (7 * DAY));

  fs.mkdirSync(path.join(WORK, ticker), { recursive: true });
  const from = registeredAt - WARMUP_DAYS * DAY;
  const manifest = { version: 1, ticker, from_ms: from, train_end_ms: registeredAt,
    validation_end_ms: now, test_end_ms: now, test_independence: 'unverified' };
  const manifestFile = path.join(WORK, ticker, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const prodSnapFile = path.join(WORK, ticker, 'production.json');
  fs.writeFileSync(prodSnapFile, JSON.stringify({ ...t.production_asset_snapshot, ticker }, null, 2));
  const candSnapFile = path.join(WORK, ticker, 'candidate.json');
  fs.writeFileSync(candSnapFile, JSON.stringify({ ...t.candidate_asset_snapshot, ticker }, null, 2));

  console.log(`  ${ticker}: evaluando forward ${new Date(registeredAt).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} (${weeks} sem)`);
  const prodOut = runEval(ticker, prodSnapFile, manifestFile, path.join(WORK, ticker, 'prod_out.json'));
  const candOut = runEval(ticker, candSnapFile, manifestFile, path.join(WORK, ticker, 'cand_out.json'));

  // train_end = fecha de registro → la partición de validación ES la ventana forward.
  if (Array.isArray(t.source_files) && t.source_files.length > 0) {
    const evalSrc = (p: string) => {
      const rel = p.replace(/^\/opt\/JARVIS\//, '');
      return /^(src\/|jarvis-os\/src\/(engine|services)\/)/.test(rel) ||
        ['scripts/hyperopt/jarvis_hyperopt_worker.ts', 'scripts/hyperopt/evaluation_protocol.ts',
         'scripts/hyperopt/wfa_window.ts', 'scripts/periodic_opt/selection_context.ts',
         'scripts/periodic_opt/eval_production.ts'].includes(rel);
    };
    const nowByPath = new Map((prodOut.provenance?.source_files || []).map((x: any) => [x.path, x.sha256]));
    const changed = t.source_files.filter((x: any) => evalSrc(String(x.path || '')) && nowByPath.get(x.path) !== x.sha256);
    if (changed.length > 0) {
      console.log(`  ${ticker}: motor evaluado cambió desde el registro (${changed.length} archivo(s)) — no se certifica con inputs incompatibles`);
      return;
    }
  }
  const p = digest(prodOut.metrics_validation);
  const c = digest(candOut.metrics_validation);
  let verdict = 'PENDING';
  let reason = 'muestra forward insuficiente';
  if (c.n >= MIN_FWD_TRADES && p.n >= MIN_FWD_TRADES) {
    const delta = (c.expectancy ?? -Infinity) - (p.expectancy ?? Infinity);
    if (delta >= MIN_DELTA_R) { verdict = 'CERTIFIED'; reason = `Δ ${delta.toFixed(3)} R/t ≥ ${MIN_DELTA_R}`; }
    else { verdict = 'REJECTED'; reason = `Δ ${delta.toFixed(3)} R/t < ${MIN_DELTA_R}`; }
  } else if (weeks >= MAX_WEEKS) {
    verdict = 'REJECTED'; reason = `sin muestra suficiente en ${MAX_WEEKS} semanas`;
  }

  const evidence = { evaluated_at_ms: now, weeks, window: { from_ms: registeredAt, to_ms: now },
    production: p, candidate: c, verdict, reason,
    manifest_fingerprint: prodOut.evaluation_fingerprint ?? null };
  console.log(`  ${ticker}: producción n=${p.n} exp=${p.expectancy} | candidato n=${c.n} exp=${c.expectancy} → ${verdict} (${reason})`);

  if (!APPLY) { console.log('  [dry-run] no se escribió evidencia'); return; }
  const evaluations = [...(t.evaluations || []).slice(-9), evidence];
  await testRef(ticker).set({ ...t, status: verdict === 'PENDING' ? 'SHADOW' : verdict, weeks_elapsed: weeks,
    evaluations, latest: evidence }, { merge: false });
  console.log(`  ✅ ${ticker}: estado ${verdict} persistido`);
}

async function evaluateAll() {
  const only = flag('--ticker');
  const all = only ? [only.toUpperCase()] : (await db.collection(COLL).get()).docs.map((d) => d.id);
  console.log(`evaluando ${all.length} test(s) prospectivo(s)${APPLY ? '' : ' [dry-run]'}`);
  for (const t of all) { try { await evaluate(t); } catch (e: any) { console.error(`  ${t}: ERROR ${e.message}`); } }
}

async function autoregister() {
  // Registra como SHADOW sólo RECOMMEND verificados de la corrida actual y dentro de active_tickers.
  const stateDir = process.env.MARK_DIR || '/var/lib/jarvis';
  const summaryPath = process.env.WEEKLY_SUMMARY || path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_selection_summary.json');
  const vr = spawnSync('python3', [path.join(REPO, 'scripts/periodic_opt/weekly_cycle_state.py'), 'verify', '--state-dir', stateDir, '--summary', summaryPath], { encoding: 'utf8', timeout: 15_000 });
  if (vr.status !== 0) {
    throw new Error(`autoregister abortado: ciclo semanal no verificado (${(vr.stderr || vr.stdout || '').trim()})`);
  }
  const ctx = JSON.parse(vr.stdout);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const atDoc = await db.collection('optimization_config').doc('active_tickers').get();
  const activeSet = new Set<string>(((atDoc.data()?.tickers as string[]) || []).map((t) => t.toUpperCase()));
  const evaluatedTs = new Map<string, number>();
  for (const o of summary.outcomes || []) {
    if (o.outcome === 'evaluated' && o.status === 'RECOMMEND' && !o.deployment_error) {
      evaluatedTs.set(String(o.ticker).toUpperCase(), Number(o.timestamp));
    }
  }

  let n = 0;
  for (const [ticker, expectedTs] of evaluatedTs) {
    if (!activeSet.has(ticker)) continue;
    const f = path.join(reportsDir, `${ticker}.json`);
    if (!fs.existsSync(f)) continue;
    let rep: any; try { rep = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!rep || rep.status !== 'RECOMMEND' || !rep.final_asset_config || !rep.evaluation_certificate) continue;
    if (rep.timestamp !== expectedTs || rep.timestamp < ctx.started_at || Date.now() - rep.timestamp > 8 * DAY) continue;
    if (rep.deployment_error) continue;
    const assetDoc = await assetRef(ticker).get();
    const asset = assetDoc.data() as any;
    const trading = asset?.enabled === true && !(typeof asset?.disabledReason === 'string' && asset.disabledReason.trim());
    if (!trading) console.log(`[auto] ${ticker}: activo apagado (roster) — se registra igual para certificar su config forward`);
    const ex = await testRef(ticker).get();
    if (ex.exists) continue;
    console.log(`[auto] ${ticker}: RECOMMEND verificado (${ctx.week}) sin test → registrando`);
    await register(ticker);
    n++;
  }
  console.log(`[auto] nuevos registros: ${n}${APPLY ? '' : ' (dry-run)'}`);
}

async function reset(ticker: string) {
  if (!APPLY) { console.log(`[dry-run] se borraría ${COLL}/${ticker}`); return; }
  await testRef(ticker).delete();
  console.log(`✅ ${COLL}/${ticker} borrado`);
}

async function status() {
  const s = await db.collection(COLL).get();
  if (s.size === 0) { console.log('sin tests prospectivos registrados'); return; }
  console.log('ticker        estado      registrado  sem  cand(n/exp)      prod(n/exp)      último veredicto');
  for (const d of s.docs) {
    const x = d.data() as any; const e = x.latest || {};
    const dt = new Date(x.registered_at_ms).toISOString().slice(0, 10);
    const f = (m: any) => `${m?.n ?? '-'}/${Number.isFinite(m?.expectancy) ? m.expectancy.toFixed(2) : '-'}`;
    console.log(`${d.id.padEnd(13)} ${String(x.status).padEnd(11)} ${dt}  ${String(x.weeks_elapsed ?? 0).padEnd(4)} ${f(e.candidate).padEnd(17)} ${f(e.production).padEnd(17)} ${e.verdict || '-'} ${e.reason ? '· ' + e.reason : ''}`);
  }
}

if (cmd === 'register') {
  const ticker = (flag('--ticker') || argv[1] || '').toUpperCase();
  if (!ticker) throw new Error('register requiere TICKER');
  await register(ticker);
} else if (cmd === 'reset') {
  const ticker = (flag('--ticker') || argv[1] || '').toUpperCase();
  if (!ticker) throw new Error('reset requiere TICKER');
  await reset(ticker);
} else if (cmd === 'autoregister') {
  await autoregister();
} else if (cmd === 'evaluate') {
  await evaluateAll();
} else if (cmd === 'status') {
  await status();
} else {
  throw new Error(`comando desconocido: ${cmd} (usar register|evaluate|status)`);
}
process.exit(0);
