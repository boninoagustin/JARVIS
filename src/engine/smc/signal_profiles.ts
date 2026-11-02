import type { SMCPreset } from './types.js';

export type SignalProfile = 'legacy_v1' | 'directional_atr_v1';
export interface SignalAblation {
    directionalMomentum: boolean;
    sweepAbsorption: boolean;
    sameBarSweeps: boolean;
    plateauPivots: boolean;
    fvgQuality: boolean;
}
export interface DirectionalImpulseConfig {
    window?: number;
    decay?: number;
    wickWeight?: number;
    volWindow?: number;
}
export interface SignalFvgConfig {
    minAtr?: number;
    maxAtr?: number;
    minBodyFraction?: number;
}
export interface SignalPolicy extends SignalAblation {
    experimental: boolean;
    profile: SignalProfile;
    impulse: Required<DirectionalImpulseConfig>;
    fvg: Required<SignalFvgConfig>;
}

/** User-proposed experimental variant, NOT literal Pine parity. */
export const DIRECTIONAL_SIGNAL_THRESHOLDS = Object.freeze({
    displZ: 1.35, chochZ: 1.10, bodyFraction: .50,
    sweepMinPenAtr: .03, sweepMaxPenAtr: 1.35,
    sweepRangeScaleAtr: .65, sweepScore: 1,
    reclaimClose: .70, reclaimZ: 1,
});

/** Reject instead of clamping invalid/unknown settings. Shared by the calculator. */
export function resolveDirectionalImpulseConfig(config: DirectionalImpulseConfig = {}): Required<DirectionalImpulseConfig> {
    validateObject(config, ['window', 'decay', 'wickWeight', 'volWindow']);
    const result = { window: 50, decay: .8, wickWeight: .35, volWindow: 20, ...config };
    if (!Number.isInteger(result.window) || result.window < 2) throw new Error('Invalid impulse window');
    if (!Number.isInteger(result.volWindow) || result.volWindow < 1) throw new Error('Invalid impulse volWindow');
    if (!Number.isFinite(result.decay) || result.decay < 0 || result.decay >= 1) throw new Error('Invalid impulse decay');
    if (!Number.isFinite(result.wickWeight) || result.wickWeight < 0) throw new Error('Invalid impulse wickWeight');
    return result;
}

function validateObject(value: unknown, keys: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Signal config must be an object');
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown signal config key: ${key}`);
}

/** Resolve an opt-in policy without activating the legacy, previously inert Z window. */
export function resolveSignalPolicy(preset: Partial<SMCPreset>): SignalPolicy {
    if (preset.signal_profile !== undefined && preset.signal_profile !== 'legacy_v1' && preset.signal_profile !== 'directional_atr_v1') throw new Error('Unknown signal profile');
    const profile = preset.signal_profile ?? 'legacy_v1';
    const experimental = profile === 'directional_atr_v1';
    const switches: SignalAblation = {
        directionalMomentum: experimental, sweepAbsorption: experimental,
        sameBarSweeps: experimental, plateauPivots: experimental, fvgQuality: experimental,
    };
    if (preset.signal_ablation !== undefined) {
        if (!experimental) throw new Error('Ablations require experimental profile');
        const ablations = preset.signal_ablation;
        if (!ablations || typeof ablations !== 'object' || Array.isArray(ablations)) throw new Error('Ablations must be an object');
        for (const [key, value] of Object.entries(ablations)) {
            if (!Object.hasOwn(switches, key)) throw new Error(`Unknown ablation: ${key}`);
            if (typeof value !== 'boolean') throw new Error(`Ablation ${key} must be boolean`);
            switches[key as keyof SignalAblation] = value;
        }
    }
    const impulse = resolveDirectionalImpulseConfig(preset.signal_impulse);
    const fvg: Required<SignalFvgConfig> = { minAtr: .5, maxAtr: 3, minBodyFraction: .55 };
    if (preset.signal_fvg !== undefined) validateObject(preset.signal_fvg, ['minAtr', 'maxAtr', 'minBodyFraction']);
    if (experimental) {
        if (preset.signal_fvg?.minAtr === undefined && preset.fvg_min_atr !== undefined && preset.fvg_min_atr_factor !== undefined && preset.fvg_min_atr !== preset.fvg_min_atr_factor) throw new Error('Conflicting FVG min ATR aliases');
        fvg.minAtr = preset.signal_fvg?.minAtr ?? preset.fvg_min_atr_factor ?? preset.fvg_min_atr ?? .5;
        Object.assign(fvg, preset.signal_fvg);
    }
    if (!Number.isFinite(fvg.minAtr) || fvg.minAtr < 0 || !Number.isFinite(fvg.maxAtr) || fvg.maxAtr <= 0 || fvg.minAtr > fvg.maxAtr || !Number.isFinite(fvg.minBodyFraction) || fvg.minBodyFraction < 0 || fvg.minBodyFraction > 1) throw new Error('Invalid FVG thresholds');
    return { experimental, profile, ...switches, impulse, fvg };
}
