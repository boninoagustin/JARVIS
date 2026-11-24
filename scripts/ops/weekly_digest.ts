#!/usr/bin/env tsx
/**
 * Digest semanal por Telegram — 02-nov-2026.
 *
 * Motivo: los fallos eran silenciosos. El tune de detección murió por timeout tres
 * semanas seguidas y nadie se enteró; el backup diario falló cuatro días y tampoco.
 * Este resumen agrupa, en 12 líneas legibles, todo lo que pasó el fin de semana y
 * avisa si algún job programado no corrió o terminó mal.
 *
 * Se ejecuta al cerrar health + propuestas (OnSuccess/OnFailure), no el lunes.
 * Uso:  npx tsx scripts/ops/weekly_digest.ts --cycle-close         # dry-run
 *       npx tsx scripts/ops/weekly_digest.ts --cycle-close --send  # Telegram
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';
import { parse as parseEnv } from 'dotenv';
import { digestJobState, summarizeSelection, validateTelegramResponse } from './digest_status_core.js';

const REPO = '/opt/JARVIS';
const SEND = process.argv.includes('--send');
const CYCLE_CLOSE = process.argv.includes('--cycle-close');
const DAY = 864e5;

const UNITS: Array<[string, string]> = [
  ['jarvis-periodic-opt.service', 'Servicio optimizador (systemd)'],
  ['jarvis-detection-tune.service', 'Tune detección'],
  ['jarvis-asset-scout.service', 'Asset scout'],
  ['jarvis-timesfm-bridge.service', 'TimesFM bridge'],
  ['jarvis-health-weekly.service', 'Health + propuestas'],
];

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  // A timeout/partial journal read is not successful attribution evidence.
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

/** Último estado del unit + duración de la última corrida (µs monotónicos). */
function unitInfo(unit: string) {
  const state = sh('systemctl', ['show', unit, '-p', 'Result', '-p', 'ActiveState', '-p', 'ExecMainStartTimestampMonotonic', '-p', 'ExecMainExitTimestampMonotonic', '-p', 'InvocationID']);
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
  const jobState = digestJobState(result, active);
  // ExecCondition-only fallback invocations must not replace the last real work
  // identity. Filter in journalctl so a long optimizer log cannot hide its sentinel.
  const cycleInvocation = unit === 'jarvis-periodic-opt.service' && fs.existsSync('/var/lib/jarvis/weekly_cycle_context.json')
    ? selectCycleInvocation(sh('journalctl', ['-u', unit, '-o', 'json', '--no-pager', '--since=21 days ago', '--grep=^cycle-context:', '-n', '1']))
    : null;
  return { unit, durMin, lastRun, active, result, cycleInvocation, state: jobState, failed: jobState === 'failed' };
}

const fmtDur = (m: number | null) => (m === null ? '?' : m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m}min`);
const fmtAgo = (ts: number | null) => {
  if (!ts) return 'nunca';
  const d = Math.floor((Date.now() - ts) / DAY);
  return d === 0 ? 'hoy' : `hace ${d}d`;
};

export function isoCycleWeek(ms: number): string {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil((((date.getTime() - Date.UTC(year, 0, 1)) / DAY) + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

type CycleInvocation = { run_id: string; week: string; invocation_id: string };

/** Last work sentinel with journald service attribution, not last condition check. */
export function selectCycleInvocation(journal: string): CycleInvocation | null {
  for (const raw of journal.split('\n').reverse()) {
    if (!raw.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(raw); } catch { return null; }
    if (typeof entry.MESSAGE !== 'string' || !entry.MESSAGE.startsWith('cycle-context:')) continue;
    const match = /^cycle-context: run=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) week=([0-9]{4}-W[0-9]{2}) invocation=([a-f0-9]{32})$/.exec(entry.MESSAGE);
    // Never fall back to an older sentinel when the newest is malformed or misattributed.
    if (!match || entry._SYSTEMD_UNIT !== 'jarvis-periodic-opt.service' || entry._SYSTEMD_INVOCATION_ID !== match[3]) return null;
    return { run_id: match[1], week: match[2], invocation_id: match[3] };
  }
  return null;
}

type CycleEvidence = {
  context: any; receipt: any; summaryRaw: string; roster: unknown;
  seal: string; invocationId: string; serviceWeek: string; serviceRunId: string; now?: number;
};

/** Fail closed: process success alone is not proof of this invocation's optimization. */
export function validateCycleEvidence(input: CycleEvidence): { complete: boolean; reason: string; week?: string } {
  const fail = (reason: string) => ({ complete: false, reason });
  try {
    const { context: c, receipt: r } = input;
    const now = input.now ?? Date.now();
    const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
    const tickers = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 &&
      v.every(t => typeof t === 'string' && /^[A-Z0-9]+$/.test(t)) && new Set(v).size === v.length;
    const same = (a: string[], b: string[]) => a.length === b.length && a.every(t => b.includes(t));
    if (!c || c.version !== 1 || !stamp(c.started_at) || !/^[0-9]{4}-W[0-9]{2}$/.test(c.week) ||
        typeof c.run_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.run_id) ||
        !tickers(c.tickers)) return fail('Contexto de ciclo ausente o inválido');
    if (!/^[a-f0-9]{32}$/i.test(input.invocationId) || c.invocation_id !== input.invocationId ||
        c.week !== input.serviceWeek || c.run_id !== input.serviceRunId)
      return fail('Contexto no pertenece a la última invocación de trabajo del servicio semanal');
    if (isoCycleWeek(c.started_at) !== c.week || c.started_at > now || now - c.started_at > 21 * DAY)
      return fail('Semana o fecha de inicio del contexto inválida/obsoleta');
    if (input.seal.trim() !== c.week) return fail(`Sello semanal no corresponde al ciclo ${c.week}`);
    if (!r || r.version !== 1 || r.week !== c.week || r.run_id !== c.run_id || r.started_at !== c.started_at ||
        !tickers(r.tickers) || !same(r.tickers, c.tickers) || !stamp(r.completed_at) ||
        r.completed_at < c.started_at || r.completed_at > now) return fail('Recibo Python ausente o no corresponde al contexto del ciclo');
    if (!/^[a-f0-9]{64}$/.test(r.summary_sha256) || createHash('sha256').update(input.summaryRaw).digest('hex') !== r.summary_sha256)
      return fail('Hash del resumen no corresponde al recibo Python');
    const s = JSON.parse(input.summaryRaw);
    if (s.version !== 1 || s.cycle_week !== c.week || s.cycle_run_id !== c.run_id ||
        s.started_at !== c.started_at || s.completed_at !== r.completed_at || s.status !== 'completed')
      return fail('Resumen no corresponde a la semana/run o no está completado');
    if (!tickers(s.tickers) || !same(s.tickers, c.tickers)) return fail('Tickers del resumen no coinciden con el contexto');
    if (!tickers(input.roster)) return fail('Roster actual ausente o inválido');
    const missing = input.roster.filter(t => !s.tickers.includes(t));
    if (missing.length) return fail(`Resumen incompleto para el roster actual: faltan ${missing.join(', ')}`);
    if (s.error || !Array.isArray(s.errors) || s.errors.length || !Array.isArray(s.outcomes) || s.outcomes.length !== s.tickers.length)
      return fail('Resumen con errores o resultados incompletos');
    const outcomeTickers = s.outcomes.map((o: any) => o?.ticker);
    if (!tickers(outcomeTickers) || !same(outcomeTickers, s.tickers)) return fail('Resultados duplicados o sin cobertura del pool');
    const counts = { evaluated: 0, skipped: 0, failed: 0 };
    for (const o of s.outcomes) {
      if (!Object.hasOwn(counts, o.outcome) || typeof o.status !== 'string' || !o.status.trim() ||
          /^(ERROR|HOLD_SELECTION_ERROR|HOLD_INTEGRITY|HOLD_ML_ERROR)$/.test(o.status) ||
          !stamp(o.timestamp) || o.timestamp < c.started_at || o.timestamp > r.completed_at || o.deployment_error)
        return fail('Resultado individual inválido o fuera de las fechas del ciclo');
      counts[o.outcome as keyof typeof counts]++;
    }
    if (counts.failed || !s.counts || Object.entries(counts).some(([key, n]) => s.counts[key] !== n))
      return fail('Conteos de selección inválidos o con fallidos');
    return { complete: true, reason: `Optimización verificada: ${c.week} · run ${c.run_id}`, week: c.week };
  } catch { return fail('Evidencia de optimización ilegible o inválida'); }
}

export function cycleCloseHeader(ready: boolean): string {
  return ready ? '✅ JARVIS — ciclo semanal finalizado' : '⚠️ JARVIS — ciclo semanal incompleto';
}

async function main() {
const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase-key.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const lines: string[] = [`📊 JARVIS — resumen semanal (${new Date().toISOString().slice(0, 10)})`];
const warnings: string[] = [];
let cycleReady = true;
const coreUnits = new Set(['jarvis-periodic-opt.service', 'jarvis-detection-tune.service', 'jarvis-health-weekly.service']);
let periodicInvocation: CycleInvocation | null = null;

for (const [unit, label] of UNITS) {
  const info = unitInfo(unit);
  if (unit === 'jarvis-periodic-opt.service') periodicInvocation = info.cycleInvocation;
  const isDaemon = info.active === 'active' && unit.endsWith('bridge.service');
  const stale = info.lastRun ? Date.now() - info.lastRun > 9 * DAY : true;
  if (isDaemon) {
    lines.push(`✅ ${label}: corriendo (servicio residente)`);
    continue;
  }
  if (coreUnits.has(unit) && (info.failed || info.state === 'running' || stale)) cycleReady = false;
  const icon = info.failed ? '❌' : info.state === 'running' ? '⏳' : stale ? '⚠️' : '✅';
  const detail = info.failed ? `FALLÓ (${info.result || info.active})` : info.state === 'running' ? 'en curso' : info.state === 'skipped' ? 'último intento omitido por guarda; cierre previo' : 'ok';
  lines.push(`${icon} ${label}: ${detail} · ${fmtDur(info.durMin)} · ${fmtAgo(info.lastRun)}`);
  if (info.failed) warnings.push(`${label} terminó con ${info.result || info.active}`);
  if (info.state === 'running') warnings.push(`${label} todavía no terminó`);
  if (stale) warnings.push(`${label} no tiene un cierre reciente (${fmtAgo(info.lastRun)})`);
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

// Do not confuse successful postprocessors with a new Python optimization. All
// artifacts must join on the invocation-bound cycle identity and exact summary bytes.
try {
  const context = JSON.parse(fs.readFileSync('/var/lib/jarvis/weekly_cycle_context.json', 'utf8'));
  if (typeof context.week !== 'string' || !/^[0-9]{4}-W[0-9]{2}$/.test(context.week)) throw new Error('invalid week');
  const receipt = JSON.parse(fs.readFileSync(`/var/lib/jarvis/weekly_python_done_${context.week}`, 'utf8'));
  const summaryRaw = fs.readFileSync(path.join(REPO, 'scripts/periodic_opt/opt_out/weekly_selection_summary.json'), 'utf8');
  const rosterDoc = await db.collection('optimization_config').doc('active_tickers').get();
  const proof = validateCycleEvidence({ context, receipt, summaryRaw, roster: rosterDoc.data()?.tickers,
    seal: fs.readFileSync('/var/lib/jarvis/weekly_cycle_last', 'utf8'), invocationId: periodicInvocation?.invocation_id ?? '',
    serviceWeek: periodicInvocation?.week ?? '', serviceRunId: periodicInvocation?.run_id ?? '' });
  if (!proof.complete) {
    cycleReady = false;
    warnings.push(proof.reason);
    lines.push(`⚠️ Optimización NO verificada: ${proof.reason}`);
  } else {
    lines.push(`🔐 ${proof.reason}`);
    const sel = summarizeSelection(JSON.parse(summaryRaw));
    lines.push(sel.line);
    // A fully verified current run can legitimately reuse all certified selections;
    // the legacy count-only summarizer must not overrule the joined cycle proof.
  }
} catch {
  cycleReady = false;
  const reason = 'No se pudo verificar contexto, recibo Python, roster y resumen del ciclo; no se acredita una optimización nueva';
  warnings.push(reason);
  lines.push(`⚠️ Optimización NO verificada: ${reason}`);
}

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
      cycleReady = false;
      warnings.push(`Continuación al tune pendiente: ${cont.state}`);
      lines.push(`🔁 Continuación al tune: ${cont.state} (runId ${String(cont.runId || '').slice(0, 8)} · ${cont.week || '?'}) — revisar /var/lib/jarvis/weekly_continuation.json`);
    }
  }
} catch { /* best-effort */ }

// 05-nov-2026: roster propuesto (TRADE/WATCH/OFF) y cuántos operan fuera de él.
let rosterLine = '';
try {
  const [rosterDocs, configDocs] = await Promise.all([
    db.collection('roster_proposals').get(), db.collection('asset_configs').get(),
  ]);
  const configMap = new Map(configDocs.docs.map(d => [d.id, d.data()]));
  const rv: Record<string, number> = { TRADE: 0, WATCH: 0, PARKED: 0, OFF: 0 };
  const fuera: string[] = [];
  for (const d of rosterDocs.docs) {
    if (d.id === '_SUMMARY') continue;
    const x = d.data();
    if (rv[x.verdict] !== undefined) rv[x.verdict]++;
    const cfg = configMap.get(d.id);
    if (x.verdict !== 'TRADE' && cfg?.enabled === true && !String(cfg.disabledReason || '').trim()) fuera.push(d.id);
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

if (CYCLE_CLOSE) {
  lines[0] = cycleCloseHeader(cycleReady);
  lines.splice(1, 0, cycleReady
    ? 'Health y propuestas listos. Revisá Salud de Activos y Optimización Periódica: ya podés decidir qué aplicar, sin esperar al lunes. Riesgo y activaciones requieren tu aprobación.'
    : 'Hay etapas fallidas o pendientes. No apliques recomendaciones como si el ciclo hubiera cerrado correctamente; revisá las incidencias.');
}

if (warnings.length) {
  lines.push('', '⚠️ INCIDENCIAS:', ...warnings.map((w) => `• ${w}`));
} else {
  lines.push('', '✅ Sin incidencias en los jobs programados.');
}

const text = lines.join('\n');
console.log(text);

if (!SEND) { console.log('\n[dry-run] agregá --send para enviarlo por Telegram'); process.exit(0); }

const env = parseEnv(fs.readFileSync(path.join(REPO, '.env'), 'utf8'));
const token = env.TELEGRAM_BOT_TOKEN;
const chat = (env.TELEGRAM_ALLOWED_USER_IDS || '').split(',')[0].trim();
if (!token || !chat) { console.error('Falta configuración de Telegram'); process.exit(1); }
try {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ chat_id: chat, text }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await res.json();
  validateTelegramResponse(res.ok, body);
  console.log('\nTELEGRAM_CONFIRMED');
} catch {
  // Do not log request URLs, credentials, or Telegram response bodies.
  console.error('TELEGRAM_FAILED: entrega no confirmada');
  process.exit(1);
}
process.exit(0);
}

// Importing validation in isolated tests must never contact Firestore/Telegram/systemd.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('DIGEST_FAILED: no se pudo construir el resumen'); process.exitCode = 1; });
}
