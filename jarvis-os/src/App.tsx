import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Activity, Terminal, PieChart, Settings, Play, BrainCircuit } from 'lucide-react';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import RadarHeatmap from './components/RadarHeatmap';
import FundamentalTerminal from './components/FundamentalTerminal';
import AnalyticsJournal from './components/AnalyticsJournal';
import AdminPanel from './components/AdminPanel';
import BacktestingPanel from './components/BacktestingPanel';
import PeriodicOptPanel from './components/PeriodicOptPanel';
import { ToastProvider, useToast } from './components/Toast';
import './index.css';

function Sidebar() {
  return (
    <div className="sidebar">
      <div className="brand">
        <Activity size={24} color="var(--accent-gold)" />
        JARVIS OS
      </div>
      
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
        <NavLink to="/radar" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Activity size={18} /> Radar Cuantitativo
        </NavLink>
        <NavLink to="/terminal" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Terminal size={18} /> Terminal Fundamental
        </NavLink>
        <NavLink to="/journal" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <PieChart size={18} /> Diario Analítico
        </NavLink>
        <NavLink to="/backtesting" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Play size={18} /> Backtesting
        </NavLink>
        <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Settings size={18} /> Panel de Control
        </NavLink>
        <NavLink to="/autotune" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <BrainCircuit size={18} /> Optimización Periódica
        </NavLink>
      </nav>
      
      <div style={{ marginTop: 'auto', padding: '16px', borderTop: '1px solid var(--border-color)', fontSize: '0.8rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <div className="live-dot"></div>
          SYS.ONLINE
        </div>
        V. 1.0.0
      </div>
    </div>
  );
}

function Header({ time }: { time: Date }) {
  const { toast } = useToast();
  const [killswitches, setKillswitches] = useState<Record<string, boolean>>({});
  const [showModal, setShowModal] = useState(false);
  const [autoTrading, setAutoTrading] = useState(false);

  useEffect(() => {
    const unsubGlobal = onSnapshot(doc(db, 'app_settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        setKillswitches(docSnap.data()?.killswitches || {});
      }
    }, (err) => {
      console.error('[Header] Error listening to global settings:', err);
    });
    
    const unsubBot = onSnapshot(doc(db, 'firebase_config', 'dynamic'), (botSnap) => {
      if (botSnap.exists()) {
        setAutoTrading(botSnap.data()?.autoTrading === true);
      }
    }, (err) => {
      console.error('[Header] Error listening to bot config:', err);
    });

    return () => {
      unsubGlobal();
      unsubBot();
    };
  }, []);

  const isBotActive = !killswitches['GLOBAL_SYSTEM'];

  const handleTurnOn = async () => {
    try {
      await setDoc(doc(db, 'app_settings', 'global'), {
        killswitches: {
          ...killswitches,
          GLOBAL_SYSTEM: false
        }
      }, { merge: true });
      toast('🤖 Sistema Jarvis Reactivado con éxito.', 'success');
    } catch (e: any) {
      toast('Error al encender el bot', 'error');
    }
  };

  const handlePauseAll = async () => {
    try {
      await setDoc(doc(db, 'app_settings', 'global'), {
        killswitches: {
          ...killswitches,
          GLOBAL_SYSTEM: true,
          BTCUSD: true
        }
      }, { merge: true });
      toast('🛑 Jarvis Bot y BTCUSD apagados completamente.', 'warning');
    } catch (e: any) {
      toast('Error al pausar el bot', 'error');
    }
    setShowModal(false);
  };

  const handlePauseAllExceptBtc = async () => {
    try {
      await setDoc(doc(db, 'app_settings', 'global'), {
        killswitches: {
          ...killswitches,
          GLOBAL_SYSTEM: true,
          BTCUSD: false
        }
      }, { merge: true });
      toast('🛑 Jarvis Bot en pausa. BTCUSD continúa operando.', 'info');
    } catch (e: any) {
      toast('Error al pausar el bot', 'error');
    }
    setShowModal(false);
  };

  const handleToggleAutoTrading = async () => {
    try {
      const newValue = !autoTrading;
      setAutoTrading(newValue);
      await setDoc(doc(db, 'firebase_config', 'dynamic'), { autoTrading: newValue }, { merge: true });
      toast(`🤖 Modo Automático ${newValue ? 'ACTIVADO' : 'DESACTIVADO'}`, newValue ? 'success' : 'info');
    } catch (e) {
      console.error(e);
      toast('❌ Error guardando Modo Automático', 'error');
    }
  };

  return (
    <>
      <header className="header">
        <div>
          <h2 style={{ letterSpacing: '0.1em', textTransform: 'uppercase' }}>Terminal de Operaciones</h2>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div 
            onClick={handleToggleAutoTrading}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
              padding: '8px 12px', backgroundColor: autoTrading ? '#ffaa0020' : '#222',
              border: `1px solid ${autoTrading ? '#ffaa00' : '#444'}`,
              borderRadius: '6px', transition: 'all 0.2s'
            }}
          >
            <div style={{
              width: '12px', height: '12px', borderRadius: '50%',
              backgroundColor: autoTrading ? '#ffaa00' : '#666',
              boxShadow: autoTrading ? '0 0 8px #ffaa00' : 'none'
            }} />
            <span style={{ fontSize: '0.9rem', color: autoTrading ? '#ffaa00' : '#888', fontWeight: 600 }}>
              AUTO TRADING
            </span>
          </div>

          <button
            onClick={() => isBotActive ? setShowModal(true) : handleTurnOn()}
            className={`master-bot-btn ${isBotActive ? 'active' : 'inactive'}`}
            title={isBotActive ? "Apagar el Bot Maestro" : "Encender el Bot Maestro"}
          >
            <span className="btn-icon">🤖</span>
            <span className="btn-text">{isBotActive ? 'BOT ONLINE' : 'BOT OFFLINE'}</span>
            <span className="btn-pulse-dot"></span>
          </button>

          <div className="mono" style={{ fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
            {time.toLocaleTimeString('en-GB')} UTC-3
          </div>
        </div>
      </header>

      {/* Modal de Confirmación Premium */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content-premium" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-premium">
              <span className="modal-title-icon">⚠️</span>
              <h3>APAGAR JARVIS SYSTEM</h3>
            </div>
            
            <div className="modal-body-premium">
              <p>¿Estás seguro de que deseas pausar por completo el bot de operaciones?</p>
              <p className="highlight-text">
                Dado que <strong>BTCUSD</strong> opera 24/7 de forma continua, puedes seleccionar si deseas desactivar también este activo o si deseas mantenerlo operativo de forma independiente.
              </p>
            </div>
            
            <div className="modal-footer-premium">
              <button className="btn-danger" onClick={handlePauseAll}>
                🛑 Apagar Todo (Incluyendo BTCUSD)
              </button>
              <button className="btn-warning-premium" onClick={handlePauseAllExceptBtc}>
                ⚡ Apagar Todo excepto BTCUSD
              </button>
              <button className="btn-cancel" onClick={() => setShowModal(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function App() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <BrowserRouter>
      <ToastProvider>
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <Header time={time} />
          
          <Routes>
            <Route path="/" element={<Navigate to="/radar" replace />} />
            <Route path="/radar" element={<RadarHeatmap />} />
            <Route path="/terminal" element={<FundamentalTerminal />} />
            <Route path="/journal" element={<AnalyticsJournal />} />
            <Route path="/backtesting" element={<BacktestingPanel />} />
            <Route path="/admin" element={<AdminPanel />} />
            <Route path="/autotune" element={<PeriodicOptPanel />} />
          </Routes>
        </main>
      </div>
      </ToastProvider>
    </BrowserRouter>
  );
}

export default App;
