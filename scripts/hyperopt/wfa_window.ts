/** WFA authorization: selection/outer windows are explicit; Vault has no evaluator. */
import {configFingerprint,stableCanonical} from './evaluation_protocol.js';
const D=86400000,H=3600000;
const TF=['5','15','60','240','D'];
const POLICY=['is_days','oos_days','step_days','history_days','warmup_days','gap_hours','embargo_hours','inner_validation_days','min_context_observations'];
const FIELDS=['id','is_start_ms','is_end_ms','inner_train_end_ms','inner_validation_start_ms','oos_start_ms','oos_end_ms','fit_asof_ms','context_policy'];
function exact(value:any,keys:string[],name:string){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new Error(`invalid ${name} fields`);
}
function ms(value:any,name:string){if(!Number.isSafeInteger(value)||value<0)throw new Error(`invalid ${name} milliseconds`);return value;}
function duration(value:any,unit:number,name:string,zero=false){
 if(typeof value!=='number'||!Number.isFinite(value)||(zero?value<0:value<=0)||!Number.isSafeInteger(value*unit))throw new Error(`invalid ${name} duration`);
 return value*unit;
}
function makeFold(policy:any,oosStart:number,oosEnd:number,id:number):any{
 const ie=oosStart-policy.gap_hours*H,vs=ie-policy.inner_validation_days*D;
 return {id,is_start_ms:ie-policy.is_days*D,is_end_ms:ie,
  inner_train_end_ms:vs-policy.embargo_hours*H,inner_validation_start_ms:vs,
  oos_start_ms:oosStart,oos_end_ms:oosEnd,fit_asof_ms:ie,context_policy:'context-only-reset-execution-v1'};
}
export function validateWfaPlan(input:any,ticker:string):any{
 stableCanonical(input);
 exact(input,['version','kind','ticker','clock','coverage','policy','folds','vault','apply_eligible','fingerprint'],'WFA plan');
 if(input.version!==2||input.kind!=='rolling_wfa_shadow'||input.clock!=='M5'||input.ticker!==ticker||input.apply_eligible!==false)throw new Error('invalid WFA plan identity/role');
 const {fingerprint,...unsigned}=input;
 if(fingerprint!==configFingerprint(unsigned))throw new Error('WFA plan fingerprint mismatch');
 exact(input.coverage,['m5_start_ms','m5_end_ms'],'M5 coverage');
 const start=ms(input.coverage.m5_start_ms,'M5 start'),end=ms(input.coverage.m5_end_ms,'M5 end');
 if(start>=end)throw new Error('empty M5 horizon');
 const p=input.policy;exact(p,POLICY,'WFA policy');
 for(const k of ['is_days','oos_days','step_days','history_days','inner_validation_days'])duration(p[k],D,k);
 duration(p.warmup_days,D,'warmup_days',true);
 duration(p.gap_hours,H,'gap_hours',true);duration(p.embargo_hours,H,'embargo_hours');
 exact(p.min_context_observations,TF,'context observations');
 for(const tf of TF)if(!Number.isSafeInteger(p.min_context_observations[tf])||p.min_context_observations[tf]<1)throw new Error('invalid context observation minimum');
 if(p.step_days<p.oos_days||p.is_days*D<=p.inner_validation_days*D+p.embargo_hours*H)throw new Error('overlapping OOS or empty inner training');
 exact(input.vault,['from_ms','to_ms','independence','access'],'Vault');
 const v=input.vault;
 if(v.access!=='blocked'||v.independence!=='unverified'||v.to_ms!==end||v.from_ms!==end-p.oos_days*D)throw new Error('Vault must remain blocked/unverified at M5 end');
 const lower=Math.max(start,end-p.history_days*D);
 const expected:any[]=[];
 for(let oe=v.from_ms;oe-p.oos_days*D-p.gap_hours*H-p.is_days*D>=lower;oe-=p.step_days*D){
  expected.unshift(makeFold(p,oe-p.oos_days*D,oe,0));
  if(expected.length>10000)throw new Error('WFA fold budget exceeded');
 }
 if(!expected.length||!Array.isArray(input.folds)||input.folds.length!==expected.length)throw new Error('WFA fold coverage incomplete');
 expected.forEach((f,i)=>{
  f.id=i+1;exact(input.folds[i],FIELDS,'fold');
  if(configFingerprint(f)!==configFingerprint(input.folds[i]))throw new Error('invalid WFA fold window');
  for(const k of FIELDS.filter(k=>k.endsWith('_ms')))ms(f[k],k);
 });
 return JSON.parse(JSON.stringify(input));
}
export function foldWindow(plan:any,foldId:number,role:string):{from_ms:number;to_ms:number;fold:any}{
 if(!Number.isSafeInteger(foldId)||foldId<0)throw new Error('invalid fold ID');
 if(!['inner_train','inner_validation','is','outer_oos'].includes(role))throw new Error('invalid WFA role');
 if(foldId===0&&role==='outer_oos')throw new Error('Vault evaluation is blocked');
 const fold=foldId===0?makeFold(plan.policy,plan.vault.from_ms,plan.vault.to_ms,0):plan.folds.find((f:any)=>f.id===foldId);
 if(!fold)throw new Error('unknown WFA fold');
 const bounds:any={inner_train:[fold.is_start_ms,fold.inner_train_end_ms],inner_validation:[fold.inner_validation_start_ms,fold.is_end_ms],
  is:[fold.is_start_ms,fold.is_end_ms],outer_oos:[fold.oos_start_ms,fold.oos_end_ms]};
 const [from,to]=bounds[role];
 if(from>=to||to>plan.vault.from_ms||from<plan.coverage.m5_start_ms)throw new Error('window outside authorized history / Vault blocked');
 return {from_ms:from,to_ms:to,fold};
}
export function m5Coverage(entries:any[]):any{
 const observed=entries.filter(e=>e.parsed?.eventTf==='5'&&Number.isSafeInteger(e.ts));
 if(!observed.length)return null;
 const prices=[...new Set(observed.filter(e=>e.parsed?.prefix==='PING_PRICE').map(e=>e.ts))].sort((a,b)=>a-b);
 if(!prices.length)return null;
 let maxGap=0;
 for(let i=1;i<prices.length;i++)maxGap=Math.max(maxGap,prices[i]-prices[i-1]);
 return {from_ms:prices[0],to_ms:prices[prices.length-1]+1,event_count:observed.length,
  price_observations:prices.length,max_observed_price_gap_ms:maxGap,coverage_status:'observed_event_range_not_exchange_calendar_certification'};
}
