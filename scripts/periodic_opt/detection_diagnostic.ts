/**
 * detection_diagnostic.ts — DIAGNÓSTICO DE DETECCIÓN SMC (paso 1, 21-sep-2026).
 *
 * Cruza 3 señales por activo y levanta bandera si la capa de detección del motor
 * (zonas/eventos por TF) parece mal calibrada para ese activo:
 *
 *   A) VIVO PERDIENDO        — trade_journal 21d: n≥8 y (winRate<35% o pnl neto<0).
 *   B) EMBUDO OTE ROTO      — parity_live_vs_backtest.json: muchas esperas OTE que
 *      mueren (inalcanzable/presión contraria) vs media global, o esperas sin ejecuciones.
 *   C) SEÑALES ANÓMALAS     — trigger_telemetry 7d: señales/día del activo con |z|>2
 *      vs mediana de todos los activos (pocas = motor ciego, muchas = ruido).
 *
 * Salida: reports/detection_diagnostic.json + Firestore detection_diagnostics/latest
 * + tabla por stdout. NO modifica nada del bot. Uso:
 *   npx tsx scripts/periodic_opt/detection_diagnostic.ts [--days 21]
 */
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

const REPO = '/opt/JARVIS';
const sa = JSON.parse(fs.readFileSync(path.join(REPO, 'service-account.json'), 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=21').split('=')[1] || 21);
const NOW = Date.now();
const WINDOW = DAYS * 86400e3;
const ACTIVE: Record<string, string> = {}; // ticker → cat (se llena de telemetría)

interface Diag { flags: string[]; details: Record<string, any>; }

async function main() {
  // ── A) trade_journal 21d ──────────────────────────────────────────────
  const jSnap = await db.collection('trade_journal').get();
  const jStat: Record<string, { n: number; wins: number; pnl: number }> = {};
  for (const d of jSnap.docs) {
    const v = d.data() as any;
    const ts = Number(v.timestamp ?? 0);
    if (ts < NOW - WINDOW || !v.ticker) continue;
    const st = jStat[v.ticker] || (jStat[v.ticker] = { n: 0, wins: 0, pnl: 0 });
    st.n++;
    if (v.result === 'WIN') st.wins++;
    st.pnl += Number(v.pnl ?? 0);
  }

  // ── B) parity JSON ────────────────────────────────────────────────────
  const parityPath = path.join(REPO, 'scripts/periodic_opt/reports/parity_live_vs_backtest.json');
  let parityRows: any[] = [];
  if (fs.existsSync(parityPath)) {
    try { parityRows = JSON.parse(fs.readFileSync(parityPath, 'utf8')).rows || []; } catch {}
  }
  const pAgg: Record<string, { esperas: number; ejec: number; muertes: number; rows: number; deadLive: number }> = {};
  for (const r of parityRows) {
    const t = r.ticker;
    if (!t) continue;
    const st = pAgg[t] || (pAgg[t] = { esperas: 0, ejec: 0, muertes: 0, rows: 0, deadLive: 0 });
    st.esperas += Number(r.oteWaits ?? 0);
    st.ejec += Number(r.oteExecutions ?? 0);
    const deadVals = Object.values(r.oteDead ?? {}) as any[];
    st.muertes += deadVals.reduce((s: number, x: any) => s + Number(x ?? 0), 0);
    st.rows++;
    if (r.deadInLive) st.deadLive++;
  }
  const esperasAll = Object.values(pAgg).reduce((s, x) => s + x.esperas, 0);
  const ejecAll = Object.values(pAgg).reduce((s, x) => s + x.ejec, 0);
  const globalExecRate = esperasAll > 0 ? ejecAll / (esperasAll + ejecAll) : 0;

  // ── C) trigger_telemetry 7d: señales/día por activo ────────────────────
  const tSnap = await db.collection('trigger_telemetry').get();
  const sigPerTicker: Record<string, { days: number; signals: number }> = {};
  for (const d of tSnap.docs) {
    const dayTs = Date.parse(d.id); // doc id = YYYY-MM-DD
    if (Number.isNaN(dayTs) || dayTs < NOW - 7 * 86400e3) continue;
    const v = d.data() as any;
    for (const [key, val] of Object.entries(v)) {
      const [ticker, , ] = key.split('|');
      if (!ticker || !(val as any)?.signals) continue;
      const st = sigPerTicker[ticker] || (sigPerTicker[ticker] = { days: 0, signals: 0 });
      st.days++;
      st.signals += (val as any).signals;
      if (!ACTIVE[ticker]) ACTIVE[ticker] = 'FX';
    }
  }
  const sigsPerDay = Object.entries(sigPerTicker)
    .map(([t, s]) => ({ t, spd: s.days > 0 ? s.signals / s.days : 0 }))
    .filter(x => x.spd > 0);
  if (sigsPerDay.length >= 3) {
    const vals = sigsPerDay.map(x => x.spd).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const mad = Math.max(1e-9, vals.reduce((s, v) => s + Math.abs(v - med), 0) / vals.length);
    for (const x of sigsPerDay) (x as any).z = (x.spd - med) / (1.4826 * mad);
  }

  // ── Score por activo ───────────────────────────────────────────────────
  const diags: Record<string, Diag> = {};
  const add = (t: string, flag: string, detail: any) => {
    const d = diags[t] || (diags[t] = { flags: [], details: {} });
    d.flags.push(flag);
    d.details[flag] = detail;
  };

  for (const [t, s] of Object.entries(jStat)) {
    if (s.n < 8) continue;
    const wr = s.wins / s.n;
    if (wr < 0.35 || s.pnl < 0) {
      add(t, 'A:VIVO_PERDIENDO', { n: s.n, wr: Number(wr.toFixed(2)), pnl: Number(s.pnl.toFixed(1)) });
    }
  }
  for (const [t, s] of Object.entries(pAgg)) {
    const rate = s.esperas + s.ejec > 0 ? s.ejec / (s.esperas + s.ejec) : 0;
    const deadRatio = s.rows > 0 ? s.deadLive / s.rows : 0;
    const oteRoto = s.esperas >= 15 && rate < globalExecRate * 0.5;
    const deadAlto = s.rows >= 6 && deadRatio >= 0.5;
    if (oteRoto || deadAlto) {
      add(t, 'B:OTE_ROTO', {
        esperas: s.esperas, ejec: s.ejec, rate: Number(rate.toFixed(2)),
        global: Number(globalExecRate.toFixed(2)),
        deadInLive: `${s.deadLive}/${s.rows} filas`
      });
    }
  }
  for (const x of sigsPerDay) {
    if (Math.abs((x as any).z) > 2) {
      add(x.t, 'C:SEÑALES_ANÓMALAS', { spd: Number(x.spd.toFixed(1)), z: Number((x as any).z.toFixed(2)) });
    }
  }

  // Ordenar: más flags primero, luego alfabético
  const rows = Object.entries(diags)
    .map(([t, d]) => ({ ticker: t, score: d.flags.length, ...d }))
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));

  console.log(`\n🩺 DIAGNÓSTICO DE DETECCIÓN — ventana ${DAYS}d — ${new Date().toISOString().slice(0, 16)}Z`);
  console.log(`   OTE global: ejec/esperas = ${(globalExecRate * 100).toFixed(1)}% (${ejecAll}/${esperasAll + ejecAll})`);
  if (rows.length === 0) {
    console.log('   ✅ Ningún activo con detección sospechosa.');
  } else {
    for (const r of rows) {
      console.log(`\n  ${'🚩'.repeat(Math.min(r.score, 3))} ${r.ticker} (score=${r.score})`);
      for (const f of r.flags) console.log(`      ${f}: ${JSON.stringify(r.details[f])}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    windowDays: DAYS,
    globalOteExecRate: globalExecRate,
    flags: rows,
  };
  const outPath = path.join(REPO, 'scripts/periodic_opt/reports/detection_diagnostic.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  await db.collection('detection_diagnostics').doc('latest').set(out);
  console.log(`\n💾 ${outPath} + Firestore detection_diagnostics/latest`);
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e); process.exit(1); });
