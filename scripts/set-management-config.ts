/**
 * Establece la gestión de trades óptima por activo en Firestore (asset_configs).
 * Valores elegidos por matriz de backtest (jarvis-os/scripts/run-matrix.ts) sobre
 * los logs pine de cada activo — ver matrix-full-TICKER-results.json en cada carpeta de logs
 *
 * Uso: npx tsx scripts/set-management-config.ts
 * El bot live toma los cambios en caliente vía listener de asset_configs.
 */
import { db } from '../src/db/memory.js';

interface ManagementConfig {
  partialClosePct: number;                       // fracción cerrada en TP1
  slAfterTp1: 'midpoint' | 'breakeven' | 'none'; // ajuste del SL al tocar TP1
  atrTrailEnabled: boolean;                      // trailing ATR post-TP1
  structuralTrailEnabled: boolean;               // trailing estructural (solo backtest; live no lo implementa)
  tp15BeEnabled: boolean;                        // BE diferido en TP1.5
  tp1StructuralMinRR: number;                    // 99 = TP1 fijo 1:1; 1.2 = TP1 estructural si queda >= 1.2R
}

const MANAGEMENT_BY_TICKER: Record<string, ManagementConfig> = {
  // EURUSD — EV 0.357 | PF 2.18 | DD 5.2R (matriz logs/eurusd)
  EURUSD: { partialClosePct: 0.3, slAfterTp1: 'breakeven', atrTrailEnabled: false, structuralTrailEnabled: false, tp15BeEnabled: true, tp1StructuralMinRR: 99 },
  // USDJPY — EV 0.257 | PF 1.87 | DD 5.1R (matriz Descargas/usdjpy)
  USDJPY: { partialClosePct: 0.3, slAfterTp1: 'breakeven', atrTrailEnabled: false, structuralTrailEnabled: false, tp15BeEnabled: true, tp1StructuralMinRR: 1.2 },
  // XAUUSD — EV 0.336 | PF 2.13 | DD 5.0R (matriz Descargas/xauusd) — el oro sí se beneficia del trail ATR
  XAUUSD: { partialClosePct: 0.3, slAfterTp1: 'breakeven', atrTrailEnabled: true, structuralTrailEnabled: false, tp15BeEnabled: true, tp1StructuralMinRR: 99 },
  // NAS100 — EV 0.316 | PF 2.12 | DD 5.5R (matriz Descargas/NAS100) — BE se barre seguido, mejor midpoint
  NAS100: { partialClosePct: 0.3, slAfterTp1: 'midpoint', atrTrailEnabled: false, structuralTrailEnabled: false, tp15BeEnabled: true, tp1StructuralMinRR: 99 },
};

async function main() {
  if (!db) {
    console.error('❌ Sin conexión a Firebase (revisá GOOGLE_APPLICATION_CREDENTIALS).');
    process.exit(1);
  }
  for (const [ticker, mgmt] of Object.entries(MANAGEMENT_BY_TICKER)) {
    await db.collection('asset_configs').doc(ticker).set({ ...mgmt, updatedAt: Date.now() }, { merge: true });
    console.log(`✅ ${ticker} ← ${JSON.stringify(mgmt)}`);
  }
  console.log('\nListo. El bot live toma los cambios en caliente (listener asset_configs).');
  process.exit(0);
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
