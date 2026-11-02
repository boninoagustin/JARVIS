import type { AssetManagementProfile, DynamicBreakevenInput, DynamicBreakevenResult, ExecutionDirection, ExecutionPolicy, ExecutionPolicyInput, ExecutionPositionState, ExecutionQuote, ExecutionRegime, ExecutionTargetResult, MultiAssetTrailingInput, SmartRoutingDecision, SmartRoutingInput } from './ExecutionTypes.ts';
import { classifyExecutionRegime, validateExecutionInstrument, validateExecutionStop } from './ExecutionCosts.js';

const positive = (v:unknown):v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonnegative = (v:unknown):v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const sign = (direction:ExecutionDirection) => direction === 'BUY' ? 1 : -1;
const validDirection = (direction:ExecutionDirection) => direction === 'BUY' || direction === 'SELL';
const TF_MS:Readonly<Record<string,number>> = {'5':300000,'15':900000,'60':3600000,'240':14400000,D:86400000,W:604800000};

export function evaluateSmartEntryRouting(input:SmartRoutingInput):SmartRoutingDecision {
  const wait = (reason:string):SmartRoutingDecision => ({mode:'WAIT_DATA',takeDirectNow:false,requiresCloseConfirmation:false,reason});
  const i=input, d=sign(i.direction), b=i.breakBar;
  if (!validDirection(i.direction) || ![i.currentPrice,i.originPrice,i.extremePrice,i.riskDist,i.atr14].every(positive)
    || !nonnegative(i.nowMs) || !nonnegative(i.impulseCreatedAtMs) || i.impulseCreatedAtMs > i.nowMs
    || (i.adr !== undefined && !positive(i.adr)) || (i.plannedTp2Price !== undefined && !positive(i.plannedTp2Price))
    || (i.rewardToOppositeZone !== undefined && (typeof i.rewardToOppositeZone!=='number' || !Number.isFinite(i.rewardToOppositeZone)))) return wait('INVALID_GEOMETRY_OR_ATR');
  const legRange=d*(i.extremePrice-i.originPrice);
  if (!positive(legRange)) return wait('INVALID_DIRECTIONAL_IMPULSE');
  if (!b || b.closed !== true || !TF_MS[b.tf] || ![b.open,b.high,b.low,b.close].every(positive)
    || b.high <= b.low || b.high < Math.max(b.open,b.close) || b.low > Math.min(b.open,b.close)
    || !nonnegative(b.openTimeMs) || b.closeTimeMs-b.openTimeMs !== TF_MS[b.tf]
    || !Number.isFinite(b.availableAtMs) || b.availableAtMs < b.closeTimeMs || b.availableAtMs > i.nowMs) return wait('INVALID_OR_UNAVAILABLE_CLOSED_BREAK_BAR');
  // Impulse identity is event creation/observation, not the break candle's open.
  // Both must already be available; the caller enforces same-bar ATR/identity.
  const barRange=b.high-b.low, body=Math.abs(b.close-b.open)/barRange;
  const front=(i.direction==='BUY' ? b.high-b.close : b.close-b.low)/barRange;
  const riskAtr=i.riskDist/i.atr14!;
  const t=i.tickActivity;
  const measured=!!t && positive(t.ratio) && Number.isInteger(t.sampleCount) && t.sampleCount>=20 && t.source==='broker_ticks'
    && ['UP','DOWN','FLAT'].includes(t.direction) && nonnegative(t.timestampMs) && t.timestampMs<=i.nowMs && i.nowMs-t.timestampMs<=10000;
  const rooms:number[]=[];
  if (i.plannedTp2Price !== undefined) {
    const room=d*(i.plannedTp2Price-i.currentPrice);
    if (!positive(room)) return wait('UNFAVORABLE_PLANNED_TP2');
    rooms.push(room);
  }
  if (positive(i.rewardToOppositeZone)) rooms.push(i.rewardToOppositeZone);
  const rr=rooms.length ? Math.min(...rooms)/i.riskDist : 0;
  if (!Number.isFinite(riskAtr) || !Number.isFinite(barRange/i.atr14!) || !Number.isFinite(rr)) return wait('NONFINITE_ROUTING_RATIOS');
  const ote = (percent:number,reason:string,requiresCloseConfirmation=false,ce?:{price:number;id:string}):SmartRoutingDecision => {
    const price=ce?.price ?? i.extremePrice-d*legRange*percent/100;
    if (!positive(price) || price < Math.min(i.originPrice,i.extremePrice) || price > Math.max(i.originPrice,i.extremePrice)) return wait('INVALID_OTE_PRICE');
    return {mode:percent===79?'OTE_DEEP':percent===38.2?'OTE_SHALLOW':'OTE_STANDARD',takeDirectNow:false,requiresCloseConfirmation,reason,recommendedOtePercent:percent,recommendedOtePrice:price,effectiveOtePercent:d*(i.extremePrice-price)/legRange*100,...(ce?{anchorFvgId:ce.id}:{})};
  };
  if (barRange/i.atr14!>2.2 && front>=.30) return ote(79,'OVEREXTENDED_FRONT_REQUIRES_CLOSE',true);
  const c=i.correlation;
  const correlated=!!c && Number.isFinite(c.rho) && c.rho>=.70 && c.rho<=1 && c.activeCluster===true && nonnegative(c.asOfMs) && c.asOfMs<=i.nowMs;
  if (riskAtr>1.50 || correlated) return ote(riskAtr>1.85 || correlated?79:62,correlated?'MEASURED_ACTIVE_CORRELATION':'WIDE_RISK_ATR');
  if (measured && t!.ratio>1.65 && t!.direction===(i.direction==='BUY'?'DOWN':'UP')) return ote(79,'ADVERSE_REAL_TICK_ACTIVITY_REQUIRES_CLOSE',true);
  const clean=body>=.78 && front<=.12 && d*(b.close-b.open)>0;
  if (clean && riskAtr<=1.25 && rr>=1.5 && measured && t!.ratio>=.90 && t!.ratio<=1.65)
    return {mode:'DIRECT',takeDirectNow:true,requiresCloseConfirmation:false,reason:'CLEAN_DISPLACEMENT_GROSS_ROOM_REAL_TICKS'};
  if (clean && riskAtr>1.25 && riskAtr<=1.50) return ote(38.2,'CLEAN_DISPLACEMENT_MODERATE_RISK');
  const eligible=(Array.isArray(i.fvgs)?i.fvgs:[]).filter(f=>{
    if (!f || typeof f.id!=='string' || !f.id || f.active!==true || f.direction!==i.direction || f.tf!==b.tf || f.impulseCreatedAtMs!==i.impulseCreatedAtMs
      || ![f.top,f.bottom].every(positive) || f.top<=f.bottom || f.top>Math.max(i.originPrice,i.extremePrice) || f.bottom<Math.min(i.originPrice,i.extremePrice)
      || !nonnegative(f.createdAtMs) || !nonnegative(f.availableAtMs) || f.createdAtMs<i.impulseCreatedAtMs || f.availableAtMs<f.createdAtMs || f.availableAtMs>i.nowMs) return false;
    const pct=d*(i.extremePrice-(f.top+f.bottom)/2)/legRange;
    return pct>=.382 && pct<=.55;
  }).sort((a,b)=>a.availableAtMs-b.availableAtMs || a.createdAtMs-b.createdAtMs || a.id.localeCompare(b.id));
  if (eligible.length) {const f=eligible[0]; return ote(50,'ELIGIBLE_SAME_IMPULSE_CE',false,{price:(f.top+f.bottom)/2,id:f.id});}
  if (i.htfAligned===3) return ote(50,'THREE_HTF_ALIGNED');
  return ote(62,'STANDARD_FIB_NO_DIRECT_EVIDENCE');
}

function validQuote(q:ExecutionQuote,nowMs:number):boolean {
  return !!q && positive(q.bid) && positive(q.ask) && q.bid<=q.ask && (q.source==='broker'||q.source==='modeled')
    && nonnegative(nowMs) && nonnegative(q.timestampMs) && q.timestampMs<=nowMs && nowMs-q.timestampMs<=10000;
}
function validPosition(s:ExecutionPositionState,direction:ExecutionDirection,entry:number):boolean {
  if (!s || s.schema!==1 || s.profile!=='microstructure_v1' || !validDirection(direction) || !positive(entry)
    || !positive(s.initialSlPrice) || !positive(s.initialRiskDist) || !positive(s.lastConfirmedSlPrice)
    || !nonnegative(s.entryTimestampMs) || !nonnegative(s.lastObservationMs) || s.lastObservationMs<s.entryTimestampMs || !nonnegative(s.mfePriceDist)
    || typeof s.tp1Touched!=='boolean' || typeof s.partialConfirmed!=='boolean' || !['NONE','DEFENSIVE_MIDPOINT','NET_PROTECTION_ESTIMATE'].includes(s.stage)) return false;
  const risk=sign(direction)*(entry-s.initialSlPrice);
  return risk>0 && Math.abs(risk-s.initialRiskDist)<=Number.EPSILON*Math.max(entry,s.initialRiskDist)*4;
}

export function createExecutionPositionState(input:{direction:ExecutionDirection;entryPrice:number;initialSlPrice:number;entryTimestampMs:number}):ExecutionPositionState {
  const risk=sign(input.direction)*(input.entryPrice-input.initialSlPrice);
  if (!validDirection(input.direction) || !positive(input.entryPrice) || !positive(input.initialSlPrice) || !positive(risk) || !nonnegative(input.entryTimestampMs)) throw new Error('INVALID_INITIAL_EXECUTION_RISK');
  return {schema:1,profile:'microstructure_v1',initialSlPrice:input.initialSlPrice,initialRiskDist:risk,entryTimestampMs:input.entryTimestampMs,lastObservationMs:input.entryTimestampMs,mfePriceDist:0,tp1Touched:false,partialConfirmed:false,stage:'NONE',lastConfirmedSlPrice:input.initialSlPrice};
}

/** Confirmation flags come from the caller's readback, not inference from quotes. */
export function advanceExecutionPositionState(state:ExecutionPositionState,input:{direction:ExecutionDirection;entryPrice:number;quote:ExecutionQuote;nowMs:number;tp1Touched?:boolean;partialConfirmed?:boolean}):ExecutionPositionState {
  const next={...state};
  if (!validPosition(state,input.direction,input.entryPrice)) return next;
  next.tp1Touched=state.tp1Touched || input.tp1Touched===true;
  next.partialConfirmed=state.partialConfirmed || input.partialConfirmed===true;
  if (!validQuote(input.quote,input.nowMs) || input.quote.timestampMs<=state.entryTimestampMs || input.quote.timestampMs<=state.lastObservationMs) return next;
  const executable=input.direction==='BUY'?input.quote.bid:input.quote.ask;
  const distance=sign(input.direction)*(executable-input.entryPrice);
  if (!Number.isFinite(distance)) return next;
  next.mfePriceDist=Math.max(state.mfePriceDist,distance,0);
  next.lastObservationMs=input.quote.timestampMs;
  return next;
}

/** Pure proposals, never broker acknowledgements and never a net-profit guarantee. */
export function evaluateDynamicBreakeven(input:DynamicBreakevenInput):DynamicBreakevenResult {
  const i=input;
  let lockOffsetPrice=NaN, requiredTriggerDist=NaN;
  const none=(reason:string):DynamicBreakevenResult=>({shouldUpdateSl:false,newSlPrice:i.currentSlPrice,stage:'NONE',lockOffsetPrice,requiredTriggerDist,reason});
  if (i.rolloverBlocked) return none('ROLLOVER_BLOCKED');
  if (!validateExecutionInstrument(i.instrument) || i.ticker!==i.instrument.ticker || classifyExecutionRegime(i.ticker)!==i.instrument.regime) return none('UNKNOWN_OR_MISMATCHED_INSTRUMENT');
  if (!validPosition(i.state,i.direction,i.entryPrice) || i.state.lastObservationMs>i.nowMs || !validQuote(i.currentQuote,i.nowMs) || i.currentQuote.timestampMs<=i.state.entryTimestampMs) return none('INVALID_POSITION_OR_QUOTE');
  if (!i.state.tp1Touched || !i.state.partialConfirmed) return none('TP1_PARTIAL_NOT_CONFIRMED');
  if (!positive(i.atr14) || (i.adr!==undefined && !positive(i.adr))) return none('INVALID_OR_MISSING_ATR_ADR');
  if (!nonnegative(i.pendingCostPrice)) return none('UNKNOWN_PENDING_COSTS');
  const profile=REGIME_PROFILES[i.instrument.regime], risk=i.state.initialRiskDist;
  const spread=i.currentQuote.ask-i.currentQuote.bid, base=i.instrument.baseSpreadPips*i.instrument.pipSize;
  const epsilon=Number.EPSILON*Math.max(i.currentQuote.ask,i.entryPrice)*4;
  if ((base===0 && spread!==0) || spread-2.5*base>epsilon) return none('SPREAD_ABOVE_BASE_LIMIT');
  lockOffsetPrice=i.pendingCostPrice+.25*Math.max(spread-base,0)+Math.max(profile.beMinNetR*risk,i.adr===undefined?0:.008*i.adr);
  requiredTriggerDist=Math.max(profile.beTriggerR*risk,profile.beTriggerAtrMult*i.atr14,i.adr===undefined?0:profile.beTriggerAdrFrac*i.adr,3.5*lockOffsetPrice);
  if (!positive(lockOffsetPrice) || !positive(requiredTriggerDist)) return none('INVALID_PROTECTION_GEOMETRY');
  const net=i.state.mfePriceDist>=requiredTriggerDist;
  if (!net && i.state.stage==='NET_PROTECTION_ESTIMATE') return none('NO_STAGE_REGRESSION');
  const candidateSl=i.entryPrice+sign(i.direction)*(net?lockOffsetPrice:-.45*risk);
  const checked=validateExecutionStop({direction:i.direction,candidateSl,currentSl:i.currentSlPrice,quote:i.currentQuote,instrument:i.instrument,nowMs:i.nowMs});
  if (!checked.valid) return none(checked.reason);
  return {shouldUpdateSl:true,newSlPrice:checked.price,stage:net?'NET_PROTECTION_ESTIMATE':'DEFENSIVE_MIDPOINT',lockOffsetPrice,requiredTriggerDist,reason:net?'PENDING_COST_NET_PROTECTION_ESTIMATE':'CONFIRMED_PARTIAL_DEFENSIVE_MIDPOINT'};
}

export function computeMultiAssetTrailingSl(input:MultiAssetTrailingInput):number {
  const i=input, unchanged=i.currentSlPrice;
  if (i.rolloverBlocked || !validateExecutionInstrument(i.instrument) || i.ticker!==i.instrument.ticker
    || !validPosition(i.state,i.direction,i.entryPrice) || !i.state.tp1Touched || !i.state.partialConfirmed || i.state.stage!=='NET_PROTECTION_ESTIMATE'
    || !positive(i.atr14) || !positive(i.tp2Price) || !validQuote(i.currentQuote,i.nowMs) || i.state.lastObservationMs>i.nowMs || i.currentQuote.timestampMs<=i.state.entryTimestampMs) return unchanged;
  const d=sign(i.direction), tpDistance=d*(i.tp2Price-i.entryPrice);
  if (!positive(tpDistance)) return unchanged;
  const progress=i.state.mfePriceDist/tpDistance, p=REGIME_PROFILES[i.instrument.regime];
  if (!Number.isFinite(progress)) return unchanged;
  let candidateSl:number;
  if (p.trailMode==='STRUCTURAL_SWING') {
    const o=i.latestStructuralOrigin;
    if (!o || o.direction!==i.direction || !['5','15'].includes(o.tf) || !positive(o.price) || !nonnegative(o.eventAtMs) || !nonnegative(o.availableAtMs)
      || o.eventAtMs<=i.state.entryTimestampMs || o.availableAtMs<o.eventAtMs || o.availableAtMs>i.nowMs) return unchanged;
    candidateSl=o.price-d*.60*i.atr14;
  } else {
    const decay=Math.max(0,Math.min(1,(progress-.50)/.50));
    const mult=p.trailMode==='CHANDELIER_TIGHT'?(progress>=.70?p.tightTrailAtrMult:p.baseTrailAtrMult):p.baseTrailAtrMult+(p.tightTrailAtrMult-p.baseTrailAtrMult)*decay;
    const peak=i.entryPrice+d*i.state.mfePriceDist;
    candidateSl=peak-d*mult*i.atr14;
  }
  const checked=validateExecutionStop({direction:i.direction,candidateSl,currentSl:i.currentSlPrice,quote:i.currentQuote,instrument:i.instrument,nowMs:i.nowMs});
  const epsilon=Number.EPSILON*Math.max(i.entryPrice,Math.abs(checked.price))*4;
  if (!checked.valid || d*(checked.price-i.currentSlPrice)+epsilon<p.ratchetStepAtrMult*i.atr14) return unchanged;
  return checked.price;
}

export function computeExecutionTargets(input:{direction:ExecutionDirection;entryPrice:number;initialSlPrice:number;adr?:number;regime:ExecutionRegime;structuralTp1Price?:number;requestedTp2Price?:number}):ExecutionTargetResult {
  const i=input, p=REGIME_PROFILES[i.regime];
  const invalid=(reason:string):ExecutionTargetResult=>({valid:false,reason,tp1Price:NaN,tp2Price:NaN,partialClosePct:p?.partialClosePct ?? NaN});
  if (!p || !validDirection(i.direction) || !positive(i.entryPrice) || !positive(i.initialSlPrice) || (i.adr!==undefined && !positive(i.adr))
    || (i.structuralTp1Price!==undefined && !positive(i.structuralTp1Price)) || (i.requestedTp2Price!==undefined && !positive(i.requestedTp2Price))) return invalid('INVALID_TARGET_INPUT');
  const d=sign(i.direction), risk=d*(i.entryPrice-i.initialSlPrice);
  if (!positive(risk)) return invalid('INVALID_INITIAL_RISK');
  let tp1Dist=Math.min(p.tp1RR*risk,i.adr===undefined?Infinity:p.tp1MaxAdrFrac*i.adr);
  let tp2Dist=Math.min(p.tp2MaxRR*risk,i.adr===undefined?Infinity:p.tp2MaxAdrFrac*i.adr);
  if (i.structuralTp1Price!==undefined) {const structural=d*(i.structuralTp1Price-i.entryPrice); if (positive(structural)) tp1Dist=Math.min(tp1Dist,structural);}
  if (i.requestedTp2Price!==undefined) {const requested=d*(i.requestedTp2Price-i.entryPrice); if (!positive(requested)) return invalid('UNFAVORABLE_REQUESTED_TP2'); tp2Dist=Math.min(tp2Dist,requested);}
  const tp1Price=i.entryPrice+d*tp1Dist, tp2Price=i.entryPrice+d*tp2Dist;
  if (![tp1Dist,tp2Dist,tp1Price,tp2Price].every(positive) || !(tp1Dist<tp2Dist) || !(d*(tp1Price-i.entryPrice)>0) || !(d*(tp2Price-tp1Price)>0)) return invalid('TARGET_ORDER_NOT_PRESERVABLE');
  return {valid:true,reason:'PROFILE_RR_ADR_STRUCTURAL_TARGETS',tp1Price,tp2Price,partialClosePct:p.partialClosePct};
}

/** Research policy only: frozen independently of live configuration. */
export const REGIME_PROFILES: Readonly<Record<ExecutionRegime,AssetManagementProfile>> = Object.freeze({
  FOREX:Object.freeze({tp1RR:1,tp1MaxAdrFrac:.25,partialClosePct:.70,tp2MaxRR:1.5,tp2MaxAdrFrac:.45,beTriggerR:1.15,beTriggerAtrMult:1.20,beTriggerAdrFrac:.14,beMinNetR:.06,trailMode:'CHANDELIER_TIGHT',baseTrailAtrMult:1.25,tightTrailAtrMult:.90,ratchetStepAtrMult:.20}),
  METALS:Object.freeze({tp1RR:1.10,tp1MaxAdrFrac:.30,partialClosePct:.50,tp2MaxRR:2.40,tp2MaxAdrFrac:.60,beTriggerR:1.30,beTriggerAtrMult:1.60,beTriggerAdrFrac:.16,beMinNetR:.08,trailMode:'ADAPTIVE_DECAY',baseTrailAtrMult:2.10,tightTrailAtrMult:1.05,ratchetStepAtrMult:.30}),
  INDICES:Object.freeze({tp1RR:1.20,tp1MaxAdrFrac:.35,partialClosePct:.35,tp2MaxRR:3.50,tp2MaxAdrFrac:.85,beTriggerR:1.20,beTriggerAtrMult:1.35,beTriggerAdrFrac:.15,beMinNetR:.06,trailMode:'STRUCTURAL_SWING',baseTrailAtrMult:1.85,tightTrailAtrMult:1.15,ratchetStepAtrMult:.25}),
  ENERGY:Object.freeze({tp1RR:1.05,tp1MaxAdrFrac:.28,partialClosePct:.60,tp2MaxRR:1.80,tp2MaxAdrFrac:.50,beTriggerR:1.20,beTriggerAtrMult:1.40,beTriggerAdrFrac:.15,beMinNetR:.07,trailMode:'ADAPTIVE_DECAY',baseTrailAtrMult:1.75,tightTrailAtrMult:1,ratchetStepAtrMult:.25}),
  CRYPTO:Object.freeze({tp1RR:1.15,tp1MaxAdrFrac:.32,partialClosePct:.50,tp2MaxRR:2.50,tp2MaxAdrFrac:.65,beTriggerR:1.25,beTriggerAtrMult:1.50,beTriggerAdrFrac:.15,beMinNetR:.08,trailMode:'ADAPTIVE_DECAY',baseTrailAtrMult:2,tightTrailAtrMult:1.10,ratchetStepAtrMult:.25}),
});

export function resolveExecutionPolicy(input?: ExecutionPolicyInput): ExecutionPolicy {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('INVALID_EXECUTION_POLICY');
  const profile = input?.profile === undefined ? 'legacy_v1' : input.profile;
  if (profile !== 'legacy_v1' && profile !== 'microstructure_v1') throw new Error('INVALID_EXECUTION_PROFILE');
  for (const flag of ['smart','management','trailing','targets'] as const) if (input?.[flag] !== undefined && typeof input[flag] !== 'boolean') throw new Error(`INVALID_EXECUTION_FLAG:${flag}`);
  const active = profile === 'microstructure_v1';
  return {profile,smart:active && (input?.smart ?? true),management:active && (input?.management ?? true),trailing:active && (input?.trailing ?? true),targets:active && (input?.targets ?? true)};
}
