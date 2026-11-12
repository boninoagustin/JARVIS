import { useEffect, useState } from 'react';
import { currentActiveAssessment, currentCandidateForwardComparison, monitorRecommendation, type MonitorRow, type MonitorWindow, type MonitorReference } from '../services/mlGateMonitoring';

function WindowMetrics({ title, window: w }: { title: string; window: MonitorWindow }) {
    return <div style={{ marginTop: 8 }}>
        <strong>{title}</strong>
        <div style={{ color: '#888', fontSize: '.72rem' }}>{new Date(w.fromMs).toLocaleString()} → {new Date(w.toMs).toLocaleString()} (fin exclusivo)</div>
        <table style={{ width: '100%', fontSize: '.8rem', textAlign: 'left' }}>
            <thead><tr><th></th><th>Trades</th><th>PnL</th><th>DD</th></tr></thead>
            <tbody><tr><td>Sin gate</td><td>{w.baseline.n}</td><td>{w.baseline.pnlR.toFixed(2)}R</td><td>{w.baseline.mdd.toFixed(2)}R</td></tr>
                <tr><td>Modelo configurado</td><td>{w.active.n}</td><td>{w.active.pnlR.toFixed(2)}R</td><td>{w.active.mdd.toFixed(2)}R</td></tr></tbody>
        </table>
        <div style={{ color: w.deltaR < 0 ? '#ff7777' : '#aaa' }}>Contribución: {w.deltaR > 0 ? '+' : ''}{w.deltaR.toFixed(2)}R · {w.status === 'sufficient' ? 'Muestra suficiente' : 'Datos insuficientes (mínimo 30 por brazo)'}</div>
    </div>;
}
export default function MLGateMonitorPanel({ configs, candidates, references }: {
    configs: Record<string, any>; candidates: Record<string, { candidate?: { sha256: string } }>;
    references: Record<string, MonitorReference>;
}) {
    const [rows, setRows] = useState<Record<string, MonitorRow>>({});
    const [updatedAt, setUpdatedAt] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const api = `http://${window.location.hostname}:8000/api/ml-gate/monitor`;
    const load = async () => {
        try {
            const response = await fetch(`${api}/status`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (!body.assets || typeof body.assets !== 'object') throw new Error('Respuesta inválida');
            setRows(body.assets); setUpdatedAt(body.updatedAt ?? null); setRunning(body.refreshing === true); setError(null);
        } catch (e: any) { setRows({}); setError(`Seguimiento no disponible: ${e.message}`); setRunning(false); }
    };
    useEffect(() => { void load(); const id = window.setInterval(() => { void load(); }, 60000); return () => window.clearInterval(id); }, []);
    const refresh = async () => {
        setRequesting(true);
        try {
            const response = await fetch(`${api}/refresh`, { method: 'POST', headers: { 'X-Jarvis-ML': 'recalibrate' } });
            const body = await response.json();
            if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'No se pudo solicitar la revisión');
            await load();
        } catch (e: any) { setError(e.message); } finally { setRequesting(false); }
    };
    const tickers = [...new Set([...Object.keys(configs), ...Object.keys(rows)])]
        .filter(t => configs[t]?.mlGateEnabled === true || (rows[t] && !['INACTIVE', 'NOT_TRADE'].includes(rows[t].state)))
        .sort();
    return <section className="premium-card" style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>SEGUIMIENTO DEL GATE ML ACTIVO</h3>
            <button className="btn" disabled={requesting || running} onClick={() => void refresh()}>{requesting || running ? 'Revisando…' : 'Revisar seguimiento'}</button>
        </div>
        <p style={{ color: '#888', fontSize: '.78rem' }}>Modelo y umbral fijos frente a operar sin gate, en replay posterior al inicio del seguimiento. Revisión semanal: lunes 09:00 UTC. Ningún apagado, reemplazo ni orden automática.</p>
        {updatedAt && <div style={{ color: '#777', fontSize: '.72rem' }}>Estado actualizado: {new Date(updatedAt).toLocaleString()}</div>}
        {error && <p role="alert" style={{ color: '#eab308' }}>{error}</p>}
        {!error && tickers.length === 0 && <p style={{ color: '#aaa' }}>No hay gates ML activados. Al solicitar una activación manual se registrará su identidad y configuración para iniciar el seguimiento.</p>}
        {tickers.map(t => {
            const row = rows[t], a = currentActiveAssessment(row, t, configs[t], Date.now(), references[t]);
            const cc = row?.candidateComparison;
            const candidateAligned = currentCandidateForwardComparison(row, a, candidates[t]?.candidate?.sha256);
            return <article key={t} style={{ borderTop: '1px solid #333', paddingTop: 12, marginTop: 12 }}>
                <strong>{t} · {row ? monitorRecommendation(row, a) : 'Esperando primera revisión'}</strong>
                <div style={{ color: '#aaa', fontSize: '.75rem' }}>Modelo: {row?.modelSha256?.slice(0, 12) ?? 'sin identidad verificada'} · umbral {row?.threshold ?? '—'} · época {row?.epochId?.slice(0, 10) ?? '—'}</div>
                <div style={{ color: '#888', fontSize: '.72rem' }}>Activación solicitada: {row?.requestedAtMs ? new Date(row.requestedAtMs).toLocaleString() : 'desconocida'} · seguimiento desde {row?.fromMs ? new Date(row.fromMs).toLocaleString() : 'pendiente'}</div>
                <div style={{ color: '#888', fontSize: '.72rem' }}>Recepción por el bot: no confirmada. Esto evalúa el modelo configurado, no demuestra su aplicación efectiva en cada orden.</div>
                <div style={{ color: '#eab308' }}>{row?.reason ?? 'Falta registrar o verificar esta activación.'}</div>
                {a ? <>
                    <WindowMetrics title="Acumulado del seguimiento" window={a.windows.cumulative} />
                    <WindowMetrics title="Últimos 28 días disponibles" window={a.windows.recent} />
                    <div style={{ color: '#888', fontSize: '.72rem' }}>Último dato: {a.dataThroughMs ? new Date(a.dataThroughMs).toLocaleString() : '—'} · Evaluado: {new Date(a.evaluatedAt).toLocaleString()} · Confirmaciones semanales: {row.confirmationCount ?? 0}/2</div>
                </> : <div style={{ color: '#888' }}>Sin métricas vigentes verificables. No se muestran resultados de otra configuración, de antes del seguimiento o de datos vencidos.</div>}
                <div style={{ marginTop: 8, fontSize: '.78rem' }}><b>Candidato frente a activo y sin gate:</b>{' '}
                    {candidateAligned ? <>
                        <div>{new Date(cc!.fromMs!).toLocaleString()} → {new Date(cc!.toMs!).toLocaleString()}</div>
                        <div>Sin gate {cc!.baseline!.pnlR.toFixed(2)}R · activo {cc!.active!.pnlR.toFixed(2)}R · candidato {cc!.candidate!.pnlR.toFixed(2)}R</div>
                        <div>{cc!.reason} No reemplaza automáticamente el modelo activo.</div>
                    </> : cc?.reason ?? 'Se requiere un candidato identificado y datos posteriores a su elección, sobre un período común. No se mezclan PnL históricos de calibración.'}
                </div>
            </article>;
        })}
        <details style={{ fontSize: '.75rem', color: '#888', marginTop: 12 }}>
            <summary>Reglas de recomendación (v1, fijadas antes de evaluar)</summary>
            <ul>
                <li>Mantener: contribución positiva en ambas ventanas y DD activo ≤ 1,25 × DD sin gate + 1R.</li>
                <li>Recalibrar: contribución ≤ −2R en ambas ventanas, confirmada en dos revisiones semanales.</li>
                <li>Recomendar apagar: contribución ≤ −5R y DD activo mayor que DD sin gate + 2R en ambas ventanas, con dos confirmaciones.</li>
                <li>Las confirmaciones deben estar separadas por ≥7 días, con nuevos datos y nuevas operaciones cerradas en ambos brazos. No se cuentan ventanas superpuestas como confirmaciones independientes.</li>
                <li>Sin al menos 30 operaciones por brazo en cada ventana, o con datos vencidos, no hay recomendación de rendimiento.</li>
            </ul>
        </details>
        <p style={{ color: '#777', fontSize: '.72rem', marginBottom: 0 }}>Reglas predefinidas: mínimo 30 operaciones por brazo en ambas ventanas; datos de hasta 7 días. Una alerta de deterioro requiere dos revisiones separadas por al menos 7 días y nuevas operaciones cerradas; refrescar varias veces no confirma una alerta. Las simulaciones no envían órdenes.</p>
    </section>;
}
