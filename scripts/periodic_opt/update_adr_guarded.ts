/** Keep shared engine calibration fixed while any deployed version awaits review.
 * This is deployment orchestration only, not an evaluated strategy input.
 */
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function adrUpdateDecision(state:any,openTrades=0):{ok:boolean;reason:string} {
 if(openTrades>0)return {ok:false,reason:'ADR conservado: hay operaciones abiertas'};
 const waiting=Object.values<any>({...state?.applied,...state?.reviews}).some(entry=>entry?.policy_version===2 &&
  (entry.confirmation_pending===true || !['KEEP','ROLLBACK'].includes(entry.followup?.status)));
 if(waiting)return {ok:false,reason:'ADR conservado: seguimiento de versiones anteriores pendiente; no se cambia su motor'};
 return {ok:true,reason:'sin revisiones pendientes'};
}
export async function main(argv=process.argv.slice(2)) {
 const {default:admin}=await import('firebase-admin');
 const fs=await import('node:fs');
 if(!admin.apps.length)admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/service-account.json','utf8')))});
 try {
  const db=admin.firestore();
  const [snapshot,trades]=await Promise.all([db.doc('optimization_config/auto_state').get(),db.collection('active_trades').limit(1).get()]);
  const decision=adrUpdateDecision(snapshot.data()??{},trades.empty?0:1);
  console.log(JSON.stringify({kind:'weekly_adr_update',...decision,dry_run:argv.includes('--dry-run')}));
  if(!decision.ok||argv.includes('--dry-run'))return;
  const {spawnSync}=await import('node:child_process');
  const p=spawnSync('/opt/JARVIS/node_modules/.bin/tsx',['/opt/JARVIS/scripts/update_adr_table.ts'],{cwd:'/opt/JARVIS',stdio:'inherit',timeout:180000});
  if(p.error)throw p.error;
  if(p.status!==0)throw new Error(`ADR updater exit ${p.status}`);
 }finally{await admin.app().delete();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e);process.exitCode=1;});
