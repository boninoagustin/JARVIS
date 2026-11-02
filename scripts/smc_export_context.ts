import fs from 'node:fs';
import path from 'node:path';
import type {SMCPreset} from '../src/engine/smc/types.js';

export interface SmcExportArgs {
 ticker:string;inputDir:string;outputDir:string;isolated:boolean;quiet:boolean;
 profile?:'legacy_v1'|'directional_atr_v1';timeframes?:string[];executionContext?:boolean;
 presetFile?:string;ablationFile?:string;signalOptionsFile?:string;manifestPath?:string;
 rolloverPolicyFile?:string;rolloverSchedulesFile?:string;mlRegimeShadow?:boolean;
}
const PROFILES=['legacy_v1','directional_atr_v1'];
function realDestination(value:string):string {
 let existing=path.resolve(value);const suffix:string[]=[];
 while(true){
  try{fs.lstatSync(existing);break;}catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   const parent=path.dirname(existing);if(parent===existing)throw error;
   suffix.unshift(path.basename(existing));existing=parent;
  }
 }
 return path.join(fs.realpathSync(existing),...suffix);
}
export function assertFrozenInputIsolation(inputDir:string,destinationPath:string):void {
 const raw=fs.realpathSync(inputDir),target=realDestination(destinationPath);
 const relative=path.relative(raw,target);
 if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))
  throw new Error('Research output must not mutate frozen raw input directory');
}
export function assertResearchDestination(value:string,repo:string):void {
 const target=realDestination(value),root=fs.realpathSync(repo);
 const relative=path.relative(root,target);
 if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))
  throw new Error('Research output must stay outside the repository and active CSVs');
}
export function parseSmcExportArgs(argv:string[],repo=process.cwd()):SmcExportArgs {
 const ticker=(argv[0]??'EURUSD').toUpperCase();
 if(!/^[A-Z0-9_.-]+$/.test(ticker)||ticker==='.'||ticker==='..')throw new Error('Invalid ticker');
 const flags:Record<string,string>={};let quiet=false,executionContext=false,mlRegimeShadow=false;
 const known=['--rollover-schedules-file','--rollover-policy-file','--input-dir','--output-dir','--profile','--timeframes','--preset-file','--ablation-file','--signal-options-file','--manifest-out'];
 for(let i=1;i<argv.length;i++){
  const arg=argv[i];if(arg==='--quiet'){quiet=true;continue;}
  if(arg==='--ml-regime-shadow'){if(mlRegimeShadow)throw new Error('Duplicate ml-regime-shadow flag');mlRegimeShadow=true;continue;}
  if(arg==='--execution-context'){if(executionContext)throw new Error('Duplicate execution-context flag');executionContext=true;continue;}
  if(!known.includes(arg))throw new Error('unknown export option: '+arg);
  if(arg in flags)throw new Error('Duplicate export option: '+arg);
  const next=argv[++i];if(!next||next.startsWith('--'))throw new Error('Missing value for '+arg);
  flags[arg]=next;
 }
 const profile=flags['--profile'];if(profile&&!PROFILES.includes(profile))throw new Error('Unknown signal profile');
 const isolated=flags['--output-dir']!==undefined;
 if((mlRegimeShadow||flags['--rollover-schedules-file']||flags['--rollover-policy-file']||executionContext||profile==='directional_atr_v1'||flags['--ablation-file']||flags['--signal-options-file'])&&!isolated)
  throw new Error('Experimental signal export requires explicit --output-dir');
 if((flags['--ablation-file']||flags['--signal-options-file'])&&profile!=='directional_atr_v1')
  throw new Error('Signal options/ablations require explicit experimental --profile');
 const outputDir=path.resolve(flags['--output-dir']??path.join(repo,'logs',ticker.toLowerCase(),'history_exported'));
 if(isolated)assertResearchDestination(outputDir,repo);
 const manifestPath=flags['--manifest-out']?path.resolve(flags['--manifest-out']):isolated?path.join(outputDir,'export_manifest.json'):undefined;
 if(manifestPath){if(!isolated)throw new Error('manifest-out requires isolated output-dir');assertResearchDestination(manifestPath,repo);}
 const inputDir=path.resolve(flags['--input-dir']??path.join(repo,'logs',ticker.toLowerCase(),'history'));
 if(isolated&&fs.existsSync(inputDir)){
  assertFrozenInputIsolation(inputDir,outputDir);
  if(manifestPath)assertFrozenInputIsolation(inputDir,manifestPath);
 }
 const timeframes=flags['--timeframes']?.split(',').map(x=>x.trim().toUpperCase());
 if(timeframes&&(!timeframes.length||new Set(timeframes).size!==timeframes.length||timeframes.some(x=>!['M5','M15','M30','H1','H4','D1','W1'].includes(x))))
  throw new Error('Invalid or duplicate timeframes');
 return {ticker,inputDir,outputDir,...(mlRegimeShadow?{mlRegimeShadow:true}:{}),rolloverPolicyFile:flags['--rollover-policy-file']?path.resolve(flags['--rollover-policy-file']):undefined,
  rolloverSchedulesFile:flags['--rollover-schedules-file']?path.resolve(flags['--rollover-schedules-file']):undefined,...(executionContext?{executionContext:true}:{}),
  isolated,quiet,profile:profile as SmcExportArgs['profile'],timeframes,manifestPath,
  presetFile:flags['--preset-file']?path.resolve(flags['--preset-file']):undefined,
  ablationFile:flags['--ablation-file']?path.resolve(flags['--ablation-file']):undefined,
  signalOptionsFile:flags['--signal-options-file']?path.resolve(flags['--signal-options-file']):undefined};
}
export function rejectLegacyDetectionProfileFlags(argv:readonly string[]):void {
 if(argv.some(arg=>['--profile','--signal-profile','--ablation-file','--signal-options-file'].includes(arg)))
  throw new Error('Legacy detection search has no experimental profile route; use the isolated exporter');
}
export function assertLegacyDetectionSearch(preset:Partial<SMCPreset>|Record<string,unknown>):void {
 if(preset.signal_profile!==undefined&&preset.signal_profile!=='legacy_v1')
  throw new Error('Experimental SMC profiles are not eligible for the legacy detection search/apply; use the isolated exporter');
 if(preset.signal_ablation!==undefined||preset.signal_impulse!==undefined||preset.signal_fvg!==undefined)
  throw new Error('Experimental SMC options require the isolated exporter, not legacy detection search');
}
