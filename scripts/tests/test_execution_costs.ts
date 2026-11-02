import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionInstrument } from '../../src/engine/ExecutionTypes.ts';
import * as executionCosts from '../../src/engine/ExecutionCosts.ts';
// Runtime-invalid fixtures intentionally cross the typed boundary.
const costs:any=executionCosts;
const instrument: ExecutionInstrument = {ticker:'EURUSD',regime:'FOREX',pipSize:.0001,tickSize:.00001,pipValuePerLotUsd:10,baseSpreadPips:1,exitSlippagePips:.2,commissionPerLotSideUsd:3,minStopDistance:0,source:'explicit_model'};
test('classify all 47 ADR symbols explicitly and reject non-FX lookalikes', () => {
  assert.equal(typeof costs.classifyExecutionRegime,'function');
  const groups = {
    FOREX:'AUDCAD AUDCHF AUDJPY AUDNZD AUDUSD CADCHF CADJPY CHFJPY EURAUD EURCAD EURCHF EURGBP EURNZD EURUSD GBPAUD GBPCAD GBPCHF GBPJPY GBPNZD GBPUSD NZDCAD NZDCHF NZDJPY NZDUSD USDCAD USDCHF USDJPY',
    METALS:'XAGUSD XAUUSD XPDUSD XPTUSD',
    INDICES:'AUSTRALIA200 EUROPE50 FRA40 GER40 ITALY40 JP225 NL25 SPAIN35 UK100 US30 US500 USTECH100',
    ENERGY:'NATGAS USOIL XBRUSD', CRYPTO:'BTCUSD',
  };
  let count=0;
  for(const [regime,symbols] of Object.entries(groups)) for(const symbol of symbols.split(' ')){ count++; assert.equal(costs.classifyExecutionRegime(symbol),regime,symbol); }
  assert.equal(count,47);
  for(const symbol of ['FOOBAR','ABCUSD','EURXXX','EURUSD.fake','','USDEURUSD','USDUSD']) assert.equal(costs.classifyExecutionRegime(symbol),undefined,symbol);
  assert.equal(costs.classifyExecutionRegime('eur/usd'),'FOREX');
  assert.equal(costs.classifyExecutionRegime('NAS100'),'INDICES');
});

test('round stops outward and enforce fresh executable geometry and strict ratchet', () => {
  assert.equal(typeof costs.roundExecutionStop,'function'); assert.equal(typeof costs.validateExecutionStop,'function');
  assert.equal(costs.roundExecutionStop(100.129,'BUY',.01),100.12);
  assert.equal(costs.roundExecutionStop(100.121,'SELL',.01),100.13);
  assert.equal(costs.roundExecutionStop(1.1,'BUY',.00001),1.1);
  assert.equal(costs.roundExecutionStop(1.1,'SELL',.00001),1.1);
  for(const [p,t] of [[NaN,.01],[1,0],[-1,.01],[Infinity,.01]]) assert.ok(Number.isNaN(costs.roundExecutionStop(p,'BUY',t)));
  const input={direction:'BUY',candidateSl:1.09,currentSl:1.08,quote:{bid:1.10,ask:1.1001,timestampMs:20000,source:'broker'},instrument:{...instrument,minStopDistance:.001},nowMs:20000};
  assert.equal(costs.validateExecutionStop(input).valid,true);
  for(const bad of [{candidateSl:1.099},{candidateSl:1.08},{currentSl:NaN},{nowMs:19999},{nowMs:30001},{quote:{...input.quote,ask:1.09}},{candidateSl:NaN}]) {const r=costs.validateExecutionStop({...input,...bad}); assert.equal(r.valid,false); assert.ok(r.reason);}
  assert.equal(costs.validateExecutionStop({...input,direction:'SELL',candidateSl:1.11,currentSl:1.12}).valid,true);
  assert.equal(costs.validateExecutionStop({...input,direction:'SELL',candidateSl:1.1011,currentSl:1.12}).valid,false);
});

test('pending cost unit conversion rejects overflowing per-leg USD per pip',()=>{
  const r=costs.estimatePendingExecutionCosts({instrument:{...instrument,exitSlippagePips:0,commissionPerLotSideUsd:0},lots:1e308,remainingLots:1e308,paidCostsUsd:0});
  assert.equal(r.valid,false); assert.ok(r.reason);
});

test('unknown null costs are not defaulted and fine-tick rounding stays outward at large prices',()=>{
  const input={instrument,lots:1,remainingLots:.5,paidCostsUsd:0};
  assert.equal(costs.estimatePendingExecutionCosts({...input,estimatedExitCommissionPerLotUsd:null}).valid,false);
  assert.equal(costs.estimatePendingExecutionCosts({...input,accruedSwapUsd:null}).valid,false);
  const price=12345678.12345678;
  assert.ok(costs.roundExecutionStop(price,'BUY',1e-8)<=price);
  assert.ok(costs.roundExecutionStop(price,'SELL',1e-8)>=price);
  assert.ok(Number.isNaN(costs.roundExecutionStop(1e100,'BUY',1e-10)));
});

test('validate units and price only remaining obligations without rebilling sunk entry costs', () => {
  assert.equal(typeof costs.validateExecutionInstrument,'function');
  assert.equal(typeof costs.estimatePendingExecutionCosts,'function');
  assert.equal(costs.validateExecutionInstrument(instrument),true);
  for(const key of ['pipSize','tickSize','pipValuePerLotUsd']) for(const bad of [0,-1,NaN,Infinity,undefined]) assert.equal(costs.validateExecutionInstrument({...instrument,[key]:bad}),false,key);
  for(const key of ['baseSpreadPips','exitSlippagePips','commissionPerLotSideUsd','minStopDistance']) for(const bad of [-1,NaN,Infinity,undefined]) assert.equal(costs.validateExecutionInstrument({...instrument,[key]:bad}),false,key);
  for(const bad of [{ticker:'FOOBAR'},{regime:'METALS'},{source:'guessed'}]) assert.equal(costs.validateExecutionInstrument({...instrument,...bad}),false);
  const input={instrument,lots:2,remainingLots:.5,paidCostsUsd:100,accruedSwapUsd:-4};
  const result=costs.estimatePendingExecutionCosts(input);
  assert.equal(result.valid,true); assert.equal(result.pendingCostUsd,6.5); assert.ok(Math.abs(result.pendingCostPrice-.00013)<1e-12);
  assert.deepEqual(costs.estimatePendingExecutionCosts({...input,paidCostsUsd:0}),result);
  assert.equal(costs.estimatePendingExecutionCosts({...input,accruedSwapUsd:4}).pendingCostUsd,2.5);
  assert.equal(costs.estimatePendingExecutionCosts({...input,estimatedExitCommissionPerLotUsd:6}).pendingCostUsd,8);
  for(const bad of [{lots:0},{remainingLots:0},{remainingLots:3},{paidCostsUsd:-1},{paidCostsUsd:NaN},{estimatedExitCommissionPerLotUsd:-1},{accruedSwapUsd:NaN},{instrument:{...instrument,pipValuePerLotUsd:undefined}}]) {
    const r=costs.estimatePendingExecutionCosts({...input,...bad}); assert.equal(r.valid,false); assert.ok(r.reason); assert.ok(Number.isNaN(r.pendingCostPrice));
  }
});
