// Clasificación de sesión de trading por timestamp (Argentina UTC-3, sin DST).
// Extraído del antiguo backtestEngine para que el Diario Analítico no dependa
// del módulo de backtesting.

export type SessionName = 'LONDON' | 'NY' | 'ASIA' | 'OFF';

export function getSessionForTimestamp(ts: number): SessionName {
  // Argentina is UTC-3 all year round
  const d = new Date(ts - 3 * 3600 * 1000);
  const arHour = d.getUTCHours();
  const arMin = d.getUTCMinutes();
  const timeDecimal = arHour + arMin / 60;

  if (timeDecimal >= 21 || timeDecimal < 4) return 'ASIA';
  if (timeDecimal >= 4 && timeDecimal < 10.5) return 'LONDON';
  if (timeDecimal >= 10.5 && timeDecimal < 17) return 'NY';

  return 'OFF';
}
