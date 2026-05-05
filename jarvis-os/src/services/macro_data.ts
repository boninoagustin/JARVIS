/**
 * Macro Data Fetcher — DXY, VIX, US10Y, BTC Dominance, Fear & Greed
 * Corre del lado del cliente (browser) — sin dependencias del backend.
 */

const FINNHUB_KEY = 'd7pt291r01qosaaprsr0d7pt291r01qosaaprsrg';

export interface MacroIndicator {
  label: string;
  value: string;
  status: 'buy' | 'sell' | 'neutral' | 'alert';
  interpretation: string;
}

let cachedMacros: MacroIndicator[] | null = null;
let lastFetch = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 min cache

export async function fetchMacroIndicators(): Promise<MacroIndicator[]> {
  const now = Date.now();
  if (cachedMacros && (now - lastFetch) < CACHE_MS) {
    return cachedMacros;
  }

  const results: MacroIndicator[] = [
    { label: 'DXY (Índice Dólar)', value: '—', status: 'neutral', interpretation: 'Cargando...' },
    { label: 'VIX (Volatilidad)', value: '—', status: 'neutral', interpretation: 'Cargando...' },
    { label: 'US 10Y Yield', value: '—', status: 'neutral', interpretation: 'Cargando...' },
    { label: 'Dominancia BTC', value: '—', status: 'neutral', interpretation: 'Cargando...' },
    { label: 'Fear & Greed', value: '—', status: 'neutral', interpretation: 'Cargando...' },
  ];

  try {
    const dxyRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=ICE_DX&token=${FINNHUB_KEY}`);
    if (dxyRes.ok) {
      const dxyData = await dxyRes.json();
      if (dxyData.c) {
        const dxy = dxyData.c;
        results[0].value = dxy.toFixed(2);
        results[0].status = dxy > 105 ? 'sell' : dxy < 100 ? 'buy' : 'neutral';
        results[0].interpretation = dxy > 105 ? 'Dólar fuerte: presión bajista en EURUSD, Oro y BTC' :
                                     dxy < 100 ? 'Dólar débil: favorable para riesgo' : 'Rango neutral';
      }
    }
  } catch { /* keep defaults */ }

  try {
    const vixRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_KEY}`);
    if (vixRes.ok) {
      const vixData = await vixRes.json();
      if (vixData.c) {
        const vix = vixData.c;
        results[1].value = vix.toFixed(2);
        results[1].status = vix > 25 ? 'sell' : vix < 15 ? 'buy' : 'neutral';
        results[1].interpretation = vix > 25 ? 'Miedo extremo: riesgo de liquidaciones' :
                                     vix < 15 ? 'Complacencia: Risk On favorable' : 'Volatilidad normal';
      }
    }
  } catch { /* keep defaults */ }

  try {
    const yieldRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=US10Y&token=${FINNHUB_KEY}`);
    if (yieldRes.ok) {
      const yieldData = await yieldRes.json();
      if (yieldData.c) {
        const yld = yieldData.c;
        results[2].value = yld.toFixed(2) + '%';
        results[2].status = yld > 4.5 ? 'sell' : yld < 3.5 ? 'buy' : 'neutral';
        results[2].interpretation = yld > 4.5 ? 'Yields altos: presión en oro, crypto y growth stocks' :
                                     yld < 3.5 ? 'Yields bajos: favorable para risk assets' : 'Nivel moderado';
      }
    }
  } catch { /* keep defaults */ }

  try {
    const btcRes = await fetch('https://api.coingecko.com/api/v3/global');
    if (btcRes.ok) {
      const btcData = await btcRes.json();
      const dominance = btcData?.data?.market_cap_percentage?.btc;
      if (dominance) {
        results[3].value = dominance.toFixed(1) + '%';
        results[3].status = dominance > 55 ? 'alert' : 'neutral';
        results[3].interpretation = dominance > 55 ? 'BTC absorbiendo liquidez: altcoins débiles' : 'Distribución normal';
      }
    }
  } catch { /* keep defaults */ }

  try {
    const fgRes = await fetch('https://api.alternative.me/fng/?limit=1');
    if (fgRes.ok) {
      const fgData = await fgRes.json();
      const fgValue = parseInt(fgData?.data?.[0]?.value || '50');
      const fgClassification = fgData?.data?.[0]?.value_classification || 'Neutral';
      results[4].value = fgValue.toString();
      results[4].status = fgValue > 70 ? 'alert' : fgValue < 30 ? 'buy' : 'neutral';
      results[4].interpretation = fgClassification;
    }
  } catch { /* keep defaults */ }

  cachedMacros = results;
  lastFetch = now;
  return results;
}
