import re

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """    let triggerOte = false;
    let oteData: any = null;
    let dispatchData: any = null;

    try {
        // 🔥 Reemplazo completo de la Transacción por Memoria RAM Local 🔥
        triggerOte = false;
        oteData = null;

        // 1. LEER DE LA RAM (Ultra rápido y sin costo de base de datos)
        let state = store.localRadarStates.get(ticker);"""

replacement = """    let triggerOte = false;
    let oteData: any = null;
    let dispatchData: any = null;
    let state: any = null;

    try {
        // 🔥 Reemplazo completo de la Transacción por Memoria RAM Local 🔥
        triggerOte = false;
        oteData = null;

        // 1. LEER DE LA RAM (Ultra rápido y sin costo de base de datos)
        state = store.localRadarStates.get(ticker);"""

content = content.replace(target, replacement)

with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
    f.write(content)
