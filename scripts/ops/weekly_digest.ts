#!/usr/bin/env tsx
/**
 * Digest semanal por Telegram — 02-nov-2026.
 *
 * Motivo: los fallos eran silenciosos. El tune de detección murió por timeout tres
 * semanas seguidas y nadie se enteró; el backup diario falló cuatro días y tampoco.
 * Este resumen agrupa, en 12 líneas legibles, todo lo que pasó el fin de semana y
 * avisa si algún job programado no corrió o terminó mal.
 *
 * Uso:  npx tsx scripts/ops/weekly_digest.ts            # imprime (dry-run)
 *       npx tsx scripts/ops/weekly_digest.ts --send     # envía por Telegram
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';

const REPO = '/opt/JARVIS';
const SEND = process.argv.includes('--send');
const DAY = 864e5;

const UNITS: Array<[string, string]> = [
  ['jarvis-periodic-opt.service', 'Ciclo semanal'],
  ['jarvis-detection-tune.service', 'Tune detección'],
  ['jarvis-asset-scout.service', 'Asset scout'],
  ['jarvis-timesfm-bridge.service', 'TimesFM bridge'],
  ['jarvis-health-weekly.service', 'Health + propuestas'],
];

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/** Último estado del unit + duración de la última corrida (µs monotónicos). */
function unitInfo(unit: string) {
  const state = sh('systemctl', ['show', unit, '-p', 'Result', '-p', 'ActiveState', '-p', 'ExecMainStartTimestampMonotonic', '-p', 'ExecMainExitTimestampMonotonic']);
  const get = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(state)?.[1] || '').trim();
  const start = Number(get('ExecMainStartTimestampMonotonic')) || 0;
  const end = Number(get('ExecMainExitTimestampMonotonic')) || 0;
  const durMin = start > 0 && end > start ? Math.round((end - start) / 60e6) : null;
  const j = sh('journalctl', ['-u', unit, '-o', 'short-iso', '--no-pager', '-n', '400']);
  const lines = j.split('\n');
  let lastRun: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(Finished|Failed with result)/.test(lines[i])) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(lines[i]);
      if (m) { lastRun = Date.parse(m[1]); break; }
    }
  }
  const active = get('ActiveState');
  const result = get('Result');
  const failed = result && !['success', 'start', ''].includes(result);
  return { unit, durMin, lastRun, active, result, failed };
}

const fmtDur = (m: number | null) => (m === null ? '?' : m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m}min`);
const fmtAgo = (ts: number | null) => {
  if (!ts) return 'nunca';
  const d = Math.floor((Date.now() - ts) / DAY);
  return d === 0 ? 'hoy' : `hace ${d}d`;
};

const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const lines: string[] = [`📊 JARVIS — resumen semanal (${new Date().toISOString().slice(0, 10)})`];
const warnings: string[] = [];

for (const [unit, label] of UNITS) {
  const info = unitInfo(unit);
  const isDaemon = info.active === 'active' && unit.endsWith('bridge.service');
  const stale = info.lastRun ? Date.now() - info.lastRun > 9 * DAY : true;
  if (isDaemon) {
    lines.push(`✅ ${label}: corriendo (servicio residente)`);
    continue;
  }
  const icon = info.failed ? '❌' : stale ? '⚠️' : '✅';
  lines.push(`${icon} ${label}: ${info.failed ? `FALLÓ (${info.result})` : 'ok'} · ${fmtDur(info.durMin)} · ${fmtAgo(info.lastRun)}`);
  if (info.failed) warnings.push(`${label} terminó con ${info.result}`);
  if (stale) warnings.push(`${label} no corre desde ${fmtAgo(info.lastRun)}`);
}

// Informes del ciclo: estados de los candidatos
const reports = await db.collection('opt_reports').get();
const byStatus: Record<string, number> = {};
let newestReport = 0;
for (const d of reports.docs) {
  const x = d.data() as any;
  const s = String(x.status || 'n/a');
  byStatus[s] = (byStatus[s] || 0) + 1;
  if (Number.isFinite(x.timestamp)) newestReport = Math.max(newestReport, x.timestamp);
}
const rec = byStatus.RECOMMEND || 0;
lines.push(`🎯 Candidatos: ${rec} RECOMMEND · ${byStatus.HOLD || 0} HOLD · ${byStatus.HOLD_MC || 0} HOLD_MC (ciclo ${fmtAgo(newestReport)})`);

// Aplicaciones auto-vigiladas + tests prospectivos + modelos
const st = (await db.collection('optimization_config').doc('auto_state').get()).data() as any || {};
const applied = Object.keys(st.applied || {});
lines.push(`🛠 Auto-aplicados vigentes: ${applied.length}${applied.length ? ` (${applied.join(', ')})` : ''}`);

const pt = await db.collection('prospective_tests').get();
const ptc: Record<string, number> = {};
for (const d of pt.docs) { const s = String((d.data() as any).status); ptc[s] = (ptc[s] || 0) + 1; }
const ptTxt = Object.entries(ptc).map(([k, v]) => `${v} ${k}`).join(' · ') || 'ninguno';
lines.push(`🧪 Test prospectivo: ${ptTxt}`);

const modelsDir = path.join(REPO, 'scripts/hyperopt/models');
const nModels = fs.readdirSync(modelsDir).filter((f) => /^ml_model_[A-Z0-9]+\.json$/i.test(f)).length;
const qFile = path.join(modelsDir, 'quarantine/quarantine.json');
const nQuar = fs.existsSync(qFile) ? (JSON.parse(fs.readFileSync(qFile, 'utf8')) as any[]).length : 0;
lines.push(`🧠 Modelos ML: ${nModels} activos${nQuar ? ` · ${nQuar} en cuarentena` : ''}`);

// Semana de trading
const cutoff = Date.now() - 7 * DAY;
const week = await db.collection('trade_journal').where('timestamp', '>=', cutoff).get();
let win = 0, loss = 0, skip = 0, exec = 0;
const skips: Record<string, number> = {};
for (const d of week.docs) {
  const x = d.data() as any;
  if (x.ctraderStatus === 'EXECUTED') exec++;
  if (x.result === 'WIN') win++;
  else if (x.result === 'LOSS') loss++;
  else if (x.result === 'SKIP') {
    skip++;
    const r = String(x.skipReason || "sin motivo").slice(0, 60);
    skips[r] = (skips[r] || 0) + 1;
  }
}
const decided = win + loss;
const wr = decided ? `${Math.round((win / decided) * 100)}%` : '—';
// Revisión 7 (06-nov-2026): estado de la continuación ciclo→tune (runId durable).
try {
  const contPath = '/var/lib/jarvis/weekly_continuation.json';
  if (fs.existsSync(contPath)) {
    const cont = JSON.parse(fs.readFileSync(contPath, 'utf8'));
    if (cont?.state && cont.state !== 'completed') {
      lines.push(`🔁 Continuación al tune: ${cont.state} (runId ${String(cont.runId || '').slice(0, 8)} · ${cont.week || '?'}) — revisar /var/lib/jarvis/weekly_continuation.json`);
    }
  }
} catch { /* best-effort */ }

// 05-nov-2026: roster propuesto (TRADE/WATCH/OFF) y cuántos operan fuera de él.
let rosterLine = '';
try {
  const rosterDocs = await db.collection('roster_proposals').get();
  const rv: Record<string, number> = { TRADE: 0, WATCH: 0, PARKED: 0, OFF: 0 };
  const fuera: string[] = [];
  for (const d of rosterDocs.docs) {
    if (d.id === '_SUMMARY') continue;
    const x = d.data();
    if (rv[x.verdict] !== undefined) rv[x.verdict]++;
    if (x.verdict !== 'TRADE' && x.enabledAtGeneration === true) fuera.push(d.id);
  }
  if (rv.TRADE + rv.WATCH + rv.PARKED + rv.OFF > 0) {
    rosterLine = `🎯 Roster: ${rv.TRADE} TRADE · ${rv.WATCH} WATCH · ${rv.PARKED} PARKED · ${rv.OFF} OFF${fuera.length ? ` · operando fuera de roster: ${fuera.length} (${fuera.slice(0, 6).join(', ')}${fuera.length > 6 ? '…' : ''})` : ''}`;
  }
} catch { /* best-effort */ }
if (rosterLine) lines.push(rosterLine);

// H03 (auditoría 2026-11-05): el MCL ya no se aplica solo; el ciclo publica propuestas.
let mclLine = '';
try {
  const mclSum = (await db.collection('mcl_proposals').doc('_SUMMARY').get()).data() as any;
  if (mclSum?.count) {
    mclLine = `🔧 MCL propuesto (sweep train-only): ${mclSum.count} valores en ${(mclSum.tickers || []).length} activos · ${fmtAgo(Date.parse(mclSum.generatedAt))} — aplicar a mano con mcl_sync.ts --apply`;
  }
} catch { /* best-effort */ }
if (mclLine) lines.push(mclLine);

// 05-nov-2026: bloqueos silenciosos por datos de riesgo no verificados (dataHold).
const rh = (await db.collection('system').doc('risk_health').get()).data() || {};
if (rh.heldCount) {
  lines.push(`⛔ Entradas retenidas (datos no verificados): ${rh.heldCount} evento(s) · último ${fmtAgo(Date.parse(rh.heldLastAt))} — ${String(rh.heldLastReason || '').slice(0, 80)}`);
}
lines.push(`📈 Semana: ${week.size} señales · ${exec} ejecutadas · ${win}W/${loss}L (WR ${wr}) · ${skip} skip`);
const topSkip = Object.entries(skips).sort((a, b) => b[1] - a[1]).slice(0, 2);
if (topSkip.length) lines.push(`   ↳ skips: ${topSkip.map(([k, v]) => `${k} (${v})`).join(' · ')}`);

const open = await db.collection('active_trades').get();
lines.push(`📂 Abiertas ahora: ${open.size}`);

// Salud del pool (último diagnóstico)
const diag = await db.collection('detection_diagnostics').get();
let flagged = 0, diagAt = 0;
for (const d of diag.docs) {
  const x = d.data() as any;
  const at = x.generatedAt ? Date.parse(x.generatedAt) : 0;
  if (at >= diagAt) { diagAt = at; flagged = Array.isArray(x.flags) ? x.flags.length : 0; }
}
if (diagAt) lines.push(`🩺 Salud: ${flagged} activos flaggeados (${fmtAgo(diagAt)})`);

// Tune: último resumen rescatado
const tuneDir = path.join(REPO, 'logs/periodic_opt');
const tuneFiles = fs.existsSync(tuneDir) ? fs.readdirSync(tuneDir).filter((f) => f.startsWith('detection_tune_')).sort() : [];
if (tuneFiles.length) {
  const last = fs.readFileSync(path.join(tuneDir, tuneFiles[tuneFiles.length - 1]), 'utf8');
  const m = /FIN tune semanal\. Aplicados: (\d+)/.exec(last);
  if (m) lines.push(`🔬 Tune: aplicados ${m[1]} (${tuneFiles[tuneFiles.length - 1].replace(/[^0-9]/g, '').slice(0, 8)})`);
}

if (warnings.length) {
  lines.push('', '⚠️ ATAJO:', ...warnings.map((w) => `• ${w}`));
} else {
  lines.push('', '✅ Sin incidencias en los jobs programados.');
}

const text = lines.join('\n');
console.log(text);

if (!SEND) { console.log('\n[dry-run] agregá --send para enviarlo por Telegram'); process.exit(0); }

const env = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
const token = /TELEGRAM_BOT_TOKEN="([^"]+)"/.exec(env)?.[1];
const chat = /TELEGRAM_ALLOWED_USER_IDS="([^"]+)"/.exec(env)?.[1] || '1348898450';
if (!token) { console.error('sin TELEGRAM_BOT_TOKEN'); process.exit(1); }
const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ chat_id: chat, text }).toString(),
});
const body = await res.text();
console.log('\nenviado:', body.slice(0, 120));
process.exit(0);
