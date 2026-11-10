/** Pure browser/Node contract for positive ML gate deployment; no I/O or activation.
 *
 * v1/legacy sweeps are diagnostic ONLY. v2 separates chronological threshold
 * selection from a later, untouched validation interval. All dates are UTC epoch
 * milliseconds. Model identity is SHA-256 of the RAW deployed model JSON bytes,
 * not a reserialized object or the threshold-modified sweep copy. evidenceId is
 * the producer's SHA-256 evidence identifier (not a signature/attestation).
 *
 * configFingerprint deliberately is canonical JSON, NOT a cryptographic digest.
 * It binds every stored configuration field, including trading/risk parameters,
 * except the exact root-level control/audit fields listed below. No Node crypto,
 * browser globals, Firestore dependencies, or implicit Date.now in fingerprinting.
 */
export const ML_GATE_SCHEMA_VERSION = 2;
export const ML_GATE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const ML_GATE_MIN_SAMPLE = 30;
export const ML_CONFIG_EXCLUDED_FIELDS = Object.freeze([
    'mlGateEnabled', 'mlGateDeployment',
    'updatedAt', 'updatedBy', 'lastModifiedAt', 'lastModifiedBy',
] as const);
const excluded = new Set<string>(ML_CONFIG_EXCLUDED_FIELDS);
const sha256 = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;
export interface MLGateMetrics {
    n: number; wr: number; pf: number; pnlR: number; mdd: number;
}
export interface MLGateEvaluationV2 {
    schemaVersion: 2;
    evidenceId: string;
    ticker: string;
    evaluatedAt: number;
    configFingerprint: string;
    model: { sha256: string; availableAt: number; trainingCutoffAt: number };
    selection: {
        method: 'chronological-holdout'; selectedThreshold: number;
        from: number; to: number;
    };
    validation: {
        independent: true; threshold: number; from: number; to: number;
        baseline: MLGateMetrics; gate: MLGateMetrics;
    };
}
export interface MLGateDeployment {
    schemaVersion: 2;
    modelSha256: string;
    threshold: number;
    evidenceId: string;
    configFingerprint: string;
    evaluatedAt: number;
}
export interface MLGateEvaluationContext {
    ticker: string;
    config: unknown;
    now?: number;
    /** Optional independent identity read from currently available raw model bytes. */
    modelSha256?: string;
    /** Disabling retains evidence checks but does not require a positive delta. */
    intent?: 'enable' | 'disable';
}
export interface MLGateReadiness {
    ok: boolean;
    reasons: string[];
    /** Plain Spanish, ready for UI; empty on success. */
    reason: string;
    delta?: number;
    deployment?: MLGateDeployment;
}
function record(value: unknown): value is JsonRecord {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
function timestamp(value: unknown): value is number {
    return finite(value) && Number.isSafeInteger(value) && value > 0;
}
function threshold(value: unknown): value is number {
    return finite(value) && value >= 0 && value <= 1;
}
/** Strict canonical JSON: rejects undefined, holes, NaN, dates, cycles, etc.
 * Missing/defaulted fields remain distinct: callers must supply the same frozen
 * stored config at evaluation and deployment, NOT different effective subsets.
 */
export function configFingerprint(config: unknown): string {
    if (!record(config)) throw new TypeError('La configuración debe ser un objeto JSON.');
    const ancestors = new Set<object>();
    function canonical(value: unknown, root = false): string {
        if (value === null) return 'null';
        if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
        if (finite(value)) return JSON.stringify(value);
        if (typeof value !== 'object' || value === null || ancestors.has(value)) {
            throw new TypeError('Configuración no JSON, no finita o circular.');
        }
        ancestors.add(value);
        try {
            if (Array.isArray(value)) {
                const parts: string[] = [];
                for (let i = 0; i < value.length; i++) {
                    if (!Object.hasOwn(value, i)) throw new TypeError('Array disperso no admitido.');
                    parts.push(canonical(value[i]));
                }
                return `[${parts.join(',')}]`;
            }
            if (!record(value) || Object.getOwnPropertySymbols(value).length) {
                throw new TypeError('Solo se admiten objetos JSON sin símbolos.');
            }
            const keys = Object.keys(value).filter(key => !root || !excluded.has(key)).sort();
            return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
        } finally { ancestors.delete(value); }
    }
    return canonical(config, true);
}
export const mlConfigFingerprint = configFingerprint;

function validMetrics(value: unknown): value is MLGateMetrics {
    if (!record(value)) return false;
    return finite(value.n) && Number.isSafeInteger(value.n) && value.n >= ML_GATE_MIN_SAMPLE
        && finite(value.wr) && value.wr >= 0 && value.wr <= 100
        && finite(value.pf) && value.pf >= 0
        && finite(value.pnlR) && finite(value.mdd) && value.mdd >= 0;
}
/** Fail closed. A positive stored delta, legacy bestGate, boolean enabled flag,
 * or threshold selected on the validation period can never authorize deployment.
 * This checks certificate consistency, not authenticity of producer assertions.
 */
export function validateMLGateEvaluation(
    evidence: unknown, context: MLGateEvaluationContext,
): MLGateReadiness {
    const reasons: string[] = [];
    const fail = (reason: string) => { reasons.push(reason); };
    const done = (extra: Partial<MLGateReadiness> = {}): MLGateReadiness => ({
        ok: reasons.length === 0, reasons, reason: reasons.join(' '), ...extra,
    });
    if (!record(evidence) || evidence.schemaVersion !== ML_GATE_SCHEMA_VERSION) {
        fail('Se requiere evidencia ML v2; el sweep legado no autoriza activar.');
        return done();
    }
    if (typeof context.ticker !== 'string' || !context.ticker.trim()
        || evidence.ticker !== context.ticker) fail('La evidencia no corresponde al activo exacto.');
    if (typeof evidence.evidenceId !== 'string' || !sha256.test(evidence.evidenceId)) {
        fail('Falta identidad SHA-256 de la evidencia.');
    }
    const now = context.now === undefined ? Date.now() : context.now;
    if (!timestamp(now) || !timestamp(evidence.evaluatedAt) || evidence.evaluatedAt > now
        || now - evidence.evaluatedAt > ML_GATE_MAX_AGE_MS) {
        fail('Evidencia vencida, futura o sin fecha válida (máximo 8 días).');
    }
    try {
        if (typeof evidence.configFingerprint !== 'string'
            || evidence.configFingerprint !== configFingerprint(context.config)) {
            fail('La configuración cambió desde la evaluación.');
        }
    } catch { fail('La configuración no tiene identidad JSON válida.'); }
    const model = record(evidence.model) ? evidence.model : {};
    if (typeof model.sha256 !== 'string' || !sha256.test(model.sha256)) {
        fail('Falta identidad SHA-256 del modelo exacto.');
    }
    if (context.modelSha256 !== undefined && (typeof context.modelSha256 !== 'string'
        || !sha256.test(context.modelSha256) || context.modelSha256 !== model.sha256)) {
        fail('El modelo disponible no coincide con el modelo evaluado.');
    }
    const selection = record(evidence.selection) ? evidence.selection : {};
    const validation = record(evidence.validation) ? evidence.validation : {};
    if (selection.method !== 'chronological-holdout' || validation.independent !== true) {
        fail('Se requiere selección separada de validación independiente posterior.');
    }
    if (!threshold(selection.selectedThreshold) || !threshold(validation.threshold)
        || selection.selectedThreshold !== validation.threshold) {
        fail('El umbral validado debe ser exactamente el umbral seleccionado.');
    }
    if (!timestamp(model.trainingCutoffAt) || !timestamp(model.availableAt)
        || !timestamp(selection.from) || !timestamp(selection.to)
        || !timestamp(validation.from) || !timestamp(validation.to)
        || !timestamp(evidence.evaluatedAt)
        || !(model.trainingCutoffAt <= model.availableAt
            && model.availableAt <= selection.from && selection.from < selection.to
            && selection.to < validation.from && validation.from < validation.to
            && validation.to <= evidence.evaluatedAt)) {
        fail('Fechas inválidas: entrenamiento → modelo disponible → selección → validación sin solapamiento → evaluación.');
    }
    if (!validMetrics(validation.baseline) || !validMetrics(validation.gate)) {
        fail('Muestra insuficiente o métricas inválidas: mínimo 30 trades finitos en baseline Y gate.');
        return done();
    }
    const delta = validation.gate.pnlR - validation.baseline.pnlR;
    if (!finite(delta)) fail('El delta de validación no es finito.');
    else if (context.intent !== 'disable' && delta <= 0) {
        fail('La validación independiente no mejora el PnL (Δ debe ser positivo).');
    }
    if (reasons.length || context.intent === 'disable') return done({ delta });
    // Narrowed by all checks above; no deployment is ever returned on a failure.
    return done({ delta, deployment: {
        schemaVersion: 2,
        modelSha256: model.sha256 as string,
        threshold: validation.threshold as number,
        evidenceId: evidence.evidenceId as string,
        configFingerprint: evidence.configFingerprint as string,
        evaluatedAt: evidence.evaluatedAt as number,
    } });
}
