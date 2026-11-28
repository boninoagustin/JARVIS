import { isFreshReport } from '../services/periodicOptPresentation';

export type ReportCycleKind = 'historical' | 'evaluated' | 'skipped' | 'partial_or_error';

export interface ReportCycleDescriptor {
    kind: ReportCycleKind;
    badge: string;
    color: string;
    detail: string;
}

export function describeReportCycleState(
    report: {
        ticker: string;
        timestamp?: unknown;
        status?: string;
        selection_outcome?: string;
        deployment_error?: string;
        cycle_week?: string;
    },
    activeTickers: readonly string[],
    now = Date.now(),
): ReportCycleDescriptor {
    const inRoster = activeTickers.includes(report.ticker);
    const fresh = isFreshReport(report.timestamp, now);
    if (!inRoster || !fresh) {
        return {
            kind: 'historical',
            badge: 'HISTÓRICO / VENCIDO',
            color: '#f59e0b',
            detail: !inRoster
                ? 'Fuera del universo activo actual; registro histórico informativo.'
                : 'Antigüedad mayor a 8 días o fecha inválida; pendiente de publicación del ciclo vigente.',
        };
    }

    const status = String(report.status || '');
    const outcome = String(report.selection_outcome || '');
    const isErrorOrPartial =
        status === 'ERROR' ||
        status === 'REFRESH_ERROR' ||
        outcome === 'failed' ||
        outcome === 'evaluating' ||
        Boolean(report.deployment_error) ||
        (status.startsWith('HOLD_') && status !== 'HOLD_MC' && status !== 'HOLD_DSR');

    if (isErrorOrPartial) {
        return {
            kind: 'partial_or_error',
            badge: outcome === 'evaluating' ? 'RESULTADO PARCIAL' : 'ERROR EN EVALUACIÓN',
            color: '#ef4444',
            detail: report.deployment_error
                ? 'Error al confirmar despliegue; revisar estado de aplicación.'
                : 'La evaluación de este activo falló o quedó incompleta en la corrida.',
        };
    }

    if (outcome === 'skipped') {
        return {
            kind: 'skipped',
            badge: 'SIN RE-OPTIMIZAR (DATOS IGUALES)',
            color: '#94a3b8',
            detail: 'Sin velas/operaciones/configuración nuevas desde la última selección certificada.',
        };
    }

    return {
        kind: 'evaluated',
        badge: report.cycle_week ? `EVALUACIÓN NUEVA (${report.cycle_week})` : 'EVALUACIÓN NUEVA',
        color: '#38bdf8',
        detail: 'Evaluado con snapshot congelado en el ciclo vigente.',
    };
}
