import re

with open('src/engine/Types.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """export interface RadarZone {
    tf?: string;
    dir: 'BUY' | 'SELL';
    top: number;
    btm: number;
    lvl?: string;
    medal?: string;
    score?: number;
    tp?: number;
    sl?: number;
    mid?: number;
    atr?: number;
    t?: string;
    d?: 'BUY' | 'SELL';
    p?: number;
    b?: number;
    lv?: string;
    md?: string;
    sc?: number;
    mi?: number;
    a?: number;
    createdAt?: number;
}"""

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
        createdAt: raw.createdAt
    };
}"""

# Fallback pattern if the target doesn't perfectly match
match = re.search(r"export interface RadarZone \{.*?createdAt\?: number;\n\}", content, re.DOTALL)
if match:
    content = content[:match.start()] + replacement + content[match.end():]
else:
    print("Could not find the target block")

with open('src/engine/Types.ts', 'w', encoding='utf-8') as f:
    f.write(content)
