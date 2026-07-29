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

import fs from 'fs';
import path from 'path';

export function loadOptimizedPreset(ticker: string, period: string, basePresetName: string = 'Forex - 3. Balanceado'): SMCPreset {
    const basePreset = { ...getPreset(basePresetName) };
    
    try {
        const presetPath = path.resolve(process.cwd(), `optimized_preset_${ticker}.json`);
        if (fs.existsSync(presetPath)) {
            const data = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
            
            let tfKey = '';
            const p = period.toUpperCase();
            if (p === '15' || p === 'M15' || p === '15M') tfKey = 'M15';
            else if (p === '60' || p === '1H' || p === 'H1') tfKey = 'H1';
            else if (p === '240' || p === '4H' || p === 'H4') tfKey = 'H4';
            else if (p === 'D' || p === '1D' || p === 'D1') tfKey = 'D1';
            
            if (tfKey && data[tfKey]) {
                const opt = data[tfKey];
                if (opt.pivot_len !== undefined) basePreset.pivot_len = opt.pivot_len;
                if (opt.wick_pct !== undefined) basePreset.min_sweep_wick_pct = opt.wick_pct;
                if (opt.div_len !== undefined) basePreset.div_pivot_len = opt.div_len;
                if (opt.z_window !== undefined) basePreset.z_score_window = opt.z_window;
                console.log(`[SMC_CONFIG] Loaded optimized preset for ${ticker} ${tfKey}`);
            }
        }
    } catch (e) {
        console.error(`[SMC_CONFIG] Error loading optimized preset for ${ticker}:`, e);
    }
    
    return basePreset;
}

export function getOptimizedRisk(ticker: string) {
    try {
        const presetPath = path.resolve(process.cwd(), `optimized_preset_${ticker}.json`);
        if (fs.existsSync(presetPath)) {
            const data = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
            if (data.Risk) {
                return data.Risk;
            }
        }
    } catch (e) {
        console.error(`[SMC_CONFIG] Error loading optimized risk for ${ticker}:`, e);
    }
    return null;
}
