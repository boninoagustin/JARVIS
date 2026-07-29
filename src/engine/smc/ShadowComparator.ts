import fs from 'fs';
import path from 'path';

interface QueuedAlert {
    text: string;
    source: 'PINE' | 'SMC';
    timestamp: number;
}

const SHADOW_LOG_PATH = path.join(process.cwd(), 'logs', 'shadow_divergences.json');
const MATCH_WINDOW_MS = 30_000; // 30 seconds to match an event

class ShadowComparator {
    private queue: QueuedAlert[] = [];
    private interval: NodeJS.Timeout;

    constructor() {
        this.interval = setInterval(() => this.cleanupQueue(), 10_000);
        
        // Ensure logs directory exists
        const dir = path.dirname(SHADOW_LOG_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    public recordPineAlert(text: string) {
        this.processAlert({ text, source: 'PINE', timestamp: Date.now() });
    }

    public recordSMCAlert(text: string) {
        this.processAlert({ text, source: 'SMC', timestamp: Date.now() });
    }

    private processAlert(newAlert: QueuedAlert) {
        // Try to find a match in the opposite source
        const matchIndex = this.queue.findIndex(
            (q) => q.source !== newAlert.source && this.isMatch(q.text, newAlert.text)
        );

        if (matchIndex !== -1) {
            // Matched! Remove from queue
            this.queue.splice(matchIndex, 1);
            if(false) console.log(`[SHADOW] ✅ Matched alert: ${newAlert.text.split('|')[0]}`);
        } else {
            // No match yet, add to queue
            this.queue.push(newAlert);
        }
    }

    private isMatch(textA: string, textB: string): boolean {
        // Simple fuzzy match: if the prefix and main body match (ignoring exact price decimals/timestamps)
        // For now, exact match excluding TS is done in Bridge, but let's do a substring check.
        const coreA = textA.replace(/\s*\|\s*TS:\s*\d+/, '').replace(/\s*\|\s*Precio:\s*[\d.]+/, '').trim();
        const coreB = textB.replace(/\s*\|\s*TS:\s*\d+/, '').replace(/\s*\|\s*Precio:\s*[\d.]+/, '').trim();
        return coreA === coreB;
    }

    private cleanupQueue() {
        const now = Date.now();
        const remaining: QueuedAlert[] = [];

        for (const alert of this.queue) {
            if (now - alert.timestamp > MATCH_WINDOW_MS) {
                this.logDivergence(alert);
            } else {
                remaining.push(alert);
            }
        }
        this.queue = remaining;
    }

    private logDivergence(alert: QueuedAlert) {
        console.warn(`[SHADOW] ❌ Divergence detected! Orphaned ${alert.source} alert: ${alert.text}`);
        let existing = [];
        try {
            if (fs.existsSync(SHADOW_LOG_PATH)) {
                existing = JSON.parse(fs.readFileSync(SHADOW_LOG_PATH, 'utf-8'));
            }
        } catch (e) {
            // ignore parse error
        }

        existing.push({
            timestamp: new Date(alert.timestamp).toISOString(),
            source: alert.source,
            text: alert.text
        });

        // Keep last 1000 to avoid giant files
        if (existing.length > 1000) {
            existing = existing.slice(existing.length - 1000);
        }

        fs.writeFileSync(SHADOW_LOG_PATH, JSON.stringify(existing, null, 2));
    }
}

export const shadowComparator = new ShadowComparator();
