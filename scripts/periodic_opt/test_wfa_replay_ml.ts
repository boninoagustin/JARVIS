import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSV, runBacktest } from '../../jarvis-os/src/services/backtestEngine';
import type { BacktestConfig } from '../../jarvis-os/src/services/backtestTypes';
import {LEGACY_FEATURE_NAMES} from '../../src/engine/MLModelValidation';

const start = Date.parse('2026-07-14T15:00:00Z');
const entries = parseCSV(`PING_PRICE | TF: 5 | Precio: 1.1 | High: 1.1002 | Low: 1.0998 | TS: ${start - 100}
EVENTO_CHOCH | TF: 5 | BUY | ORIGIN: 1.099 | Precio: 1.1 | TS: ${start + 1}
PING_PRICE | TF: 5 | Precio: 1.1 | TS: ${start + 60_000}`).lines;
const window = { warmupStartMs: start - 100, evaluationStartMs: start, evaluationEndMs: start + 120_000,
  statePolicy: 'context-only-reset-execution-v1' as const, minContextObservations: { '5': 1 } };
const config: BacktestConfig = { ticker: 'EURUSD', minBuyPoints: 1, minSellPoints: 1, oteEntryPercent: 70, entryTrigger: 'CHOCH' };
const dir = mkdtempSync(join(tmpdir(), 'wfa-engine-ml-'));
try {
  const model = (name: string, leaf: number) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ meta: { threshold: 0.65, accuracy: 0.7, f1: 0.7, train_samples: 1, n_features:12, feature_names:[...LEGACY_FEATURE_NAMES] }, xgboost_model: {learner:{objective:{name:'binary:logistic'},learner_model_param:{num_feature:'12',num_class:'0',base_score:'0.5'},gradient_booster:{name:'gbtree',model:{tree_info:[0],trees:[{left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[leaf],base_weights:[leaf],default_left:[1],split_type:[0]}]}}}} }));
    return path;
  };
  const a = model('approve.json', 10), b = model('reject.json', -10);
  const run = (path: string) => runBacktest(new Map(), { ...config, mlGate: { enabled: true, trainedAt: 0, modelPath: path } }, undefined, entries, window);
  const firstA = run(a), firstB = run(b), secondA = run(a);
  assert.equal(firstA.trades.length, 1);
  assert.equal(firstB.trades.length, 0);
  assert.equal(firstB.mlRejected, 1);
  assert.equal(secondA.trades.length, firstA.trades.length, 'A/B/A must reload A rather than inherit B from the per-ticker model cache');
  assert.equal(secondA.mlRejected, 0);
  console.log('PASS replay ML A/B/A model-cache isolation');
  assert.throws(() => run(join(dir, 'missing.json')), /replay.*model/i,
    'missing replay models cannot inherit a prior ticker model');
  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, '{}');
  assert.throws(() => run(invalid), /replay.*model/i);
  assert.throws(() => runBacktest(new Map(), { ...config, mlGate: { enabled: true } }, undefined, entries, window), /replay.*model/i);
  console.log('PASS replay ML missing/invalid model fail-closed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
