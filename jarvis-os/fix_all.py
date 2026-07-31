import os

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/components/BacktestingPanel.tsx'
with open(file_path, 'r') as f:
    content = f.read()

# 1. Fix defaultSessionTriggers for oteChoch15m and oteBos15m (lines ~814)
content = content.replace(
    "oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62 },",
    "oteChoch15m: { enabled: true, minScore: 4, entryPercent: next[s].oteChoch15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteChoch15m) },"
)
content = content.replace(
    "oteBos5m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos5m?.entryPercent ?? 62 },",
    "oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },"
)
content = content.replace(
    "oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62 },",
    "oteBos15m: { enabled: true, minScore: 4, entryPercent: next[s].oteBos15m?.entryPercent ?? 62, ...migrateMgmt(next[s].oteBos15m) },"
)

# 2. handleAutoTuneSession is unused, so let's comment it out or prefix with underscore
content = content.replace("const handleAutoTuneSession = useCallback(async (sessionName: string) => {", "// const handleAutoTuneSession = useCallback(async (sessionName: string) => {")

# 3. Fix slBufferPercent in bestMeta (around 994)
content = content.replace("slBufferPercent: bestMeta.sl,", "/* slBufferPercent: bestMeta.sl */")
content = content.replace("slBufferPercent: bestData[s].config.slBufferPercent,", "/* slBufferPercent: bestData[s].config.slBufferPercent */")

with open(file_path, 'w') as f:
    f.write(content)

