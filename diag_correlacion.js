// diag_correlacion.js — mide correlación real entre los 10 activos + solapamientos históricos
import fs from 'node:fs';
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;

const TICKERS = ['EURUSD','GBPUSD','AUDCAD','US500','XAUUSD','USDJPY','USDCAD','NZDUSD','BTCUSD','USOIL'];

// ── 1. Cargar velas M15 de cada ticker ──
const closes = {}; // ticker -> {ts: close}
let maxN = 0;
for (const t of TICKERS) {
  const p = `logs/${t.toLowerCase()}/history/history_M15.csv`;
  if (!fs.existsSync(p)) { console.log(`⚠️ sin history para ${t}`); continue; }
  const rows = fs.readFileSync(p, 'utf8').trim().split('\n').slice(1);
  const map = {};
  for (const r of rows) {
    const c = r.split(',');
    const ts = parseInt(c[0], 10);
    const close = parseFloat(c[4]);
    if (Number.isFinite(ts) && Number.isFinite(close)) map[ts] = close;
  }
  closes[t] = map;
  maxN = Math.max(maxN, rows.length);
}
const tss = [...new Set(Object.values(closes).flatMap(m => Object.keys(m).map(Number)))].sort((a,b)=>a-b);

// retornos log de cada ticker sobre la unión de timestamps
const ret = {}; for (const t of TICKERS) ret[t] = new Map();
for (let i = 1; i < tss.length; i++) {
  const ts = tss[i], prev = tss[i-1];
  for (const t of TICKERS) {
    const m = closes[t];
    if (!m || m[prev] === undefined || m[ts] === undefined) continue;
    const c0 = m[prev], c1 = m[ts];
    if (c0 > 0 && c1 > 0) ret[t].set(ts, Math.log(c1/c0));
  }
}

// ── 2. Correlación Pearson estática (últimos 90 días) + EWMA λ=0.992 (half-life ~1 día M15) ──
const pair = (a,b) => [a,b].sort().join('|');
const staticCorr = {}, ewmaCorr = {};
for (let i = 0; i < TICKERS.length; i++) {
  for (let j = i+1; j < TICKERS.length; j++) {
    const A = TICKERS[i], B = TICKERS[j];
    const common = [...ret[A].keys()].filter(ts => ret[B].has(ts));
    if (common.length < 100) continue;
    // estática (últimos ~90 días = últimas ~8600 velas M15)
    const n = Math.min(common.length, 8640);
    const xs = [], ys = [];
    for (const ts of common.slice(-n)) { xs.push(ret[A].get(ts)); ys.push(ret[B].get(ts)); }
    const mean = v => v.reduce((s,x)=>s+x,0)/v.length;
    const mx = mean(xs), my = mean(ys);
    let num=0, dx=0, dy=0;
    for (let k=0;k<xs.length;k++){ num+=(xs[k]-mx)*(ys[k]-my); dx+=(xs[k]-mx)**2; dy+=(ys[k]-my)**2; }
    const rho = num/Math.sqrt(dx*dy);
    staticCorr[pair(A,B)] = rho;
    // EWMA (últimos ~30 días de common, λ=0.992)
    const w = common.slice(-2880);
    const L = 0.992;
    let sA=0, sB=0, sAB=0, first=true;
    for (const ts of w) {
      const x = ret[A].get(ts), y = ret[B].get(ts);
      if (first) { sA=x*x; sB=y*y; sAB=x*y; first=false; }
      else { sA = L*sA + (1-L)*x*x; sB = L*sB + (1-L)*y*y; sAB = L*sAB + (1-L)*x*y; }
    }
    ewmaCorr[pair(A,B)] = sAB/Math.sqrt(sA*sB);
  }
}
console.log('=== CORRELACION REAL (M15, velas del bot) ===');
console.log('par | estática(90d) | EWMA(30d, λ=.992)');
for (const [p, v] of Object.entries(staticCorr).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))) {
  const ew = ewmaCorr[p];
  if (Math.abs(v) >= 0.3 || Math.abs(ew) >= 0.3) {
    console.log(`${p} | ${v.toFixed(3)} | ${ew.toFixed(3)}`);
  }
}

// ── 3. Journal: trades superpuestos en el tiempo, reglas del doc con umbral 0.70 ──
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const cutoff = Date.now() - 180*24*3600*1000;
const snap = await db.collection('trade_journal').where('timestamp','>=',cutoff).get();
const trades = [];
for (const d of snap.docs) {
  const x = d.data();
  if (x.mode === 'backtesting') continue;
  if (!x.ticker || !x.direction || !x.timestamp) continue;
  if (!['WIN','LOSS','BREAKEVEN'].includes(x.result)) continue;
  trades.push({ ticker: String(x.ticker).toUpperCase(), dir: x.direction, ts: x.timestamp, closeTs: x.closedAt ?? x.timestamp, result: x.result });
}
trades.sort((a,b)=>a.ts-b.ts);

const corrFor = (A,B) => {
  const p = pair(A,B);
  return staticCorr[p] ?? ewmaCorr[p] ?? undefined;
};

let violOpuestasPos = 0, violIgualesNeg = 0, dobleExposicion = 0, ejemplos = [];
for (let i = 0; i < trades.length; i++) {
  for (let j = i+1; j < trades.length; j++) {
    const a = trades[i], b = trades[j];
    if (a.ticker === b.ticker) continue;
    // solape temporal
    if (a.ts > (b.closeTs ?? b.ts) || b.ts > (a.closeTs ?? a.ts)) continue;
    const rho = corrFor(a.ticker, b.ticker);
    if (rho === undefined || Math.abs(rho) < 0.70) continue;
    if (rho > 0 && a.dir !== b.dir) {
      violOpuestasPos++;
      if (ejemplos.length < 8) ejemplos.push(`OPUESTAS en ${a.ticker}(${a.dir}) vs ${b.ticker}(${b.dir}) ρ=+${rho.toFixed(2)} | ${new Date(a.ts).toISOString().slice(0,10)}`);
    } else if (rho < 0 && a.dir === b.dir) {
      violIgualesNeg++;
      if (ejemplos.length < 8) ejemplos.push(`IGUALES en ${a.ticker}(${a.dir}) vs ${b.ticker}(${b.dir}) ρ=${rho.toFixed(2)} | ${new Date(a.ts).toISOString().slice(0,10)}`);
    } else if (rho > 0 && a.dir === b.dir) {
      dobleExposicion++;
      if (ejemplos.length < 8) ejemplos.push(`DOBLE EXP ${a.ticker}(${a.dir}) + ${b.ticker}(${b.dir}) ρ=+${rho.toFixed(2)} | ${new Date(a.ts).toISOString().slice(0,10)}`);
    }
  }
}
console.log('\n=== JOURNAL (últimos 90 días, umbral |ρ|≥0.70) ===');
console.log(`trades analizados: ${trades.length}`);
console.log(`⚠️ opuestas en pares positivamente correlacionados (hedge accidental): ${violOpuestasPos}`);
console.log(`⚠️ misma dirección en pares negativamente correlacionados: ${violIgualesNeg}`);
console.log(`⚠️ doble exposición (misma dirección en pares positivos): ${dobleExposicion}`);
console.log('ejemplos:');
for (const e of ejemplos) console.log('  ' + e);
process.exit(0);
