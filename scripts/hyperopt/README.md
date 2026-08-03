# JARVIS Hyperopt — Bayesian Optimization (Optuna)

Inspirado en la arquitectura de Freqtrade `freqtrade/optimize/hyperopt.py`. Reemplaza
los bucles Grid Search de:

- `scripts/meta-optimize.ts` (900 combinaciones hard-coded)
- `scripts/smc_bruteforcer.ts` (Coordinate Descent secuencial, ~390+150)
- `handleOptimizeTrigger` en `jarvis-os/src/components/BacktestingPanel.tsx` (1.152 combos, inyectado por `implement_autotune.py` / `add_handle_optimize.py`)

## Arquitectura

```
┌─────────────────────┐    JSON-RPC (stdin/stdout NDJSON)    ┌──────────────────────┐
│   Python (Optuna)   │ ◄──────────────────────────────────► │   TS Worker          │
│                     │                                      │ jarvis_hyperopt_     │
│  - TPE Sampler      │  {"method":"evaluate",               │ worker.ts            │
│  - Sugiere params   │   "params":{config}}                 │                      │
│  - Persiste SQLite  │ ────► {"result":{metrics, objective}}│ - loadLogsFromDir()  │
│  - Penaliza DD      │                                      │ - runBacktest()      │
│                     │                                      │ - computeMetrics()   │
└─────────────────────┘                                      └──────────────────────┘
```

## Quickstart

```bash
# 1) Setup (una sola vez)
cd /home/bon/Descargas/JARVIS
python3 -m venv scripts/hyperopt/.venv
scripts/hyperopt/.venv/bin/pip install optuna numpy
npm install --save-dev tsx   # si no estaba

# 2) Smoke-test (5 trials, ~30 segundos)
python scripts/hyperopt/run_hyperopt.py EURUSD --smoke-test

# 3) Optimización real
python scripts/hyperopt/run_hyperopt.py EURUSD --n-trials 200
python scripts/hyperopt/run_hyperopt.py XAUUSD --n-trials 300 --study-name jarvis_xau_v2

# 4) Cargar mejores parámetros al formato que smc_config.ts ya entiende
python scripts/hyperopt/load_best_params.py optimized_preset_eurusd_hyperopt.json
# Genera/sobreescribe optimized_preset_EURUSD.json
```

## Función objetivo

```
obj = ProfitFactor - 2.0 * MaxDrawdownR - 0.5 * |trades - 200| / 200 + 0.1 * Expectancy
```

- Si `trades < 30`: penalización fuerte (-10 * (1 - n/30)).
- Si `trades == 0`: -100 (igual que `smc_bruteforcer.ts:101`).
- Se MAXIMIZA (Optuna convierte internamente según `direction`).

## Espacio de búsqueda

14 parámetros cubriendo SMC engine, Risk, Scoring y Trade Management.
Mismos rangos que los grids actuales (continuos donde antes eran discretos):
`pivot_len ∈ [3,21]`, `min_sweep_wick_pct ∈ [0.05, 0.8]`, `div_pivot_len ∈ [2,7]`,
`z_score_window ∈ {14,20,50,100}`, `slBufferPercent ∈ [0, 0.25]`, `fixedRR ∈ [1.2, 5.0]`,
`minRR ∈ [1.0, 3.0]`, `oteEntryPercent ∈ {50,62,79}`, `minBuyPoints ∈ [3,12]`,
`minSellPoints ∈ [3,12]`, `partialClosePct ∈ {0, 0.5, 0.8}`, `slAfterTp1 ∈ {none,midpoint,breakeven}`,
`tp15BeEnabled ∈ {T,F}`, `atrTrailEnabled ∈ {T,F}`.

## Archivos

| Archivo | Rol |
|---|---|
| `hyperopt_server.py` | Motor Optuna TPE. Lanza el worker, itera trials, persiste en SQLite |
| `jarvis_hyperopt_worker.ts` | JSON-RPC wrapper sobre `runBacktest` (jarvis-os) |
| `metrics.py` | Cálculo de TradeMetrics + función objetivo (replicada en TS) |
| `run_hyperopt.py` | CLI de entrada — resuelve log_dir automáticamente |
| `load_best_params.py` | Convierte output JSON al formato `optimized_preset_<TICKER>.json` |

## Limitaciones conocidas

- El worker TS recibe los SMC engine params pero NO los aplica al engine
  todavía (los logs Pine fueron generados con los params originales). Para
  aplicar SMC params al log generation hay que migrar a `smc_bruteforcer.ts`
  flujo (re-generar logs por TF con cada SMC gene). Esto queda para Fase 2.
- Sin warm-start automático de estudios anteriores (más allá del load_if_exists
  de Optuna).
- No hay pruning: si un trial tiene 0 trades, Optuna igual lo evalúa completo.
  Se podría agregar `HyperbandPruner` con un trial wrapper que reporte después
  de procesar el primer 25% de eventos.
