/** Pure wire-contract helpers: no services, timers, configuration or strategy weights. */
const ZONE_MEDALS: Record<string, string> = {
    PLAT: 'Platino', PLATINO: 'Platino', ORO: 'Oro', PLATA: 'Plata',
    BRONCE: 'Bronce', CHOCH: 'CHoCH', GOD: 'GodZone', GODZONE: 'GodZone',
    GOD_BRK: 'GodZone', BRK: 'Breaker', BREAKER: 'Breaker', LEGACY: 'Legacy', OB: 'OB',
};

/** Preserve unknown legacy categories; normalize only aliases understood by the radar. */
export function canonicalZoneMedal(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const trimmed = value.trim();
    const basePart = trimmed.split('|')[0].trim();
    const key = basePart.toUpperCase();
    if (key === 'UNDEFINED' || key === 'NULL') return undefined;
    return ZONE_MEDALS[key] ?? trimmed;
}

/** The caller already removes EX1/BOOTSTRAP. Accept legacy JSON and the native trailing TS. */
export function parseSyncZonesPayload(payload: string): unknown[] {
    const json = payload.replace(/\s*\|\s*TS:\s*\d+\s*$/i, '').trim();
    const zones: unknown = JSON.parse(json);
    if (!Array.isArray(zones)) throw new Error('SYNC_ZONES payload must be an array');
    return zones;
}

/** Reject malformed native rows before an empty/partial snapshot could erase valid state. */
export function assertNativeZoneSnapshot(rows: unknown[]): void {
    for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('Invalid native zone row');
        const z = row as Record<string, unknown>;
        const top = z.top !== undefined ? z.top : z.p;
        const bottom = z.btm !== undefined ? z.btm : z.b;
        const direction = z.dir !== undefined ? z.dir : z.d;
        const score = z.score !== undefined ? z.score : z.sc;
        if (typeof top !== 'number' || !Number.isFinite(top) || typeof bottom !== 'number' || !Number.isFinite(bottom)
            || top < bottom || (direction !== 'BUY' && direction !== 'SELL')
            || (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score)))) throw new Error('Invalid native zone geometry');
    }
}

/** Canonicalize identifiers, never infer a category for an old undefined event. */
export function canonicalZoneScoreId(id: string): string {
    const touch = id.match(/^🎯_ZoneTouched_(.+)_([^_]+)$/);
    if (touch) {
        const medal = canonicalZoneMedal(touch[1]);
        return medal ? `🎯_ZoneTouched_${medal}_${touch[2]}` : id;
    }
    const ob = id.match(/^OB_(.+)_([^_]+)$/);
    if (!ob) return id;
    const medal = canonicalZoneMedal(ob[1]);
    if (!medal) return id;
    if (medal === 'GodZone') return `💎_GOD_ZONE_${ob[2]}`;
    if (medal === 'Breaker') return `♻️_Breaker_${ob[2]}`;
    if (medal === 'CHoCH') return `🎯_Silver_Bullet_${ob[2]}`;
    return `OB_${medal}_${ob[2]}`;
}

/** Run before the caller's ordinary gcScore/refresh; leave position/leg/cooldown data alone. */
export function migrateZoneProtocolState(state: any): void {
    if (state.zoneProtocolSchema === 2) return;
    if (Array.isArray(state.zones)) for (const zone of state.zones) {
        if (zone && typeof zone === 'object') zone.medal = canonicalZoneMedal(zone.medal ?? zone.md);
    }
    for (const score of [state.scoreBuy, state.scoreSell]) {
        if (!score || !Array.isArray(score.events)) continue;
        const events: any[] = [], positions = new Map<string, number>();
        for (const event of score.events) {
            if (!event || typeof event.id !== 'string') { events.push(event); continue; }
            const id = canonicalZoneScoreId(event.id), previous = positions.get(id);
            if (previous === undefined) { positions.set(id, events.length); events.push({ ...event, id }); }
            else if (typeof event.ts === 'number' && event.ts < events[previous].ts) events[previous] = { ...event, id };
        }
        score.events = events;
    }
    state.zoneProtocolSchema = 2;
}

/** Caller must run normal score GC first. Unknown old provenance cannot justify a second touch. */
export function hasLegacyUnresolvedZoneEvidence(score: { events?: any[] }, tf: string): boolean {
    return Array.isArray(score.events) && score.events.some(event => event && event.tf === tf
        && typeof event.id === 'string' && /^(?:🎯_ZoneTouched_|OB_)(?:undefined|null)_/.test(event.id));
}

export const NATIVE_ZONE_SOURCE = 'SMC_NATIVE_V2';

/** Only a header field can select native semantics; quoted payload text cannot. */
export function isNativeZoneAlert(text: string): boolean {
    return /(?:^|\|)\s*Source:\s*SMC_NATIVE_V2\s*(?:\||$)/.test(text.split('Payload:', 1)[0]);
}

export interface NativeZoneBreak { direction: 'BUY' | 'SELL'; top: number; bottom: number; }

/** Native Dir is the zone's side. Legacy Dir remains the breaking pressure. */
export function parseNativeZoneBreak(text: string): NativeZoneBreak | undefined {
    if (!isNativeZoneAlert(text)) return undefined;
    const side = text.match(/(?:^|\|)\s*ZoneDir:\s*(LONG|SHORT)\s*(?:\||$)/)?.[1];
    const numberField = (name: string): number => {
        const value = text.match(new RegExp('(?:^|\\|)\\s*' + name + ':\\s*([^|]+)'))?.[1];
        return value === undefined || !value.trim() ? NaN : Number(value);
    };
    const top = numberField('ZoneTop'), bottom = numberField('ZoneBtm');
    if (!side || !Number.isFinite(top) || !Number.isFinite(bottom) || top < bottom) {
        throw new Error('Invalid native ZONE_BROKEN geometry');
    }
    return { direction: side === 'LONG' ? 'BUY' : 'SELL', top, bottom };
}

export function matchesNativeBrokenZone(zone: { tf?: string; dir?: string; top?: number; btm?: number }, tf: string, broken: NativeZoneBreak): boolean {
    return zone.tf === tf && zone.dir === broken.direction && zone.top === broken.top && zone.btm === broken.bottom;
}

// Shared producer for the live bridge and explicitly opted-in offline exports.
// No clock, services or synthetic divergence zones are hidden in this contract.
const NATIVE_TF: Record<string, string> = { M5:'5', M15:'15', M30:'30', H1:'60', H4:'240', D1:'D', W1:'W' };
const NATIVE_MEDAL: Record<string, string> = { Platino:'PLAT', Oro:'ORO', Plata:'PLATA', Bronce:'BRONCE', CHoCH:'CHoCH', GodZone:'GOD', Breaker:'BRK' };
const nativePrice = (n: number): string => Number(n.toFixed(8)).toString();
interface NativeOB { id: string; direction: string; top: number; bottom: number; category: string; score: number; mitigated: boolean; }
interface NativeSnapshot { activeOBs?: NativeOB[]; activeBreakers?: NativeOB[]; atr?: number | null; currentTrend?: string; }
export function buildNativeZoneSync(ticker: string, period: string, state: NativeSnapshot, weeklyBias: string, lastProcessedTs: number | undefined, nowMs: number): string | null {
    if (!Number.isFinite(lastProcessedTs)) return null;
    const tf = NATIVE_TF[period] ?? period;
    const zones = [...new Set([...(state.activeOBs ?? []), ...(state.activeBreakers ?? [])])]
        .filter(ob => !ob.mitigated).slice(0, 20).map(ob => ({
            id: ob.id, t: tf, d: ob.direction === 'Bullish' ? 'BUY' : 'SELL',
            p: ob.top, b: ob.bottom, lv: nativePrice(ob.direction === 'Bullish' ? ob.top : ob.bottom),
            md: NATIVE_MEDAL[ob.category] ?? ob.category, sc: ob.score, a: state.atr ?? 0
        }));
    const trend = state.currentTrend === 'Bullish' ? 'BUY' : state.currentTrend === 'Bearish' ? 'SELL' : 'NEUTRAL';
    const bias = weeklyBias === 'Bullish' ? 'BUY' : weeklyBias === 'Bearish' ? 'SELL' : 'NEUTRAL';
    return `SYNC_ZONES | ${ticker} | TF: ${tf} | Source: ${NATIVE_ZONE_SOURCE} | Trend: ${trend} | WBias: ${bias} | Payload: ${JSON.stringify(zones)} | TS: ${nowMs}`;
}
export function formatNativeZoneEvent(ticker: string, tf: string, ev: {type: string; direction: string; category?: string; medal?: string; score: number; top: number; bottom: number}, nowMs: number): string {
    if (ev.type !== 'ZONE_TOUCHED' && ev.type !== 'ZONE_BROKEN') throw new Error('Unsupported native zone event');
    const dir = ev.direction === 'Bullish' ? 'BUY' : 'SELL';
    const category = ev.category ?? ev.medal ?? 'OB', medal = NATIVE_MEDAL[category] ?? category;
    const broken = ev.type === 'ZONE_BROKEN' ? ` | ZoneDir: ${dir === 'BUY' ? 'LONG' : 'SHORT'} | ZoneTop: ${ev.top} | ZoneBtm: ${ev.bottom}` : '';
    return `${ev.type} | ${ticker} | TF: ${tf} | Source: ${NATIVE_ZONE_SOURCE} | Dir: ${dir} | Medal: ${medal} | Score: ${ev.score} | Top: ${nativePrice(ev.top)} | Btm: ${nativePrice(ev.bottom)}${broken} | TS: ${nowMs}`;
}
