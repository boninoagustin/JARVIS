import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Activity, Terminal, PieChart, Settings } from 'lucide-react';
import RadarHeatmap from './components/RadarHeatmap';
import FundamentalTerminal from './components/FundamentalTerminal';
import AnalyticsJournal from './components/AnalyticsJournal';
import AdminPanel from './components/AdminPanel';
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
        <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Settings size={18} /> Panel de Control
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

function App() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <BrowserRouter>
      <div className="app-container">
        <Sidebar />
        <main className="main-content">
          <header className="header">
            <div>
              <h2 style={{ letterSpacing: '0.1em', textTransform: 'uppercase' }}>Terminal de Operaciones</h2>
            </div>
            <div className="mono" style={{ fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
              {time.toLocaleTimeString('en-GB')} UTC-3
            </div>
          </header>
          
          <Routes>
            <Route path="/" element={<Navigate to="/radar" replace />} />
            <Route path="/radar" element={<RadarHeatmap />} />
            <Route path="/terminal" element={<FundamentalTerminal />} />
            <Route path="/journal" element={<AnalyticsJournal />} />
            <Route path="/admin" element={<AdminPanel />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
