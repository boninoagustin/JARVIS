/**
 * health_check.ts — Sello de calidad del sistema JARVIS.
 *
 * Corre 6 chequeos de salud y escribe el resultado a Firestore (health_check/latest)
 * para que el panel de "Optimización Periódica" de jarvis-os lo muestre.
 *
 * Pensado para correr DESPUÉS del optimizador dominical (run_weekly) como validación
 * final, y también manualmente en cualquier momento:
 *   npx tsx scripts/health_check.ts [--json]
 *
 * Regla: NUNCA muta asset_configs ni trade_journal — solo lee y reporta.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import { SMCEngine } from '../src/engine/smc/SMCEngine.js';

type ItemStatus = 'PASS' | 'WARN' | 'FAIL';
interface Item { check: string; status: ItemStatus; detail: string }
interface Report { timestamp: number; status: 'OK' | 'FAIL'; items: Item[] }

const items: Item[] = [];
const log = (check: string, status: ItemStatus, detail: string) => items.push({ check, status, detail });

// ── Firestore ────────────────────────────────────────────────────────────────
let db: any = null;
try {
  const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
  if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
} catch (e: any) {
  log('firestore', 'FAIL', `No se pudo inicializar Firestore: ${e.message}`);
}

// ── 1. Gates SMC activos (la rotura original) ────────────────────────────────
function checkGates() {
  try {
    const h4 = new SMCEngine('Forex - 3. Balanceado', '4h') as any;
    const p4 = h4.preset;
    const m5 = new SMCEngine('Forex - 3. Balanceado', '5m') as any;
    const p5 = m5.preset;

    const expectedH4 = {
      valid_bos_displacement: true,
      choch_require_sweep: true,   // H4 → auto_4h
      choch_require_momentum: true, // H4 → auto_4h
      displ_atr_mult: 0.5,
    };
    const expectedM5 = { choch_require_sweep: false, choch_require_momentum: false };

    const problems: string[] = [];
    for (const [k, v] of Object.entries(expectedH4)) {
      if (p4[k] !== v) problems.push(`H4 ${k}=${JSON.stringify(p4[k])} (esperado ${v})`);
    }
    for (const [k, v] of Object.entries(expectedM5)) {
      if (p5[k] !== v) problems.push(`M5 ${k}=${JSON.stringify(p5[k])} (esperado ${v})`);
    }

    if (problems.length === 0) {
      log('gates_smc', 'PASS', 'Gates anti-whipsaw derivados correctamente (H4 displacement/sweep/momentum ON, M5 OFF — paridad Pine)');
    } else {
      log('gates_smc', 'FAIL', `Gates apagados o mal derivados: ${problems.join('; ')}`);
    }
  } catch (e: any) {
    log('gates_smc', 'FAIL', `Error instanciando SMCEngine: ${e.message}`);
  }
}

// ── 2. Flip-flop de señales (firma forense) ──────────────────────────────────
function checkFlipFlop() {
  try {
    // Leer solo la cola del log (puede pesar GBs). 80MB ≈ ~1 semana de actividad típica.
    const tail = execSync('tail -c 80000000 ~/.pm2/logs/JARVIS-out.log 2>/dev/null', { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    const re = /EVENTO_(CHOCH|BOS) (BUY|SELL) ([A-Z0-9]+) TF=(\d+)/g;
    const byKey: Record<string, { buy: number; sell: number }> = {};
    let m: RegExpExecArray | null;
    let total = 0;
    while ((m = re.exec(tail)) !== null) {
      const key = `${m[3]}:${m[4]}`;
      byKey[key] = byKey[key] || { buy: 0, sell: 0 };
      if (m[2] === 'BUY') byKey[key].buy++; else byKey[key].sell++;
      total++;
    }
    const flip: string[] = [];
    for (const [key, c] of Object.entries(byKey)) {
      const n = c.buy + c.sell;
      if (n >= 40 && Math.abs(c.buy - c.sell) <= n * 0.15) {
        flip.push(`${key} (${c.buy}B/${c.sell}S)`);
      }
    }
    if (flip.length > 0) {
      log('flipflop', 'FAIL', `Flip-flop simétrico detectado en: ${flip.slice(0, 6).join(', ')}`);
    } else {
      log('flipflop', 'PASS', `Sin flip-flop masivo (${total} señales en la ventana analizada)`);
    }
  } catch (e: any) {
    log('flipflop', 'WARN', `No se pudo analizar el log: ${e.message}`);
  }
}

// ── 3. Bot saludable (pm2) ───────────────────────────────────────────────────
function checkBot() {
  try {
    const jlist = JSON.parse(execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }));
    const jarvis = jlist.find((p: any) => p.name === 'JARVIS');
    if (!jarvis) { log('bot', 'FAIL', 'Proceso JARVIS no encontrado en pm2'); return; }
    const restarts = jarvis.pm2_env?.restart_time || 0;
    const status = jarvis.pm2_env?.status;
    const uptimeMs = Date.now() - (jarvis.pm2_env?.pm_uptime || 0);
    if (status !== 'online') {
      log('bot', 'FAIL', `JARVIS no está online (status=${status})`);
    } else if (restarts > 1000) {
      log('bot', 'WARN', `JARVIS online pero con ${restarts} restarts acumulados (posible crash-loop histórico)`);
    } else {
      log('bot', 'PASS', `JARVIS online, uptime ${(uptimeMs / 3600000).toFixed(1)}h, ${restarts} restarts`);
    }
  } catch (e: any) {
    log('bot', 'WARN', `No se pudo leer pm2: ${e.message}`);
  }
}

// ── 4. WR del diario (últimos 7 días) ────────────────────────────────────────
async function checkWinRate() {
  if (!db) return;
  try {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const snap = await db.collection('trade_journal').get();
    let wins = 0, losses = 0;
    for (const d of snap.docs) {
      const x = d.data();
      const ts = Number(x.timestamp || x.entryTs || 0);
      if (ts < weekAgo) continue;
      if (x.result === 'WIN') wins++;
      else if (x.result === 'LOSS') losses++;
    }
    const n = wins + losses;
    if (n === 0) {
      log('winrate', 'WARN', 'Sin trades cerrados en los últimos 7 días (muestra vacía)');
    } else if (n < 10) {
      log('winrate', 'WARN', `Muestra chica: ${n} trades en 7d (${wins}W/${losses}L) — insuficiente para concluir`);
    } else if (wins / n < 0.15) {
      log('winrate', 'FAIL', `WR ${(100 * wins / n).toFixed(0)}% (${wins}W/${losses}L) — sospechosamente bajo`);
    } else {
      log('winrate', 'PASS', `WR ${(100 * wins / n).toFixed(0)}% (${wins}W/${losses}L en 7d)`);
    }
  } catch (e: any) {
    log('winrate', 'WARN', `No se pudo leer trade_journal: ${e.message}`);
  }
}

// ── 5. Configs coherentes (regla gatillo-por-gatillo del paso 8, sep-2026) ────
// Política vieja (solo-5M hardcodeado, US500 off) reemplazada el 10-sep: el paso 8 del
// dominical decide apagar/activar por DATOS (minScore=99 apaga, minScore=4 reactiva).
// El check valida que Firestore refleje la última propuesta del trigger-state.
async function checkConfigs() {
  if (!db) return;
  try {
    const snap = await db.collection('asset_configs').get();
    const cfgs: Record<string, any> = {};
    snap.docs.forEach(d => { cfgs[d.id] = d.data(); });

    const problems: string[] = [];
    // JP225 sigue on (decisión vigente)
    if (cfgs['JP225'] && cfgs['JP225'].enabled !== true) problems.push('JP225 debería estar enabled=true');

    // Coherencia con el trigger-state aplicado (reports/loser_triggers_proposal.json)
    const stPath = '/opt/JARVIS/scripts/periodic_opt/reports/loser_triggers_proposal.json';
    if (fs.existsSync(stPath)) {
      const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
      const SESS = ['ASIA', 'LONDON', 'NY', 'OFF'];
      for (const p of (st.disables || [])) {
        const cfg = cfgs[p.ticker]; if (!cfg) continue;
        const s = (cfg.sessions || {}) as Record<string, any>;
        for (const sess of SESS) {
          const blk = s[sess]?.[p.trigger];
          if (blk && blk.minScore < 99) problems.push(`${p.ticker}/${sess}/${p.trigger} debería estar apagado (minScore>=99), tiene ${blk.minScore}`);
          else if (blk && blk.enabled !== false) problems.push(`${p.ticker}/${sess}/${p.trigger} apagado con enabled!=false (panel incoherente)`);
        }
      }
      // Misma exclusión que apply_trigger_state.ts: señales conflictivas no aplicadas
      const EXCLUDE = new Set(['GBPJPY:oteBos5m']);
      for (const p of (st.enables || [])) {
        if (EXCLUDE.has(`${p.ticker}:${p.trigger}`)) continue;
        const cfg = cfgs[p.ticker]; if (!cfg) continue;
        const s = (cfg.sessions || {}) as Record<string, any>;
        const states = SESS.map(sess => s[sess]?.[p.trigger]);
        const allOff = states.every(b => !b || b.minScore >= 99);
        if (allOff) problems.push(`${p.ticker}.${p.trigger} debería estar activado (propuesta del paso 8)`);
      }
    }

    if (problems.length === 0) {
      log('configs', 'PASS', 'Configs coherentes con el trigger-state (apagados minScore=99, activados encendidos)');
    } else {
      log('configs', 'FAIL', problems.slice(0, 6).join('; '));
    }
  } catch (e: any) {
    log('configs', 'WARN', `No se pudo leer asset_configs: ${e.message}`);
  }
}

// ── 6. Posiciones fantasma (active_trades sin cierre) ────────────────────────
async function checkGhostPositions() {
  if (!db) return;
  try {
    const snap = await db.collection('active_trades').get();
    let ghosts = 0;
    for (const d of snap.docs) {
      const x = d.data();
      if (!x.closed && !x.result) ghosts++;
    }
    if (ghosts > 0) {
      log('ghost_positions', 'WARN', `${ghosts} posiciones activas sin cierre/resultado — verificar que existan en cTrader`);
    } else {
      log('ghost_positions', 'PASS', 'Sin posiciones fantasma en active_trades');
    }
  } catch (e: any) {
    log('ghost_positions', 'WARN', `No se pudo leer active_trades: ${e.message}`);
  }
}

// ── 7. Optimización saludable por activo (sep-2026, idea de Bon) ─────────────
// Detecta cuando un activo NO logra ser optimizado: status ERROR en su report más
// reciente, o report demasiado viejo (el dominical no corrió / el activo quedó afuera).
// El exit code 0 de run_weekly NO alcanza: la re-corrida 10-sep terminó exit=0 con
// AUDCAD y NZDUSD en ERROR (timeout) — este check es el que lo ve.
const OPT_TICKERS_LEGACY = ['EURUSD', 'GBPUSD', 'AUDCAD', 'US500', 'XAUUSD', 'USDJPY', 'NZDUSD', 'GBPJPY', 'AUDJPY', 'GER40'];
const OPT_MAX_AGE_DAYS = 8;
// 🆕 22-sep-2026: la lista oficial vive en Firestore optimization_config/active_tickers
// (decisión Bon: TODOS los activos que opera el bot, hoy 23). Fallback: lista legacy.
async function getOptTickers(): Promise<string[]> {
  try {
    if (db) {
      const snap = await db.collection('optimization_config').doc('active_tickers').get();
      const list: string[] = (snap.data() || {}).tickers || [];
      if (list.length > 0) return list;
    }
  } catch {}
  return OPT_TICKERS_LEGACY;
}
async function checkOptStatus() {
  try {
    const repDir = '/opt/JARVIS/scripts/periodic_opt/reports';
    const errors: string[] = [];
    const stale: string[] = [];
    const now = Date.now();
    const tickers = await getOptTickers();
    for (const t of tickers) {
      const p = `${repDir}/${t}.json`;
      if (!fs.existsSync(p)) { stale.push(`${t} (sin report)`); continue; }
      let d: any = null;
      try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { stale.push(`${t} (json roto)`); continue; }
      const ageDays = (now - (d.timestamp || 0)) / 86400000;
      if (d.status === 'ERROR') errors.push(`${t} (${(d.reason || '').slice(0, 60)})`);
      else if (ageDays > OPT_MAX_AGE_DAYS || !Number.isFinite(ageDays)) stale.push(`${t} (${Math.round(ageDays)}d)`);
    }
    if (errors.length) log('opt_status', 'FAIL', `Activos con optimización fallida: ${errors.join(' · ')}`);
    else if (stale.length) log('opt_status', 'WARN', `Activos sin optimización reciente: ${stale.join(' · ')}`);
    else log('opt_status', 'PASS', `${tickers.length} activos con reporte de optimización fresco y sin ERROR`);
  } catch (e: any) {
    log('opt_status', 'WARN', `No se pudo escanear reports/: ${e.message}`);
  }
}

// ── 6b. TOP candidatos para cuenta REAL (22-sep-2026, pedido de Bon) ────────
// Criterios conservadores (mismo espíritu que los gates del auto-apply):
//  1. reporte fresco (≤8d) con status RECOMMEND
//  2. MC evaluado y survival ≥ 0.80 (fail-closed: sin MC no es candidato)
//  3. activo enabled en asset_configs
//  4. vivo con ≥8 trades cerrados en 21d y WR ≥ 40%
// Rank: MC survival desc, desempate WR desc. Máx 3.
async function checkRealCandidates() {
  if (!db) return;
  try {
    const repDir = '/opt/JARVIS/scripts/periodic_opt/reports';
    const now = Date.now();
    const cfgsSnap = await db.collection('asset_configs').get();
    const enabled = new Set<string>();
    cfgsSnap.docs.forEach(d => { if (d.id !== 'GLOBAL' && d.data().enabled !== false) enabled.add(d.id); });

    const cut21 = now - 21 * 86400e3;
    const jSnap = await db.collection('trade_journal').get();
    const live = new Map<string, { n: number; wins: number }>();
    for (const d of jSnap.docs) {
      const x = d.data();
      const ts = Number(x.timestamp || x.entryTs || 0);
      if (ts < cut21 || !x.ticker) continue;
      const s = live.get(x.ticker) || { n: 0, wins: 0 };
      s.n++;
      if (x.result === 'WIN') s.wins++;
      live.set(x.ticker, s);
    }

    const cands: { t: string; surv: number; wr: number; n: number }[] = [];
    for (const f of fs.readdirSync(repDir)) {
      if (!/^[A-Z][A-Z0-9]*\.json$/.test(f)) continue;
      const t = f.replace('.json', '');
      if (!enabled.has(t)) continue;
      let r: any = null;
      try { r = JSON.parse(fs.readFileSync(`${repDir}/${f}`, 'utf8')); } catch { continue; }
      if (r.status !== 'RECOMMEND') continue;
      const age = (now - (r.timestamp || 0)) / 86400e3;
      if (age > 8 || !Number.isFinite(age)) continue;
      const surv = r.montecarlo?.survival;
      if (typeof surv !== 'number' || surv < 0.8) continue;
      const lv = live.get(t);
      if (!lv || lv.n < 8 || lv.wins / lv.n < 0.4) continue;
      cands.push({ t, surv, wr: lv.wins / lv.n, n: lv.n });
    }
    cands.sort((a, b) => b.surv - a.surv || b.wr - a.wr);
    if (cands.length === 0) {
      log('real_candidates', 'WARN', 'Ningún activo pasa los criterios de cuenta real (RECOMMEND fresco + MC≥80% + enabled + vivo n≥8 y WR≥40%)');
    } else {
      const top = cands.slice(0, 3).map((c, i) => `${i + 1}) ${c.t} (MC ${(c.surv * 100).toFixed(0)}% · vivo ${(c.wr * 100).toFixed(0)}% · n=${c.n})`).join('  ·  ');
      log('real_candidates', 'PASS', top);
    }
  } catch (e: any) {
    log('real_candidates', 'WARN', `No se pudo calcular: ${e.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  checkGates();
  checkFlipFlop();
  checkBot();
  await checkWinRate();
  await checkConfigs();
  await checkGhostPositions();
  await checkOptStatus();
  await checkRealCandidates();

  const hasFail = items.some(i => i.status === 'FAIL');
  const report: Report = { timestamp: Date.now(), status: hasFail ? 'FAIL' : 'OK', items };

  // Salida por stdout (para ejecución manual y logs del service)
  const jsonOut = JSON.stringify(report, null, 2);
  if (process.argv.includes('--json')) {
    console.log(jsonOut);
  } else {
    for (const i of items) {
      const icon = i.status === 'PASS' ? '✅' : i.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} [${i.check}] ${i.detail}`);
    }
    console.log(`\n=== HEALTH CHECK: ${report.status === 'OK' ? '✅ TODO OK' : '❌ ALGO FALLA'} ===`);
  }

  // Escritura a Firestore para el panel
  if (db) {
    try {
      await db.collection('health_check').doc('latest').set(report, { merge: true });
      console.log('[health_check] → escrito en health_check/latest');
    } catch (e: any) {
      console.error('[health_check] Error escribiendo a Firestore:', e.message);
    }
  }
  process.exit(hasFail ? 2 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
