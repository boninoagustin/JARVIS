import { type SessionConfig, type SessionKey, SESSION_LABELS, DEFAULT_SESSION_CONFIG } from './types';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface Props {
  session: SessionKey;
  config: SessionConfig;
  onChange: (session: SessionKey, config: SessionConfig) => void;
}

const inputStyle: React.CSSProperties = {
  width: '70px', padding: '6px 8px', backgroundColor: '#111', border: '1px solid #333',
  borderRadius: '4px', color: '#e6e6e6', fontFamily: "'JetBrains Mono', monospace",
  fontSize: '0.8rem', textAlign: 'center', outline: 'none',
};

const toggleStyle = (active: boolean): React.CSSProperties => ({
  width: '36px', height: '20px', borderRadius: '10px', border: 'none', cursor: 'pointer',
  backgroundColor: active ? '#00e676' : '#333', position: 'relative', transition: 'all 0.2s',
});

const dotStyle = (active: boolean): React.CSSProperties => ({
  width: '16px', height: '16px', borderRadius: '50%', position: 'absolute', top: '2px',
  left: active ? '18px' : '2px', backgroundColor: active ? '#000' : '#666', transition: 'all 0.2s',
});

function TriggerRow({ label, emoji, trigger, onToggle, onScoreChange }: {
  label: string; emoji: string;
  trigger: { enabled: boolean; minScore: number };
  onToggle: () => void; onScoreChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1a1a1a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '90px' }}>
        <span>{emoji}</span>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: trigger.enabled ? '#e6e6e6' : '#555' }}>{label}</span>
      </div>
      <button onClick={onToggle} style={toggleStyle(trigger.enabled)}>
        <div style={dotStyle(trigger.enabled)} />
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '0.7rem', color: '#666' }}>Min:</span>
        <input type="number" min={1} max={50} value={trigger.minScore}
          onChange={e => onScoreChange(parseInt(e.target.value) || 1)}
          disabled={!trigger.enabled} style={{ ...inputStyle, opacity: trigger.enabled ? 1 : 0.4 }}
        />
      </div>
    </div>
  );
}

export default function SessionCard({ session, config, onChange }: Props) {
  const [expanded, setExpanded] = useState(session === 'ALL');
  const meta = SESSION_LABELS[session];
  const cfg = config || DEFAULT_SESSION_CONFIG;

  const update = (path: string, field: string, value: any) => {
    const next = { ...cfg, [path]: { ...(cfg as any)[path], [field]: value } };
    onChange(session, next);
  };

  return (
    <div style={{
      border: `1px solid ${expanded ? meta.color + '40' : '#222'}`,
      borderRadius: '6px', backgroundColor: expanded ? meta.color + '05' : '#0a0a0a',
      transition: 'all 0.2s', overflow: 'hidden',
    }}>
      <button onClick={() => setExpanded(!expanded)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', color: '#e6e6e6',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>{meta.emoji}</span>
          <span style={{ fontWeight: 700, fontSize: '0.8rem', color: meta.color }}>{meta.label}</span>
          {cfg.choch5m?.enabled && <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: '#00e67615', color: '#00e676', borderRadius: '3px' }}>CHoCH</span>}
          {cfg.bos5m?.enabled && <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: '#0088ff15', color: '#0088ff', borderRadius: '3px' }}>BOS</span>}
          {cfg.oteChoch5m?.enabled && <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: '#ffaa0015', color: '#ffaa00', borderRadius: '3px' }}>OTE CHOCH</span>}
          {cfg.oteBos5m?.enabled && <span style={{ fontSize: '0.65rem', padding: '2px 6px', backgroundColor: '#ffaa0015', color: '#ffaa00', borderRadius: '3px' }}>OTE BOS</span>}
        </div>
        {expanded ? <ChevronUp size={14} color="#666" /> : <ChevronDown size={14} color="#666" />}
      </button>

      {expanded && (
        <div style={{ padding: '0 14px 14px' }}>
          <TriggerRow label="CHoCH (5m)" emoji="🚀" trigger={cfg.choch5m}
            onToggle={() => update('choch5m', 'enabled', !cfg.choch5m?.enabled)}
            onScoreChange={v => update('choch5m', 'minScore', v)} />
          <TriggerRow label="CHoCH (15m)" emoji="🚀" trigger={cfg.choch15m}
            onToggle={() => update('choch15m', 'enabled', !cfg.choch15m?.enabled)}
            onScoreChange={v => update('choch15m', 'minScore', v)} />
          <TriggerRow label="BOS (5m)" emoji="🔨" trigger={cfg.bos5m}
            onToggle={() => update('bos5m', 'enabled', !cfg.bos5m?.enabled)}
            onScoreChange={v => update('bos5m', 'minScore', v)} />
          <TriggerRow label="BOS (15m)" emoji="🔨" trigger={cfg.bos15m}
            onToggle={() => update('bos15m', 'enabled', !cfg.bos15m?.enabled)}
            onScoreChange={v => update('bos15m', 'minScore', v)} />
          <TriggerRow label="OTE CHoCH (5m)" emoji="🎯" trigger={cfg.oteChoch5m}
            onToggle={() => update('oteChoch5m', 'enabled', !cfg.oteChoch5m?.enabled)}
            onScoreChange={v => update('oteChoch5m', 'minScore', v)} />
          <TriggerRow label="OTE CHoCH (15m)" emoji="🎯" trigger={cfg.oteChoch15m}
            onToggle={() => update('oteChoch15m', 'enabled', !cfg.oteChoch15m?.enabled)}
            onScoreChange={v => update('oteChoch15m', 'minScore', v)} />
          <TriggerRow label="OTE BOS (5m)" emoji="🎯" trigger={cfg.oteBos5m}
            onToggle={() => update('oteBos5m', 'enabled', !cfg.oteBos5m?.enabled)}
            onScoreChange={v => update('oteBos5m', 'minScore', v)} />
          <TriggerRow label="OTE BOS (15m)" emoji="🎯" trigger={cfg.oteBos15m}
            onToggle={() => update('oteBos15m', 'enabled', !cfg.oteBos15m?.enabled)}
            onScoreChange={v => update('oteBos15m', 'minScore', v)} />

          {/* Directional Max Consecutive Losses & Risk Settings */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #1a1a1a' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', color: '#aaa', display: 'flex', alignItems: 'center', gap: '4px' }}>
                🔴 Pérdidas Consec. Máx (SELL):
                <span style={{ fontSize: '0.55rem', backgroundColor: 'var(--accent-gold)', color: '#000', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold' }}>AUTO</span>
              </span>
              <input type="number" min={0} max={10} value={cfg.maxSellLosses ?? 0}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  const next = { ...cfg, maxSellLosses: isNaN(val) ? 0 : val };
                  onChange(session, next);
                }}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', color: '#aaa', display: 'flex', alignItems: 'center', gap: '4px' }}>
                🟢 Pérdidas Consec. Máx (BUY):
                <span style={{ fontSize: '0.55rem', backgroundColor: 'var(--accent-gold)', color: '#000', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold' }}>AUTO</span>
              </span>
              <input type="number" min={0} max={10} value={cfg.maxBuyLosses ?? 0}
                onChange={e => {
                  const val = parseInt(e.target.value);
                  const next = { ...cfg, maxBuyLosses: isNaN(val) ? 0 : val };
                  onChange(session, next);
                }}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', color: '#aaa' }}>🛡️ SL Buffer %:</span>
              <input type="number" step="0.01" min={0} value={cfg.slBufferPercent !== undefined ? cfg.slBufferPercent : ''}
                placeholder="Global"
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  const next = { ...cfg, slBufferPercent: isNaN(val) ? undefined : val };
                  onChange(session, next);
                }}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.75rem', color: '#aaa' }}>🎯 R:R Fijo (TP2):</span>
              <input type="number" step="0.1" min={0} value={cfg.fixedRR !== undefined ? cfg.fixedRR : ''}
                placeholder="Global"
                onChange={e => {
                  const val = parseFloat(e.target.value);
                  const next = { ...cfg, fixedRR: isNaN(val) ? undefined : val };
                  onChange(session, next);
                }}
                style={inputStyle}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
