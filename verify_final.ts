// verify_final.ts — verificación definitiva: journal vs deals reales de cTrader desde el 14/09.
import fs from 'node:fs';
for (const line of fs.readFileSync('/opt/JARVIS/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { connect } = await import('ctrader-ts');
const adminModule = await import('firebase-admin');
const admin = adminModule.default ?? adminModule;
const sa = JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json', 'utf8'));
if (admin.apps.length === 0) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const CORTE = Date.parse('2026-09-14T03:00:00Z');
const client = await connect({
  clientId: process.env.CTRADER_CLIENT_ID, clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN, accountId: parseInt(process.env.CTRADER_ACCOUNT_ID!, 10) || 0,
  environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
});
const resp: any = await client.getDeals({ from: CORTE, to: Date.now(), maxRows: 5000 });
const deals: any[] = resp?.deals ?? resp ?? [];
try { await (client as any).disconnect?.(); } catch { }

// neto por posición desde deals
const byPid = new Map<number, { net: number; closes: number }>();
for (const d of deals) {
  const pid = Number(d.positionId);
  if (!byPid.has(pid)) byPid.set(pid, { net: 0, closes: 0 });
  const p = byPid.get(pid)!;
  const cp = d.closePositionDetail;
  if (cp) {
    const md = d.moneyDigits ?? cp.moneyDigits ?? 2;
    p.net += (Number(cp.grossProfit || 0) + Number(cp.commission || 0) + Number(cp.swap || 0)) / Math.pow(10, md);
    p.closes++;
  } else {
    const md = d.moneyDigits ?? 2;
    p.net += Number(d.commission || 0) / Math.pow(10, md);
  }
}

const snap = await db.collection('trade_journal').get();
let ok = 0, fail = 0;
console.log('=== VERIFICACIÓN FINAL (desde 14/09) ===');
for (const doc of snap.docs) {
  const x = doc.data();
  const pid = x.ctraderPositionId ? Number(x.ctraderPositionId) : null;
  if (pid == null) {
    console.log(`#${doc.id} ${x.ticker}: sin posID (${x.result ? 'abierto/otro' : 'en curso'}) — no aplica`);
    continue;
  }
  const real = byPid.get(pid);
  if (!real || real.closes === 0) {
    console.log(`#${doc.id} ${x.ticker} posID=${pid}: posición AÚN ABIERTA o sin deals en ventana — no aplica`);
    continue;
  }
  const realNet = Math.round(real.net * 100) / 100;
  const stored = x.ctrader_real_pnl ?? null;
  const resReal = realNet > 0.1 ? 'WIN' : realNet < -0.1 ? 'LOSS' : 'BREAKEVEN';
  const problems: string[] = [];
  if (stored == null || Math.abs(stored - realNet) > 0.11) problems.push(`pnl journal=$${stored} vs real=$${realNet}`);
  if (x.result && !x.manualResult && x.result !== resReal) problems.push(`result=${x.result} vs ${resReal}`);
  if (problems.length) {
    fail++;
    console.log(`❌ #${doc.id} ${x.ticker} posID=${pid}: ${problems.join(' | ')}`);
  } else {
    ok++;
    console.log(`✅ #${doc.id} ${x.ticker}: pnl=$${stored} result=${x.result} — COINCIDE con cTrader`);
  }
}
console.log(`\nok=${ok} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
