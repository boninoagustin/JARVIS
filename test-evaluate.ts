import { evaluateWithKronos } from './src/services/kronos';

async function main() {
    console.log("Evaluating...");
    const res = await evaluateWithKronos('BTCUSDT', 'BUY');
    console.log(res);
}

main().catch(console.error);
