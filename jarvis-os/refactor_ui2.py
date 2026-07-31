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

# Insert before 'export const BacktestingPanel' or similar
insert_idx = content.find('export const BacktestingPanel')
if insert_idx != -1:
    content = content[:insert_idx] + trigger_panel_code + '\n' + content[insert_idx:]

# 2. Replace the massive trigger block inside BacktestingPanel
# Start string: <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}> right after `) : (` for sessionFilter !== 'GLOBAL'
# End string: `<div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.4' }}>`

start_marker = "<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>"
end_marker = "<div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '12px', lineHeight: '1.4' }}>"

start_idx = content.find(start_marker, content.find('SIMULAR CON NUEVA CONFIGURACIÓN'))
end_idx = content.find(end_marker, start_idx)

if start_idx != -1 and end_idx != -1:
    new_trigger_list_code = """<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="choch15m" title="💥 CHOCH (Ruptura) (15m)"
                config={sessionTriggers[sessionFilter]?.choch15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={false}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="CHOCH_15M"
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="bos15m" title="🚀 BOS (Continuación) (15m)"
                config={sessionTriggers[sessionFilter]?.bos15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={false}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="BOS_15M"
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="oteChoch15m" title="📉 OTE CHOCH (15m)"
                config={sessionTriggers[sessionFilter]?.oteChoch15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={true}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="OTE_CHOCH_15M"
              />
              <TriggerSettingsPanel
                sessionKey={sessionFilter} triggerKey="oteBos15m" title="📈 OTE BOS (15m)"
                config={sessionTriggers[sessionFilter]?.oteBos15m} updateTrigger={updateSessionTrigger}
                onSimulate={() => handleRun(undefined, undefined, false)} isRunning={isRunning} isOte={true}
                tradeFilter={tradeFilter} setTradeFilter={setTradeFilter} filterKey="OTE_BOS_15M"
              />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '12px', backgroundColor: 'rgba(255,165,0,0.03)', borderRadius: '6px', border: '1px solid rgba(255,165,0,0.08)' }}>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--accent-red)', whiteSpace: 'nowrap', fontWeight: 600, display: 'block', marginBottom: '4px' }}>MAX LOSS SELLs ({sessionFilter})</label>
                  <input type="number" min="0" value={sessionTriggers[sessionFilter]?.maxSellLosses ?? 0} onChange={e => updateSessionTrigger(sessionFilter, 'maxSellLosses', '', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} placeholder="Ilimitado (0)" />
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: 'var(--accent-green)', whiteSpace: 'nowrap', fontWeight: 600, display: 'block', marginBottom: '4px' }}>MAX LOSS BUYs ({sessionFilter})</label>
                  <input type="number" min="0" value={sessionTriggers[sessionFilter]?.maxBuyLosses ?? 0} onChange={e => updateSessionTrigger(sessionFilter, 'maxBuyLosses', '', parseInt(e.target.value) || 0)} style={{ width: '100%', padding: '4px', backgroundColor: 'var(--bg-base)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} placeholder="Ilimitado (0)" />
                </div>
              </div>

            </div>
            
            """
    content = content[:start_idx] + new_trigger_list_code + content[end_idx:]

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("done")
