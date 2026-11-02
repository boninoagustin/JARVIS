/**
 * JARVIS MLFilter — FreqAI-style ML prediction layer
 *
 * Extrae 12 features del estado del RadarState al momento de la señal
 * y evalúa un clasificador XGBoost exportado como JSON (árboles).
 *
 * Compatible con Node.js y browser (jarvis-os). En browser, el modelo
 * se carga desde el servidor o se usa el fallback (sin modelo = aprueba todo).
 */

import type { RadarState } from './Types.js';
import { validateModel, LEGACY_FEATURE_NAMES, LEGACY_INFERENCE_PROFILE } from './MLModelValidation.js';

// ── Tipos del modelo ──
interface XGBoostTree {
  split_indices?: number[];
  split_conditions?: number[];
  left_children?: number[];
  right_children?: number[];
  base_weights?: number[];
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  leaf?: number;
  children?: XGBoostTree[];
  nodeid?: number;
}

interface MLModelExport {
  meta: {
    feature_names: string[];
    threshold: number;
    accuracy: number;
    f1: number;
    train_samples: number;
  };
  xgboost_model: any;
}

// ── Cache (por ticker; '__default__' = modelo genérico) ──
interface LoadedModel { trees: XGBoostTree[]; meta: MLModelExport['meta']; }
const _models = new Map<string, LoadedModel>();
const DEFAULT_KEY = '__default__';

// 🛡️ ML F3 (sep-2026): ventana de activación para walk-forward en el BACKTEST.
// El motor setea setMLWindowStart(trainedAt): predict() aprueba automáticamente los
// trades anteriores a la ventana (el modelo no debe juzgar su propio período de train).
// En el VIVO la ventana es 0 → el gate aplica siempre (comportamiento intacto).
let _mlWindowStartMs = 0;
export function setMLWindowStart(ms: number): void { _mlWindowStartMs = ms > 0 ? ms : 0; }

// ── Tree walker ──
function walkTree(features: number[], tree: XGBoostTree): number {
  if (tree.split_indices && tree.split_conditions && tree.left_children && tree.right_children) {
    // 🛡️ FIX (sep-2026): detección de HOJAS por left_children[nodeIdx] < 0 (formato XGBoost 2.x).
    // Antes el -1 de hoja se trataba como índice de nodo → si[-1]=undefined → bajaba por
    // left_children[-1]=undefined → walkTree devolvía 0 en TODOS los árboles → prob=0.5
    // constante → el filtro rechazaba TODO (0.5 < 0.65) sin señal real.
    let nodeIdx = 0;
    const n = tree.split_indices.length;
    while (nodeIdx >= 0 && nodeIdx < n) {
      const lc = tree.left_children[nodeIdx];
      const rc = tree.right_children[nodeIdx];
      if (lc === undefined || lc < 0 || rc < 0) return tree.base_weights?.[nodeIdx] ?? 0; // hoja
      const fi = tree.split_indices[nodeIdx];
      if (fi < 0 || fi >= features.length) return tree.base_weights?.[nodeIdx] ?? 0;
      const val = features[fi];
      nodeIdx = (!Number.isNaN(val) && val >= tree.split_conditions[nodeIdx]) ? rc : lc;
    }
    return tree.base_weights?.[nodeIdx] ?? 0;
  }
  if (tree.leaf !== undefined) return tree.leaf;
  if (tree.split !== undefined && tree.children?.length) {
    const fi = parseInt(tree.split.replace('f', ''), 10);
    const val = features[fi];
    const goRight = !Number.isNaN(val) && val >= (tree.split_condition ?? 0);
    return walkTree(features, tree.children[goRight ? 1 : 0]);
  }
  return 0;
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

function predictProba(features: number[], trees: XGBoostTree[]): number {
  let raw = 0;
  for (const t of trees) raw += walkTree(features, t);
  return sigmoid(raw);
}

// ── Feature extraction ──
export interface MLPrediction {
  probability: number;
  approved: boolean;
  threshold: number;
  features: number[];
}

export function extractFeatures(
  state: RadarState, direction: 'BUY' | 'SELL', nowMs: number,
  chochPoints: number, scorePoints: number, tf: string,
) {
  const d = new Date(nowMs);
  const arH = (d.getUTCHours() - 3 + 24) % 24;
  const dec = arH + d.getUTCMinutes() / 60;
  let session = 3;
  if (dec >= 21 || dec < 4) session = 0;
  else if (dec >= 4 && dec < 10.5) session = 1;
  else if (dec >= 10.5 && dec < 17) session = 2;

  const vwapRaw = state.vwapStatus?.['15'] || '';
  let vwap = 2;
  if (vwapRaw === 'UNDER') vwap = 0;
  else if (vwapRaw === 'OVER') vwap = 1;

  const bias = state.marketBias?.[tf === 'D' ? '240' : tf] || 'NEUTRAL';
  let biasAligned = 0;
  if ((bias === 'BUY' && direction === 'BUY') || (bias === 'SELL' && direction === 'SELL')) biasAligned = 1;

  const bias15 = state.marketBias?.['15'] || 'NEUTRAL';
  let simpleTrend = 1;
  if (bias15 === 'BUY') simpleTrend = 2;
  else if (bias15 === 'SELL') simpleTrend = 0;

  return {
    z_score: (state.zUp ?? 0) - (state.zDn ?? 0),
    vwap_status: vwap,
    atr_value: state.atr14 ?? 0,
    sweep_direction: 0,
    simple_trend: simpleTrend,
    hour_of_day: arH,
    session,
    day_of_week: d.getDay(),
    score_points: scorePoints,
    active_zones: state.zones?.length ?? 0,
    choch_points: chochPoints,
    bias_aligned: biasAligned,
  };
}

export function predict(
  state: RadarState, direction: 'BUY' | 'SELL', nowMs: number,
  chochPoints: number, scorePoints: number, tf: string, ticker?: string,
  opts?: { auditOnly?: boolean },
): MLPrediction | null {
  // 🛡️ FIX: tickers excluidos (ej. USOIL con modelo ~azar) no pasan por el filtro ML.
  // Devolvemos null para que AlphaModel caiga al fallback heurístico legacy (reglas de puntaje).
  const t = (ticker || '').toUpperCase();
  // 🛡️ 16-sep-2026: override runtime del bot (asset_configs.mlGateEnabled) manda sobre la
  // lista estática. Sin override → lista estática (solo USOIL).
  // auditOnly=true (16-sep): evaluar IGUAL aunque el gate esté apagado/excluido — solo para
  // telemetría del gate extendido (directas). El llamador decide si bloquea (nunca acá).
  if (!opts?.auditOnly) {
    if (t && ML_GATE_OVERRIDES.has(t)) {
      if (!ML_GATE_OVERRIDES.get(t)) return null;
    } else if (t && ML_EXCLUDED_TICKERS.has(t)) {
      return null;
    }
  }

  const f = extractFeatures(state, direction, nowMs, chochPoints, scorePoints, tf);
  const vec = [f.z_score, f.vwap_status, f.atr_value, f.sweep_direction, f.simple_trend,
               f.hour_of_day, f.session, f.day_of_week, f.score_points, f.active_zones,
               f.choch_points, f.bias_aligned];

  // 🛡️ ML F3 (sep-2026): walk-forward del backtest — antes de la ventana de entrenamiento
  // devolvemos null = fallback a la heurística legacy, IDÉNTICO a "sin modelo cargado"
  // (paridad exacta del tramo pre-window; approved:true saltaría los checks legacy del AlphaModel).
  // En el VIVO la ventana es 0 → el gate aplica siempre (comportamiento intacto).
  if (_mlWindowStartMs > 0 && nowMs < _mlWindowStartMs) {
    return null;
  }

  const key = ticker ? ticker.toUpperCase() : DEFAULT_KEY;
  const model = _models.get(key) ?? _models.get(DEFAULT_KEY);
  if (!model) return { probability: 1.0, approved: true, threshold: 0.65, features: vec };

  const prob = predictProba(vec, model.trees);
  const threshold = model.meta?.threshold ?? 0.65;
  return { probability: prob, approved: prob >= threshold, threshold, features: vec };
}

export function isMLActive(): boolean { return _models.size > 0; }

// 🛡️ FIX: activos cuyo modelo ML no aporta señal se excluyen del filtro SIEMPRE.
// - USOIL: acc=0.536 ≈ azar → rechazaba TODO con prob≈0.500 < 0.65.
// 🛡️ 16-sep-2026: la decisión de gate por activo dejó de ser estática — vive en
// `asset_configs/{TICKER}.mlGateEnabled` (Firestore) y el bot la aplica en caliente vía
// setMLGateOverride(). Default en vivo = APAGADO (sweep: los modelos de 11-ago restan PnL
// en todos los umbrales). El motor de backtest NO usa overrides → el sweep puede evaluar
// el gate libremente (paridad intacta).
const ML_EXCLUDED_TICKERS = new Set(['USOIL']);
const ML_GATE_OVERRIDES = new Map<string, boolean>();

/** Override runtime del gate ML por ticker (true = gate ON, false = OFF → fallback heurístico).
 *  Lo usa SOLO el bot en vivo al cargar asset_configs. Sin override → lista estática. */
export function setMLGateOverride(ticker: string, enabled: boolean): void {
    ML_GATE_OVERRIDES.set(ticker.toUpperCase(), !!enabled);
}

/**
 * Carga un modelo desde un objeto JSON (útil para browser y Node.js).
 * En Node.js se puede usar fs.readFileSync + JSON.parse.
 * En browser se puede usar fetch() + response.json().
 */
export function loadModelFromJSON(json: string | object, ticker?: string): boolean {
  try {
    const { trees, meta } = validateModel(json, LEGACY_FEATURE_NAMES, LEGACY_INFERENCE_PROFILE);
    const key = ticker ? ticker.toUpperCase() : DEFAULT_KEY;
    // Format/log before installing: validation or a throwing logger cannot poison the cache.
    const message = `[MLFilter] ✅ ${ticker ? ticker.toUpperCase() : 'default'}: ${trees.length} trees, acc=${meta.accuracy.toFixed(3)}, f1=${meta.f1.toFixed(3)}`;
    console.log(message);
    _models.set(key, { trees, meta });
    return true;
  } catch (e: any) {
    console.error(`[MLFilter] ❌ Error: ${e.message}`);
    return false;
  }
}
