import { useEffect, useState } from 'react';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '../firebase';
import { Activity, Zap } from 'lucide-react';

interface RadarState {
  id: string;
  marketBias: { '240': string, '60': string, '15': string, '3': string };
  scoreBuy: { points: number };
  scoreSell: { points: number };
  zones: any[];
  lastPrice?: number;
}

const getIcon = (dir: string) => {
  if (dir === 'BUY') return <span className="status-buy">BUY 🟢</span>;
  if (dir === 'SELL') return <span className="status-sell">SELL 🔴</span>;
  return <span className="status-neutral">NEUT ⚪</span>;
};

export default function RadarHeatmap() {
  const [states, setStates] = useState<RadarState[]>([]);

  useEffect(() => {
    const q = query(collection(db, 'radar_states'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RadarState));
      setStates(data);
    });
    return () => unsubscribe();
  }, []);

  return (
    <div>
      <div className="panel-header">
        <span><Activity size={14} style={{ marginRight: 8 }} /> MATRIZ DE ALINEACIÓN CUANTITATIVA</span>
        <span className="live-dot"></span>
      </div>
      
      <div className="panel" style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>ACTIVO</th>
              <th>PRECIO</th>
              <th>4H (MACRO)</th>
              <th>1H (TREND)</th>
              <th>15M (MICRO)</th>
              <th>GATILLO (3M)</th>
              <th>PUNTOS COMPRA</th>
              <th>PUNTOS VENTA</th>
              <th>TERMÓMETRO (LIQ)</th>
            </tr>
          </thead>
          <tbody>
            {states.map(asset => {
              const buyPoints = asset.scoreBuy?.points || 0;
              const sellPoints = asset.scoreSell?.points || 0;
              const maxPoints = Math.max(buyPoints, sellPoints);
              
              // Termómetro calculation: gets hot if points are near 8
              const isHot = maxPoints >= 5;
              const isCritical = maxPoints >= 8;
              
              return (
                <tr key={asset.id}>
                  <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{asset.id}</td>
                  <td>{asset.lastPrice?.toFixed(5) || 'N/A'}</td>
                  <td>{getIcon(asset.marketBias?.['240'])}</td>
                  <td>{getIcon(asset.marketBias?.['60'])}</td>
                  <td>{getIcon(asset.marketBias?.['15'])}</td>
                  <td>{getIcon(asset.marketBias?.['3'])}</td>
                  <td className="text-green">{buyPoints} / 8</td>
                  <td className="text-red">{sellPoints} / 8</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ 
                        width: '100%', 
                        height: '6px', 
                        backgroundColor: 'var(--border-color)',
                        borderRadius: '3px',
                        overflow: 'hidden'
                      }}>
                        <div style={{ 
                          width: `${Math.min(100, (maxPoints / 8) * 100)}%`, 
                          height: '100%', 
                          backgroundColor: isCritical ? 'var(--accent-red)' : isHot ? 'var(--accent-gold)' : 'var(--status-neutral)',
                          transition: 'width 0.3s ease, background-color 0.3s ease'
                        }}></div>
                      </div>
                      {isCritical && <Zap size={14} color="var(--accent-red)" className="live-dot" />}
                    </div>
                  </td>
                </tr>
              );
            })}
            {states.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '24px' }}>
                  Esperando datos del Radar...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
