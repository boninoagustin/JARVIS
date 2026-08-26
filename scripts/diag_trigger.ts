// Diagnóstico: qué traen los campos events/isChochEntry/tf en el journal real.
import 'dotenv/config';
import { db } from '../src/db/memory.js';

const snap = await db.collection('trade_journal').orderBy('timestamp', 'desc').limit(40).get();
console.log(`docs: ${snap.size}\n`);
for (const d of snap.docs) {
    const x = d.data();
    const ev = Array.isArray(x.events) ? x.events : null;
    console.log(JSON.stringify({
        id: d.id,
        ticker: x.ticker,
        ts: new Date(Number(x.timestamp ?? 0)).toISOString().slice(0, 16),
        isChoch: x.isChochEntry,
        tf: x.tf ?? null,
        events: ev ? (ev.length > 6 ? `${ev.length} items: [${ev.slice(0, 3).join(' | ')} ...]` : ev) : null,
        triggerKey: x.triggerKey ?? x.trigger ?? null,
        session: x.session ?? null,
        result: x.result ?? null,
    }));
}
process.exit(0);
