import sys

with open('src/db/trading.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Extract the body starting from `if (triggerOte && oteData) {` up to its end.
# Since we saved it to dispatch_block.ts, we can read it from there.
with open('dispatch_block.ts', 'r', encoding='utf-8') as f:
    dispatch_block_content = f.read()

# Make the extracted function dispatchOteSignal
# Replace 'oteData' with 'dispatchData' inside the body? No, just assign `const oteData = dispatchData;` at the beginning of the function.
# Also it needs `config`, `nowMs`, `ticker`, `isBacktest`, `sessionThresholds`, `store`, `db`.
# We'll put `dispatchOteSignal` at the end of the file.
new_function = """
async function dispatchOteSignal(dispatchData: any, state: any, docRef: any, ctx: any) {
    const { ticker, nowMs, isBacktest, sessionThresholds, store } = ctx;
    const oteData = dispatchData;
    const { db: fireDb } = await import('./memory.js');
    const db = fireDb;
""" + dispatch_block_content.replace('if (triggerOte && oteData) {', '{', 1) + "\n}"

# The replacement block in `processTradingAlert`
replacement_in_process = """        let dispatchData: any = null;
        if (triggerOte && oteData) {
            state.lastGatillo = {
                dir: oteData.direction as 'BUY' | 'SELL',
                price: oteData.entryPrice,
                time: nowMs,
                type: oteData.isChochEntry ? 'CHOCH' : 'OTE',
                status: 'EVALUANDO...',
                tf: oteData.tf
            };
            state.version = (state.version || 0) + 1;
            state.lastModified = nowMs;
            docRef.set(state, { merge: true }).catch(() => {});
            dispatchData = oteData;
        }

    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    } finally {
        releaseLock!(); // 🛡️ v5.4: Liberar lock del ticker
    }

    if (dispatchData) {
        await dispatchOteSignal(dispatchData, state, docRef, { ticker, nowMs, isBacktest, sessionThresholds, store });
    }
}"""

# Actually, the original code had:
original_end_of_try = dispatch_block_content + """
    } catch (e: any) {
        console.error(`[RADAR] Error crítico en memoria/Firebase:`, e.message);
    } finally {
        releaseLock!(); // 🛡️ v5.4: Liberar lock del ticker
    }
}"""

# We'll find exactly where `        // =========================================================================` is
import re
target_pattern = r"        // =========================================================================\n        // EJECUCIÓN OTE FUERA DE LA TRANSACCIÓN.*?\} finally \{\n        releaseLock!\(\); // 🛡️ v5\.4: Liberar lock del ticker\n    \}\n\}"
match = re.search(target_pattern, content, re.DOTALL)
if match:
    content = content[:match.start()] + replacement_in_process + content[match.end():]
    content += "\n" + new_function
    with open('src/db/trading.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Patched successfully")
else:
    print("Could not find the target block")

