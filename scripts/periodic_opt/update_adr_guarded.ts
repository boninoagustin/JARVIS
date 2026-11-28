/** Keep shared engine calibration fixed while any deployed version awaits review.
 * This is deployment orchestration only, not an evaluated strategy input.
 */
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function adrUpdateDecision(state:any,openTrades=0,cyclePlanAction='new'):{ok:boolean;reason:string} {
 if(cyclePlanAction!=='new' && cyclePlanAction!=='skip')return {ok:false,reason:`ADR conservado: ciclo semanal en curso o pendiente (${cyclePlanAction})`};
 if(openTrades>0)return {ok:false,reason:'ADR conservado: hay operaciones abiertas'};
 const waiting=Object.values<any>({...state?.applied,...state?.reviews}).some(entry=>entry?.policy_version===2 &&
  (entry.confirmation_pending===true || !['KEEP','ROLLBACK'].includes(entry.followup?.status)));
 if(waiting)return {ok:false,reason:'ADR conservado: seguimiento de versiones anteriores pendiente; no se cambia su motor'};
 return {ok:true,reason:'sin revisiones pendientes'};
}
export async function main(argv=process.argv.slice(2)) {
 const {default:admin}=await import('firebase-admin');
 const fs=await import('node:fs');
 const {spawnSync}=await import('node:child_process');
 if(!admin.apps.length)admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json','utf8')))});
 try {
  let planAction='new';
  const planRes=spawnSync('python3',['/opt/JARVIS/scripts/periodic_opt/weekly_cycle_state.py','plan',
   '--state-dir',process.env.MARK_DIR||'/var/lib/jarvis'],{encoding:'utf8',timeout:15000});
  if(planRes.status!==0)planAction='invalid_cycle_state';
  else {try{planAction=JSON.parse(planRes.stdout)?.action||'invalid_cycle_state';}catch{planAction='invalid_cycle_state';}}
  const db=admin.firestore();
  const [snapshot,trades]=await Promise.all([db.doc('optimization_config/auto_state').get(),db.collection('active_trades').limit(1).get()]);
  const decision=adrUpdateDecision(snapshot.data()??{},trades.empty?0:1,planAction);
  console.log(JSON.stringify({kind:'weekly_adr_update',...decision,dry_run:argv.includes('--dry-run')}));
  if(!decision.ok||argv.includes('--dry-run'))return;
  const p=spawnSync('/opt/JARVIS/node_modules/.bin/tsx',['/opt/JARVIS/scripts/update_adr_table.ts'],{cwd:'/opt/JARVIS',stdio:'inherit',timeout:180000});
  if(p.error)throw p.error;
  if(p.status!==0)throw new Error(`ADR updater exit ${p.status}`);
 }finally{await admin.app().delete();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e);process.exitCode=1;});
