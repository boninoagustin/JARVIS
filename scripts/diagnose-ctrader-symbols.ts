import { config } from 'dotenv';
import { resolve } from 'path';
import { connect } from 'ctrader-ts';

config({ path: resolve(process.cwd(), '.env') });

async function main() {
    console.log('🔌 Conectando a cTrader Open API para diagnosticar símbolos...');
    
    if (!process.env.CTRADER_CLIENT_ID || !process.env.CTRADER_ACCESS_TOKEN) {
        console.error('❌ Falta configurar CTRADER_CLIENT_ID o CTRADER_ACCESS_TOKEN en el .env');
        process.exit(1);
    }

    try {
        const ctClient = await connect({
            clientId: process.env.CTRADER_CLIENT_ID,
            clientSecret: process.env.CTRADER_CLIENT_SECRET || '',
            accessToken: process.env.CTRADER_ACCESS_TOKEN,
            accountId: parseInt(process.env.CTRADER_ACCOUNT_ID || '0', 10),
            environment: process.env.CTRADER_DEMO === 'true' ? 'demo' : 'live',
        });

        console.log('✅ Conectado. Obteniendo información de símbolos...\n');

        const symbolsToTest = ['BTCUSD', 'XAUUSD', 'EURUSD'];

        for (const sym of symbolsToTest) {
            console.log(`\n======================================`);
            console.log(`🔍 Probando Símbolo Fijo: ${sym}`);
            console.log(`======================================`);
            try {
                const info = await ctClient.getSymbolInfo(sym);
                console.log(`✅ ¡Encontrado! lotSize: ${info.lotSize}, stepVolume: ${info.stepVolume}`);
            } catch (e: any) {
                console.log(`❌ Error: ${e.message}`);
            }
        }

        console.log(`\n======================================`);
        console.log(`🔎 BUSCANDO EL NOMBRE CORRECTO PARA EL NASDAQ (US100)...`);
        console.log(`======================================`);
        
        try {
            // Refresh cache to get all symbols
            await (ctClient as any).refreshSymbols(); // ctrader-ts actualiza el cache
            const allSymbols = Object.keys((ctClient as any).symbols || {});
            
            const nasdaqCandidates = allSymbols.filter(s => 
                s.toUpperCase().includes('US') || 
                s.toUpperCase().includes('TECH') || 
                s.toUpperCase().includes('100') ||
                s.toUpperCase().includes('NAS')
            );

            console.log(`Se encontraron ${nasdaqCandidates.length} posibles candidatos para índices de US/Tech:`);
            nasdaqCandidates.forEach(c => console.log(` - ${c}`));

        } catch (e: any) {
            console.log(`❌ No se pudo listar los símbolos: ${e.message}`);
        }

        console.log('\n✅ Diagnóstico finalizado.');
        process.exit(0);

    } catch (e: any) {
        console.error('❌ Error de conexión:', e.message);
        process.exit(1);
    }
}

main();
