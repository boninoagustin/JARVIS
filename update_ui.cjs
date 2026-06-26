const fs = require('fs');
let content = fs.readFileSync('jarvis-os/src/components/BacktestingPanel.tsx', 'utf8');

function duplicateTriggerBlock(triggerType, uiLabel, emoji, baseBg, baseBorder, isOte) {
    const regex = new RegExp(`<!-- BEGIN ${triggerType} -->[\\s\\S]*?<!-- END ${triggerType} -->`, 'g'); // if we had comments...
}

// Actually it's easier to use string replacement since the structure is identical.
// I will just replace the "choch" block with two blocks (choch5m, choch15m).
// First, I need to isolate the choch block.

// We will use node's string replacement to replace the whole <div> for each trigger type.
const generateBlock = (type, tf, label, emoji, isOte, typeName) => {
  const tId = `${type}${tf}m`;
  let html = `
              {/* ${typeName} ${tf}M Trigger */}
              <div 
                onClick={() => setTradeFilter(tradeFilter === '${typeName}' ? 'ALL' : '${typeName}')}
                style={{ cursor: 'pointer', padding: '10px', backgroundColor: tradeFilter === '${typeName}' ? 'rgba(124,77,255,0.08)' : 'rgba(255,255,255,0.02)', border: tradeFilter === '${typeName}' ? '1px solid #7c4dff' : '1px solid var(--border-color)', borderRadius: '6px', transition: 'all 0.2s' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={sessionTriggers[sessionFilter]?.${tId}?.enabled ?? false}
                      onChange={e => updateSessionTrigger(sessionFilter, '${tId}', 'enabled', e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: 'var(--accent-gold)', width: '14px', height: '14px' }}
                    />
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>${emoji} ${label} (${tf}m)</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', padding: '2px 6px', borderRadius: '4px', backgroundColor: 'rgba(124,77,255,0.1)', color: '#7c4dff', fontWeight: 600 }}>Gatillo</span>
                </div>
                {sessionTriggers[sessionFilter]?.${tId}?.enabled && (
                  <div 
                    onClick={e => e.stopPropagation()} 
                    onPointerDown={e => e.stopPropagation()} 
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}
                  >
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Mín. Score:</span>
                    <input
                      type="range"
                      min="1"
                      max="30"
                      step="1"
                      value={sessionTriggers[sessionFilter]?.${tId}?.minScore ?? 5}
                      onChange={e => updateSessionTrigger(sessionFilter, '${tId}', 'minScore', parseInt(e.target.value))}
                      style={{ flex: 1, accentColor: 'var(--accent-gold)' }}
                    />
                    <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-gold)', minWidth: '24px', textAlign: 'right' }}>
                      +{sessionTriggers[sessionFilter]?.${tId}?.minScore}
                    </span>
                  </div>
                )}
`;
  if (isOte) {
    html += `                {sessionTriggers[sessionFilter]?.${tId}?.enabled && (
                  <div 
                    onClick={e => e.stopPropagation()} 
                    onPointerDown={e => e.stopPropagation()} 
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}
                  >
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>% Entry:</span>
                    <input
                      type="range"
                      min="1"
                      max="99"
                      step="1"
                      value={sessionTriggers[sessionFilter]?.${tId}?.entryPercent ?? 62}
                      onChange={e => updateSessionTrigger(sessionFilter, '${tId}', 'entryPercent', parseInt(e.target.value))}
                      style={{ flex: 1, accentColor: 'var(--accent-blue)' }}
                    />
                    <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-blue)', minWidth: '24px', textAlign: 'right' }}>
                      {sessionTriggers[sessionFilter]?.${tId}?.entryPercent}%
                    </span>
                  </div>
                )}\n`;
  }
  html += `              </div>`;
  return html;
};

// I will extract the sections between {/* CHOCH Trigger */} and {/* BOS Trigger */}
// using regex.
content = content.replace(
  /\{\/\* CHOCH Trigger \*\/\}[\s\S]*?(?=\{\/\* BOS Trigger \*\/|\{\/\* OTE CHOCH Trigger \*\/)/,
  generateBlock('choch', 5, 'CHOCH (Ruptura)', '💥', false, 'CHOCH') + '\n' +
  generateBlock('choch', 15, 'CHOCH (Ruptura)', '💥', false, 'CHOCH') + '\n'
);

content = content.replace(
  /\{\/\* BOS Trigger \*\/\}[\s\S]*?(?=\{\/\* OTE CHOCH Trigger \*\/|\{\/\* OTE BOS Trigger \*\/)/,
  generateBlock('bos', 5, 'BOS (Continuación)', '🔨', false, 'BOS') + '\n' +
  generateBlock('bos', 15, 'BOS (Continuación)', '🔨', false, 'BOS') + '\n'
);

content = content.replace(
  /\{\/\* OTE CHOCH Trigger \*\/\}[\s\S]*?(?=\{\/\* OTE BOS Trigger \*\/)/,
  generateBlock('oteChoch', 5, 'OTE CHOCH', '🎯', true, 'OTE_CHOCH') + '\n' +
  generateBlock('oteChoch', 15, 'OTE CHOCH', '🎯', true, 'OTE_CHOCH') + '\n'
);

content = content.replace(
  /\{\/\* OTE BOS Trigger \*\/\}[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/div>\s*<div style=\{\{ padding: '20px' \}\}>)/,
  generateBlock('oteBos', 5, 'OTE BOS', '🎯', true, 'OTE_BOS') + '\n' +
  generateBlock('oteBos', 15, 'OTE BOS', '🎯', true, 'OTE_BOS') + '\n'
);

fs.writeFileSync('jarvis-os/src/components/BacktestingPanel.tsx', content, 'utf8');
console.log("Updated UI blocks");
