import re

with open('src/engine/Types.ts', 'r', encoding='utf-8') as f:
    content = f.read()

replacement = """export interface RadarZoneWire {
    d?: 'BUY'|'SELL';
    p?: number;
    b?: number;
    lv?: string;
    md?: string;
    sc?: number;
    mi?: number;
    a?: number;
    t?: string;
    mg?: number;
    kz?: boolean;
}

export interface RadarZone {
    tf?: string;
    dir: 'BUY'|'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
    mid?: number;
    atr?: number;
    tp?: number;
    sl?: number;
    createdAt?: number;
    mg?: number;
    kz?: boolean;
}

export function normalizeRadarZone(raw: any): RadarZone {
    return {
        dir: raw.d ?? raw.dir,
        top: raw.p ?? raw.top,
        btm: raw.b ?? raw.btm,
        lvl: raw.lv ?? raw.lvl,
        medal: raw.md ?? raw.medal,
        score: raw.sc ?? raw.score,
        mid: raw.mi ?? raw.mid,
        atr: raw.a ?? raw.atr,
        tf: raw.t ?? raw.tf,
        tp: raw.tp,
        sl: raw.sl,
        createdAt: raw.createdAt,
        mg: raw.mg,
        kz: raw.kz
    };
}"""

match = re.search(r"export interface RadarZone \{.*?kz\?: boolean;\n\}", content, re.DOTALL)
if match:
    content = content[:match.start()] + replacement + content[match.end():]
    with open('src/engine/Types.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Patched successfully")
else:
    print("Failed to find target block")
