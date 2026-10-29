import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadEnvFile } from 'node:process';
import admin from 'firebase-admin';
import { connect } from 'ctrader-ts';
import { tickFlow } from '../src/engine/TickFlow.js';
import { registerRolloverSchedule, evaluateRolloverEntryGate } from '../src/engine/RolloverSpreadGate.js';
import { getRolloverAssetClass, getRolloverSpreadReference } from '../src/engine/RolloverSpreadReference.js';

// Independent, read-only connection; never imports live service/listeners.
function extract(file: string, names: string[], dependencies: Record<string, unknown>) {
    const text = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) ||
        (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))))
        .map(n => n.getText(ast)).join('\n');
    const js = ts.transpileModule(selected.replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    return vm.runInNewContext(js + '\n({' + names.join(',') + '})', { console, Date, ...dependencies });
}
const root = '/opt/JARVIS';
const friction = extract(root + '/src/engine/FrictionModel.ts', ['getAssetClass', 'getPipValue', 'defaultFrictionConfig'], {});
const quote = extract(root + '/src/services/ctrader.ts', ['MAX_QUOTE_AGE_MS', 'lastBidAsk', 'quoteSides', 'ingestSpotQuote', 'getLastBidAsk', 'configureSpotBootstrap', 'mapToCTraderSymbol'], { tickFlow, ...friction, getRolloverSpreadReference });
loadEnvFile(root + '/.env');
const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(root + '/service-account.json', 'utf8'))) }, 'rollover-roster-readonly');
let client: Awaited<ReturnType<typeof connect>> | undefined;
try {
    const docs = await app.firestore().collection('asset_configs').get();
    const tickers = docs.docs.filter(d => d.id !== 'GLOBAL' && d.data().enabled === true && !d.data().disabledReason).map(d => d.id).sort();
    client = await connect({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
        accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: Number(process.env.CTRADER_ACCOUNT_ID),
        environment: (process.env.CTRADER_DEMO || 'true').toLowerCase() === 'true' ? 'demo' : 'live' });
    const assets = new Map<number, any>();
    const unavailable: string[] = [];
    for (const ticker of tickers) {
        try {
            const info = await client.getSymbolInfo(quote.mapToCTraderSymbol(ticker));
            registerRolloverSchedule(ticker, { scheduleTimeZone: info.scheduleTimeZone ?? '', schedule: info.schedule ?? [] });
            assets.set(Number(info.symbolId), { ticker, info, events: 0, spreads: [] as number[], rawEvents: [] as any[] });
        } catch { unavailable.push(ticker); }
    }
    client.raw.market.onSpot((msg: any) => {
        const asset = assets.get(Number(msg.symbolId));
        if (!asset || (msg.bid == null && msg.ask == null)) return;
        const now = Date.now();
        asset.rawEvents.push({ receivedAt: now, timestamp: msg.timestamp ?? null, bid: msg.bid ?? null, ask: msg.ask ?? null });
        const price = Number(msg.bid ?? msg.ask) / 100000;
        quote.configureSpotBootstrap(asset.ticker, price);
        quote.ingestSpotQuote(asset.ticker, msg, now);
        asset.events++;
        const q = quote.getLastBidAsk(asset.ticker, now);
        if (q && q.ask > q.bid) asset.spreads.push(q.ask - q.bid);
    });
    await client.raw.market.subscribeSpots([...assets.keys()], true);
    await new Promise(resolve => setTimeout(resolve, 180_000));
    const now = Date.now();
    const result = [...assets.values()].map(asset => {
        const s = tickFlow.getSpreadSnapshot(asset.ticker, now);
        const price = s?.bid ?? 1;
        const reference = getRolloverSpreadReference(asset.ticker, price);
        const pip = reference.pipSize;
        const base = reference.baseSpreadPrice;
        const spreads = asset.spreads.sort((a: number, b: number) => a - b);
        const decision = evaluateRolloverEntryGate(asset.ticker, now, s, { live: true, pipSize: pip, baseSpreadPrice: base });
        return { ticker: asset.ticker, events: asset.events, acceptedSamples: s?.samples ?? 0,
            classUsed: getRolloverAssetClass(asset.ticker), pipUsed: pip, brokerPipPosition: asset.info.pipPosition,
            cleanHistoricalReference: reference.cleanBaseline ?? null,
            independentBootstrapCapPrice: Math.max(base + 0.8 * pip, 1.65 * (reference.cleanBaseline ?? 0)),
            medianObservedSpreadPrice: spreads.length ? spreads[Math.floor(spreads.length / 2)] : null,
            gateBlocked: decision.blocked, reason: decision.reason, marketOpen: decision.calendar.marketOpen };
    });
    const report = { observedAt: now, source: 'read-only live SpotEvents, enabled roster, actual current decoder/bootstrap', unavailable, result };
    const file = root + '/logs/rollover_safety/roster_probe_' + now + '.json';
    fs.writeFileSync(file, JSON.stringify({ ...report, rawEvents: Object.fromEntries([...assets.values()].map(a => [a.ticker, a.rawEvents])) }, null, 2));
    console.log(JSON.stringify({ file, ...report }, null, 2));
} finally { client?.disconnect(); await app.delete(); }
