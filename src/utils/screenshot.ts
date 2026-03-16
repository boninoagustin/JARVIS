import puppeteer from 'puppeteer';

export async function takeTradingViewScreenshot(symbol: string): Promise<Buffer | null> {
    const url = `https://www.tradingview.com/chart/?symbol=${symbol}`;
    console.log(`[PUPPETEER] Abriendo navegador para capturar ${symbol}...`);
    
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true, // Funciona en background sin interfaz visual
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: {
                width: 1920,
                height: 1080
            }
        });

        const page = await browser.newPage();
        
        console.log(`[PUPPETEER] Navegando a ${url}...`);
        
        // Vamos a la URL, esperamos a que el network esté idle así el gráfico terminó de dibujar
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Agregamos un delay extra de 3 segundos por las dudas para que carguen las velas
        await new Promise(r => setTimeout(r, 3000));
        
        console.log(`[PUPPETEER] Tomando captura de pantalla...`);
        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 90 });
        
        await browser.close();
        console.log(`[PUPPETEER] Captura tomada con éxito.`);
        
        // Cast Buffer since Page.screenshot returns Uint8Array or Buffer but we strictly need Buffer for Grammy
        return Buffer.from(screenshotBuffer);
    } catch (error: any) {
        console.error('[PUPPETEER] Error tomando captura:', error.message);
        if (browser) {
            await browser.close().catch(() => {});
        }
        return null;
    }
}
