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

// ── Cache ──
let _cachedTrees: XGBoostTree[] | null = null;
let _cachedMeta: MLModelExport['meta'] | null = null;

// ── Tree walker ──
function walkTree(features: number[], tree: XGBoostTree): number {
  if (tree.split_indices && tree.split_conditions && tree.left_children && tree.right_children) {
    let nodeIdx = 0;
    const n = tree.split_indices.length;
    while (nodeIdx < n) {
      const fi = tree.split_indices[nodeIdx];
      if (fi < 0 || fi >= features.length) break;
      const val = features[fi];
      nodeIdx = (!Number.isNaN(val) && val >= tree.split_conditions[nodeIdx])
        ? tree.right_children[nodeIdx]
        : tree.left_children[nodeIdx];
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

function predictProba(features: number[]): number {
  if (!_cachedTrees) return 1.0;
  let raw = 0;
  for (const t of _cachedTrees) raw += walkTree(features, t);
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
  chochPoints: number, scorePoints: number, tf: string,
): MLPrediction {
  const f = extractFeatures(state, direction, nowMs, chochPoints, scorePoints, tf);
  const vec = [f.z_score, f.vwap_status, f.atr_value, f.sweep_direction, f.simple_trend,
               f.hour_of_day, f.session, f.day_of_week, f.score_points, f.active_zones,
               f.choch_points, f.bias_aligned];

  if (!_cachedTrees) return { probability: 1.0, approved: true, threshold: 0.65, features: vec };

  const prob = predictProba(vec);
  const threshold = _cachedMeta?.threshold ?? 0.65;
  return { probability: prob, approved: prob >= threshold, threshold, features: vec };
}

export function isMLActive(): boolean { return _cachedTrees !== null; }

/**
 * Carga un modelo desde un objeto JSON (útil para browser y Node.js).
 * En Node.js se puede usar fs.readFileSync + JSON.parse.
 * En browser se puede usar fetch() + response.json().
 */
export function loadModelFromJSON(json: string | object): boolean {
  try {
    const exported: MLModelExport = typeof json === 'string' ? JSON.parse(json) : json;
    _cachedMeta = exported.meta;

    const booster = exported.xgboost_model?.learner?.gradient_booster?.model;
    const trees: XGBoostTree[] = [];
    const collect = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        if (obj.length > 0 && typeof obj[0] === 'object' &&
            (obj[0].split_indices !== undefined || obj[0].split !== undefined || obj[0].leaf !== undefined)) {
          trees.push(...obj); return;
        }
        for (const item of obj) collect(item);
        return;
      }
      if (obj.split_indices !== undefined || obj.split !== undefined || obj.leaf !== undefined) trees.push(obj);
      for (const val of Object.values(obj)) collect(val);
    };
    collect(booster || exported.xgboost_model);
    _cachedTrees = trees;
    console.log(`[MLFilter] ✅ ${trees.length} trees, acc=${_cachedMeta.accuracy.toFixed(3)}, f1=${_cachedMeta.f1.toFixed(3)}`);
    return trees.length > 0;
  } catch (e: any) {
    console.error(`[MLFilter] ❌ Error: ${e.message}`);
    return false;
  }
}
