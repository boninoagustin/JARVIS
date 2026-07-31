import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add TriggerSettingsPanel component before BacktestingPanel
trigger_panel_code = """
interface TriggerSettingsPanelProps {
  sessionKey: string;
  triggerKey: 'choch15m' | 'bos15m' | 'oteChoch15m' | 'oteBos15m';
  title: string;
  config: any;
  updateTrigger: (session: string, triggerType: any, field: string, value: any, autoRun?: boolean) => void;
  onSimulate: () => void;
  isRunning: boolean;
  isOte: boolean;
  tradeFilter: string;
  setTradeFilter: (f: string) => void;
  filterKey: string;
}

const TriggerSettingsPanel: React.FC<TriggerSettingsPanelProps> = ({ sessionKey, triggerKey, title, config, updateTrigger, onSimulate, isRunning, isOte, tradeFilter, setTradeFilter, filterKey }) => {
  if (!config) return null;
  const isActive = tradeFilter === filterKey;
  
  return (
    <div 
      onClick={() => setTradeFilter(isActive ? 'ALL' : filterKey)}
      style={{ cursor: 'pointer', padding: '10px', backgroundColor: isActive ? 'rgba(124,77,255,0.08)' : 'rgba(255,255,255,0.02)', border: isActive ? '1px solid #7c4dff' : '1px solid var(--border-color)', borderRadius: '6px', transition: 'all 0.2s' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={config.enabled ?? false}
            onChange={e => updateTrigger(sessionKey, triggerKey, 'enabled', e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--accent-gold)', width: '14px', height: '14px' }}
          />
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        </label>
        <button 
          onClick={(e) => { e.stopPropagation(); onSimulate(); }}
          disabled={isRunning || !config.enabled}
          style={{
            padding: '4px 8px', backgroundColor: 'var(--accent-gold)', color: '#000', border: 'none', borderRadius: '4px',
            fontWeight: 700, fontSize: '0.6rem', cursor: (isRunning || !config.enabled) ? 'not-allowed' : 'pointer',
            opacity: (isRunning || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
          }}
        >
          <Play size={10} /> Simular
        </button>
      </div>
      
      {config.enabled && (
        <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Min Score */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', minWidth: '60px' }}>Mín. Score:</span>
            <input type="range" min="1" max="30" step="1" value={config.minScore ?? 4} onChange={e => updateTrigger(sessionKey, triggerKey, 'minScore', parseInt(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent-gold)' }} />
            <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)', minWidth: '24px', textAlign: 'right' }}>+{config.minScore}</span>
          </div>

          {/* OTE Entry */}
          {isOte && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Entry Fib:</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {[50, 62, 79].map(level => (
                  <button key={level} type="button" onClick={() => updateTrigger(sessionKey, triggerKey, 'entryPercent', level)} style={{ flex: 1, padding: '4px 0', fontSize: '0.7rem', fontWeight: 700, borderRadius: '4px', border: config.entryPercent === level ? '1px solid var(--accent-gold)' : '1px solid var(--border-color)', backgroundColor: config.entryPercent === level ? 'rgba(255,215,0,0.15)' : 'var(--bg-secondary)', color: config.entryPercent === level ? 'var(--accent-gold)' : 'var(--text-secondary)', cursor: 'pointer' }}>{level}%</button>
                ))}
              </div>
            </div>
          )}

          {/* SL Buff & TP2 */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>SL BUFF: <strong style={{color:'var(--text-primary)'}}>{config.slBuff}</strong></span>
              <input type="range" min="0" max="0.5" step="0.01" value={config.slBuff ?? 0} onChange={e => updateTrigger(sessionKey, triggerKey, 'slBuff', parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>TP2 R:R: <strong style={{color:'var(--text-primary)'}}>{config.tp2}x</strong></span>
              <input type="range" min="1" max="5" step="0.1" value={config.tp2 ?? 1.5} onChange={e => updateTrigger(sessionKey, triggerKey, 'tp2', parseFloat(e.target.value))} style={{ width: '100%' }} />
            </div>
          </div>

          {/* Parciales & SL after TP1 */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>Parciales %: <strong style={{color:'var(--text-primary)'}}>{config.partialClosePct}%</strong></span>
              <input type="range" min="0" max="100" step="10" value={config.partialClosePct ?? 0} onChange={e => updateTrigger(sessionKey, triggerKey, 'partialClosePct', parseInt(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>Acción post-TP1:</span>
              <select value={config.slAfterTp1 ?? 'none'} onChange={e => updateTrigger(sessionKey, triggerKey, 'slAfterTp1', e.target.value)} style={{ padding: '2px 4px', fontSize: '0.65rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
                <option value="none">Nada</option>
                <option value="breakeven">Breakeven</option>
                <option value="midpoint">Midpoint (50% SL)</option>
              </select>
            </div>
          </div>
          
          {/* Toggles */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.tp15BeEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'tp15BeEnabled', e.target.checked)} />
              TP 1.5 -> BE
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.atrTrailEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'atrTrailEnabled', e.target.checked)} />
              ATR Trail
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={config.structuralTrailEnabled} onChange={e => updateTrigger(sessionKey, triggerKey, 'structuralTrailEnabled', e.target.checked)} />
              Trail Estructural
            </label>
          </div>
          
        </div>
      )}
    </div>
  );
};
"""

insert_idx = content.find('export default function BacktestingPanel() {')
if insert_idx != -1:
    content = content[:insert_idx] + trigger_panel_code + '\n' + content[insert_idx:]
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("done")
else:
    print("could not find export default function BacktestingPanel")

