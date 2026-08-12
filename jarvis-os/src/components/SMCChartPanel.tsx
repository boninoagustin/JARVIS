import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickSeries } from 'lightweight-charts';
import { TrendingUp } from 'lucide-react';
import { BoxPrimitive } from './BoxPrimitive';
import { SMCScanner } from './SMCScanner';

interface SMCState {
    pivotsHigh: any[];
    pivotsLow: any[];
    activeOBs: any[];
    activeFVGs: any[];
    currentTrend: string;
}

export default function SMCChartPanel() {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const lastCandleTimeRef = useRef<number>(0);

    const [ticker, setTicker] = useState('EURUSD');
    const [period, setPeriod] = useState('M15');
    const [smcState, setSmcState] = useState<SMCState | null>(null);
    const [isConnected, setIsConnected] = useState(false);

    // Initialize chart
    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: 'solid', color: 'transparent' } as any,
                textColor: 'rgba(255, 255, 255, 0.9)',
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
            },
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
            },
            crosshair: {
                mode: 0,
            },
            autoSize: true,
        });

        const candleSeries = (chart as any).addSeries(CandlestickSeries, {
            upColor: '#10b981',
            downColor: '#ef4444',
            borderVisible: false,
            wickUpColor: '#10b981',
            wickDownColor: '#ef4444',
        });

        chartRef.current = chart;
        candleSeriesRef.current = candleSeries;

        return () => {
            chart.remove();
        };
    }, []);

    // Actualizar precisión del precio según el activo
    useEffect(() => {
        if (!candleSeriesRef.current) return;
        
        const getPrecision = (t: string) => {
            if (t.includes('JPY') || t.includes('XAU')) return 3;
            if (t.includes('US500') || t.includes('US30') || t.includes('USOIL') || t.includes('BTC')) return 2;
            return 5; // Por defecto 5 decimales para Forex (EURUSD, GBPUSD, etc.)
        };
        
        const precision = getPrecision(ticker);
        const minMove = 1 / Math.pow(10, precision);
        
        candleSeriesRef.current.applyOptions({
            priceFormat: {
                type: 'price',
                precision: precision,
                minMove: minMove,
            }
        });
    }, [ticker]);

    // Connect to WS
    useEffect(() => {
        let unsubscribe: (() => void) | undefined;
        
        import('../services/wsClient').then(({ wsClient }) => {
            wsClient.connect('ws://169.58.163.132:8081');
            wsClient.send({ type: 'SUBSCRIBE', ticker: `${ticker}:${period}` });
            setIsConnected(true);

            unsubscribe = wsClient.subscribe((data: any) => {
                if (data.ticker !== `${ticker}:${period}`) return;

                if (data.type === 'HISTORY' && candleSeriesRef.current) {
                    const offsetCandles = data.candles.map((c: any) => ({
                        ...c,
                        time: c.time
                    }));
                    candleSeriesRef.current.setData(offsetCandles);
                    if (offsetCandles.length > 0) {
                        lastCandleTimeRef.current = offsetCandles[offsetCandles.length - 1].time;
                    }
                } else if (data.type === 'NEW_CANDLE' && candleSeriesRef.current) {
                    const c = data.candle;
                    const t = Math.floor(c.timestamp / 1000) as any;

                    // Evitar crasheo si llega un tick de una vela anterior al historial cargado
                    if (lastCandleTimeRef.current && t < lastCandleTimeRef.current) {
                        return;
                    }

                    candleSeriesRef.current.update({
                        time: t,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                    });
                    lastCandleTimeRef.current = t;
                } else if (data.type === 'SMC_STATE' && data.state) {
                    // Estado completo del motor (lo emite broadcastState en cada vela)
                    setSmcState(data.state);
                    drawSMCZOnes(data.state, lastCandleTimeRef.current);
                }
            });
        });

        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [ticker, period]);

    const activeBoxesRef = useRef<BoxPrimitive[]>([]);

    const drawSMCZOnes = (state: SMCState, lastCandleTime: number) => {
        if (!state) return;
        
        // Remove previous primitives
        activeBoxesRef.current.forEach(box => {
            candleSeriesRef.current?.detachPrimitive(box);
        });
        activeBoxesRef.current = [];

        // Draw OBs
        (state.activeOBs || []).forEach(ob => {
            const color = ob.direction === 'Bullish' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            const box = new BoxPrimitive({
                time1: Math.floor(ob.timestamp / 1000) as any,
                price1: ob.top,
                time2: lastCandleTime as any, // Extendemos hasta la vela actual EXACTA
                price2: ob.bottom,
                color
            });
            if (candleSeriesRef.current) {
                candleSeriesRef.current.attachPrimitive(box);
                activeBoxesRef.current.push(box);
            }
        });

        // Draw FVGs
        (state.activeFVGs || []).forEach(fvg => {
            const color = fvg.direction === 'Bullish' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(245, 158, 11, 0.2)';
            const box = new BoxPrimitive({
                time1: Math.floor(fvg.timestamp / 1000) as any,
                price1: fvg.top,
                time2: lastCandleTime as any,
                price2: fvg.bottom,
                color
            });
            if (candleSeriesRef.current) {
                candleSeriesRef.current.attachPrimitive(box);
                activeBoxesRef.current.push(box);
            }
        });
    };

    return (
        <div className="panel" style={{ height: 'calc(100vh - 40px)', display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingRight: '8px' }}>
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <TrendingUp size={20} color="var(--accent-gold)" />
                    <h2 className="panel-title">SMC Live Chart</h2>
                    
                    <select className="input" value={ticker} onChange={e => setTicker(e.target.value)} style={{ width: '120px', marginLeft: '16px' }}>
                        <option value="EURUSD">EURUSD</option>
                        <option value="GBPUSD">GBPUSD</option>
                        <option value="AUDCAD">AUDCAD</option>
                        <option value="US500">US500</option>
                        <option value="XAUUSD">XAUUSD</option>
                        <option value="USDJPY">USDJPY</option>
                        <option value="USDCAD">USDCAD</option>
                        <option value="NZDUSD">NZDUSD</option>
                        <option value="USOIL">USOIL</option>
                    </select>

                    <select className="input" value={period} onChange={e => setPeriod(e.target.value)} style={{ width: '80px' }}>
                        <option value="M15">M15</option>
                        <option value="H1">H1</option>
                        <option value="H4">H4</option>
                        <option value="D1">D1</option>
                        <option value="W1">W1</option>
                    </select>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <div className="status-badge" style={{ backgroundColor: isConnected ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isConnected ? '#10b981' : '#ef4444' }}>
                        {isConnected ? 'LIVE WS' : 'DISCONNECTED'}
                    </div>
                </div>
            </div>

            <div style={{ position: 'relative', flex: '1 1 0', minHeight: 0, marginTop: '16px', border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                
                {/* Floating SMC Status Panel */}
                <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, backgroundColor: 'rgba(10, 10, 15, 0.8)', backdropFilter: 'blur(4px)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', minWidth: '200px' }}>
                    <h3 style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>SMC Engine Status</h3>
                    
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Trend:</span>
                        <span style={{ color: smcState?.currentTrend === 'Bullish' ? '#10b981' : smcState?.currentTrend === 'Bearish' ? '#ef4444' : 'var(--text-primary)', fontWeight: 'bold', fontSize: '13px' }}>
                            {smcState?.currentTrend || 'N/A'}
                        </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Active OBs:</span>
                        <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>{smcState?.activeOBs?.length || 0}</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Active FVGs:</span>
                        <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>{smcState?.activeFVGs?.length || 0}</span>
                    </div>
                </div>

                <div ref={chartContainerRef} style={{ position: 'absolute', inset: 0 }} />
            </div>
            
            {/* Embedded Scanner */}
            <div style={{ flexShrink: 0, marginTop: '16px', borderRadius: '8px', border: '1px solid var(--border-color)', marginBottom: '16px' }}>
                <SMCScanner wsUrl="ws://169.58.163.132:8081" activeAsset={ticker} />
            </div>
        </div>
    );
}
