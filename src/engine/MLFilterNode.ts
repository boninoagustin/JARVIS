/**
 * MLFilter Node.js loader — carga modelos desde disco.
 * Separado de MLFilter.ts para que el frontend (jarvis-os) no necesite @types/node.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadModelFromJSON } from './MLFilter.js';

export function initMLFilter(_ticker?: string): void {
  const modelsDir = path.join(process.cwd(), 'scripts', 'hyperopt', 'models');

  // 1. Modelo genérico como fallback (clave '__default__')
  const defaultPath = path.join(modelsDir, 'ml_model.json');
  if (fs.existsSync(defaultPath)) {
    loadModelFromJSON(fs.readFileSync(defaultPath, 'utf8'));
  }

  // 2. Todos los modelos por ticker: ml_model_<TICKER>.json (auto-descubiertos)
  const files = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : [];
  for (const fname of files) {
    const m = fname.match(/^ml_model_([A-Z0-9]+)\.json$/i);
    if (m) {
      loadModelFromJSON(fs.readFileSync(path.join(modelsDir, fname), 'utf8'), m[1].toUpperCase());
    }
  }

  console.log('[MLFilter] 🧠 Carga de modelos completa.');
}
