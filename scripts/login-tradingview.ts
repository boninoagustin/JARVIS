import puppeteer from 'puppeteer';
import path from 'path';
import os from 'os';

/**
 * Script para loguear TradingView en Puppeteer UNA VEZ.
 * Abre un navegador visible donde podés hacer login manual.
 * Las cookies quedan guardadas en ~/.jarvis-chrome-profile/
 * y el worker las reutiliza en cada captura.
 *
 * Ejecutar: npx tsx scripts/login-tradingview.ts
 */
const PROFILE_DIR = path.join(os.homedir(), '.jarvis-chrome-profile');

async function main() {
    console.log('[LOGIN] Abriendo navegador con perfil persistente...');
    console.log(`[LOGIN] Perfil guardado en: ${PROFILE_DIR}`);

    const browser = await puppeteer.launch({
        headless: false, // Navegador VISIBLE para que puedas hacer login
        userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: { width: 1366, height: 768 }
    });

    const page = await browser.newPage();
    await page.goto('https://www.tradingview.com/accounts/signin/', { waitUntil: 'networkidle2' });

    console.log('\n========================================');
    console.log('  Logueate en TradingView en el navegador');
    console.log('  que se acaba de abrir.');
    console.log('  Cuando termines, cerrá el navegador.');
    console.log('========================================\n');

    // Esperar a que el usuario cierre el navegador
    await new Promise<void>(resolve => {
        browser.on('disconnected', () => resolve());
    });

    console.log('[LOGIN] Navegador cerrado. Sesión guardada en:', PROFILE_DIR);
    console.log('[LOGIN] Ahora el screenshot worker va a usar esta sesión automáticamente.');
    process.exit(0);
}

main().catch(console.error);
