/** Routing SMART de entrada directa CHoCH/BOS vs esperar retroceso OTE.
 *
 * FUENTE ÚNICA compartida entre el bot vivo (src/db/trading.ts) y el backtest
 * (jarvis-os/src/services/backtestEngine.ts). Antes estaba duplicado y había derivado
 * (rrChoch default 999 vs 3, tp2 sobreescrito a la pared solo en backtest, etc.).
 */
import type { RadarZone } from './Types.js';
import { canonicalZoneMedal } from './smc/zone_protocol.js';

export interface SmartRouteInput {
  direction: 'BUY' | 'SELL';
  currentSession: string;
  totalPoints: number;
  minPtsRequired: number;
  riskDist: number;
  currentPrice: number;
  signalTfMinutes: number;
  decimals: number;
  nowMs: number;
  zones: RadarZone[];
  biasTs?: Record<string, number>;
  atr14?: number;
  /** high-low de la última vela cerrada (en vivo: prevClosedHigh-Low; en backtest: htfHighLow). */
  climaxRange: number;
  alertLine: string;
  config: any;
}

export interface SmartRouteResult {
  takeChoch: boolean;
  disableOte: boolean;
  /** Precio de la pared opuesta más cercana (para log/telemetría); NO pisa el tp2. */
  closestZonePrice: number;
  rrChoch: number;
  /** Razón corta de la decisión, para log/telemetría del vivo. */
  reason: 'ote_only' | 'ote_risk' | 'ote_climax' | 'ote_bias' | 'direct' | 'direct_momentum' | 'ote_else';
}

function parseTfToMinutes(tfStr: string): number {
  if (!tfStr) return 0;
  const upper = tfStr.toUpperCase();
  if (upper === 'D' || upper === '1D') return 1440;
  if (upper === 'W' || upper === '1W') return 10080;
  const val = parseInt(upper);
  if (!isNaN(val)) {
    if (upper.includes('H')) return val * 60;
    return val;
  }
  return 0;
}

/** Umbral de entrada directa por gatillo (minScore/minScoreBuy/minScoreSell), FUENTE
 * ÚNICA compartida entre vivo y backtest. Reemplaza la lógica duplicada de
 * trading.ts (~3519-3563) y backtestEngine.ts (~1771-1808). */
export function resolveDirectTrigger(input: {
  direction: 'BUY' | 'SELL';
  entryTrigger: string;
  sessionConfig: any;
  isChoch: boolean;
  eventTf: string;
  assetMinBuy: number;
  assetMinSell: number;
}): { triggerEnabled: boolean; minPtsRequired: number; liveTriggerCfg?: any } {
  const { direction, entryTrigger, sessionConfig, isChoch, eventTf, assetMinBuy, assetMinSell } = input;
  const assetMin = direction === 'BUY' ? assetMinBuy : assetMinSell;
  let triggerEnabled = false;
  let liveTriggerCfg: any = null;
  let minPtsRequired = assetMin;

  const dirMin = (cfg: any, fallback: number) => direction === 'BUY'
    ? (cfg?.minScoreBuy ?? cfg?.minScore ?? fallback)
    : (cfg?.minScoreSell ?? cfg?.minScore ?? fallback);

  if (sessionConfig) {
    const tfKey = isChoch ? `choch${eventTf}m` : `bos${eventTf}m`;
    const legacyKey = isChoch ? 'choch' : 'bos';
    const tfConfig = sessionConfig[tfKey];
    if (tfConfig) {
      liveTriggerCfg = tfConfig;
      triggerEnabled = tfConfig.enabled ?? false;
      minPtsRequired = dirMin(tfConfig, assetMin);
    } else if (sessionConfig[legacyKey]) {
      triggerEnabled = sessionConfig[legacyKey].enabled ?? false;
      minPtsRequired = dirMin(sessionConfig[legacyKey], assetMin);
    }
  } else if (isChoch) {
    triggerEnabled = (entryTrigger === 'CHOCH' || entryTrigger === 'BOTH' || entryTrigger === 'SMART');
  } else {
    triggerEnabled = (entryTrigger === 'BOTH' || entryTrigger === 'SMART');
  }

  return { triggerEnabled, minPtsRequired, liveTriggerCfg };
}

export function routeSmartEntry(input: SmartRouteInput): SmartRouteResult {
  const { direction, currentSession, totalPoints, minPtsRequired, riskDist, currentPrice,
    signalTfMinutes, decimals, nowMs, zones, biasTs, atr14, climaxRange, alertLine, config } = input;

  // Paredes de papel: obstáculo si es fuerte O de igual/mayor temporalidad (misma que vivo).
  const oppositeZones = zones.filter(z => {
    if (z.dir === direction) return false;
    if (z.medal === 'SMC_DIV') return false;
    const zTfMs = parseTfToMinutes(z.tf || '');
    const isStrong = z.lvl === 'Strong' || z.medal?.includes('GOD') || canonicalZoneMedal(z.medal) === 'GodZone';
    return isStrong || zTfMs >= signalTfMinutes;
  });

  let closestZonePrice = direction === 'BUY' ? Infinity : 0;
  for (const z of oppositeZones) {
    if (direction === 'BUY' && z.btm > currentPrice && z.btm < closestZonePrice) closestZonePrice = z.btm;
    else if (direction === 'SELL' && z.top < currentPrice && z.top > closestZonePrice) closestZonePrice = z.top;
  }

  let rrChoch = 3.0; // default optimista (paridad con vivo)
  if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
    const rewardDist = Math.abs(closestZonePrice - currentPrice);
    rrChoch = riskDist > 0 ? rewardDist / riskDist : 3.0;
  }

  const MOMENTUM_EXTREMO_UMBRAL = (minPtsRequired || 8) + 5;
  const hasExtremeMomentum = totalPoints >= MOMENTUM_EXTREMO_UMBRAL;

  const smartMaxRisk = config.maxSmartRiskPercent !== undefined ? config.maxSmartRiskPercent : 0.15;
  const smartLimitByPct = currentPrice * (smartMaxRisk / 100);
  let smartAtr = 0;
  for (let i = zones.length - 1; i >= 0; i--) { if (zones[i].atr) { smartAtr = zones[i].atr!; break; } }
  const smartMaxRiskDist = smartAtr > 0 ? smartAtr * 1.5 : smartLimitByPct;

  const smartAtrForClimax = atr14 ?? smartAtr;
  const smartIsClimax = alertLine.includes('Vol: CLIMAX')
    || (smartAtrForClimax > 0 && climaxRange > smartAtrForClimax * 2);

  const rrThreshold = (config.smartAsiaStrict === true && currentSession === 'ASIA') ? 2.0 : 1.5;
  const biasFreshWindow = config.smartBiasFreshWindowMs ?? 4 * 3600e3;
  const biasFreshGuard = config.smartBiasFreshGuard === true
    && ((biasTs?.['240'] && nowMs - biasTs['240'] < biasFreshWindow)
        || (biasTs?.['60'] && nowMs - biasTs['60'] < biasFreshWindow));

  let takeChoch = false;
  let disableOte = false;
  let reason: SmartRouteResult['reason'] = 'ote_else';
  if (config.smartOteOnly === true) {
    takeChoch = false; disableOte = false; reason = 'ote_only';
  } else if (riskDist > smartMaxRiskDist) {
    takeChoch = false; disableOte = false; reason = 'ote_risk';
  } else if (smartIsClimax) {
    takeChoch = false; disableOte = false; reason = 'ote_climax';
  } else if (biasFreshGuard && !hasExtremeMomentum) {
    takeChoch = false; disableOte = false; reason = 'ote_bias';
  } else if (rrChoch >= rrThreshold || hasExtremeMomentum) {
    takeChoch = true; disableOte = true;
    reason = rrChoch < rrThreshold ? 'direct_momentum' : 'direct';
  } else {
    takeChoch = false; disableOte = false; reason = 'ote_else';
  }

  return { takeChoch, disableOte, closestZonePrice, rrChoch, reason };
}
