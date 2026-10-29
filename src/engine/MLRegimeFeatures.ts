import { validateModel, predictNativeVector, NATIVE_INFERENCE_PROFILE, type ValidatedModel } from './MLModelValidation.js';

/** Experimental causal regime14. Pure, opt-in; never feeds the legacy12 registry. */
export const REGIME_FEATURE_SCHEMA = 'jarvis/regime14/causal/v1' as const;
export const REGIME_FEATURE_NAMES = Object.freeze(['dir_z_momentum','vwap_regime_aligned','atr_to_adr_ratio','adr_exhaustion_dir','adr_room_to_tp1','htf_bias_confluence','time_sin','time_cos','session_killzone_quality','recent_sweep_aligned','smc_score_excess','zone_confluence_density','spread_to_normal_ratio','tick_velocity_z'] as const);
export const REGIME_VELOCITY_PROFILE = 'tickflow/interarrival-ewma-z/utc-hour/v1' as const;
export type RegimeDirection = 'BUY' | 'SELL';
export type MomentumProfile = 'radar-z-difference/v1' | 'smc-directional-impulse/v1';
export interface AsOfObservation<T> {
  readonly value: T;
  readonly observedAtMs: number;
  readonly availableAtMs: number;
  readonly maxAgeMs: number;
  /** A real source identifier; absent/unknown provenance is not an observed zero. */
  readonly provenance: string;
}
export type RegimeMomentum =
  | (AsOfObservation<{readonly zUp:number; readonly zDn:number}> & {readonly profile:'radar-z-difference/v1'})
  | (AsOfObservation<{readonly signedZ:number}> & {readonly profile:'smc-directional-impulse/v1'});
export interface RegimeContext {
  readonly schema: typeof REGIME_FEATURE_SCHEMA;
  readonly ticker: string;
  readonly tf: string;
  readonly direction: RegimeDirection;
  readonly nowMs: number;
  readonly momentum: RegimeMomentum;
  readonly atr: AsOfObservation<number> & {readonly tf:string; readonly units:'price'};
  readonly adr: AsOfObservation<number> & {readonly units:'price'; readonly calendarId:string; readonly closedDayEndMs:readonly number[]; readonly lookbackDays:number};
  readonly day: AsOfObservation<{readonly high:number;readonly low:number}> & {readonly calendarId:string;readonly dayStartMs:number;readonly dayEndMs:number};
  readonly price: AsOfObservation<number>;
  readonly entry: AsOfObservation<{readonly entryPrice:number;readonly initialSL:number}> & {readonly source:'signal-initial-stop'|'broker-initial-stop'};
  readonly vwap: AsOfObservation<'UNDER'|'OVER'|'AT'> & {readonly tf:'15'|'5'};
  readonly biases: Readonly<Record<'D'|'240'|'60'|'15',AsOfObservation<'BUY'|'SELL'|'NEUTRAL'>>>;
  readonly score: AsOfObservation<{readonly points:number;readonly minRequired:number}>;
  readonly sweeps: AsOfObservation<readonly {readonly direction:RegimeDirection;readonly tf:string;readonly eventAtMs:number;readonly availableAtMs:number}[]> & {readonly ttlMsByTf:Readonly<Record<string,number>>;readonly coverageStartMs:number};
  /** Full observed active-zone set; density v1 counts all directions, no invented proximity rule. */
  readonly zones: AsOfObservation<readonly {readonly direction:RegimeDirection}[]>;
  readonly quote: AsOfObservation<{readonly bid:number;readonly ask:number}> & {readonly units:'price'};
  readonly spreadBaseline: AsOfObservation<number> & {readonly units:'price';readonly clean:true;readonly samples:number};
  /** Observed profile baseline: samples is the real current-UTC-hour interval count;
   * baselineVarianceMs2 is its population inter-arrival variance in ms^2 (m2/n).
   * Both come from TickFlow evidence; absence must never be filled with defaults. */
  readonly velocity: AsOfObservation<{readonly zScore:number}> & {readonly baselineHourUtc:number;readonly samples:number;readonly baselineVarianceMs2:number;readonly profile:typeof REGIME_VELOCITY_PROFILE};
}
/** Partial is deliberate: absent historical observations must surface as UNAVAILABLE. */
export type RegimeContextInput = Pick<RegimeContext,'ticker'|'tf'|'direction'|'nowMs'> & Partial<Omit<RegimeContext,'ticker'|'tf'|'direction'|'nowMs'>>;
export interface RegimeUnavailable { readonly status:'UNAVAILABLE'; readonly schema:typeof REGIME_FEATURE_SCHEMA; readonly reasons:readonly string[] }
export type RegimeContextResult = {readonly status:'AVAILABLE';readonly context:RegimeContext} | RegimeUnavailable;
export type RegimeFeatures = Readonly<Record<typeof REGIME_FEATURE_NAMES[number],number>>;
export type RegimeExtraction = RegimeUnavailable | {
  readonly status:'EXTRACTED'; readonly schema:typeof REGIME_FEATURE_SCHEMA; readonly ticker:string;
  readonly nowMs:number; readonly momentumProfile:MomentumProfile; readonly calendarId:string;
  readonly features:RegimeFeatures; readonly vector:readonly number[];
};
const NY_TIME_FMT = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const finite = (v:unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const timestamp = (v:unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const positive = (v:unknown): v is number => finite(v) && v > 0;
const direction = (v:unknown): v is RegimeDirection => v === 'BUY' || v === 'SELL';
const label = (v:unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !/^(unknown|unavailable|missing)$/i.test(v.trim());
function ensure(ok:unknown, key:string): asserts ok { if (!ok) throw new Error(key); }
function deepFreeze<T>(value:T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
export function regimeUnavailable(reason:string): RegimeUnavailable {
  return Object.freeze({status:'UNAVAILABLE',schema:REGIME_FEATURE_SCHEMA,reasons:Object.freeze([reason])});
}
/** Validate an immutable, decision-time snapshot. There is no Radar/default/ATR*4 fallback. */
export function buildRegimeContext(input:RegimeContextInput): RegimeContextResult {
  try {
    const c:any = JSON.parse(JSON.stringify(input));
    ensure(c && c.schema === REGIME_FEATURE_SCHEMA,'schema');
    ensure(label(c.ticker) && /^[A-Z0-9._-]+$/.test(c.ticker) && label(c.tf) && direction(c.direction) && timestamp(c.nowMs),'identity/decision-time');
    const observe = (o:any,key:string) => {
      ensure(o && timestamp(o.observedAtMs) && timestamp(o.availableAtMs) && o.observedAtMs <= o.availableAtMs && o.availableAtMs <= c.nowMs && positive(o.maxAgeMs) && c.nowMs-o.observedAtMs <= o.maxAgeMs && label(o.provenance), `${key}:missing/stale/future/provenance`);
    };
    for (const key of ['momentum','atr','adr','day','price','entry','vwap','score','sweeps','zones','quote','spreadBaseline','velocity']) observe(c[key],key);
    ensure((c.momentum.profile === 'radar-z-difference/v1' && finite(c.momentum.value?.zUp) && finite(c.momentum.value?.zDn)) || (c.momentum.profile === 'smc-directional-impulse/v1' && finite(c.momentum.value?.signedZ)), 'momentum:profile/value');
    ensure(c.atr.tf === c.tf && c.atr.units === 'price' && positive(c.atr.value),'atr:tf/units/value');
    ensure(label(c.day.calendarId) && timestamp(c.day.dayStartMs) && timestamp(c.day.dayEndMs) && c.day.dayStartMs <= c.nowMs && c.nowMs < c.day.dayEndMs && c.day.observedAtMs >= c.day.dayStartMs,'day:calendar/bounds');
    ensure(positive(c.day.value?.low) && finite(c.day.value?.high) && c.day.value.high >= c.day.value.low,'day:extrema');
    ensure(c.adr.units === 'price' && positive(c.adr.value) && c.adr.calendarId === c.day.calendarId && Number.isSafeInteger(c.adr.lookbackDays) && c.adr.lookbackDays > 0 && Array.isArray(c.adr.closedDayEndMs) && c.adr.closedDayEndMs.length === c.adr.lookbackDays && new Set(c.adr.closedDayEndMs).size === c.adr.lookbackDays && c.adr.closedDayEndMs.every((t:any) => timestamp(t) && t <= c.day.dayStartMs && t <= c.adr.observedAtMs),'adr:prior-closed-days/units/calendar');
    ensure(positive(c.price.value) && c.price.observedAtMs >= c.day.dayStartMs && c.price.value >= c.day.value.low && c.price.value <= c.day.value.high,'price:today/range');
    const entry = c.entry.value;
    ensure(['signal-initial-stop','broker-initial-stop'].includes(c.entry.source) && positive(entry?.entryPrice) && positive(entry?.initialSL) && (c.direction === 'BUY' ? entry.initialSL < entry.entryPrice : entry.initialSL > entry.entryPrice),'entry:initial-risk');
    ensure(['15','5'].includes(c.vwap.tf) && ['UNDER','OVER','AT'].includes(c.vwap.value),'vwap:tf/value');
    for (const tf of ['D','240','60','15']) { observe(c.biases?.[tf],`bias:${tf}`); ensure(['BUY','SELL','NEUTRAL'].includes(c.biases[tf].value),`bias:${tf}:value`); }
    ensure(finite(c.score.value?.points) && finite(c.score.value?.minRequired),'score:effective-minimum');
    ensure(c.sweeps.ttlMsByTf && Object.keys(c.sweeps.ttlMsByTf).length > 0 && Object.values(c.sweeps.ttlMsByTf).every(positive),'sweeps:ttl-policy');
    ensure(timestamp(c.sweeps.coverageStartMs) && c.sweeps.coverageStartMs <= c.nowMs-Math.max(...Object.values(c.sweeps.ttlMsByTf) as number[]) && Array.isArray(c.sweeps.value),'sweeps:coverage');
    for (const s of c.sweeps.value) ensure(direction(s.direction) && positive(c.sweeps.ttlMsByTf[s.tf]) && timestamp(s.eventAtMs) && timestamp(s.availableAtMs) && s.eventAtMs <= s.availableAtMs && s.availableAtMs <= c.nowMs && s.eventAtMs <= c.sweeps.observedAtMs && s.availableAtMs <= c.sweeps.availableAtMs,'sweeps:future/ttl/identity');
    ensure(Array.isArray(c.zones.value) && c.zones.value.every((z:any) => direction(z.direction)),'zones:observed-set');
    ensure(c.quote.units === 'price' && positive(c.quote.value?.bid) && finite(c.quote.value?.ask) && c.quote.value.ask >= c.quote.value.bid && c.nowMs-c.quote.observedAtMs <= 10000,'quote:executable/fresh');
    ensure(c.spreadBaseline.units === 'price' && c.spreadBaseline.clean === true && positive(c.spreadBaseline.value) && Number.isSafeInteger(c.spreadBaseline.samples) && c.spreadBaseline.samples >= 100,'spread-baseline:clean/coverage');
    ensure(c.velocity.profile === REGIME_VELOCITY_PROFILE && finite(c.velocity.value?.zScore) && c.velocity.baselineHourUtc === new Date(c.nowMs).getUTCHours() && c.nowMs-c.velocity.observedAtMs <= 10000,'velocity:profile/asof-hour/fresh');
    ensure(Number.isSafeInteger(c.velocity.samples) && c.velocity.samples > 50 && positive(c.velocity.baselineVarianceMs2),'velocity:coverage/variance-ms2');
    return Object.freeze({status:'AVAILABLE',context:deepFreeze(c) as RegimeContext});
  } catch (e:any) { return regimeUnavailable(e?.message || 'invalid-context'); }
}
/** Schema-v1 formulas retain literal directional ADR remainder (not total daily-range remainder). */
export function extractRegimeFeatures(input:RegimeContextInput): RegimeExtraction {
  const built = buildRegimeContext(input); if (built.status === 'UNAVAILABLE') return built;
  const c = built.context, buy = c.direction === 'BUY', sign = buy ? 1 : -1;
  const momentum = c.momentum.profile === 'radar-z-difference/v1' ? c.momentum.value.zUp-c.momentum.value.zDn : c.momentum.value.signedZ;
  const adr = c.adr.value, risk = Math.abs(c.entry.value.entryPrice-c.entry.value.initialSL);
  const consumed = buy ? Math.max(0,c.price.value-c.day.value.low) : Math.max(0,c.day.value.high-c.price.value);
  const exhaustion = Math.min(1.5,consumed/adr);
  const b = (tf:'D'|'240'|'60'|'15') => c.biases[tf].value === 'NEUTRAL' ? 0 : c.biases[tf].value === c.direction ? 1 : -1;
  const parts = NY_TIME_FMT.formatToParts(c.nowMs);
  const minute = Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);
  const angle = 2*Math.PI*minute/1440;
  const quality = minute>=480 && minute<=690 ? 1 : ((minute>=180 && minute<480)||(minute>690 && minute<=810)) ? .85 : minute>=1140 || minute<120 ? .45 : .15;
  let ownSweep = false, oppositeSweep = false, ownZones = 0, oppositeZones = 0;
  for (const s of c.sweeps.value) if (c.nowMs-s.eventAtMs < c.sweeps.ttlMsByTf[s.tf]) { if(s.direction===c.direction) ownSweep=true; else oppositeSweep=true; }
  for (const z of c.zones.value) { if(z.direction===c.direction) ownZones++; else oppositeZones++; }
  const features:RegimeFeatures = Object.freeze({
    dir_z_momentum:sign*momentum,
    vwap_regime_aligned:c.vwap.value==='AT' ? 0 : (c.vwap.value==='UNDER' ? sign : -sign),
    atr_to_adr_ratio:Math.min(1,c.atr.value/adr),
    adr_exhaustion_dir:exhaustion,
    adr_room_to_tp1:Math.min(5,Math.max(0,adr*(1-exhaustion))/risk),
    htf_bias_confluence:(4*b('D')+2.5*b('240')+1.5*b('60')+b('15'))/9,
    time_sin:Math.sin(angle),time_cos:Math.cos(angle),session_killzone_quality:quality,
    recent_sweep_aligned:ownSweep ? 1 : oppositeSweep ? -1 : 0,
    smc_score_excess:Math.max(-10,Math.min(20,c.score.value.points-c.score.value.minRequired)),
    zone_confluence_density:Math.max(-10,Math.min(10,ownZones-oppositeZones)),
    spread_to_normal_ratio:Math.min(5,(c.quote.value.ask-c.quote.value.bid)/c.spreadBaseline.value),
    tick_velocity_z:Math.max(-3,Math.min(3,c.velocity.value.zScore)),
  });
  const vector = Object.freeze(REGIME_FEATURE_NAMES.map(name=>features[name]));
  if (!vector.every(v=>finite(v) && Number.isFinite(Math.fround(v)))) return regimeUnavailable('nonfinite/float32-overflow-derived-feature');
  return Object.freeze({status:'EXTRACTED',schema:REGIME_FEATURE_SCHEMA,ticker:c.ticker,nowMs:c.nowMs,momentumProfile:c.momentum.profile,calendarId:c.day.calendarId,features,vector});
}

export type RegimePrediction = RegimeUnavailable | {
  readonly status:'PREDICTED'; readonly schema:typeof REGIME_FEATURE_SCHEMA;
  readonly inferenceProfile:typeof NATIVE_INFERENCE_PROFILE; readonly artifactId:string;
  readonly nowMs:number; readonly probability:number; readonly approved:boolean;
  readonly threshold:number; readonly features:RegimeFeatures; readonly vector:readonly number[];
};
const regimeModels = new Map<string,ValidatedModel>();
/** Explicit memory-only candidate registration. Never scans disk or promotes/activates an artifact. */
export function loadRegimeModelFromJSON(json:string|object,ticker:string):boolean {
  try {
    ensure(typeof ticker === 'string' && /^[A-Z0-9._-]+$/.test(ticker),'ticker');
    const model = validateModel(json,REGIME_FEATURE_NAMES,NATIVE_INFERENCE_PROFILE);
    const m = model.meta;
    ensure(m.feature_schema === REGIME_FEATURE_SCHEMA && m.n_features === 14 && m.ticker === ticker,'schema/dimension/ticker');
    ensure(m.artifact_status === 'candidate' && label(m.artifact_id),'declared-candidate-identity');
    ensure(m.context_profile && ['radar-z-difference/v1','smc-directional-impulse/v1'].includes(m.context_profile.momentum_profile) && label(m.context_profile.calendar_id) && m.context_profile.velocity_profile === REGIME_VELOCITY_PROFILE,'context-profile');
    const p = m.provenance;
    ensure(p && p.source === 'observed-asof' && typeof p.dataset_sha256 === 'string' && /^[a-f0-9]{64}$/.test(p.dataset_sha256) && timestamp(p.train_end_ms) && timestamp(p.available_at_ms) && p.train_end_ms <= p.available_at_ms,'observed-asof-provenance');
    regimeModels.set(ticker,deepFreeze(model));
    return true;
  } catch { return false; }
}
/** Shadow consumer must call this explicitly. UNAVAILABLE has no probability/approval substitute. */
export function predictRegime(input:RegimeContextInput):RegimePrediction {
  const extracted = extractRegimeFeatures(input);
  if (extracted.status === 'UNAVAILABLE') return extracted;
  const model = regimeModels.get(extracted.ticker);
  if (!model) return regimeUnavailable('no-regime14-model');
  const meta = model.meta;
  if (extracted.nowMs < meta.provenance.available_at_ms || extracted.nowMs <= meta.provenance.train_end_ms) return regimeUnavailable('model-not-available-asof');
  if (extracted.momentumProfile !== meta.context_profile.momentum_profile || extracted.calendarId !== meta.context_profile.calendar_id) return regimeUnavailable('context-profile-mismatch');
  const probability = predictNativeVector(model,extracted.vector);
  return Object.freeze({status:'PREDICTED',schema:REGIME_FEATURE_SCHEMA,inferenceProfile:NATIVE_INFERENCE_PROFILE,artifactId:meta.artifact_id,nowMs:extracted.nowMs,probability,approved:probability>=meta.threshold,threshold:meta.threshold,features:extracted.features,vector:extracted.vector});
}
