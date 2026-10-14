// smoke del módulo de renovación automática del token de cTrader
import { refreshIfNeeded, tokenRemainingMs } from '../src/services/ctraderToken.js';

(async () => {
    const r = await refreshIfNeeded();
    console.log('refresh ejecutado:', r);
    console.log('días restantes del token ahora:', (tokenRemainingMs() / 86400000).toFixed(1));
    process.exit(0);
})();
