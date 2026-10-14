// probe_ctrader_account.ts — verificación directa del estado de la cuenta demo
// Conecta con las credenciales de .env, autentica y pide el snapshot de la cuenta.
import dotenv from 'dotenv';
dotenv.config({ path: '/opt/JARVIS/.env' });

const CID = process.env.CTRADER_CLIENT_ID || '';
const SEC = process.env.CTRADER_CLIENT_SECRET || '';
const TOK = process.env.CTRADER_ACCESS_TOKEN || '';
const ACC = parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10);
const DEMO = (process.env.CTRADER_DEMO || 'true') === 'true';

console.log(`[PROBE] Modo: ${DEMO ? 'DEMO' : 'LIVE'} | accountId: ${ACC} | clientId: ${CID.slice(0, 12)}... | token: ${TOK.slice(0, 8)}... (${TOK.length} chars)`);

const { connect } = await import('ctrader-ts');

const t0 = Date.now();
try {
  const client = await connect({
    clientId: CID,
    clientSecret: SEC,
    accessToken: TOK,
    accountId: ACC,
    environment: DEMO ? 'demo' : 'live',
  });
  console.log(`[PROBE] ✅ Conectado en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const state = await client.getState();
  console.log(`[PROBE] Cuenta: ${JSON.stringify({
    accountId: state?.accountId,
    balance: state?.balance,
    equity: state?.equity,
    currency: state?.currency,
    margin: state?.margin,
    positions: state?.positions?.length ?? 'n/d',
    orders: state?.orders?.length ?? 'n/d',
  })}`);
  await new Promise(r => setTimeout(r, 1500)); // dejar ciclar heartbeats
  client.disconnect();
  console.log('[PROBE] Desconectado limpio.');
  process.exit(0);
} catch (e: any) {
  console.error(`[PROBE] ❌ FALLO tras ${((Date.now() - t0) / 1000).toFixed(1)}s:`, e?.message || e);
  process.exit(1);
}
