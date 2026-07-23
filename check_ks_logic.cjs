const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function getArgentinaMidnightMs(nowMs) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = formatter.format(new Date(nowMs)).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 3, 0, 0)).getTime();
}

async function check() {
    const nowMs = Date.now();
    const artMidnightMs = getArgentinaMidnightMs(nowMs);
    console.log("artMidnightMs:", new Date(artMidnightMs).toISOString());
    const snapshot = await db.collection('trade_journal')
        .where('timestamp', '>=', artMidnightMs)
        .get();
    console.log("Trades today:", snapshot.size);
    let totalTrades = snapshot.size;
    let dailyPnLR = 0;
    let peakPnLR = 0;
    let consecutiveLosses = 0;
    let maxConsecutiveLosses = 0;

    const trades = snapshot.docs
        .map(d => d.data())
        .filter(t => t.mode !== 'backtesting' && t.result)
        .sort((a, b) => a.timestamp - b.timestamp);

    for (const t of trades) {
        let rMultiple = Number(t.rMultiple);
        if (isNaN(rMultiple) || rMultiple === undefined) {
            if (t.result === 'WIN') rMultiple = 1.5;
            else if (t.result === 'LOSS') rMultiple = -1.0;
            else rMultiple = 0;
        }

        dailyPnLR = Math.round((dailyPnLR + rMultiple) * 1000) / 1000;
        if (dailyPnLR > peakPnLR) peakPnLR = dailyPnLR;

        if (rMultiple < 0) {
            consecutiveLosses++;
            if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
        } else if (rMultiple > 0) {
            consecutiveLosses = 0;
        }
    }
    console.log({ totalTrades, consecutiveLosses, maxConsecutiveLosses, dailyPnLR });
}

check().then(() => process.exit(0));
