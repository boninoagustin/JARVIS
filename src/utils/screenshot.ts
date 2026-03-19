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
            userDataDir: PROFILE_DIR,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: {
                width: 1366,
                height: 768
            }
        });

        const page = await browser.newPage();
        
        console.log(`[PUPPETEER] Navegando a ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        
        // Esperar 8 segundos para que carguen todos los indicadores
        console.log(`[PUPPETEER] Esperando carga de indicadores...`);
        await new Promise(r => setTimeout(r, 8000));

        // Cerrar cualquier popup/modal que tape el gráfico
        try {
            // Botón X de cierre de modales
            const closeButtons = await page.$$('[class*="close"], [class*="Close"], [aria-label="Close"], [data-name="close"]');
            for (const btn of closeButtons) {
                await btn.click().catch(() => {});
            }

            // Buscar "Decline offer" o cualquier botón de rechazo
            const declineBtn = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const decline = buttons.find(b => 
                    b.textContent?.includes('Decline') || 
                    b.textContent?.includes('No thanks') ||
                    b.textContent?.includes('Not now') ||
                    b.textContent?.includes('Later') ||
                    b.textContent?.includes('Dismiss')
                );
                if (decline) { decline.click(); return true; }
                return false;
            });
            if (declineBtn) console.log('[PUPPETEER] Popup de oferta cerrado.');

            // Cerrar overlays con botón X genérico
            await page.evaluate(() => {
                // Remover overlays/modales del DOM si siguen visibles
                document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popup"], [class*="dialog"]').forEach(el => {
                    const style = window.getComputedStyle(el);
                    if (style.position === 'fixed' || style.position === 'absolute') {
                        (el as HTMLElement).style.display = 'none';
                    }
                });
            });
        } catch (_) {
            // Si no hay popups, no pasa nada
        }

        // Esperar un momento más después de cerrar popups
        await new Promise(r => setTimeout(r, 2000));

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
