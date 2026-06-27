import type {
  RadarZone, ImpulseLeg, RadarState, BacktestTrade,
  BacktestConfig, BacktestResult, LogEntry,
} from './backtestTypes';
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
}

function updateDailyStatsFromClose(trade: BacktestTrade, dailyStats: DailyStats, config: BacktestConfig) {
  if (trade.rMultiple !== undefined) {
    dailyStats.pnlR += trade.rMultiple;
    if (dailyStats.pnlR > dailyStats.peakPnlR) {
      dailyStats.peakPnlR = dailyStats.pnlR;
    }
    
    if (trade.result === 'LOSS') {
      dailyStats.consecutiveLosses++;
      if (trade.direction === 'SELL') dailyStats.sellLossCount++;
      if (trade.direction === 'BUY') dailyStats.buyLossCount++;
    } else if (trade.result === 'WIN') {
      dailyStats.consecutiveLosses = 0;
      if (trade.direction === 'SELL') dailyStats.sellLossCount = 0;
      if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
    }

    if (config.maxDailyLossR && dailyStats.pnlR <= -config.maxDailyLossR) dailyStats.isKilled = true;
    if (config.dailyProfitTargetR && dailyStats.pnlR >= config.dailyProfitTargetR) dailyStats.isKilled = true;
    if (config.maxConsecutiveLosses && dailyStats.consecutiveLosses >= config.maxConsecutiveLosses) dailyStats.isKilled = true;
    if (config.trailingDrawdownR && (dailyStats.peakPnlR - dailyStats.pnlR) >= config.trailingDrawdownR) dailyStats.isKilled = true;
  }
}

const SETUP_MEMORY_WINDOW_MS = 21600000;
const MAX_ZONE_AGE_MS: Record<string, number> = { '3': 1800000, '15': 21600000, '60': 28800000, '240': 86400000 };

// --- CSV PARSING ---
export function parseCSV(content: string): { lines: string[]; detectedTF: string } {
  const rows = content.split('\n').filter(l => l.trim().length > 0 && l.includes(' | TS: '));
  const lines = rows.map(r => {
    const firstComma = r.indexOf(',');
    return firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;
  });
  let tf = '3';
  for (const l of lines.slice(0, 10)) {
    const m = l.match(/TF:\s*(\d+)/i);
    if (m) { tf = m[1]; break; }
  }
  return { lines, detectedTF: tf };
}

// --- Dynamic SL Buffer Calculator ---
export function calculateDynamicSlBuffer(ticker: string, originPrice: number, bufferConfig: number): number {
  const t = ticker.toUpperCase();
  if (t.includes('JPY')) return bufferConfig * 0.1;
  const forexPairs = ['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
  if (forexPairs.some(fiat => t.includes(fiat)) && !t.includes('BTC') && !t.includes('ETH')) {
      return bufferConfig * 0.001;
  }
  const indices = ['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'];
  if (indices.some(idx => t.includes(idx))) return bufferConfig * 100;
  if (t.includes('XAU') || t.includes('GOLD')) return bufferConfig * 10;
  return originPrice * (bufferConfig / 100);
}

// --- GET SESSION FOR TIMESTAMP ---
export function getSessionForTimestamp(ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {
  const d = new Date(ts);
  const arHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
  const arMin = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', minute: 'numeric' }));
  const timeDecimal = arHour + arMin / 60;
  
  if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
  if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
  if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';
  
  return 'OFF';
}

// --- EVALUATE IMPULSE (ported from backend) ---
function evaluateImpulse(
  leg: ImpulseLeg | null | undefined, currentPrice: number,
  highPrice: number, lowPrice: number, ticker: string,
  state: RadarState, nowMs: number, config: BacktestConfig
): { updatedLeg: ImpulseLeg | null; triggerOte?: boolean; oteData?: any } {
  if (!leg) return { updatedLeg: null };

  const MAX_LEG_AGE_MS = 4 * 60 * 60 * 1000;
  if (leg.createdAt && (nowMs - leg.createdAt) > MAX_LEG_AGE_MS) return { updatedLeg: null };

  const legScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
  const oppositeScore = leg.dir === 'BUY' ? state.scoreSell : state.scoreBuy;
  if (oppositeScore.points >= legScore.points * 3 && oppositeScore.points >= 9 && (nowMs - oppositeScore.lastUpdate) < 900000)
    return { updatedLeg: null };

  const range = Math.abs(leg.extreme - leg.origin);
  const atrEst = range * 0.3;
  const beyond = leg.dir === 'BUY' ? (currentPrice > leg.extreme + atrEst) : (currentPrice < leg.extreme - atrEst);
  if (beyond && leg.createdAt && (nowMs - leg.createdAt) > 30 * 60 * 1000) return { updatedLeg: null };

  if (leg.dir === 'BUY' && highPrice > leg.extreme) leg.extreme = highPrice;
  else if (leg.dir === 'SELL' && lowPrice < leg.extreme) leg.extreme = lowPrice;

  let impulseInvalidated = false;
  if (leg.dir === 'BUY' && lowPrice < leg.origin) impulseInvalidated = true;
  else if (leg.dir === 'SELL' && highPrice > leg.origin) impulseInvalidated = true;

  if (!impulseInvalidated) {
    const r2 = Math.abs(leg.extreme - leg.origin);
    
    // --- RESOLUCIÓN DINÁMICA DE OTE ENTRY PERCENT POR SESIÓN Y GATILLO ---
    const session = getSessionForTimestamp(nowMs);
    const sessionConfig = config.sessions?.[session] || config.sessions?.['OFF'];
    const isChoch = leg.chochEvents?.some(e => e.includes('CHOCH') || e.includes('CHoCH'));
    const isBos = leg.chochEvents?.some(e => e.includes('BOS'));

    let activeOteEntryPercent = config.oteEntryPercent || 50;
    if (sessionConfig) {
      const triggerTfStr = leg.chochEvents?.map(e => {
          const parts = e.split('_');
          return parts[parts.length - 1];
      }).find(tf => tf === '3M' || tf === '5M' || tf === '15M') || '';
      const triggerTf = triggerTfStr.toLowerCase();

      if (isChoch) {
        const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
        const tfConfig = sessionConfig[tfKey] as any;
        if (tfConfig) activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
        else if ((sessionConfig as any).oteChoch) activeOteEntryPercent = (sessionConfig as any).oteChoch.entryPercent ?? config.oteEntryPercent ?? 50;
      } else if (isBos) {
        const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
        const tfConfig = sessionConfig[tfKey] as any;
        if (tfConfig) activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
        else if ((sessionConfig as any).oteBos) activeOteEntryPercent = (sessionConfig as any).oteBos.entryPercent ?? config.oteEntryPercent ?? 50;
      }
    }

    const fibRatio = activeOteEntryPercent / 100;
    const entryLevel = leg.dir === 'BUY' ? leg.extreme - (r2 * fibRatio) : leg.extreme + (r2 * fibRatio);

    const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;

    if (isEntryHit && !leg.oteScored) {
      let oteEnabled = false;
      let oteMinScore = 8;

      const triggerTfStr = leg.chochEvents?.map(e => {
          const parts = e.split('_');
          return parts[parts.length - 1];
      }).find(tf => tf === '3M' || tf === '5M' || tf === '15M') || '';
      const triggerTf = triggerTfStr.toLowerCase();

      if (sessionConfig) {

        if (isChoch) {
          const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
          const tfConfig = sessionConfig[tfKey] as any;
          if (tfConfig) {
              oteEnabled = tfConfig.enabled ?? false;
              oteMinScore = tfConfig.minScore ?? 8;
          } else if ((sessionConfig as any).oteChoch) {
              oteEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
              oteMinScore = (sessionConfig as any).oteChoch.minScore ?? 8;
          }
        } else if (isBos) {
          const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
          const tfConfig = sessionConfig[tfKey] as any;
          if (tfConfig) {
              oteEnabled = tfConfig.enabled ?? false;
              oteMinScore = tfConfig.minScore ?? 8;
          } else if ((sessionConfig as any).oteBos) {
              oteEnabled = (sessionConfig as any).oteBos.enabled ?? false;
              oteMinScore = (sessionConfig as any).oteBos.minScore ?? 8;
          }
        } else {
          oteEnabled = false;
          oteMinScore = 8;
        }
      } else {
        oteEnabled = (config.entryTrigger === 'OTE' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
        oteMinScore = 8;
      }

      const totalPoints = (leg.chochPoints || 0) + 4;

      if (sessionConfig) {
        if (!oteEnabled || totalPoints < oteMinScore) {
          return { updatedLeg: leg };
        }
      } else {
        const MIN_OTE_POINTS = oteMinScore;
        if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS)
          return { updatedLeg: leg };
        if (!oteEnabled || totalPoints < oteMinScore)
          return { updatedLeg: leg };
      }

      const riskDist = r2 * 0.21;
      const rewardDist = r2 * 0.50;
      if (riskDist > 0 && rewardDist / riskDist < 1.2) return { updatedLeg: leg };

      const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
      const tfFormatted = triggerTf.toUpperCase();
      const eventName = `🎯_OTE_Retracement_${tfFormatted}`;
      if (!activeScore.events.includes(eventName)) {
        activeScore.events.push(eventName);
        activeScore.points += 4;
        activeScore.lastUpdate = nowMs;
        leg.oteScored = true;

        const decimals = getDecimals(ticker);
        const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const activeSlBufferPercent = sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? 0;
        const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;

        const slBufferAmt = calculateDynamicSlBuffer(ticker, leg.origin, activeSlBufferPercent);
        const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBufferAmt : leg.origin + slBufferAmt;
        
        return {
          updatedLeg: leg, triggerOte: oteEnabled,
          oteData: {
            tradeId, direction: leg.dir,
            entryPrice: entryLevel,
            stopLoss: adjustedSL.toFixed(decimals),
            tp1: leg.extreme.toFixed(decimals),
            tp2: (() => {
              const riskDist = Math.abs(entryLevel - adjustedSL);
              const fixedTP2 = leg.dir === 'BUY'
                ? entryLevel + (riskDist * activeFixedRR)
                : entryLevel - (riskDist * activeFixedRR);
              return fixedTP2.toFixed(decimals);
            })(),
            points: totalPoints,
            events: [...(leg.chochEvents || []), eventName],
            bestZone: leg.bestZone || null,
            marketBias: { ...state.marketBias },
            oteEntryUsed: activeOteEntryPercent,
            tf: tfFormatted
          }
        };
      }
    }
  }
  return { updatedLeg: impulseInvalidated ? null : leg };
}

// --- MAIN BACKTEST RUNNER ---
export function runBacktest(
  logs: Map<string, string[]>,
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
    buyLossCount: 0
  };

  // 1. Parse all entries with timestamps
  const allEntries: LogEntry[] = [];
  for (const [tf, lines] of logs.entries()) {
    for (const line of lines) {
      const tsMatch = line.match(/TS:\s*(\d+)/i);
      allEntries.push({ ts: tsMatch ? parseInt(tsMatch[1], 10) : 0, line, tf });
    }
  }

  // 2. Sort chronologically
  const validEntries = allEntries.filter(e => e.ts > 0).sort((a, b) => a.ts - b.ts);
  if (validEntries.length === 0) {
    return { trades: [], totalEvents: 0, processedEvents: 0, startDate: 'N/A', endDate: 'N/A' };
  }

  // 3. Pre-sync: process SYNC_ZONES first
  const syncEntries = validEntries.filter(e => e.line.includes('SYNC_ZONES'));
  const restEntries = validEntries.filter(e => !e.line.includes('SYNC_ZONES'));

  for (const entry of syncEntries) {
    processAlert(entry.line, entry.ts, state, config, trades, activeTrades, dailyStats);
  }

  // 4. Process rest chronologically
  const total = restEntries.length;
  let lastProgressPct = 0;
  for (let i = 0; i < total; i++) {
    processAlert(restEntries[i].line, restEntries[i].ts, state, config, trades, activeTrades, dailyStats);
    const pct = Math.floor((i / total) * 100);
    if (onProgress && pct > lastProgressPct && pct % 5 === 0) {
      lastProgressPct = pct;
      onProgress(pct, [...trades]);
    }
  }

  // Close remaining active trades as TIMEOUT
  for (const [, trade] of activeTrades) {
    trade.result = 'TIMEOUT';
    trade.closeTimestamp = validEntries[validEntries.length - 1].ts;
  }

  if (onProgress) onProgress(100, [...trades]);

  return {
    trades,
    totalEvents: validEntries.length,
    processedEvents: syncEntries.length + total,
    startDate: new Date(validEntries[0].ts).toISOString().split('T')[0],
    endDate: new Date(validEntries[validEntries.length - 1].ts).toISOString().split('T')[0],
  };
}

// --- PROCESS SINGLE ALERT (ported from backend processTradingAlert) ---
function processAlert(
  alertText: string, nowMs: number, state: RadarState,
  config: BacktestConfig, trades: BacktestTrade[],
  activeTrades: Map<string, BacktestTrade>,
  dailyStats: DailyStats
) {
  const textUpToPayload = alertText.includes('Payload:') ? alertText.split('Payload:')[0] : alertText;
  const parts = textUpToPayload.split(/[,|]/).map(p => p.trim());
  if (parts.length < 2) return;

  const prefix = parts[0].toUpperCase();
  const ticker = config.ticker;
  const upperText = alertText.toUpperCase();

  const tfMatch = alertText.match(/TF:\s*([a-zA-Z0-9]+)/i);
  const eventTf = tfMatch ? tfMatch[1] : 'UNKNOWN';
  const readableTf = parseTF(eventTf);
  const todayStr = new Date(nowMs).toISOString().split('T')[0];
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
  }

  let currentDirection: 'BUY' | 'SELL' | null = null;
  if (upperText.includes('BUY') || upperText.includes('BULLISH')) currentDirection = 'BUY';
  else if (upperText.includes('SELL') || upperText.includes('BEARISH')) currentDirection = 'SELL';

  if (!state.scoreBuy) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
  if (!state.scoreSell) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };
  if (nowMs - state.scoreBuy.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreBuy = { points: 0, lastUpdate: nowMs, events: [] };
  if (nowMs - state.scoreSell.lastUpdate > SETUP_MEMORY_WINDOW_MS) state.scoreSell = { points: 0, lastUpdate: nowMs, events: [] };

  // --- SYNC_ZONES ---
  if (prefix === 'SYNC_ZONES') {
    if (!alertText.includes('Payload:')) return;
    const sourceTf = eventTf;
    const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
    const trendMatch = alertText.match(/Trend:\s*(BUY|SELL)/i);
    if (trendMatch) state.marketBias[sourceTf] = trendMatch[1].toUpperCase();

    try {
      const rawZones = JSON.parse(payloadStr) as Record<string, unknown>[];
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
    const priceMatch = alertText.match(/Precio:\s*([0-9.]+)/i);
    if (!priceMatch) return;
    const currentPrice = parseFloat(priceMatch[1]);
    const highMatch = alertText.match(/High:\s*([0-9.]+)/i);
    const lowMatch = alertText.match(/Low:\s*([0-9.]+)/i);
    const highPrice = highMatch ? parseFloat(highMatch[1]) : currentPrice;
    const lowPrice = lowMatch ? parseFloat(lowMatch[1]) : currentPrice;

    const previousPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.previousPrice = previousPrice;

    // Evaluate impulse legs
    const buyRes = evaluateImpulse(state.activeImpulseBuy, currentPrice, highPrice, lowPrice, ticker, state, nowMs, config);
    state.activeImpulseBuy = buyRes.updatedLeg;
    if (buyRes.triggerOte && buyRes.oteData) createTrade(buyRes.oteData, nowMs, trades, activeTrades, dailyStats, config);

    const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, config);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.triggerOte && sellRes.oteData) createTrade(sellRes.oteData, nowMs, trades, activeTrades, dailyStats, config);

    // Evaluate active trades TP/SL
    for (const [tradeId, trade] of activeTrades) {
      const tradeAge = nowMs - trade.timestamp;
      if (tradeAge < 5000) continue;

      // TP1
      if (!trade.tp1Hit) {
        const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
        if (tp1Hit) {
          trade.tp1Hit = true;
          const slLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
          trade.slPrice = trade.entryPrice; // Move SL to entry price (BE)
          trade.resultTp1 = 'WIN';
          trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
          trade.rMultipleTp1 = slLossPct > 0 ? (trade.pnlTp1 / slLossPct) * 0.5 : 0.5;
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
          const finalPnl = trade.tp1Hit ? (pnlTp1 * 0.5 + pnlTp2 * 0.5) : pnlTp2;
          
          trade.pnl = finalPnl;
          trade.pnlTp2 = finalPnl;
          const originalSl = trade.originalSlPrice ?? trade.slPrice;
          const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
          trade.rMultiple = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 1.5;
          trade.rMultipleTp2 = initialSlLossPct > 0 ? (pnlTp2 / initialSlLossPct) * 0.5 : 0.75;
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          updateDailyStatsFromClose(trade, dailyStats, config);
          continue;
        }
      }

      // SL
      const slHit = trade.direction === 'BUY' ? lowPrice <= trade.slPrice : highPrice >= trade.slPrice;
      if (slHit) {
        const isPartialClose = trade.tp1Hit;
        const currentSlLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100; // should be 0 if moved to BE
        const pnlTp1Pct = trade.tp1Hit ? Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100 : 0;
        const finalPnlPct = isPartialClose ? (pnlTp1Pct * 0.5 - currentSlLossPct * 0.5) : -currentSlLossPct;
        const finalResult = isPartialClose ? (finalPnlPct >= 0 ? 'BE' : 'LOSS') : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        trade.rMultiple = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        
        if (!isPartialClose) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = -initialSlLossPct;
          trade.rMultipleTp1 = undefined; // Don't show confusing -50 in TP1
          trade.rMultipleTp2 = undefined; // Don't show confusing -50 in TP2
        } else {
          trade.rMultipleTp2 = 0.0;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
        updateDailyStatsFromClose(trade, dailyStats, config);
        continue;
      }

      // Timeout: 6 hours
      if (tradeAge > 6 * 60 * 60 * 1000) {
        trade.result = 'TIMEOUT';
        trade.resultTp2 = 'TIMEOUT';
        if (!trade.tp1Hit) trade.resultTp1 = 'TIMEOUT';
        
        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round(tradeAge / 60000);
        activeTrades.delete(tradeId);
      }
    }

    // Zone touching (scoring)
    const buffer = getBuffer(ticker, currentPrice);
    for (const zone of state.zones) {
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

    // Zone age cleanup
    state.zones = state.zones.filter(z => !z.createdAt || (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000));
    return;
  }

  // --- EVENTS WITH DIRECTION ---
  if (!currentDirection) return;
  const activeScore = currentDirection === 'BUY' ? state.scoreBuy : state.scoreSell;
  let addedPoints = 0;

  if (prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') {
    state.marketBias[eventTf] = currentDirection;

    if (eventTf === '5' || eventTf === '15') {
      const originMatch = alertText.match(/ORIGIN:\s*([0-9.]+)/i);
      const priceMatchChoch = alertText.match(/Precio:\s*([0-9.]+)/i);
      const actualPrice = priceMatchChoch ? parseFloat(priceMatchChoch[1]) : state.lastPrice || 0;

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
          if (isBuy) state.activeImpulseBuy = newLeg;
          else state.activeImpulseSell = newLeg;
        }
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
      if (upperText.includes('ABSORCION')) { addedPoints = 6; activeScore.events.push(`🩸_V-Shape_Absorb_${readableTf}`); }
      else { addedPoints = 3; activeScore.events.push(`Sweep_${readableTf}`); }
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

  // --- CHoCH/BOS TRIGGER VALIDATION ---
  if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && (eventTf === '5' || eventTf === '15')) {
    if (nowMs - (state.lastSniperAlert ?? 0) < 180000) return;

    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';
    const baseBiasPoints = isMacroAligned ? 5 : 0;

    let vwapBonus = 0;
    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') vwapBonus = 2;
    else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') vwapBonus = 2;

    let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus;

    // Apply Anti-Bias Filters
    const session = getSessionForTimestamp(nowMs);
    const sessionConfig = config.sessions?.[session] || config.sessions?.['OFF'];
    if (currentDirection === 'SELL') {
      if (sessionConfig?.maxSellLosses !== undefined && sessionConfig.maxSellLosses > 0 && dailyStats.sellLossCount >= sessionConfig.maxSellLosses) return;
    } else if (currentDirection === 'BUY') {
      if (sessionConfig?.maxBuyLosses !== undefined && sessionConfig.maxBuyLosses > 0 && dailyStats.buyLossCount >= sessionConfig.maxBuyLosses) return;
    }

    // Spatial backing
    const activeLeg = currentDirection === 'BUY' ? state.activeImpulseBuy : state.activeImpulseSell;
    const chOrigin = activeLeg ? activeLeg.origin : null;
    const chExtreme = activeLeg ? activeLeg.extreme : null;
    const spatialBuffer = getBuffer(ticker, chOrigin ?? state.lastPrice ?? 0);

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
    let minPtsRequired = currentDirection === 'BUY' ? config.minBuyPoints : config.minSellPoints;
    
    if (sessionConfig) {
      const tfKeyChoch = `choch${eventTf}m` as keyof typeof sessionConfig;
      const tfKeyBos = `bos${eventTf}m` as keyof typeof sessionConfig;

      if (prefix === 'EVENTO_CHOCH') {
        const tfConfig = sessionConfig[tfKeyChoch] as any;
        if (tfConfig) {
            triggerEnabled = tfConfig.enabled ?? false;
            minPtsRequired = tfConfig.minScore ?? config.minBuyPoints;
        } else if ((sessionConfig as any).choch) {
            triggerEnabled = (sessionConfig as any).choch.enabled ?? false;
            minPtsRequired = (sessionConfig as any).choch.minScore ?? config.minBuyPoints;
        }
      } else if (prefix === 'EVENTO_BOS') {
        const tfConfig = sessionConfig[tfKeyBos] as any;
        if (tfConfig) {
            triggerEnabled = tfConfig.enabled ?? false;
            minPtsRequired = tfConfig.minScore ?? config.minBuyPoints;
        } else if ((sessionConfig as any).bos) {
            triggerEnabled = (sessionConfig as any).bos.enabled ?? false;
            minPtsRequired = (sessionConfig as any).bos.minScore ?? config.minBuyPoints;
        }
      }
    } else {
      if (prefix === 'EVENTO_BOS') {
        triggerEnabled = (config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
      } else {
        triggerEnabled = (config.entryTrigger === 'CHOCH' || config.entryTrigger === 'BOTH' || config.entryTrigger === 'SMART');
      }
    }

    if (hasSpatialBacking) totalPoints += spatialBonus;
    else {
      const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
      const hasSeqBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || e.includes('DIV_') || e.includes('Sweep_'));
      if (!hasSeqBacking) {
        const penalty = isCrypto ? 1 : 3;
        if (totalPoints < minPtsRequired) totalPoints -= penalty;
      }
    }
    if (is4HAgainst && is1HAgainst) totalPoints -= 3;

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
      activeLeg.chochEvents = [...activeScore.events, prefix];
      activeLeg.bestZone = state.zones.filter(z => z.dir === currentDirection).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

      if (efectiveValidation && triggerEnabled && totalPoints >= minPtsRequired) {
        const decimals = getDecimals(ticker);
        const activeSlBufferPercent = sessionConfig?.slBufferPercent ?? config.slBufferPercent ?? 0;
        const activeFixedRR = sessionConfig?.fixedRR ?? config.fixedRR ?? 2.0;

        const slBufferAmt = calculateDynamicSlBuffer(ticker, activeLeg.origin, activeSlBufferPercent);
        const adjustedSL = currentDirection === 'BUY' ? activeLeg.origin - slBufferAmt : activeLeg.origin + slBufferAmt;
        const stopLoss = adjustedSL.toFixed(decimals);
        const currentPrice = state.lastPrice || (currentDirection === 'BUY' ? activeLeg.extreme : activeLeg.extreme);
        const riskDist = Math.abs(currentPrice - adjustedSL);
        const fixedTP1 = currentDirection === 'BUY' 
          ? currentPrice + riskDist 
          : currentPrice - riskDist;
        const tp1 = fixedTP1.toFixed(decimals);
        const fixedTP2 = currentDirection === 'BUY'
          ? currentPrice + (riskDist * activeFixedRR)
          : currentPrice - (riskDist * activeFixedRR);
        const tp2 = fixedTP2.toFixed(decimals);
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
            const oppositeZones = state.zones.filter(z => z.dir !== currentDirection);
            let closestZonePrice = currentDirection === 'BUY' ? Infinity : 0;
            for (const z of oppositeZones) {
                if (currentDirection === 'BUY' && z.btm > currentPrice && z.btm < closestZonePrice) closestZonePrice = z.btm;
                else if (currentDirection === 'SELL' && z.top < currentPrice && z.top > closestZonePrice) closestZonePrice = z.top;
            }
            
            let rrChoch = 3.0; // Default optimista
            if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
                const rewardDist = Math.abs(closestZonePrice - currentPrice);
                rrChoch = riskDist > 0 ? rewardDist / riskDist : 3.0;
            }
        
            if (rrChoch >= 1.5) {
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
            createTrade(oteData, nowMs, trades, activeTrades, dailyStats, config);
        }
        
        if (disableOte) activeLeg.oteScored = true;
      }

      if (totalPoints >= minPtsRequired) {
        const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
        oppositeScore.points = 0; oppositeScore.events = [];
      }
      state.lastSniperAlert = nowMs;
      activeScore.points = 0; activeScore.events = [];
    }
  }
}

// --- CREATE TRADE ---
function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig) {
  if (dailyStats.isKilled) return;
  const trade: BacktestTrade = {
    id: oteData.tradeId,
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1),
    tp2Price: parseFloat(oteData.tp2) || 0,
    slPrice: parseFloat(oteData.stopLoss),
    originalSlPrice: parseFloat(oteData.stopLoss),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
    oteEntryUsed: oteData.oteEntryUsed,
    tf: oteData.tf,
  };
  trades.push(trade);
  activeTrades.set(trade.id, trade);

  dailyStats.tradeCount++;

  if (config.maxTradesPerDay && dailyStats.tradeCount >= config.maxTradesPerDay) {
    dailyStats.isKilled = true;
  }
}
