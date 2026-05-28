import { useState, useRef, useCallback } from 'react';
import { Upload, BarChart2, TrendingUp, BookOpen, Play, Trash2, FileText, Wand2, Download, ShieldAlert, Briefcase, Zap } from 'lucide-react';
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
    maxDailyLossR?: number;
    dailyProfitTargetR?: number;
    maxConsecutiveLosses?: number;
    maxTradesPerDay?: number;
    trailingDrawdownR?: number;
    enabled?: boolean;
    sessions?: Record<string, {
      choch: { enabled: boolean; minScore: number };
      bos: { enabled: boolean; minScore: number };
      ote: { enabled: boolean; minScore: number };
    }>;
  };
}

const getOverriddenSessions = (sessions: Record<string, any> | undefined, level: number) => {
  if (!sessions) return undefined;
  const updated = JSON.parse(JSON.stringify(sessions)); // deep clone to prevent mutation
  Object.keys(updated).forEach(s => {
    if (updated[s]) {
      if (!updated[s].ote) updated[s].ote = { enabled: false, minScore: 5 };
      if (!updated[s].oteChoch) updated[s].oteChoch = { enabled: false, minScore: 5 };
      if (!updated[s].oteBos) updated[s].oteBos = { enabled: false, minScore: 5 };
      
      updated[s].ote.entryPercent = level;
      updated[s].oteChoch.entryPercent = level;
      updated[s].oteBos.entryPercent = level;
    }
  });
  return updated;
};

export default function BacktestingPanel() {
  const [ticker, setTicker] = useState('BTCUSD');
  const [minBuyPoints, setMinBuyPoints] = useState(5);
  const [minSellPoints, setMinSellPoints] = useState(5);
  const [slBufferPercent, setSlBufferPercent] = useState(0.1);
  const [fixedRR, setFixedRR] = useState(2.0);
  const [oteEntryPercent, setOteEntryPercent] = useState(50);
  const [entryTrigger, setEntryTrigger] = useState<'CHOCH' | 'OTE' | 'BOTH'>('OTE');
  const [sessionTriggers, setSessionTriggers] = useState<Record<string, {
    choch: { enabled: boolean; minScore: number };
    bos: { enabled: boolean; minScore: number };
    ote: { enabled: boolean; minScore: number; entryPercent?: number };
    oteChoch: { enabled: boolean; minScore: number; entryPercent?: number };
    oteBos: { enabled: boolean; minScore: number; entryPercent?: number };
    slBufferPercent?: number;
    fixedRR?: number;
  }>>(() => {
    try {
      const saved = localStorage.getItem('bt_session_triggers');
      if (saved) {
        const parsed = JSON.parse(saved);
        for (const s of ['ALL', 'LONDON', 'NY', 'ASIA']) {
          if (parsed[s]) {
            if (!parsed[s].ote) parsed[s].ote = { enabled: true, minScore: 8, entryPercent: 62 };
            if (parsed[s].ote.entryPercent === undefined) parsed[s].ote.entryPercent = 62;
            if (!parsed[s].oteChoch) parsed[s].oteChoch = { enabled: true, minScore: 8, entryPercent: 62 };
            if (parsed[s].oteChoch.entryPercent === undefined) parsed[s].oteChoch.entryPercent = 62;
            if (!parsed[s].oteBos) parsed[s].oteBos = { enabled: true, minScore: 8, entryPercent: 62 };
            if (parsed[s].oteBos.entryPercent === undefined) parsed[s].oteBos.entryPercent = 62;
            if (parsed[s].slBufferPercent === undefined) parsed[s].slBufferPercent = 0.1;
            if (parsed[s].fixedRR === undefined) parsed[s].fixedRR = 2.0;
          }
        }
        return parsed;
      }
    } catch {}
    return {
      ALL: {
        choch: { enabled: true, minScore: 5 },
        bos: { enabled: true, minScore: 10 },
        ote: { enabled: true, minScore: 8, entryPercent: 62 },
        oteChoch: { enabled: true, minScore: 8, entryPercent: 62 },
        oteBos: { enabled: true, minScore: 8, entryPercent: 62 },
        slBufferPercent: 0.1,
        fixedRR: 2.0
      },
      LONDON: {
        choch: { enabled: true, minScore: 5 },
        bos: { enabled: true, minScore: 10 },
        ote: { enabled: true, minScore: 8, entryPercent: 62 },
        oteChoch: { enabled: true, minScore: 8, entryPercent: 62 },
        oteBos: { enabled: true, minScore: 8, entryPercent: 62 },
        slBufferPercent: 0.1,
        fixedRR: 2.0
      },
      NY: {
        choch: { enabled: true, minScore: 5 },
        bos: { enabled: true, minScore: 10 },
        ote: { enabled: true, minScore: 8, entryPercent: 62 },
        oteChoch: { enabled: true, minScore: 8, entryPercent: 62 },
        oteBos: { enabled: true, minScore: 8, entryPercent: 62 },
        slBufferPercent: 0.1,
        fixedRR: 2.0
      },
      ASIA: {
        choch: { enabled: true, minScore: 5 },
        bos: { enabled: true, minScore: 10 },
        ote: { enabled: true, minScore: 8, entryPercent: 62 },
        oteChoch: { enabled: true, minScore: 8, entryPercent: 62 },
        oteBos: { enabled: true, minScore: 8, entryPercent: 62 },
        slBufferPercent: 0.1,
        fixedRR: 2.0
      }
    };
  });

  const updateSessionTrigger = (
    session: string,
    triggerType: 'choch' | 'bos' | 'ote' | 'oteChoch' | 'oteBos' | 'slBufferPercent' | 'fixedRR',
    field: 'enabled' | 'minScore' | 'entryPercent' | '',
    value: any
  ) => {
    setSessionTriggers(prev => {
      let updatedSession = { ...prev[session] };
      if (triggerType === 'slBufferPercent' || triggerType === 'fixedRR') {
        updatedSession[triggerType] = value;
      } else {
        const type = triggerType as 'choch' | 'bos' | 'ote' | 'oteChoch' | 'oteBos';
        const f = field as 'enabled' | 'minScore' | 'entryPercent';
        updatedSession[type] = {
          ...updatedSession[type],
          [f]: value
        };
      }

      const next = {
        ...prev,
        [session]: updatedSession
      };
      localStorage.setItem('bt_session_triggers', JSON.stringify(next));
      return next;
    });
  };
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
  const [trades50, setTrades50] = useState<BacktestTrade[]>([]);
  const [trades62, setTrades62] = useState<BacktestTrade[]>([]);
  const [trades79, setTrades79] = useState<BacktestTrade[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [sessions, setSessions] = useState<SessionHistory[]>(() => {
    try { return JSON.parse(localStorage.getItem('bt_sessions') || '[]'); } catch { return []; }
  });
  const [showLog, setShowLog] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<'ALL' | 'LONDON' | 'NY' | 'ASIA'>('ALL');
  const [tradeFilter, setTradeFilter] = useState<'ALL' | 'BOS' | 'CHOCH' | 'OTE' | 'OTE_CHOCH' | 'OTE_BOS'>('ALL');
  const [scoreFilterMin, setScoreFilterMin] = useState<number>(5);
  const [scoreFilterMax, setScoreFilterMax] = useState<number>(30);
  const [oteFilter, setOteFilter] = useState<50 | 62 | 79>(50);
  const optimizeSwitches = false;
  const [optimizedSessionResults, setOptimizedSessionResults] = useState<Record<string, { config: any, result: BacktestResult }>>({});
  const [enabled, setEnabled] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  // 🗂️ TABS PRINCIPALES (INDIVIDUAL VS PORTAFOLIO GLOBAL)
  const [activeTab, setActiveTab] = useState<'individual' | 'portfolio'>('individual');

  // 💼 ESTADOS PORTAFOLIO GLOBAL
  interface PortfolioAssetFile {
    name: string;
    ticker: string;
    trades: any[];
  }
  const [portfolioFiles, setPortfolioFiles] = useState<PortfolioAssetFile[]>([]);
  const [globalMDL, setGlobalMDL] = useState(3.0);
  const [globalDPT, setGlobalDPT] = useState(5.0);
  const [globalMCL, setGlobalMCL] = useState(3);
  const [globalMTD, setGlobalMTD] = useState(4);
  const [globalTDD, setGlobalTDD] = useState(3.0);
  const [portfolioResults, setPortfolioResults] = useState<{
    trades: any[];
    metrics: any;
    equityData: any[];
  } | null>(null);
  const [isOptimizingPortfolio, setIsOptimizingPortfolio] = useState(false);
  const [portfolioOptResults, setPortfolioOptResults] = useState<any[]>([]);

  const TF_ORDER: Record<string, number> = { '240': 0, '60': 1, '15': 2, '3': 3 };
  const TF_LABEL: Record<string, string> = { '240': '4H', '60': '1H', '15': '15M', '3': '3M' };
  const TF_COLOR: Record<string, string> = { '240': '#7c4dff', '60': '#0088ff', '15': 'var(--accent-gold)', '3': 'var(--accent-red)' };

  const getSessionForTimestamp = useCallback((ts: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' => {
    const d = new Date(ts);
    const arHour = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
    const arMin = parseInt(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', minute: 'numeric' }));
    const timeDecimal = arHour + arMin / 60;
    
    // Asia: 21:00 - 04:00 AR
    if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
    // London: 04:00 - 10:30 AR
    if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
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
      setOteFilter(config.oteEntryPercent as 50 | 62 | 79);
      setEntryTrigger(config.entryTrigger);
      setMinBuyPoints(config.minBuyPoints);
      setMinSellPoints(config.minSellPoints);
      setMaxDailyLossR(config.maxDailyLossR || 0);
      setDailyProfitTargetR(config.dailyProfitTargetR || 0);
      setMaxConsecutiveLosses(config.maxConsecutiveLosses || 0);
      setMaxTradesPerDay(config.maxTradesPerDay || 0);
      setTrailingDrawdownR(config.trailingDrawdownR || 0);
      setEnabled(config.enabled !== false);
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
        enabled: enabled,
        sessions: sessionTriggers,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configurada ${configDoc} en JARVIS (${enabled ? 'HABILITADA' : 'DESHABILITADA'})`, 'success');
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

  const handleRun = useCallback((overrideOte?: number, overrideSessions?: Record<string, any>) => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true); setProgress(0); setTrades([]); setResult(null);
    setOptimizedSessionResults({});

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    const finalOte = overrideOte !== undefined ? overrideOte : oteEntryPercent;
    const finalSessions = overrideSessions !== undefined ? overrideSessions : sessionTriggers;

    // Run in next tick to allow UI update
    setTimeout(() => {
      const baseParams = {
        ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, entryTrigger,
        maxDailyLossR: maxDailyLossR || undefined,
        dailyProfitTargetR: dailyProfitTargetR || undefined,
        maxConsecutiveLosses: maxConsecutiveLosses || undefined,
        maxTradesPerDay: maxTradesPerDay || undefined,
        trailingDrawdownR: trailingDrawdownR || undefined,
      };

      const res = runBacktest(logs, { 
        ...baseParams,
        oteEntryPercent: finalOte,
        sessions: finalSessions,
      }, (pct, currentTrades) => {
        setProgress(pct);
        setTrades([...currentTrades]);
      });

      // Run background simulations for OTE level comparisons and fast filtering
      const sessions50 = getOverriddenSessions(finalSessions, 50);
      const sessions62 = getOverriddenSessions(finalSessions, 62);
      const sessions79 = getOverriddenSessions(finalSessions, 79);

      const res50 = runBacktest(logs, { ...baseParams, oteEntryPercent: 50, sessions: sessions50 });
      const res62 = runBacktest(logs, { ...baseParams, oteEntryPercent: 62, sessions: sessions62 });
      const res79 = runBacktest(logs, { ...baseParams, oteEntryPercent: 79, sessions: sessions79 });

      setResult(res);
      setTrades(res.trades);
      setTrades50(res50.trades);
      setTrades62(res62.trades);
      setTrades79(res79.trades);
      setOteFilter(finalOte as 50 | 62 | 79);
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
        config: { 
          minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent: finalOte, entryTrigger,
          sessions: finalSessions,
        }
      };
      setSessions(prev => {
        const next = [session, ...prev].slice(0, 20);
        localStorage.setItem('bt_sessions', JSON.stringify(next));
        return next;
      });
      setSelectedSession(session.id);
      toast(`✅ Backtest completado: ${res.trades.length} trades detectados`, 'success');
    }, 50);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR, sessionTriggers, toast]);

  const handleDashboardOteSelect = useCallback((level: number) => {
    // 1. Update oteEntryPercent state
    setOteEntryPercent(level);
    
    // 2. Prepare the updated session triggers object
    const updatedSessions = { ...sessionTriggers };
    if (sessionFilter === 'ALL') {
      Object.keys(updatedSessions).forEach(s => {
        if (updatedSessions[s]) {
          updatedSessions[s] = {
            ...updatedSessions[s],
            ote: { ...updatedSessions[s].ote, entryPercent: level },
            oteChoch: { ...updatedSessions[s].oteChoch, entryPercent: level },
            oteBos: { ...updatedSessions[s].oteBos, entryPercent: level },
          };
        }
      });
    } else {
      if (updatedSessions[sessionFilter]) {
        updatedSessions[sessionFilter] = {
          ...updatedSessions[sessionFilter],
          ote: { ...updatedSessions[sessionFilter].ote, entryPercent: level },
          oteChoch: { ...updatedSessions[sessionFilter].oteChoch, entryPercent: level },
          oteBos: { ...updatedSessions[sessionFilter].oteBos, entryPercent: level },
        };
      }
    }
    
    // 3. Update sessionTriggers state
    setSessionTriggers(updatedSessions);
    localStorage.setItem('bt_session_triggers', JSON.stringify(updatedSessions));
    
    // 4. Execute the backtest with the overrides
    handleRun(level, updatedSessions);
  }, [sessionFilter, sessionTriggers, handleRun]);

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

    const finalizeOptimization = () => {
        if (Object.keys(bestData).length > 0) {
            setOptimizedSessionResults(bestData);
            
            const currentData = bestData[sessionFilter] || bestData['ALL'];
            const bestConfig = currentData.config;
            const bestResult = currentData.result;
            
            setResult(bestResult);
            setTrades(bestResult.trades);
            setSlBufferPercent(bestConfig.slBufferPercent);
            setFixedRR(bestConfig.fixedRR);
            setOteEntryPercent(bestConfig.oteEntryPercent);
            setOteFilter(bestConfig.oteEntryPercent as 50 | 62 | 79);
            setEntryTrigger(bestConfig.entryTrigger);
            setMinBuyPoints(bestConfig.minBuyPoints);
            setMinSellPoints(bestConfig.minSellPoints);

            // Also set killswitch state in the UI so the user sees the optimized values!
            setMaxDailyLossR(bestConfig.maxDailyLossR || 0);
            setDailyProfitTargetR(bestConfig.dailyProfitTargetR || 0);
            setMaxConsecutiveLosses(bestConfig.maxConsecutiveLosses || 0);
            setMaxTradesPerDay(bestConfig.maxTradesPerDay || 0);
            setTrailingDrawdownR(bestConfig.trailingDrawdownR || 0);
            setEnabled(bestConfig.enabled !== false);
            
            const closed = bestResult.trades.filter(t => t.result && t.result !== 'TIMEOUT');
            const wins = closed.filter(t => t.result === 'WIN').length;
            const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
            const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(2);
             const session: SessionHistory = {
              id: `BT_OPT_${Date.now()}`, ticker, date: bestResult.startDate + ' → ' + bestResult.endDate,
              trades: bestResult.trades.length, winRate: wr, pnl, status: 'completed',
              tradeData: bestResult.trades,
              config: {
                ...bestConfig,
                sessions: sessionTriggers,
              }
            };
            setSessions(prev => {
              const next = [session, ...prev].slice(0, 20);
              localStorage.setItem('bt_sessions', JSON.stringify(next));
              return next;
            });
            const baseParams = {
              ticker,
              minBuyPoints: bestConfig.minBuyPoints,
              minSellPoints: bestConfig.minSellPoints,
              slBufferPercent: bestConfig.slBufferPercent,
              fixedRR: bestConfig.fixedRR,
              entryTrigger: bestConfig.entryTrigger,
              maxDailyLossR: bestConfig.maxDailyLossR || undefined,
              dailyProfitTargetR: bestConfig.dailyProfitTargetR || undefined,
              maxConsecutiveLosses: bestConfig.maxConsecutiveLosses || undefined,
              maxTradesPerDay: bestConfig.maxTradesPerDay || undefined,
              trailingDrawdownR: bestConfig.trailingDrawdownR || undefined,
            };

            const sessions50 = getOverriddenSessions(sessionTriggers, 50);
            const sessions62 = getOverriddenSessions(sessionTriggers, 62);
            const sessions79 = getOverriddenSessions(sessionTriggers, 79);

            const res50 = runBacktest(logs, { ...baseParams, oteEntryPercent: 50, sessions: sessions50 });
            const res62 = runBacktest(logs, { ...baseParams, oteEntryPercent: 62, sessions: sessions62 });
            const res79 = runBacktest(logs, { ...baseParams, oteEntryPercent: 79, sessions: sessions79 });

            setTrades50(res50.trades);
            setTrades62(res62.trades);
            setTrades79(res79.trades);

            setSelectedSession(session.id);
            setIsRunning(false);
            toast(optimizeSwitches 
              ? `✅ Optimización finalizada para TODAS las sesiones (con Killswitches optimizados).`
              : `✅ Optimización finalizada para TODAS las sesiones.`, 
              'success'
            );
        }
    };

    const startStage2 = () => {
        const ksMaxDailyLoss = [0, 1.0, 1.5, 2.0, 3.0];
        const ksDailyProfit = [0, 2.0, 3.0, 4.0, 6.0];
        const ksMaxConsLosses = [0, 2, 3, 4];
        const ksMaxTrades = [0, 2, 3, 5];
        const ksTrailDD = [0, 1.5, 2.5, 4.0];

        const ksCombinations: {
            maxDailyLossR?: number,
            dailyProfitTargetR?: number,
            maxConsecutiveLosses?: number,
            maxTradesPerDay?: number,
            trailingDrawdownR?: number
        }[] = [];

        for (const mdl of ksMaxDailyLoss) {
            for (const dpt of ksDailyProfit) {
                for (const mcl of ksMaxConsLosses) {
                    for (const mt of ksMaxTrades) {
                        for (const tdd of ksTrailDD) {
                            ksCombinations.push({
                                maxDailyLossR: mdl || undefined,
                                dailyProfitTargetR: dpt || undefined,
                                maxConsecutiveLosses: mcl || undefined,
                                maxTradesPerDay: mt || undefined,
                                trailingDrawdownR: tdd || undefined
                            });
                        }
                    }
                }
            }
        }

        const stage2Tasks: {
            session: 'ALL' | 'LONDON' | 'NY' | 'ASIA',
            ks: typeof ksCombinations[number]
        }[] = [];

        const sessionsToEval = ['ALL', 'LONDON', 'NY', 'ASIA'] as const;
        sessionsToEval.forEach(s => {
            if (bestData[s]) {
                for (const ks of ksCombinations) {
                    stage2Tasks.push({ session: s, ks });
                }
            }
        });

        const bestStage2Pnl: Record<string, number> = { ALL: -Infinity, LONDON: -Infinity, NY: -Infinity, ASIA: -Infinity };
        const bestStage2Data: Record<string, { config: any, result: BacktestResult }> = {};

        const processStage2Chunk = (startIndex: number) => {
            const chunkSize = 50;
            const endIndex = Math.min(startIndex + chunkSize, stage2Tasks.length);

            for (let i = startIndex; i < endIndex; i++) {
                const task = stage2Tasks[i];
                const pass1Result = bestData[task.session];
                if (!pass1Result) continue;

                const testConfig = {
                    ...pass1Result.config,
                    ...task.ks
                };
                const res = runBacktest(logs, testConfig);

                const sessionTrades = task.session === 'ALL'
                    ? res.trades
                    : res.trades.filter(t => getSessionForTimestamp(t.timestamp) === task.session);
                
                const closed = sessionTrades.filter(t => t.result && t.result !== 'TIMEOUT');
                const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);

                if (pnl > bestStage2Pnl[task.session]) {
                    bestStage2Pnl[task.session] = pnl;
                    bestStage2Data[task.session] = { config: testConfig, result: res };
                }
            }

            const stage2Progress = Math.floor((endIndex / stage2Tasks.length) * 50) + 50;
            setProgress(stage2Progress);

            if (endIndex < stage2Tasks.length) {
                setTimeout(() => processStage2Chunk(endIndex), 15);
            } else {
                Object.keys(bestStage2Data).forEach(s => {
                    bestData[s] = bestStage2Data[s];
                });
                finalizeOptimization();
            }
        };

        setTimeout(() => processStage2Chunk(0), 10);
    };

    const processStage1Chunk = (startIndex: number) => {
        const chunkSize = 10;
        const endIndex = Math.min(startIndex + chunkSize, combinations.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            const c = combinations[i];
            const config = { 
                ticker, minBuyPoints: c.score, minSellPoints: c.score, slBufferPercent: c.sl, fixedRR: c.rr, oteEntryPercent: c.ote, entryTrigger: c.trigger,
                maxDailyLossR: optimizeSwitches ? undefined : (maxDailyLossR || undefined),
                dailyProfitTargetR: optimizeSwitches ? undefined : (dailyProfitTargetR || undefined),
                maxConsecutiveLosses: optimizeSwitches ? undefined : (maxConsecutiveLosses || undefined),
                maxTradesPerDay: optimizeSwitches ? undefined : (maxTradesPerDay || undefined),
                trailingDrawdownR: optimizeSwitches ? undefined : (trailingDrawdownR || undefined),
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
        
        const baseProgress = Math.floor((endIndex / combinations.length) * 100);
        setProgress(optimizeSwitches ? Math.floor(baseProgress / 2) : baseProgress);
        
        if (endIndex < combinations.length) {
            setTimeout(() => processStage1Chunk(endIndex), 20);
        } else {
            if (optimizeSwitches && Object.keys(bestData).length > 0) {
                startStage2();
            } else {
                finalizeOptimization();
            }
        }
    };
    
    setTimeout(() => processStage1Chunk(0), 100);
  }, [uploadedFiles, ticker, entryTrigger, sessionFilter, toast, getSessionForTimestamp, maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR, optimizeSwitches]);

  // ✨ AUTO-OPTIMIZADOR INTELIGENTE POR SESIÓN INDEPENDIENTE
  const handleOptimizeSession = useCallback((targetSession: 'LONDON' | 'NY' | 'ASIA' | 'ALL') => {
    if (uploadedFiles.length === 0) { toast('Subí al menos 1 log', 'error'); return; }
    setIsRunning(true);
    setProgress(0);
    setTrades([]);
    setResult(null);

    const logs = new Map<string, string[]>();
    uploadedFiles.forEach(f => logs.set(f.tf, f.lines));

    // Opciones del espacio de búsqueda para SL Buffer y R:R
    const slOptions = [0, 0.05, 0.1, 0.15, 0.2];
    const rrOptions = [1.5, 2.0, 2.5, 3.0, 4.0];
    
    // Perfiles inteligentes de gatillos (Escala Premium de Alta Puntuación para Entradas Sniper)
    const triggerProfiles = [
      // 1. Choch puros (Reversiones directas de alta puntuación)
      { choch: { enabled: true, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: true, minScore: 16 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: true, minScore: 20 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      
      // 2. Bos puros (Continuaciones directas de alta puntuación)
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: true, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: true, minScore: 16 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: true, minScore: 20 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: false, minScore: 12 } },
      
      // 3. OTE Choch puros (Entradas en retrocesos óptimos basadas en CHOCH)
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 12, entryPercent: 62 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 16, entryPercent: 62 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 16, entryPercent: 79 }, oteBos: { enabled: false, minScore: 12 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 20, entryPercent: 79 }, oteBos: { enabled: false, minScore: 12 } },
      
      // 4. OTE Bos puros (Entradas en retrocesos óptimos basadas en BOS)
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: true, minScore: 12, entryPercent: 62 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: true, minScore: 16, entryPercent: 62 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: true, minScore: 16, entryPercent: 79 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: false, minScore: 12 }, oteBos: { enabled: true, minScore: 20, entryPercent: 79 } },

      // 5. OTE mixto (Combina OTE CHOCH y OTE BOS de nivel Sniper)
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 16, entryPercent: 62 }, oteBos: { enabled: true, minScore: 16, entryPercent: 62 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 16, entryPercent: 79 }, oteBos: { enabled: true, minScore: 16, entryPercent: 79 } },
      { choch: { enabled: false, minScore: 12 }, bos: { enabled: false, minScore: 12 }, ote: { enabled: false, minScore: 12 }, oteChoch: { enabled: true, minScore: 20, entryPercent: 79 }, oteBos: { enabled: true, minScore: 20, entryPercent: 79 } },
      
      // 6. Híbridos globales (Todos los gatillos encendidos para mayor flexibilidad de alto puntaje)
      { choch: { enabled: true, minScore: 12 }, bos: { enabled: true, minScore: 12 }, ote: { enabled: true, minScore: 12, entryPercent: 62 }, oteChoch: { enabled: true, minScore: 12, entryPercent: 62 }, oteBos: { enabled: true, minScore: 12, entryPercent: 62 } },
      { choch: { enabled: true, minScore: 16 }, bos: { enabled: true, minScore: 16 }, ote: { enabled: true, minScore: 16, entryPercent: 79 }, oteChoch: { enabled: true, minScore: 16, entryPercent: 79 }, oteBos: { enabled: true, minScore: 16, entryPercent: 79 } },
      { choch: { enabled: true, minScore: 20 }, bos: { enabled: true, minScore: 20 }, ote: { enabled: true, minScore: 20, entryPercent: 79 }, oteChoch: { enabled: true, minScore: 20, entryPercent: 79 }, oteBos: { enabled: true, minScore: 20, entryPercent: 79 } }
    ];

    const sessionsList = targetSession === 'ALL' ? ['LONDON', 'NY', 'ASIA'] as const : [targetSession] as const;

    let currentSessionTriggers = JSON.parse(JSON.stringify(sessionTriggers));

    const optimizeSessionTask = (sessionIndex: number) => {
      if (sessionIndex >= sessionsList.length) {
        setSessionTriggers(currentSessionTriggers);
        localStorage.setItem('bt_session_triggers', JSON.stringify(currentSessionTriggers));

        // Corremos un backtest final con los parámetros nuevos optimizados
        setTimeout(() => {
          const baseParams = {
            ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, entryTrigger,
            maxDailyLossR: maxDailyLossR || undefined,
            dailyProfitTargetR: dailyProfitTargetR || undefined,
            maxConsecutiveLosses: maxConsecutiveLosses || undefined,
            maxTradesPerDay: maxTradesPerDay || undefined,
            trailingDrawdownR: trailingDrawdownR || undefined,
          };
          const finalRes = runBacktest(logs, {
            ...baseParams,
            oteEntryPercent,
            sessions: currentSessionTriggers
          });
          setResult(finalRes);
          setTrades(finalRes.trades);

          // También actualizamos las simulaciones rápidas por ote
          const sessions50 = getOverriddenSessions(currentSessionTriggers, 50);
          const sessions62 = getOverriddenSessions(currentSessionTriggers, 62);
          const sessions79 = getOverriddenSessions(currentSessionTriggers, 79);

          const res50 = runBacktest(logs, { ...baseParams, oteEntryPercent: 50, sessions: sessions50 });
          const res62 = runBacktest(logs, { ...baseParams, oteEntryPercent: 62, sessions: sessions62 });
          const res79 = runBacktest(logs, { ...baseParams, oteEntryPercent: 79, sessions: sessions79 });

          setTrades50(res50.trades);
          setTrades62(res62.trades);
          setTrades79(res79.trades);

          setProgress(100);
          setIsRunning(false);
          toast(`✅ Optimización finalizada para ${targetSession === 'ALL' ? 'todas las sesiones individuales' : targetSession}.`, 'success');
        }, 100);
        return;
      }

      const s = sessionsList[sessionIndex];
      let bestScore = -Infinity;
      let bestConfig: typeof triggerProfiles[number] & { slBufferPercent: number, fixedRR: number } = {
        ...triggerProfiles[0],
        slBufferPercent: 0.1,
        fixedRR: 2.0
      };

      const combinations: { sl: number, rr: number, profile: typeof triggerProfiles[number] }[] = [];
      for (const sl of slOptions) {
        for (const rr of rrOptions) {
          for (const profile of triggerProfiles) {
            combinations.push({ sl, rr, profile });
          }
        }
      }

      const processChunk = (chunkStartIndex: number) => {
        const chunkSize = 50;
        const chunkEndIndex = Math.min(chunkStartIndex + chunkSize, combinations.length);

        for (let i = chunkStartIndex; i < chunkEndIndex; i++) {
          const comb = combinations[i];
          
          const tempSessions = JSON.parse(JSON.stringify(currentSessionTriggers));
          tempSessions[s] = {
            ...comb.profile,
            slBufferPercent: comb.sl,
            fixedRR: comb.rr
          };

          const testParams = {
            ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, entryTrigger,
            maxDailyLossR: maxDailyLossR || undefined,
            dailyProfitTargetR: dailyProfitTargetR || undefined,
            maxConsecutiveLosses: maxConsecutiveLosses || undefined,
            maxTradesPerDay: maxTradesPerDay || undefined,
            trailingDrawdownR: trailingDrawdownR || undefined,
            oteEntryPercent,
            sessions: tempSessions
          };

          const testRes = runBacktest(logs, testParams);

          const sessionTrades = testRes.trades.filter(t => getSessionForTimestamp(t.timestamp) === s);
          const closed = sessionTrades.filter(t => t.result && t.result !== 'TIMEOUT');
          
          // Cálculo de PnL Neto en unidades de R
          const pnl = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
          
          // Cálculo del Profit Factor local de la sesión
          let grossProfit = 0;
          let grossLoss = 0;
          closed.forEach(t => {
            const p = t.rMultiple || 0;
            if (p > 0) grossProfit += p;
            else if (p < 0) grossLoss += Math.abs(p);
          });
          const pf = grossLoss === 0 ? (grossProfit > 0 ? 2.5 : 1.0) : (grossProfit / grossLoss);
          
          // 1. Penalizador de Muestra Pequeña (Evita overfitting y trades de suerte con poca muestra)
          const tradeCountFactor = closed.length < 3 ? 0.2 : (closed.length < 6 ? 0.6 : 1.0);
          
          // 2. Factor de Profit Factor saludable (topado en 2.5 para evitar sobreajuste absurdo)
          const cappedPF = Math.min(pf, 2.5);
          
          // 3. Puntuación final multivariable (Score de Robustez)
          const robustScore = pnl >= 0 
            ? pnl * cappedPF * tradeCountFactor 
            : pnl / (Math.max(0.1, cappedPF) * Math.max(0.1, tradeCountFactor));

          if (robustScore > bestScore) {
            bestScore = robustScore;
            bestConfig = {
              ...comb.profile,
              slBufferPercent: comb.sl,
              fixedRR: comb.rr
            };
          }
        }

        const sessionProgress = (chunkEndIndex / combinations.length);
        const overallProgress = Math.floor(((sessionIndex + sessionProgress) / sessionsList.length) * 100);
        setProgress(overallProgress);

        if (chunkEndIndex < combinations.length) {
          setTimeout(() => processChunk(chunkEndIndex), 10);
        } else {
          currentSessionTriggers[s] = {
            ...currentSessionTriggers[s],
            ...bestConfig
          };
          setTimeout(() => optimizeSessionTask(sessionIndex + 1), 50);
        }
      };

      setTimeout(() => processChunk(0), 10);
    };

    setTimeout(() => optimizeSessionTask(0), 100);
  }, [uploadedFiles, ticker, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, maxDailyLossR, dailyProfitTargetR, maxConsecutiveLosses, maxTradesPerDay, trailingDrawdownR, sessionTriggers, toast, getSessionForTimestamp]);

  // 📊 MOTOR DE SIMULACIÓN DE PORTAFOLIO GLOBAL
  const runPortfolioSimulation = useCallback((
    files: PortfolioAssetFile[],
    config: {
      mdl: number;
      dpt: number;
      mcl: number;
      mtd: number;
      tdd: number;
    }
  ) => {
    if (files.length === 0) return null;

    // Unificar todos los trades
    let allTrades: any[] = [];
    files.forEach(f => {
      f.trades.forEach(t => {
        allTrades.push({
          ...t,
          ticker: f.ticker
        });
      });
    });

    // Ordenar cronológicamente por timestamp de apertura
    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    // Simulación día a día en huso horario de Argentina
    let simulatedTrades: any[] = [];
    let currentDayStr = '';
    
    // Variables de control de día
    let dailyPnLR = 0;
    let dailyTradesCount = 0;
    let dailyConsecutiveLosses = 0;
    let dailyPeakPnLR = 0;
    let isDailyKilled = false;
    let dailyKillReason = '';

    let totalPnLR = 0;

    allTrades.forEach(t => {
      // Calcular el día de Argentina correspondiente (ART es UTC-3)
      const date = new Date(t.timestamp);
      const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // YYYY-MM-DD

      if (dateStr !== currentDayStr) {
        currentDayStr = dateStr;
        dailyPnLR = 0;
        dailyTradesCount = 0;
        dailyConsecutiveLosses = 0;
        dailyPeakPnLR = 0;
        isDailyKilled = false;
        dailyKillReason = '';
      }

      const r = Number(t.rMultiple) || 0;

      if (isDailyKilled) {
        simulatedTrades.push({
          ...t,
          blockedByGlobalKillswitch: true,
          blockReason: dailyKillReason,
          cumulativePnLR: totalPnLR
        });
      } else {
        // Registrar trade no bloqueado
        totalPnLR += r;
        simulatedTrades.push({
          ...t,
          blockedByGlobalKillswitch: false,
          cumulativePnLR: totalPnLR
        });

        // Actualizar estadísticas del día
        dailyPnLR += r;
        dailyTradesCount++;
        if (r < 0) {
          dailyConsecutiveLosses++;
        } else if (r > 0) {
          dailyConsecutiveLosses = 0;
        }

        if (dailyPnLR > dailyPeakPnLR) {
          dailyPeakPnLR = dailyPnLR;
        }

        const dailyDrawdown = dailyPeakPnLR - dailyPnLR;

        // Comprobar triggers de bloqueo diario consolidado
        if (config.mdl > 0 && dailyPnLR <= -config.mdl) {
          isDailyKilled = true;
          dailyKillReason = `Max Daily Loss superado (-${config.mdl}R)`;
        } else if (config.dpt > 0 && dailyPnLR >= config.dpt) {
          isDailyKilled = true;
          dailyKillReason = `Daily Profit Target alcanzado (+${config.dpt}R)`;
        } else if (config.mtd > 0 && dailyTradesCount >= config.mtd) {
          isDailyKilled = true;
          dailyKillReason = `Max Trades/Día superado (${config.mtd})`;
        } else if (config.mcl > 0 && dailyConsecutiveLosses >= config.mcl) {
          isDailyKilled = true;
          dailyKillReason = `Max Pérdidas Consecutivas superado (${config.mcl})`;
        } else if (config.tdd > 0 && dailyDrawdown >= config.tdd) {
          isDailyKilled = true;
          dailyKillReason = `Trailing Drawdown superado (${config.tdd}R)`;
        }
      }
    });

    // Métricas finales
    const activeTrades = simulatedTrades.filter(t => !t.blockedByGlobalKillswitch);
    const totalTradesCount = activeTrades.length;
    const wins = activeTrades.filter(t => t.result === 'WIN').length;
    const losses = activeTrades.filter(t => t.result === 'LOSS').length;
    const be = activeTrades.filter(t => t.result === 'BE').length;

    const wr = totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(1) : '0';
    
    let grossProfitR = 0;
    let grossLossR = 0;
    let maxDD = 0;
    let peak = 0;

    activeTrades.forEach(t => {
      const r = Number(t.rMultiple) || 0;
      if (r > 0) grossProfitR += r;
      else grossLossR += Math.abs(r);

      peak += r;
      if (peak < maxDD) maxDD = peak;
    });

    const profitFactor = grossLossR > 0 ? (grossProfitR / grossLossR).toFixed(2) : (grossProfitR > 0 ? '∞' : '0.00');

    // Curva de capital
    const equityData = [{ name: 'Start', PnL: 0 }];
    let cumPnL = 0;
    activeTrades.forEach((t, idx) => {
      cumPnL += Number(t.rMultiple) || 0;
      equityData.push({
        name: `T${idx + 1}`,
        PnL: parseFloat(cumPnL.toFixed(2))
      });
    });

    return {
      trades: simulatedTrades,
      equityData,
      metrics: {
        wr,
        profitFactor,
        totalPnLR: totalPnLR.toFixed(2),
        activeTradesCount: totalTradesCount,
        blockedTradesCount: simulatedTrades.filter(t => t.blockedByGlobalKillswitch).length,
        wins,
        losses,
        be,
        maxDDR: maxDD.toFixed(2)
      }
    };
  }, []);

  // 🔎 GRID SEARCH: OPTIMIZADOR INTELIGENTE DE KILLSWITCHES GLOBALES
  const optimizePortfolioKillswitches = useCallback(() => {
    if (portfolioFiles.length === 0) return;
    setIsOptimizingPortfolio(true);

    setTimeout(() => {
      const mdlOptions = [0, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
      const dptOptions = [0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0];
      const mtdOptions = [0, 2, 3, 4, 5, 6];
      
      let combinations: { mdl: number, dpt: number, mtd: number }[] = [];
      for (const mdl of mdlOptions) {
        for (const dpt of dptOptions) {
          for (const mtd of mtdOptions) {
            combinations.push({ mdl, dpt, mtd });
          }
        }
      }

      let results: any[] = [];

      combinations.forEach(c => {
        const sim = runPortfolioSimulation(portfolioFiles, {
          mdl: c.mdl,
          dpt: c.dpt,
          mtd: c.mtd,
          mcl: 0,
          tdd: 0
        });

        if (sim) {
          results.push({
            config: c,
            pnlR: parseFloat(sim.metrics.totalPnLR),
            wr: parseFloat(sim.metrics.wr),
            blocked: sim.metrics.blockedTradesCount,
            active: sim.metrics.activeTradesCount
          });
        }
      });

      // Ordenar por rendimiento PnL R neto consolidado de forma descendente
      results.sort((a, b) => b.pnlR - a.pnlR);

      setPortfolioOptResults(results.slice(0, 5));
      setIsOptimizingPortfolio(false);
      toast('✅ Grid Search optimizado. ¡Elegí la mejor opción abajo!', 'success');
    }, 100);
  }, [portfolioFiles, runPortfolioSimulation, toast]);

  // 💾 SUBIR LA CONFIGURACIÓN GLOBAL A JARVIS FIRESTORE
  const handlePushGlobalToBot = async () => {
    try {
      await setDoc(doc(db, 'asset_configs', 'GLOBAL'), {
        enabled: true,
        maxDailyLossR: globalMDL,
        dailyProfitTargetR: globalDPT,
        maxConsecutiveLosses: globalMCL,
        maxTradesPerDay: globalMTD,
        trailingDrawdownR: globalTDD,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      toast(`✅ Configuración Global subida a JARVIS con éxito!`, 'success');
    } catch (err: any) {
      toast(`❌ Error subiendo config global: ${err.message}`, 'error');
    }
  };

  // 📂 CARGA DE ARCHIVOS JSON DE BACKTESTING INDIVIDUAL
  const handlePortfolioUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const content = ev.target?.result as string;
          const data = JSON.parse(content);

          if (!data.trades || !Array.isArray(data.trades)) {
            toast(`❌ ${file.name}: no es un archivo de backtesting válido de JARVIS`, 'error');
            return;
          }

          const detectedTicker = data.metadata?.ticker || 'DESCONOCIDO';
          const cleanTrades = data.trades.filter((t: any) => t.result && t.result !== 'TIMEOUT');

          setPortfolioFiles(prev => {
            const filtered = prev.filter(f => f.ticker !== detectedTicker);
            const newFiles = [...filtered, {
              name: file.name,
              ticker: detectedTicker,
              trades: cleanTrades
            }];
            
            setTimeout(() => {
              const res = runPortfolioSimulation(newFiles, {
                mdl: globalMDL,
                dpt: globalDPT,
                mcl: globalMCL,
                mtd: globalMTD,
                tdd: globalTDD
              });
              setPortfolioResults(res);
            }, 50);

            return newFiles;
          });

          toast(`✅ ${detectedTicker}: ${cleanTrades.length} trades importados`, 'success');
        } catch (err: any) {
          toast(`❌ Error leyendo JSON: ${err.message}`, 'error');
        }
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }, [toast, globalMDL, globalDPT, globalMCL, globalMTD, globalTDD, runPortfolioSimulation]);

  // 🎛️ ACTUALIZACIÓN DINÁMICA DE PARÁMETROS
  const handleGlobalParamChange = (param: string, val: number) => {
    let newMdl = globalMDL;
    let newDpt = globalDPT;
    let newMcl = globalMCL;
    let newMtd = globalMTD;
    let newTdd = globalTDD;

    if (param === 'mdl') { setGlobalMDL(val); newMdl = val; }
    else if (param === 'dpt') { setGlobalDPT(val); newDpt = val; }
    else if (param === 'mcl') { setGlobalMCL(val); newMcl = val; }
    else if (param === 'mtd') { setGlobalMTD(val); newMtd = val; }
    else if (param === 'tdd') { setGlobalTDD(val); newTdd = val; }

    const res = runPortfolioSimulation(portfolioFiles, {
      mdl: newMdl,
      dpt: newDpt,
      mcl: newMcl,
      mtd: newMtd,
      tdd: newTdd
    });
    setPortfolioResults(res);
  };

  const isOteFilterActive = ['OTE', 'OTE_CHOCH', 'OTE_BOS'].includes(tradeFilter);

  const oteSourceTrades = (() => {
    if (isOteFilterActive) {
      if (oteFilter === 50 && trades50.length > 0) return trades50;
      if (oteFilter === 62 && trades62.length > 0) return trades62;
      if (oteFilter === 79 && trades79.length > 0) return trades79;
    }
    return trades;
  })();

  const filteredTrades = sessionFilter === 'ALL'
    ? oteSourceTrades
    : oteSourceTrades.filter(t => getSessionForTimestamp(t.timestamp) === sessionFilter);

  const doubleFilteredTrades = tradeFilter === 'ALL'
    ? filteredTrades
    : filteredTrades.filter(t => {
        const hasOte = t.events?.some(e => e.includes('OTE_Retracement'));
        if (tradeFilter === 'BOS') return t.events?.some(e => e.includes('EVENTO_BOS')) && !hasOte;
        if (tradeFilter === 'CHOCH') return t.events?.some(e => e.includes('EVENTO_CHOCH')) && !hasOte;
        if (tradeFilter === 'OTE') return hasOte;
        if (tradeFilter === 'OTE_CHOCH') return hasOte && t.events?.some(e => e.includes('EVENTO_CHOCH'));
        if (tradeFilter === 'OTE_BOS') return hasOte && t.events?.some(e => e.includes('EVENTO_BOS'));
        return true;
    });

  const tripleFilteredTrades = doubleFilteredTrades.filter(t => {
    const scoreMatch = t.points >= scoreFilterMin && t.points <= scoreFilterMax;
    const oteMatch = !isOteFilterActive || t.oteEntryUsed === undefined || t.oteEntryUsed === oteFilter;
    return scoreMatch && oteMatch;
  });

  // Analíticas por rango de score basadas en doubleFilteredTrades (antes de filtrar la lista actual por score)
  const scoreRangesData = (() => {
    const ranges = [
      { min: 5, max: 9, label: 'Bajo (5-9 pts)', color: 'var(--accent-red)' },
      { min: 10, max: 14, label: 'Medio (10-14 pts)', color: 'var(--accent-gold)' },
      { min: 15, max: 19, label: 'Alto (15-19 pts)', color: '#0088ff' },
      { min: 20, max: 50, label: 'Premium (20+ pts)', color: 'var(--accent-green)' }
    ];

    return ranges.map(range => {
      const rangeTrades = doubleFilteredTrades.filter(t => t.points >= range.min && t.points <= range.max);
      const closed = rangeTrades.filter(t => t.result && t.result !== 'TIMEOUT');
      const wins = closed.filter(t => t.result === 'WIN').length;
      const pnlTotalR = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
      const pnlTotalUsd = pnlTotalR * riskUsd;
      
      const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
      
      let grossProfitUsd = 0, grossLossUsd = 0;
      closed.forEach(t => {
        const profitUsd = (t.rMultiple || 0) * riskUsd;
        if (profitUsd > 0) grossProfitUsd += profitUsd;
        else grossLossUsd += Math.abs(profitUsd);
      });
      const profitFactor = grossLossUsd > 0 ? (grossProfitUsd / grossLossUsd).toFixed(2) : (grossProfitUsd > 0 ? '∞' : '0.00');

      return {
        ...range,
        tradesCount: rangeTrades.length,
        closedCount: closed.length,
        winRate: wr,
        pnlR: pnlTotalR.toFixed(1),
        pnlUsd: pnlTotalUsd.toFixed(2),
        profitFactor
      };
    });
  })();

  const oteBreakdownData = (() => {
    const levels = [50, 62, 79] as const;
    
    return levels.map(level => {
      const source = level === 50 ? trades50 : level === 62 ? trades62 : trades79;
      const finalSource = source.length > 0 ? source : trades;
      
      const sessionFiltered = sessionFilter === 'ALL'
        ? finalSource
        : finalSource.filter(t => getSessionForTimestamp(t.timestamp) === sessionFilter);
        
      const levelTrades = sessionFiltered.filter(t => t.events?.some(e => e.includes('OTE_Retracement')));
      const closed = levelTrades.filter(t => t.result && t.result !== 'TIMEOUT');
      const wins = closed.filter(t => t.result === 'WIN').length;
      const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
      
      let grossProfit = 0;
      let grossLoss = 0;
      closed.forEach(t => {
        const p = t.rMultiple || 0;
        if (p > 0) grossProfit += p;
        else if (p < 0) grossLoss += Math.abs(p);
      });
      const pf = grossLoss === 0 
        ? (grossProfit > 0 ? '∞' : '1.00') 
        : (grossProfit / grossLoss).toFixed(2);
        
      const pnlR = closed.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(1);
      
      return {
        level,
        tradesCount: levelTrades.length,
        winRate: wr,
        profitFactor: pf,
        pnlR,
        color: level === 50 ? 'var(--accent-gold)' : level === 62 ? '#d500f9' : '#00e5ff'
      };
    });
  })();

  // Metrics
  const metrics = (() => {
    const closed = tripleFilteredTrades.filter(t => t.result && t.result !== 'TIMEOUT');
    const wins = closed.filter(t => t.result === 'WIN').length;
    const losses = closed.filter(t => t.result === 'LOSS').length;
    const be = closed.filter(t => t.result === 'BE').length;
    const open = tripleFilteredTrades.filter(t => !t.result).length;
    
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
        count: closed.length, total: tripleFilteredTrades.length, 
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
    
    // Calcular las métricas globales para la exportación completa (sin aplicar los filtros visuales)
    const closedGlobal = trades.filter(t => t.result && t.result !== 'TIMEOUT');
    const winsGlobal = closedGlobal.filter(t => t.result === 'WIN').length;
    const lossesGlobal = closedGlobal.filter(t => t.result === 'LOSS').length;
    const beGlobal = closedGlobal.filter(t => t.result === 'BE').length;
    const openGlobal = trades.filter(t => !t.result).length;
    
    const pnlTotalUsdGlobal = closedGlobal.reduce((acc, t) => acc + (t.rMultiple || 0) * riskUsd, 0);
    const pnlTotalRGlobal = closedGlobal.reduce((acc, t) => acc + (t.rMultiple || 0), 0);
    const wrGlobal = closedGlobal.length > 0 ? ((winsGlobal / closedGlobal.length) * 100).toFixed(1) : '—';
    
    let maxDDGlobal = 0, peakGlobal = 0;
    let grossProfitUsdGlobal = 0, grossLossUsdGlobal = 0;
    let maxConsLossesGlobal = 0, currentLossStreakGlobal = 0;
    let totalDurationGlobal = 0, tradesWithDurationGlobal = 0;
    let tp1OnlyCountGlobal = 0, tp2CountGlobal = 0, slCountGlobal = 0, beCountGlobal = 0;

    closedGlobal.forEach(t => {
      const r = t.rMultiple || 0;
      const profitUsd = r * riskUsd;
      
      peakGlobal += profitUsd;
      if (peakGlobal < maxDDGlobal) maxDDGlobal = peakGlobal;

      if (profitUsd > 0) grossProfitUsdGlobal += profitUsd;
      else grossLossUsdGlobal += Math.abs(profitUsd);

      if (t.result === 'LOSS') {
        currentLossStreakGlobal++;
        if (currentLossStreakGlobal > maxConsLossesGlobal) maxConsLossesGlobal = currentLossStreakGlobal;
      } else if (t.result === 'WIN') {
        currentLossStreakGlobal = 0;
      }

      if (t.durationMin) {
        totalDurationGlobal += t.durationMin;
        tradesWithDurationGlobal++;
      }

      if (t.result === 'WIN') {
          if (t.resultTp2 === 'WIN') tp2CountGlobal++;
          else tp1OnlyCountGlobal++;
      } else if (t.result === 'LOSS') {
          slCountGlobal++;
      } else if (t.result === 'BE') {
          beCountGlobal++;
      }
    });

    const profitFactorGlobal = grossLossUsdGlobal > 0 ? (grossProfitUsdGlobal / grossLossUsdGlobal).toFixed(2) : (grossProfitUsdGlobal > 0 ? '∞' : '0.00');
    const expectancyRGlobal = closedGlobal.length > 0 ? (pnlTotalRGlobal / closedGlobal.length).toFixed(2) : '0.00';
    const avgDurationMinGlobal = tradesWithDurationGlobal > 0 ? Math.round(totalDurationGlobal / tradesWithDurationGlobal) : 0;
    
    const formatDuration = (mins: number) => {
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    const globalMetrics = {
      wins: winsGlobal,
      losses: lossesGlobal,
      be: beGlobal,
      open: openGlobal,
      wr: wrGlobal,
      pnlUsd: pnlTotalUsdGlobal.toFixed(2),
      pnlR: pnlTotalRGlobal.toFixed(2),
      count: closedGlobal.length,
      total: trades.length,
      maxDDUsd: maxDDGlobal.toFixed(2),
      closed: closedGlobal,
      profitFactor: profitFactorGlobal,
      expectancyR: expectancyRGlobal,
      maxConsLosses: maxConsLossesGlobal,
      avgDuration: formatDuration(avgDurationMinGlobal),
      tp1OnlyCount: tp1OnlyCountGlobal,
      tp2Count: tp2CountGlobal,
      slCount: slCountGlobal,
      beCount: beCountGlobal
    };

    const downloadData = {
      metadata: {
        ticker,
        exportDate: new Date().toISOString(),
        timeframe: result.startDate + ' -> ' + result.endDate,
        sessionFilter,
        tradeFilter,
        scoreFilterMin,
        scoreFilterMax
      },
      config: {
        minBuyPoints,
        minSellPoints,
        slBufferPercent,
        fixedRR,
        oteEntryPercent,
        entryTrigger,
        sessions: sessionTriggers
      },
      metrics: globalMetrics,
      trades: trades
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(downloadData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `jarvis_bt_${ticker}_${new Date().getTime()}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    toast('✅ Archivo JSON descargado con éxito (historial completo de trades)', 'success');
  }, [result, trades, ticker, sessionFilter, tradeFilter, minBuyPoints, minSellPoints, slBufferPercent, fixedRR, oteEntryPercent, entryTrigger, sessionTriggers, scoreFilterMin, scoreFilterMax, riskUsd, toast]);

  return (
    <div className="animate-fadeIn">
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ display: 'flex', alignItems: 'center', fontWeight: 700 }}>
            <Upload size={14} style={{ marginRight: 8 }} /> BACKTESTING STANDALONE v3.0 {isRunning && <span className="live-dot"></span>}
          </span>
          <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Motor local y optimizador multi-activo</span>
        </div>

        {/* 🎂 SELECTOR DE PESTAÑAS PREMIUM */}
        <div style={{
          display: 'flex',
          background: 'rgba(255, 255, 255, 0.05)',
          borderRadius: '8px',
          padding: '2px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          backdropFilter: 'blur(10px)',
          gap: '2px'
        }}>
          <button
            onClick={() => setActiveTab('individual')}
            style={{
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              background: activeTab === 'individual' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: activeTab === 'individual' ? '#fff' : 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <TrendingUp size={12} color={activeTab === 'individual' ? 'var(--accent-gold)' : 'var(--text-tertiary)'} /> Backtest Individual
          </button>
          <button
            onClick={() => setActiveTab('portfolio')}
            style={{
              padding: '6px 14px',
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: '6px',
              border: 'none',
              background: activeTab === 'portfolio' ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: activeTab === 'portfolio' ? '#fff' : 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <Briefcase size={12} color={activeTab === 'portfolio' ? 'var(--accent-gold)' : 'var(--text-tertiary)'} /> Portafolio Global
          </button>
        </div>
      </div>

      {activeTab === 'individual' ? (
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(255,170,0,0.05)', borderRadius: '4px', border: '1px solid rgba(255,170,0,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-gold)', fontWeight: 700 }}>📉 OTE ENTRY GLOBAL</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[50, 62, 79].map(level => {
                  const isActive = oteEntryPercent === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setOteEntryPercent(level)}
                      style={{
                        flex: 1,
                        padding: '4px 0',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        borderRadius: '4px',
                        border: isActive ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)',
                        backgroundColor: isActive ? 'rgba(255,170,0,0.15)' : 'var(--bg-secondary)',
                        color: isActive ? 'var(--accent-gold)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                      }}
                    >
                      {level}%
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', padding: '8px 10px', backgroundColor: 'rgba(32,191,107,0.05)', borderRadius: '4px', border: '1px solid rgba(32,191,107,0.15)' }}>
              <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600 }}>💵 RIESGO (USD)</label>
              <input type="number" min="1" step="1" value={riskUsd} onChange={e => setRiskUsd(parseFloat(e.target.value) || 0)}
                style={{ flex: 1, padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', textAlign: 'right' }} />
            </div>



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
              <button type="button" onClick={() => handleRun()} disabled={uploadedFiles.length === 0 || isRunning}
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

          {/* SESSIONS & TRIGGERS CONFIGURATION */}
          <div className="panel" style={{ background: 'linear-gradient(180deg, var(--bg-surface) 0%, rgba(20,20,25,0.95) 100%)', border: '1px solid var(--border-color)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: '-10%', right: '-10%', width: '120px', height: '120px', background: 'radial-gradient(circle, rgba(124,77,255,0.15) 0%, rgba(0,0,0,0) 70%)', pointerEvents: 'none' }} />
            
            <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.9rem', letterSpacing: '0.5px' }}>
              <Zap size={18} color="var(--accent-gold)" /> GATILLOS Y FILTROS POR SESIÓN
            </h3>

            <div style={{ display: 'flex', gap: '4px', padding: '2px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '6px', marginBottom: '12px' }}>
              {(['ALL', 'LONDON', 'NY', 'ASIA'] as const).map(s => {
                const isActive = sessionFilter === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleSessionSelect(s)}
                    style={{
                      flex: 1,
                      padding: '6px 4px',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      borderRadius: '4px',
                      border: 'none',
                      backgroundColor: isActive ? 'var(--accent-gold)' : 'transparent',
                      color: isActive ? 'black' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease-in-out'
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>

            {sessionFilter !== 'ALL' ? (
              <button
                type="button"
                onClick={() => handleOptimizeSession(sessionFilter)}
                disabled={isRunning}
                style={{
                  width: '100%',
                  padding: '8px',
                  fontSize: '0.75rem',
                  fontWeight: 800,
                  borderRadius: '6px',
                  border: 'none',
                  background: 'linear-gradient(90deg, #7c4dff 0%, #00e5ff 100%)',
                  color: 'white',
                  cursor: 'pointer',
                  marginBottom: '16px',
                  boxShadow: '0 4px 15px rgba(124, 77, 255, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  transition: 'all 0.3s ease',
                  opacity: isRunning ? 0.6 : 1
                }}
                onMouseEnter={e => {
                  if (!isRunning) {
                    (e.currentTarget as any).style.transform = 'translateY(-1px)';
                    (e.currentTarget as any).style.boxShadow = '0 6px 20px rgba(124, 77, 255, 0.5)';
                  }
                }}
                onMouseLeave={e => {
                  if (!isRunning) {
                    (e.currentTarget as any).style.transform = 'translateY(0)';
                    (e.currentTarget as any).style.boxShadow = '0 4px 15px rgba(124, 77, 255, 0.3)';
                  }
                }}
              >
                <Zap size={14} /> ✨ AUTO-OPTIMIZAR SESIÓN {sessionFilter}
              </button>
            ) : (
              <div style={{
                textAlign: 'center',
                padding: '10px 12px',
                fontSize: '0.7rem',
                color: 'var(--accent-gold)',
                backgroundColor: 'rgba(255, 215, 0, 0.04)',
                border: '1px dashed rgba(255, 215, 0, 0.2)',
                borderRadius: '6px',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}>
                <span>💡 Seleccioná una sesión (London, NY, Asia) para optimizar su configuración individual.</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* CHOCH Trigger */}
              <div style={{ padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={sessionTriggers[sessionFilter]?.choch.enabled ?? false}
                      onChange={e => updateSessionTrigger(sessionFilter, 'choch', 'enabled', e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent-gold)', width: '14px', height: '14px' }}
                    />
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>💥 CHOCH (Ruptura)</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(124,77,255,0.1)', color: '#7c4dff', fontWeight: 600 }}>Gatillo</span>
                </div>
                {sessionTriggers[sessionFilter]?.choch.enabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Mín. Score:</span>
                    <input
                      type="range"
                      min="1"
                      max="30"
                      step="1"
                      value={sessionTriggers[sessionFilter]?.choch.minScore ?? 5}
                      onChange={e => updateSessionTrigger(sessionFilter, 'choch', 'minScore', parseInt(e.target.value))}
                      style={{ flex: 1, accentColor: 'var(--accent-gold)' }}
                    />
                    <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)', minWidth: '24px', textAlign: 'right' }}>
                      +{sessionTriggers[sessionFilter]?.choch.minScore}
                    </span>
                  </div>
                )}
              </div>

              {/* BOS Trigger */}
              <div style={{ padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={sessionTriggers[sessionFilter]?.bos.enabled ?? false}
                      onChange={e => updateSessionTrigger(sessionFilter, 'bos', 'enabled', e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: '#0088ff', width: '14px', height: '14px' }}
                    />
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>📈 BOS (Continuación)</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(0,136,255,0.1)', color: '#0088ff', fontWeight: 600 }}>Gatillo</span>
                </div>
                {sessionTriggers[sessionFilter]?.bos.enabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Mín. Score:</span>
                    <input
                      type="range"
                      min="1"
                      max="30"
                      step="1"
                      value={sessionTriggers[sessionFilter]?.bos.minScore ?? 10}
                      onChange={e => updateSessionTrigger(sessionFilter, 'bos', 'minScore', parseInt(e.target.value))}
                      style={{ flex: 1, accentColor: '#0088ff' }}
                    />
                    <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: '#0088ff', minWidth: '24px', textAlign: 'right' }}>
                      +{sessionTriggers[sessionFilter]?.bos.minScore}
                    </span>
                  </div>
                )}
              </div>


              {/* OTE CHoCH Trigger */}
              <div style={{ padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={sessionTriggers[sessionFilter]?.oteChoch?.enabled ?? false}
                      onChange={e => updateSessionTrigger(sessionFilter, 'oteChoch', 'enabled', e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: '#d500f9', width: '14px', height: '14px' }}
                    />
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>💥 OTE (Basado en CHOCH)</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(213,0,249,0.1)', color: '#d500f9', fontWeight: 600 }}>Gatillo</span>
                </div>
                {sessionTriggers[sessionFilter]?.oteChoch?.enabled && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', minWidth: '60px' }}>Mín. Score:</span>
                      <input
                        type="range"
                        min="1"
                        max="30"
                        step="1"
                        value={sessionTriggers[sessionFilter]?.oteChoch?.minScore ?? 8}
                        onChange={e => updateSessionTrigger(sessionFilter, 'oteChoch', 'minScore', parseInt(e.target.value))}
                        style={{ flex: 1, accentColor: '#d500f9' }}
                      />
                      <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: '#d500f9', minWidth: '24px', textAlign: 'right' }}>
                        +{sessionTriggers[sessionFilter]?.oteChoch?.minScore}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Entry Fib:</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {[50, 62, 79].map(level => {
                          const currentVal = sessionTriggers[sessionFilter]?.oteChoch?.entryPercent ?? 62;
                          const isActive = currentVal === level;
                          return (
                            <button
                              key={level}
                              type="button"
                              onClick={() => updateSessionTrigger(sessionFilter, 'oteChoch', 'entryPercent', level)}
                              style={{
                                flex: 1,
                                padding: '4px 0',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                borderRadius: '4px',
                                border: isActive ? '1px solid #d500f9' : '1px solid var(--border-color)',
                                backgroundColor: isActive ? 'rgba(213,0,249,0.15)' : 'var(--bg-secondary)',
                                color: isActive ? '#d500f9' : 'var(--text-secondary)',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                              }}
                            >
                              {level}%
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* OTE BOS Trigger */}
              <div style={{ padding: '10px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                    <input
                      type="checkbox"
                      checked={sessionTriggers[sessionFilter]?.oteBos?.enabled ?? false}
                      onChange={e => updateSessionTrigger(sessionFilter, 'oteBos', 'enabled', e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: '#00e5ff', width: '14px', height: '14px' }}
                    />
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>📈 OTE (Basado en BOS)</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(0,229,255,0.1)', color: '#00e5ff', fontWeight: 600 }}>Gatillo</span>
                </div>
                {sessionTriggers[sessionFilter]?.oteBos?.enabled && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', minWidth: '60px' }}>Mín. Score:</span>
                      <input
                        type="range"
                        min="1"
                        max="30"
                        step="1"
                        value={sessionTriggers[sessionFilter]?.oteBos?.minScore ?? 8}
                        onChange={e => updateSessionTrigger(sessionFilter, 'oteBos', 'minScore', parseInt(e.target.value))}
                        style={{ flex: 1, accentColor: '#00e5ff' }}
                      />
                      <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: '#00e5ff', minWidth: '24px', textAlign: 'right' }}>
                        +{sessionTriggers[sessionFilter]?.oteBos?.minScore}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Entry Fib:</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {[50, 62, 79].map(level => {
                          const currentVal = sessionTriggers[sessionFilter]?.oteBos?.entryPercent ?? 62;
                          const isActive = currentVal === level;
                          return (
                            <button
                              key={level}
                              type="button"
                              onClick={() => updateSessionTrigger(sessionFilter, 'oteBos', 'entryPercent', level)}
                              style={{
                                flex: 1,
                                padding: '4px 0',
                                fontSize: '0.7rem',
                                fontWeight: 700,
                                borderRadius: '4px',
                                border: isActive ? '1px solid #00e5ff' : '1px solid var(--border-color)',
                                backgroundColor: isActive ? 'rgba(0,229,255,0.15)' : 'var(--bg-secondary)',
                                color: isActive ? '#00e5ff' : 'var(--text-secondary)',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                              }}
                            >
                              {level}%
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Gestión de Riesgo por Sesión */}
            <div style={{ marginTop: '14px', padding: '12px', backgroundColor: 'rgba(255,255,255,0.01)', border: '1px dashed var(--border-color)', borderRadius: '6px' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--accent-gold)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                🛡️ RIESGO Y TP PERSONALIZADO ({sessionFilter})
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', padding: '6px 8px', backgroundColor: 'rgba(255,51,51,0.03)', borderRadius: '4px', border: '1px solid rgba(255,51,51,0.08)' }}>
                <label style={{ fontSize: '0.6rem', color: 'var(--accent-red)', whiteSpace: 'nowrap', fontWeight: 600 }}>SL BUF ({sessionFilter})</label>
                <input type="range" min="0" max="0.5" step="0.01" 
                  value={sessionTriggers[sessionFilter]?.slBufferPercent ?? 0.1} 
                  onChange={e => updateSessionTrigger(sessionFilter, 'slBufferPercent', '', parseFloat(e.target.value))}
                  style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: '0.7rem', color: 'var(--accent-red)', fontWeight: 700, minWidth: '36px', textAlign: 'right' }}>
                  {sessionTriggers[sessionFilter]?.slBufferPercent ?? 0.1}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', backgroundColor: 'rgba(0,136,255,0.03)', borderRadius: '4px', border: '1px solid rgba(0,136,255,0.08)' }}>
                <label style={{ fontSize: '0.6rem', color: '#0088ff', whiteSpace: 'nowrap', fontWeight: 600 }}>TP2 R:R ({sessionFilter})</label>
                <input type="range" min="1" max="5" step="0.1" 
                  value={sessionTriggers[sessionFilter]?.fixedRR ?? 2.0} 
                  onChange={e => updateSessionTrigger(sessionFilter, 'fixedRR', '', parseFloat(e.target.value))}
                  style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: '0.7rem', color: '#0088ff', fontWeight: 700, minWidth: '36px', textAlign: 'right' }}>
                  {sessionTriggers[sessionFilter]?.fixedRR ?? 2.0}x
                </span>
              </div>
            </div>
            
            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.4' }}>
              💡 Configura qué gatillos están activos y su puntaje mínimo para la sesión <strong>{sessionFilter}</strong>.
            </div>
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

            {/* SCORE RANGE BREAKDOWN */}
            {doubleFilteredTrades.length > 0 && (
              <div style={{ marginTop: '24px', padding: '16px', backgroundColor: 'rgba(255,255,255,0.01)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ marginBottom: '12px', fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <TrendingUp size={14} color="var(--accent-gold)" /> DESGLOSE DE CONFLUENCIA POR SCORE
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {scoreRangesData.map(range => {
                    const isPositive = parseFloat(range.pnlR) >= 0;
                    return (
                      <div key={range.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '4px', borderLeft: `3px solid ${range.color}` }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)' }}>{range.label}</span>
                          <span style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>{range.tradesCount} trades | Win Rate: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{range.winRate}%</span></span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>FACTOR BENEF.</div>
                            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: parseFloat(range.profitFactor) >= 1.5 ? 'var(--accent-green)' : parseFloat(range.profitFactor) >= 1.0 ? 'var(--accent-gold)' : 'var(--accent-red)' }}>{range.profitFactor}</div>
                          </div>
                          <div style={{ textAlign: 'right', minWidth: '60px' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>RETORNO</div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isPositive ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                              {isPositive ? '+' : ''}{range.pnlR}R
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* OTE ENTRY BREAKDOWN */}
            {trades.filter(t => t.events?.some(e => e.includes('OTE_Retracement'))).length > 0 && (
              <div style={{ marginTop: '20px', padding: '16px', backgroundColor: 'rgba(255,255,255,0.01)', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ marginBottom: '12px', fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <TrendingUp size={14} color="var(--accent-gold)" /> DESGLOSE DE RENDIMIENTO POR OTE
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {oteBreakdownData.map(data => {
                    const isPositive = parseFloat(data.pnlR) >= 0;
                    const currentOteEntry = sessionFilter === 'ALL'
                      ? oteEntryPercent
                      : (sessionTriggers[sessionFilter]?.oteChoch?.entryPercent ?? oteEntryPercent);
                    const isCurrentlyActive = currentOteEntry === data.level;

                    return (
                      <div 
                        key={data.level} 
                        onClick={() => handleDashboardOteSelect(data.level)}
                        style={{ 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'space-between', 
                          padding: '10px 12px', 
                          backgroundColor: isCurrentlyActive ? 'rgba(255,170,0,0.05)' : 'rgba(255,255,255,0.02)', 
                          borderRadius: '4px', 
                          border: isCurrentlyActive ? '1px solid rgba(255,170,0,0.3)' : '1px solid transparent',
                          borderLeft: `4px solid ${data.color}`,
                          cursor: 'pointer',
                          transition: 'all 0.2s ease-in-out',
                        }}
                        title="Haz clic para aplicar este OTE y re-correr backtest automáticamente"
                        onMouseEnter={e => {
                          e.currentTarget.style.backgroundColor = isCurrentlyActive ? 'rgba(255,170,0,0.08)' : 'rgba(255,255,255,0.05)';
                          e.currentTarget.style.transform = 'translateX(2px)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.backgroundColor = isCurrentlyActive ? 'rgba(255,170,0,0.05)' : 'rgba(255,255,255,0.02)';
                          e.currentTarget.style.transform = 'translateX(0)';
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            Retorno OTE {data.level}% {isCurrentlyActive && <span style={{ fontSize: '0.55rem', padding: '1px 4px', backgroundColor: 'rgba(255,170,0,0.2)', color: 'var(--accent-gold)', borderRadius: '3px', fontWeight: 700 }}>ACTIVO</span>}
                          </span>
                          <span style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>
                            {data.tradesCount} trades | Win Rate: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{data.winRate}%</span>
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>FACTOR BENEF.</div>
                            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: parseFloat(data.profitFactor) >= 1.5 ? 'var(--accent-green)' : parseFloat(data.profitFactor) >= 1.0 ? 'var(--accent-gold)' : 'var(--accent-red)' }}>
                              {data.profitFactor}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', minWidth: '60px' }}>
                            <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>RETORNO</div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isPositive ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                              {isPositive ? '+' : ''}{data.pnlR}R
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
                  {tripleFilteredTrades.length}{tradeFilter !== 'ALL' || sessionFilter !== 'ALL' || scoreFilterMin > 5 || scoreFilterMax < 30 ? `/${trades.length}` : ''} total
                </span>
              )}
            </h3>
            {/* Session Filter */}
            {trades.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                {(['ALL', 'LONDON', 'NY', 'ASIA'] as const).map(s => {
                  const labels: Record<string, string> = { ALL: '🌍 Todas las Sesiones', LONDON: '🇬🇧 Londres (04-10:30h)', NY: '🇺🇸 New York (10:30-17h)', ASIA: '🇯🇵 Asia (21-04h)' };
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
                {(['ALL', 'CHOCH', 'BOS', 'OTE', 'OTE_CHOCH', 'OTE_BOS'] as const).map(f => {
                  const labels: Record<string, string> = { 
                    ALL: '⚡ Todos los Gatillos', 
                    CHOCH: '🚀 Solo CHoCH', 
                    BOS: '🔨 Solo BOS', 
                    OTE: '📉 OTE (Todos)',
                    OTE_CHOCH: '📉 OTE de CHoCH',
                    OTE_BOS: '📉 OTE de BOS'
                  };
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
            {/* Score Filter */}
            {trades.length > 0 && (
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '12px', 
                marginBottom: '16px', 
                padding: '10px 14px', 
                backgroundColor: 'rgba(255, 255, 255, 0.02)', 
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                flexWrap: 'wrap'
              }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  🎯 SCORE FILTRADO:
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '150px' }}>
                  <input 
                    type="range" 
                    min="5" 
                    max="30" 
                    value={scoreFilterMin} 
                    onChange={e => {
                      const val = Number(e.target.value);
                      setScoreFilterMin(val);
                      if (val > scoreFilterMax) setScoreFilterMax(val);
                    }}
                    style={{ flex: 1, accentColor: 'var(--accent-gold)', height: '4px', cursor: 'pointer' }} 
                  />
                  <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-gold)', minWidth: '60px', textAlign: 'right' }}>
                    Min: {scoreFilterMin}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '150px' }}>
                  <input 
                    type="range" 
                    min="5" 
                    max="30" 
                    value={scoreFilterMax} 
                    onChange={e => {
                      const val = Number(e.target.value);
                      setScoreFilterMax(val);
                      if (val < scoreFilterMin) setScoreFilterMin(val);
                    }}
                    style={{ flex: 1, accentColor: '#0088ff', height: '4px', cursor: 'pointer' }} 
                  />
                  <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#0088ff', minWidth: '60px', textAlign: 'right' }}>
                    Max: {scoreFilterMax}
                  </span>
                </div>
                
                {/* Pre-sets */}
                <div style={{ display: 'flex', gap: '4px' }}>
                  {[
                    { label: 'Todos (5+)', min: 5, max: 30 },
                    { label: '≥10 pts', min: 10, max: 30 },
                    { label: '≥15 pts', min: 15, max: 30 },
                    { label: '≥20 pts', min: 20, max: 30 }
                  ].map(preset => {
                    const isActive = scoreFilterMin === preset.min && scoreFilterMax === preset.max;
                    return (
                      <button 
                        key={preset.label}
                        onClick={() => {
                          setScoreFilterMin(preset.min);
                          setScoreFilterMax(preset.max);
                        }}
                        style={{
                          padding: '2px 8px',
                          fontSize: '0.65rem',
                          borderRadius: '4px',
                          border: isActive ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)',
                          backgroundColor: isActive ? 'rgba(255,170,0,0.1)' : 'transparent',
                          color: isActive ? 'var(--accent-gold)' : 'var(--text-secondary)',
                          fontWeight: isActive ? 700 : 400,
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* OTE Filter */}
            {trades.length > 0 && (() => {
              const isOteFilterActive = ['OTE', 'OTE_CHOCH', 'OTE_BOS'].includes(tradeFilter);
              return (
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '12px', 
                  marginBottom: '16px', 
                  padding: '10px 14px', 
                  backgroundColor: 'rgba(255, 255, 255, 0.02)', 
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  flexWrap: 'wrap',
                  opacity: isOteFilterActive ? 1 : 0.45,
                  pointerEvents: isOteFilterActive ? 'auto' : 'none',
                  transition: 'opacity 0.2s'
                }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                    🎯 OTE ENTRY FILTRADO {!isOteFilterActive && <span style={{ color: 'var(--accent-gold)', fontWeight: 400, marginLeft: '4px' }}>(Inactivo - Solo para gatillos OTE)</span>}:
                  </span>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {([50, 62, 79] as const).map(level => {
                      const label = `${level}%`;
                      const isActive = isOteFilterActive && oteFilter === level;
                      return (
                        <button 
                          key={level} 
                          disabled={!isOteFilterActive}
                          onClick={() => setOteFilter(level)}
                          style={{
                            padding: '4px 12px',
                            fontSize: '0.65rem',
                            borderRadius: '4px',
                            border: isActive ? '1px solid var(--accent-magenta)' : '1px solid var(--border-color)',
                            backgroundColor: isActive ? 'rgba(213,0,249,0.1)' : 'transparent',
                            color: isActive ? 'var(--accent-magenta)' : 'var(--text-secondary)',
                            fontWeight: isActive ? 700 : 400,
                            cursor: isOteFilterActive ? 'pointer' : 'not-allowed',
                            transition: 'all 0.2s'
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

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
                    {tripleFilteredTrades.map(t => {
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
                          setEnabled(s.config.enabled !== false);
                          // @ts-ignore
                          if (s.config.sessions) {
                            // @ts-ignore
                            setSessionTriggers(s.config.sessions);
                          }

                          if (uploadedFiles.length > 0) {
                            const logs = new Map<string, string[]>();
                            uploadedFiles.forEach(f => logs.set(f.tf, f.lines));
                            
                            const baseParams = {
                              ticker: s.ticker,
                              minBuyPoints: s.config.minBuyPoints,
                              minSellPoints: s.config.minSellPoints,
                              slBufferPercent: s.config.slBufferPercent,
                              fixedRR: s.config.fixedRR,
                              entryTrigger: s.config.entryTrigger,
                              maxDailyLossR: s.config.maxDailyLossR || undefined,
                              dailyProfitTargetR: s.config.dailyProfitTargetR || undefined,
                              maxConsecutiveLosses: s.config.maxConsecutiveLosses || undefined,
                              maxTradesPerDay: s.config.maxTradesPerDay || undefined,
                              trailingDrawdownR: s.config.trailingDrawdownR || undefined,
                            };
                            
                            // @ts-ignore
                            const finalSessions = s.config.sessions || sessionTriggers;
                            const sessions50 = getOverriddenSessions(finalSessions, 50);
                            const sessions62 = getOverriddenSessions(finalSessions, 62);
                            const sessions79 = getOverriddenSessions(finalSessions, 79);
                            
                            const res50 = runBacktest(logs, { ...baseParams, oteEntryPercent: 50, sessions: sessions50 });
                            const res62 = runBacktest(logs, { ...baseParams, oteEntryPercent: 62, sessions: sessions62 });
                            const res79 = runBacktest(logs, { ...baseParams, oteEntryPercent: 79, sessions: sessions79 });
                            
                            setTrades50(res50.trades);
                            setTrades62(res62.trades);
                            setTrades79(res79.trades);
                          }
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
      ) : (
        /* ================= PEPE: PORTAFOLIO GLOBAL TAB ================= */
        <div className="animate-fadeIn" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '20px', marginBottom: '24px' }}>
          
          {/* COLUMNA IZQUIERDA: CONTROLES Y CONFIGS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/* CARGADOR MULTI-ACTIVO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <Upload size={18} color="var(--accent-gold)" /> IMPORTAR BACKTESTS (.JSON)
              </h3>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginBottom: '16px', lineHeight: '1.4' }}>
                Subí múltiples archivos JSON de backtests individuales limpios (sin killswitches internos) para evaluar el comportamiento unificado de tu cuenta.
              </p>

              <div style={{
                border: '2px dashed rgba(255, 255, 255, 0.15)',
                borderRadius: '8px',
                padding: '24px 16px',
                textAlign: 'center',
                cursor: 'pointer',
                background: 'rgba(255, 255, 255, 0.02)',
                transition: 'all 0.2s ease',
                position: 'relative'
              }}
              onClick={() => {
                const input = document.getElementById('portfolio-file-upload');
                if (input) input.click();
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--accent-gold)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)'}
              >
                <input
                  id="portfolio-file-upload"
                  type="file"
                  multiple
                  accept=".json"
                  onChange={handlePortfolioUpload}
                  style={{ display: 'none' }}
                />
                <Upload size={28} color="var(--text-secondary)" style={{ margin: '0 auto 8px auto', display: 'block' }} />
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)', display: 'block' }}>
                  Seleccionar archivos JSON
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', display: 'block', marginTop: '4px' }}>
                  Soporta selección múltiple (EURUSD, GBPUSD, etc.)
                </span>
              </div>

              {/* LISTA DE ACTIVOS CARGADOS */}
              {portfolioFiles.length > 0 && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-secondary)' }}>ACTIVOS ACTIVOS EN PORTAFOLIO:</span>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '6px' }}>
                    {portfolioFiles.map((file, idx) => (
                      <div key={idx} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 12px',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '6px'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: file.ticker === 'BTCUSD' ? '#f7931a' : file.ticker === 'US100' ? '#00c49f' : '#0088ff'
                          }}></span>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff' }}>{file.ticker}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{file.trades.length} trades</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPortfolioFiles(prev => {
                                const next = prev.filter(f => f.ticker !== file.ticker);
                                setTimeout(() => {
                                  const res = runPortfolioSimulation(next, {
                                    mdl: globalMDL,
                                    dpt: globalDPT,
                                    mcl: globalMCL,
                                    mtd: globalMTD,
                                    tdd: globalTDD
                                  });
                                  setPortfolioResults(res);
                                }, 50);
                                return next;
                              });
                            }}
                            style={{ background: 'none', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', fontSize: '0.75rem' }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* PARÁMETROS DEL KILLSWITCH GLOBAL */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <ShieldAlert size={18} color="var(--accent-red)" /> RIESGO CONSOLIDADO (CUENTA)
              </h3>

              {/* SLIDER MDL */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Daily Loss (MDL)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-red)' }}>{globalMDL > 0 ? `-${globalMDL.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.5"
                  value={globalMDL}
                  onChange={(e) => handleGlobalParamChange('mdl', parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Bloquea la cuenta al perder este monto R diario.</span>
              </div>

              {/* SLIDER DPT */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Daily Profit Target (DPT)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-green)' }}>{globalDPT > 0 ? `+${globalDPT.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="15"
                  step="0.5"
                  value={globalDPT}
                  onChange={(e) => handleGlobalParamChange('dpt', parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-green)' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Asegura ganancias cerrando la sesión al alcanzar esta meta R.</span>
              </div>

              {/* SLIDER MTD */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Trades / Día (MTD)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)' }}>{globalMTD > 0 ? `${globalMTD} trades` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  value={globalMTD}
                  onChange={(e) => handleGlobalParamChange('mtd', parseInt(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-gold)' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Número máximo de operaciones consolidadas permitidas por día.</span>
              </div>

              {/* SLIDER MCL */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Max Consec. Losses (MCL)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-red)' }}>{globalMCL > 0 ? `${globalMCL} racha` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  step="1"
                  value={globalMCL}
                  onChange={(e) => handleGlobalParamChange('mcl', parseInt(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Racha de pérdidas seguidas permitidas globalmente en el día.</span>
              </div>

              {/* SLIDER TDD */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Trailing Drawdown (TDD)</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#f7931a' }}>{globalTDD > 0 ? `${globalTDD.toFixed(1)}R` : 'OFF'}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="8"
                  step="0.5"
                  value={globalTDD}
                  onChange={(e) => handleGlobalParamChange('tdd', parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#f7931a' }}
                />
                <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>Pérdida máxima admitida desde el punto más alto del PnL consolidado del día.</span>
              </div>

              {/* BOTONES ACCION GLOBAL */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button
                  type="button"
                  onClick={handlePushGlobalToBot}
                  style={{
                    width: '100%',
                    padding: '10px',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #0088ff, #7c4dff)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    transition: 'opacity 0.2s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                >
                  <Wand2 size={14} /> PERSISTIR GLOBAL EN JARVIS LIVE
                </button>
              </div>
            </div>

            {/* GRID SEARCH POR METODO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.9rem', fontWeight: 700 }}>
                <Wand2 size={16} color="var(--accent-gold)" /> GRID SEARCH OPTIMIZER
              </h3>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginBottom: '14px', lineHeight: '1.4' }}>
                Calcula automáticamente las combinaciones ideales de MDL, DPT y MTD que maximizan el rendimiento global consolidado.
              </p>

              <button
                type="button"
                onClick={optimizePortfolioKillswitches}
                disabled={portfolioFiles.length === 0 || isOptimizingPortfolio}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  background: portfolioFiles.length === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 170, 0, 0.1)',
                  color: portfolioFiles.length === 0 ? 'var(--text-tertiary)' : 'var(--accent-gold)',
                  fontWeight: 700,
                  fontSize: '0.7rem',
                  cursor: portfolioFiles.length === 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px'
                }}
              >
                {isOptimizingPortfolio ? 'Calculando combinaciones...' : 'Correr Optimización en Malla'}
              </button>

              {portfolioOptResults.length > 0 && (
                <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-secondary)' }}>TOP 5 COMBINACIONES ÓPTIMAS:</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {portfolioOptResults.map((opt, index) => (
                      <div
                        key={index}
                        onClick={() => {
                          setGlobalMDL(opt.config.mdl);
                          setGlobalDPT(opt.config.dpt);
                          setGlobalMTD(opt.config.mtd);
                          const res = runPortfolioSimulation(portfolioFiles, {
                            mdl: opt.config.mdl,
                            dpt: opt.config.dpt,
                            mcl: globalMCL,
                            mtd: opt.config.mtd,
                            tdd: globalTDD
                          });
                          setPortfolioResults(res);
                          toast(`Aplicada configuración Top ${index + 1}`, 'success');
                        }}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 10px',
                          background: 'rgba(255, 255, 255, 0.03)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.borderColor = 'rgba(255, 170, 0, 0.3)'}
                        onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#fff' }}>
                            MDL: <span style={{ color: 'var(--accent-red)' }}>{opt.config.mdl}</span> | DPT: <span style={{ color: 'var(--accent-green)' }}>{opt.config.dpt}</span> | MTD: <span style={{ color: 'var(--accent-gold)' }}>{opt.config.mtd}</span>
                          </span>
                          <span style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)' }}>
                            Trades: {opt.active} ({opt.blocked} bloqueados)
                          </span>
                        </div>
                        <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--accent-green)' }}>
                          +{opt.pnlR.toFixed(1)}R
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* COLUMNA DERECHA: DASHBOARD, GRÁFICO Y DETALLES */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/* ESTADÍSTICAS DEL PORTAFOLIO */}
            <div className="panel" style={{
              background: 'rgba(30, 30, 40, 0.65)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '12px',
              padding: '20px'
            }}>
              <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                <BarChart2 size={18} color="var(--accent-gold)" /> DASHBOARD DE PORTAFOLIO CONSOLIDADO
              </h3>

              {!portfolioResults ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>
                  Subí los archivos de backtesting de tus activos para simular la cuenta.
                </div>
              ) : (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '20px' }}>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ display: 'block', fontSize: '0.55rem', color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase' }}>PnL Neto Consolidado</span>
                      <span style={{ fontSize: '1.25rem', fontWeight: 800, color: parseFloat(portfolioResults.metrics.totalPnLR) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                        {parseFloat(portfolioResults.metrics.totalPnLR) >= 0 ? '+' : ''}{portfolioResults.metrics.totalPnLR}R
                      </span>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ display: 'block', fontSize: '0.55rem', color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase' }}>Win Rate (WR)</span>
                      <span style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-gold)' }}>
                        {portfolioResults.metrics.wr}%
                      </span>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ display: 'block', fontSize: '0.55rem', color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase' }}>Profit Factor (PF)</span>
                      <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#0088ff' }}>
                        {portfolioResults.metrics.profitFactor}
                      </span>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ display: 'block', fontSize: '0.55rem', color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase' }}>Bloqueos Globales</span>
                      <span style={{ fontSize: '1.25rem', fontWeight: 800, color: portfolioResults.metrics.blockedTradesCount > 0 ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
                        {portfolioResults.metrics.blockedTradesCount} <span style={{ fontSize: '0.65rem', fontWeight: 500, color: 'var(--text-tertiary)' }}>trades</span>
                      </span>
                    </div>
                  </div>

                  {/* INFO DE TRADES COMPONENTES */}
                  <div style={{ display: 'flex', gap: '16px', fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '20px', padding: '8px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px' }}>
                    <span>✅ Operados: <strong>{portfolioResults.metrics.activeTradesCount}</strong></span>
                    <span>📈 Ganados: <strong>{portfolioResults.metrics.wins}</strong></span>
                    <span>📉 Perdidos: <strong>{portfolioResults.metrics.losses}</strong></span>
                    <span>🤝 Breakevens: <strong>{portfolioResults.metrics.be}</strong></span>
                    <span>📉 Max Drawdown: <strong style={{ color: 'var(--accent-red)' }}>{portfolioResults.metrics.maxDDR}R</strong></span>
                  </div>

                  {/* CURVA DE EQUIDAD PORTAFOLIO */}
                  <div style={{ height: '240px', width: '100%', marginBottom: '10px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={portfolioResults.equityData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="name" stroke="var(--text-tertiary)" style={{ fontSize: '0.6rem' }} />
                        <YAxis stroke="var(--text-tertiary)" style={{ fontSize: '0.6rem' }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', fontSize: '0.7rem', borderRadius: '6px' }}
                          labelStyle={{ fontWeight: 'bold' }}
                        />
                        <Line
                          type="monotone"
                          dataKey="PnL"
                          stroke="url(#portfolioEquityGrad)"
                          strokeWidth={2.5}
                          dot={false}
                          activeDot={{ r: 4 }}
                        />
                        <defs>
                          <linearGradient id="portfolioEquityGrad" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#00c49f" />
                            <stop offset="50%" stopColor="var(--accent-gold)" />
                            <stop offset="100%" stopColor="#0088ff" />
                          </linearGradient>
                        </defs>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>

            {/* DETALLE CRONOLÓGICO DE TRADES MULTI-ACTIVO */}
            {portfolioResults && portfolioResults.trades.length > 0 && (
              <div className="panel" style={{
                background: 'rgba(30, 30, 40, 0.65)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '12px',
                padding: '20px'
              }}>
                <h3 style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', fontSize: '0.95rem', fontWeight: 700 }}>
                  <BookOpen size={18} color="var(--accent-gold)" /> HISTORIAL UNIFICADO Y FILTRADO CONSOLIDADO
                </h3>

                <div style={{ maxHeight: '350px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', paddingRight: '4px' }}>
                  {portfolioResults.trades.slice().reverse().map((t, idx) => {
                    const isBlocked = t.blockedByGlobalKillswitch;
                    const r = Number(t.rMultiple) || 0;
                    const date = new Date(t.timestamp);
                    const formattedDate = date.toLocaleString('es-AR', {
                      timeZone: 'America/Argentina/Buenos_Aires',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    });

                    return (
                      <div key={idx} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 14px',
                        background: isBlocked ? 'rgba(255, 51, 51, 0.02)' : 'rgba(255, 255, 255, 0.02)',
                        border: isBlocked ? '1px dashed rgba(255, 51, 51, 0.2)' : '1px solid rgba(255, 255, 255, 0.05)',
                        borderRadius: '8px',
                        opacity: isBlocked ? 0.40 : 1,
                        transition: 'opacity 0.2s ease'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              fontSize: '0.75rem',
                              fontWeight: 800,
                              color: t.ticker === 'BTCUSD' ? '#f7931a' : t.ticker === 'US100' ? '#00c49f' : '#0088ff'
                            }}>{t.ticker}</span>
                            <span style={{
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              background: t.type === 'BUY' ? 'rgba(32,191,107,0.1)' : 'rgba(255,51,51,0.1)',
                              color: t.type === 'BUY' ? 'var(--accent-green)' : 'var(--accent-red)',
                              fontWeight: 700
                            }}>{t.type}</span>
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{formattedDate} ART</span>
                          </div>
                          
                          {isBlocked ? (
                            <span style={{ fontSize: '0.6rem', color: 'var(--accent-red)', fontWeight: 600 }}>
                              🚫 BLOQUEADO: {t.blockReason}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
                              FIB: {t.fibLevel || 'OTE'} | SL: {t.slBufferPercent || '1.0'} | R:R: {t.fixedRR || '2.0'}x
                            </span>
                          )}
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                          <span style={{
                            fontSize: '0.8rem',
                            fontWeight: 800,
                            color: isBlocked ? 'var(--text-tertiary)' : (r > 0 ? 'var(--accent-green)' : (r < 0 ? 'var(--accent-red)' : 'var(--text-secondary)'))
                          }}>
                            {isBlocked ? '0.00R' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`}
                          </span>
                          {!isBlocked && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
                              Equidad: {t.cumulativePnLR.toFixed(2)}R
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
