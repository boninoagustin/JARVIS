import type {
  RadarZone, ImpulseLeg, RadarState, BacktestTrade,
  BacktestConfig, BacktestResult, LogEntry, ParsedAlert,
} from './backtestTypes';
import { evaluateImpulseCore, evaluateMacroStretching, isInsideMacroOteZone, SETUP_MEMORY_WINDOW_MS } from '../engine/AlphaModel';
import { getPipValue, defaultFrictionConfig, getAssetClass, pipValuePerLotUsd } from '../engine/FrictionModel';
import { evaluateNetTrade } from '../engine/FrictionModel';
import {
  emptyState, normalizeZone, parseTF, getBuffer, getDecimals
} from './backtestTypes';

export type { BacktestTrade, BacktestResult, BacktestConfig } from './backtestTypes';

export interface DailyStats {
  currentDayStr: string;
  currentSessionStr: string;
  pnlR: number;
  peakPnlR: number;
  consecutiveLosses: number;
  tradeCount: number;
  isKilled: boolean;
  sellLossCount: number;
  buyLossCount: number;
  sessionTradeCount: number;
  sessionExp?: Record<string, { n: number; sumR: number }>;
}

function updateDailyStatsFromClose(trade: BacktestTrade, dailyStats: DailyStats, config: BacktestConfig) {
  if (trade.rMultiple === undefined || Number.isNaN(trade.rMultiple)) return;

  dailyStats.pnlR = Math.round((dailyStats.pnlR + trade.rMultiple) * 1000) / 1000;
  if (dailyStats.pnlR > dailyStats.peakPnlR) {
    dailyStats.peakPnlR = dailyStats.pnlR;
  }
  
  const NET_BE_EPS = 0.05;
  if (trade.rMultiple < -NET_BE_EPS) {
    dailyStats.consecutiveLosses++;
    if (trade.direction === 'SELL') dailyStats.sellLossCount++;
    if (trade.direction === 'BUY') dailyStats.buyLossCount++;
  } else if (trade.rMultiple >= 0.8) {
    dailyStats.consecutiveLosses = 0;
    if (trade.direction === 'SELL') dailyStats.sellLossCount = 0;
    if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
  } else if (trade.rMultiple > NET_BE_EPS) {
    dailyStats.consecutiveLosses = Math.max(0, dailyStats.consecutiveLosses - 1);
    if (trade.direction === 'SELL') dailyStats.sellLossCount = Math.max(0, dailyStats.sellLossCount - 1);
    if (trade.direction === 'BUY') dailyStats.buyLossCount = Math.max(0, dailyStats.buyLossCount - 1);
  }
  
  if (!dailyStats.sessionExp) dailyStats.sessionExp = {};
  const key = `${dailyStats.currentSessionStr.split('-').pop()}-${trade.direction}`;
  const e = (dailyStats.sessionExp[key] ??= { n: 0, sumR: 0 });
  e.n++; e.sumR += trade.rMultiple;

  if (config.maxDailyLossR && dailyStats.pnlR <= -config.maxDailyLossR) dailyStats.isKilled = true;
  if (config.dailyProfitTargetR && dailyStats.pnlR >= config.dailyProfitTargetR) dailyStats.isKilled = true;
  if (config.maxConsecutiveLosses && dailyStats.consecutiveLosses >= config.maxConsecutiveLosses) dailyStats.isKilled = true;
  if (config.trailingDrawdownR && (dailyStats.peakPnlR - dailyStats.pnlR) >= config.trailingDrawdownR) dailyStats.isKilled = true;
}


const MAX_ZONE_AGE_MS: Record<string, number> = {
  '3': 1800000, '5': 3600000, '15': 21600000,
  '60': 28800000, '240': 86400000, 'D': 604800000,
};

// --- CSV PARSING ---
export function* parseCSVLines(content: string): Generator<LogEntry> {
  const seen = new Set<string>();
  let start = 0;
  while (start < content.length) {
    let end = content.indexOf('\n', start);
    if (end === -1) end = content.length;
    let r = content.substring(start, end);
    if (r.endsWith('\r')) r = r.slice(0, -1);
    start = end + 1;

    if (r.trim().length === 0 || !r.includes(' | TS: ')) continue;
    const firstComma = r.indexOf(',');
    const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;
    
    // Guardamos una subcadena o hash simple en memoria en vez de la línea completa de 300 chars
    // para reducir drásticamente el uso de RAM del Set. 
    // Como las duplicaciones suelen ser exactas, un prefijo + TS suele bastar.
    const dedupKey = line.substring(0, 60);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const tsMatch = line.match(/TS:\s*(\d+)/i);
    const tfMatch = line.match(/TF:\s*([a-zA-Z0-9]+)/i);
    yield {
      line,
      ts: tsMatch ? parseInt(tsMatch[1], 10) : 0,
      tf: tfMatch ? tfMatch[1].toUpperCase() : '3',
      parsed: preParseAlert(line)
    };
  }
}

export function parseCSV(content: string): { lines: LogEntry[]; detectedTF: string } {
  const entries: LogEntry[] = [];
  let tf = '3';
  let first = true;
  for (const entry of parseCSVLines(content)) {
    if (first && entry.tf) { tf = entry.tf; first = false; }
    entries.push(entry);
  }
  return { lines: entries, detectedTF: tf };
}

// --- GET SESSION FOR TIMESTAMP ---
export function getSessionForTimestamp(ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
  // Argentina is UTC-3 all year round
  const d = new Date(ts - 3 * 3600 * 1000);
  const arHour = d.getUTCHours();
  const arMin = d.getUTCMinutes();
  const timeDecimal = arHour + arMin / 60;
  
  if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
  if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
  if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';
  
  return 'OFF';
}


// --- MAIN BACKTEST RUNNER ---
export function runBacktest(
  logs: Map<string, (string | LogEntry)[]>,
  config: BacktestConfig,
  onProgress?: (pct: number, trades: BacktestTrade[]) => void
): BacktestResult {
  const state = emptyState();
  const trades: BacktestTrade[] = [];
  const activeTrades = new Map<string, BacktestTrade>();
  const dailyStats: DailyStats = {
    currentDayStr: '',
    currentSessionStr: '',
    pnlR: 0,
    peakPnlR: 0,
    consecutiveLosses: 0,
    tradeCount: 0,
    isKilled: false,
    sellLossCount: 0,
    buyLossCount: 0,
    sessionTradeCount: 0
  };

  // 1. Parse all entries with timestamps
  const allEntries: LogEntry[] = [];
  for (const [tf, items] of logs.entries()) {
    for (const item of items) {
      if (typeof item === 'string') {
        const tsMatch = item.match(/TS:\s*(\d+)/i);
        allEntries.push({ ts: tsMatch ? parseInt(tsMatch[1], 10) : 0, line: item, tf, parsed: preParseAlert(item) });
      } else {
        allEntries.push(item as LogEntry);
      }
    }
  }
  // 2. Sort chronologically
  const validEntries = allEntries.filter(e => e.ts > 0).sort((a, b) => a.ts - b.ts);
  
  if (validEntries.length === 0) {
    return { trades, totalEvents: 0, processedEvents: 0, startDate: '', endDate: '' };
  }

  // 3. Procesar cronológicamente (sin hoistar SYNC_ZONES para evitar lookahead bias)
  const initialPrice = validEntries.find(e => e.parsed?.currentPrice !== undefined)?.parsed?.currentPrice ?? 1;
  const pipSize = getPipValue(config.ticker, initialPrice);

  const total = validEntries.length;
  let lastProgressPct = 0;
  for (let i = 0; i < total; i++) {
    processAlert(validEntries[i], validEntries[i].ts, state, config, trades, activeTrades, dailyStats, pipSize);
    const pct = Math.floor((i / total) * 100);
    if (onProgress && pct > lastProgressPct && pct % 5 === 0) {
      lastProgressPct = pct;
      onProgress(pct, [...trades]);
    }
  }

  // Close remaining active trades at closing price
  const lastEntry = validEntries[validEntries.length - 1];
  const closingPrice = state.lastPrice ?? lastEntry.parsed?.currentPrice;
  if (closingPrice !== undefined) {
    for (const [, trade] of activeTrades) {
      const slDistance = Math.abs(trade.originalSlPrice! - trade.entryPrice);
      const pnlDistance = trade.direction === 'BUY'
        ? closingPrice - trade.entryPrice
        : trade.entryPrice - closingPrice;
      const pct = (pnlDistance / trade.entryPrice) * 100;
      
      const pipSize = getPipValue(config.ticker, closingPrice);
      const riskPips = slDistance / pipSize;
      const cls = getAssetClass(config.ticker);
      const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
      const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, closingPrice)) : 0;
      
      const applyFullComm = !trade.tp1Hit;
      const finalCost = applyFullComm ? transactionCostR : (transactionCostR * 0.5);
      
      const r = slDistance > 0 ? pnlDistance / slDistance : 0;
      trade.result = r > 0 ? 'WIN' : r === 0 ? 'BE' : 'LOSS';
      trade.pnl = pct;
      trade.rMultiple = (r - finalCost) * (trade.riskMult || 1.0);
      trade.closeTimestamp = lastEntry.ts;
      trade.durationMin = Math.round((lastEntry.ts - trade.timestamp) / 60000);
      updateDailyStatsFromClose(trade, dailyStats, config);
    }
  }
  activeTrades.clear();

  if (onProgress) onProgress(100, [...trades]);

  return {
    trades,
    totalEvents: validEntries.length,
    processedEvents: total,
    startDate: new Date(validEntries[0].ts).toISOString().split('T')[0],
    endDate: new Date(validEntries[validEntries.length - 1].ts).toISOString().split('T')[0],
  };
}

// --- PROCESS SINGLE ALERT (ported from backend processTradingAlert) ---

function preParseAlert(alertText: string): ParsedAlert | undefined {
  const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
  const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());
  if (parts.length < 2) return undefined;

  const prefix = parts[0].toUpperCase();
  const upperText = alertText.toUpperCase();

  const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
  const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
  const readableTf = parseTF(eventTf);


  let currentDirection: 'BUY' | 'SELL' | null = null;
  if (upperText.includes('BUY') || upperText.includes('BULLISH')) currentDirection = 'BUY';
  else if (upperText.includes('SELL') || upperText.includes('BEARISH')) currentDirection = 'SELL';

  const parsed: any = { prefix, eventTf, readableTf, currentDirection };

  if (prefix === 'SYNC_ZONES') {
    const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
    if (trendMatch) parsed.trendMatch = trendMatch[1].toUpperCase();
    if (alertText.includes('Payload:')) {
      const afterPayload = alertText.substring(alertText.indexOf('Payload:') + 8);
      const payloadStr = afterPayload.split(/\s*\|\s*TS:/)[0].trim().replace(/""/g, '"');
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }
  }

  if (prefix === 'HEARTBEAT') {
    const biasMatch = alertText.match(/Bias:\s*(BUY|SELL|NEUTRAL)/i);
    if (biasMatch) parsed.biasMatch = biasMatch[1].toUpperCase();
  }

  if (prefix === 'PING_PRICE') {
    const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
    const highMatch = alertText.match(/High:\s*([0-9.]+)/i);
    const lowMatch = alertText.match(/Low:\s*([0-9.]+)/i);
    if (highMatch) parsed.highPrice = parseFloat(highMatch[1]);
    if (lowMatch) parsed.lowPrice = parseFloat(lowMatch[1]);
  }
  
  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS' || prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
    if (originMatch) parsed.origin = parseFloat(originMatch[1]);
    const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
    if (priceMatch) parsed.currentPrice = parseFloat(priceMatch[1]);
  }
  
  if (upperText.includes('VWAP UNDER')) parsed.vwapUnder = true;
  if (upperText.includes('VWAP OVER')) parsed.vwapOver = true;

  return parsed;
}

function getArgentinaDayStr(nowMs: number): string {
  // Para ASIA: anclar el día de trading a las 17:00 ART (convención FX: el día cambia al cierre de NY):
  const d = new Date(nowMs - 3 * 3600e3 - 17 * 3600e3);
  return d.toISOString().split('T')[0];
}

function processAlert(
  entry: LogEntry, nowMs: number, state: RadarState,
  config: BacktestConfig, trades: BacktestTrade[],
  activeTrades: Map<string, BacktestTrade>,
  dailyStats: DailyStats,
  pipSize: number
) {
  const p = entry.parsed;
  if (!p) return;
  const { prefix, eventTf, readableTf, currentDirection } = p;
  const alertText = entry.line;
  const upperText = alertText.toUpperCase();

  // --- TICK DENSITY (ACTIVITY PROXY) ---
  state.tickTimes = (state.tickTimes ?? []).filter(t => nowMs - t < 3600000);
  state.tickTimes.push(nowMs);
  const density = state.tickTimes.length;
  const a = 1 / 50;
  state.densityMedian = state.densityMedian === undefined ? density 
    : state.densityMedian + a * (density - state.densityMedian);

  // Extract VWAP status globally for the event timeframe
  const vwapMatch = upperText.match(/VWAP:\s*(UNDER|OVER)/);
  if (vwapMatch && eventTf) {
    if (!state.vwapStatus) state.vwapStatus = {};
    if (!state.vwapTs) state.vwapTs = {};
    state.vwapStatus[eventTf] = vwapMatch[1];
    state.vwapTs[eventTf] = nowMs;
  }
  const ticker = config.ticker;
  const todayStr = getArgentinaDayStr(nowMs);
  const currentSession = getSessionForTimestamp(nowMs);
  const sessionId = `${todayStr}-${currentSession}`;

  if (dailyStats.currentDayStr !== todayStr) {
    dailyStats.currentDayStr = todayStr;
    dailyStats.pnlR = 0;
    dailyStats.peakPnlR = 0;
    dailyStats.consecutiveLosses = 0;
    dailyStats.tradeCount = 0;
    dailyStats.isKilled = false;
  }

  if (dailyStats.currentSessionStr !== sessionId) {
    dailyStats.currentSessionStr = sessionId;
    dailyStats.sellLossCount = 0;
    dailyStats.buyLossCount = 0;
    dailyStats.sessionTradeCount = 0;
  }


  if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
  if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
  if (nowMs - state.scoreBuy.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
  if (nowMs - state.scoreSell.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };

  // --- SYNC_ZONES ---
  if (prefix === 'SYNC_ZONES') {
    if (!alertText.includes('Payload:')) return;
    const sourceTf = eventTf;

    if (p.trendMatch) {
      if (!state.biasTs) state.biasTs = {};
      state.marketBias[sourceTf] = p.trendMatch;
      state.biasTs[sourceTf] = nowMs;
    }

    try {
      const rawZones = p.rawZones as Record<string, unknown>[];
      if (!rawZones) return;
      const parsedZones: RadarZone[] = rawZones.map(normalizeZone).filter(z => z.top !== undefined && z.btm !== undefined && z.dir !== undefined);
      parsedZones.forEach(z => { z.tf = sourceTf; z.createdAt = nowMs; });

      if (state.lastSyncDate !== todayStr) {
        state.zones = [];
        state.lastSyncDate = todayStr;
      }
      state.zones = state.zones.filter(z => z.tf !== sourceTf);
      state.zones.push(...parsedZones);
    } catch { /* invalid JSON */ }
    return;
  }

  // --- PING_PRICE ---
  if (prefix === 'PING_PRICE') {
    if (p.currentPrice === undefined) return;
    const currentPrice = p.currentPrice;
    const highPrice = p.highPrice !== undefined ? p.highPrice : currentPrice;
    const lowPrice = p.lowPrice !== undefined ? p.lowPrice : currentPrice;

    const prevClose = state.lastPrice ?? currentPrice;
    const tr = Math.max(highPrice - lowPrice, Math.abs(highPrice - prevClose), Math.abs(lowPrice - prevClose));
    if (state.atr14 === undefined) {
        state.atrSeed = (state.atrSeed ?? 0) + tr;
        state.atrSamples = (state.atrSamples ?? 0) + 1;
        if (state.atrSamples >= 14) state.atr14 = state.atrSeed / 14;
    } else {
        state.atr14 = (state.atr14 * 13 + tr) / 14;
    }

    const previousPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.previousPrice = previousPrice;

    // Evaluate impulse legs

    const currentSession = getSessionForTimestamp(nowMs);
    const sessionConfig = config.sessions?.[currentSession] || config.sessions?.['OFF'];
    const ctx = { config, currentSession, sessionConfig };

    const buyRes = evaluateImpulseCore(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, ctx);
    state.activeImpulseBuy = buyRes.updatedLeg;
    if (buyRes.newTrade && buyRes.oteData) createTrade({ ...buyRes.oteData, ...buyRes.newTrade }, nowMs, trades, activeTrades, dailyStats, config, state);

    const sellRes = evaluateImpulseCore(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, ctx);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.newTrade && sellRes.oteData) createTrade({ ...sellRes.oteData, ...sellRes.newTrade }, nowMs, trades, activeTrades, dailyStats, config, state);


    // Evaluate macro impulse legs (1H/4H stretching)
    state.activeMacroImpulseBuy = evaluateMacroStretching(state.activeMacroImpulseBuy, highPrice, lowPrice, nowMs);
    state.activeMacroImpulseSell = evaluateMacroStretching(state.activeMacroImpulseSell, highPrice, lowPrice, nowMs);

    // Evaluate active trades TP/SL
    for (const [tradeId, trade] of activeTrades) {
      const tradeAge = nowMs - trade.timestamp;
      if (tradeAge < 5000) continue;

      // Gestión diferenciada por tipo de entrada: OTE (retroceso fibo) vs directa (CHOCH/BOS)
      const isOteTrade = trade.events?.some(e => e.includes('OTE_Retracement')) ?? false;
      const mgmt = (isOteTrade ? config.oteManagement : config.directManagement) ?? {};
      const partialPct = mgmt.partialClosePct ?? config.partialClosePct ?? 0.5; // fracción cerrada en TP1
      const remainderPct = 1 - partialPct;
      const slAfterTp1Mode = mgmt.slAfterTp1 ?? config.slAfterTp1 ?? 'midpoint';
      const tp15BeEnabled = mgmt.tp15BeEnabled ?? config.tp15BeEnabled ?? true;
      const atrTrailEnabled = mgmt.atrTrailEnabled ?? config.atrTrailEnabled ?? true;

      const MAX_HOLD_MS = config.maxHoldMin ? config.maxHoldMin * 60000 : Infinity;
      if (tradeAge >= MAX_HOLD_MS) {
        const pnlDist = trade.direction === 'BUY'
          ? currentPrice - trade.entryPrice
          : trade.entryPrice - currentPrice;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const slDist = Math.abs(originalSl - trade.entryPrice);
        
        const riskPips = slDist / pipSize;
        const cls = getAssetClass(config.ticker);
        const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
        const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, currentPrice)) : 0;

        const lockedPct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 * partialPct : 0;
        const openPct = (pnlDist / trade.entryPrice) * 100 * (trade.tp1Hit ? remainderPct : 1.0);
        const slPct = (slDist / trade.entryPrice) * 100;

        trade.pnl = lockedPct + openPct;
        trade.rMultiple = slPct > 0 ? ((lockedPct + openPct) / slPct - transactionCostR) * (trade.riskMult || 1.0) : 0;
        trade.result = trade.rMultiple > 0 ? 'WIN' : trade.rMultiple === 0 ? 'BE' : 'LOSS';
        
        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round(tradeAge / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // 1) SL con niveles de apertura de barra (path desconocido => peor caso)
      const slAtBarOpen = trade.slPrice;
      const slHitFirst = trade.direction === 'BUY' ? lowPrice <= slAtBarOpen : highPrice >= slAtBarOpen;
      if (slHitFirst) {
        const isPartialClose = trade.tp1Hit;
        const cls = getAssetClass(config.ticker);
        const latencyMs = config.latencyMs ?? defaultFrictionConfig[cls].latencyMs;
        const exitSlip = (latencyMs / 50) * 0.1 * pipSize;
        const slFill = trade.direction === 'BUY' ? trade.slPrice - exitSlip : trade.slPrice + exitSlip;

        const slPnlPct = trade.direction === 'BUY' 
          ? (slFill - trade.entryPrice) / trade.entryPrice * 100 
          : (trade.entryPrice - slFill) / trade.entryPrice * 100;
        const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
        const finalPnlPct = isPartialClose ? (pnlTp1Pct * partialPct + slPnlPct * remainderPct) : slPnlPct;
        const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        
        // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
        const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
        const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
        const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
        
        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = initialSlLossPct > 0 ? (grossR - transactionCostR) * (trade.riskMult || 1.0) : 0;
        
        if (!isPartialClose) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = -initialSlLossPct;
          trade.rMultipleTp1 = undefined; // Don't show confusing -50 in TP1
          trade.rMultipleTp2 = undefined; // Don't show confusing -50 in TP2
        } else {
          trade.rMultipleTp2 = initialSlLossPct > 0 ? slPnlPct / initialSlLossPct : 0.0;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // 2) solo si no hubo SL: TP1, trailing BE, TP2


      // TP1
      if (!trade.tp1Hit) {
        const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
        if (tp1Hit) {
          trade.tp1Hit = true;
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const slLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          // Tras TP1: ajuste del SL según slAfterTp1 ('midpoint' default | 'breakeven' | 'none')
          if (slAfterTp1Mode === 'midpoint') {
            trade.slPrice = originalSl + (trade.entryPrice - originalSl) * 0.5;
            trade.slHalfwayHit = true;
          } else if (slAfterTp1Mode === 'breakeven') {
            trade.slPrice = trade.entryPrice;
          }
            
          trade.resultTp1 = 'WIN';
          trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
          
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = slLossPct > 0 ? trade.pnlTp1 / slLossPct : 1.0;
          trade.rMultipleTp1 = ((grossR * partialPct) - (transactionCostR * partialPct)) * (trade.riskMult || 1.0);
        }
      }

      // TP1.5 (Trailing a BE diferido)
      if (trade.tp1Hit && !trade.tp1_5Hit && tp15BeEnabled) {
        const tp1_5Price = trade.direction === 'BUY' 
          ? trade.tp1Price + Math.abs(trade.tp1Price - trade.entryPrice) * 0.5
          : trade.tp1Price - Math.abs(trade.tp1Price - trade.entryPrice) * 0.5;
        const tp1_5Hit = trade.direction === 'BUY' ? highPrice >= tp1_5Price : lowPrice <= tp1_5Price;
        if (tp1_5Hit) {
          trade.tp1_5Hit = true;
          trade.slPrice = trade.entryPrice;
        }
      }

      // Complemento PING: trailing continuo post-TP1 por distancia
      if (trade.tp1Hit && atrTrailEnabled) {
        const atrThreshold = (state.atr14 ?? 0) * 1.5;
        const ratchetStep = (state.atr14 ?? 0) * 0.25;
        if (trade.direction === 'BUY') {
          const atrTrailSL = highPrice - atrThreshold;
          if (atrTrailSL > trade.slPrice + ratchetStep) {
            trade.slPrice = atrTrailSL;
          }
        } else {
          const atrTrailSL = lowPrice + atrThreshold;
          if (atrTrailSL < trade.slPrice - ratchetStep) {
            trade.slPrice = atrTrailSL;
          }
        }
      }

      // Chequeo de vela ambigua: si en la misma vela se alcanzó TP1 o TP1.5 (modificando el SL) y también se violó el nuevo SL
      if (trade.tp1Hit) {
        const slViolated = trade.direction === 'BUY' ? lowPrice <= trade.slPrice : highPrice >= trade.slPrice;
        if (slViolated) {
          trade.result = 'WIN'; 
          trade.resultTp2 = 'LOSS';
          const slPnlPct = trade.direction === 'BUY' 
            ? (trade.slPrice - trade.entryPrice) / trade.entryPrice * 100 
            : (trade.entryPrice - trade.slPrice) / trade.entryPrice * 100;
          trade.pnl = trade.pnlTp1! * partialPct + slPnlPct * remainderPct;
          trade.pnlTp2 = trade.pnl;
          
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = initialSlLossPct > 0 ? trade.pnl / initialSlLossPct : 0;
          trade.rMultiple = (grossR - transactionCostR) * (trade.riskMult || 1.0);
          
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
          continue;
        }
      }
      // TP2
      if (trade.tp2Price > 0) {
        const tp2Hit = trade.direction === 'BUY' ? highPrice >= trade.tp2Price : lowPrice <= trade.tp2Price;
        if (tp2Hit) {
          trade.result = 'WIN';
          trade.resultTp2 = 'WIN';
          const pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
          const pnlTp2 = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
          const finalPnl = trade.tp1Hit ? (pnlTp1 * partialPct + pnlTp2 * remainderPct) : pnlTp2;
          
          trade.pnl = finalPnl;
          trade.pnlTp2 = finalPnl;
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          
          // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const cls = getAssetClass(config.ticker);
          const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
          const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker)) : 0;
          
          const grossR = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 0;
          trade.rMultiple = initialSlLossPct > 0 ? (grossR - transactionCostR) * (trade.riskMult || 1.0) : 0;
          
          const grossRTp2 = initialSlLossPct > 0 ? pnlTp2 / initialSlLossPct : 0;
          trade.rMultipleTp2 = initialSlLossPct > 0 ? ((grossRTp2 * remainderPct) - (transactionCostR * remainderPct)) * (trade.riskMult || 1.0) : 0;
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
          continue;
        }
      }



    }

    // Zone touching (scoring)
    const buffer = Math.max(getBuffer(ticker, currentPrice), (state.atr14 ?? 0) * 0.25);
    const validZones: RadarZone[] = [];
    for (const zone of state.zones) {
      if (zone.createdAt && (nowMs - zone.createdAt) >= (MAX_ZONE_AGE_MS[zone.tf || '60'] || 14400000)) continue;
      validZones.push(zone);

      if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
        const enteredFromAbove = previousPrice !== null && previousPrice > zone.top;
        const enteredFromBelow = previousPrice !== null && previousPrice < zone.btm;
        const isValid = (zone.dir === 'BUY' && enteredFromAbove) || (zone.dir === 'SELL' && enteredFromBelow);
        if (!isValid && previousPrice !== null) continue;

        const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
        const zTf = parseTF(zone.tf || '');
        const basePts = zone.score !== undefined ? zone.score : 2;
        const tfMult = zTf === '4H' ? 2 : zTf === '1H' ? 1.5 : 1;
        const eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                          zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                          zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                          `OB_${zone.medal}_${zTf}`;
        const pts = Math.floor(basePts * tfMult);
        if (!activeScore.events.includes(eventName)) {
          activeScore.events.push(eventName);
          activeScore.points += pts;
          activeScore.lastUpdate = nowMs;
        }
      }
    }
    state.zones = validZones;
    return;
  }

  // --- EVENTS WITH DIRECTION ---
  if (!currentDirection) return;
  const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
  let addedPoints = 0;

  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
    if (!state.biasTs) state.biasTs = {};
    state.marketBias[eventTf] = currentDirection;
    state.biasTs[eventTf] = nowMs;

    if (eventTf === '5' || eventTf === '15') {
      const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
      const priceMatchChoch = alertText.match(/Precio:\s*([0-9.]+)/i);
      const actualPrice = priceMatchChoch ? parseFloat(priceMatchChoch[1]) : state.lastPrice || 0;
      
      // 🆕 FIX 2.5: Registrar explícitamente el CHOCH/BOS contrario en el score opuesto para permitir invalidación
      const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
      const eventKey = `${prefix}_${readableTf}`;
      if (!oppositeScore.events.includes(eventKey)) {
        oppositeScore.events.push(eventKey);
        oppositeScore.lastUpdate = nowMs;
      }

      if (originMatch && actualPrice) {
        const newOrigin = parseFloat(originMatch[1]);
        const isBuy = currentDirection === 'BUY';
        const activeLeg = isBuy ? state.activeImpulseBuy : state.activeImpulseSell;

        let shouldCreateNew = true;
        if (activeLeg) {
          const isInside = actualPrice > Math.min(activeLeg.origin, activeLeg.extreme) && actualPrice < Math.max(activeLeg.origin, activeLeg.extreme);
          if (isInside) shouldCreateNew = false;
          if (activeLeg.createdAt && (nowMs - activeLeg.createdAt) < 3 * 60 * 1000) shouldCreateNew = false;
        }

        const impulseRange = Math.abs(actualPrice - newOrigin);
        const minRange = ticker.includes('BTC') || ticker.includes('ETH') ? actualPrice * 0.0005 : 0.00015;
        if (impulseRange < minRange) shouldCreateNew = false;

        if (shouldCreateNew) {
          let macroTarget: number | null = null;
          if (isBuy && state.activeImpulseSell) { macroTarget = state.activeImpulseSell.origin; state.activeImpulseSell = null; }
          else if (!isBuy && state.activeImpulseBuy) { macroTarget = state.activeImpulseBuy.origin; state.activeImpulseBuy = null; }

          const newLeg: ImpulseLeg = {
            dir: currentDirection, origin: newOrigin, extreme: actualPrice,
            createdAt: nowMs, tp2: macroTarget, oteScored: false,
          };
          if (isBuy) {
            state.activeImpulseBuy = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              const stOte = trade.events?.some(e => e.includes('OTE_Retracement')) ?? false;
              const stEnabled = ((stOte ? config.oteManagement : config.directManagement)?.structuralTrailEnabled) ?? config.structuralTrailEnabled ?? true;
              if (!stEnabled) continue;
              if (trade.direction === 'BUY' && trade.tp1Hit && !trade.closeTimestamp) {
                const atrTrail = (state.atr14 ?? Math.abs(actualPrice - newOrigin) * 0.3) * 0.5;
                const structuralBuffer = Math.max(2 * (config.spreadPips ?? 0.1) * pipSize, atrTrail);
                const trailedSL = newOrigin - structuralBuffer;
                // Ratchet con paso mínimo: solo mover si mejora ≥ 0.25×ATR
                if (trailedSL > trade.slPrice + atrTrail * 0.5) trade.slPrice = trailedSL;
              }
            }
          } else {
            state.activeImpulseSell = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              const stOte = trade.events?.some(e => e.includes('OTE_Retracement')) ?? false;
              const stEnabled = ((stOte ? config.oteManagement : config.directManagement)?.structuralTrailEnabled) ?? config.structuralTrailEnabled ?? true;
              if (!stEnabled) continue;
              if (trade.direction === 'SELL' && trade.tp1Hit && !trade.closeTimestamp) {
                const atrTrail = (state.atr14 ?? Math.abs(actualPrice - newOrigin) * 0.3) * 0.5;
                const structuralBuffer = Math.max(2 * (config.spreadPips ?? 0.1) * pipSize, atrTrail);
                const trailedSL = newOrigin + structuralBuffer;
                // Ratchet con paso mínimo: solo mover si mejora ≥ 0.25×ATR
                if (trailedSL < trade.slPrice - atrTrail * 0.5) trade.slPrice = trailedSL;
              }
            }
          }
        }
      }
    }
    // Macro impulse legs for 1H/4H (used for macro OTE bonus)
    if (eventTf === '60' || eventTf === '240') {
      const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
      const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
      const actualPrice = priceMatch ? parseFloat(priceMatch[1]) : state.lastPrice || 0;
      if (originMatch && actualPrice) {
        const newOrigin = parseFloat(originMatch[1]);
        const isBuy = currentDirection === 'BUY';
        const newMacroLeg: ImpulseLeg = {
          dir: currentDirection, origin: newOrigin, extreme: actualPrice,
          createdAt: nowMs, oteScored: false,
        };
        if (isBuy) state.activeMacroImpulseBuy = newMacroLeg;
        else state.activeMacroImpulseSell = newMacroLeg;
      }
    }
    addedPoints = prefix === 'EVENTO_CHOCH' ? 3 : 1;
  }
  else if (prefix === 'ZONE_BROKEN') {
    state.zones = state.zones.filter(z => {
      if (z.tf !== eventTf) return true;
      if (currentDirection === 'BUY' && z.dir === 'SELL') return true;
      if (currentDirection === 'SELL' && z.dir === 'BUY') return true;
      return false;
    });
    return;
  }
  else if (prefix === 'SWEEP_BROKEN' || prefix === 'DIV_BROKEN') {
    // Deduct points from active score
    let deduct = 0;
    const initialLen = activeScore.events.length;
    if (prefix === 'SWEEP_BROKEN') {
      activeScore.events = activeScore.events.filter(e => {
        if (e.includes(`Sweep_${readableTf}`)) { deduct += 3; return false; }
        return true;
      });
    } else {
      activeScore.events = activeScore.events.filter(e => {
        if (e === `DIV_${readableTf}`) { deduct += 2; return false; }
        return true;
      });
    }
    if (activeScore.events.length < initialLen) activeScore.points = Math.max(0, activeScore.points - deduct);
    return;
  }
  else if (prefix === 'EVENTO_SMC_DIV') {
    if (!activeScore.events.includes(`DIV_${readableTf}`)) { addedPoints = 2; activeScore.events.push(`DIV_${readableTf}`); }
  }
  else if (prefix === 'EVENTO_SWEEP' || prefix === 'EVENTO_SWEEP_SCALP') {
    if (!activeScore.events.includes(`Sweep_${readableTf}`)) {
      if (upperText.includes('ABSORCION') && density >= state.densityMedian) { 
        addedPoints = 6; 
        activeScore.events.push(`🩸_V-Shape_Absorb_${readableTf}`); 
      } else if (upperText.includes('ABSORCION')) { 
        addedPoints = 3; 
        activeScore.events.push(`Sweep_${readableTf}`); // sin confirmación de actividad       
      } else { 
        addedPoints = 3; 
        activeScore.events.push(`Sweep_${readableTf}`); 
      }
    }
  }
  else if (prefix === 'HEARTBEAT') {
    state.lastHeartbeat = nowMs;
    return;
  }

  if (addedPoints > 0) {
    activeScore.points += addedPoints;
    activeScore.lastUpdate = nowMs;
  }

  // 🆕 FIX PERF: Limitar tamaño de arrays de eventos para evitar crecimiento infinito O(N)
  if (state.scoreBuy.events.length > 50) state.scoreBuy.events = state.scoreBuy.events.slice(-50);
  if (state.scoreSell.events.length > 50) state.scoreSell.events = state.scoreSell.events.slice(-50);

  // --- LATE RE-VALIDATION (ported from live) ---
  if (prefix !== 'EVENTO_CHOCH' && prefix !== 'EVENTO_BOS' && currentDirection) {
    const pendingLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
    if (pendingLeg && !pendingLeg.isValidated && pendingLeg.chochPoints) {
      const hasZoneNow = activeScore.events.some(e =>
        e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') ||
        e.includes('Sweep_') || e.includes('DIV_') || e.includes('Silver_Bullet_')
      );
      if (hasZoneNow) {
        pendingLeg.isValidated = true;
        pendingLeg.chochEvents = [...activeScore.events, `CHoCH_${readableTf}`];
      }
    }
  }

  // --- CHoCH/BOS TRIGGER VALIDATION ---
  if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '5' || eventTf === '15')) {
    if (nowMs - (state.lastSniperAlert ?? 0) < 180000) return;

    const BIAS_TTL: Record<string, number> = { '60': 8*3600e3, '240': 48*3600e3, '1D': 120*3600e3, 'D': 120*3600e3, '4H': 48*3600e3, '1H': 8*3600e3 };
    const freshBias = (tf: string) => (nowMs - (state.biasTs?.[tf] ?? 0) < (BIAS_TTL[tf] ?? 24*3600e3)) ? state.marketBias?.[tf] : undefined;
    const mb240 = freshBias('240'); const mb60 = freshBias('60'); const mbD = freshBias('D') || freshBias('1D');
    
    const isMacroAligned = (mb240 === currentDirection) || (mb60 === currentDirection);
    const isDAgainst = mbD !== undefined && mbD !== currentDirection && mbD !== 'NEUTRAL';
    const is4HAgainst = mb240 !== undefined && mb240 !== currentDirection && mb240 !== 'NEUTRAL';
    const is1HAgainst = mb60 !== undefined && mb60 !== currentDirection && mb60 !== 'NEUTRAL';
    const baseBiasPoints = isMacroAligned ? 5 : 0;

    let vwapBonus = 0;
    let vwapPenalty = 0;

    const VWAP_TTL: Record<string, number> = { '15': 2*3600e3, '60': 8*3600e3, '240': 48*3600e3 };
    const freshVwap = (tf: string) => (nowMs - (state.vwapTs?.[tf] ?? 0) < (VWAP_TTL[tf] ?? 4*3600e3)) ? state.vwapStatus?.[tf] : undefined;
    
    const vwap15m = freshVwap('15') || (upperText.match(/VWAP:\s*(UNDER|OVER)/)?.[1]);
    const vwap1H = freshVwap('60');
    const vwap4H = freshVwap('240');

    if (currentDirection === 'BUY') {
      if (vwap15m === 'UNDER') vwapBonus += 2;
      if (vwap1H === 'UNDER') vwapBonus += 3;
      if (vwap4H === 'UNDER') vwapBonus += 4;
      if (vwap1H === 'OVER' && vwap4H === 'OVER') vwapPenalty += 5;
    } else if (currentDirection === 'SELL') {
      if (vwap15m === 'OVER') vwapBonus += 2;
      if (vwap1H === 'OVER') vwapBonus += 3;
      if (vwap4H === 'OVER') vwapBonus += 4;
      if (vwap1H === 'UNDER' && vwap4H === 'UNDER') vwapPenalty += 5;
    }

    // Apply Anti-Bias Filters
    
    const sessionConfig = config.sessions?.[currentSession] || config.sessions?.['OFF'];
    if (currentDirection === 'SELL') {
      if (sessionConfig?.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0 && dailyStats.sellLossCount >= sessionConfig.maxSellLosses) return;
    } else if (currentDirection === 'BUY') {
      if (sessionConfig?.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0 && dailyStats.buyLossCount >= sessionConfig.maxBuyLosses) return;
    }

    // Spatial backing
    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
    const chOrigin = activeLeg ? activeLeg.origin : null;
    const chExtreme = activeLeg ? activeLeg.extreme : null;
    const spatialBuffer = Math.max(getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0), (state.atr14 ?? 0) * 0.25);

    let hasSpatialBacking = false;
    let spatialBonus = 0;
    const SPATIAL_WEIGHT: Record<string, number> = { '15': 1.0, '60': 1.5, '240': 2.0 };

    if (chOrigin) {
      for (const z of state.zones) {
        if (z.dir !== currentDirection) continue;
        if (chOrigin <= (z.top + spatialBuffer) && chOrigin >= (z.btm - spatialBuffer)) {
          hasSpatialBacking = true;
          spatialBonus = Math.max(spatialBonus, Math.round((SPATIAL_WEIGHT[z.tf || ''] || 1.0) * 5));
        }
      }
    }
    if (!hasSpatialBacking && chOrigin && chExtreme) {
      const chLow = Math.min(chOrigin, chExtreme);
      const chHigh = Math.max(chOrigin, chExtreme);
      for (const z of state.zones) {
        if (z.dir !== currentDirection) continue;
        if (chHigh >= (z.btm - spatialBuffer) && chLow <= (z.top + spatialBuffer)) {
          hasSpatialBacking = true;
          spatialBonus = Math.max(spatialBonus, Math.round((SPATIAL_WEIGHT[z.tf || ''] || 1.0) * 5));
        }
      }
    }

    let triggerEnabled = false;
    const baseMin = currentDirection === 'BUY' ? config.minBuyPoints : config.minSellPoints;
    let minPtsRequired = baseMin;
    
    if (sessionConfig) {
      const tfKeyChoch = `choch${eventTf}m` as keyof typeof sessionConfig;
      const tfKeyBos = `bos${eventTf}m` as keyof typeof sessionConfig;

      if (prefix === 'EVENTO_CHOCH') {
        const tfConfig = sessionConfig[tfKeyChoch] as any;
        if (tfConfig) {
            triggerEnabled = tfConfig.enabled ?? false;
            minPtsRequired = tfConfig.minScore ?? baseMin;
        } else if ((sessionConfig as any).choch) {
            triggerEnabled = (sessionConfig as any).choch.enabled ?? false;
            minPtsRequired = (sessionConfig as any).choch.minScore ?? baseMin;
        }
      } else if (prefix === 'EVENTO_BOS') {
        const tfConfig = sessionConfig[tfKeyBos] as any;
        if (tfConfig) {
            triggerEnabled = tfConfig.enabled ?? false;
            minPtsRequired = tfConfig.minScore ?? baseMin;
        } else if ((sessionConfig as any).bos) {
            triggerEnabled = (sessionConfig as any).bos.enabled ?? false;
            minPtsRequired = (sessionConfig as any).bos.minScore ?? baseMin;
        }
      }
    } else {
      if (prefix === 'EVENTO_BOS') {
        triggerEnabled = (config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
      } else {
        triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
      }
    }

    // Macro OTE bonus (ported from live)
    let macroOteBonus = 0;
    const activeMacroLeg = currentDirection === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
    const chExtremePriceForMacro = chExtreme ?? state.lastPrice ?? 0;
    if (isInsideMacroOteZone(activeMacroLeg, chExtremePriceForMacro)) {
      macroOteBonus = 6;
    }

    let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus - vwapPenalty + macroOteBonus;

    // Trap Zone penalty (Caso C - ported from live)
    if (chOrigin && chExtreme) {
      const chLow = Math.min(chOrigin, chExtreme);
      const chHigh = Math.max(chOrigin, chExtreme);
      const trapZoneCount = state.zones.filter(z =>
        z.dir !== currentDirection &&
        z.top >= chLow && z.btm <= chHigh
      ).length;
      if (trapZoneCount > 0) totalPoints -= trapZoneCount * 2;
    }

    if (hasSpatialBacking) totalPoints += spatialBonus;
    else {
      const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
      const hasSeqBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || e.includes('DIV_') || e.includes('Sweep_'));
      if (!hasSeqBacking) {
        const penalty = isCrypto ? 1 : 3;
        // Orphan penalty bypass for high score (ported from live)
        const wouldBeAfterPenalty = totalPoints - penalty;
        if (totalPoints >= 12 && wouldBeAfterPenalty >= 5) {
          // High-score bypass: penalty nullified
        } else {
          totalPoints -= penalty;
        }
      }
    }
    if (isDAgainst) totalPoints -= 2;
    if (is4HAgainst && is1HAgainst) totalPoints -= 3;

    // 🆕 MULTI-TF SCORE MULTIPLIER (Mejora 5)
    let scoreMultiplier = 1.0;
    const tradeDir = currentDirection;
    const biasD = freshBias('D') || freshBias('1D');
    const bias4H = freshBias('4H') || freshBias('240');
    const bias1H = freshBias('1H') || freshBias('60');

    let alignedTfs = 0;
    let againstTfs = 0;

    if (biasD === tradeDir) alignedTfs++;
    else if (biasD && biasD !== tradeDir) againstTfs++;

    if (bias4H === tradeDir) alignedTfs++;
    else if (bias4H && bias4H !== tradeDir) againstTfs++;

    if (bias1H === tradeDir) alignedTfs++;
    else if (bias1H && bias1H !== tradeDir) againstTfs++;

    if (alignedTfs >= 3) scoreMultiplier = 1.3;
    else if (againstTfs >= 2) scoreMultiplier = 0.6;
    else if (biasD && biasD !== tradeDir) scoreMultiplier = 0.8;

    totalPoints = Math.floor(totalPoints * scoreMultiplier);

    const se = dailyStats.sessionExp?.[`${currentSession}-${currentDirection}`];
    if (se && se.n >= 5) {
        const expR = se.sumR / se.n;
        if (expR < -0.3) minPtsRequired += 2;
        else if (expR < 0) minPtsRequired += 1;
        else if (expR > 0.5 && se.n >= 10) minPtsRequired = Math.max(minPtsRequired - 1, 3);
    }

    // Crypto: reduce minPtsRequired by 1 (ported from live)
    const isCryptoTicker = ticker.includes('BTC') || ticker.includes('ETH');
    if (isCryptoTicker) minPtsRequired = Math.max(minPtsRequired - 1, 3);

    // Escalado de umbral removido: la calidad de la señal debe ser constante.
    // Usaremos riskMult (Anti-martingala inversa) en su lugar.

    // Validate leg
    
    // Block moved up

    if (activeLeg) {
      const hasZoneConf = activeScore.events.some(e =>
        e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') ||
        e.includes('Sweep_') || e.includes('DIV_') || e.includes('Silver_Bullet_')
      );
      const efectiveValidation = hasZoneConf || hasSpatialBacking || (totalPoints >= minPtsRequired);
      activeLeg.isValidated = efectiveValidation;
      activeLeg.chochPoints = totalPoints;
      activeLeg.chochEvents = [...activeScore.events, `${prefix}_${parseTF(eventTf)}`];
      activeLeg.bestZone = state.zones.filter(z => z.dir === currentDirection).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

      if (efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired) {
        const decimals = getDecimals(ticker);
        const structuralBuffer = Math.max(
          2 * (config.spreadPips ?? 0.1) * pipSize,
          (state.atr14 ?? 0) * 0.5
        );
        const adjustedSL = currentDirection === 'BUY'
          ? activeLeg.origin - structuralBuffer
          : activeLeg.origin + structuralBuffer;
        const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;
        const stopLoss = adjustedSL.toFixed(decimals);
        const currentPrice = state.lastPrice ?? activeLeg.extreme;
        const riskDist = Math.abs(currentPrice - adjustedSL);
        const fixedTP1 = currentDirection === 'BUY' 
          ? currentPrice + riskDist 
          : currentPrice - riskDist;
        const tp1 = fixedTP1.toFixed(decimals);
        const fixedTP2 = currentDirection === 'BUY'
          ? currentPrice + (riskDist * activeFixedRR)
          : currentPrice - (riskDist * activeFixedRR);
        let tp2 = fixedTP2.toFixed(decimals);
        const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        let takeChoch = false;
        let disableOte = false;

        let oteSessionEnabled = false;
        if (sessionConfig) {
            const oteTfKeyChoch = `oteChoch${eventTf}m` as keyof typeof sessionConfig;
            const oteTfKeyBos = `oteBos${eventTf}m` as keyof typeof sessionConfig;

            if (prefix === 'EVENTO_CHOCH') {
                const tfConfig = sessionConfig[oteTfKeyChoch] as any;
                if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                else if ((sessionConfig as any).oteChoch) oteSessionEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
            } else {
                const tfConfig = sessionConfig[oteTfKeyBos] as any;
                if (tfConfig) oteSessionEnabled = tfConfig.enabled ?? false;
                else if ((sessionConfig as any).oteBos) oteSessionEnabled = (sessionConfig as any).oteBos.enabled ?? false;
            }
        } else {
            oteSessionEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
        }

        if (config.entryTrigger === 'SMART') {
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

            const signalTfMs = parseTfToMinutes(parseTF(eventTf));
            
            const oppositeZones = state.zones.filter(z => {
                if (z.dir === currentDirection) return false;
                if (z.medal === 'SMC_DIV') return false; 
                
                const zTfMs = parseTfToMinutes(z.tf || '');
                const isStrong = z.lvl === 'Strong' || z.medal?.includes('GOD');
                
                return isStrong || zTfMs >= signalTfMs;
            });

            let closestZonePrice = currentDirection === 'BUY' ? Infinity : 0;
            for (const z of oppositeZones) {
                if (currentDirection === 'BUY' && z.btm > currentPrice && z.btm < closestZonePrice) closestZonePrice = z.btm;
                else if (currentDirection === 'SELL' && z.top < currentPrice && z.top > closestZonePrice) closestZonePrice = z.top;
            }
            
            let rrChoch = 999.0; // Camino libre: sin zona opuesta el R:R teórico es infinito
            if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
                const rewardDist = Math.abs(closestZonePrice - currentPrice);
                rrChoch = riskDist > 0 ? rewardDist / riskDist : 0;
                tp2 = closestZonePrice.toFixed(decimals);
            }
        
            const MOMENTUM_EXTREMO_UMBRAL = (minPtsRequired || 8) + 5;
            const hasExtremeMomentum = totalPoints >= MOMENTUM_EXTREMO_UMBRAL;
            const minRR = config.minRR ?? 1.5;
            if (rrChoch >= minRR || hasExtremeMomentum) {
                takeChoch = true;
                disableOte = true;
            } else {
                takeChoch = false;
                disableOte = false;
            }
        } else if (config.entryTrigger === 'OTE') {
            takeChoch = false;
            disableOte = false;
        } else if (config.entryTrigger === 'BOTH') {
            takeChoch = true;
            disableOte = !oteSessionEnabled;
        } else {
            // CHOCH Only
            takeChoch = true;
            disableOte = true;
        }

        if (takeChoch) {
            const readableTf = parseTF(eventTf);
            const oteData = {
              tradeId, direction: currentDirection,
              entryPrice: currentPrice,
              stopLoss, tp1, tp2, points: totalPoints, events: [...activeScore.events, `${prefix}_${readableTf}`],
              tf: readableTf
            };
            createTrade(oteData, nowMs, trades, activeTrades, dailyStats, config, state);
            
            // ✅ Cooldown y reset SOLO cuando el trade realmente se dispara (idéntico a live)
            state.lastSniperAlert = nowMs;
            activeScore.points = 0; activeScore.events = [];
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            oppositeScore.points = 0; oppositeScore.events = [];
        } else if (!disableOte) {
            // Si va a esperar OTE, reseteamos score y ponemos cooldown, pero dejamos la pata habilitada
            state.lastSniperAlert = nowMs;
            activeScore.points = 0; activeScore.events = [];
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            oppositeScore.points = 0; oppositeScore.events = [];
        }

        if (disableOte) activeLeg.oteScored = true;
      }
    }
  }
}

// --- CREATE TRADE ---
function minutesSinceSessionOpen(ts: number): number {
    const d = new Date(ts - 3 * 3600 * 1000);
    const t = d.getUTCHours() * 60 + d.getUTCMinutes();
    const session = getSessionForTimestamp(ts);
    const openMin = session === 'LONDON' ? 240 : session === 'NY' ? 630 : session === 'ASIA' ? 1260 : -1;
    if (openMin < 0) return Infinity;
    let m = t - openMin; if (m < 0) m += 1440;
    return m;
}

function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig, state: any) {
  if (dailyStats.isKilled) return;

  const riskMult = dailyStats.consecutiveLosses >= 3 ? 0.25 :
                   dailyStats.consecutiveLosses >= 2 ? 0.5 : 1.0;
  oteData.riskMult = riskMult;

  const currentSession = getSessionForTimestamp(nowMs);
  if (config.sessionFilter && config.sessionFilter.length > 0) {
      if (!config.sessionFilter.includes(currentSession)) return;
  }

  const warmupMin = (config as any).sessionWarmupMin ?? 15;
  if ((currentSession === 'LONDON' || currentSession === 'NY') && minutesSinceSessionOpen(nowMs) < warmupMin) return;

  if (config.maxTradesPerSession && dailyStats.sessionTradeCount >= config.maxTradesPerSession) {
      return;
  }

  if (isNewsBlackout(nowMs)) return;

  // (c) Guardia al crear el trade + eliminar defaults mágicos
  // El path de gatillo directo pasa `stopLoss` (string); el path OTE pasa `slPrice` (number)
  const guardSl = parseFloat(oteData.stopLoss ?? oteData.slPrice);
  if (!isFinite(guardSl) || guardSl === oteData.entryPrice) return;

  // 🛡️ ANTI-PYRAMIDACIÓN & SAR
  let existingTradeForTicker: BacktestTrade | undefined;
  for (const t of activeTrades.values()) {
    existingTradeForTicker = t;
    break; // En standalone backtester asumimos 1 ticker (el config.ticker actual)
  }

  if (existingTradeForTicker) {
    if (existingTradeForTicker.direction === oteData.direction) {
      return; // Bloqueo de piramidación
    } else {
      if (oteData.points > existingTradeForTicker.points) {
        // Ejecutar SAR (Reversión)
        const currentPrice = state.lastPrice ?? existingTradeForTicker.entryPrice;
        const originalSl = existingTradeForTicker.originalSlPrice ?? existingTradeForTicker.slPrice;
        const slDist = Math.abs(originalSl - existingTradeForTicker.entryPrice);
        const pnlDist = existingTradeForTicker.direction === 'BUY'
          ? currentPrice - existingTradeForTicker.entryPrice
          : existingTradeForTicker.entryPrice - currentPrice;
        
        const pipSize = getPipValue(config.ticker, currentPrice);
        const riskPips = slDist / pipSize;
        const cls = getAssetClass(config.ticker);
        const commissionPerLot = config.commissionPerLot ?? defaultFrictionConfig[cls].commissionPerLot;
        const transactionCostR = riskPips > 0 ? (commissionPerLot * 2) / (riskPips * pipValuePerLotUsd(config.ticker, currentPrice)) : 0;
        
        const partialPct = config.partialClosePct ?? 0.5;
        const remainderPct = 1 - partialPct;
        const lockedPct = existingTradeForTicker.tp1Hit ? Math.abs(existingTradeForTicker.tp1Price - existingTradeForTicker.entryPrice) / existingTradeForTicker.entryPrice * 100 * partialPct : 0;
        const openPct = (pnlDist / existingTradeForTicker.entryPrice) * 100 * (existingTradeForTicker.tp1Hit ? remainderPct : 1.0);
        const slPct = (slDist / existingTradeForTicker.entryPrice) * 100;
        
        existingTradeForTicker.pnl = lockedPct + openPct;
        existingTradeForTicker.rMultiple = slPct > 0 ? ((lockedPct + openPct) / slPct - transactionCostR) * (existingTradeForTicker.riskMult || 1.0) : 0;
        existingTradeForTicker.result = existingTradeForTicker.rMultiple > 0 ? 'WIN' : existingTradeForTicker.rMultiple === 0 ? 'BE' : 'LOSS';
        
        existingTradeForTicker.resultTp2 = 'REVERSAL';
        if (!existingTradeForTicker.tp1Hit) existingTradeForTicker.resultTp1 = 'REVERSAL';
        existingTradeForTicker.closeTimestamp = nowMs;
        existingTradeForTicker.durationMin = Math.round((nowMs - existingTradeForTicker.timestamp) / 60000);
        activeTrades.delete(existingTradeForTicker.id);
        updateDailyStatsFromClose(existingTradeForTicker, dailyStats, config);
      } else {
        return; // Contra-tendencia más débil, ignorar entrada
      }
    }
  }

  let trade: BacktestTrade = {
    id: oteData.tradeId || (oteData.id),
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1 || oteData.tp1Price),
    tp2Price: parseFloat(oteData.tp2 || oteData.tp2Price) || 0,
    slPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    originalSlPrice: parseFloat(oteData.stopLoss || oteData.slPrice),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
    oteEntryUsed: oteData.oteEntryUsed,
    tf: oteData.tf,
    riskMult: oteData.riskMult,
  };

  // --- FRICTION MODEL INTERCEPTION ---
  const clsFriction = getAssetClass(config.ticker);
  const customFriction = {
    baseSpreadPips: config.spreadPips !== undefined ? config.spreadPips : defaultFrictionConfig[clsFriction].baseSpreadPips,
    commissionPerLot: config.commissionPerLot !== undefined ? config.commissionPerLot : defaultFrictionConfig[clsFriction].commissionPerLot,
    latencyMs: 50
  };
  const activeLike = {
    tradeId: trade.id,
    ticker: config.ticker,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    tp1Price: trade.tp1Price,
    tp2Price: trade.tp2Price,
    slPrice: trade.slPrice,
    tp1Hit: false,
    tp2Hit: false,
    score: trade.points,
    timestamp: trade.timestamp,
  } as any; // Still cast as any since ActiveTrade is in backend types, but matches shape perfectly
  const frictionResult = evaluateNetTrade(activeLike, nowMs, customFriction);
  if (!frictionResult.approved) {
    // Si la fricción lo rechaza (ej. spread mayor al 40% del SL, o RR Neto < 0.2)
    console.log('REJECTED BY FRICTION:', frictionResult.reason);
    return;
  }
  
  // Re-asignamos los precios que pudieron ser alterados por el spread/slippage
  trade.entryPrice = frictionResult.netTrade.entryPrice;
  trade.tp1Price = frictionResult.netTrade.tp1Price;
  trade.tp2Price = frictionResult.netTrade.tp2Price;
  trade.slPrice = frictionResult.netTrade.slPrice;

  trades.push(trade);
  activeTrades.set(trade.id, trade);

  dailyStats.tradeCount++;
  dailyStats.sessionTradeCount++;

  if (config.maxTradesPerDay && dailyStats.tradeCount >= config.maxTradesPerDay) {
    dailyStats.isKilled = true;
  }
}

export function isNewsBlackout(ts: number): boolean {
  const d = new Date(ts);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  const inW = (a: number, b: number) => t >= a && t <= b;
  const usData = inW(12 * 60 + 25, 14 * 60 + 10);
  const fomc = inW(17 * 60 + 55, 18 * 60 + 15) || inW(18 * 60 + 55, 19 * 60 + 15);
  return usData || fomc;
}
