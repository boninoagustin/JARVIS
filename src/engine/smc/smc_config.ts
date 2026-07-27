// src/engine/smc/smc_config.ts
import { SMCPreset } from './types.js';

export const PRESETS: Record<string, SMCPreset> = {
    'Forex - 3. Balanceado': {
        name: 'Forex - 3. Balanceado',
        risk_level: 3,
        asset_type: 'forex',
        override_choch: true,
        require_displacement: true,
        require_fvg_after_ob: false, // risk_level <= 2 is true in Pine for this
        strict_breaker: true,
        strict_sweep: false, // risk_level <= 2 is true in Pine
        confirm_close: true,
        min_score: 3
    },
    'Forex - 5. Ultra Agresivo': {
        name: 'Forex - 5. Ultra Agresivo',
        risk_level: 5,
        asset_type: 'forex',
        override_choch: true,
        require_displacement: false,
        require_fvg_after_ob: false,
        strict_breaker: false,
        strict_sweep: false,
        confirm_close: false,
        min_score: 1
    },
    'Forex - 1. Ultra Conservador': {
        name: 'Forex - 1. Ultra Conservador',
        risk_level: 1,
        asset_type: 'forex',
        override_choch: true,
        require_displacement: true,
        require_fvg_after_ob: true,
        strict_breaker: true,
        strict_sweep: true,
        confirm_close: true,
        min_score: 5
    }
};

export function getPreset(name: string): SMCPreset {
    return PRESETS[name] || PRESETS['Forex - 3. Balanceado'];
}
