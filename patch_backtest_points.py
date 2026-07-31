import re

file_path = '/home/bon/Descargas/JARVIS/jarvis-os/src/services/backtestEngine.ts'
with open(file_path, 'r', encoding='utf-8') as f:
    text = f.read()

old_block = r"""    // Zone touching \(scoring\)
    const buffer = Math\.max\(getBuffer\(ticker, currentPrice\), \(state\.atr14 \?\? 0\) \* 0\.25\);
    const validZones: RadarZone\[\] = \[\];
    for \(const zone of state\.zones\) \{
      if \(zone\.createdAt && \(nowMs - zone\.createdAt\) >= \(MAX_ZONE_AGE_MS\[zone\.tf \|\| '60'\] \|\| 14400000\)\) continue;
      validZones\.push\(zone\);

      if \(currentPrice <= \(zone\.top \+ buffer\) && currentPrice >= \(zone\.btm - buffer\)\) \{
        const enteredFromAbove = previousPrice !== null && previousPrice > zone\.top;
        const enteredFromBelow = previousPrice !== null && previousPrice < zone\.btm;
        const isValid = \(zone\.dir === 'BUY' && enteredFromAbove\) \|\| \(zone\.dir === 'SELL' && enteredFromBelow\);
        if \(!isValid && previousPrice !== null\) continue;

        const activeScore = zone\.dir === 'BUY' \? state\.scoreBuy : state\.scoreSell;
        const zTf = parseTF\(zone\.tf \|\| ''\);
        const basePts = zone\.score !== undefined \? zone\.score : 2;
        const tfMult = zTf === '4H' \? 2 : zTf === '1H' \? 1\.5 : 1;
        const eventName = zone\.medal\?\.includes\('God'\) \? `💎_GOD_ZONE_$\{zTf\}` :
                          zone\.medal\?\.includes\('CHoCH'\) \? `🎯_Silver_Bullet_$\{zTf\}` :
                          zone\.medal\?\.includes\('Breaker'\) \? `♻️_Breaker_$\{zTf\}` :
                          `OB_$\{zone\.medal\}_$\{zTf\}`;
        const pts = Math\.floor\(basePts \* tfMult\);
        if \(!activeScore\.events\.includes\(eventName\)\) \{
          activeScore\.events\.push\(eventName\);
          activeScore\.points \+= pts;
          activeScore\.lastUpdate = nowMs;
        \}
      \}
    \}
    state\.zones = validZones;"""

new_block = """    // Zone touching (scoring)
    const buffer = Math.max(getBuffer(ticker, currentPrice), (state.atr14 ?? 0) * 0.25);
    const validZones: RadarZone[] = [];
    const touchedThisPing: { zone: RadarZone; eventName: string; pts: number }[] = [];

    for (const zone of state.zones) {
      if (zone.createdAt && (nowMs - zone.createdAt) >= (MAX_ZONE_AGE_MS[zone.tf || '60'] || 14400000)) continue;
      validZones.push(zone);

      if (currentPrice <= (zone.top + buffer) && currentPrice >= (zone.btm - buffer)) {
        const enteredFromAbove = previousPrice !== null && previousPrice > zone.top;
        const enteredFromBelow = previousPrice !== null && previousPrice < zone.btm;
        const isValid = (zone.dir === 'BUY' && enteredFromAbove) || (zone.dir === 'SELL' && enteredFromBelow);
        if (!isValid && previousPrice !== null) continue;

        const activeScore = zone.dir === 'BUY' ? state.scoreBuy : state.scoreSell;
        const zTf = parseTF(zone.tf || '');
        const basePts = zone.score !== undefined ? zone.score : 2;
        
        let confluenceMultiplier = 1.0;
        let confluenceTFs: string[] = [];
        for (const otherZone of state.zones) {
            if (otherZone === zone) continue;
            if (otherZone.dir !== zone.dir) continue;
            if (otherZone.tf === zone.tf) continue;
            const overlaps = !(otherZone.top < zone.btm || otherZone.btm > zone.top);
            if (overlaps && !confluenceTFs.includes(otherZone.tf || '')) {
                confluenceTFs.push(otherZone.tf || '');
            }
        }
        if (confluenceTFs.length >= 3) confluenceMultiplier = 2.5;
        else if (confluenceTFs.length >= 2) confluenceMultiplier = 2.0;
        else if (confluenceTFs.length >= 1) confluenceMultiplier = 1.5;

        const tfMult = zTf === '4H' ? 2 : zTf === '1H' ? 1.5 : 1;
        const eventName = zone.medal?.includes('God') ? `💎_GOD_ZONE_${zTf}` :
                          zone.medal?.includes('CHoCH') ? `🎯_Silver_Bullet_${zTf}` :
                          zone.medal?.includes('Breaker') ? `♻️_Breaker_${zTf}` :
                          `OB_${zone.medal}_${zTf}`;
        const pts = Math.floor(basePts * tfMult * confluenceMultiplier);
        if (!activeScore.events.includes(eventName)) {
          activeScore.events.push(eventName);
          activeScore.points += pts;
          activeScore.points = Math.min(activeScore.points, 35);
          activeScore.lastUpdate = nowMs;
          touchedThisPing.push({ zone, eventName, pts });
        }
      }
    }

    for (const dir of ['BUY', 'SELL'] as const) {
        const dirZones = touchedThisPing.filter(t => t.zone.dir === dir);
        if (dirZones.length < 2) continue;

        const activeScore = dir === 'BUY' ? state.scoreBuy : state.scoreSell;
        const uniqueTFs = new Set(dirZones.map(t => t.zone.tf));
        const tfCount = uniqueTFs.size;

        if (tfCount >= 2) {
            const zonesOverlap = dirZones.some((a, i) =>
                dirZones.some((b, j) => i !== j && a.zone.tf !== b.zone.tf && !(a.zone.top < b.zone.btm || a.zone.btm > b.zone.top))
            );
            if (!zonesOverlap) continue;

            let confluenceBonus = tfCount === 4 ? 10 : tfCount === 3 ? 7 : 4;
            const tfList = [...uniqueTFs].map(t => parseTF(t || '')).sort((a: any, b: any) => {
                const order: Record<string, number> = { '5M': 0, '15M': 1, '1H': 2, '4H': 3, 'D': 4 };
                return (order[b] || 0) - (order[a] || 0);
            }).join('+');

            const eventName = `🧲_CONFLUENCIA_${tfCount}TF_${tfList}`;
            if (!activeScore.events.includes(eventName)) {
                activeScore.events.push(eventName);
                activeScore.points += confluenceBonus;
                activeScore.points = Math.min(activeScore.points, 35);
                activeScore.lastUpdate = nowMs;
            }
        }
    }

    state.zones = validZones;"""

if not re.search(r"// Zone touching \(scoring\)", text):
    print("Could not find block in text!")
else:
    text = re.sub(old_block, new_block, text, flags=re.MULTILINE)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(text)
    print("Patch applied to backtestEngine.ts")
