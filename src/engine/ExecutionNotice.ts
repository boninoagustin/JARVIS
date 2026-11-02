// Explicit local preflight allowlist: unknown/broker codes must remain errors.
const SAFE_REASONS: Readonly<Record<string, string>> = {
    BLOCKED_ACCOUNT_STATE: 'No se pudo verificar el estado de posiciones de la cuenta.',
    BLOCKED_METADATA: 'No se pudieron verificar las unidades o los datos del instrumento.',
    BLOCKED_QUOTE: 'La cotización bilateral está ausente, vencida o no es válida.',
    BLOCKED_STOPS: 'El SL no despeja el spread vivo o está del lado incorrecto.',
    BLOCKED_SLIPPAGE: 'No se pudo garantizar el límite de deslizamiento autorizado.',
    BLOCKED_CURRENCY: 'La moneda de la cuenta no está verificada.',
    BLOCKED_CONVERSION: 'No hay una conversión de moneda vigente y verificable.',
    BLOCKED_COST: 'No se pudieron verificar los costes de la orden.',
    BLOCKED_RISK: 'No se pudo verificar el riesgo de la entrada.',
    BLOCKED_MIN_VOLUME: 'El volumen mínimo excede el presupuesto de riesgo; no se aumentó el tamaño.',
    BLOCKED_DISPATCH: 'El envío no cumple la autorización o las condiciones de seguridad.',
    BLOCKED_UNBOUNDED_MARKET: 'Se requiere una orden con límite de deslizamiento nativo.',
    BLOCKED_LEVELS: 'Los niveles o la dirección de la entrada no son válidos.',
    BLOCKED_TARGETS: 'Los objetivos TP1/TP2 no cumplen la dirección o el orden requerido.',
    BLOCKED_RR: 'La entrada no cumple la relación riesgo/beneficio mínima.',
    BLOCKED_SESSION: 'La sesión de entradas está deshabilitada.',
    BLOCKED_KILLSWITCH: 'Está activa una protección de la cuenta o del activo.',
    BLOCKED_EXECUTION_INCIDENT: 'Hay una ejecución o contabilidad pendiente de reconciliación.',
    BLOCKED_RACHA: 'Está activa la protección por racha de pérdidas.',
    BLOCKED_VIX: 'Está activa la protección por volatilidad.',
    BLOCKED_SPREAD: 'El spread está fuera de las condiciones permitidas.',
    BLOCKED_ROLLOVER: 'Está activa la protección de entradas durante el rollover.',
    BLOCKED_GLOBAL: 'Está activo el límite de riesgo global.',
    BLOCKED_ASSET: 'Está activo el límite de riesgo del activo.',
};

/** Presentation only. Call exclusively after the caller has verified no fill. */
export function buildExecutionNotice(error: string | undefined, mode: 'AUTO' | 'MANUAL') {
    // Error details are HTML text, never markup. Leave the raw audit value alone.
    const detail = (error ?? 'Sin detalle del error.').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Local admission deadline, not a transport timeout after submission.
    if (error === 'BLOCKED_DISPATCH: admission wait timed out before submission') return {
        headingHtml: '⚠️ <b>FALLO TÉCNICO DE ENVÍO</b>',
        reasonHtml: `Se agotó el tiempo de espera para habilitar el envío. La orden no se envió al broker.\nDetalle: ${detail}`,
        buttonText: '⚠️ FALLO TÉCNICO DE ENVÍO',
    };
    const code = error?.match(/^(BLOCKED_[A-Z_]+)(?::|$)/)?.[1];
    const legacySpreadStop = /^SL \([^\n)]+\) no despeja el spread vivo \(bid=[^\n,]+, ask=[^\n)]+\) para (?:BUY|SELL)\. Trade abortado antes del broker\.$/.test(error ?? '');
    const reason = (code && Object.hasOwn(SAFE_REASONS, code) ? SAFE_REASONS[code] : undefined)
        ?? (legacySpreadStop ? SAFE_REASONS.BLOCKED_STOPS : undefined);
    return {
        headingHtml: reason ? '🛡️ <b>ENTRADA DESCARTADA POR SEGURIDAD</b>'
            : mode === 'AUTO' ? '❌ <b>ERROR AUTO-EJECUCIÓN</b>' : '❌ <b>ERROR DE EJECUCIÓN</b>',
        reasonHtml: reason ? `Entrada descartada de forma segura. ${reason}\nDetalle: ${detail}` : detail,
        buttonText: reason ? '🛡️ ENTRADA DESCARTADA' : '❌ ERROR DE EJECUCIÓN',
    };
}
