/** Read-only, descriptive rollover evaluation; no trading operations.
 * Default/--dry-run NEVER writes Firestore. Only --publish authorizes publishing.
 * Existing scheduling without flags deliberately becomes read-only.
 * Offline tests: --dry-run --fixture <explicitly labelled fixture JSON>.
 * Bid M5 traversals and recorded survival do not establish rule-A causation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadEnvFile } from 'node:process';
import { getRolloverCalendar, registerRolloverSchedule } from '../src/engine/RolloverSpreadGate.js';
import { CUT, decodeTrendbar, evaluateRollover, normalizeTrade, parseTimestamp, tradeWindows,
    type BarData, type BidBar, type ClosedTrade } from './rollover_eval_core.js';

const ROOT = '/opt/JARVIS';
const DAY_MS = 86_400_000;
/** Match src/config.ts without importing its credential validation or dotenv side effects. */
export function resolveBrokerEnvironment(env: NodeJS.ProcessEnv): 'demo' | 'live' {
    return (env.CTRADER_DEMO || 'true').toLowerCase() === 'true' ? 'demo' : 'live';
}

export interface CliOptions { publish: boolean; fixture?: string }
export function parseCliOptions(args: string[]): CliOptions {
    const options: CliOptions = { publish: false };
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--dry-run') dryRun = true;
        else if (args[i] === '--publish') options.publish = true;
        else if (args[i] === '--fixture' && args[i + 1] && !args[i + 1]!.startsWith('--')) options.fixture = args[++i];
        else throw new Error('Invalid arguments; use --dry-run [--fixture FILE] or --publish');
    }
    if (options.publish && (dryRun || options.fixture)) throw new Error('--publish cannot be combined with --dry-run or --fixture');
    return options;
}

export function evaluateFixture(fixture: any) {
    if (fixture?.kind !== 'rollover_eval_test_fixture' || !Array.isArray(fixture.trades) ||
        parseTimestamp(fixture.evaluatedAt) === null) throw new Error('Explicit test fixture label and evaluation time required');
    const tickers = new Set<string>(fixture.trades.map((t: any) => t.ticker));
    for (const ticker of tickers) {
        // Invalid/missing metadata clears a previously registered fixture calendar.
        registerRolloverSchedule(ticker, fixture.symbols?.[ticker] ?? { scheduleTimeZone: '', schedule: [] });
    }
    const barsByTicker: Record<string, BarData> = Object.create(null);
    for (const [ticker, raw] of Object.entries(fixture.rawBarsByTicker ?? {})) {
        if (!Array.isArray(raw)) throw new Error('Fixture bars must be raw protocol arrays');
        const bars = raw.map(decodeTrendbar);
        barsByTicker[ticker] = bars.some(b => b === null)
            ? { bars: [], error: 'invalid_raw_bar' } : { bars: bars as BidBar[] };
    }
    return evaluateRollover({ trades: fixture.trades, evaluatedAt: parseTimestamp(fixture.evaluatedAt)!,
        barsByTicker, getCalendar: getRolloverCalendar, blockedByTicker: fixture.blockedByTicker ?? {} });
}

function readBlockedSignals() {
    const counts: Record<string, number> = Object.create(null);
    const file = path.join(ROOT, 'logs/blocked_signals.jsonl');
    let malformedLines = 0;
    if (!fs.existsSync(file)) return { counts, malformedLines, available: false };
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line), ts = parseTimestamp(r.ts);
            if (r.reason === 'ROLLOVER' && ts !== null && ts >= CUT && typeof r.ticker === 'string' && r.ticker !== '_GLOBAL') {
                counts[r.ticker] = (counts[r.ticker] ?? 0) + 1;
            }
        } catch { malformedLines++; }
    }
    return { counts, malformedLines, available: true };
}

export interface ReadonlyBroker {
    getSymbols(): Promise<{ symbolId: number; symbolName?: string }[]>;
    getSymbolDetails(ids: number[]): Promise<{ scheduleTimeZone?: string; schedule?: { startSecond: number; endSecond: number }[] }[]>;
    raw: { market: { getTrendbars(params: { symbolId: number; period: number; fromTimestamp: number; toTimestamp: number; count: number }): Promise<{ trendbars: any[]; hasMore: boolean }> } };
    disconnect(): void | Promise<void>;
}
/** Ownership of the supplied read-only connection transfers here, including cleanup. */
export async function collectBrokerEvidence(ct: ReadonlyBroker, valid: ClosedTrade[], evaluatedAt: number, period: number): Promise<Record<string, BarData>> {
    const barsByTicker: Record<string, BarData> = Object.create(null);
    const tickers = [...new Set(valid.map(t => t.ticker))];
    for (const ticker of tickers) registerRolloverSchedule(ticker, { scheduleTimeZone: '', schedule: [] });
    try {
        let symbols: Awaited<ReturnType<ReadonlyBroker['getSymbols']>>;
        try { symbols = await ct.getSymbols(); }
        catch {
            for (const ticker of tickers) barsByTicker[ticker] = { bars: [], error: 'broker_discovery_failed' };
            return barsByTicker;
        }
        for (const ticker of tickers) {
            const symbol = symbols.find(s => s.symbolName === ticker);
            if (!symbol) { barsByTicker[ticker] = { bars: [], error: 'symbol_unavailable' }; continue; }
            try {
                const [details] = await ct.getSymbolDetails([symbol.symbolId]);
                if (!details || !registerRolloverSchedule(ticker, { scheduleTimeZone: details.scheduleTimeZone ?? '', schedule: details.schedule ?? [] })) {
                    barsByTicker[ticker] = { bars: [], error: 'schedule_metadata_unavailable' }; continue;
                }
                const days = new Set<number>();
                for (const trade of valid.filter(t => t.ticker === ticker)) for (const window of tradeWindows(trade, getRolloverCalendar).windows) {
                    for (let day = Math.floor(window.start / DAY_MS) * DAY_MS; day < Math.min(window.end, trade.closedAt); day += DAY_MS) days.add(day);
                }
                let requests = 0;
                const getRange = async (fromTimestamp: number, toTimestamp: number): Promise<BidBar[]> => {
                    if (++requests > 512) throw new Error('pagination_budget_exceeded');
                    const result = await ct.raw.market.getTrendbars({ symbolId: symbol.symbolId, period,
                        fromTimestamp, toTimestamp, count: 300 });
                    if (result.hasMore) {
                        // Do not assume the broker's page order. Subdivide the time
                        // interval and discard the ambiguous truncated parent page.
                        const middle = Math.floor((fromTimestamp + toTimestamp + 1) / 2 / 300_000) * 300_000;
                        if (middle <= fromTimestamp || middle > toTimestamp) throw new Error('unresolved_truncation');
                        return [...await getRange(fromTimestamp, middle - 1), ...await getRange(middle, toTimestamp)];
                    }
                    const decoded: BidBar[] = [];
                    for (const raw of result.trendbars) {
                        const bar = decodeTrendbar(raw);
                        if (!bar || bar.ts < fromTimestamp || bar.ts > toTimestamp) throw new Error('invalid_raw_bar');
                        decoded.push(bar);
                    }
                    return decoded;
                };
                const bars: BidBar[] = [];
                for (const day of [...days].sort((a, b) => a - b)) {
                    // One UTC day holds at most 288 M5 bars; installed API exposes
                    // no max-period metadata. Missing prices never imply safe stops.
                    bars.push(...await getRange(day, Math.min(day + DAY_MS - 1, evaluatedAt)));
                }
                barsByTicker[ticker] = { bars: [...new Map(bars.map(b => [b.ts, b])).values()].sort((a, b) => a.ts - b.ts) };
            } catch { barsByTicker[ticker] = { bars: [], error: 'broker_request_failed_or_incomplete' }; }
        }
        return barsByTicker;
    } finally { await ct.disconnect(); }
}

export async function publishEvaluation(db: any, documents: Record<string, any>[], publish = false): Promise<boolean> {
    if (!publish) return false;
    for (const document of documents) {
        if (document.rSalvado !== null || typeof document.ticker !== 'string') throw new Error('Invalid descriptive publication');
        const ref = db.collection('rollover_evals').doc(document.ticker);
        await ref.set(document, { merge: false });
        if (!isDeepStrictEqual((await ref.get()).data(), document)) throw new Error('Publication verification failed');
    }
    return true;
}

export async function main(args = process.argv.slice(2)) {
    const options = parseCliOptions(args);
    if (options.fixture) {
        const report = evaluateFixture(JSON.parse(fs.readFileSync(options.fixture, 'utf8')));
        console.log(JSON.stringify({ mode: 'dry-run', source: 'test_fixture_not_history', published: false, ...report }));
        return report;
    }
    // All credentials, Firebase and broker connections are entrypoint-only.
    const { default: admin } = await import('firebase-admin');
    const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(path.join(ROOT, 'service-account.json'), 'utf8'))) }, 'rollover-eval');
    const evaluatedAt = Date.now();
    try {
        const db = app.firestore();
        const snap = await db.collection('trade_journal').get();
        const trades: any[] = [];
        snap.forEach(d => {
            const record = d.data();
            const ts = parseTimestamp(record.timestamp);
            if ((ts === null || ts >= CUT) && record.mode === 'live' && record.ctraderStatus === 'EXECUTED' && typeof record.result === 'string') {
                trades.push({ ...record, id: record.id ?? d.id });
            }
        });
        const blocked = readBlockedSignals();
        const barsByTicker: Record<string, BarData> = Object.create(null);
        const valid = trades.map(t => normalizeTrade(t, evaluatedAt)).flatMap(n => n.trade ? [n.trade] : []);
        if (valid.length) {
            loadEnvFile(path.join(ROOT, '.env'));
            const { connect, TrendbarPeriod } = await import('ctrader-ts');
            const ct = await connect({ environment: resolveBrokerEnvironment(process.env),
                clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
                accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: Number(process.env.CTRADER_ACCOUNT_ID) });
            Object.assign(barsByTicker, await collectBrokerEvidence(ct, valid, evaluatedAt, TrendbarPeriod.M5));
        }
        const report = evaluateRollover({ trades, evaluatedAt, getCalendar: getRolloverCalendar, barsByTicker, blockedByTicker: blocked.counts });
        const documents = [...report.tickers, report.global].map(a => ({ ...a,
            // Bound Firestore document size; complete evidence remains in dry-run output.
            evidence: a.evidence.slice(0, 100), evidenceTotal: a.evidence.length, evidenceTruncated: a.evidence.length > 100,
            evaluatedAt, schemaVersion: 2, dataSource: 'broker_bid_m5_and_recorded_journal', coverage: 'available_data_only',
            historicalScheduleVerified: false, blockedLogAvailable: blocked.available, malformedBlockedLines: blocked.malformedLines,
            ...(a.ticker === '_GLOBAL' ? { tickers: report.tickers.length } : {}) }));
        await publishEvaluation(db, documents, options.publish);
        console.log(JSON.stringify({ mode: options.publish ? 'publish' : 'dry-run', published: options.publish,
            evaluatedAt, blockedRule: 'C', coverage: 'available_data_only', historicalScheduleVerified: false, ...report }));
        return report;
    } finally { await app.delete(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(() => { console.error('[roll-eval] failed; no credentials or broker payload logged'); process.exitCode = 1; });
}
