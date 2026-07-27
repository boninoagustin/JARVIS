import React, { useEffect, useState, useRef } from 'react';

interface SMCScannerProps {
    wsUrl: string;
    activeAsset: string;
}

export const SMCScanner: React.FC<SMCScannerProps> = ({ wsUrl, activeAsset }) => {
    const [scannerStates, setScannerStates] = useState<Record<string, any>>({});
    const [isConnected, setIsConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);

    const timeframes = ['M15', 'H1', 'H4', 'D1', 'W1'];
    const indicators = [
        { key: 'bias', label: 'Trend Bias' },
        { key: 'ob', label: 'Order Blocks (OB)' },
        { key: 'fvg', label: 'Fair Value Gaps (FVG)' },
        { key: 'ifvg', label: 'Inverse FVGs (IFVG)' },
        { key: 'bos', label: 'Break of Structure (BOS)' },
        { key: 'choch', label: 'Change of Character (CHoCH)' },
        { key: 'crt', label: 'Liquidity Sweeps (CRT)' },
        { key: 'div', label: 'Divergences (DIV)' }
    ];

    useEffect(() => {
        let isComponentMounted = true;
        let reconnectTimeout: any;

        const connectWs = () => {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!isComponentMounted) return;
                setIsConnected(true);
                // Subscribe to scanner events
                ws.send(JSON.stringify({ type: 'SCANNER_SUBSCRIBE' }));
            };

            ws.onmessage = (event) => {
                if (!isComponentMounted) return;
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'SCANNER_STATE' && data.states) {
                        setScannerStates(data.states);
                    }
                } catch (err) {
                    console.error('WS Parse Error', err);
                }
            };

            ws.onclose = () => {
                if (!isComponentMounted) return;
                setIsConnected(false);
                reconnectTimeout = setTimeout(connectWs, 3000);
            };
        };

        connectWs();

        return () => {
            isComponentMounted = false;
            clearTimeout(reconnectTimeout);
            if (wsRef.current) {
                wsRef.current.onclose = null;
                wsRef.current.close();
            }
        };
    }, [wsUrl]);

    // Helper para obtener el estado de la temporalidad para el activo activo
    const getStateForTf = (tf: string) => {
        const key = `${activeAsset}:${tf}`;
        return scannerStates[key];
    };

    const renderCell = (indicatorKey: string, state: any) => {
        if (!state) return <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>Loading...</span>;

        switch (indicatorKey) {
            case 'bias': {
                const isBullish = state.currentTrend === 'Bullish';
                const isBearish = state.currentTrend === 'Bearish';
                const trendColor = isBullish ? '#10b981' : isBearish ? '#ef4444' : 'var(--text-tertiary)';
                
                return (
                    <span style={{ 
                        padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold',
                        color: trendColor, backgroundColor: `${trendColor}20`, textTransform: 'uppercase'
                    }}>
                        {state.currentTrend || 'N/A'}
                    </span>
                );
            }
            case 'ob': {
                const hasOB = state.activeOBs && state.activeOBs.length > 0;
                return hasOB ? (
                    <span title={`${state.activeOBs.length} Order Blocks activos`} style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(59, 130, 246, 0.2)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)', fontWeight: 'bold'
                    }}>Activo ({state.activeOBs.length})</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'fvg': {
                const hasFVG = state.activeFVGs && state.activeFVGs.length > 0;
                return hasFVG ? (
                    <span title={`${state.activeFVGs.length} FVGs activos`} style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)', fontWeight: 'bold'
                    }}>Activo ({state.activeFVGs.length})</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'ifvg': {
                // IFVGs generally checked via fvg.is_ifvg if supported
                const hasIFVG = state.activeFVGs?.some((fvg: any) => fvg.is_ifvg);
                return hasIFVG ? (
                    <span style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(168, 85, 247, 0.2)', color: '#a855f7', border: '1px solid rgba(168, 85, 247, 0.3)', fontWeight: 'bold'
                    }}>Activo</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'bos': {
                return state.lastBOS ? (
                    <span style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)', fontWeight: 'bold'
                    }}>{state.lastBOS.type} BOS</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'choch': {
                return state.lastCHoCH ? (
                    <span style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(139, 92, 246, 0.2)', color: '#8b5cf6', border: '1px solid rgba(139, 92, 246, 0.3)', fontWeight: 'bold'
                    }}>{state.lastCHoCH.type} CHoCH</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'crt': {
                return state.lastSweep ? (
                    <span title={`Sweep: ${state.lastSweep.type}`} style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(236, 72, 153, 0.2)', color: '#ec4899', border: '1px solid rgba(236, 72, 153, 0.3)', fontWeight: 'bold'
                    }}>{state.lastSweep.direction} Sweep</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            case 'div': {
                return state.lastDivergence ? (
                    <span title={`${state.lastDivergence.type} Divergence`} style={{ 
                        padding: '2px 8px', borderRadius: '4px', background: 'rgba(14, 165, 233, 0.2)', color: '#0ea5e9', border: '1px solid rgba(14, 165, 233, 0.3)', fontWeight: 'bold'
                    }}>{state.lastDivergence.direction} ({state.lastDivergence.type})</span>
                ) : <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
            }
            default:
                return null;
        }
    };

    return (
        <div style={{
            background: 'var(--bg-secondary)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            width: '100%'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '18px' }}>📡</span>
                    Scanner Data: <span style={{ color: 'var(--accent-gold)' }}>{activeAsset}</span>
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: isConnected ? '#10b981' : '#ef4444',
                        boxShadow: `0 0 8px ${isConnected ? '#10b981' : '#ef4444'}`
                    }} />
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {isConnected ? 'LIVE' : 'DISCONNECTED'}
                    </span>
                </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center', fontSize: '13px' }}>
                    <thead>
                        <tr>
                            <th style={{ padding: '10px', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)', textAlign: 'left' }}>SMC Structure</th>
                            {timeframes.map(tf => (
                                <th key={tf} style={{ padding: '10px', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)' }}>{tf}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {indicators.map(indicator => (
                            <tr key={indicator.key} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                                <td style={{ padding: '10px', color: 'var(--text-primary)', fontWeight: '500', textAlign: 'left' }}>
                                    {indicator.label}
                                </td>
                                {timeframes.map(tf => {
                                    const state = getStateForTf(tf);
                                    return (
                                        <td key={tf} style={{ padding: '10px' }}>
                                            {renderCell(indicator.key, state)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
