// src/services/wsClient.ts
export class WSClient {
    private static instance: WSClient;
    private ws: WebSocket | null = null;
    private listeners = new Set<(msg: any) => void>();
    private retryMs = 1000;
    private pendingMessages: any[] = [];

    static get() { return (WSClient.instance ??= new WSClient()); }

    connect(url: string) {
        if (this.ws) return;
        this.ws = new WebSocket(url);
        
        this.ws.onmessage = e => {
            try {
                const msg = JSON.parse(e.data);
                this.listeners.forEach(fn => fn(msg));
            } catch (err) {
                console.error('WS Parse Error', err);
            }
        };
        
        this.ws.onclose = () => {
            this.ws = null;
            const jitter = Math.floor(Math.random() * 1000);
            setTimeout(() => this.connect(url), this.retryMs + jitter);
            this.retryMs = Math.min(this.retryMs * 2, 30000); // backoff, evita thundering herd
        };
        
        this.ws.onopen = () => { 
            this.retryMs = 1000; 
            // Enviar mensajes encolados
            this.pendingMessages.forEach(msg => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify(msg));
                }
            });
            this.pendingMessages = [];
        };
    }
    
    send(obj: any) { 
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        } else {
            this.pendingMessages.push(obj);
        }
    }
    
    subscribe(fn: (msg: any) => void) { 
        this.listeners.add(fn); 
        return () => this.listeners.delete(fn); 
    }

    disconnect() {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    }
}

export const wsClient = WSClient.get();
