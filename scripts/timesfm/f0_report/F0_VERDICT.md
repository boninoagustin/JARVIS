# F0 — Benchmark de calibración TimesFM 2.5 200M (torch CPU, zero-shot)

- Modelo: `google/timesfm-2.5-200m-pytorch` (pkg timesfm 2.0.2)
- Contexto: 512 cierres · Horizontes: [6, 12, 24] velas
- Orígenes por dataset: 500 (stride determinista, seed fija)
- Look-ahead: cero (contexto = cierres ≤ T; realizado = T+1..T+H)

## Cobertura y calibración por dataset

| Dataset | H | Cobertura q10–q90 (step) | Cobertura path conjunta | Cal. error | PIT max dev (pp) |
|---|---|---|---|---|---|
| AUDCAD M15 | H6 | 79.4% ✅ | 54.6% | 0.0060 | 1.33 |
| AUDCAD M15 | H12 | 79.5% ✅ | 42.2% | 0.0050 | 1.65 |
| AUDCAD M15 | H24 | 78.4% ✅ | 31.2% | 0.0114 | 1.69 |
| AUDCAD M5 | H6 | 74.7% ✅ | 48.2% | 0.0223 | 3.43 |
| AUDCAD M5 | H12 | 73.6% ✅ | 36.2% | 0.0261 | 4.12 |
| AUDCAD M5 | H24 | 74.8% ✅ | 29.4% | 0.0203 | 2.94 |
| BTCUSD M15 | H6 | 78.1% ✅ | 54.6% | 0.0094 | 1.03 |
| BTCUSD M15 | H12 | 78.0% ✅ | 43.2% | 0.0057 | 1.23 |
| BTCUSD M15 | H24 | 77.1% ✅ | 35.0% | 0.0073 | 1.52 |
| BTCUSD M5 | H6 | 77.9% ✅ | 53.4% | 0.0110 | 1.20 |
| BTCUSD M5 | H12 | 77.5% ✅ | 44.6% | 0.0179 | 1.65 |
| BTCUSD M5 | H24 | 76.7% ✅ | 34.4% | 0.0112 | 1.72 |
| EURUSD M15 | H6 | 76.6% ✅ | 51.2% | 0.0140 | 1.87 |
| EURUSD M15 | H12 | 77.0% ✅ | 40.4% | 0.0118 | 2.05 |
| EURUSD M15 | H24 | 76.2% ✅ | 31.2% | 0.0128 | 2.53 |
| EURUSD M5 | H6 | 75.3% ✅ | 49.0% | 0.0229 | 3.63 |
| EURUSD M5 | H12 | 75.7% ✅ | 40.4% | 0.0172 | 2.95 |
| EURUSD M5 | H24 | 75.4% ✅ | 31.4% | 0.0188 | 3.12 |
| GBPUSD M15 | H6 | 77.0% ✅ | 52.4% | 0.0082 | 2.50 |
| GBPUSD M15 | H12 | 76.2% ✅ | 42.2% | 0.0075 | 2.50 |
| GBPUSD M15 | H24 | 77.1% ✅ | 36.0% | 0.0073 | 2.06 |
| GBPUSD M5 | H6 | 77.7% ✅ | 52.2% | 0.0109 | 1.47 |
| GBPUSD M5 | H12 | 77.5% ✅ | 42.4% | 0.0103 | 1.70 |
| GBPUSD M5 | H24 | 76.9% ✅ | 34.6% | 0.0130 | 1.80 |
| NZDUSD M15 | H6 | 77.8% ✅ | 52.0% | 0.0095 | 1.37 |
| NZDUSD M15 | H12 | 77.3% ✅ | 40.8% | 0.0074 | 1.48 |
| NZDUSD M15 | H24 | 75.8% ✅ | 29.8% | 0.0124 | 2.41 |
| NZDUSD M5 | H6 | 77.9% ✅ | 48.6% | 0.0140 | 1.53 |
| NZDUSD M5 | H12 | 77.9% ✅ | 40.2% | 0.0136 | 1.62 |
| NZDUSD M5 | H24 | 78.0% ✅ | 32.4% | 0.0114 | 1.58 |
| US500 M15 | H6 | 76.1% ✅ | 53.0% | 0.0097 | 2.47 |
| US500 M15 | H12 | 75.1% ✅ | 44.0% | 0.0136 | 2.95 |
| US500 M15 | H24 | 73.6% ✅ | 34.0% | 0.0178 | 3.95 |
| US500 M5 | H6 | 75.1% ✅ | 50.4% | 0.0180 | 3.43 |
| US500 M5 | H12 | 76.4% ✅ | 41.4% | 0.0161 | 2.48 |
| US500 M5 | H24 | 76.3% ✅ | 31.8% | 0.0133 | 2.48 |
| USDCAD M15 | H6 | 76.1% ✅ | 50.8% | 0.0144 | 3.17 |
| USDCAD M15 | H12 | 76.4% ✅ | 41.0% | 0.0102 | 2.25 |
| USDCAD M15 | H24 | 77.3% ✅ | 32.0% | 0.0081 | 1.59 |
| USDCAD M5 | H6 | 76.2% ✅ | 50.4% | 0.0236 | 2.67 |
| USDCAD M5 | H12 | 77.0% ✅ | 39.6% | 0.0183 | 1.90 |
| USDCAD M5 | H24 | 77.5% ✅ | 33.8% | 0.0156 | 2.10 |
| USDJPY M15 | H6 | 78.7% ✅ | 54.4% | 0.0226 | 1.80 |
| USDJPY M15 | H12 | 78.3% ✅ | 43.0% | 0.0272 | 2.27 |
| USDJPY M15 | H24 | 78.3% ✅ | 30.6% | 0.0303 | 2.78 |
| USDJPY M5 | H6 | 77.0% ✅ | 49.0% | 0.0192 | 2.57 |
| USDJPY M5 | H12 | 76.6% ✅ | 38.6% | 0.0218 | 2.57 |
| USDJPY M5 | H24 | 76.8% ✅ | 30.2% | 0.0287 | 2.57 |
| USOIL M15 | H6 | 78.4% ✅ | 57.4% | 0.0042 | 1.23 |
| USOIL M15 | H12 | 76.7% ✅ | 43.0% | 0.0083 | 2.13 |
| USOIL M15 | H24 | 74.9% ✅ | 33.4% | 0.0150 | 2.93 |
| USOIL M5 | H6 | 80.2% ✅ | 56.0% | 0.0046 | 0.87 |
| USOIL M5 | H12 | 79.3% ✅ | 47.0% | 0.0037 | 1.12 |
| USOIL M5 | H24 | 77.7% ✅ | 35.8% | 0.0079 | 1.62 |

## Agregado por TF × horizonte (pooling de todos los activos)

| TF | H | Cobertura media | PIT bins min–max % | PIT uniforme | Gate cobertura |
|---|---|---|---|---|---|
| M15 | H6 | 77.6% | 9.0–11.3 | ✅ | ✅ |
| M15 | H12 | 77.2% | 8.9–11.5 | ✅ | ✅ |
| M15 | H24 | 76.5% | 9.0–12.1 | ✅ | ✅ |
| M5 | H6 | 76.9% | 9.2–11.7 | ✅ | ✅ |
| M5 | H12 | 76.8% | 9.2–11.7 | ✅ | ✅ |
| M5 | H24 | 76.7% | 9.2–11.8 | ✅ | ✅ |

## Latencia single-call en vivo (CPU, contexto=512, H=24)

- P50: **1096.3 ms** · P95: 1575.9 ms · P99: 1853.5 ms · media 1153.4 ms (98 llamadas)
- Throughput batched amortizado: 1309 ms/forecast (plano: compute-bound, batching no acelera)

## VEREDICTO DEL GATE

- Datasets con cobertura ≥ 70%: **54/54** celdas (dataset×H)
- Cobertura media global: **76.9%** (mín 73.6%, máx 80.2%)
- PIT uniforme en todos los agregados TF×H: sí

### ✅ GATE SUPERADO — se habilita F2 (TP dinámico con q90) además de F1
