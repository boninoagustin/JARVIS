// diag_killswitch.js — diagnostica por qué se disparó el killswitch global
import adminModule from 'firebase-admin';
const admin = adminModule.default ?? adminModule;
import fs from 'node:fs';
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const NY_TZ = 'America/New_York';
function getTimezoneOffsetMs(timeZone, atMs) {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    const name = dtf.formatToParts(new Date(atMs)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}
function getFxDayStartMs(nowMs) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
    const get = (t) => Number(parts.find(p => p.type === t)?.value ?? 0);
    let year = get('year'), month = get('month'), day = get('day'), hour = get('hour');
    if (hour < 17) { const prev = new Date(Date.UTC(year, month - 1, day, 0, 0, 0)); prev.setUTCDate(prev.getUTCDate() - 1); year = prev.getUTCFullYear(); month = prev.getUTCMonth() + 1; day = prev.getUTCDate(); }
    const offsetMs = getTimezoneOffsetMs(NY_TZ, Date.UTC(year, month - 1, day, 17, 0, 0));
    return Date.UTC(year, month - 1, day, 17, 0, 0) - offsetMs;
}

async function main() {
    const nowMs = Date.now();
    const fxDayStartMs = getFxDayStartMs(nowMs);
    console.log('now:', new Date(nowMs).toISOString(), '| ahora en ART:', new Date(nowMs).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));
    console.log('fxDayStart (17:00 NY):', new Date(fxDayStartMs).toISOString(), '=>', new Date(fxDayStartMs).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }));
    console.log('---\n');

    const snap = await db.collection('trade_journal')
        .where('timestamp', '>=', fxDayStartMs - 48 * 60 * 60 * 1000)
        .get();

    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('docs traídos (ventana 48h antes de fxDayStart):', all.length);

    // Replicar el filtro de evaluateGlobalRisk
    const trades = all
        .filter(t => t.mode !== 'backtesting')
        .filter(t => t.result)
        .filter(t => (typeof t.closedAt === 'number' ? t.closedAt : t.timestamp) >= fxDayStartMs)
        .sort((a, b) => (a.closedAt ?? a.timestamp) - (b.closedAt ?? b.timestamp));

    console.log('trades LIVE que cuentan para el killswitch de HOY:', trades.length);
    console.log('---\n');

    let dailyPnLR = 0;
    for (const t of trades) {
        let r = Number(t.rMultiple);
        if (!Number.isFinite(r) || t.rMultiple == null) {
            if (t.result === 'WIN') r = 1.5; else if (t.result === 'LOSS') r = -1.0; else r = 0;
        }
        dailyPnLR += r;
        const ts = t.closedAt ?? t.timestamp;
        const tsStr = new Date(ts).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        console.log(
            `${t.id.padEnd(28)} | ${(t.ticker ?? '?').padEnd(7)} | ${(t.result ?? '?').padEnd(5)} | r=${String(r).padEnd(6)} | ctraderStatus=${t.ctraderStatus ?? '(n/a)'} | dir=${t.direction ?? '?'} | closedAt=${tsStr}`
        );
    }
    console.log('---');
    console.log('dailyPnLR (acumulado):', dailyPnLR.toFixed(2) + 'R');

    // Estado de posiciones abiertas en journal
    const open = all.filter(t => t.mode !== 'backtesting' && !t.result);
    console.log('\nPosiciones SIN result (abiertas en journal):', open.length);
    for (const t of open) {
        console.log(`  ${t.id} | ${t.ticker} | dir=${t.direction} | ctraderStatus=${t.ctraderStatus ?? '(n/a)'} | ts=${new Date(t.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    }

    process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
