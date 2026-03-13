import { processTradingAlert } from '../src/db/trading.js';

async function test() {
    await processTradingAlert("CONTEXT_LIQ | TEST | Simulación local");
}
test();
