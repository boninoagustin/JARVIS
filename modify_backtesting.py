import re

with open('src/services/backtesting.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Add import
if 'createStateStore' not in content:
    content = content.replace("import { processTradingAlert } from '../db/trading.js';", "import { processTradingAlert } from '../db/trading.js';\nimport { createStateStore } from '../engine/StateStore.js';")

# Add backtestState
if 'const backtestState = createStateStore();' not in content:
    content = content.replace('isReplaying = true;', 'isReplaying = true;\n    const backtestState = createStateStore();')

# Replace processTradingAlert calls
content = content.replace('await processTradingAlert(entry.line);', 'await processTradingAlert(entry.line, backtestState);')

with open('src/services/backtesting.ts', 'w', encoding='utf-8') as f:
    f.write(content)
