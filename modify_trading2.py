import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Modify activeTrade assignment to include isBacktest
content = re.sub(
    r"(activeTrade = \{.*?)(\n\s*timestamp: nowMs\s*\n\s*\};)",
    r"\1\2\n\t\t\t\t\t\t\tisBacktest: isBacktest\n\t\t\t\t\t};",
    content,
    flags=re.DOTALL | re.MULTILINE
)

# Alternative regex to be more robust
import sys
try:
    with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    for i, line in enumerate(lines):
        if "timestamp: Date.now()," in line and "score: 0" in lines[i-1]:
            # This is the anti-pyramid mock trade around 1932
            lines[i] = line.replace("timestamp: Date.now(),", f"timestamp: Date.now(), isBacktest: isBacktest,")
            
        if "timestamp: nowMs" in line and "score:" in lines[i-1]:
            # Around 2137
            lines[i] = line.replace("timestamp: nowMs", f"timestamp: nowMs, isBacktest: isBacktest")
            
        # The loop
        if "for (const [tradeId, trade] of store.activeTrades) {" in line:
            # Insert the checks right after
            lines[i] = line + f"                if (trade.ticker !== ticker) continue;\n                if (!!(trade as any).isBacktest !== isBacktest) continue;\n"
            
        # RecordResult gates
        if "recordResult(trade.journalId, 'WIN'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"
        if "recordResult(tradeId, 'WIN'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"
                
        if "recordResult(trade.journalId, 'LOSS'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"
        if "recordResult(tradeId, 'LOSS'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"
                
        if "recordResult(trade.journalId, 'BREAKEVEN'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"
        if "recordResult(tradeId, 'BREAKEVEN'" in line:
            if "if (!isBacktest)" not in lines[i-1]:
                lines[i] = f"                                if (!isBacktest) {line.strip()}\n"

    with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print("Done applying loops and recordResult gates.")
except Exception as e:
    print("Error:", e)
