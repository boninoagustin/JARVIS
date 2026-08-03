/**
 * JARVIS MLFilter — FreqAI-style ML prediction layer
 *
 * Extrae 12 features del estado del SMCEngine/RadarState al momento de la señal
 * y evalúa un clasificador XGBoost exportado como JSON (árboles) para decidir
 * si una entrada debe aprobarse (probabilidad > threshold).
 *
 * Arquitectura:
 *   - Sin dependencias Python en runtime (modelo serializado como JSON)
 *   - Tree-walker nativo en TypeScript (~0.1ms por predicción)
 *   - Fallback: si no hay modelo → aprueba todo (comportamiento legacy)
 *
 * Features (deben coincidir con train_ml_model.py:FEATURE_NAMES):
 *   z_score, vwap_status, atr_value, sweep_direction, simple_trend,
 *   hour_of_day, session, day_of_week, score_points, active_zones,
 *   choch_points, bias_aligned
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RadarState, ScoreState } from './Types.js';

// -----------------------------------------------------------------------------
// Tipos del modelo XGBoost exportado
// -----------------------------------------------------------------------------
interface XGBoostNode {
  nodeid?: number;
  depth?: number;
  split?: string;       // "f0", "f3", ...
  split_condition?: number;
  yes?: number;          // child index if split condition is true
  no?: number;           // child index if split condition is false
  missing?: number;      // child index if feature is missing
  leaf?: number;         // leaf value (log-odds)
  children?: XGBoostNode[];
}

interface XGBoostTree {
  nodeid?: number;
  depth?: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  missing?: number;
  leaf?: number;
  children?: XGBoostNode[];
  // Lossguide format (XGBoost ≥1.5)
  left_children?: number[];
  right_children?: number[];
  parents?: number[];
  split_indices?: number[];
  split_conditions?: number[];
  base_weights?: number[];
}

interface XGBoostModel {
  learner?: {
    gradient_booster?: {
      model?: {
        trees?: XGBoostTree[];
        tree_info?: number[];
      };
    };
    attributes?: Record<string, string>;
  };
}

interface MLModelMeta {
  feature_names: string[];
  n_features: number;
  threshold: number;
  accuracy: number;
  f1: number;
  train_samples: number;
}

interface MLModelExport {
  meta: MLModelMeta;
  features: string[];
  xgboost_model: XGBoostModel;
}

// -----------------------------------------------------------------------------
// Cache del modelo cargado
// -----------------------------------------------------------------------------
let _cachedModel: MLModelExport | null = null;
let _cachedTrees: XGBoostTree[] | null = null;
let _modelPath: string | null = null;

const DEFAULT_MODEL_PATH = path.resolve(
  process.cwd(), 'scripts', 'hyperopt', 'models', 'ml_model.json'
);

// -----------------------------------------------------------------------------
// Tree walker
// -----------------------------------------------------------------------------
function walkTree(features: number[], tree: XGBoostTree): number {
  // XGBoost JSON export: puede estar en formato "lossguide" (arrays paralelos)
  // o en formato "depthwise" (children anidados).
  
  // Formato lossguide (XGBoost ≥ 1.5)
  if (tree.split_indices && tree.split_conditions && tree.left_children && tree.right_children) {
    let nodeIdx = 0;
    const n = tree.split_indices.length;
    while (nodeIdx < n) {
      const featIdx = tree.split_indices[nodeIdx];
      if (featIdx < 0 || featIdx >= features.length) {
        // Leaf or invalid
        break;
      }
      const cond = tree.split_conditions[nodeIdx];
      const val = features[featIdx];
      if (Number.isNaN(val)) {
        nodeIdx = tree.left_children[nodeIdx]; // missing → left (XGBoost default)
      } else if (val < cond) {
        nodeIdx = tree.left_children[nodeIdx];
      } else {
        nodeIdx = tree.right_children[nodeIdx];
      }
    }
    // Fallback: buscar base_weight
    if (tree.base_weights && nodeIdx < tree.base_weights.length) {
      return tree.base_weights[nodeIdx];
    }
    return 0;
  }

  // Formato depthwise (children anidados)
  if (tree.children && tree.children.length > 0) {
    const nodeMap = new Map<number, XGBoostNode>();
    const stack: XGBoostNode[] = [tree as unknown as XGBoostNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.nodeid !== undefined) nodeMap.set(node.nodeid, node);
      for (const child of node.children || []) stack.push(child);
    }
    let current = tree as unknown as XGBoostNode;
    while (current) {
      if (current.leaf !== undefined) return current.leaf;
      if (current.split === undefined) return 0;
      const featIdx = parseInt(current.split.replace('f', ''), 10);
      const val = features[featIdx];
      const goRight = (!Number.isNaN(val) && val >= (current.split_condition ?? 0));
      const nextId = goRight ? current.yes : current.no;
      if (nextId === undefined) return 0;
      const next = nodeMap.get(nextId);
      if (!next) return 0;
      current = next;
    }
    return 0;
  }

  // Formato recursivo (children directos en el mismo objeto)
  if (tree.split !== undefined && tree.children && tree.children.length > 0) {
    const featIdx = parseInt(tree.split.replace('f', ''), 10);
    const val = features[featIdx];
    const goRight = (!Number.isNaN(val) && val >= (tree.split_condition ?? 0));
    const childIdx = goRight ? 1 : 0;
    if (childIdx < tree.children.length) {
      return walkTree(features, tree.children[childIdx]);
    }
    return 0;
  }

  // Leaf
  if (tree.leaf !== undefined) return tree.leaf;
  return 0;
}

function sigmoid(x: number): number {
  return 1.0 / (1.0 + Math.exp(-x));
}

function predictProba(features: number[]): number {
  if (!_cachedTrees) return 1.0;  // sin modelo → aprobar todo

  let rawScore = 0.0;
  for (const tree of _cachedTrees) {
    rawScore += walkTree(features, tree);
  }

  // XGBoost binary:logistic → raw_score es log-odds
  return sigmoid(rawScore);
}

// -----------------------------------------------------------------------------
// Carga del modelo
// -----------------------------------------------------------------------------
export function loadModel(modelPath?: string): boolean {
  const fp = modelPath || DEFAULT_MODEL_PATH;
  if (_modelPath === fp && _cachedModel !== null) return true;

  if (!fs.existsSync(fp)) {
    console.log(`[MLFilter] ⚠️ Modelo no encontrado en ${fp} — usando heurística legacy.`);
    console.log(`[MLFilter]    Ejecutá: python scripts/train_ml_model.py <TICKER>`);
    _cachedModel = null;
    _cachedTrees = null;
    _modelPath = null;
    return false;
  }

  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const exported: MLModelExport = JSON.parse(raw);
    _cachedModel = exported;

    // Extraer árboles del booster
    const booster = exported.xgboost_model?.learner?.gradient_booster?.model;
    if (booster?.trees) {
      _cachedTrees = booster.trees;
    } else if (booster?.tree_info) {
      // Formato alternativo: buscar en el JSON
      const trees: XGBoostTree[] = [];
      const collectTrees = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          // Si el primer elemento tiene 'split' o 'leaf', son árboles
          if (obj.length > 0 && (obj[0].split !== undefined || obj[0].leaf !== undefined)) {
            trees.push(...obj);
            return;
          }
          for (const item of obj) collectTrees(item);
          return;
        }
        if (obj.split !== undefined || obj.leaf !== undefined) {
          trees.push(obj as XGBoostTree);
        }
        for (const val of Object.values(obj)) collectTrees(val);
      };
      collectTrees(booster);
      _cachedTrees = trees;
    } else {
      // Buscar recursivamente en todo el JSON
      const trees: XGBoostTree[] = [];
      const collectTrees = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          if (obj.length > 0 && typeof obj[0] === 'object' &&
              (obj[0].split !== undefined || obj[0].leaf !== undefined ||
               obj[0].split_indices !== undefined)) {
            trees.push(...obj);
            return;
          }
          for (const item of obj) collectTrees(item);
          return;
        }
        if (obj.split !== undefined || obj.leaf !== undefined ||
            obj.split_indices !== undefined) {
          trees.push(obj as XGBoostTree);
        }
        for (const val of Object.values(obj)) collectTrees(val);
      };
      collectTrees(exported.xgboost_model);
      _cachedTrees = trees;
    }

    _modelPath = fp;
    const meta = exported.meta;
    console.log(
      `[MLFilter] ✅ Modelo cargado: ${_cachedTrees.length} trees, ` +
      `acc=${meta.accuracy.toFixed(3)}, f1=${meta.f1.toFixed(3)}, ` +
      `threshold=${meta.threshold}, samples=${meta.train_samples}`
    );
    return true;
  } catch (e: any) {
    console.error(`[MLFilter] ❌ Error cargando modelo: ${e.message}`);
    _cachedModel = null;
    _cachedTrees = null;
    return false;
  }
}

// -----------------------------------------------------------------------------
// Feature extraction
// -----------------------------------------------------------------------------
export interface MLFeatures {
  z_score: number;
  vwap_status: number;       // 0=UNDER, 1=OVER, 2=N/A
  atr_value: number;
  sweep_direction: number;   // 0=none, 1=bull, 2=bear
  simple_trend: number;      // 0=bear, 1=neutral, 2=bull
  hour_of_day: number;       // 0-23 (Argentina ART)
  session: number;           // 0=ASIA, 1=LONDON, 2=NY, 3=OFF
  day_of_week: number;       // 0-6 (0=Domingo en JS, mapeado a 0-6)
  score_points: number;
  active_zones: number;
  choch_points: number;
  bias_aligned: number;      // 0/1: ¿marketBias del TF coincide con dir del trade?
}

export function extractFeatures(
  state: RadarState,
  direction: 'BUY' | 'SELL',
  nowMs: number,
  chochPoints: number,
  scorePoints: number,
  tf: string,
): MLFeatures {
  const d = new Date(nowMs);
  // Ajuste a Argentina UTC-3
  const arHour = (d.getUTCHours() - 3 + 24) % 24;
  const sessionDec = arHour + d.getUTCMinutes() / 60;
  let session: number;
  if (sessionDec >= 21 || sessionDec < 4) session = 0;       // ASIA
  else if (sessionDec >= 4 && sessionDec < 10.5) session = 1; // LONDON
  else if (sessionDec >= 10.5 && sessionDec < 17) session = 2; // NY
  else session = 3; // OFF

  // vwap_status del TF 15M (el más relevante para entradas)
  const vwapKey = tf === 'D' ? '240' : tf === '240' ? '240' : '15';
  const vwapRaw = state.vwapStatus?.[vwapKey] || '';
  let vwapStatus = 2; // N/A
  if (vwapRaw === 'UNDER') vwapStatus = 0;
  else if (vwapRaw === 'OVER') vwapStatus = 1;

  // sweep direction
  let sweepDir = 0;
  if (state.lastSweep) {
    if (state.lastSweep.direction === 'Bullish') sweepDir = 1;
    else if (state.lastSweep.direction === 'Bearish') sweepDir = 2;
  }

  // bias_aligned: ¿el marketBias del TF coincide con la dirección del trade?
  const bias = state.marketBias?.[tf === 'D' ? '240' : tf] || 'NEUTRAL';
  let biasAligned = 0;
  if ((bias === 'BUY' && direction === 'BUY') || (bias === 'SELL' && direction === 'SELL')) {
    biasAligned = 1;
  }

  // simple_trend (proxy: si no hay simple_trend en RadarState, usamos marketBias)
  let simpleTrend = 1; // neutral
  const bias15 = state.marketBias?.['15'] || 'NEUTRAL';
  if (bias15 === 'BUY') simpleTrend = 2;
  else if (bias15 === 'SELL') simpleTrend = 0;

  return {
    z_score: (state.zUp ?? 0) - (state.zDn ?? 0),
    vwap_status: vwapStatus,
    atr_value: state.atr14 ?? 0,
    sweep_direction: sweepDir,
    simple_trend: simpleTrend,
    hour_of_day: arHour,
    session,
    day_of_week: d.getDay(),
    score_points: scorePoints,
    active_zones: state.zones?.length ?? 0,
    choch_points: chochPoints,
    bias_aligned: biasAligned,
  };
}

// -----------------------------------------------------------------------------
// Prediction API
// -----------------------------------------------------------------------------
export interface MLPrediction {
  probability: number;   // 0..1
  approved: boolean;     // prob > threshold
  threshold: number;
  features: number[];    // vector crudo (para debug)
}

/**
 * Predice si un trade debe aprobarse basado en features del estado actual.
 * Si no hay modelo cargado, aprueba todo (comportamiento legacy).
 */
export function predict(
  state: RadarState,
  direction: 'BUY' | 'SELL',
  nowMs: number,
  chochPoints: number,
  scorePoints: number,
  tf: string,
): MLPrediction {
  const feats = extractFeatures(state, direction, nowMs, chochPoints, scorePoints, tf);
  const featureVec = [
    feats.z_score,
    feats.vwap_status,
    feats.atr_value,
    feats.sweep_direction,
    feats.simple_trend,
    feats.hour_of_day,
    feats.session,
    feats.day_of_week,
    feats.score_points,
    feats.active_zones,
    feats.choch_points,
    feats.bias_aligned,
  ];

  if (!_cachedTrees || !_cachedModel) {
    // Sin modelo → aprobar todo (fallback legacy)
    return { probability: 1.0, approved: true, threshold: 0.65, features: featureVec };
  }

  const prob = predictProba(featureVec);
  const threshold = _cachedModel.meta.threshold || 0.65;
  return {
    probability: prob,
    approved: prob >= threshold,
    threshold,
    features: featureVec,
  };
}

/**
 * Inicializa el filtro ML. Debe llamarse al arranque del bot.
 * Intenta cargar el modelo específico del ticker, con fallback al default.
 */
export function initMLFilter(ticker?: string): void {
  if (ticker) {
    const tickerPath = path.resolve(
      process.cwd(), 'scripts', 'hyperopt', 'models', `ml_model_${ticker.toUpperCase()}.json`
    );
    if (fs.existsSync(tickerPath)) {
      loadModel(tickerPath);
      return;
    }
  }
  loadModel(); // fallback a ml_model.json default
}

/**
 * True si hay un modelo ML cargado y activo.
 */
export function isMLActive(): boolean {
  return _cachedTrees !== null && _cachedTrees.length > 0;
}
