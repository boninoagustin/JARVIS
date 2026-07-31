import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { BacktestTrade, BacktestResult } from '../../services/backtestTypes';

// ─── Tipos ────────────────────────────────────────────────
export interface UploadedFile {
  name: string;
  tf: string;
  lines: any[];
  lineCount: number;
}

export interface SessionConfig {
  enabled: boolean;
  minScore: number;
  slBuff: number;
  tp2: number;
  partialClosePct: number;
  slAfterTp1: 'midpoint' | 'breakeven' | 'none';
  tp15BeEnabled: boolean;
  atrTrailEnabled: boolean;
  structuralTrailEnabled: boolean;
  tp1StructuralMinRR: number;
}

export interface SessionTriggerSet {
  choch15m: SessionConfig;
  bos15m: SessionConfig;
  oteChoch15m?: SessionConfig & { entryPercent?: number };
  oteBos15m?: SessionConfig & { entryPercent?: number };
  maxBuyLosses?: number;
  maxSellLosses?: number;
}

export interface PortfolioAssetFile {
  name: string;
  ticker: string;
  trades: any[];
}

export interface OptimizedSessionResult {
  config: any;
  result: BacktestResult;
}

export interface OptimizationResult {
  best: any;
  top10: any[];
  evaluated: number;
  trainPnlR: number;
  trainTrades: number;
  oosPnlR: number | null;
  oosTrades: number | null;
}

export interface BacktestingState {
  // ─── Config ───
  ticker: string;
  minBuyPoints: number;
  minSellPoints: number;
  slBufferPercent: number;
  fixedRR: number;
  oteEntryPercent: number;
  entryTrigger: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART';
  partialClosePct: number;
  slAfterTp1: 'midpoint' | 'breakeven' | 'none';
  tp15BeEnabled: boolean;
  atrTrailEnabled: boolean;
  structuralTrailEnabled: boolean;
  tp1StructuralMinRR: number;

  // ─── Killswitches / Friction ───
  maxDailyLossR: number;
  dailyProfitTargetR: number;
  maxConsecutiveLosses: number;
  maxTradesPerDay: number;
  trailingDrawdownR: number;
  spreadPips: number;
  commissionPerLot: number;
  riskUsd: number;
  minRR: number;
  maxTradesPerSession: number;
  enabled: boolean;
  activeSessions: string[];

  // ─── Session Triggers ───
  sessionTriggers: Record<string, SessionTriggerSet>;

  // ─── Files ───
  uploadedFiles: UploadedFile[];

  // ─── Execution ───
  isRunning: boolean;
  progress: number;
  trades: BacktestTrade[];
  result: BacktestResult | null;
  showLog: boolean;
  selectedSession: string | null;
  sessionFilter: 'GLOBAL' | 'OFF' | 'LONDON' | 'NY' | 'ASIA';
  tradeFilter: string;
  optimizingTrigger: string | null;
  optimizeProgress: number;
  optimizingSessionLosses: string | null;
  optimizedSessionResults: Record<string, OptimizedSessionResult>;

  // ─── Portfolio ───
  activeTab: 'individual' | 'portfolio';
  portfolioFiles: PortfolioAssetFile[];
  globalMDL: number;
  globalDPT: number;
  globalMCL: number;
  globalMTD: number;
  globalTDD: number;
  globalDisabledSessions: string[];
  portfolioResults: { trades: any[]; metrics: any; equityData: any[] } | null;
  isOptimizingPortfolio: boolean;
  portfolioOptResults: any[];

  // ─── Acciones ───
  setTicker: (v: string) => void;
  setMinBuyPoints: (v: number) => void;
  setMinSellPoints: (v: number) => void;
  setSlBufferPercent: (v: number) => void;
  setFixedRR: (v: number) => void;
  setOteEntryPercent: (v: number) => void;
  setEntryTrigger: (v: 'CHOCH' | 'OTE' | 'BOTH' | 'SMART') => void;
  setPartialClosePct: (v: number) => void;
  setSlAfterTp1: (v: 'midpoint' | 'breakeven' | 'none') => void;
  setTp15BeEnabled: (v: boolean) => void;
  setAtrTrailEnabled: (v: boolean) => void;
  setStructuralTrailEnabled: (v: boolean) => void;
  setTp1StructuralMinRR: (v: number) => void;

  setMaxDailyLossR: (v: number) => void;
  setDailyProfitTargetR: (v: number) => void;
  setMaxConsecutiveLosses: (v: number) => void;
  setMaxTradesPerDay: (v: number) => void;
  setTrailingDrawdownR: (v: number) => void;
  setSpreadPips: (v: number) => void;
  setCommissionPerLot: (v: number) => void;
  setRiskUsd: (v: number) => void;
  setEnabled: (v: boolean) => void;

  setSessionTriggers: (v: Record<string, SessionTriggerSet>) => void;
  updateSessionTrigger: (sessionKey: string, triggerKey: string, updates: Partial<SessionConfig>) => void;

  setUploadedFiles: (files: UploadedFile[] | ((prev: UploadedFile[]) => UploadedFile[])) => void;

  setIsRunning: (v: boolean) => void;
  setProgress: (v: number) => void;
  setTrades: (v: BacktestTrade[]) => void;
  setResult: (v: BacktestResult | null) => void;
  setShowLog: (v: boolean) => void;
  setSelectedSession: (v: string | null) => void;
  setSessionFilter: (v: 'GLOBAL' | 'OFF' | 'LONDON' | 'NY' | 'ASIA') => void;
  setTradeFilter: (v: string) => void;
  setOptimizingTrigger: (v: string | null) => void;
  setOptimizeProgress: (v: number) => void;
  setOptimizingSessionLosses: (v: string | null) => void;
  setOptimizedSessionResults: (v: Record<string, OptimizedSessionResult>) => void;

  setActiveTab: (v: 'individual' | 'portfolio') => void;
  setPortfolioFiles: (v: PortfolioAssetFile[]) => void;
  setGlobalMDL: (v: number) => void;
  setGlobalDPT: (v: number) => void;
  setGlobalMCL: (v: number) => void;
  setGlobalMTD: (v: number) => void;
  setGlobalTDD: (v: number) => void;
  setGlobalDisabledSessions: (v: string[]) => void;
  setPortfolioResults: (v: { trades: any[]; metrics: any; equityData: any[] } | null) => void;
  setIsOptimizingPortfolio: (v: boolean) => void;
  setPortfolioOptResults: (v: any[]) => void;
}

// ─── Defaults ──────────────────────────────────────────────
const defaultSessionConfig = (): SessionConfig => ({
  enabled: true,
  minScore: 4,
  slBuff: 0.1,
  tp2: 1.5,
  partialClosePct: 0.5,
  slAfterTp1: 'none',
  tp15BeEnabled: false,
  atrTrailEnabled: false,
  structuralTrailEnabled: false,
  tp1StructuralMinRR: 1.2,
});

const loadSessionTriggers = (): Record<string, SessionTriggerSet> => {
  try {
    const raw = localStorage.getItem('bt_session_triggers');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore */ }
  // Defaults
  const d = defaultSessionConfig;
  const makeSession = (): SessionTriggerSet => ({
    ...d(),
    choch15m: d(),
    bos15m: d(),
    oteChoch15m: { ...d(), entryPercent: 62 },
    oteBos15m: { ...d(), entryPercent: 62 },
  });
  return {
    OFF: makeSession(),
    LONDON: makeSession(),
    NY: makeSession(),
    ASIA: makeSession(),
  };
};

// ─── Store ──────────────────────────────────────────────────
export const useBacktestingStore = create<BacktestingState>()(
  persist(
    (set, get) => ({
      // ─── Config defaults ───
      ticker: 'BTCUSD',
      minBuyPoints: 5,
      minSellPoints: 5,
      slBufferPercent: 0.1,
      fixedRR: 2.0,
      oteEntryPercent: 50,
      entryTrigger: 'BOTH',
      partialClosePct: 0.5,
      slAfterTp1: 'midpoint',
      tp15BeEnabled: true,
      atrTrailEnabled: true,
      structuralTrailEnabled: true,
      tp1StructuralMinRR: 1.2,

      maxDailyLossR: 0,
      dailyProfitTargetR: 0,
      maxConsecutiveLosses: 0,
      maxTradesPerDay: 0,
      trailingDrawdownR: 0,
      spreadPips: 0.0,
      commissionPerLot: 0.0,
      riskUsd: 50,
      minRR: 2.0,
      maxTradesPerSession: 0,
      enabled: true,
      activeSessions: ['LONDON', 'NY', 'ASIA', 'OFF'],

      sessionTriggers: loadSessionTriggers(),

      uploadedFiles: [],

      isRunning: false,
      progress: 0,
      trades: [],
      result: null,
      showLog: false,
      selectedSession: null,
      sessionFilter: 'GLOBAL',
      tradeFilter: 'ALL',
      optimizingTrigger: null,
      optimizeProgress: 0,
      optimizingSessionLosses: null,
      optimizedSessionResults: {},

      activeTab: 'individual',
      portfolioFiles: [],
      globalMDL: 3.0,
      globalDPT: 5.0,
      globalMCL: 3,
      globalMTD: 4,
      globalTDD: 3.0,
      globalDisabledSessions: [],
      portfolioResults: null,
      isOptimizingPortfolio: false,
      portfolioOptResults: [],

      // ─── Setters ───
      setTicker: (v) => set({ ticker: v }),
      setMinBuyPoints: (v) => set({ minBuyPoints: v }),
      setMinSellPoints: (v) => set({ minSellPoints: v }),
      setSlBufferPercent: (v) => set({ slBufferPercent: v }),
      setFixedRR: (v) => set({ fixedRR: v }),
      setOteEntryPercent: (v) => set({ oteEntryPercent: v }),
      setEntryTrigger: (v) => set({ entryTrigger: v }),
      setPartialClosePct: (v) => set({ partialClosePct: v }),
      setSlAfterTp1: (v) => set({ slAfterTp1: v }),
      setTp15BeEnabled: (v) => set({ tp15BeEnabled: v }),
      setAtrTrailEnabled: (v) => set({ atrTrailEnabled: v }),
      setStructuralTrailEnabled: (v) => set({ structuralTrailEnabled: v }),
      setTp1StructuralMinRR: (v) => set({ tp1StructuralMinRR: v }),

      setMaxDailyLossR: (v) => set({ maxDailyLossR: v }),
      setDailyProfitTargetR: (v) => set({ dailyProfitTargetR: v }),
      setMaxConsecutiveLosses: (v) => set({ maxConsecutiveLosses: v }),
      setMaxTradesPerDay: (v) => set({ maxTradesPerDay: v }),
      setTrailingDrawdownR: (v) => set({ trailingDrawdownR: v }),
      setSpreadPips: (v) => set({ spreadPips: v }),
      setCommissionPerLot: (v) => set({ commissionPerLot: v }),
      setRiskUsd: (v) => set({ riskUsd: v }),
      setEnabled: (v) => set({ enabled: v }),

      setSessionTriggers: (triggers) => {
        localStorage.setItem('bt_session_triggers', JSON.stringify(triggers));
        set({ sessionTriggers: triggers });
      },
      updateSessionTrigger: (sessionKey, triggerKey, updates) => {
        const current = get().sessionTriggers;
        const next = JSON.parse(JSON.stringify(current));
        if (!next[sessionKey]) next[sessionKey] = {};
        next[sessionKey][triggerKey] = { ...next[sessionKey][triggerKey], ...updates };
        localStorage.setItem('bt_session_triggers', JSON.stringify(next));
        set({ sessionTriggers: next });
      },

      setUploadedFiles: (v) => set(s => ({ uploadedFiles: typeof v === 'function' ? v(s.uploadedFiles) : v })),

      setIsRunning: (v) => set({ isRunning: v }),
      setProgress: (v) => set({ progress: v }),
      setTrades: (v) => set({ trades: v }),
      setResult: (v) => set({ result: v }),
      setShowLog: (v) => set({ showLog: v }),
      setSelectedSession: (v) => set({ selectedSession: v }),
      setSessionFilter: (v) => set({ sessionFilter: v }),
      setTradeFilter: (v) => set({ tradeFilter: v }),
      setOptimizingTrigger: (v) => set({ optimizingTrigger: v }),
      setOptimizeProgress: (v) => set({ optimizeProgress: v }),
      setOptimizingSessionLosses: (v) => set({ optimizingSessionLosses: v }),
      setOptimizedSessionResults: (v) => set({ optimizedSessionResults: v }),

      setActiveTab: (v) => set({ activeTab: v }),
      setPortfolioFiles: (v) => set({ portfolioFiles: v }),
      setGlobalMDL: (v) => set({ globalMDL: v }),
      setGlobalDPT: (v) => set({ globalDPT: v }),
      setGlobalMCL: (v) => set({ globalMCL: v }),
      setGlobalMTD: (v) => set({ globalMTD: v }),
      setGlobalTDD: (v) => set({ globalTDD: v }),
      setGlobalDisabledSessions: (v) => set({ globalDisabledSessions: v }),
      setPortfolioResults: (v) => set({ portfolioResults: v }),
      setIsOptimizingPortfolio: (v) => set({ isOptimizingPortfolio: v }),
      setPortfolioOptResults: (v) => set({ portfolioOptResults: v }),
    }),
    {
      name: 'bt-backtesting-store',
      partialize: (state) => ({
        // Solo persistir sessionTriggers para mantener compatibilidad con el localStorage actual
        sessionTriggers: state.sessionTriggers,
      }),
    }
  )
);
