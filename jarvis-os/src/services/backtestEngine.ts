import type {
  RadarZone, ImpulseLeg, RadarState, BacktestTrade,
  BacktestConfig, BacktestResult, LogEntry,
} from './backtestTypes';
import {
  emptyState, normalizeZone, parseTF, getBuffer, getDecimals
} from './backtestTypes';

export type { BacktestTrade, BacktestResult } from './backtestTypes';

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
    const fibRatio = (config.oteEntryPercent || 50) / 100;
    const entryLevel = leg.dir === 'BUY' ? leg.extreme - (r2 * fibRatio) : leg.extreme + (r2 * fibRatio);

    const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;

    if (isEntryHit && !leg.oteScored) {
      const MIN_OTE_POINTS = 8;
      if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS)
        return { updatedLeg: leg };

      const riskDist = r2 * 0.21;
      const rewardDist = r2 * 0.50;
      if (riskDist > 0 && rewardDist / riskDist < 1.2) return { updatedLeg: leg };

      const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
      const eventName = '🎯_OTE_Retracement_3M';
      if (!activeScore.events.includes(eventName)) {
        activeScore.events.push(eventName);
        activeScore.points += 4;
        activeScore.lastUpdate = nowMs;
        leg.oteScored = true;

        const decimals = getDecimals(ticker);
        const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const slBufferAmt = leg.origin * ((config.slBufferPercent || 0) / 100);
        const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBufferAmt : leg.origin + slBufferAmt;
        return {
          updatedLeg: leg, triggerOte: true,
          oteData: {
            tradeId, direction: leg.dir,
            entryPrice: entryLevel, // Use precise entry level
            stopLoss: adjustedSL.toFixed(decimals),
            tp1: leg.extreme.toFixed(decimals),
            tp2: (() => {
              const riskDist = Math.abs(entryLevel - adjustedSL);
              const fixedTP2 = leg.dir === 'BUY'
                ? entryLevel + (riskDist * (config.fixedRR || 2.0))
                : entryLevel - (riskDist * (config.fixedRR || 2.0));
              return fixedTP2.toFixed(decimals);
            })(),
            points: (leg.chochPoints || 0) + 4,
            events: [...(leg.chochEvents || []), eventName],
            bestZone: leg.bestZone || null,
            marketBias: { ...state.marketBias },
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
    processAlert(entry.line, entry.ts, state, config, trades, activeTrades);
  }

  // 4. Process rest chronologically
  const total = restEntries.length;
  let lastProgressPct = 0;
  for (let i = 0; i < total; i++) {
    processAlert(restEntries[i].line, restEntries[i].ts, state, config, trades, activeTrades);
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
  activeTrades: Map<string, BacktestTrade>
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
    if (buyRes.triggerOte && buyRes.oteData) createTrade(buyRes.oteData, nowMs, trades, activeTrades);

    const sellRes = evaluateImpulse(state.activeImpulseSell, currentPrice, highPrice, lowPrice, ticker, state, nowMs, config);
    state.activeImpulseSell = sellRes.updatedLeg;
    if (sellRes.triggerOte && sellRes.oteData) createTrade(sellRes.oteData, nowMs, trades, activeTrades);

    // Evaluate active trades TP/SL
    for (const [tradeId, trade] of activeTrades) {
      const tradeAge = nowMs - trade.timestamp;
      if (tradeAge < 5000) continue;

      // TP1
      if (!trade.tp1Hit) {
        const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
        if (tp1Hit) {
          trade.tp1Hit = true;
          trade.slPrice = trade.entryPrice; // Move SL to break even
          trade.resultTp1 = 'WIN';
          trade.pnlTp1 = Math.abs(trade.tp1Price - trade.entryPrice) / trade.entryPrice * 100;
        }
      }

      // TP2
      if (trade.tp2Price > 0) {
        const tp2Hit = trade.direction === 'BUY' ? highPrice >= trade.tp2Price : lowPrice <= trade.tp2Price;
        if (tp2Hit) {
          trade.result = 'WIN';
          trade.resultTp2 = 'WIN';
          const pnl = Math.abs(trade.tp2Price - trade.entryPrice) / trade.entryPrice * 100;
          trade.pnl = pnl;
          trade.pnlTp2 = pnl;
          trade.closeTimestamp = nowMs;
          trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
          activeTrades.delete(tradeId);
          continue;
        }
      }

      // SL
      const slHit = trade.direction === 'BUY' ? lowPrice <= trade.slPrice : highPrice >= trade.slPrice;
      if (slHit) {
        trade.result = trade.tp1Hit ? 'BE' : 'LOSS';
        const lossPnl = -(Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100);
        
        trade.pnl = trade.tp1Hit ? 0 : lossPnl;
        trade.resultTp2 = trade.tp1Hit ? 'BE' : 'LOSS';
        trade.pnlTp2 = trade.tp1Hit ? 0 : lossPnl;
        
        if (!trade.tp1Hit) {
          trade.resultTp1 = 'LOSS';
          trade.pnlTp1 = lossPnl;
        }

        trade.closeTimestamp = nowMs;
        trade.durationMin = Math.round((nowMs - trade.timestamp) / 60000);
        activeTrades.delete(tradeId);
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

    if (eventTf === '3') {
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

  // --- CHoCH/BOS TRIGGER VALIDATION (3M only) ---
  if ((prefix === 'EVENTO_CHOCH' || prefix === 'EVENTO_BOS') && eventTf === '3') {
    if (nowMs - (state.lastSniperAlert ?? 0) < 180000) return;

    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';
    const baseBiasPoints = isMacroAligned ? 5 : 0;

    let vwapBonus = 0;
    if (upperText.includes('VWAP: UNDER') && currentDirection === 'BUY') vwapBonus = 2;
    else if (upperText.includes('VWAP: OVER') && currentDirection === 'SELL') vwapBonus = 2;

    let totalPoints = activeScore.points + baseBiasPoints + 2 + vwapBonus;

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

    if (hasSpatialBacking) totalPoints += spatialBonus;
    else {
      const isCrypto = ticker.includes('BTC') || ticker.includes('ETH');
      const hasSeqBacking = activeScore.events.some(e => e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') || e.includes('DIV_') || e.includes('Sweep_'));
      if (!hasSeqBacking) {
        const penalty = isCrypto ? 1 : 3;
        if (totalPoints < 12) totalPoints -= penalty;
      }
    }
    if (is4HAgainst && is1HAgainst) totalPoints -= 3;

    // Validate leg
    const minPtsRequired = currentDirection === 'BUY' ? config.minBuyPoints : config.minSellPoints;
    if (totalPoints >= Math.max(minPtsRequired - 3, 5) && activeLeg) {
      const hasZoneConf = activeScore.events.some(e =>
        e.includes('OB_') || e.includes('GOD_') || e.includes('Breaker_') ||
        e.includes('Sweep_') || e.includes('DIV_') || e.includes('Silver_Bullet_')
      );
      const efectiveValidation = hasZoneConf || hasSpatialBacking || (totalPoints >= 12);
      activeLeg.isValidated = efectiveValidation;
      activeLeg.chochPoints = totalPoints;
      activeLeg.chochEvents = [...activeScore.events];
      activeLeg.bestZone = state.zones.filter(z => z.dir === currentDirection).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

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
function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>) {
  const trade: BacktestTrade = {
    id: oteData.tradeId,
    timestamp: nowMs,
    direction: oteData.direction,
    entryPrice: oteData.entryPrice,
    tp1Price: parseFloat(oteData.tp1),
    tp2Price: parseFloat(oteData.tp2) || 0,
    slPrice: parseFloat(oteData.stopLoss),
    points: oteData.points,
    events: oteData.events || [],
    grade: oteData.points >= 8 ? 'A+' : 'B',
  };
  trades.push(trade);
  activeTrades.set(trade.id, trade);
}
