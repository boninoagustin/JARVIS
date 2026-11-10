import {configFingerprint} from '../hyperopt/evaluation_protocol.js';
export function paperReadiness(ticker:string, p:any, cert:any, now=Date.now()) {
  const no=(reason:string)=>({ready:false,reason,n:0,wr:null as number|null,expectancy:null as number|null});
  if(p?.evidenceKind!=='forward_paper_v1'||p?.temporalMode!=='future_observation'||p?.status!=='OBSERVED') return no('Sin replay prospectivo válido; el histórico no autoriza activación');
  const at=Date.parse(p.generatedAt);
  if(!Number.isFinite(at)||at>now||now-at>8*864e5) return no('Evidencia paper vencida o sin fecha');
  if(cert?.status!=='CERTIFIED'||cert.ticker!==ticker) return no('Falta certificación forward del candidato');
  if(!cert.candidate_fingerprint||configFingerprint(cert.candidate_asset_snapshot)!==cert.candidate_fingerprint||p.candidateFingerprint!==cert.candidate_fingerprint||p.registrationFingerprint!==cert.registration_fingerprint) return no('Paper y certificado no corresponden al mismo candidato');
  const ev=cert.latest;
  if(ev?.verdict!=='CERTIFIED'||!Number.isFinite(ev.evaluated_at_ms)||ev.evaluated_at_ms>now||now-ev.evaluated_at_ms>28*864e5||ev.candidate?.n<8||ev.production?.n<8||!Number.isFinite(ev.candidate?.expectancy)||!Number.isFinite(ev.production?.expectancy)||ev.candidate.expectancy-ev.production.expectancy<0.05) return no('Certificación insuficiente o vencida');
  const start=p.registeredAtMs,end=p.window?.to_ms;
  if(!Number.isSafeInteger(start)||start<cert.registered_at_ms||p.window?.from_ms!==start||!Number.isSafeInteger(end)||end>now||end-start<7*864e5) return no('Ventana paper no es posterior al registro');
  if(!Array.isArray(p.trades)) return no('Faltan operaciones individuales paper');
  const ids=new Set<string>();let wins=0,sum=0;
  for(const t of p.trades){
    if(!t.id||ids.has(t.id)||t.ticker!==ticker||t.candidateFingerprint!==cert.candidate_fingerprint||t.mode!=='paper'||t.isPaper!==true||!Number.isSafeInteger(t.timestamp)||!Number.isSafeInteger(t.closedAt)||t.timestamp<start||t.closedAt<t.timestamp||t.closedAt>=end||typeof t.rMultiple!=='number'||!Number.isFinite(t.rMultiple)) return no('Operaciones paper inválidas, duplicadas o fuera de ventana');
    ids.add(t.id);sum+=t.rMultiple;if(t.rMultiple>0)wins++;
  }
  const n=ids.size,wr=n?wins/n:0,expectancy=n?sum/n:0;
  return {ready:n>=8&&wr>=0.4&&expectancy>0,reason:n<8?'Muestra paper insuficiente (mínimo 8 cierres)':wr<0.4||expectancy<=0?'Paper no confirma ventaja positiva':'Candidato certificado y paper positivo; revisar riesgo y cupo antes de proponer TRADE',n,wr,expectancy};
}
