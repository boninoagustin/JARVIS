import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadEnvFile } from 'node:process';
import { connect } from 'ctrader-ts';
import { tickFlow } from '../src/engine/TickFlow.js';
import { registerRolloverSchedule, evaluateRolloverEntryGate } from '../src/engine/RolloverSpreadGate.js';

// Read-only connection. Extract quote decoder only; never import service/trading listeners.
const text = fs.readFileSync('/opt/JARVIS/src/services/ctrader.ts', 'utf8');
const ast = ts.createSourceFile('ctrader.ts', text, ts.ScriptTarget.Latest, true);
const names = ['MAX_QUOTE_AGE_MS', 'lastBidAsk', 'quoteSides', 'ingestSpotQuote', 'getLastBidAsk'];
const selected = ast.statements.filter(n => (ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? '')) ||
    (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))))
    .map(n => n.getText(ast)).join('\n');
const compiled = ts.transpileModule(selected.replace(/export /g, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const quoteApi = vm.runInNewContext(compiled + '\n({ingestSpotQuote,getLastBidAsk})', { tickFlow, Date, console });
loadEnvFile('/opt/JARVIS/.env');
const client = await connect({ clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: Number(process.env.CTRADER_ACCOUNT_ID),
    environment: (process.env.CTRADER_DEMO || 'true').toLowerCase() === 'true' ? 'demo' : 'live' });
const deadline = setTimeout(() => { client.disconnect(); process.exitCode = 2; }, 60000);
try {
    const assets = new Map<number, any>();
    for (const ticker of ['EURUSD', 'AUDJPY', 'GBPUSD', 'XAUUSD']) {
        const info = await client.getSymbolInfo(ticker);
        const key = `LIVEPROBE_${ticker}`;
        const pip = ticker.includes('JPY') ? 0.01 : ticker === 'XAUUSD' ? 0.1 : 0.0001;
        const basePips = ticker === 'XAUUSD' ? 1 : 0.1;
        if (!registerRolloverSchedule(key, { scheduleTimeZone: info.scheduleTimeZone ?? '', schedule: info.schedule ?? [] })) {
            throw new Error(`Broker calendar unavailable for ${ticker}`);
        }
        tickFlow.configureBootstrapSpread(key, { pipSize: pip, baseSpreadPrice: basePips * pip });
        assets.set(Number(info.symbolId), { ticker, key, pip, basePips, events: 0, missingTimestamp: 0, staleOrFutureTimestamp: 0, executableSnapshots: 0 });
    }
    const rawEvents: any[] = [];
    client.raw.market.onSpot((msg: any) => {
        const asset = assets.get(Number(msg.symbolId));
        if (!asset || (msg.bid == null && msg.ask == null)) return;
        const now = Date.now(), timestamp = Number(msg.timestamp);
        asset.events++;
        if (!Number.isFinite(timestamp) || timestamp <= 0) asset.missingTimestamp++;
        else if (timestamp > now || now - timestamp > 10000) asset.staleOrFutureTimestamp++;
        quoteApi.ingestSpotQuote(asset.key, msg, now);
        if (quoteApi.getLastBidAsk(asset.key, now) && tickFlow.getSpreadSnapshot(asset.key, now)) asset.executableSnapshots++;
        rawEvents.push({ ticker: asset.ticker, receivedAt: now, timestamp: msg.timestamp ?? null, bid: msg.bid ?? null, ask: msg.ask ?? null });
    });
    await client.raw.market.subscribeSpots([...assets.keys()], true);
    await new Promise(resolve => setTimeout(resolve, 45000));
    const now = Date.now();
    const result = [...assets.values()].map(asset => {
        const snapshot = tickFlow.getSpreadSnapshot(asset.key, now);
        const decision = evaluateRolloverEntryGate(asset.key, now, snapshot, { live: true, baseSpreadPrice: asset.basePips * asset.pip, pipSize: asset.pip });
        return { ticker: asset.ticker, events: asset.events, missingTimestamp: asset.missingTimestamp,
            staleOrFutureTimestamp: asset.staleOrFutureTimestamp, executableSnapshots: asset.executableSnapshots,
            cleanSamples: snapshot?.samples ?? 0, baselinePips: snapshot?.baselineSpread == null ? null : snapshot.baselineSpread / asset.pip,
            gateBlocked: decision.blocked, gateReason: decision.reason };
    });
    const report = { observedAt: now, source: 'actual timestamp-enabled cTrader SpotEvents; extracted real quote decoder + real pure gate/TickFlow', result, rawEvents };
    fs.writeFileSync('/opt/JARVIS/logs/rollover_safety/live_quote_probe.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ observedAt: now, totalEvents: rawEvents.length, result }, null, 2));
    if (!rawEvents.length || result.some(x => x.missingTimestamp > 0)) throw new Error('Broker timestamp wiring not verified');
} finally { clearTimeout(deadline); client.disconnect(); }
