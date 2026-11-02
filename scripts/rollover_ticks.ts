export interface DecodedTick { ts: number; price: number }
export interface RawTick { timestamp: number | string; tick: number | string }

/** cTrader pages are newest first; subsequent timestamps/prices are deltas. */
export function decodeTickPage(raw: RawTick[]): DecodedTick[] {
    let ts = 0;
    let price = 0;
    const ticks: DecodedTick[] = [];
    for (let i = 0; i < raw.length; i++) {
        ts = i === 0 ? Number(raw[i].timestamp) : ts + Number(raw[i].timestamp);
        price = i === 0 ? Number(raw[i].tick) : price + Number(raw[i].tick);
        if (!Number.isSafeInteger(ts) || ts <= 0 || !Number.isSafeInteger(price) || price <= 0) {
            throw new Error('Invalid cTrader tick page');
        }
        if (i > 0 && ts > ticks[ticks.length - 1].ts) throw new Error('Non-descending tick page');
        ticks.push({ ts, price: price / 100000 });
    }
    return ticks.reverse();
}

export type FetchTickPage = (fromMs: number, toMs: number) => Promise<{ ticks: RawTick[]; hasMore: boolean }>;

/** Subdivide truncated ranges instead of dropping same-millisecond boundary ticks. */
export async function collectTickRange(fetchPage: FetchTickPage, fromMs: number, toMs: number): Promise<{ ticks: DecodedTick[]; requests: number }> {
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs <= 0 || toMs < fromMs || toMs - fromMs > 604800000) {
        throw new Error('Invalid tick range (maximum seven days)');
    }
    let requests = 0;
    const visit = async (from: number, to: number): Promise<DecodedTick[]> => {
        if (++requests > 4096) throw new Error('Tick coverage could not be completed within request bound');
        const page = await fetchPage(from, to);
        if (page.hasMore) {
            if (from === to) throw new Error('Incomplete tick coverage at one millisecond');
            const midpoint = Math.floor((from + to) / 2);
            return [...await visit(from, midpoint), ...await visit(midpoint + 1, to)];
        }
        const ticks = decodeTickPage(page.ticks);
        if (ticks.some(t => t.ts < from || t.ts > to)) throw new Error('Broker tick outside requested range');
        return ticks;
    };
    return { ticks: await visit(fromMs, toMs), requests };
}
