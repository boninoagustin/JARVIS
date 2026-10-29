import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-risk-history-'));
const out = path.join(dir, 'proposal.json');
const run = (extra: string[] = []) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/review_trade_risk_history.ts', '--snapshot', 'scratch/review_20261021/firestore.json', '--broker', 'scratch/review_20261021/broker.json', '--since', '2026-10-18T00:00:00+02:00', '--out', out, ...extra], { encoding: 'utf8' });
let proc = run();
assert.equal(proc.status, 0, proc.stderr);
const proposal = JSON.parse(fs.readFileSync(out, 'utf8'));
assert.equal(proposal.mode, 'OFFLINE_PROPOSAL_ONLY');
assert.equal(proposal.summary.trades, 15);
assert.equal(proposal.summary.resolved, 15);
assert.equal(proposal.summary.exactRisk, 0, 'no initial fill-side conversion was captured in these historical documents');
assert.equal(proposal.summary.unknownRisk, 15);
assert.equal(proposal.checks.balanceReconciled, true);
assert.equal(proposal.checks.countsMatch, true);
assert.equal(proposal.summary.accountCurrency, 'EUR');
const originals = JSON.parse(fs.readFileSync('scratch/review_20261021/firestore.json', 'utf8')).journal;
for (const row of proposal.trades) {
    const original = originals.find((j: any) => j.id === row.id);
    assert.equal(row.original.result, original.result);
    assert.equal(row.original.ctrader_real_pnl, original.ctrader_real_pnl);
    assert.equal(row.patch.rMultiple, null);
    assert.equal(row.patch.riskAccountingStatus, 'UNVERIFIED');
    assert.equal(row.patch.closedAt, row.broker.closedAt);
    assert.equal('result' in row.patch, false);
    assert.equal('ctrader_real_pnl' in row.patch, false);
    assert.equal('riskSnapshot' in row.patch, false, 'never forge broker_fill snapshot from historical closing conversion');
}
const oil = proposal.trades.find((t: any) => t.ticker === 'USOIL');
assert.equal(oil.broker.pnl, -46.66);
assert.equal(oil.reconstruction.rateSource, 'close_deal_NOT_opening_rate');
assert.ok(Math.abs(oil.reconstruction.riskAmountAccount - 34.671458) < .00001);
assert.ok(Math.abs(oil.reconstruction.rMultiple - -1.3457761) < .00001);
proc = run(['--apply']);
assert.notEqual(proc.status, 0, 'no apply mode exists');
assert.match(proc.stderr, /Unsupported argument/);
console.log(`PASS 15/15 real offline history replay, balance bridge, honest unknowns, proposal-only, preserved result/PnL; ${out}`);

const originalBrokerText = fs.readFileSync('scratch/review_20261021/broker.json', 'utf8');
for (const scenario of ['pagination', 'balance', 'missing_close'] as const) {
    const damaged = JSON.parse(originalBrokerText);
    if (scenario === 'pagination') damaged.deals.hasMore = true;
    if (scenario === 'balance') damaged.state.balance += 1;
    if (scenario === 'missing_close') damaged.deals.deals = damaged.deals.deals.filter((d: any) => String(d.dealId) !== '339809031');
    const damagedPath = path.join(dir, `${scenario}.json`), blockedOut = path.join(dir, `${scenario}-proposal.json`);
    fs.writeFileSync(damagedPath, JSON.stringify(damaged));
    const blocked = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/review_trade_risk_history.ts', '--snapshot', 'scratch/review_20261021/firestore.json', '--broker', damagedPath, '--since', '2026-10-18T00:00:00+02:00', '--out', blockedOut], { encoding: 'utf8' });
    assert.equal(blocked.status, 2, `${scenario}: ${blocked.stderr}`);
    const diagnostic = JSON.parse(fs.readFileSync(blockedOut, 'utf8'));
    assert.equal(diagnostic.eligibleForReview, false);
    assert.ok(diagnostic.issues.length);
}
assert.equal(fs.readFileSync('scratch/review_20261021/broker.json', 'utf8'), originalBrokerText, 'raw evidence is untouched');
console.log('PASS pagination, balance mismatch, incomplete close-history coverage block proposal eligibility');
