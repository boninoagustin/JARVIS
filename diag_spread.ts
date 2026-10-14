// Medir spread en vivo de GERMANY 40 vs EURUSD/GBPJPY (para responder la duda de spread del DAX)
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env','utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
}
const { connect } = await import('ctrader-ts');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN,
  accountId: parseInt(process.env.CTRADER_ACCOUNT_ID,10)||0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo':'live',
});

const spotEvent = (client as any).connection.spotEvent; // handler de SpotEvent del cliente low-level
const quotes = new Map<string, { bid: number; ask: number; ts: number }>();

const handler = (payload: any) => {
  const bid = payload?.bid ?? payload?.bids?.[0];
  const ask = payload?.ask ?? payload?.asks?.[0];
  if (bid && ask) quotes.set(String(payload.symbolId), { bid: Number(bid), ask: Number(ask), ts: Date.now() });
};

const targets = [['GERMANY 40','GER40'], ['EURUSD','EURUSD'], ['GBPJPY','GBPJPY']];
const infos: Array<[string,string,number]> = [];
(client as any).connection.on(2131, (msg: any) => { try { handler(msg); } catch {} });
for (const [name, tk] of targets) {
  const info = await client.getSymbolInfo(name);
  infos.push([name, tk, Number(info?.symbolId)]);
  await (client as any).raw.market.subscribeSpots([Number(info?.symbolId)]);
}
console.log('esperando ticks (8s)...');
await new Promise(r => setTimeout(r, 8000));

console.log('\n=== SPREAD EN VIVO (ahora: ~21:50 Berlín / 16:50 ARG) ===');
for (const [name, tk, sid] of infos) {
  const q = quotes.get(String(sid));
  if (!q) { console.log(`${tk} (${name}): sin quote`); continue; }
  const spread = q.ask - q.bid;
  const pct = (spread / ((q.bid+q.ask)/2)) * 100;
  console.log(`${tk.padEnd(6)} bid=${q.bid.toFixed(2)} ask=${q.ask.toFixed(2)} | spread=${spread.toFixed(2)} puntos | ${pct.toFixed(4)}%`);
}
await client.disconnect();
process.exit(0);
