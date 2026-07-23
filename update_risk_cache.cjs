const fs = require('fs');
const file = 'src/engine/PortfolioModel.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Add riskCache and TTL at the top of the file
const cacheDecls = `import { firestore } from 'firebase-admin';

const riskCache = new Map<string, { at: number; result: any }>();
const TTL = 5 * 60 * 1000;
`;
code = code.replace(`import { firestore } from 'firebase-admin';`, cacheDecls);

// 2. update evaluateGlobalRisk
const egrTarget = `        if (isKilled) {
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            return { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        return { isKilled: false };
    } catch (e: any) {
        console.error('[PortfolioModel] Error evaluando el riesgo unificado:', e.message);
        return { isKilled: false };
    }`;

const egrRepl = `        let result = { isKilled: false } as KillswitchResult;
        if (isKilled) {
            const endOfDayMs = artMidnightMs + 24 * 60 * 60 * 1000 - 1000;
            result = { isKilled: true, killUntilMs: endOfDayMs, killReason };
        }

        riskCache.set('global', { at: nowMs, result });
        return result;
    } catch (e: any) {
        console.error('[PortfolioModel] Error evaluando el riesgo unificado:', e.message);
        const c = riskCache.get('global');
        if (c && nowMs - c.at < TTL) return c.result;
        return { isKilled: true, killReason: 'risk-data-unavailable: límites en fail-closed' };
    }`;

if (code.includes(egrTarget)) {
    code = code.replace(egrTarget, egrRepl);
    console.log("Updated evaluateGlobalRisk");
} else {
    console.log("Could not find evaluateGlobalRisk target");
}

// 3. Update countDailySellsForTicker
const sellsTarget = `        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }`;

const sellsRepl = `        const result = snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        riskCache.set(\`sells_\${ticker}\`, { at: nowMs, result });
        return result;
    } catch (e) {
        const c = riskCache.get(\`sells_\${ticker}\`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }`;

if (code.includes(sellsTarget)) {
    code = code.replace(sellsTarget, sellsRepl);
    console.log("Updated countDailySellsForTicker");
} else {
    console.log("Could not find countDailySellsForTicker target");
}

// 4. Update countDailyBuysForTicker
const buysTarget = `        return snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
    } catch (e) {
        return 0;
    }`;

const buysRepl = `        const result = snapshot.docs.filter((d: any) => {
            const data = d.data();
            const modeMatch = isBacktest ? data.mode === 'backtesting' : data.mode !== 'backtesting';
            const sessionMatch = isBacktest ? (backtestSessionId ? data.sessionId === backtestSessionId : true) : true;
            return modeMatch && sessionMatch && tickerVariants.includes(data.ticker);
        }).length;
        riskCache.set(\`buys_\${ticker}\`, { at: nowMs, result });
        return result;
    } catch (e) {
        const c = riskCache.get(\`buys_\${ticker}\`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }`;

if (code.includes(buysTarget)) {
    code = code.replace(buysTarget, buysRepl);
    console.log("Updated countDailyBuysForTicker");
} else {
    console.log("Could not find countDailyBuysForTicker target");
}

// 5. Update countConsecutiveLossesForAsset
const streakTarget = `        }
        return streak;
    } catch (e) {
        return 0;
    }`;

const streakRepl = `        }
        riskCache.set(\`streak_\${ticker}_\${session}_\${direction}\`, { at: nowMs, result: streak });
        return streak;
    } catch (e) {
        const c = riskCache.get(\`streak_\${ticker}_\${session}_\${direction}\`);
        if (c && nowMs - c.at < TTL) return c.result;
        return 999; // fail closed if no cache
    }`;

if (code.includes(streakTarget)) {
    code = code.replace(streakTarget, streakRepl);
    console.log("Updated countConsecutiveLossesForAsset");
} else {
    console.log("Could not find countConsecutiveLossesForAsset target");
}

fs.writeFileSync(file, code);
