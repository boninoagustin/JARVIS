import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { FlaskConical, TrendingUp, CalendarClock, Newspaper, Timer } from 'lucide-react';

interface FileStats { count: number; first: string | null; last: string | null; }
interface BacktestProgressData {
  last_updated: string;
  trades: FileStats;
  sentiment: FileStats;
  calendar: FileStats;
}

const BACKTESTS = [
  {
    id: '1a',
    title: 'Proximidad a eventos',
    question: '¿Los trades tomados ±30 min de un dato de alto impacto rinden peor R?',
    deps: 'trades + horarios de eventos',
  },
  {
    id: '1b',
    title: 'Dirección anticipada',
    question: '¿Los trades a favor de la anticipación rinden mejor R que los que van en contra?',
    deps: 'trades + forecast→actual',
  },
  {
    id: '2',
    title: 'Sesgo de sentimiento',
    question: '¿El sentimiento de noticias predice el resultado de los trades?',
    deps: 'trades + sentimiento histórico',
  },
];

const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—';

const daysCovered = (s: FileStats) => {
  if (!s.first || !s.last) return 0;
  return Math.max(1, Math.round((new Date(s.last).getTime() - new Date(s.first).getTime()) / 86400000) + 1);
};

export default function BacktestProgress() {
  const [progress, setProgress] = useState<BacktestProgressData | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'app_settings', 'backtest_progress'), (snap) => {
      if (snap.exists()) setProgress(snap.data() as BacktestProgressData);
      setLoaded(true);
    }, (err) => console.error('[BacktestProgress]', err));
    return unsub;
  }, []);

  const dataCards = [
    { key: 'trades', label: 'Trades cerrados', icon: <TrendingUp size={18} />, color: 'var(--accent-green)', s: progress?.trades, target: 100, unit: 'trades' },
    { key: 'sentiment', label: 'Sentimiento', icon: <Newspaper size={18} />, color: 'var(--accent-blue)', s: progress?.sentiment, target: 30, unit: 'días' },
    { key: 'calendar', label: 'Calendario', icon: <CalendarClock size={18} />, color: 'var(--accent-gold)', s: progress?.calendar, target: 28, unit: 'días' },
  ];

  return (
    <div className="animate-fadeIn">
      <div className="panel-header" style={{ marginBottom: '16px' }}>
        <span><FlaskConical size={14} style={{ marginRight: 8 }} /> BACKTESTING DEL ANALIZADOR DE MERCADO</span>
        {progress?.last_updated && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            ACTUALIZADO: {new Date(progress.last_updated).toLocaleString('es-AR')}
          </span>
        )}
      </div>

      {/* Recordatorio */}
      <div style={{
        padding: '18px 20px',
        backgroundColor: 'rgba(255, 170, 0, 0.06)',
        border: '1px solid var(--accent-gold)',
        borderRadius: '6px',
        marginBottom: '24px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <Timer size={18} color="var(--accent-gold)" />
          <span style={{ fontWeight: 700, color: 'var(--accent-gold)', fontSize: '0.9rem', letterSpacing: '0.05em' }}>
            PROYECTO EN CURSO — RECOLECTANDO DATOS
          </span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: '1.5', margin: 0 }}>
          El bot está acumulando histórico automáticamente para poder medir si el analizador de mercado (sentimiento + calendario)
          aporta edge al trading SMC. Volvé en <strong>~1 mes</strong> para correr los backtests.
        </p>
      </div>

      {/* Las 3 preguntas a responder */}
      <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.05em', marginBottom: '12px' }}>
        Las 3 preguntas a responder
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {BACKTESTS.map(b => (
          <div key={b.id} className="panel" style={{ marginBottom: 0, padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-gold)', fontSize: '1rem' }}>{b.id}</span>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{b.title}</span>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: '1.45', margin: '0 0 10px 0' }}>{b.question}</p>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              usa: {b.deps}
            </div>
          </div>
        ))}
      </div>

      {/* Progreso de datos */}
      <h3 style={{ fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.05em', marginBottom: '12px' }}>
        Datos acumulados
      </h3>
      {!loaded ? (
        <div className="panel skeleton" style={{ height: '120px', opacity: 0.15 }} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
          {dataCards.map(c => {
            const count = c.s?.count ?? 0;
            const days = c.s ? daysCovered(c.s) : 0;
            const value = c.key === 'trades' ? count : days;
            const pct = Math.min(100, Math.round((value / c.target) * 100));
            return (
              <div key={c.key} className="panel" style={{ marginBottom: 0, padding: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={{ color: c.color }}>{c.icon}</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{c.label}</span>
                </div>
                <div className="mono" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {value}
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginLeft: 6 }}>{c.unit}</span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', margin: '4px 0 10px 0', fontFamily: 'var(--font-mono)' }}>
                  {fmtDate(c.s?.first ?? null)} → {fmtDate(c.s?.last ?? null)}
                </div>
                <div style={{ height: '6px', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', backgroundColor: c.color, borderRadius: '3px', transition: 'width 0.4s' }} />
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '6px' }}>
                  meta ~{c.target} {c.unit} · {pct}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
