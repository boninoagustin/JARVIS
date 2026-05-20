import { useState, useRef, useCallback } from 'react';
import { Upload, BarChart2, TrendingUp, BookOpen, Play, Trash2, FileText, Wand2, Download, ShieldAlert } from 'lucide-react';
import { useToast } from './Toast';
import { parseCSV, runBacktest } from '../services/backtestEngine';
import type { BacktestTrade, BacktestResult } from '../services/backtestEngine';
import { getDecimals } from '../services/backtestTypes';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { db } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';

interface UploadedFile {
  name: string;
  tf: string;
  lines: string[];
  lineCount: number;
}

interface SessionHistory {
  id: string;
  ticker: string;
  date: string;
  trades: number;
  winRate: string;
  pnl: string;
  status: string;
  tradeData?: BacktestTrade[];
  config?: {
    minBuyPoints: number;
    minSellPoints: number;
    slBufferPercent: number;
    fixedRR: number;
    oteEntryPercent: number;
    entryTrigger: 'CHOCH' | 'OTE' | 'BOTH';
  };
}

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('BTCUSD');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [slBufferPercent, setSlBufferPercent] = useState(0.1);
  const [fixedRR, setFixedRR] = useState(2.0);
  const [oteEntryPercent, setOteEntryPercent] = useState(50);
  const [entryTrigger, setEntryTrigger] = useState<'CHOCH' | 'OTE' | 'BOTH'>('OTE');
  const [riskUsd, setRiskUsd] = useState(50);
  const [maxDailyLossR, setMaxDailyLossR] = useState(0);
  const [dailyProfitTargetR, setDailyProfitTargetR] = useState(0);
  const [maxConsecutiveLosses, setMaxConsecutiveLosses] = useState(0);
  const [maxTradesPerDay, setMaxTradesPerDay] = useState(0);
  const [trailingDrawdownR, setTrailingDrawdownR] = useState(0);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [sessions, setSessions] = useState<SessionHistory[]>(() => {
    try { return JSON.parse(localStorage.getItem('bt_sessions') || '[]'); } catch { return []; }
  });
  const [showLog, setShowLog] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'ALL' | 'LONDON' | 'NY' | 'ASIA'>('ALL');
  const [tradeFilter, setTradeFilter] = useState<'ALL' | 'BOS' | 'CHOCH' | 'OTE'>('ALL');
  const [optimizedSessionResults, setOptimizedSessionResults] = useState<Record<string, { config: any, result: BacktestResult }>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  const TF_ORDER: Record<string, number> = { '240': 0, '60': 1, '15': 2, '3': 3 };
  const TF_LABEL: Record<string, string> = { '240': '4H', '60': '1H', '15': '15M', '3': '3M' };
  const TF_COLOR: Record<string, string> = { '240': '#7c4dff', '60': '#0088ff', '15': 'var(--accent-gold)', '3': 'var(--accent-red)' };

  const getSessionForTimestamp = useCallback((ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' => {
    const d = new Date(ts);
    const arHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
    const arMin = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', minute: 'numeric' }));
    const timeDecimal = arHour + arMin / 60;
    // Asia: 21:00 - 06:00 AR
    if (timeDecimal >= 21 || timeDecimal < 6) return 'ASIA';
    // London: 04:00 - 13:00 AR
    if (timeDecimal >= 4 && timeDecimal < 13) return 'LONDON';
    // NY: 10:30 - 17:00 AR
    if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';
    return 'OFF';
  }, []);

  const handleSessionSelect = useCallback((s: 'ALL' | 'LONDON' | 'NY' | 'ASIA') => {
    setSessionFilter(s);
    if (optimizedSessionResults[s]) {
      const { config, result: optResult } = optimizedSessionResults[s];
      setSlBufferPercent(config.slBufferPercent);
      setFixedRR(config.fixedRR);
      setOteEntryPercent(config.oteEntryPercent);
      setEntryTrigger(config.entryTrigger);
      setMinBuyPoints(config.minBuyPoints);
      setMinSellPoints(config.minSellPoints);
      setResult(optResult);
      setTrades(optResult.trades);
    }
  }, [optimizedSessionResults]);

  const handlePushToBot = async () => {
    try {
      const configDoc = `${ticker}_${sessionFilter}`;
      await setDoc(doc(db, 'asset_configs', configDoc), {
        minPointsForBuy: minBuyPoints,
        minPointsForSell: minSellPoints,
        slBufferPercent: slBufferPercent,
        fixedRR: fixedRR,
        oteEntryPercent: oteEntryPercent,
        entryTrigger: entryTrigger,
        maxDailyLossR,
        dailyProfitTargetR,
        maxConsecutiveLosses,
        maxTradesPerDay,
        trailingDrawdownR,
        enabled: true,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configurada ${configDoc} en JARVIS`, 'success');
    } catch (err: any) {
      toast(`❌ Error guardando: ${err.message}`, 'error');
    }
  };

  const handleFilesUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        const { lines, detectedTF } = parseCSV(content);
        if (lines.length === 0) { toast(`❌ ${file.name}: sin datos válidos`, 'error'); return; }
        setUploadedFiles(prev => {
          const filtered = prev.filter(f => f.tf !== detectedTF);
          return [...filtered, { name: file.name, tf: detectedTF, lines, lineCount: lines.length }]
            .sort((a, b) => (TF_ORDER[a.tf] ?? 99) - (TF_ORDER[b.tf] ?? 99));
        });
        toast(`✅ ${TF_LABEL[detectedTF] || detectedTF}: ${lines.length} eventos cargados`, 'success');
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }, [toast]);

  const loadDemoData = useCallback(() => {
    setIsRunning(true);
    setProgress(10);
    
    setTimeout(() => {
      const lines4H: string[] = [];
      const lines1H: string[] = [];
      const lines15M: string[] = [];
      const lines3M: string[] = [];
      
      const now = Date.now();
      const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;
      
      let price = 62500;
      let timestamp = fiveDaysAgo;
      const step3M = 3 * 60 * 1000; // 3 minutos
      
      // Zonas macro de soporte y resistencia iniciales
      lines4H.push(`SYNC_ZONES | TS: ${timestamp} | TF: 240 | Trend: BUY | Payload: [{"top":63500,"btm":63200,"dir":"SELL","score":4,"medal":"God"},{"top":61800,"btm":61500,"dir":"BUY","score":4,"medal":"God"}]`);
      lines1H.push(`SYNC_ZONES | TS: ${timestamp} | TF: 60 | Trend: BUY | Payload: [{"top":62900,"btm":62700,"dir":"SELL","score":3,"medal":"Silver"},{"top":62100,"btm":61900,"dir":"BUY","score":3,"medal":"Silver"}]`);
      lines15M.push(`SYNC_ZONES | TS: ${timestamp} | TF: 15 | Trend: BUY | Payload: [{"top":62600,"btm":62500,"dir":"SELL","score":2,"medal":"Normal"},{"top":62300,"btm":62200,"dir":"BUY","score":2,"medal":"Normal"}]`);

      let trend: 'BUY' | 'SELL' = 'BUY';
      
      // Bucle de simulación para generar logs coherentes de 5 días
      for (let i = 0; i < 1500; i++) {
        timestamp += step3M;
        
        // Caminata aleatoria con sesgo alcista moderado
        const change = (Math.random() - 0.47) * 45; 
        price += change;
        
        const high = price + Math.random() * 25;
        const low = price - Math.random() * 25;
        
        // Ping de precio cada 3 minutos
        lines3M.push(`PING_PRICE | TS: ${timestamp} | TF: 3 | Precio: ${price.toFixed(2)} | High: ${high.toFixed(2)} | Low: ${low.toFixed(2)}`);
        
        // Cada 6 horas (120 barras), actualizamos zonas y bias
        if (i % 120 === 0) {
          trend = Math.random() > 0.4 ? 'BUY' : 'SELL';
          lines4H.push(`SYNC_ZONES | TS: ${timestamp} | TF: 240 | Trend: ${trend} | Payload: [{"top":${(price + 1100).toFixed(2)},"btm":${(price + 800).toFixed(2)},"dir":"SELL","score":4,"medal":"God"},{"top":${(price - 800).toFixed(2)},"btm":${(price - 1200).toFixed(2)},"dir":"BUY","score":4,"medal":"God"}]`);
          lines1H.push(`SYNC_ZONES | TS: ${timestamp} | TF: 60 | Trend: ${trend} | Payload: [{"top":${(price + 550).toFixed(2)},"btm":${(price + 350).toFixed(2)},"dir":"SELL","score":3,"medal":"Silver"},{"top":${(price - 350).toFixed(2)},"btm":${(price - 550).toFixed(2)},"dir":"BUY","score":3,"medal":"Silver"}]`);
        }
        
        // Cada 3 horas (60 barras), enviamos sweeps o divergencias en 15M
        if (i % 60 === 0) {
          const isBuy = Math.random() > 0.5;
          lines15M.push(`EVENTO_SWEEP | TS: ${timestamp} | TF: 15 | ${isBuy ? 'BUY' : 'SELL'} | ABSORCION`);
          lines15M.push(`EVENTO_SMC_DIV | TS: ${timestamp} | TF: 15 | ${isBuy ? 'BUY' : 'SELL'}`);
        }
        
        // Cada 45 barras de 3M, generamos estructura (CHOCH o BOS) que gatillará un trade
        if (i % 45 === 0) {
          const dir = Math.random() > 0.35 ? 'BUY' : 'SELL';
          const origin = dir === 'BUY' ? price - 200 : price + 200;
          lines3M.push(`EVENTO_CHOCH | TS: ${timestamp} | TF: 3 | Precio: ${price.toFixed(2)} | ORIGIN: ${origin.toFixed(2)} | ${dir}`);
          
          // Hacemos que el precio retroceda hacia el OTE en las siguientes barras para asegurar que gatille un trade
          let pullbackPrice = price;
          for (let j = 1; j <= 5; j++) {
            timestamp += step3M;
            pullbackPrice = dir === 'BUY' ? price - (100 * (j / 5)) : price + (100 * (j / 5));
            const pbHigh = pullbackPrice + 5;
            const pbLow = pullbackPrice - 5;
            lines3M.push(`PING_PRICE | TS: ${timestamp} | TF: 3 | Precio: ${pullbackPrice.toFixed(2)} | High: ${pbHigh.toFixed(2)} | Low: ${pbLow.toFixed(2)}`);
          }
          
          // Y luego expandimos fuertemente a favor del trade para que toque el take profit en la gran mayoría
          let targetPrice = pullbackPrice;
          const targetReach = dir === 'BUY' ? 320 : -320;
          for (let j = 1; j <= 7; j++) {
            timestamp += step3M;
            targetPrice = pullbackPrice + (targetReach * (j / 7));
            const tHigh = targetPrice + 5;
            const tLow = targetPrice - 5;
            lines3M.push(`PING_PRICE | TS: ${timestamp} | TF: 3 | Precio: ${targetPrice.toFixed(2)} | High: ${tHigh.toFixed(2)} | Low: ${tLow.toFixed(2)}`);
          }
          price = targetPrice;
        }
      }
      
      setUploadedFiles([
        { name: 'demo_4h_premium.csv', tf: '240', lines: lines4H, lineCount: lines4H.length },
        { name: 'demo_1h_premium.csv', tf: '60', lines: lines1H, lineCount: lines1H.length },
        { name: 'demo_15m_premium.csv', tf: '15', lines: lines15M, lineCount: lines15M.length },
        { name: 'demo_3m_premium.csv', tf: '3', lines: lines3M, lineCount: lines3M.length },
      ]);
      
      setTicker('BTCUSD');
      setIsRunning(false);
      setProgress(0);
      toast('⚡ Datos Demo (BTCUSD) cargados con éxito. ¡Listo para simular u optimizar!', 'success');
    }, 500);
  }, [toast]);

  const handleRun = useCallback(() => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);
    setOptimizedSessionResults({});

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    // Run in next tick to allow UI update
    setTimeout(() => {
      const res = runBacktest(logs, { 
        ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger,
        maxDailyLossR: maxDailyLossR || undefined,
        dailyProfitTargetR: dailyProfitTargetR || undefined,
        maxConsecutiveLosses: maxConsecutiveLosses || undefined,
        maxTradesPerDay: maxTradesPerDay || undefined,
        trailingDrawdownR: trailingDrawdownR || undefined,
      }, (pct, currentTrades) => {
        setProgress(pct);
        setTrades([...currentTrades]);
      });
      setResult(res);
      setTrades(res.trades);
      setProgress(100);
      setIsRunning(false);

      // Save to history
      const closed = res.trades.filter(t => t.result && t.result !== 'TIMEOUT');
      const wins = closed.filter(t => t.result === 'WIN').length;
      const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
      const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(2);
      const session: SessionHistory = {
        id: `BT_${Date.now()}`, ticker, date: res.startDate + ' → ' + res.endDate,
        trades: res.trades.length, winRate: wr, pnl, status: 'completed',
        tradeData: res.trades,
        config: { minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger }
      };
      setSessions(prev => {
        const next = [session, ...prev].slice(0, 20);
        localStorage.setItem('bt_sessions', JSON.stringify(next));
        return next;
      });
      setSelectedSession(session.id);
      toast(`✅ Backtest completado: ${res.trades.length} trades detectados`, 'success');
    }, 50);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, toast]);

  const handleOptimize = useCallback(() => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);
    setOptimizedSessionResults({});

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    const slOptions = [0, 0.05, 0.1, 0.2];
    const rrOptions = [1.5, 2.0, 2.5, 3.0, 4.0];
    const oteOptions = [50, 62, 79];
    const scoreOptions = [5, 8, 12, 15, 20]; // Puntos mínimos simétricos

    const combinations: {sl:number, rr:number, ote:number, score:number, trigger: 'CHOCH' | 'OTE' | 'BOTH'}[] = [];
    for (const sl of slOptions) {
      for (const rr of rrOptions) {
        for (const ote of oteOptions) {
          for (const score of scoreOptions) {
            combinations.push({ sl, rr, ote, score, trigger: entryTrigger });
          }
        }
      }
    }

    const bestPnl: Record<string, number> = { ALL: -Infinity, LONDON: -Infinity, NY: -Infinity, ASIA: -Infinity };
    const bestData: Record<string, { config: any, result: BacktestResult }> = {};

    const processChunk = (startIndex: number) => {
        const chunkSize = 10;
        const endIndex = Math.min(startIndex + chunkSize, combinations.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            const c = combinations[i];
            const config = { 
                ticker, minBuyPoints: c.score, minSellPoints: c.score, slBufferPercent: c.sl, fixedRR: c.rr, oteEntryPercent: c.ote, entryTrigger: c.trigger,
                maxDailyLossR: maxDailyLossR || undefined,
                dailyProfitTargetR: dailyProfitTargetR || undefined,
                maxConsecutiveLosses: maxConsecutiveLosses || undefined,
                maxTradesPerDay: maxTradesPerDay || undefined,
                trailingDrawdownR: trailingDrawdownR || undefined,
            };
            const res = runBacktest(logs, config);
            
            const sessionsToEval = ['ALL', 'LONDON', 'NY', 'ASIA'] as const;
            sessionsToEval.forEach(s => {
                const sessionTrades = s === 'ALL'
                    ? res.trades
                    : res.trades.filter(t => getSessionForTimestamp(t.timestamp) === s);
                
                const closed = sessionTrades.filter(t => t.result && t.result !== 'TIMEOUT');
                const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
                
                if (pnl > bestPnl[s]) {
                    bestPnl[s] = pnl;
                    bestData[s] = { config, result: res };
                }
            });
        }
        
        setProgress(Math.floor((endIndex / combinations.length) * 100));
        
        if (endIndex < combinations.length) {
            setTimeout(() => processChunk(endIndex), 20);
        } else if (Object.keys(bestData).length > 0) {
            setOptimizedSessionResults(bestData);
            
            const currentData = bestData[sessionFilter] || bestData['ALL'];
            const bestConfig = currentData.config;
            const bestResult = currentData.result;
            
            setResult(bestResult);
            setTrades(bestResult.trades);
            setSlBufferPercent(bestConfig.slBufferPercent);
            setFixedRR(bestConfig.fixedRR);
            setOteEntryPercent(bestConfig.oteEntryPercent);
            setEntryTrigger(bestConfig.entryTrigger);
            setMinBuyPoints(bestConfig.minBuyPoints);
            setMinSellPoints(bestConfig.minSellPoints);
            
            const closed = bestResult.trades.filter(t => t.result && t.result !== 'TIMEOUT');
            const wins = closed.filter(t => t.result === 'WIN').length;
            const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
            const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(2);
            const session: SessionHistory = {
              id: `BT_OPT_${Date.now()}`, ticker, date: bestResult.startDate + ' → ' + bestResult.endDate,
              trades: bestResult.trades.length, winRate: wr, pnl, status: 'completed',
              tradeData: bestResult.trades,
              config: bestConfig
            };
            setSessions(prev => {
              const next = [session, ...prev].slice(0, 20);
              localStorage.setItem('bt_sessions', JSON.stringify(next));
              return next;
            });
            setSelectedSession(session.id);
            setIsRunning(false);
            toast(`✅ Optimización finalizada para TODAS las sesiones.`, 'success');
        }
    };
    
    setTimeout(() => processChunk(0), 100);
  }, [uploadedFiles, ticker, entryTrigger, sessionFilter, toast, getSessionForTimestamp]);

  const filteredTrades = sessionFilter === 'ALL'
    ? trades
    : trades.filter(t => getSessionForTimestamp(t.timestamp) === sessionFilter);

  const doubleFilteredTrades = tradeFilter === 'ALL'
    ? filteredTrades
    : filteredTrades.filter(t => {
        if (tradeFilter === 'BOS') return t.events?.some(e => e.includes('EVENTO_BOS'));
        if (tradeFilter === 'CHOCH') return t.events?.some(e => e.includes('EVENTO_CHOCH'));
        if (tradeFilter === 'OTE') return t.events?.some(e => e.includes('OTE_Retracement'));
        return true;
    });

  // Metrics
  const metrics = (() => {
    const closed = doubleFilteredTrades.filter(t => t.result && t.result !== 'TIMEOUT');
    const wins = closed.filter(t => t.result === 'WIN').length;
    const losses = closed.filter(t => t.result === 'LOSS').length;
    const be = closed.filter(t => t.result === 'BE').length;
    const open = doubleFilteredTrades.filter(t => !t.result).length;
    
    const pnlTotalUsd = closed.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0);
    const pnlTotalR = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
    
    const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '—';
    
    let maxDD = 0, peak = 0;
    let grossProfitUsd = 0, grossLossUsd = 0;
    let maxConsLosses = 0, currentLossStreak = 0;
    let totalDuration = 0, tradesWithDuration = 0;
    
    let tp1OnlyCount = 0, tp2Count = 0, slCount = 0, beCount = 0;

    closed.forEach(t => {
      const r = t.rMultiple || 0;
      const profitUsd = r * riskUsd;
      
      // Drawdown (Usd based)
      peak += profitUsd;
      if (peak < maxDD) maxDD = peak;

      // Profit Factor
      if (profitUsd > 0) grossProfitUsd += profitUsd;
      else grossLossUsd += Math.abs(profitUsd);

      // Consecutive Losses
      if (t.result === 'LOSS') {
        currentLossStreak++;
        if (currentLossStreak > maxConsLosses) maxConsLosses = currentLossStreak;
      } else if (t.result === 'WIN') {
        currentLossStreak = 0;
      }

      // Duration
      if (t.durationMin) {
        totalDuration += t.durationMin;
        tradesWithDuration++;
      }

      // Distribution
      if (t.result === 'WIN') {
          if (t.resultTp2 === 'WIN') tp2Count++;
          else tp1OnlyCount++;
      } else if (t.result === 'LOSS') {
          slCount++;
      } else if (t.result === 'BE') {
          beCount++;
      }
    });

    const profitFactor = grossLossUsd > 0 ? (grossProfitUsd / grossLossUsd).toFixed(2) : (grossProfitUsd > 0 ? '∞' : '0.00');
    const expectancyR = closed.length > 0 ? (pnlTotalR / closed.length).toFixed(2) : '0.00';
    const avgDurationMin = tradesWithDuration > 0 ? Math.round(totalDuration / tradesWithDuration) : 0;
    
    const formatDuration = (mins: number) => {
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    return { 
        wins, losses, be, open, wr, 
        pnlUsd: pnlTotalUsd.toFixed(2), 
        pnlR: pnlTotalR.toFixed(2),
        count: closed.length, total: doubleFilteredTrades.length, 
        maxDDUsd: maxDD.toFixed(2), closed,
        profitFactor, expectancyR, maxConsLosses, avgDuration: formatDuration(avgDurationMin),
        tp1OnlyCount, tp2Count, slCount, beCount
    };
  })();

  const equityData = [{ name: 'Start', TP1: 0, TP2: 0 }];
  let cumTp1 = 0;
  let cumTp2 = 0;
  metrics.closed.forEach((t, i) => {
    cumTp1 += (t.rMultipleTp1 || 0) * riskUsd;
    cumTp2 += (t.rMultipleTp2 || 0) * riskUsd;
    equityData.push({
      name: `T${i + 1}`,
      TP1: parseFloat(cumTp1.toFixed(2)),
      TP2: parseFloat(cumTp2.toFixed(2)),
    });
  });

  const resultColor = (r?: string) => r === 'WIN' ? 'var(--accent-green)' : r === 'LOSS' ? 'var(--accent-red)' : r === 'BE' ? 'var(--accent-gold)' : 'var(--text-tertiary)';

  const handleDownloadJson = useCallback(() => {
    if (!result || trades.length === 0) {
      toast('No hay resultados para descargar', 'error');
      return;
    }
    
    const downloadData = {
      metadata: {
        ticker,
        exportDate: new Date().toISOString(),
        timeframe: result.startDate + ' -> ' + result.endDate,
        sessionFilter,
        tradeFilter
      },
      config: {
        minBuyPoints,
        minSellPoints,
        slBufferPercent,
        fixedRR,
        oteEntryPercent,
        entryTrigger
      },
      metrics: {
        ...metrics
      },
      trades: doubleFilteredTrades
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(downloadData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `jarvis_bt_${ticker}_${new Date().getTime()}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    toast('✅ Archivo JSON descargado con éxito', 'success');
  }, [result, trades, ticker, sessionFilter, tradeFilter, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, metrics, doubleFilteredTrades, toast]);

  return (
    <div className="animate-fadeIn">
      <div className="panel-header">
        <span><Upload size={14} style={{ marginRight: 8 }} /> BACKTESTING STANDALONE v3.0 {isRunning && <span className="live-dot"></span>}</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Motor local — sin servidor requerido</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* UPLOAD */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Upload size={18} color="var(--accent-gold)" /> SUBIR LOGS CSV
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>ACTIVO</label>
                <input type="text" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} className="mono" placeholder="BTCUSD"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>TIPO GATILLO</label>
                <select value={entryTrigger} onChange={e => setEntryTrigger(e.target.value as 'CHOCH' | 'OTE' | 'BOTH')}
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}>
                  <option value="OTE">Fibonacci (OTE)</option>
                  <option value="CHOCH">Ruptura (CHOCH)</option>
                  <option value="BOTH">Ambos</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN BUY</label>
                <input type="number" value={minBuyPoints} onChange={e => setMinBuyPoints(Number(e.target.value))} className="mono"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MIN SELL</label>
                <input type="number" value={minSellPoints} onChange={e => setMinSellPoints(Number(e.target.value))} className="mono"
                  style={{ width: '100%', padding: '8px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', padding: '8px 10px', backgroundColor: 'rgba(255,51,51,0.05)', borderRadius: '4px', border: '1px solid rgba(255,51,51,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-red)', whiteSpace: 'nowrap', fontWeight: 600 }}>🛡️ SL BUF (Rel)</label>
              <input type="range" min="0" max="0.5" step="0.01" value={slBufferPercent} onChange={e => setSlBufferPercent(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{slBufferPercent}</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(0,136,255,0.05)', borderRadius: '4px', border: '1px solid rgba(0,136,255,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: '#0088ff', whiteSpace: 'nowrap', fontWeight: 600 }}>🎯 TP2 R:R</label>
              <input type="range" min="1" max="5" step="0.1" value={fixedRR} onChange={e => setFixedRR(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: '#0088ff', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{fixedRR}x</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(255,170,0,0.05)', borderRadius: '4px', border: '1px solid rgba(255,170,0,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-gold)', whiteSpace: 'nowrap', fontWeight: 600 }}>📉 OTE ENTRY</label>
              <input type="range" min="10" max="90" step="1" value={oteEntryPercent} onChange={e => setOteEntryPercent(parseFloat(e.target.value))}
                style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: '0.75rem', color: 'var(--accent-gold)', fontWeight: 700, minWidth: '42px', textAlign: 'right' }}>{oteEntryPercent}%</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(32,191,107,0.05)', borderRadius: '4px', border: '1px solid rgba(32,191,107,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600 }}>💵 RIESGO (USD)</label>
              <input type="number" min="1" step="1" value={riskUsd} onChange={e => setRiskUsd(parseFloat(e.target.value) || 0)}
                style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
            </div>

            {/* KILLSWITCHES */}
            <div style={{ padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-color)', marginBottom: '12px' }}>
              <h4 style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ShieldAlert size={14} color="var(--accent-red)" /> KILLSWITCHES (0 = APAGADO)
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
                <div>
                  <label style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MAX DAILY LOSS (R)</label>
                  <input type="number" min="0" step="0.5" value={maxDailyLossR} onChange={e => setMaxDailyLossR(parseFloat(e.target.value) || 0)} className="mono"
                    style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>DAILY TARGET (R)</label>
                  <input type="number" min="0" step="0.5" value={dailyProfitTargetR} onChange={e => setDailyProfitTargetR(parseFloat(e.target.value) || 0)} className="mono"
                    style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MAX CONS. LOSS</label>
                  <input type="number" min="0" step="1" value={maxConsecutiveLosses} onChange={e => setMaxConsecutiveLosses(parseInt(e.target.value) || 0)} className="mono"
                    style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>MAX TRADES/DAY</label>
                  <input type="number" min="0" step="1" value={maxTradesPerDay} onChange={e => setMaxTradesPerDay(parseInt(e.target.value) || 0)} className="mono"
                    style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', display: 'block', marginBottom: '2px' }}>TRAIL DD (R)</label>
                  <input type="number" min="0" step="0.5" value={trailingDrawdownR} onChange={e => setTrailingDrawdownR(parseFloat(e.target.value) || 0)} className="mono"
                    style={{ width: '100%', padding: '6px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </div>
              </div>
            </div>

            <button 
              type="button" 
              onClick={loadDemoData} 
              disabled={isRunning}
              style={{
                width: '100%',
                padding: '12px',
                marginBottom: '12px',
                background: 'linear-gradient(135deg, rgba(124,77,255,0.2) 0%, rgba(255,170,0,0.15) 100%)',
                color: 'var(--text-primary)',
                border: '1px solid rgba(255,170,0,0.3)',
                borderRadius: '8px',
                fontWeight: 700,
                fontSize: '0.75rem',
                cursor: isRunning ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                transition: 'all 0.3s ease',
                boxShadow: '0 4px 15px rgba(0,0,0,0.2)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.border = '1px solid var(--accent-gold)';
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(124,77,255,0.3) 0%, rgba(255,170,0,0.25) 100%)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.border = '1px solid rgba(255,170,0,0.3)';
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(124,77,255,0.2) 0%, rgba(255,170,0,0.15) 100%)';
              }}
            >
              <Wand2 size={14} color="var(--accent-gold)" /> ⚡ CARGAR SIMULACIÓN DEMO (UN CLICK)
            </button>

            <div style={{ border: '2px dashed var(--border-color)', borderRadius: '8px', padding: '16px', textAlign: 'center', cursor: 'pointer', marginBottom: '12px', transition: 'border-color 0.2s' }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent-gold)'; }}
              onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; }}
              onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-color)'; if (e.dataTransfer.files.length) { const dt = new DataTransfer(); Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f)); const input = fileInputRef.current; if (input) { input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); } } }}>
              <FileText size={24} color="var(--text-tertiary)" style={{ marginBottom: '8px' }} />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Click o arrastrá los 4 CSV del Pine Editor
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                Auto-detecta TF por contenido (3M, 15M, 1H, 4H)
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept=".csv,.txt,.log" multiple onChange={handleFilesUpload} style={{ display: 'none' }} />

            {uploadedFiles.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }}>
                {uploadedFiles.map(f => (
                  <div key={f.tf} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.8rem', color: TF_COLOR[f.tf] || 'var(--text-primary)', minWidth: '32px' }}>
                      {TF_LABEL[f.tf] || f.tf}
                    </span>
                    <span style={{ flex: 1, fontSize: '0.65rem', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--accent-green)', fontWeight: 600 }}>
                      ✓ {f.lineCount}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={handleRun} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? '#7c4dff' : 'var(--bg-secondary)', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Play size={14} /> SIMULAR
              </button>
              <button type="button" onClick={handleOptimize} disabled={uploadedFiles.length === 0 || isRunning}
                style={{ flex: 1, padding: '10px', backgroundColor: uploadedFiles.length > 0 && !isRunning ? 'var(--accent-gold)' : 'var(--bg-secondary)', color: 'black', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: uploadedFiles.length > 0 && !isRunning ? 'pointer' : 'not-allowed', opacity: uploadedFiles.length > 0 ? 1 : 0.5, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Wand2 size={14} /> OPTIMIZAR
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="button" onClick={handlePushToBot}
                  style={{ flex: 1, padding: '10px', backgroundColor: '#0088ff', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Upload size={14} /> EXPORTAR A JARVIS
                </button>
                <button type="button" onClick={handleDownloadJson} disabled={!result || trades.length === 0}
                  style={{ flex: 1, padding: '10px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontWeight: 700, cursor: (!result || trades.length === 0) ? 'not-allowed' : 'pointer', opacity: (!result || trades.length === 0) ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Download size={14} /> DESCARGAR JSON
                </button>
                {uploadedFiles.length > 0 && !isRunning && (
                  <button type="button" onClick={() => { setUploadedFiles([]); setTrades([]); setResult(null); setProgress(0); }}
                    style={{ padding: '10px 14px', backgroundColor: 'transparent', color: 'var(--text-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer' }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', textAlign: 'center', padding: '0 10px' }}>
                Guarda esta configuración (SL, TP, Gatillos) en Firebase para que el Bot de Telegram la use en vivo.
              </div>
            </div>

            {isRunning && (
              <div style={{ marginTop: '10px' }}>
                <div style={{ height: '4px', backgroundColor: 'var(--border-color)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${progress}%`, backgroundColor: '#7c4dff', transition: 'width 0.3s ease', borderRadius: '2px' }} />
                </div>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '4px', textAlign: 'center' }}>
                  {progress}% — {trades.length} trades detectados
                </div>
              </div>
            )}
          </div>

          {/* METRICS */}
          <div className="panel">
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BarChart2 size={18} color="var(--accent-gold)" /> DASHBOARD AVANZADO
            </h3>
            
            {/* ROW 1: Principales */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.5fr 0.8fr', gap: '8px', marginBottom: '8px' }}>
              <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>WIN RATE</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--accent-gold)' }}>{metrics.wr}%</div>
              </div>
              <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>PROFIT FACTOR</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 700, color: parseFloat(metrics.profitFactor) >= 1.5 ? 'var(--accent-green)' : parseFloat(metrics.profitFactor) >= 1.0 ? 'var(--accent-gold)' : 'var(--accent-red)' }}>{metrics.profitFactor}</div>
              </div>
              <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>PNL TOTAL</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 700, color: parseFloat(metrics.pnlR) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                  {parseFloat(metrics.pnlR) > 0 ? '+' : ''}{metrics.pnlR}R <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-secondary)' }}>/ ${metrics.pnlUsd}</span>
                </div>
              </div>
              <div style={{ textAlign: 'center', padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>TRADES</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)' }}>{metrics.count}</div>
              </div>
            </div>

            {/* ROW 2: Analíticas */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
              <div style={{ textAlign: 'center', padding: '8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>ESPERANZA MAT.</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: parseFloat(metrics.expectancyR) > 0 ? 'var(--accent-green)' : 'var(--text-primary)' }}>{parseFloat(metrics.expectancyR) > 0 ? '+' : ''}{metrics.expectancyR}R</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>MAX DRAWDOWN</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent-red)' }}>-${metrics.maxDDUsd.replace('-', '')}</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>PEOR RACHA (L)</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: metrics.maxConsLosses >= 5 ? 'var(--accent-red)' : 'var(--text-primary)' }}>{metrics.maxConsLosses}</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>DURACIÓN PROM.</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>{metrics.avgDuration}</div>
              </div>
            </div>

            {/* ROW 3: Distribución */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 0.5fr', gap: '6px' }}>
              <div style={{ textAlign: 'center', padding: '6px', fontSize: '0.65rem' }}>
                <span style={{ color: '#0088ff', fontWeight: 700 }}>{metrics.tp2Count}</span> <span style={{ color: 'var(--text-tertiary)' }}>TP2</span>
              </div>
              <div style={{ textAlign: 'center', padding: '6px', fontSize: '0.65rem' }}>
                <span style={{ color: 'var(--accent-green)', fontWeight: 700 }}>{metrics.tp1OnlyCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>TP1</span>
              </div>
              <div style={{ textAlign: 'center', padding: '6px', fontSize: '0.65rem' }}>
                <span style={{ color: 'var(--accent-gold)', fontWeight: 700 }}>{metrics.beCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>BE</span>
              </div>
              <div style={{ textAlign: 'center', padding: '6px', fontSize: '0.65rem' }}>
                <span style={{ color: 'var(--accent-red)', fontWeight: 700 }}>{metrics.slCount}</span> <span style={{ color: 'var(--text-tertiary)' }}>SL</span>
              </div>
              <div style={{ textAlign: 'center', padding: '6px', fontSize: '0.65rem' }}>
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 700 }}>{metrics.open}</span> <span style={{ color: 'var(--text-tertiary)' }}>OP</span>
              </div>
            </div>
            {result && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '8px', textAlign: 'center' }}>
                {result.processedEvents.toLocaleString()} eventos procesados | {result.startDate} → {result.endDate}
              </div>
            )}
            
            {/* EQUITY CURVE */}
            {metrics.closed.length > 0 && (
              <div style={{ marginTop: '24px', height: '200px', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '16px 16px 16px 0' }}>
                <h4 style={{ marginLeft: '16px', marginBottom: '12px', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>CURVA DE CAPITAL (EQUITY CURVE)</h4>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={equityData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                    <XAxis dataKey="name" stroke="var(--text-tertiary)" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="var(--text-tertiary)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} width={40} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '0.8rem' }}
                      itemStyle={{ padding: 0 }}
                      formatter={(value: any) => [`$${value}`]}
                    />
                    <Line type="monotone" dataKey="TP1" name="PNL TP1" stroke="var(--accent-green)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="TP2" name="PNL TP2" stroke="#0088ff" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

          {/* TRADES TABLE */}
          <div className="panel" style={{ flex: 1 }}>
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <TrendingUp size={18} color="var(--accent-gold)" /> TRADES DETECTADOS {isRunning && <span className="live-dot"></span>}
              </span>
              {trades.length > 0 && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {doubleFilteredTrades.length}{tradeFilter !== 'ALL' || sessionFilter !== 'ALL' ? `/${trades.length}` : ''} total
                </span>
              )}
            </h3>
            {/* Session Filter */}
            {trades.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                {(['ALL', 'LONDON', 'NY', 'ASIA'] as const).map(s => {
                  const labels: Record<string, string> = { ALL: '🌍 Todas las Sesiones', LONDON: '🇬🇧 Londres (04-13h)', NY: '🇺🇸 New York (10:30-17h)', ASIA: '🇯🇵 Asia (21-06h)' };
                  const isActive = sessionFilter === s;
                  return (
                    <button key={s} onClick={() => handleSessionSelect(s as 'ALL' | 'LONDON' | 'NY' | 'ASIA')}
                      style={{
                        padding: '4px 10px', fontSize: '0.65rem', borderRadius: '4px', cursor: 'pointer',
                        border: isActive ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)',
                        background: isActive ? 'rgba(255,193,7,0.15)' : 'transparent',
                        color: isActive ? 'var(--accent-gold)' : 'var(--text-secondary)',
                        fontWeight: isActive ? 700 : 400, transition: 'all 0.2s'
                      }}>
                      {labels[s]}
                    </button>
                  );
                })}
              </div>
            )}
            {/* Trade Filter */}
            {trades.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
                {(['ALL', 'CHOCH', 'BOS', 'OTE'] as const).map(f => {
                  const labels: Record<string, string> = { ALL: '⚡ Todos los Gatillos', CHOCH: '🚀 Solo CHoCH', BOS: '🔨 Solo BOS', OTE: '📉 Solo OTE (Fibo)' };
                  const isActive = tradeFilter === f;
                  return (
                    <button key={f} onClick={() => setTradeFilter(f)}
                      style={{
                        padding: '4px 10px', fontSize: '0.65rem', borderRadius: '4px', cursor: 'pointer',
                        border: isActive ? '1px solid #0088ff' : '1px solid var(--border-color)',
                        background: isActive ? 'rgba(0,136,255,0.1)' : 'transparent',
                        color: isActive ? '#0088ff' : 'var(--text-secondary)',
                        fontWeight: isActive ? 700 : 400, transition: 'all 0.2s'
                      }}>
                      {labels[f]}
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {trades.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                  {isRunning ? 'Procesando logs...' : 'Subí logs y hacé click en REPRODUCIR'}
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>FECHA</th><th>DIR</th><th>GRADO</th><th>PTS</th><th>ENTRADA</th><th>SL</th><th>TP1</th><th>TP2</th><th>RESULTADO</th><th>PNL (TP1)</th><th>PNL (TP2)</th><th>PNL (TOTAL)</th><th>R (TOTAL)</th><th>DUR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doubleFilteredTrades.map(t => {
                      const dec = getDecimals(ticker);
                      return (
                      <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setShowLog(!showLog)}>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{new Date(t.timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                        <td style={{ color: t.direction === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 700 }}>{t.direction}</td>
                        <td style={{ fontWeight: 700, color: t.grade?.startsWith('A') ? 'var(--accent-gold)' : t.grade?.startsWith('B') ? '#0088ff' : 'var(--text-secondary)' }}>{t.grade || '-'}</td>
                        <td style={{ color: t.points >= 8 ? 'var(--accent-gold)' : 'var(--text-secondary)' }}>{t.points}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.entryPrice.toFixed(dec)}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.slPrice.toFixed(dec)}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.tp1Price.toFixed(dec)}</td>
                        <td className="mono" style={{ fontSize: '0.7rem' }}>{t.tp2Price ? t.tp2Price.toFixed(dec) : '—'}</td>
                        <td style={{ color: resultColor(t.result), fontWeight: 700 }}>{t.result || 'OPEN'}</td>
                        <td className="mono" style={{ color: (t.rMultipleTp1 || 0) > 0 ? 'var(--accent-green)' : (t.rMultipleTp1 || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem' }}>
                          {t.rMultipleTp1 !== undefined ? `${(t.rMultipleTp1 * riskUsd) > 0 ? '+$' : '-$'}${Math.abs(t.rMultipleTp1 * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ color: (t.rMultipleTp2 || 0) > 0 ? 'var(--accent-green)' : (t.rMultipleTp2 || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem' }}>
                          {t.rMultipleTp2 !== undefined ? `${(t.rMultipleTp2 * riskUsd) > 0 ? '+$' : '-$'}${Math.abs(t.rMultipleTp2 * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ color: (t.rMultiple || 0) > 0 ? 'var(--accent-green)' : (t.rMultiple || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem', fontWeight: 700 }}>
                          {t.rMultiple !== undefined ? `${(t.rMultiple * riskUsd) >= 0 ? '+$' : '-$'}${Math.abs(t.rMultiple * riskUsd).toFixed(2)}` : '—'}
                        </td>
                        <td className="mono" style={{ color: (t.rMultiple || 0) > 0 ? 'var(--accent-green)' : (t.rMultiple || 0) < 0 ? 'var(--accent-red)' : 'var(--text-tertiary)', fontSize: '0.7rem', fontWeight: 700 }}>
                          {t.rMultiple !== undefined ? `${t.rMultiple > 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R` : '—'}
                        </td>
                        <td className="mono" style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
                          {t.durationMin ? `${t.durationMin}m` : '—'}
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* SESSION HISTORY */}
          <div className="panel">
            <h3 style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL DE SESIONES (RÁPIDAS)
            </h3>
            {sessions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                Sin sesiones previas guardadas.
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '10px' }}>
                {sessions.map(s => {
                  const pnlNum = parseFloat(s.pnl);
                  return (
                  <div key={s.id}
                    style={{ minWidth: '220px', padding: '14px', cursor: 'pointer', backgroundColor: selectedSession === s.id ? 'rgba(255,170,0,0.1)' : 'var(--bg-base)', border: `1px solid ${selectedSession === s.id ? 'var(--accent-gold)' : 'var(--border-color)'}`, borderRadius: '6px', flexShrink: 0, position: 'relative' }}>
                    <div onClick={() => {
                      if (selectedSession === s.id) { setSelectedSession(null); }
                      else { 
                        setSelectedSession(s.id); 
                        if (s.tradeData) setTrades(s.tradeData); 
                        if (s.config) {
                          setMinBuyPoints(s.config.minBuyPoints);
                          setMinSellPoints(s.config.minSellPoints);
                          setSlBufferPercent(s.config.slBufferPercent);
                          setFixedRR(s.config.fixedRR);
                          setOteEntryPercent(s.config.oteEntryPercent);
                          setEntryTrigger(s.config.entryTrigger);
                        }
                      }
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 800, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{s.ticker}</span>
                        <span style={{ fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: pnlNum >= 0 ? 'rgba(32,191,107,0.1)' : 'rgba(255,51,51,0.1)', color: pnlNum >= 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 700 }}>
                          {pnlNum > 0 ? '+' : ''}{pnlNum.toFixed(2)}R
                        </span>
                      </div>
                      
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginBottom: '8px' }}>{s.date}</div>
                      
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid var(--border-color)' }}>
                        <span><span style={{ color: 'var(--text-tertiary)' }}>WR:</span> <span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>{s.winRate}%</span></span>
                        <span><span style={{ color: 'var(--text-tertiary)' }}>Trades:</span> <span style={{ fontWeight: 600 }}>{s.trades}</span></span>
                      </div>
                      
                      {s.config && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '0.65rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>⚙️ Trigger: <span style={{ color: '#0088ff', fontWeight: 600 }}>{s.config.entryTrigger}</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>🎯 RR: <span style={{ fontWeight: 600 }}>{s.config.fixedRR}x</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>🛡️ SL: <span style={{ fontWeight: 600 }}>{s.config.slBufferPercent}</span></span>
                          <span style={{ color: 'var(--text-secondary)' }}>📉 OTE: <span style={{ fontWeight: 600 }}>{s.config.oteEntryPercent}%</span></span>
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={(e) => {
                      e.stopPropagation();
                      setSessions(prev => {
                        const next = prev.filter(x => x.id !== s.id);
                        localStorage.setItem('bt_sessions', JSON.stringify(next));
                        return next;
                      });
                      if (selectedSession === s.id) { setSelectedSession(null); setTrades([]); }
                      toast('Sesión eliminada', 'success');
                    }} style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8rem', padding: '2px', borderRadius: '4px' }}
                    title="Eliminar sesión">✕</button>
                  </div>
                )})}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
