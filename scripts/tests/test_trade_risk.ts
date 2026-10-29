import assert from 'node:assert/strict';
import { createTradeRiskSnapshot, computeTradeRiskR } from '../../src/engine/TradeRisk.js';

const input = { ticker: 'USOIL', direction: 'BUY' as const, currency: 'EUR', entryPrice: 99.9, initialSlPrice: 99.12123, filledVolumeCents: 5000, quoteToAccountRate: 0.8903847352440989, capturedAtMs: 1792582131848 };
const snapshot = createTradeRiskSnapshot(input);
assert.ok(snapshot);
assert.equal(snapshot.schema, 1);
assert.equal(snapshot.source, 'broker_fill');
assert.ok(Math.abs(snapshot.riskAmountAccount - 34.67024601330273) < 1e-8);
assert.ok(Math.abs(computeTradeRiskR(-46.66, snapshot)! - (-46.66 / snapshot.riskAmountAccount)) < 1e-12);
assert.equal(computeTradeRiskR(0, snapshot), 0);
console.log('PASS broker cents → immutable account-currency initial price risk');

for (const overrides of [
    { entryPrice: NaN }, { initialSlPrice: Infinity }, { initialSlPrice: 100 },
    { filledVolumeCents: 0 }, { filledVolumeCents: 0.5 }, { filledVolumeCents: Number.MAX_SAFE_INTEGER + 1 },
    { quoteToAccountRate: 0 }, { capturedAtMs: -1 }, { capturedAtMs: 1.5 },
    { ticker: ' usoil' }, { currency: 'eur' }, { direction: 'HOLD' },
]) assert.equal(createTradeRiskSnapshot({ ...input, ...overrides } as any), null, JSON.stringify(overrides));
assert.equal(createTradeRiskSnapshot(null as any), null);
const poisoned = { ...input, extra: { mutable: true }, riskAmountAccount: 1 };
const clean = createTradeRiskSnapshot(poisoned)!;
assert.equal('extra' in clean, false);
assert.equal(Object.isFrozen(clean), true);
poisoned.entryPrice = 200;
assert.equal(clean.entryPrice, input.entryPrice);
assert.equal(computeTradeRiskR(NaN, snapshot), null);
assert.equal(computeTradeRiskR(2, { ...snapshot!, riskAmountAccount: 1 }), null);
assert.equal(computeTradeRiskR(2, { ...snapshot!, source: 'close_conversion' } as any), null);
assert.equal(computeTradeRiskR(2, { ...snapshot!, schema: 2 } as any), null);
assert.equal(computeTradeRiskR(2, null), null);
console.log('PASS invalid units/SL/schema/currency rejected; fresh frozen whitelist; tamper checks');

const { resolveTradeCloseAccounting } = await import('../../src/engine/TradeRisk.js');
const trade = { ticker: 'USOIL', direction: 'BUY', ctraderPositionId: 'p1', accountCurrency: 'EUR', riskSnapshot: snapshot, slPrice: 110 };
const opening = { dealId: 1, positionId: 'p1', tradeSide: 1, filledVolume: 5000, executionPrice: input.entryPrice, executionTimestamp: 1000, moneyDigits: 2, commission: -18 };
const closing = { dealId: 2, positionId: 'p1', tradeSide: 2, filledVolume: 5000, executionTimestamp: 2000, moneyDigits: 2, closePositionDetail: { closedVolume: 5000, grossProfit: -4630, commission: -36, swap: 0, moneyDigits: 2, balance: 334800, balanceVersion: 370 } };
const accounting = resolveTradeCloseAccounting('p1', trade, [opening, closing, closing], 'EUR');
assert.ok(accounting);
assert.equal(accounting.pnl, -46.66);
assert.equal(accounting.balanceAfterUsd, 3348);
assert.equal(accounting.closedAt, new Date(2000).toISOString());
assert.equal(accounting.closedAtSource, 'broker_execution');
assert.equal(accounting.riskAccountingStatus, 'VERIFIED');
assert.equal(accounting.accountCurrency, 'EUR');
assert.equal(accounting.rMultiple, computeTradeRiskR(-46.66, snapshot));
assert.equal(accounting.riskAmountAccount, snapshot!.riskAmountAccount);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening], 'EUR'), null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, { ...closing, closePositionDetail: { ...closing.closePositionDetail, closedVolume: 2500 } }], 'EUR'), null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, { ...closing, positionId: 'other' }], 'EUR'), null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [{ ...opening, filledVolume: 2500 }, { ...closing, filledVolume: 2500, closePositionDetail: { ...closing.closePositionDetail, closedVolume: 2500 } }], 'EUR'), null, 'a matching truncated opening/close subset cannot finalize a larger verified fill');
console.log('PASS deduped actual deposit PnL, initial denominator, full-volume finality, broker close time');

const openA = { ...opening, filledVolume: 3000, executionPrice: 100 };
const openB = { ...opening, dealId: 3, filledVolume: 2000, executionPrice: 99.75 };
const closeA = { ...closing, filledVolume: 2500, executionTimestamp: 1500, closePositionDetail: { ...closing.closePositionDetail, closedVolume: 2500, grossProfit: -1000, commission: -20, swap: -5, moneyDigits: 3, balance: 3394660, balanceVersion: 369 } };
const closeB = { ...closing, dealId: 4, filledVolume: 2500, closePositionDetail: { ...closing.closePositionDetail, closedVolume: 2500 } };
const partials = resolveTradeCloseAccounting('p1', trade, [closeB, openB, closeA, openA], 'EUR')!;
assert.equal(partials.entryPrice, 99.9);
assert.equal(partials.filledVolumeCents, 5000);
assert.equal(partials.pnl, -47.685);
assert.equal(partials.balanceAfterUsd, 3348);
assert.equal(partials.rMultiple, computeTradeRiskR(-47.685, snapshot));
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, { ...closing, tradeSide: 0 }], 'EUR'), null, 'reject invalid closing identity');
for (const overrides of [{ ticker: 'XPTUSD' }, { direction: 'SELL' }, { currency: 'USD' }, { entryPrice: 100 }]) {
    const other = createTradeRiskSnapshot({ ...input, ...overrides, ...(overrides.direction === 'SELL' ? { initialSlPrice: 110 } : {}) } as any)!;
    const a = resolveTradeCloseAccounting('p1', { ...trade, riskSnapshot: other }, [opening, closing], 'EUR')!;
    assert.equal(a.rMultiple, null, JSON.stringify(overrides));
    assert.equal(a.riskAccountingStatus, 'INVALID');
}
assert.equal(resolveTradeCloseAccounting('p1', { ...trade, riskSnapshot: createTradeRiskSnapshot({ ...input, filledVolumeCents: 500000 }) }, [opening, closing], 'EUR'), null, 'volume units mismatch cannot finalize');
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, closing], 'USD')!.rMultiple, null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, closing], null)!.rMultiple, null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, closing], null)!.riskAccountingStatus, 'UNVERIFIED');
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, closing], null)!.riskAccountingProvenance, 'unverified_account_currency');
assert.equal(resolveTradeCloseAccounting('p1', { ...trade, riskSnapshot: undefined }, [opening, closing], 'EUR')!.riskAccountingStatus, 'UNVERIFIED');
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, closing, { ...closing, executionTimestamp: 3000 }], 'EUR'), null, 'conflicting duplicate rejected');
assert.equal(resolveTradeCloseAccounting('p1', { ...trade, symbolId: 5 }, [{ ...opening, symbolId: 6 }, { ...closing, symbolId: 6 }], 'EUR'), null);
assert.equal(resolveTradeCloseAccounting('p1', trade, [opening, { ...closing, closePositionDetail: { ...closing.closePositionDetail, grossProfit: NaN } }], 'EUR'), null);
console.log('PASS partial closes, per-deal scales, multi-fill VWAP, currency/identity/units mismatch rejection');

const { freezeTradeRiskForTrade } = await import('../../src/engine/TradeRisk.js');
const stored = JSON.parse(JSON.stringify(snapshot));
const hydrated: any = { ticker: 'USOIL', direction: 'BUY', riskSnapshot: stored };
assert.equal(freezeTradeRiskForTrade(hydrated), true);
assert.equal(Object.isFrozen(hydrated.riskSnapshot), true);
assert.notEqual(hydrated.riskSnapshot, stored);
assert.equal(hydrated.riskAccountingStatus, 'VERIFIED');
stored.quoteToAccountRate = 50;
assert.equal(hydrated.riskSnapshot.quoteToAccountRate, input.quoteToAccountRate);
assert.throws(() => { hydrated.riskSnapshot = null; });
assert.equal(freezeTradeRiskForTrade(hydrated, { ...snapshot!, quoteToAccountRate: .7 }), true);
assert.equal(hydrated.riskSnapshot.quoteToAccountRate, input.quoteToAccountRate);
const bad: any = { ticker: 'GBPAUD', direction: 'BUY' };
assert.equal(freezeTradeRiskForTrade(bad, snapshot), false);
assert.equal(bad.riskAccountingStatus, 'INVALID');
const absent: any = { ticker: 'USOIL', direction: 'BUY' };
assert.equal(freezeTradeRiskForTrade(absent), false);
assert.equal(absent.riskAccountingStatus, 'UNVERIFIED');
console.log('PASS hydrated and new fill snapshots have no mutable aliases and cannot be replaced');
