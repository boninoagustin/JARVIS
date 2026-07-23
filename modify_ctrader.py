import re

with open('src/services/ctrader.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = r"""let ctClient: any = null;
let isConnected = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ─── Connection Management ───

/\*\*
 \* Initialize connection to cTrader Open API.
 \* Uses lazy initialization — connects on first use.
 \*/
export async function connectCTrader\(\): Promise<boolean> \{
    if \(!config\.CTRADER_CLIENT_ID \|\| !config\.CTRADER_ACCESS_TOKEN\) \{
        console\.warn\('\[CTRADER\] ⚠️ Credenciales no configuradas en \.env\. Servicio deshabilitado\.'\);
        return false;
    \}

    if \(isConnected && ctClient\) \{
        return true;
    \}

    try \{
        connectionAttempts\+\+;
        console\.log\(`\[CTRADER\] 🔌 Conectando a cTrader Open API \(intento \$\{connectionAttempts\}\)\.\.\.`\);
        console\.log\(`\[CTRADER\] Modo: \$\{config\.CTRADER_DEMO \? 'DEMO 🧪' : 'LIVE 🔴'\}\`\);
        
        const \{ connect \} = await import\('ctrader-ts'\);
        
        ctClient = await connect\(\{
            clientId: config\.CTRADER_CLIENT_ID,
            clientSecret: config\.CTRADER_CLIENT_SECRET,
            accessToken: config\.CTRADER_ACCESS_TOKEN,
            accountId: parseInt\(config\.CTRADER_ACCOUNT_ID, 10\) \|\| 0,
            environment: config\.CTRADER_DEMO \? 'demo' : 'live',
        \}\);
        
        isConnected = true;
        connectionAttempts = 0;
        console\.log\('\[CTRADER\] ✅ Conectado exitosamente a cTrader\.'\);
        
        setupCTraderEvents\(ctClient\);
        
        return true;
    \} catch \(err: any\) \{
        isConnected = false;
        ctClient = null;
        console\.error\(`\[CTRADER\] ❌ Error de conexión \(intento \$\{connectionAttempts\}\):`, err\.message\);
        
        if \(connectionAttempts < MAX_RECONNECT_ATTEMPTS\) \{
            const delay = Math\.min\(5000 \* connectionAttempts, 30000\);
            console\.log\(`\[CTRADER\] 🔄 Reintentando en \$\{delay / 1000\}s\.\.\.`\);
            await new Promise\(r => setTimeout\(r, delay\)\);
            return connectCTrader\(\);
        \}

        console\.error\('\[CTRADER\] ⛔ Max reintentos alcanzado\. Servicio offline\.'\);
        return false;
    \}
\}"""

replacement = """let ctClient: any = null;
let isConnected = false;
let connectingPromise: Promise<boolean> | null = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ─── Connection Management ───

/**
 * Initialize connection to cTrader Open API.
 * Uses lazy initialization — connects on first use.
 */
export async function connectCTrader(): Promise<boolean> {
    if (!config.CTRADER_CLIENT_ID || !config.CTRADER_ACCESS_TOKEN) {
        console.warn('[CTRADER] ⚠️ Credenciales no configuradas en .env. Servicio deshabilitado.');
        return false;
    }
    
    if (isConnected && ctClient) return true;
    if (connectingPromise) return connectingPromise; // single-flight
    
    connectingPromise = connectWithRetry().finally(() => { connectingPromise = null; });
    return connectingPromise;
}

async function connectWithRetry(): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        try {
            console.log(`[CTRADER] 🔌 Conectando a cTrader Open API (intento ${attempt})...`);
            console.log(`[CTRADER] Modo: ${config.CTRADER_DEMO ? 'DEMO 🧪' : 'LIVE 🔴'}`);
            
            const { connect } = await import('ctrader-ts');
            let timedOut = false;
            
            const connectPromise = connect({
                clientId: config.CTRADER_CLIENT_ID,
                clientSecret: config.CTRADER_CLIENT_SECRET,
                accessToken: config.CTRADER_ACCESS_TOKEN,
                accountId: parseInt(config.CTRADER_ACCOUNT_ID, 10) || 0,
                environment: config.CTRADER_DEMO ? 'demo' : 'live',
            });
            
            connectPromise.then(c => { 
                if (timedOut) { 
                    try { c.disconnect(); } catch {} 
                } 
            }).catch(() => {});
            
            const client = await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, 'connectCTrader')
                .catch(err => { timedOut = true; throw err; });
                
            ctClient = client;
            isConnected = true;
            console.log('[CTRADER] ✅ Conectado exitosamente a cTrader.');
            
            setupCTraderEvents(client);
            
            // Invalidar el flag cuando el SDK reporte desconexión definitiva
            client.connection.onEvent('stateChange', (s: any) => {
                if (s.status === 'disconnected' && ctClient === client) {
                    isConnected = false;
                    ctClient = null;
                }
            });
            
            return true;
        } catch (err: any) {
            console.error(`[CTRADER] ❌ Error de conexión (intento ${attempt}):`, err.message);
            try { ctClient?.disconnect(); } catch { /* noop */ } // ✅ matar al huérfano
            ctClient = null;
            isConnected = false;
            
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
                const delay = Math.min(5000 * attempt, 30000);
                console.log(`[CTRADER] 🔄 Reintentando en ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error('[CTRADER] ⛔ Max reintentos alcanzado. Servicio offline.');
    return false;
}"""

content = re.sub(target, replacement, content)

with open('src/services/ctrader.ts', 'w', encoding='utf-8') as f:
    f.write(content)

