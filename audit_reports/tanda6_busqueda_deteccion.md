# Búsqueda de detección SMC — EURUSD (experimento 09-oct-2026)

**Contexto**: la Capa 1 (detección SMC) quedó sin optimizar desde la deprecación del bruteforcer
(`scripts/smc_bruteforcer.ts` → "reemplazado por hyperopt"), y Optuna la excluye explícitamente
(`hyperopt_server.py:79`). Se construyó una búsqueda de detección con el motor real.

## Herramienta
`_audit_tmp/smc_detection_search.ts` — random search determinista (mulberry32 seed 42) sobre 13
umbrales de detección (pivot_len, min_sweep_wick_pct, div_pivot_len, z_score_window,
require_displacement, require_fvg_after_ob, strict_breaker, strict_sweep, confirm_close,
min_ob_body_pct, use_body_for_ob, fvg_min_atr, wick_invalidates_ob). Cada trial evalúa con
`SMCEngine` (presets de producción por TF + overrides) + `runBacktest` (motor real), replicando
el pipeline de `export_smc_csv.ts` (HTF context M5→H1/M15→H4/H1→D1, div zones, VWAP, ORIGIN).
Modos: búsqueda sobre rango, y `eval` (validación OOS con warmup del train, como en vivo).

## Resultados

### Búsqueda período completo (120 trials)
- Baseline (producción): **-24.65R / 147 trades**.
- Mejor: +13.41R / 69 trades. 73/120 (61%) superan al baseline.

### Búsqueda train (2026-01-01 → 15-jun, 100 trials)
- Baseline: -13.34R / 94 trades. Mejor: +9.69R / 58 trades. 62/100 superan al baseline.

### Importancia de parámetros (R promedio por valor, train)
| Param | Valores (R medio) |
|---|---|
| **pivot_len** | **3: -17.8 · 5: -5.7 · 8: -17.5 · 13: +5.0 · 21: +5.6** |
| min_ob_body_pct | 0.05: -4.1 · 0.1: -8.8 (actual) · 0.3: -4.9 |
| use_body_for_ob | false: -4.4 · true: -8.5 (actual) |
| z_score_window | 14: -3.4 (actual, el mejor) |
| strict_sweep | true: -4.5 · false: -8.1 |
| div_pivot_len | 2: -3.7 (actual) · 3: -8.9 · 5: -5.5 |

### Validación out-of-sample (15-jun → 02-oct, warmup del train)
| Config | EURUSD test | GBPUSD test |
|---|---|---|
| Baseline producción | **-10.23R** (52t) | +3.12R (46t) |
| Solo pivot_len=21 (resto producción) | **+5.46R** (26t) | +0.09R (17t) |
| Consenso mejores valores | +5.25R (26t) | +1.28R (19t) |
| Top2/3/4 del train (pivot 21) | +4.2 / +5.3 / +5.3R | — |

## Conclusión
1. **El preset de detección de EURUSD está mal calibrado**: pivot 3/3/8/3 es el peor rango de todo
   el espacio (-17R en train, -10R en test). Con pivot_len=21 pasa a +5.5R OOS (solo ese cambio;
   el resto de params suma poco).
2. **La mejora es específica del activo**: GBPUSD ya tiene pivots largos (21/5/13/5, del
   bruteforcer viejo) y su baseline anda positivo (+3.1R OOS); el pivot 21 uniforme no lo mejora.
   La señal "pivot largo" no es universal.
3. **Cambio propuesto (mínimo)**: `optimized_preset_EURUSD.json` → pivot_len 21 en M15/H1/H4/D1.
   4 números de configuración, revertible sin tocar código.

## Cautelas
- Un solo período (9 meses, 2026) y un ticker; muestra OOS de ~26 trades.
- Top1 del train (+9.7R) NO generalizó (-9.3R test) → el random search puro sobreajusta;
  el cambio recomendado es el pivot 21 (señal consistente en train y test), no el top.

## Corrida multi-activo (10-oct-2026) — todos los activos habilitados
Búsqueda de 100 trials por activo (train 60%) + validación OOS del top-1 (test 40%, warmup).

| Ticker | Baseline train | Baseline OOS | Top1 train | Top1 OOS | Acción |
|---|---|---|---|---|---|
| EURUSD | -13.34R | -10.23R | +9.69R | +5.46R | ✅ pivot 21 aplicado |
| JP225 | +3.01R | -4.25R | +25.64R | **+11.81R** | ✅ top1 aplicado |
| NL25 | -2.61R | +2.99R | +3.95R | +5.41R | ✅ top1 aplicado |
| AUDCAD | -8.02R | -9.34R | +8.65R | -7.40R | ✅ top1 aplicado (mejora marginal +1.9R) |
| AUDJPY | -4.95R | -4.11R | +10.43R | -6.67R | ❌ top1 empeora OOS |
| USDJPY | -6.49R | +10.78R | -2.22R | +2.09R | ❌ baseline OOS gana (0/100 trials mejoran train — problema de scoring/gestión, no detección) |
| XAUUSD | +6.43R | +14.65R | +14.20R | +10.37R | ❌ baseline gana, no tocar |
| FRA40 | +3.80R | +4.22R | +12.17R | -2.00R | ❌ baseline gana |
| EUROPE50 | +6.80R | +6.80R | +4.24R | — | ❌ baseline gana |
| USOIL | +3.92R | +0.74R | +5.96R | +0.41R | ❌ no mejora |

**Patrón por activo**: los índices (JP225/NL25/FRA40) quieren pivot CORTO (3); los FX (EURUSD/AUDJPY)
quieren pivot LARGO (21); XAUUSD oro óptimo en 8. Cada activo tiene su personalidad — la búsqueda
por-activo es el enfoque correcto.

**Sistema automático (activo desde 10-oct-2026)**:
- `scripts/periodic_opt/smc_detection_search.ts` modos: search/eval/tune.
- `jarvis-detection-tune.timer` — dom 02:00 CEST: tune por activo (80 trials, train 70%),
  regla conservadora (aplicar solo si OOS +1R con train ≥ -1R y muestra ≥8 trades, o train +5R
  con OOS ≥ -1R), backup `.bak-pre-detection` automático, `pm2 restart JARVIS` solo si se aplicó.
- Protecciones: flock anti-duplicados, heap 2560, oom_score_adj=-1000 para JARVIS.

## Incidente OOM (10-oct-2026)
Dos búsquedas paralelas (re-lanzamiento por notify espurio) pican ~4GB → OOM killer mató al bot
(↺1032, se recuperó solo). Lecciones aplicadas: heap máx 2560, un proceso a la vez (flock),
bot blindado con oom_score_adj -1000 (el wrapper lo re-aplica tras cada restart).

## Bugs de integración destapados en el camino (el repo los tiene, no se tocaron)
1. `runBacktest` retorna 0 trades silenciosamente si no se pasa `prepareEntries` como 4º arg.
2. El HTF context requiere búsqueda menor-o-igual por timestamp (un `Map.get` exacto lo deja
   Neutral casi siempre).
3. `export_smc_csv.ts` estampa `TF: M5` (no `5`) — quirk que el backtest interpreta distinto.
4. El `SMCEngine` debe recibir el nombre del periodo ('M15'), no el código ('15').
