import { useEffect, useState } from 'react';
import { collection, getDocs, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { BrainCircuit, Check, Clock, ShieldAlert, TrendingUp, AlertTriangle, Hash, Percent, Activity } from 'lucide-react';
import { useToast } from './Toast';

interface MetricSet {
  score: number;
  pnl: number;
  winRate: number;
  tradeCount: number;
  profitFactor: number;
  maxDrawdown: number;
  expectancy: number;
}

interface OptimizeScoreResult {
  old: MetricSet;
  new: MetricSet;
}

interface LossMetrics {
  oldLimit: number | undefined;
  newLimit: number | undefined;
  winRate: number;
}

interface AutoTuneReport {
  timestamp: number;
  ticker: string;
  buy: OptimizeScoreResult;
  sell: OptimizeScoreResult;
  sessions?: Record<string, { buy: LossMetrics; sell: LossMetrics }>;
}

export default function AutoTunePanel() {
  const { toast } = useToast();
  const [reports, setReports] = useState<AutoTuneReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);

  const fetchReports = async () => {
    try {
      const snap = await getDocs(collection(db, 'autotune_reports'));
      const data = snap.docs.map(doc => doc.data() as AutoTuneReport);
      setReports(data.sort((a, b) => b.timestamp - a.timestamp));
    } catch (err) {
      console.error("Error fetching autotune reports:", err);
      toast("Error al cargar reportes de Auto-Tune", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const handleApply = async (report: AutoTuneReport) => {
    setApplying(report.ticker);
    try {
      const configRef = doc(db, 'asset_configs', report.ticker);
      
      const updateData: any = {
        minPointsForBuy: report.buy.new.score,
        minPointsForSell: report.sell.new.score,
        updatedAt: new Date().toISOString(),
        updatedBy: 'autotune'
      };

      await setDoc(configRef, updateData, { merge: true });
      
      if (report.sessions) {
        for (const [session, data] of Object.entries(report.sessions)) {
          const sessionUpdate: any = {};
          if (data.buy?.newLimit !== undefined) sessionUpdate.maxBuyLosses = data.buy.newLimit;
          if (data.sell?.newLimit !== undefined) sessionUpdate.maxSellLosses = data.sell.newLimit;
          
          if (Object.keys(sessionUpdate).length > 0) {
              await setDoc(configRef, {
                  sessions: {
                      [session]: sessionUpdate
                  }
              }, { merge: true });
          }
        }
      }

      toast(`✅ Recomendación aplicada para ${report.ticker}`, 'success');
      fetchReports();
    } catch (error) {
      console.error("Error applying autotune:", error);
      toast("Error al aplicar la recomendación", "error");
    } finally {
      setApplying(null);
    }
  };

  if (loading) {
    return <div style={{ padding: '20px', color: 'var(--text-secondary)' }}>Cargando inteligencia de red...</div>;
  }

  // Componente auxiliar para comparar métricas
  const MetricRow = ({ label, icon, oldVal, newVal, suffix = '', inverseColors = false }: { label: string, icon: any, oldVal: number, newVal: number, suffix?: string, inverseColors?: boolean }) => {
    let color = 'inherit';
    if (newVal > oldVal) color = inverseColors ? 'var(--status-sell)' : 'var(--status-buy)';
    if (newVal < oldVal) color = inverseColors ? 'var(--status-buy)' : 'var(--status-sell)';
    if (newVal === oldVal) color = 'var(--text-tertiary)';

    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', fontSize: '0.9rem' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
          {icon} {label}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {oldVal}{suffix} <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>→</span> 
          <strong style={{ color }}>{newVal}{suffix}</strong>
        </span>
      </div>
    );
  };

  const renderMetricsCard = (title: string, data: OptimizeScoreResult, type: 'BUY' | 'SELL') => {
    const isBuy = type === 'BUY';
    return (
      <div style={{ background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '8px' }}>
        <h5 style={{ color: isBuy ? 'var(--status-buy)' : 'var(--status-sell)', marginBottom: '16px', borderBottom: `1px solid ${isBuy ? 'rgba(0,255,0,0.1)' : 'rgba(255,0,0,0.1)'}`, paddingBottom: '8px' }}>
          {title}
        </h5>
        
        <MetricRow 
          label="Score Mínimo" 
          icon={<BrainCircuit size={14} />} 
          oldVal={data.old.score} 
          newVal={data.new.score} 
          inverseColors={false} 
        />
        
        <div style={{ height: '1px', background: 'var(--border-color)', margin: '12px 0' }} />

        <MetricRow 
          label="Trade Count" 
          icon={<Hash size={14} />} 
          oldVal={data.old.tradeCount} 
          newVal={data.new.tradeCount} 
          inverseColors={false} // Depende de la estrategia, pero más trades no siempre es mejor
        />
        <MetricRow 
          label="Win Rate" 
          icon={<Percent size={14} />} 
          oldVal={Number((data.old.winRate * 100).toFixed(1))} 
          newVal={Number((data.new.winRate * 100).toFixed(1))} 
          suffix="%"
        />
        <MetricRow 
          label="Max Drawdown" 
          icon={<AlertTriangle size={14} />} 
          oldVal={data.old.maxDrawdown} 
          newVal={data.new.maxDrawdown} 
          suffix="R"
          inverseColors={true} // Un drawdown mayor es peor
        />
        <MetricRow 
          label="Profit Factor" 
          icon={<Activity size={14} />} 
          oldVal={data.old.profitFactor} 
          newVal={data.new.profitFactor} 
        />
        <MetricRow 
          label="Expectativa" 
          icon={<TrendingUp size={14} />} 
          oldVal={data.old.expectancy} 
          newVal={data.new.expectancy} 
          suffix="R"
        />
        
        <div style={{ background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '6px', marginTop: '16px' }}>
          <MetricRow 
            label="Total PnL Estimado" 
            icon={<TrendingUp size={14} color="var(--accent-gold)" />} 
            oldVal={data.old.pnl} 
            newVal={data.new.pnl} 
            suffix="R"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="panel fade-in">
      <div className="panel-header" style={{ marginBottom: '24px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BrainCircuit color="var(--accent-gold)" /> AUTO-TUNE MACHINE LEARNING
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '8px' }}>
          Revisión periódica (45 días). Analiza Drawdown, Profit Factor y Expectativa Matemática para encontrar la configuración óptima.
        </p>
      </div>

      {reports.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
          <BrainCircuit size={48} color="var(--text-tertiary)" style={{ marginBottom: '16px' }} />
          <h4 style={{ color: 'var(--text-secondary)' }}>No hay reportes de Auto-Tune disponibles</h4>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {reports.map((report) => (
            <div key={report.ticker} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '20px' }}>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: '16px' }}>
                <div>
                  <h4 style={{ fontSize: '1.2rem', margin: 0, color: 'var(--text-primary)' }}>{report.ticker}</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-tertiary)', fontSize: '0.8rem', marginTop: '4px' }}>
                    <Clock size={12} /> {new Date(report.timestamp).toLocaleString()}
                  </div>
                </div>
                <button 
                  className="btn-success"
                  onClick={() => handleApply(report)}
                  disabled={applying === report.ticker}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {applying === report.ticker ? 'APLICANDO...' : <><Check size={16} /> APLICAR RECOMENDACIÓN</>}
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                {renderMetricsCard('LONG (BUY)', report.buy, 'BUY')}
                {renderMetricsCard('SHORT (SELL)', report.sell, 'SELL')}
              </div>

              {/* SESSIONS LOSS LIMITS */}
              {report.sessions && Object.keys(report.sessions).length > 0 && (
                <div style={{ marginTop: '20px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                  <h5 style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    <ShieldAlert size={14} /> Recomendaciones de Protección (Max Losses)
                  </h5>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                    {Object.entries(report.sessions).map(([sessionName, data]) => {
                      const showBuy = data.buy?.newLimit !== undefined && data.buy.newLimit !== data.buy.oldLimit;
                      const showSell = data.sell?.newLimit !== undefined && data.sell.newLimit !== data.sell.oldLimit;
                      
                      if (!showBuy && !showSell) return null;

                      return (
                        <div key={sessionName} style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', border: '1px dashed var(--border-color)' }}>
                          <strong style={{ display: 'block', marginBottom: '8px', color: 'var(--text-primary)' }}>{sessionName}</strong>
                          {showBuy && (
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                              LONG Límite: {data.buy.oldLimit || '∞'} → <span style={{ color: 'var(--accent-gold)' }}>{data.buy.newLimit}</span>
                              <br/><span style={{ fontSize: '0.75rem', opacity: 0.6 }}>(WinRate histórico: {(data.buy.winRate * 100).toFixed(0)}%)</span>
                            </div>
                          )}
                          {showSell && (
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                              SHORT Límite: {data.sell.oldLimit || '∞'} → <span style={{ color: 'var(--accent-gold)' }}>{data.sell.newLimit}</span>
                              <br/><span style={{ fontSize: '0.75rem', opacity: 0.6 }}>(WinRate histórico: {(data.sell.winRate * 100).toFixed(0)}%)</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          ))}
        </div>
      )}
    </div>
  );
}
