import type { ImpulseLeg, MacroTimeframe, RadarState } from './Types.js';
import { evaluateMacroStretching, TF_RANK } from './AlphaModel.js';

/** Register native identity without sharing execution-leg lifecycle state. */
export function recordMacroImpulse(state: RadarState, tf: MacroTimeframe, leg: ImpulseLeg): void {
    if (!state.macroImpulses) {
        state.macroImpulses = {};
        // Preserve only explicit native identities on restart; unknown legacy TF stays unknown.
        for (const dir of ['BUY', 'SELL'] as const) {
            const legacy = dir === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
            const nativeTf = legacy?.macroTf;
            if (legacy?.dir === dir && nativeTf && ['15', '60', '240', 'D'].includes(nativeTf)) {
                (state.macroImpulses[nativeTf] ??= {})[dir] = legacy;
            }
        }
    }
    (state.macroImpulses[tf] ??= {})[leg.dir] = { ...leg, macroTf: tf };
    state.activeMacroImpulseBuy = selectMacroImpulse(state, 'BUY', '5', leg.createdAt);
    state.activeMacroImpulseSell = selectMacroImpulse(state, 'SELL', '5', leg.createdAt);
}

/** Read-only selection: only native identities strictly above the executor qualify. */
export function selectMacroImpulse(state: RadarState, dir: 'BUY' | 'SELL', executionTf: string, nowMs: number): ImpulseLeg | null {
    const rank = TF_RANK[executionTf];
    if (!rank) return null;
    const legacy = state.macroImpulses ? null : dir === 'BUY' ? state.activeMacroImpulseBuy : state.activeMacroImpulseSell;
    for (const tf of ['D', '240', '60', '15'] as const) {
        const leg = state.macroImpulses ? state.macroImpulses[tf]?.[dir] : legacy?.macroTf === tf ? legacy : null;
        if (TF_RANK[tf]! <= rank || !leg || leg.dir !== dir || leg.macroTf !== tf || leg.createdAt > nowMs) continue;
        // Reuse the existing age/origin contract without stretching or mutating on reads.
        if (evaluateMacroStretching({ ...leg }, Math.max(leg.origin, leg.extreme), Math.min(leg.origin, leg.extreme), nowMs)) return leg;
    }
    return null;
}

/** Apply the existing lifecycle independently to every native TF/direction slot. */
export function updateMacroImpulses(state: RadarState, highPrice: number, lowPrice: number, nowMs: number,
    rolloverFreeze?: Parameters<typeof evaluateMacroStretching>[4], observationInterval?: Parameters<typeof evaluateMacroStretching>[5]): void {
    if (state.macroImpulses) {
        for (const tf of ['15', '60', '240', 'D'] as const) {
            const byDirection = state.macroImpulses[tf];
            if (!byDirection) continue;
            for (const dir of ['BUY', 'SELL'] as const) {
                const leg = byDirection[dir];
                if (leg && leg.createdAt <= nowMs) byDirection[dir] = evaluateMacroStretching(leg, highPrice, lowPrice, nowMs, rolloverFreeze, observationInterval);
            }
        }
        // Compatibility mirrors expose the highest context available for the M5 executor.
        state.activeMacroImpulseBuy = selectMacroImpulse(state, 'BUY', '5', nowMs);
        state.activeMacroImpulseSell = selectMacroImpulse(state, 'SELL', '5', nowMs);
    } else {
        if (!(state.activeMacroImpulseBuy && state.activeMacroImpulseBuy.createdAt > nowMs)) {
            state.activeMacroImpulseBuy = evaluateMacroStretching(state.activeMacroImpulseBuy, highPrice, lowPrice, nowMs, rolloverFreeze, observationInterval);
        }
        if (!(state.activeMacroImpulseSell && state.activeMacroImpulseSell.createdAt > nowMs)) {
            state.activeMacroImpulseSell = evaluateMacroStretching(state.activeMacroImpulseSell, highPrice, lowPrice, nowMs, rolloverFreeze, observationInterval);
        }
    }
}
