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

// ── 5. Configs coherentes (solo-5M, US500 off / JP225 on) ────────────────────
async function checkConfigs() {
  if (!db) return;
  try {
    const snap = await db.collection('asset_configs').get();
    const cfgs: Record<string, any> = {};
    snap.docs.forEach(d => { cfgs[d.id] = d.data(); });

    const problems: string[] = [];
    // US500 desactivado, JP225 activado
    if (cfgs['US500'] && cfgs['US500'].enabled !== false) problems.push('US500 debería estar enabled=false');
    if (cfgs['JP225'] && cfgs['JP225'].enabled !== true) problems.push('JP225 debería estar enabled=true');

    // Solo-5M: ningún gatillo 15m habilitado en los activos vivos
    const OFF = ['USOIL', 'USDCAD', 'BTCUSD', 'US500'];
    for (const [ticker, cfg] of Object.entries(cfgs)) {
      if (cfg.enabled === false || OFF.includes(ticker)) continue;
      const sessions = cfg.sessions || {};
      for (const [sess, trigs] of Object.entries(sessions as Record<string, any>)) {
        for (const [trig, t] of Object.entries(trigs || {})) {
          if (trig.includes('15m') && (t as any)?.enabled === true) {
            problems.push(`${ticker}/${sess}/${trig} 15m habilitado (rompe solo-5M)`);
          }
        }
      }
    }

    if (problems.length === 0) {
      log('configs', 'PASS', 'Configs coherentes: solo-5M respetado, US500 off, JP225 on');
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  checkGates();
  checkFlipFlop();
  checkBot();
  await checkWinRate();
  await checkConfigs();
  await checkGhostPositions();

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
