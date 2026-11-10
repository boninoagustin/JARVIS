#!/usr/bin/env tsx
/** Bounded registered FUTURE-week SMC paper replay for disabled assets only.
 * Default: read-only preflight, no replay. --replay explicitly runs local SMC.
 * --output-dir PATH saves local evidence/invalidation artifacts (never Firestore).
 * --apply replaces paper_trades only, including explicit legacy invalidations.
 * Never execute --apply without operator authorization; it cannot enable assets.
 * Legacy 90-day retrospective paper documents are NOT forward evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {configFingerprint} from '../hyperopt/evaluation_protocol.js';
import {invalidation,isTrading,replayPaper,validateRegistration} from './paper_replay.js';

export async function main(argv=process.argv.slice(2)) {
  const apply=argv.includes('--apply');
  const value=(flag:string)=>{const i=argv.indexOf(flag);if(i<0)return undefined;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`${flag} requires a value`);return argv[i+1];};
  const only=value('--ticker')?.toUpperCase(), output=value('--output-dir');
  if (only && !/^[A-Z0-9]+$/.test(only)) throw new Error('invalid ticker');
  for(let i=0;i<argv.length;i++) {
    if(['--ticker','--output-dir'].includes(argv[i])){i++;continue;}
    if(!['--replay','--apply'].includes(argv[i])) throw new Error(`unknown argument: ${argv[i]}`);
  }
  const admin=(await import('firebase-admin')).default;
  if(!admin.apps.length)admin.initializeApp({credential:admin.credential.cert(JSON.parse(fs.readFileSync('/opt/JARVIS/firebase-key.json','utf8')))});
  const db=admin.firestore();
  const [roster,assets,registrations,legacy]=await Promise.all([
    db.doc('optimization_config/active_tickers').get(),db.collection('asset_configs').get(),
    db.collection('prospective_tests').get(),db.collection('paper_trades').get()]);
  const tickers=roster.data()?.tickers;
  if(!Array.isArray(tickers)||tickers.some(t=>typeof t!=='string'||!/^[A-Z0-9]+$/.test(t)))throw new Error('invalid active_tickers');
  const configs=new Map(assets.docs.map(d=>[d.id,d.data()]));
  const tests=new Map(registrations.docs.map(d=>[d.id,d]));
  // Include legacy documents outside today's roster so none remain implicitly trusted.
  const targets=[...new Set([...tickers,...legacy.docs.map(d=>d.id)])].filter(t=>!only||t===only);
  if(only&&!targets.length)throw new Error('ticker absent from roster and legacy evidence');
  let errors=0;
  for(const ticker of targets) {
    const now=Date.now();let evidence:any;
    try {
      if(!tickers.includes(ticker)) evidence=invalidation(ticker,'outside_optimization_roster',now);
      else if(!configs.has(ticker)) throw new Error('active_config_missing');
      else if(isTrading(configs.get(ticker))) evidence=invalidation(ticker,'active_asset_not_paper_replayed',now);
      else {
        const snapshot=tests.get(ticker);
        if(!snapshot)throw new Error('registered_prospective_candidate_missing');
        const registration=snapshot.data(),serverCreated=snapshot.createTime?.toMillis();
        if(typeof serverCreated!=='number'||!Number.isFinite(serverCreated))throw new Error('registration_server_creation_time_missing');
        const createdAtMs=Math.ceil(serverCreated); // Firestore may retain sub-millisecond precision
        validateRegistration(ticker,registration,createdAtMs,now);
        evidence=argv.includes('--replay')?await replayPaper({ticker,registration,createdAtMs,now,logsDir:`/opt/JARVIS/logs/${ticker.toLowerCase()}/history_exported`}):
          {...invalidation(ticker,'preflight_only_no_replay_performed',now),status:'PENDING',candidateFingerprint:registration!.candidate_fingerprint};
      }
    } catch(error) {errors++;evidence=invalidation(ticker,error instanceof Error?error.message:String(error),now);}
    const fingerprint=configFingerprint(evidence);
    if(output) {
      fs.mkdirSync(output,{recursive:true});
      const file=path.resolve(output,`paper_${ticker}_${fingerprint}.json`),bytes=JSON.stringify(evidence,null,2)+'\n';
      if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==bytes)throw new Error('local_evidence_collision');}
      else fs.writeFileSync(file,bytes,{flag:'wx'});
    }
    const document={...evidence,evidenceFingerprint:fingerprint};
    // Replace, never merge: a previous historical n/WR/paper_ready must not survive.
    // No asset_configs, prospective_tests, broker, or risk writes exist here.
    if(apply)await db.collection('paper_trades').doc(ticker).set(document,{merge:false});
    console.log(JSON.stringify(document));
  }
  if(errors)throw new Error(`${errors} per-asset paper error(s); legacy evidence invalid; apply=${apply}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error=>{console.error('ERROR:',error.message);process.exitCode=1;});
