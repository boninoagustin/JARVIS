// Pure rollover-only classification. Never import FrictionModel or alter risk/R units.
import { rolloverSpreadCalibration } from './rolloverSpreadCalibration.js';

export type RolloverAssetClass = 'FOREX' | 'INDICES' | 'METALS' | 'ENERGY' | 'CRYPTO';

const indexAliases: Record<string, string[]> = {
    GER40: ['GERMANY40', 'GER40', 'DE40', 'DAX'],
    JP225: ['JAPAN225', 'NIKKEI225', 'JP225', 'NIKKEI'],
    US100: ['USTECH100', 'US100', 'NAS100', 'NASDAQ', 'NAS', 'NDX'],
    US30: ['US30', 'DOW30', 'DJI'],
    US500: ['US500', 'SPX500', 'SPX'],
    FRA40: ['FRANCE40', 'FRA40'],
    UK100: ['UK100'],
    SPAIN35: ['SPAIN35'],
    NL25: ['NETHERLANDS25', 'NL25'],
    ITALY40: ['ITALY40'],
    EUROPE50: ['EUROPE50'],
    AUSTRALIA200: ['AUSTRALIA200'],
};
function normalizedTicker(ticker: string): string {
    return ticker.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function indexTicker(ticker: string): string | undefined {
    return Object.keys(indexAliases).find(key => indexAliases[key]!.some(alias => ticker.includes(alias)));
}
export function getRolloverAssetClass(ticker: string): RolloverAssetClass {
    const t = normalizedTicker(ticker);
    // NETHERLANDS contains ETH; resolve broker index names before crypto aliases.
    if (indexTicker(t)) return 'INDICES';
    if (/BTC|ETH/.test(t)) return 'CRYPTO';
    if (/XAU|XAG|XPT|XPD|GOLD|SILVER|PLATINUM|PALLADIUM/.test(t)) return 'METALS';
    if (/OIL|XTI|XBR|WTI|BRENT|NATGAS|NATURALGAS|NGAS/.test(t)) return 'ENERGY';
    return 'FOREX';
}

export interface RolloverSpreadReference {
    pipSize: number;
    baseSpreadPrice: number;
    /** Price units measured independently during a clean liquid session. */
    cleanBaseline?: number;
}
const baseSpreadPips: Record<RolloverAssetClass, number> = {
    FOREX: 0.1, INDICES: 1, METALS: 1, ENERGY: 3, CRYPTO: 2,
};
function calibrationTicker(ticker: string): string {
    const index = indexTicker(ticker);
    if (index) return index;
    for (const [key, aliases] of Object.entries({
        XAUUSD: ['XAUUSD', 'GOLD'], XAGUSD: ['XAGUSD', 'SILVER'],
        XPTUSD: ['XPTUSD', 'PLATINUM'], XPDUSD: ['XPDUSD', 'PALLADIUM'],
        USOIL: ['USOIL', 'XTIUSD', 'WTI'], XBRUSD: ['XBRUSD', 'UKOIL', 'BRENT'],
        NATGAS: ['NATGAS', 'NATURALGAS', 'NGAS'],
    })) if (aliases.some(alias => ticker.includes(alias))) return key;
    // Keep the quote currency: XAUEUR must never inherit XAUUSD calibration.
    return ticker.match(/(?:USD|EUR|GBP|JPY|AUD|NZD|CAD|CHF|CNH|CNY|SGD|HKD|NOK|SEK|MXN|ZAR|TRY|PLN){2}/)?.[0] ?? ticker;
}
export function getRolloverSpreadReference(ticker: string, price: number): RolloverSpreadReference {
    const assetClass = getRolloverAssetClass(ticker);
    const pipSize = assetClass === 'FOREX' ? (normalizedTicker(ticker).includes('JPY') ? 0.01 : 0.0001)
        : assetClass === 'INDICES' ? 1
        : assetClass === 'METALS' ? 0.1
        : assetClass === 'ENERGY' ? 0.01
        : price * 0.0001;
    const t = normalizedTicker(ticker);
    const measured = (rolloverSpreadCalibration[t] ?? rolloverSpreadCalibration[calibrationTicker(t)])?.cleanBaseline;
    const cleanBaseline = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? measured : undefined;
    // Independent S_base: a tight live warmup must not reject measured normal spreads forever.
    // Rollover-only price units, never a change to FrictionModel or structural risk/SL policy.
    return { pipSize, baseSpreadPrice: Math.max(baseSpreadPips[assetClass] * pipSize, cleanBaseline ?? 0),
        ...(cleanBaseline !== undefined ? { cleanBaseline } : {}) };
}
