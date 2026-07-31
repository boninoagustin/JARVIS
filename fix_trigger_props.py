import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    text = f.read()

# Update TriggerSettingsPanelProps
old_props = """interface TriggerSettingsPanelProps {
  sessionKey: string;
  triggerKey: string;
  title: string;
  config: any;
  updateTrigger: (session: string, triggerType: any, field: string, value: any, autoRun?: boolean) => void;
  onSimulate: () => void;
  isRunning: boolean;
  isOte: boolean;
  tradeFilter: string;
  setTradeFilter: (f: 'ALL' | 'WIN' | 'LOSS' | 'BE') => void;
  filterKey: string;
}"""

new_props = """interface TriggerSettingsPanelProps {
  sessionKey: string;
  triggerKey: string;
  title: string;
  config: any;
  updateTrigger: (session: string, triggerType: any, field: string, value: any, autoRun?: boolean) => void;
  onSimulate: () => void;
  isRunning: boolean;
  isOte: boolean;
  tradeFilter: string;
  setTradeFilter: (f: 'ALL' | 'WIN' | 'LOSS' | 'BE') => void;
  filterKey: string;
  onOptimize?: () => void;
  isOptimizing?: boolean;
}"""

text = text.replace(old_props, new_props)

old_comp_def = "const TriggerSettingsPanel: React.FC<TriggerSettingsPanelProps> = ({ sessionKey, triggerKey, title, config, updateTrigger, onSimulate, isRunning, isOte, tradeFilter, setTradeFilter, filterKey }) => {"
new_comp_def = "const TriggerSettingsPanel: React.FC<TriggerSettingsPanelProps> = ({ sessionKey, triggerKey, title, config, updateTrigger, onSimulate, isRunning, isOte, tradeFilter, setTradeFilter, filterKey, onOptimize, isOptimizing }) => {"

text = text.replace(old_comp_def, new_comp_def)

old_buttons = """        <button 
          onClick={(e) => { e.stopPropagation(); onSimulate(); }}
          disabled={isRunning || !config.enabled}
          style={{
            padding: '4px 8px', backgroundColor: 'var(--accent-gold)', color: '#000', border: 'none', borderRadius: '4px',
            fontWeight: 700, fontSize: '0.6rem', cursor: (isRunning || !config.enabled) ? 'not-allowed' : 'pointer',
            opacity: (isRunning || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
          }}
        >
          <Play size={10} /> Simular
        </button>"""

new_buttons = """        <div style={{ display: 'flex', gap: '4px' }}>
          {onOptimize && (
            <button 
              onClick={(e) => { e.stopPropagation(); onOptimize(); }}
              disabled={isOptimizing || isRunning || !config.enabled}
              style={{
                padding: '4px 8px', backgroundColor: 'transparent', color: 'var(--accent-gold)', border: '1px solid var(--accent-gold)', borderRadius: '4px',
                fontWeight: 700, fontSize: '0.6rem', cursor: (isOptimizing || isRunning || !config.enabled) ? 'not-allowed' : 'pointer',
                opacity: (isOptimizing || isRunning || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
              }}
            >
              {isOptimizing ? <Loader2 size={10} className="spin" /> : <Wand2 size={10} />}
              {isOptimizing ? 'Optimizando...' : 'Optimizar'}
            </button>
          )}
          <button 
            onClick={(e) => { e.stopPropagation(); onSimulate(); }}
            disabled={isRunning || isOptimizing || !config.enabled}
            style={{
              padding: '4px 8px', backgroundColor: 'var(--accent-gold)', color: '#000', border: 'none', borderRadius: '4px',
              fontWeight: 700, fontSize: '0.6rem', cursor: (isRunning || isOptimizing || !config.enabled) ? 'not-allowed' : 'pointer',
              opacity: (isRunning || isOptimizing || !config.enabled) ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px'
            }}
          >
            <Play size={10} /> Simular
          </button>
        </div>"""

text = text.replace(old_buttons, new_buttons)

with open(file_path, 'w') as f:
    f.write(text)
print("done props")
