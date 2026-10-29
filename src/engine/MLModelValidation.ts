/** Pure validation boundary. No disk, registry, timers or active configuration. */
export const LEGACY_FEATURE_NAMES = Object.freeze(['z_score','vwap_status','atr_value','sweep_direction','simple_trend','hour_of_day','session','day_of_week','score_points','active_zones','choch_points','bias_aligned']);
export const LEGACY_INFERENCE_PROFILE = 'MLFilter.ts/array-trees/zero-margin/base_weights/v1';
export const NATIVE_INFERENCE_PROFILE = 'xgboost/binary-logistic/numeric-gbtree/float32/default-left/intercept/v1';
export interface ValidatedTree {
  split_indices: number[]; split_conditions: number[]; left_children: number[];
  right_children: number[]; base_weights: number[]; default_left: number[];
}
export interface ValidatedModel {
  trees: ValidatedTree[];
  meta: {feature_names: string[]; threshold: number; accuracy: number; f1: number; train_samples: number; [key: string]: any};
  intercept: number;
}
function requireValid(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function finite(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function integer(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v); }
function sameNames(v: any, names: readonly string[]): boolean { return Array.isArray(v) && v.length === names.length && v.every((n,i) => n === names[i]); }
/** Validates then takes an owned JSON snapshot: callers cannot mutate a loaded model. */
export function validateModel(json: string | object, names: readonly string[], profile: string): ValidatedModel {
  const exported = JSON.parse(typeof json === 'string' ? json : JSON.stringify(json));
  const meta = exported?.meta;
  requireValid(meta && sameNames(meta.feature_names, names), 'feature names/order mismatch');
  requireValid(exported.features === undefined || sameNames(exported.features, names), 'top-level feature names mismatch');
  requireValid(meta.n_features === undefined || meta.n_features === names.length, 'meta dimension mismatch');
  requireValid(finite(meta.threshold) && meta.threshold > 0 && meta.threshold < 1, 'invalid threshold');
  requireValid(finite(meta.accuracy) && meta.accuracy >= 0 && meta.accuracy <= 1 && finite(meta.f1) && meta.f1 >= 0 && meta.f1 <= 1, 'invalid log-safe metrics');
  requireValid(integer(meta.train_samples) && meta.train_samples >= 0, 'invalid train_samples');
  requireValid(profile === LEGACY_INFERENCE_PROFILE || profile === NATIVE_INFERENCE_PROFILE, 'unsupported inference profile');
  requireValid(meta.inference_profile === profile || (profile === LEGACY_INFERENCE_PROFILE && meta.inference_profile === undefined), 'inference profile mismatch');
  if (profile === LEGACY_INFERENCE_PROFILE && meta.feature_schema !== undefined) {
    const schema = meta.feature_schema;
    requireValid(schema && schema.version === 1 && sameNames(schema.names,names) && schema.n_features === 12 && schema.type === 'finite_numeric' && schema.order === 'runtime', 'legacy feature_schema mismatch');
  }
  const learner = exported.xgboost_model?.learner;
  requireValid(learner?.objective?.name === 'binary:logistic', 'unsupported objective');
  const param = learner.learner_model_param;
  requireValid(param && String(param.num_feature) === String(names.length) && String(param.num_class ?? 0) === '0' && String(param.num_target ?? 1) === '1', 'learner dimension mismatch');
  requireValid(!learner.feature_names?.length || sameNames(learner.feature_names, names), 'learner feature names mismatch');
  const base = typeof param.base_score === 'number' ? param.base_score : JSON.parse(param.base_score);
  const score = Array.isArray(base) && base.length === 1 ? base[0] : base;
  requireValid(finite(score) && score > 0 && score < 1, 'invalid logistic base_score');
  const booster = learner.gradient_booster;
  requireValid(booster?.name === 'gbtree', 'unsupported booster');
  const model = booster.model;
  const trees = model?.trees;
  requireValid(Array.isArray(trees) && trees.length > 0 && trees.length <= 10000, 'invalid trees');
  requireValid(Array.isArray(model.tree_info) && model.tree_info.length === trees.length && model.tree_info.every((v: any) => v === 0), 'invalid tree_info');
  if (model.gbtree_model_param?.num_trees !== undefined) requireValid(String(model.gbtree_model_param.num_trees) === String(trees.length), 'tree count mismatch');
  let totalNodes = 0;
  for (const tree of trees) {
    const n = tree.left_children?.length;
    requireValid(integer(n) && n > 0 && (totalNodes += n) <= 1000000, 'invalid node count');
    const keys = ['left_children','right_children','split_indices','split_conditions','base_weights','default_left'];
    requireValid(keys.every(k => Array.isArray(tree[k]) && tree[k].length === n), 'invalid tree arrays');
    requireValid(Array.isArray(tree.split_type) && tree.split_type.length === n && tree.split_type.every((v: any) => v === 0), 'categorical/invalid split_type');
    for (const k of ['categories','categories_nodes','categories_segments','categories_sizes']) requireValid(tree[k] === undefined || (Array.isArray(tree[k]) && tree[k].length === 0), 'categorical tree unsupported');
    requireValid(tree.tree_param === undefined || (String(tree.tree_param.num_nodes) === String(n) && String(tree.tree_param.num_feature) === String(names.length) && String(tree.tree_param.size_leaf_vector ?? 1) === '1' && String(tree.tree_param.num_deleted ?? 0) === '0'), 'invalid tree parameters');
    for (let i = 0; i < n; i++) {
      requireValid(finite(tree.base_weights[i]) && finite(tree.split_conditions[i]), 'nonfinite tree value');
      requireValid(integer(tree.split_indices[i]) && tree.split_indices[i] >= 0 && tree.split_indices[i] < names.length, 'invalid feature index');
      requireValid(tree.default_left[i] === 0 || tree.default_left[i] === 1, 'invalid missing branch');
      const l = tree.left_children[i], r = tree.right_children[i];
      requireValid(integer(l) && integer(r) && ((l === -1 && r === -1) || (l >= 0 && r >= 0 && l < n && r < n)), 'invalid children');
      if (profile === NATIVE_INFERENCE_PROFILE && l >= 0) {
        // XGBoost loads numeric thresholds as float32, just like its inputs.
        // Canonicalize only the owned native snapshot, never legacy12 or leaves.
        tree.split_conditions[i] = Math.fround(tree.split_conditions[i]);
        requireValid(finite(tree.split_conditions[i]), 'nonfinite float32 threshold');
      }
    }
    const seen = new Set<number>(), stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      requireValid(!seen.has(node), 'cycle/shared node'); seen.add(node);
      if (tree.left_children[node] >= 0) stack.push(tree.left_children[node], tree.right_children[node]);
    }
    requireValid(seen.size === n, 'unreachable nodes');
  }
  return { trees, meta, intercept: profile === NATIVE_INFERENCE_PROFILE ? Math.log(score / (1 - score)) : 0 };
}
/** Native profile only; NaN is a declared missing value, never a stand-in for absent context. */
export function predictNativeVector(model: ValidatedModel, features: readonly number[]): number {
  if (model.meta.inference_profile !== NATIVE_INFERENCE_PROFILE) throw new Error('native evaluator requires declared native profile');
  if (features.length !== model.meta.feature_names.length) throw new Error('invalid native vector dimension');
  for (let i = 0; i < features.length; i++) {
    const v = features[i];
    if (typeof v !== 'number' || (!Number.isFinite(Math.fround(v)) && !Number.isNaN(v))) throw new Error('invalid native vector value');
  }
  let raw = model.intercept;
  for (const tree of model.trees) {
    let i = 0;
    while (tree.left_children[i] >= 0) {
      const value = Math.fround(features[tree.split_indices[i]]);
      i = Number.isNaN(value) ? (tree.default_left[i] ? tree.left_children[i] : tree.right_children[i]) : value < tree.split_conditions[i] ? tree.left_children[i] : tree.right_children[i];
    }
    raw += tree.split_conditions[i];
  }
  return 1 / (1 + Math.exp(-raw));
}
