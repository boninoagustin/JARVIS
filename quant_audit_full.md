# Contexto
Jarvis es un sistema algorítmico de análisis de mercados y backtesting (procesa señales SMC/Pine Script). El backend está en Node.js y el frontend en React. La precisión matemática, la consistencia del estado y el rendimiento son críticos.

# Tarea
Realiza un Code Review profundo de los archivos referenciados. Como la arquitectura base y los cuellos de botella ya fueron optimizados, enfócate en la lógica algorítmica y el comportamiento de trading.

# Foco de la auditoría:
1. LÓGICA DE TRADING (SMC/FIBO): ¿Hay ineficiencias matemáticas en cómo se calculan las zonas OTE, el trailing stop (Breakeven) o el ratio Riesgo/Beneficio (R)?
2. GESTIÓN DE RIESGO: ¿Hay vulnerabilidades en el PortfolioModel o en el control de rachas perdedoras (consecutiveLosses)?
3. MEJORAS CUANTITATIVAS: Sugiere enfoques matemáticos o filtros (por ejemplo, análisis de volumen, ATR o manipulación de tiempo) que podrían aplicarse para mejorar la tasa de acierto del bot y proteger el capital.

# Formato de Salida Obligatorio:
No expliques qué hace el código. Ve directo a los hallazgos y sugerencias:
- [🟢 Mejora Cuantitativa | 🟣 Lógica SMC | 🔴 Bug Lógico] - `Archivo` -> `Función`
- **Problema/Oportunidad**: Breve explicación del concepto.
- **Solución**: Código refactorizado o fórmula a aplicar.


# Archivos para auditar


## jarvis-os/src/services/backtestEngine.ts
```typescript
import type {
  RadarZone, ImpulseLeg, RadarState, BacktestTrade,
  BacktestConfig, BacktestResult, LogEntry, ParsedAlert,
} from './backtestTypes';
import { evaluateImpulseCore, evaluateMacroStretching, isInsideMacroOteZone, calculateDynamicSlBuffer, SETUP_MEMORY_WINDOW_MS } from '../engine/AlphaModel';
import { getPipValue } from '../engine/FrictionModel';
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
}

function updateDailyStatsFromClose(trade: BacktestTrade, dailyStats: DailyStats, config: BacktestConfig) {
  if (trade.rMultiple === undefined || Number.isNaN(trade.rMultiple)) return;

  dailyStats.pnlR += trade.rMultiple;
  if (dailyStats.pnlR > dailyStats.peakPnlR) {
    dailyStats.peakPnlR = dailyStats.pnlR;
  }
  
  if (trade.result === 'LOSS') {
    dailyStats.consecutiveLosses++;
    if (trade.direction === 'SELL') dailyStats.sellLossCount++;
    if (trade.direction === 'BUY') dailyStats.buyLossCount++;
  } else if (trade.result === 'WIN' || trade.result === 'BE') {
    dailyStats.consecutiveLosses = 0;
    if (trade.direction === 'SELL') dailyStats.sellLossCount = 0;
    if (trade.direction === 'BUY') dailyStats.buyLossCount = 0;
  }

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
  const rows = content.split(/\r?\n/);
  for (const r of rows) {
    if (r.trim().length === 0 || !r.includes(' | TS: ')) continue;
    const firstComma = r.indexOf(',');
    const line = firstComma > 0 ? r.substring(firstComma + 1).replace(/^"|"$/g, '') : r;
    if (seen.has(line)) continue;
    seen.add(line);
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

  // 3. Pre-sync: process SYNC_ZONES first
  const syncEntries = validEntries.filter(e => e.line.includes('SYNC_ZONES'));
  const restEntries = validEntries.filter(e => !e.line.includes('SYNC_ZONES'));
  
  const initialPrice = validEntries.find(e => e.parsed?.currentPrice !== undefined)?.parsed?.currentPrice ?? 1;
  const pipSize = getPipValue(config.ticker, initialPrice);

  for (const entry of syncEntries) {
    processAlert(entry, entry.ts, state, config, trades, activeTrades, dailyStats, pipSize);
  }

  // 4. Process rest chronologically
  const total = restEntries.length;
  let lastProgressPct = 0;
  for (let i = 0; i < total; i++) {
    processAlert(restEntries[i], restEntries[i].ts, state, config, trades, activeTrades, dailyStats, pipSize);
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
      const r = slDistance > 0 ? pnlDistance / slDistance : 0;
      trade.result = r > 0 ? 'WIN' : r === 0 ? 'BE' : 'LOSS';
      trade.pnl = pct;
      trade.rMultiple = r;
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
    processedEvents: syncEntries.length + total,
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
      const payloadStr = alertText.substring(alertText.indexOf('Payload:') + 8).trim();
      try {
        parsed.rawZones = JSON.parse(payloadStr);
      } catch { /* ignore */ }
    }
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
  const d = new Date(nowMs - 3 * 3600 * 1000);
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

  // Extract VWAP status globally for the event timeframe
  const vwapMatch = upperText.match(/VWAP:\s*(UNDER|OVER)/);
  if (vwapMatch && eventTf) {
    if (!state.vwapStatus) state.vwapStatus = {};
    state.vwapStatus[eventTf] = vwapMatch[1];
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

    if (p.trendMatch) state.marketBias[sourceTf] = p.trendMatch;

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

      // 🆕 COSTOS DE TRANSACCIÓN / SPREAD (Mejora 6)
      // pipSize comes from runBacktest

      // 🆕 GATILLO DE BREAKEVEN DIFERIDO (TP 1.5)
      if (trade.tp1Hit && !trade.slHalfwayHit) {
        const distEntryToTp1 = Math.abs(trade.tp1Price - trade.entryPrice);
        const halfwayPrice = trade.direction === 'BUY'
          ? trade.tp1Price + (distEntryToTp1 * 0.5)
          : trade.tp1Price - (distEntryToTp1 * 0.5);

        const halfwayHit = trade.direction === 'BUY'
          ? highPrice >= halfwayPrice
          : lowPrice <= halfwayPrice;

        if (halfwayHit) {
          trade.slHalfwayHit = true;
          trade.slPrice = trade.entryPrice;
        }
      }

      // TP1
      if (!trade.tp1Hit) {
        const tp1Hit = trade.direction === 'BUY' ? highPrice >= trade.tp1Price : lowPrice <= trade.tp1Price;
        if (tp1Hit) {
          trade.tp1Hit = true;
          const slLossPct = Math.abs(trade.slPrice - trade.entryPrice) / trade.entryPrice * 100;
          // Tras TP1: mitad de posición cerrada en TP1, SL de la mitad restante a BE
          trade.slPrice = trade.entryPrice;
          trade.slHalfwayHit = true;
            
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
          
          // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
          const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
          const transactionCostR = riskPips > 0 ? (config.commissionPerLot || 0) / (riskPips * 10) : 0;
          
          const grossR = initialSlLossPct > 0 ? finalPnl / initialSlLossPct : 1.5;
          trade.rMultiple = grossR - transactionCostR;
          
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
        const finalResult = finalPnlPct > 0 ? 'WIN' : finalPnlPct === 0 ? 'BE' : 'LOSS';

        trade.result = finalResult;
        trade.pnl = finalPnlPct;
        trade.resultTp2 = finalResult;
        trade.pnlTp2 = finalPnlPct;
        
        const originalSl = trade.originalSlPrice ?? trade.slPrice;
        const initialSlLossPct = Math.abs(originalSl - trade.entryPrice) / trade.entryPrice * 100;
        
        // 🆕 COSTOS DE TRANSACCIÓN (Mejora 6)
        const riskPips = Math.abs(trade.entryPrice - originalSl) / pipSize;
        const transactionCostR = riskPips > 0 ? (config.commissionPerLot || 0) / (riskPips * 10) : 0;
        
        const grossR = initialSlLossPct > 0 ? finalPnlPct / initialSlLossPct : 0;
        trade.rMultiple = grossR - transactionCostR;
        
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

    }

    // Zone touching (scoring)
    const buffer = getBuffer(ticker, currentPrice);
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
    state.marketBias[eventTf] = currentDirection;

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
              if (trade.direction === 'BUY' && trade.tp1Hit && !trade.closeTimestamp) {
                if (newOrigin > trade.slPrice) {
                  trade.slPrice = newOrigin;
                }
              }
            }
          } else {
            state.activeImpulseSell = newLeg;
            // 🆕 TRAILING STOP ESTRUCTURAL POST-TP1 (Mejora 4)
            for (const [, trade] of activeTrades) {
              if (trade.direction === 'SELL' && trade.tp1Hit && !trade.closeTimestamp) {
                if (newOrigin < trade.slPrice) {
                  trade.slPrice = newOrigin;
                }
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

    const isMacroAligned = (state.marketBias['240'] === currentDirection) || (state.marketBias['60'] === currentDirection);
    const isDAgainst = state.marketBias['D'] !== currentDirection && state.marketBias['D'] !== 'NEUTRAL';
    const is4HAgainst = state.marketBias['240'] !== currentDirection && state.marketBias['240'] !== 'NEUTRAL';
    const is1HAgainst = state.marketBias['60'] !== currentDirection && state.marketBias['60'] !== 'NEUTRAL';
    const baseBiasPoints = isMacroAligned ? 5 : 0;

    let vwapBonus = 0;
    let vwapPenalty = 0;

    state.vwapStatus = state.vwapStatus || {};
    const vwap15m = state.vwapStatus['15'] || (upperText.match(/VWAP:\s*(UNDER|OVER)/)?.[1]);
    const vwap1H = state.vwapStatus['60'];
    const vwap4H = state.vwapStatus['240'];

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
    const biasD = state.marketBias['D'] || state.marketBias['1D'];
    const bias4H = state.marketBias['4H'] || state.marketBias['240'];
    const bias1H = state.marketBias['1H'] || state.marketBias['60'];

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

    // Crypto: reduce minPtsRequired by 1 (ported from live)
    const isCryptoTicker = ticker.includes('BTC') || ticker.includes('ETH');
    if (isCryptoTicker) minPtsRequired = Math.max(minPtsRequired - 1, 3);

    // Consecutive losses escalation (ported from live)
    if (dailyStats.consecutiveLosses >= 2) minPtsRequired += 2;

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
        const activeSlBufferPercent = 0; // SL Buffer only applies to OTE entries
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
            
            let rrChoch = 3.0; // Default optimista
            if (closestZonePrice !== Infinity && closestZonePrice !== 0) {
                const rewardDist = Math.abs(closestZonePrice - currentPrice);
                rrChoch = riskDist > 0 ? rewardDist / riskDist : 3.0;
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
function createTrade(oteData: any, nowMs: number, trades: BacktestTrade[], activeTrades: Map<string, BacktestTrade>, dailyStats: DailyStats, config: BacktestConfig, state: any) {
  if (dailyStats.isKilled) return;

  const currentSession = getSessionForTimestamp(nowMs);
  if (config.sessionFilter && config.sessionFilter.length > 0) {
      if (!config.sessionFilter.includes(currentSession)) return;
  }
  if (config.maxTradesPerSession && dailyStats.sessionTradeCount >= config.maxTradesPerSession) {
      return;
  }

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
        
        existingTradeForTicker.pnl = (pnlDist / existingTradeForTicker.entryPrice) * 100;
        existingTradeForTicker.rMultiple = slDist > 0 ? pnlDist / slDist : 0;
        existingTradeForTicker.result = 'REVERSAL';
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
  };

  // --- FRICTION MODEL INTERCEPTION ---
  const customFriction = {
    baseSpreadPips: config.spreadPips !== undefined ? config.spreadPips : 0.1,
    commissionPerLot: config.commissionPerLot !== undefined ? config.commissionPerLot : 3.0,
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
```


## jarvis-os/src/services/backtestTypes.ts
```typescript
// Tipos para el motor de backtesting standalone
import type { RadarZone, RadarState, ImpulseLeg, ScoreState } from '../../../src/engine/Types';
export type { RadarZone, RadarState, ImpulseLeg, ScoreState };

export interface BacktestTrade {
  id: string; timestamp: number; direction: 'BUY' | 'SELL';
  entryPrice: number; tp1Price: number; tp2Price: number; slPrice: number;
  originalSlPrice?: number;
  points: number; events: string[]; grade: string;
  result?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' | 'REVERSAL'; pnl?: number;
  resultTp1?: 'WIN' | 'LOSS' | 'TIMEOUT' | 'REVERSAL'; pnlTp1?: number;
  resultTp2?: 'WIN' | 'LOSS' | 'BE' | 'TIMEOUT' | 'REVERSAL'; pnlTp2?: number;
  tp1Hit?: boolean; slHalfwayHit?: boolean; closeTimestamp?: number; durationMin?: number;
  rMultiple?: number; rMultipleTp1?: number; rMultipleTp2?: number;
  oteEntryUsed?: number;
  tf?: string;
  marketBias?: Record<string, string>;
  vwapStatus?: Record<string, string>;
}

export interface TriggerConfig {
  enabled: boolean;
  minScore: number;
  entryPercent: number;
}

export interface OteConfig {
  enabled: boolean;
  minScore: number;
  entryPercent: number;
}

export interface SessionConfig {
  choch5m: TriggerConfig;
  choch15m: TriggerConfig;
  bos5m: TriggerConfig;
  bos15m: TriggerConfig;
  oteChoch5m?: OteConfig;
  oteChoch15m?: OteConfig;
  oteBos5m?: OteConfig;
  oteBos15m?: OteConfig;
  slBufferPercent: number;
  fixedRR: number;
  maxSellLosses?: number;
  maxBuyLosses?: number;
}

export interface BacktestConfig {
  ticker: string;
  minBuyPoints: number;
  minSellPoints: number;
  slBufferPercent: number;
  fixedRR: number;
  minRR?: number; // Minimum RR required to take a trade
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
  
  // Session-specific triggers and scores
  sessions?: Record<string, SessionConfig>;
  sessionFilter?: string[]; // Array of allowed sessions (e.g. ['LONDON', 'NY'])
  
  // Killswitches
  maxDailyLossR?: number;
  dailyProfitTargetR?: number;
  maxConsecutiveLosses?: number;
  maxTradesPerDay?: number;
  maxTradesPerSession?: number;
  trailingDrawdownR?: number;
  
  // Realism (Spread & Commissions)
  spreadPips?: number;
  commissionPerLot?: number;
}

export interface BacktestResult {
  trades: BacktestTrade[]; totalEvents: number; processedEvents: number;
  startDate: string; endDate: string;
}

export interface ParsedAlert {
  prefix: string;
  eventTf: string;
  readableTf: string;
  currentDirection: 'BUY' | 'SELL' | null;
  trendMatch?: string | null;
  rawZones?: Record<string, unknown>[];
  currentPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  origin?: number;
  vwapUnder?: boolean;
  vwapOver?: boolean;
}

export interface LogEntry {
  ts: number; line: string; tf: string; parsed?: ParsedAlert;
}

export function emptyState(): RadarState {
  return {
    zones: [], lastPrice: null, previousPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { 'D': 'NEUTRAL', '240': 'NEUTRAL', '60': 'NEUTRAL', '15': 'NEUTRAL', '5': 'NEUTRAL' },
    vwapStatus: {},
    lastSyncDate: null, lastSniperAlert: 0, lastHeartbeat: 0,
    activeImpulseBuy: null, activeImpulseSell: null,
    activeMacroImpulseBuy: null, activeMacroImpulseSell: null,
    activeLocks: [],
  };
}

export function normalizeZone(raw: Record<string, unknown>): RadarZone {
  const r = { ...raw } as Record<string, unknown>;
  if (r.t !== undefined && r.tf === undefined) r.tf = r.t;
  if (r.d !== undefined && r.dir === undefined) r.dir = r.d;
  if (r.p !== undefined && r.top === undefined) r.top = r.p;
  if (r.b !== undefined && r.btm === undefined) r.btm = r.b;
  if (r.lv !== undefined && r.lvl === undefined) r.lvl = r.lv;
  if (r.md !== undefined && r.medal === undefined) r.medal = r.md;
  if (r.sc !== undefined && r.score === undefined) r.score = r.sc;
  if (r.mi !== undefined && r.mid === undefined) r.mid = r.mi;
  if (r.a !== undefined && r.atr === undefined) r.atr = r.a;
  return r as unknown as RadarZone;
}

export const parseTF = (tf: string) => {
  if (tf === 'D') return 'D';
  if (tf === '240') return '4H';
  if (tf === '60') return '1H';
  if (tf === '15') return '15M';
  if (tf === '5') return '5M';
  return `${tf}M`;
};

export const getBuffer = (ticker: string, price: number) =>
  (ticker.includes('BTC') || ticker.includes('ETH')) ? price * 0.001 : price * 0.0002;

export const getDecimals = (ticker: string) =>
  (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS')) ? 2 : (ticker.includes('JPY') ? 3 : 5);
```


## jarvis-os/src/engine/AlphaModel.ts
```typescript
import type { RadarZone, RadarState, ImpulseLeg, ActiveTrade } from './Types.js';

const DEBUG = false;
const dbg = (...args: unknown[]) => { if (DEBUG) dbg(...args); };


export const SETUP_MEMORY_WINDOW_MS = 172800000; // 48 Horas (Swing Core)

export const TF_WEIGHT: Record<string, number> = {
    '3': 0.5,    // 3M: medio punto (mucho ruido)
    '5': 0.75,   // 5M: tres cuartos
    '15': 1.0,   // 15M: base (gatillo principal)
    '60': 1.5,   // 1H: 50% más
    '240': 2.0,  // 4H: doble
    'D': 3.0,    // Daily: triple
};

export const emptyState = (): RadarState => ({
    lastSyncDate: null,
    zones: [],
    activeLocks: [],
    lastPrice: null,
    scoreBuy: { points: 0, lastUpdate: 0, events: [] },
    scoreSell: { points: 0, lastUpdate: 0, events: [] },
    marketBias: { "D": 'NEUTRAL', "240": 'NEUTRAL', "60": 'NEUTRAL', "15": 'NEUTRAL', "5": 'NEUTRAL' },
    lastApproachAlert: 0,
    lastSniperAlert: 0,
    activeImpulseBuy: null,
    activeImpulseSell: null,
    activeMacroImpulseBuy: null,
    activeMacroImpulseSell: null,
    lastGatillo: undefined,
    version: 0,
    lastModified: 0
});

export function normalizeZone(raw: any): RadarZone {
    const r = { ...raw } as Record<string, unknown>;
    if (r.t !== undefined && r.tf === undefined) r.tf = r.t;
    if (r.d !== undefined && r.dir === undefined) r.dir = r.d;
    if (r.p !== undefined && r.top === undefined) r.top = r.p;
    if (r.b !== undefined && r.btm === undefined) r.btm = r.b;
    if (r.lv !== undefined && r.lvl === undefined) r.lvl = r.lv;
    if (r.md !== undefined && r.medal === undefined) r.medal = r.md;
    if (r.sc !== undefined && r.score === undefined) r.score = r.sc;
    if (r.mi !== undefined && r.mid === undefined) r.mid = r.mi;
    if (r.a !== undefined && r.atr === undefined) r.atr = r.a;
    if (r.mg !== undefined) r.mg = r.mg;
    if (r.kz !== undefined) r.kz = r.kz;
    return r as unknown as RadarZone;
}

export const getDecimals = (ticker: string) => (ticker.includes('BTC') || ticker.includes('ETH') || ticker.includes('US30') || ticker.includes('NAS') || ticker.includes('XAU') || ticker.includes('GOLD')) ? 2 : (ticker.includes('JPY') ? 3 : 5);

export function calculateDynamicSlBuffer(ticker: string, originPrice: number, bufferConfig: number): number {
    const t = ticker.toUpperCase();
    if (t.includes('JPY')) return bufferConfig * 0.1;
    const forexPairs = ['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
    if (forexPairs.some(fiat => t.includes(fiat)) && !t.includes('BTC') && !t.includes('ETH')) return bufferConfig * 0.001;
    const indices = ['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'];
    if (indices.some(idx => t.includes(idx))) return bufferConfig * 100;
    if (t.includes('XAU') || t.includes('GOLD')) return bufferConfig * 10;
    return originPrice * (bufferConfig / 100);
}

export interface AlphaContext {
    config: any;
    currentSession: string;
    sessionConfig: any;
}

export interface AlphaInsight {
    updatedLeg: ImpulseLeg | null;
    triggerOte?: boolean;
    oteData?: any;
    newTrade?: ActiveTrade;
}

export function evaluateImpulseCore(
    leg: ImpulseLeg | null | undefined, 
    currentPrice: number, 
    highPrice: number, 
    lowPrice: number, 
    ticker: string, 
    state: RadarState, 
    nowMs: number, 
    ctx: AlphaContext
): AlphaInsight {
    if (!leg) return { updatedLeg: null };
    let impulseInvalidated = false;

    const { config, sessionConfig } = ctx;

    // 🔧 FIX 1: Stale leg cleaner — legs de más de 8 horas se invalidan automáticamente (Intradia)
    const MAX_LEG_AGE_MS = 8 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_LEG_AGE_MS) {
        dbg(`[FIBO] 🧹 Leg ${leg.dir} en ${ticker} EXPIRADO por antigüedad (${Math.round((nowMs - leg.createdAt) / 60000)} min > 480 min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 2: Opposite pressure — si el score contrario supera 3x y el minScore de sesión, el leg se anula
    const legScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
    const oppositeScore = leg.dir === 'BUY' ? state.scoreSell : state.scoreBuy;
    const minOppositeScore = sessionConfig?.choch5m?.minScore ?? sessionConfig?.choch15m?.minScore ?? 9;
    
    if (oppositeScore.points >= legScore.points * 3 && oppositeScore.points >= minOppositeScore && (nowMs - oppositeScore.lastUpdate) < 900000) {
        dbg(`[FIBO] ⚠️ Leg ${leg.dir} en ${ticker} ANULADO por presión contraria: score opuesto ${oppositeScore.points} pts (mín ${minOppositeScore}) vs propio ${legScore.points} pts (hace ${Math.round((nowMs - oppositeScore.lastUpdate) / 60000)}min).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 2.5: Invalidación por CHoCH contrario antes de llegar a OTE
    const contraryChochFound = oppositeScore.events?.some((e: string) => e.includes('CHOCH') || e.includes('CHoCH'));
    if (contraryChochFound && leg.createdAt && oppositeScore.lastUpdate > leg.createdAt) {
        dbg(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} ANULADO: Se detectó un CHoCH contrario posterior a la creación del leg (antes de llegar a OTE).`);
        return { updatedLeg: null };
    }

    // 🔧 FIX 3: Si el precio superó el extreme por >1 ATR y pasaron >30 min, OTE inalcanzable
    const range = Math.abs(leg.extreme - leg.origin);
    const atrEstimate = range * 0.3;
    const priceBeyondExtreme = leg.dir === 'BUY' 
        ? (currentPrice > leg.extreme + atrEstimate) 
        : (currentPrice < leg.extreme - atrEstimate);
    if (priceBeyondExtreme && leg.createdAt && (nowMs - leg.createdAt) > 30 * 60 * 1000) {
        dbg(`[FIBO] 🚫 Leg ${leg.dir} en ${ticker} INALCANZABLE: precio ${currentPrice} ya superó el extreme ${leg.extreme} en más de 1 ATR.`);
        return { updatedLeg: null };
    }

    if (leg.dir === 'BUY' && highPrice > leg.extreme) leg.extreme = highPrice;
    else if (leg.dir === 'SELL' && lowPrice < leg.extreme) leg.extreme = lowPrice;

    if (leg.dir === 'BUY' && lowPrice < leg.origin) impulseInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) impulseInvalidated = true;

    if (!impulseInvalidated) {
        const range = Math.abs(leg.extreme - leg.origin);
        const isChoch = leg.chochEvents?.some(e => e.includes('CHOCH') || e.includes('CHoCH')) || false;
        const isBos = leg.chochEvents?.some(e => e.includes('BOS')) || false;

        let triggerTfStr = leg.chochEvents?.map(e => {
            const parts = e.split('_');
            return parts[parts.length - 1]; // "5M" or "15M"
        }).find(tf => tf === '3M' || tf === '5M' || tf === '15M') || '';
        let triggerTf = triggerTfStr.toLowerCase(); // "5m" or "15m"

        let activeOteEntryPercent = config.oteEntryPercent || 50;
        if (sessionConfig) {
            if (isChoch) {
                const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteChoch) {
                    activeOteEntryPercent = (sessionConfig as any).oteChoch.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else if (isBos) {
                const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                const tfConfig = sessionConfig[tfKey] as any;
                if (tfConfig) {
                    activeOteEntryPercent = tfConfig.entryPercent ?? config.oteEntryPercent ?? 50;
                } else if ((sessionConfig as any).oteBos) {
                    activeOteEntryPercent = (sessionConfig as any).oteBos.entryPercent ?? config.oteEntryPercent ?? 50;
                }
            } else {
                activeOteEntryPercent = config.oteEntryPercent ?? 50;
            }
        }

        const fibRatio = activeOteEntryPercent / 100;
        const entryLevel = leg.dir === 'BUY' ? leg.extreme - (range * fibRatio) : leg.extreme + (range * fibRatio);
        
        const isEntryHit = leg.dir === 'BUY' ? lowPrice <= entryLevel : highPrice >= entryLevel;
        
        if (isEntryHit && !leg.oteScored) {

            let oteEnabled = false;
            let oteMinScore = 8;

            if (sessionConfig) {
                if (isChoch) {
                    const tfKey = `oteChoch${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY' 
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) 
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
                    } else if ((sessionConfig as any).oteChoch) {
                        oteEnabled = (sessionConfig as any).oteChoch.enabled ?? false;
                        oteMinScore = (sessionConfig as any).oteChoch.minScore ?? 8;
                    }
                } else if (isBos) {
                    const tfKey = `oteBos${triggerTf}` as keyof typeof sessionConfig;
                    const tfConfig = sessionConfig[tfKey] as any;
                    if (tfConfig) {
                        oteEnabled = tfConfig.enabled ?? false;
                        oteMinScore = leg.dir === 'BUY' 
                            ? (tfConfig.minScoreBuy ?? tfConfig.minScore ?? 8) 
                            : (tfConfig.minScoreSell ?? tfConfig.minScore ?? 8);
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

            if (sessionConfig && config.entryTrigger !== 'SMART' && config.entryTrigger !== 'BOTH') {
                if (!oteEnabled || totalPoints < oteMinScore) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} para esta sesión`);
                    return { updatedLeg: leg };
                }
            } else {
                const MIN_OTE_POINTS = oteMinScore;
                if (!leg.isValidated && (leg.chochPoints || 0) < MIN_OTE_POINTS) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: leg no validado y solo ${leg.chochPoints || 0} pts (< ${MIN_OTE_POINTS})`);
                    return { updatedLeg: leg };
                }
                if (!oteEnabled || totalPoints < oteMinScore) {
                    dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} ignorado: OTE deshabilitado o puntaje ${totalPoints} < requerido ${oteMinScore} de base`);
                    return { updatedLeg: leg };
                }
            }

            const riskDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.21;
            const rewardDistanceOTE = Math.abs(leg.extreme - leg.origin) * 0.50;
            const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 1.0;
            if (riskDistanceOTE === 0 || rrRatioOTE < 1.2) {
                dbg(`[FIBO] ❌ R:R invalid: risk=${riskDistanceOTE}, reward=${rewardDistanceOTE}, ratio=${rrRatioOTE}`);
                dbg(`[FIBO] ⚠️ OTE ${ticker} ${leg.dir} descartado: R:R teórico ${rrRatioOTE.toFixed(2)} < 1.2 (rango impulso: ${(Math.abs(leg.extreme - leg.origin)).toFixed(4)})`);
                return { updatedLeg: leg };
            }

            const activeScore = leg.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
            const tfFormatted = triggerTf.toUpperCase() || '5M';
            const eventName = `🎯_OTE_Retracement_${tfFormatted}`;
            
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += 4;
                activeScore.lastUpdate = nowMs;
                leg.oteScored = true;
                
                const decimals = getDecimals(ticker);
                const slBuffer = calculateDynamicSlBuffer(ticker, leg.origin, sessionConfig?.slBufferPercent ?? config.slBufferPercent);
                const adjustedSL = leg.dir === 'BUY' ? leg.origin - slBuffer : leg.origin + slBuffer;
                const stopLoss = adjustedSL.toFixed(decimals);
                const tp1 = leg.extreme.toFixed(decimals);
                const riskDist = Math.abs(currentPrice - adjustedSL);
                const oteTP2Limit = leg.dir === 'BUY'
                    ? leg.extreme + (range * 0.27)
                    : leg.extreme - (range * 0.27);
                const fixedTP2 = leg.dir === 'BUY'
                    ? Math.max(oteTP2Limit, currentPrice + (riskDist * config.fixedRR))
                    : Math.min(oteTP2Limit, currentPrice - (riskDist * config.fixedRR));
                const tp2 = fixedTP2.toFixed(decimals);

                const tradeId = Math.random().toString(36).substring(2, 8).toUpperCase();

                dbg(`[FIBO] 🎯 RETROCESO 50% CONFIRMADO para ${ticker} ${leg.dir}. Despertando IA...`);

                const bias240 = state.marketBias["240"] || 'NEUTRAL';
                const bias60 = state.marketBias["60"] || 'NEUTRAL';
                const bias15 = state.marketBias["15"] || 'NEUTRAL';
                const getIconStr = (bias: string) => bias === 'BUY' ? '🟢' : bias === 'SELL' ? '🔴' : '⚪';
                const fallbackReport = `🗺️ <b>Contexto Macro:</b>\n` +
                    `${getIconStr(bias240)} 4H: ${bias240}\n` +
                    `${getIconStr(bias60)} 1H: ${bias60}\n` +
                    `${getIconStr(bias15)} 15M: ${bias15}\n\n` +
                    `🎯 <b>Confluencia de Entrada:</b> Retroceso OTE 5M en nivel del 50% Fibo (Puntaje base: ${leg.chochPoints || 0} pts + OTE: +4 pts).`;

                const oteData = {
                    tradeId, 
                    direction: leg.dir,
                    dirText: leg.dir === 'BUY' ? 'COMPRA' : 'VENTA',
                    stopLoss, tp1, tp2,
                    entryPrice: currentPrice,
                    points: (leg.chochPoints || 0) + 4, 
                    events: [...(leg.chochEvents || []), eventName],
                    confluenceReport: leg.chochReport || fallbackReport,
                    bestZone: leg.bestZone || null,
                    marketBias: { ...state.marketBias },
                    tf: eventName.split('_').pop(),
                    isChochEntry: false
                };

                const newTrade: ActiveTrade = {
                    tradeId, ticker, direction: leg.dir,
                    entryPrice: currentPrice,
                    tp1Price: leg.extreme,
                    tp2Price: fixedTP2,
                    slPrice: adjustedSL,
                    tp1Hit: false,
                    tp2Hit: false,
                    score: oteData.points || 0,
                    timestamp: nowMs
                };

                // PURE Alpha Model: Return the decision instead of executing it.
                return { updatedLeg: leg, triggerOte: true, oteData, newTrade };
            }
        }
    }
    return { updatedLeg: impulseInvalidated ? null : leg };
}


export function evaluateMacroStretching(leg: ImpulseLeg | null | undefined, highPrice: number, lowPrice: number, nowMs: number): ImpulseLeg | null {
    if (!leg) return null;

    // 🧹 Expiración: legs macro duran hasta 24 horas en RAM
    const MAX_MACRO_LEG_AGE_MS = 24 * 60 * 60 * 1000;
    if (leg.createdAt && (nowMs - leg.createdAt) > MAX_MACRO_LEG_AGE_MS) {
        dbg(`[FIBO-MACRO] 🧹 Leg MACRO ${leg.dir} expirado por antigüedad.`);
        return null;
    }

    let macroInvalidated = false;
    
    // Invalida si el precio rompe el origen
    if (leg.dir === 'BUY' && lowPrice < leg.origin) macroInvalidated = true;
    else if (leg.dir === 'SELL' && highPrice > leg.origin) macroInvalidated = true;

    if (macroInvalidated) {
        dbg(`[FIBO-MACRO] 🚫 Leg MACRO ${leg.dir} invalidado por ruptura de origen.`);
        return null;
    }

    // Estirar extremo flexible
    if (leg.dir === 'BUY' && highPrice > leg.extreme) {
        leg.extreme = highPrice;
    } else if (leg.dir === 'SELL' && lowPrice < leg.extreme) {
        leg.extreme = lowPrice;
    }

    return leg;
}

export function isInsideMacroOteZone(leg: ImpulseLeg | null | undefined, price: number): boolean {
    if (!leg) return false;
    const range = Math.abs(leg.extreme - leg.origin);
    if (range === 0) return false;
    
    if (leg.dir === 'BUY') {
        const oteBtm = leg.extreme - (range * 0.79);
        const oteTop = leg.extreme - (range * 0.50); // Límite de descuento superior (50%)
        return price >= oteBtm && price <= oteTop;
    } else {
        const oteBtm = leg.extreme + (range * 0.50);
        const oteTop = leg.extreme + (range * 0.79);
        return price >= oteBtm && price <= oteTop;
    }
}
```


## jarvis-os/src/engine/FrictionModel.ts
```typescript
import type { ActiveTrade } from './Types.js';
import { getDecimals } from './AlphaModel.js';

export interface FrictionConfig {
    commissionPerLot: number; // Comisión por lado (ej. $3)
    baseSpreadPips: number;   // Spread raw promedio (ej. 0.1)
    latencyMs: number;        // Latencia estimada al broker
}

export const defaultFrictionConfig: Record<string, FrictionConfig> = {
    'FOREX': { commissionPerLot: 3.0, baseSpreadPips: 0.1, latencyMs: 50 },
    'CRYPTO': { commissionPerLot: 0.0, baseSpreadPips: 2.0, latencyMs: 50 },
    'INDICES': { commissionPerLot: 0.0, baseSpreadPips: 1.0, latencyMs: 50 },
    'METALS': { commissionPerLot: 3.0, baseSpreadPips: 1.0, latencyMs: 50 },
};

function getAssetClass(ticker: string): string {
    const t = ticker.toUpperCase();
    if (t.includes('BTC') || t.includes('ETH')) return 'CRYPTO';
    if (['US30', 'NAS', 'NDX', 'SPX', 'US500', 'DJI'].some(i => t.includes(i))) return 'INDICES';
    if (t.includes('XAU') || t.includes('GOLD')) return 'METALS';
    return 'FOREX';
}

export function getPipValue(ticker: string, currentPrice: number): number {
    const assetClass = getAssetClass(ticker);
    if (assetClass === 'FOREX') {
        if (ticker.includes('JPY')) return 0.01;
        return 0.0001;
    }
    if (assetClass === 'INDICES') return 1.0;
    if (assetClass === 'METALS') return 0.1;
    if (assetClass === 'CRYPTO') return currentPrice * 0.0001; // Proxy dinámico
    return 0.0001;
}

export function evaluateNetTrade(
    trade: ActiveTrade, 
    nowMs: number, 
    customConfig?: FrictionConfig
): { approved: boolean; netTrade: ActiveTrade; reason?: string; frictionCostDetails?: string } {
    const assetClass = getAssetClass(trade.ticker);
    const config = customConfig || defaultFrictionConfig[assetClass];
    const pipValue = getPipValue(trade.ticker, trade.entryPrice);
    const decimals = getDecimals(trade.ticker);

    // 1. Spread Dinámico (Aumentado por horario o por defecto)
    let activeSpreadPips = config.baseSpreadPips;
    const hourUTC = new Date(nowMs).getUTCHours();
    // Horario Rollover: 21:00 a 22:00 UTC (Spread se abre masivamente)
    if (hourUTC === 21) {
        activeSpreadPips *= 5; // Simulación del "Death Spread" del Rollover
    }
    const spreadCost = activeSpreadPips * pipValue;
    
    // 2. Slippage por latencia (0.1 pips por cada 50ms)
    const slippagePips = (config.latencyMs / 50) * 0.1;
    const slippageCost = slippagePips * pipValue;

    // Fricción Total en la entrada (Peor precio)
    const entryFriction = spreadCost + slippageCost;
    
    // Aplicamos el peor precio de entrada al simulador
    const netEntryPrice = trade.direction === 'BUY' 
        ? trade.entryPrice + entryFriction 
        : trade.entryPrice - entryFriction;
    
    // 3. Costo de Comisión convertido a impacto en Precio
    // Para propósitos de R:R de backtest, convertimos los $6 (Round Turn) a pips.
    // Aproximación estándar: $10 = 1 pip. Entonces $6 = 0.6 pips extra de costo.
    const commissionRoundTurn = config.commissionPerLot * 2;
    const commissionPips = commissionRoundTurn / 10;
    const commissionCostInPrice = commissionPips * pipValue;

    const frictionCostDetails = `Spread: ${activeSpreadPips.toFixed(2)} pips | Slip: ${slippagePips.toFixed(2)} pips | Com: ${commissionPips.toFixed(2)} pips (Total R:R Merma)`;

    // 4. Recalcular Beneficio Neto vs Riesgo Real
    const grossRiskDistance = Math.abs(trade.entryPrice - trade.slPrice);
    const minRisk = Math.max(Number.EPSILON, pipValue * 0.5); // media unidad de precisión mínima
    if (grossRiskDistance <= minRisk) {
        return { 
            approved: false, 
            netTrade: trade, 
            reason: 'Riesgo bruto insuficiente (SL demasiado cerca del entry).',
            frictionCostDetails
        };
    }
    const netRiskDistance = grossRiskDistance + entryFriction + commissionCostInPrice;
    
    const grossRewardDistance = Math.abs(trade.tp1Price - trade.entryPrice);
    const netRewardDistance = grossRewardDistance - entryFriction - commissionCostInPrice;

    if (netRewardDistance <= 0) {
        return { 
            approved: false, 
            netTrade: trade, 
            reason: `Fricción devoró la ganancia (Neto negativo).`,
            frictionCostDetails
        };
    }

    const netRR = netRewardDistance / netRiskDistance;

    // Filtro Escudo: Si el RR después de comisiones y spread cae de 1.0, descartar trade.
    // Esto salva cuentas fondeadas de scalping extremo en temporalidades pequeñas.
    if (netRR < 0.2) {
        return {
            approved: false,
            netTrade: trade,
            reason: `Net R:R inaceptable (${netRR.toFixed(2)}). El SL es demasiado ajustado y el Broker absorbe casi toda la rentabilidad.`,
            frictionCostDetails
        };
    }

    const modifiedTrade = { ...trade };
    modifiedTrade.entryPrice = parseFloat(netEntryPrice.toFixed(decimals));
    // SL y TP NO se modifican: son niveles de orden, la fricción actúa en el fill.

    return {
        approved: true,
        netTrade: modifiedTrade,
        frictionCostDetails
    };
}
```


## jarvis-os/src/engine/PortfolioModel.ts
```typescript
// PortfolioModel.ts - Lógica de control de riesgo global y de cuenta

export interface KillswitchResult {
    isKilled: boolean;
    killUntilMs?: number;
    killReason?: string;
}

export async function evaluateGlobalRisk(
    nowMs: number,
    globalPortfolioConfig: any,
    currentKillswitchUntil: number,
    currentSession: string,
    db: any
): Promise<KillswitchResult> {
    if (!globalPortfolioConfig.enabled) return { isKilled: false };

    if (globalPortfolioConfig.disabledSessions && globalPortfolioConfig.disabledSessions.includes(currentSession)) {
        return { isKilled: true, killReason: `Sesión actual (${currentSession}) está deshabilitada globalmente.` };
    }

    if (nowMs < currentKillswitchUntil) return { isKilled: true };
    if (!db) return { isKilled: false };

    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1;
        const day = parseInt(dateParts[2]);

        const artMidnight = new Date(Date.UTC(year, month, day, 3, 0, 0));
        const artMidnightMs = artMidnight.getTime();

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .get();

        if (snapshot.empty) return { isKilled: false };

        const trades = snapshot.docs
            .map((d: any) => d.data())
            .filter((t: any) => t.mode !== 'backtesting' && t.result)
            .sort((a: any, b: any) => a.timestamp - b.timestamp);

        let totalTrades = trades.length;
        let dailyPnLR = 0;
        let peakPnLR = 0;
        let consecutiveLosses = 0;
        let maxConsecutiveLosses = 0;

        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (isNaN(rMultiple) || rMultiple === undefined) {
                if (t.result === 'WIN') rMultiple = 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            dailyPnLR += rMultiple;
            if (dailyPnLR > peakPnLR) peakPnLR = dailyPnLR;

            if (rMultiple < 0) {
                consecutiveLosses++;
                if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
            } else if (rMultiple > 0) {
                consecutiveLosses = 0;
            }
        }

        const trailingDrawdown = peakPnLR - dailyPnLR;
        let isKilled = false;
        let killReason = '';

        if (globalPortfolioConfig.maxDailyLossR > 0 && dailyPnLR <= -globalPortfolioConfig.maxDailyLossR) {
            isKilled = true;
            killReason = `Max Daily Loss superado (-${globalPortfolioConfig.maxDailyLossR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if (globalPortfolioConfig.dailyProfitTargetR > 0 && dailyPnLR >= globalPortfolioConfig.dailyProfitTargetR) {
            isKilled = true;
            killReason = `Daily Profit Target alcanzado (+${globalPortfolioConfig.dailyProfitTargetR}R | PnL: ${dailyPnLR.toFixed(2)}R)`;
        } else if (globalPortfolioConfig.maxTradesPerDay > 0 && totalTrades >= globalPortfolioConfig.maxTradesPerDay) {
            isKilled = true;
            killReason = `Max Trades per Day superado (${globalPortfolioConfig.maxTradesPerDay} trades | Realizados: ${totalTrades})`;
        } else if (globalPortfolioConfig.maxConsecutiveLosses > 0 && maxConsecutiveLosses >= globalPortfolioConfig.maxConsecutiveLosses) {
            isKilled = true;
            killReason = `Max Consecutive Losses superado (${globalPortfolioConfig.maxConsecutiveLosses} consecutivas | Racha: ${maxConsecutiveLosses})`;
        } else if (globalPortfolioConfig.trailingDrawdownR > 0 && trailingDrawdown >= globalPortfolioConfig.trailingDrawdownR) {
            isKilled = true;
            killReason = `Trailing Drawdown superado (${globalPortfolioConfig.trailingDrawdownR}R | Drawdown: ${trailingDrawdown.toFixed(2)}R)`;
        }

        if (isKilled) {
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            return { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return { isKilled: false };
    } catch (e: any) {
        console.error('[PortfolioModel] Error evaluando el riesgo unificado:', e.message);
        return { isKilled: false };
    }
}

export async function countDailySellsForTicker(db: any, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'SELL')
            .get();

        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }
}

export async function countDailyBuysForTicker(db: any, ticker: string, nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', 'BUY')
            .get();

        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }
}

export async function countConsecutiveLossesForAsset(db: any, ticker: string, session: string, direction: 'BUY' | 'SELL', nowMs: number, isBacktest: boolean = false, backtestSessionId?: string): Promise<number> {
    if (!db) return 0;
    try {
        const now = new Date(nowMs);
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
        const argDateStr = formatter.format(now);
        const dateParts = argDateStr.split('-');
        const artMidnightMs = new Date(Date.UTC(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 3, 0, 0)).getTime();

        const tickerVariants = [ticker];
        if (ticker.includes('NAS') || ticker.includes('US100')) tickerVariants.push('NAS100', 'US100');

        const snapshot = await db.collection('trade_journal')
            .where('timestamp', '>=', artMidnightMs)
            .where('direction', '==', direction)
            .get();

        if (snapshot.empty) return 0;

        const trades = snapshot.docs
            .map((d: any) => d.data())
            .filter((t: any) => {
                const isMatchingTicker = tickerVariants.includes(t.ticker);
                const isMatchingSession = t.session === session;
                const modeMatch = isBacktest ? t.mode === 'backtesting' : t.mode !== 'backtesting';
                const sessionMatch = isBacktest ? (backtestSessionId ? t.sessionId === backtestSessionId : true) : true;
                return modeMatch && sessionMatch && isMatchingTicker && isMatchingSession && t.result;
            })
            .sort((a: any, b: any) => a.timestamp - b.timestamp);

        let streak = 0;
        for (const t of trades) {
            let rMultiple = Number(t.rMultiple);
            if (isNaN(rMultiple) || rMultiple === undefined) {
                if (t.result === 'WIN') rMultiple = 1.5;
                else if (t.result === 'LOSS') rMultiple = -1.0;
                else rMultiple = 0;
            }

            if (rMultiple < 0) streak++;
            else if (rMultiple > 0) streak = 0;
        }
        return streak;
    } catch (e) {
        return 0;
    }
}

```

