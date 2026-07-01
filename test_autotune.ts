import { runAutoTune } from './src/services/autotune';

async function main() {
    console.log("Iniciando prueba de autotune...");
    try {
        await runAutoTune();
        console.log("Autotune finalizado.");
    } catch (e) {
        console.error("Error en autotune:", e);
    }
}

main();
