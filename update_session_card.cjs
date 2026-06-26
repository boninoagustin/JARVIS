const fs = require('fs');
let content = fs.readFileSync('jarvis-os/src/components/admin/SessionCard.tsx', 'utf8');

content = content.replace(
  /<TriggerRow label="CHoCH" emoji="🚀" trigger=\{cfg\.choch\}\s*onToggle=\{\(\) => update\('choch', 'enabled', !cfg\.choch\.enabled\)\}\s*onScoreChange=\{v => update\('choch', 'minScore', v\)\} \/>/g,
  `<TriggerRow label="CHoCH (5m)" emoji="🚀" trigger={cfg.choch5m}
            onToggle={() => update('choch5m', 'enabled', !cfg.choch5m?.enabled)}
            onScoreChange={v => update('choch5m', 'minScore', v)} />
          <TriggerRow label="CHoCH (15m)" emoji="🚀" trigger={cfg.choch15m}
            onToggle={() => update('choch15m', 'enabled', !cfg.choch15m?.enabled)}
            onScoreChange={v => update('choch15m', 'minScore', v)} />`
);

content = content.replace(
  /<TriggerRow label="BOS" emoji="🔨" trigger=\{cfg\.bos\}\s*onToggle=\{\(\) => update\('bos', 'enabled', !cfg\.bos\.enabled\)\}\s*onScoreChange=\{v => update\('bos', 'minScore', v\)\} \/>/g,
  `<TriggerRow label="BOS (5m)" emoji="🔨" trigger={cfg.bos5m}
            onToggle={() => update('bos5m', 'enabled', !cfg.bos5m?.enabled)}
            onScoreChange={v => update('bos5m', 'minScore', v)} />
          <TriggerRow label="BOS (15m)" emoji="🔨" trigger={cfg.bos15m}
            onToggle={() => update('bos15m', 'enabled', !cfg.bos15m?.enabled)}
            onScoreChange={v => update('bos15m', 'minScore', v)} />`
);

content = content.replace(
  /<TriggerRow label="OTE CHoCH" emoji="🎯" trigger=\{cfg\.oteChoch\}\s*onToggle=\{\(\) => update\('oteChoch', 'enabled', !cfg\.oteChoch\?\.enabled\)\}\s*onScoreChange=\{v => update\('oteChoch', 'minScore', v\)\} \/>/g,
  `<TriggerRow label="OTE CHoCH (5m)" emoji="🎯" trigger={cfg.oteChoch5m}
            onToggle={() => update('oteChoch5m', 'enabled', !cfg.oteChoch5m?.enabled)}
            onScoreChange={v => update('oteChoch5m', 'minScore', v)} />
          <TriggerRow label="OTE CHoCH (15m)" emoji="🎯" trigger={cfg.oteChoch15m}
            onToggle={() => update('oteChoch15m', 'enabled', !cfg.oteChoch15m?.enabled)}
            onScoreChange={v => update('oteChoch15m', 'minScore', v)} />`
);

content = content.replace(
  /<TriggerRow label="OTE BOS" emoji="🎯" trigger=\{cfg\.oteBos\}\s*onToggle=\{\(\) => update\('oteBos', 'enabled', !cfg\.oteBos\?\.enabled\)\}\s*onScoreChange=\{v => update\('oteBos', 'minScore', v\)\} \/>/g,
  `<TriggerRow label="OTE BOS (5m)" emoji="🎯" trigger={cfg.oteBos5m}
            onToggle={() => update('oteBos5m', 'enabled', !cfg.oteBos5m?.enabled)}
            onScoreChange={v => update('oteBos5m', 'minScore', v)} />
          <TriggerRow label="OTE BOS (15m)" emoji="🎯" trigger={cfg.oteBos15m}
            onToggle={() => update('oteBos15m', 'enabled', !cfg.oteBos15m?.enabled)}
            onScoreChange={v => update('oteBos15m', 'minScore', v)} />`
);

content = content.replace(
  /\{cfg\.choch\?\.enabled &&/g,
  "{cfg.choch5m?.enabled &&"
);

content = content.replace(
  /\{cfg\.bos\?\.enabled &&/g,
  "{cfg.bos5m?.enabled &&"
);

fs.writeFileSync('jarvis-os/src/components/admin/SessionCard.tsx', content, 'utf8');
console.log("Updated SessionCard");
