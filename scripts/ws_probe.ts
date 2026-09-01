// ws_probe.ts — verifica el payload POSITIONS del WS (incluye pnlR calculado)
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:8081');
const t0 = Date.now();
ws.on('open', () => console.log('conectado, esperando mensajes POSITIONS...'));
ws.on('message', (data: any) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'POSITIONS') {
        console.log('POSITIONS recibido:', JSON.stringify(msg.positions, null, 1));
        ws.close();
        process.exit(0);
    }
    if (Date.now() - t0 > 15000) {
        console.log('timeout 15s sin POSITIONS');
        process.exit(1);
    }
});
ws.on('error', (e: any) => { console.error('WS error:', e.message); process.exit(1); });
