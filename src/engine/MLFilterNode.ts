/**
 * MLFilter Node.js loader — carga modelos desde disco.
 * Separado de MLFilter.ts para que el frontend (jarvis-os) no necesite @types/node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadModelFromJSON } from './MLFilter.js';

export function initMLFilter(ticker?: string): void {
  const modelsDir = path.join(process.cwd(), 'scripts', 'hyperopt', 'models');
  const tickerPath = ticker ? path.join(modelsDir, `ml_model_${ticker.toUpperCase()}.json`) : null;
  const defaultPath = path.join(modelsDir, 'ml_model.json');

  for (const fp of [tickerPath, defaultPath]) {
    if (fp && fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      if (loadModelFromJSON(raw)) return;
    }
  }
  console.log('[MLFilter] ⚠️ Sin modelo. Usando heurística legacy.');
}
