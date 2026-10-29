import { configFingerprint } from '../hyperopt/evaluation_protocol.js';
import { mapAssetConfig } from './selection_context.js';
import { AssetSessionConfigSchema } from '../../src/engine/Types.js';

/** SHA-256 of JSON-compatible data with sorted object keys, matching worker config hashes. */
export function assetFingerprint(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value));
  return configFingerprint(normalized);
}

/** Shared identity checks. Operational rollout does not manufacture prospective evidence. */
function checkCandidate(report: any, current: any, nowMs: number, prospective: boolean): { ok: boolean; reason: string } {
  const no = (reason: string) => ({ ok: false, reason });
  try {
    const ts = report?.timestamp;
    if (!Number.isSafeInteger(ts) || ts < 0 || ts > nowMs || nowMs - ts >= 48 * 3600e3) return no('timestamp inválido, futuro o viejo (>48h)');
    const cert = report?.certificate;
    if (!cert || cert.version !== 1) return no('sin evaluación del candidato final');
    if (cert.validation_role !== 'selection_validation') return no('rol temporal de validación desconocido');
    if (prospective && (report.apply_eligible !== true || cert.test_independence !== 'prospective' || cert.test_evaluated !== true)) return no('sin Test prospectivo independiente evaluado y certificado');
    const test = report.metrics_test;
    if (prospective && (!test || !Number.isInteger(test.trade_count) || test.trade_count <= 0 || !Number.isFinite(test.expectancy))) return no('Test sin observaciones válidas');
    const hash = (value: any) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (![cert.config_fingerprint, cert.asset_fingerprint, cert.evaluation_fingerprint, report.production_asset_fingerprint].every(hash)) return no('fingerprints inválidos');
    if (!report.final_config || !report.final_asset_config || !report.production_asset_snapshot) return no('faltan snapshots completos');
    if (!/^[A-Z][A-Z0-9]{0,20}$/.test(report.ticker) || report.final_config.ticker !== report.ticker) return no('ticker inconsistente');
    if (report.final_asset_config.ticker !== undefined && report.final_asset_config.ticker !== report.ticker) return no('ticker del asset inconsistente');
    if (assetFingerprint(report.production_asset_snapshot) !== report.production_asset_fingerprint || assetFingerprint(current) !== report.production_asset_fingerprint) return no('producción cambió desde la evaluación');
    if (assetFingerprint(report.final_config) !== cert.config_fingerprint) return no('candidato cambió después de evaluar');
    if (assetFingerprint(report.final_asset_config) !== cert.asset_fingerprint || report.final_asset_fingerprint !== cert.asset_fingerprint) return no('payload difiere del asset evaluado');
    const evaluated = JSON.parse(JSON.stringify(report.final_config));
    const projected = mapAssetConfig(report.ticker, report.final_asset_config, evaluated.timesfm?.cachePath);
    const gateEnabled = evaluated.mlGate?.enabled === true;
    if (gateEnabled !== (report.final_asset_config.mlGateEnabled === true)) return no('permiso ML del asset difiere del replay');
    projected.mlGate = evaluated.mlGate;
    for (const cfg of [evaluated, projected]) {
      delete cfg.minRR;
      if (cfg.collectOnly === true || cfg.timesfm?.collectOnly === true) return no('candidato de colección no aplicable');
      delete cfg.collectOnly;
      if (cfg.timesfm) for (const key of ['auditPath', 'collectPath', 'collectOnly']) delete cfg.timesfm[key];
    }
    if (assetFingerprint(projected) !== assetFingerprint(evaluated)) return no('asset no reproduce la estrategia evaluada');
    if (report.evaluation_fingerprint !== cert.evaluation_fingerprint) return no('dataset/escenario no coincide');
    const testEvidence = report.test_evidence;
    if (prospective && (!testEvidence || testEvidence.partition !== 'test' || testEvidence.test_independence !== 'prospective' ||
        testEvidence.config_fingerprint !== cert.config_fingerprint || testEvidence.evaluation_fingerprint !== cert.evaluation_fingerprint ||
        testEvidence.metrics_fingerprint !== assetFingerprint(test))) return no('Test no pertenece al candidato/escenario o cambió');
    const mc = report.montecarlo;
    if (!mc || !Number.isFinite(mc.survival) || mc.survival < 0.80 || mc.survival > 1) return no('MC inválido o insuficiente');
    if (cert.montecarlo_config_fingerprint !== cert.config_fingerprint || mc.config_fingerprint !== cert.config_fingerprint || mc.evaluation_fingerprint !== cert.evaluation_fingerprint) return no('MC no pertenece al candidato/escenario final');
    return {ok:true, reason:prospective ? 'candidato exacto certificado con Test prospectivo y MC pareado' : 'mejora histórica evaluada + MC; seguimiento posterior pendiente'};
  } catch { return no('evaluación o snapshot no serializable'); }
}

export function checkCertifiedCandidate(report: any, current: any, nowMs = Date.now()) {
  return checkCandidate(report, current, nowMs, true);
}

/** Operator-authorized weekly rollout. Never changes apply_eligible or certifies future returns. */
export function checkWeeklyCandidate(report: any, current: any, nowMs = Date.now()) {
  const no=(reason:string)=>({ok:false,reason});
  try {
    if (report?.status !== 'RECOMMEND') return no(`sin mejora aprobada: ${report?.status ?? 'sin reporte'}`);
    if (current?.enabled !== true || (typeof current.disabledReason==='string' && current.disabledReason.trim())) return no('activo deshabilitado o retirado: se respeta la decisión del operador');
    const integrity=checkCandidate(report,current,nowMs,false);
    if (!integrity.ok) return integrity;
    const next=report.final_asset_config;
    if (!AssetSessionConfigSchema.safeParse(next).success) return no('configuración inválida para el esquema del motor vivo');
    for (const key of ['enabled','disabledReason','entryTrigger','autoTrading','maxSmartRiskPercent','riskPercent','executionPolicy','executionInstrument','rolloverPolicy','mlGateEnabled','correlationFilter']) {
      if (assetFingerprint(current[key]??null)!==assetFingerprint(next[key]??null)) return no(`control operativo no optimizable: ${key}`);
    }
    const p=report.proposal_validation,b=report.production_validation;
    for (const m of [p,b]) {
      if (!m || !Number.isInteger(m.trade_count) || m.trade_count<=0 ||
          !['expectancy','net_pnl_r','max_drawdown_r'].every(k=>typeof m[k]==='number' && Number.isFinite(m[k])) || m.max_drawdown_r<0)
        return no('métricas de validación incompletas o inválidas');
    }
    const gain=p.expectancy-b.expectancy;
    const dd=(b.max_drawdown_r-p.max_drawdown_r)/Math.max(b.max_drawdown_r,1);
    const pnlDrop=b.net_pnl_r>0 ? (b.net_pnl_r-p.net_pnl_r)/Math.max(b.net_pnl_r,1) : 0;
    if (!(gain>=0.05 || (dd>=0.15 && pnlDrop<=0.15))) return no('las métricas no confirman la mejora recomendada');
    return integrity;
  } catch { return no('reporte o configuración inválidos'); }
}
