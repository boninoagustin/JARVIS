import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    const previousLock = store.tickerLocks.get(ticker) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    store.tickerLocks.set(ticker, newLock);"""

replacement = """    const previousLock = store.tickerLocks.get(ticker) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>(resolve => { releaseLock = resolve; });
    store.tickerLocks.set(ticker, newLock);
    
    // 🧹 Limpieza: borrar el lock del mapa si no ha sido sobrescrito por uno más nuevo
    newLock.finally(() => {
        if (store.tickerLocks.get(ticker) === newLock) {
            store.tickerLocks.delete(ticker);
        }
    });"""

content = content.replace(target, replacement)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
