import assert from 'node:assert/strict';
const regime: typeof import('../../src/engine/MLRegimeFeatures.js') = await import('../../src/engine/MLRegimeFeatures.js').catch(() => ({} as any));
assert.equal(typeof regime.buildRegimeContext,'function','causal regime builder must exist');
const now = Date.UTC(2026,9,12,13,30);
const obs = <T>(value:T) => ({value, observedAtMs:now-100, availableAtMs:now-50, maxAgeMs:10000, provenance:'observed:test-fixture'});
export function context(): any {
 return {schema:regime.REGIME_FEATURE_SCHEMA, ticker:'EURUSD',tf:'15',direction:'BUY',nowMs:now,
  momentum:{...obs({zUp:3,zDn:1}),profile:'radar-z-difference/v1'},
  atr:{...obs(.001),tf:'15',units:'price'},
  adr:{...obs(.01),units:'price',calendarId:'UTC-day',closedDayEndMs:[now-86400000,now-172800000],lookbackDays:2},
  day:{...obs({high:1.105,low:1.095}),calendarId:'UTC-day',dayStartMs:Date.UTC(2026,9,12),dayEndMs:Date.UTC(2026,9,13)},
  price:obs(1.1),entry:{...obs({entryPrice:1.1,initialSL:1.098}),source:'signal-initial-stop'},
  vwap:{...obs('UNDER'),tf:'15'},biases:{D:obs('BUY'),'240':obs('BUY'),'60':obs('NEUTRAL'),'15':obs('SELL')},
  score:obs({points:0,minRequired:6}),
  sweeps:{...obs([{direction:'BUY',tf:'15',eventAtMs:now-500,availableAtMs:now-400}]),ttlMsByTf:{'15':60000},coverageStartMs:now-60000},
  zones:obs([{direction:'BUY'},{direction:'SELL'}]),
  quote:{...obs({bid:1.1,ask:1.1002}),units:'price'},
  spreadBaseline:{...obs(.0001),units:'price',clean:true,samples:100},
  // Explicit synthetic fixture evidence, not a default for historical/live absence.
  velocity:{...obs({zScore:-2}),baselineHourUtc:13,samples:51,baselineVarianceMs2:100,profile:'tickflow/interarrival-ewma-z/utc-hour/v1'},
 };
}
assert.equal(typeof regime.buildRegimeContext,'function');
const raw=context();
const built=regime.buildRegimeContext(raw); assert.equal(built.status,'AVAILABLE');
const features=regime.extractRegimeFeatures(raw); assert.equal(features.status,'EXTRACTED');
if(features.status!=='EXTRACTED') throw new Error('extract failed');
assert.deepEqual(Object.keys(features.features),regime.REGIME_FEATURE_NAMES);
assert.equal(features.vector.length,14);
assert.equal(features.features.dir_z_momentum,2);
assert.equal(features.features.smc_score_excess,-6,'zero score is real, never CHoCH fallback');
assert.ok(Math.abs(features.features.atr_to_adr_ratio-.1)<1e-12);
assert.ok(Math.abs(features.features.spread_to_normal_ratio-2)<1e-8);
assert.equal(features.features.tick_velocity_z,-2);
assert.equal(features.features.recent_sweep_aligned,1);
assert.equal(regime.extractRegimeFeatures({...raw,adr:undefined}).status,'UNAVAILABLE');
assert.equal(regime.extractRegimeFeatures({...raw,spreadBaseline:undefined}).status,'UNAVAILABLE');
assert.equal(regime.extractRegimeFeatures({...raw,momentum:undefined}).status,'UNAVAILABLE');
for(const mutate of [
 (c:any)=>c.atr.tf='60',
 (c:any)=>c.adr.closedDayEndMs[0]=now+1,
 (c:any)=>c.day.dayStartMs=now+1,
 (c:any)=>c.entry.value.initialSL=c.entry.value.entryPrice,
 (c:any)=>c.vwap.availableAtMs=now+1,
 (c:any)=>c.biases.D.value='UNKNOWN',
 (c:any)=>c.sweeps.value[0].eventAtMs=now+1,
 (c:any)=>delete c.sweeps.ttlMsByTf['15'],
 (c:any)=>c.quote.observedAtMs=now-20000,
 (c:any)=>c.spreadBaseline.clean=false,
 (c:any)=>c.velocity.baselineHourUtc=2,
 (c:any)=>c.velocity.availableAtMs=now+1,
 (c:any)=>c.momentum.profile='smc-impulse-pretending-radar',
]) { const c=context();mutate(c);assert.equal(regime.buildRegimeContext(c).status,'UNAVAILABLE'); }
const expired=context(); expired.sweeps.value[0].eventAtMs=now-60001;expired.sweeps.value[0].availableAtMs=now-60000;
const old=regime.extractRegimeFeatures(expired);assert.equal(old.status,'EXTRACTED');if(old.status==='EXTRACTED')assert.equal(old.features.recent_sweep_aligned,0);
const moving=context();let priceReads=0;
Object.defineProperty(moving.price,'value',{enumerable:true,get(){return ++priceReads<=3?1.1:-1;}});
const captured=regime.buildRegimeContext(moving);
assert.equal(captured.status,'AVAILABLE');
if(captured.status==='AVAILABLE')assert.ok(captured.context.price.value>0,'validate exactly the immutable snapshot returned, never a later read of mutable source');
assert.equal(Object.isFrozen(features.vector),true);
assert.equal(Object.isFrozen(features.features),true);
raw.score.value.points=20;assert.equal(features.features.smc_score_excess,-6);
console.log(JSON.stringify({test:'ml-regime-context',status:'PASS'}));
