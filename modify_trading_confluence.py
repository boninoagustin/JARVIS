import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add computeConfluenceTFs function
function_str = """
function computeConfluenceTFs(zones: RadarZone[]): Map<RadarZone, string[]> {
    const byDir = new Map<string, RadarZone[]>();
    for (const z of zones) {
        const list = byDir.get(z.dir) ?? [];
        list.push(z);
        byDir.set(z.dir, list);
    }
    const result = new Map<RadarZone, string[]>();
    for (const group of byDir.values()) {
        for (const zone of group) {
            const tfs: string[] = [];
            for (const other of group) {
                if (other === zone || other.tf === zone.tf) continue;
                if (!(other.top < zone.btm || other.btm > zone.top) && !tfs.includes(other.tf || '')) {
                    tfs.push(other.tf || '');
                }
            }
            result.set(zone, tfs);
        }
    }
    return result;
}
"""
target_import = """function getCurrentSession(nowMs?: number): 'LONDON' | 'NY' | 'ASIA' | 'OFF' {"""
content = content.replace(target_import, function_str + "\n" + target_import)

# 2. Update assignments
# 2.1
target_assign1 = """                if (state.lastSyncDate !== todayStr) {
                    state.zones = [];
                    state.activeLocks = [];
                    state.lastSyncDate = todayStr;
                }"""
replacement_assign1 = """                if (state.lastSyncDate !== todayStr) {
                    state.zones = [];
                    state.zoneConfluence = computeConfluenceTFs(state.zones);
                    state.activeLocks = [];
                    state.lastSyncDate = todayStr;
                }"""
content = content.replace(target_assign1, replacement_assign1)

# 2.2
target_assign2 = """                state.zones = state.zones.filter(z => z.tf !== sourceTf);
                state.zones.push(...parsedZones);"""
replacement_assign2 = """                state.zones = state.zones.filter(z => z.tf !== sourceTf);
                state.zones.push(...parsedZones);
                state.zoneConfluence = computeConfluenceTFs(state.zones);"""
content = content.replace(target_assign2, replacement_assign2)

# 2.3
target_assign3 = """                    state.zones = state.zones.filter(z => {
                        if (z.tf !== eventTf) return true;
                        if (currentDirection === 'BUY' && z.dir === 'BUY') return true;   // Mantener zonas BUY (no afectadas)
                        if (currentDirection === 'SELL' && z.dir === 'SELL') return true;  // Mantener zonas SELL (no afectadas)
                        return false; // zona contraria = la que fue rota por la presión, eliminarla
                    });"""
replacement_assign3 = """                    state.zones = state.zones.filter(z => {
                        if (z.tf !== eventTf) return true;
                        if (currentDirection === 'BUY' && z.dir === 'BUY') return true;   // Mantener zonas BUY (no afectadas)
                        if (currentDirection === 'SELL' && z.dir === 'SELL') return true;  // Mantener zonas SELL (no afectadas)
                        return false; // zona contraria = la que fue rota por la presión, eliminarla
                    });
                    state.zoneConfluence = computeConfluenceTFs(state.zones);"""
content = content.replace(target_assign3, replacement_assign3)

# 2.4
target_assign4 = """        state.zones = state.zones.filter(z => {
            if (!z.createdAt) return true;
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });"""
replacement_assign4 = """        state.zones = state.zones.filter(z => {
            if (!z.createdAt) return true;
            return (nowMs - z.createdAt) < (MAX_ZONE_AGE_MS[z.tf || '60'] || 14400000);
        });
        state.zoneConfluence = computeConfluenceTFs(state.zones);"""
content = content.replace(target_assign4, replacement_assign4)


# 3. Replace loop
target_loop = """                    let confluenceMultiplier = 1.0;
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
                    else if (confluenceTFs.length >= 1) confluenceMultiplier = 1.5;"""
replacement_loop = """                    const confluenceTFs = state.zoneConfluence?.get(zone) ?? [];
                    let confluenceMultiplier = 1.0;
                    if (confluenceTFs.length >= 3) confluenceMultiplier = 2.5;
                    else if (confluenceTFs.length >= 2) confluenceMultiplier = 2.0;
                    else if (confluenceTFs.length >= 1) confluenceMultiplier = 1.5;"""
content = content.replace(target_loop, replacement_loop)


with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
