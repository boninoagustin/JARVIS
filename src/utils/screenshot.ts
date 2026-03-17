import puppeteer from 'puppeteer';
import path from 'path';
import os from 'os';

const PROFILE_DIR = path.join(os.homedir(), '.jarvis-chrome-profile');

export async function takeTradingViewScreenshot(symbol: string): Promise<Buffer | null> {
    const url = `https://www.tradingview.com/chart/orjqnC70/?symbol=${symbol}&interval=15`;
    console.log(`[PUPPETEER] Abriendo navegador para capturar ${symbol}...`);
    
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            userDataDir: PROFILE_DIR, // Usa perfil persistente con sesión de TradingView
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: {
                width: 1920,
                height: 1080
            }
        });

        const page = await browser.newPage();
        
        console.log(`[PUPPETEER] Navegando a ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Esperar a que carguen las velas
        await new Promise(r => setTimeout(r, 5000));
        
        console.log(`[PUPPETEER] Tomando captura de pantalla...`);
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
        
        await browser.close();
        console.log(`[PUPPETEER] Captura tomada con éxito.`);
        
        return Buffer.from(screenshotBuffer);
    } catch (error: any) {
        console.error('[PUPPETEER] Error tomando captura:', error.message);
        if (browser) {
            await browser.close().catch(() => {});
        }
        return null;
    }
}
