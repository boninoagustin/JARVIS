# Tanda de backtest — Divergencias Pine↔TS (T5, Objetivo 1)

**08-oct-2026**. A/B de las 3 divergencias de estrategia sobre el motor real (`backtestEngine.ts`), midiendo **conteo de eventos SMC** (determinístico) + **backtest** (trades/R). Rango 2026-01-01 → 2026-10-02, config SMART, minScore 8/6, sesiones LONDON+NY+ASIA.

**Método**: `export_smc_csv.ts <TICKER>` (regenera eventos SMC con el SMCEngine) → `backtest_server.ts <TICKER> "M5,M15,H1,H4"` (motor real).

## Resultados — conteo de eventos (determinístico)

| Variante | EURUSD SWEEP | EURUSD LIQ | XAUUSD SWEEP | GBPUSD SWEEP | zonas vacías |
|---|---|---|---|---|---|
| **Baseline** (Z no direccional) | 23 | 79 | — | — | 426 |
| **Div 1**: gate `\|Z\|≥2` eliminado | **719** | **1004** | — | — | — |
| **Div 2**: VWAP → penalización | 23 | 79 | — | — | **163** |
| **Div 3**: gate `max(\|zUp\|,\|zDn\|)` direccional | **103** | 88 | **119** | **304** | — |

## Resultados — backtest (muestra insuficiente)

| Variante | EURUSD | XAUUSD | GBPUSD |
|---|---|---|---|
| Baseline | 5 trades, -2.05R | — | — |
| Div 1 (eliminar gate) | 8 trades, **-5.26R** | — | — |
| Div 2 (VWAP pen.) | 4 trades, -2.18R | — | — |
| Div 3 (gate direccional) | 6 trades, -3.13R | 17 trades, +0.00R* | 6 trades, -2.22R |

\* XAUUSD 17 trades / WR 100% / totalR +0.004 → artefacto: cierran en breakeven con rMultiple≈0 (posible issue de decimales/spread en XAU, no de Div 3).

## Interpretación

### Concluyente (determinístico)
1. **El gate `|Z|≥2` sobre el Z no direccional aniquila los sweeps** (23 en 9m). Eliminarlo → 719 (31×), demasiado ruido.
2. **Div 3 (gate direccional `max(|zUp|,|zDn|)`) es el punto medio correcto**: restaura sweeps a cientos (103-304 en 3 tickers) manteniendo un filtro de impulso real. Es estructuralmente la solución correcta — el Z no direccional no distingue impulso alcista de bajista; `zUp`/`zDn` (Pine:396-412) sí.
3. El filtro duro de VWAP descarta OBs (426→163 zonas vacías al suavizarlo).

### NO concluyente (muestra de trades insuficiente)
- 4-17 trades por variante en 9 meses. **Ninguna variante muestra mejora de R**; el período es perdedor para todos los configs probados y el N es demasiado chico. No se puede validar el impacto económico de Div 3 con esta historia.

## Recomendación
- **NO aplicar** Div 1 ni Div 2 al vivo (sin mejora, Div 1 degrada).
- **Div 3 es el cambio correcto en diseño**, pero su valor económico requiere validación con: más historia (multi-año), más tickers, y un config más permisivo (minScore más bajo) para generar más trades. Proponer como tanda de backtest dedicada antes de decidir.

## Estado del código
Revertido a baseline (`liquidity.ts`, `order_blocks.ts`, `zscore.ts`, `SMCEngine.ts` idénticos al estado previo, verificado con `diff -q`). El bot vivo nunca cargó los cambios de estrategia (no se reinició durante el A/B, sigue ↺1030).
