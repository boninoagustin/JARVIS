# 🔍 AUDITORÍA COMPLETA DEL SISTEMA JARVIS
## Backend + Frontend - Chequeo de Salud Riguroso

**Fecha**: 11 de junio de 2026  
**Estado de Compilación**: ✅ Ambas raíz y jarvis-os compilan sin errores (strict: true)  
**Repositorio**: JARVIS Trading Bot

---

## 📋 HALLAZGOS EJECUTIVOS

| Severidad | Cantidad | Estado | Impacto |
|-----------|----------|--------|---------|
| **P0 - Crítico** | 4 | 🔴 Requiere acción inmediata | Seguridad, pérdidas financieras |
| **P1 - Alto** | 12 | 🟠 Debe corregirse en sprint actual | Memory leaks, bugs de lógica |
| **P2 - Moderado** | 8 | 🟡 Mejorar en próximas iteraciones | Performance, mantenibilidad |

---

# 🔴 PROBLEMAS CRÍTICOS (P0)

## 1. **API KEYS HARDCODEADAS - EXPOSICIÓN DE CREDENCIALES**
- **Ubicación**: `src/services/macro_data.ts:3`
- **Severidad**: P0
- **Código**:
```typescript
const FINNHUB_KEY = 'd7pt291r01qosaaprsr0d7pt291r01qosaaprsrg'; // ❌ EXPUESTO
```
- **Riesgo**: 
  - Credencial expuesta en repositorio público
  - Posible abuso/revocación de la clave
  - Acceso no autorizado a APIs financieras
  - Facturación a cuenta personal
  
- **Recomendación**: 
  - Usar variables de entorno: `process.env.FINNHUB_API_KEY`
  - Revocar clave actual en Finnhub dashboard
  - Usar secretos gestionados (GitHub Secrets, Firebase, etc.)

---

## 2. **DIVISIONES POR CERO EN R:R RATIO - RIESGO DE NaN**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L603-L620) (líneas ~603-620, múltiples lugares)
- **Severidad**: P0
- **Código problemático**:
```typescript
// Línea ~603
const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 0;

// Línea ~564 (evaluateImpulse)
const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 0;
if (rrRatioOTE < 1.2) { /* descartar */ }

// Problema: si riskDistanceOTE === 0, rrRatioOTE=0 → condición <1.2 es TRUE → SIEMPRE descartar
```
- **Riesgo**:
  - Si `riskDistanceOTE` es 0 (rango mínimo), R:R=0 → setup rechazado siempre
  - Impacto: **Setups válidos rechazados por error matemático**
  - Silent failure: solo log, sin alerta de error

- **Recomendación**:
```typescript
const rrRatioOTE = riskDistanceOTE > 0 ? rewardDistanceOTE / riskDistanceOTE : 1.0; // Fallback a 1.0
if (riskDistanceOTE === 0 || rrRatioOTE < 1.2) {
    // Log error explícito
    console.error(`[FIBO] ❌ R:R invalid: risk=${riskDistanceOTE}, reward=${rewardDistanceOTE}, ratio=${rrRatioOTE}`);
    return { updatedLeg: leg };
}
```

---

## 3. **RACE CONDITIONS EN FIREBASE - SOBREESCRITURA DE TRADES**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L1930-1950) (guardado de trades)
- **Severidad**: P0
- **Problema**:
```typescript
// RAM siempre, Firebase cada 5 min O en eventos
const timeSinceLastSave = nowMs - (lastFirebaseSave.get(ticker) || 0);
const FIREBASE_INTERVAL_MS = 5 * 60 * 1000;

if (prefix !== 'PING_PRICE' || timeSinceLastSave > FIREBASE_INTERVAL_MS) {
    docRef.set(state).catch(() => {});  // ⚠️ FIRE & FORGET SIN WAIT
    lastFirebaseSave.set(ticker, nowMs);
}
```
- **Escenario de Falla**:
  1. PING_PRICE llega, actualiza RAM (BUY con 8 pts)
  2. Antes de sincronizar a Firebase (5 min), llega EVENTO_CHOCH con 2 pts más
  3. Se dispara OTE inmediatamente (RAM=10 pts)
  4. 5 min después, Firebase recibe `set()` con BUY 8 pts (VIEJO)
  5. Resultado: Firebase sobrescribe y pierde los 2 pts del CHoCH

- **Impacto**: 
  - Inconsistencia datos RAM ≠ Firebase
  - Si crash del servidor, pierde trades activos
  - Auditoría histórica corrupta

- **Recomendación**:
  - Usar `update()` en lugar de `set()` para cambios incrementales
  - Agregar versionado (`version`, `lastModified`)
  - Implementar sync automático post-OTE (no esperar 5 min)

---

## 4. **MEMORY LEAKS EN LISTENERS DE FIRESTORE**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L270-330) (múltiples `onSnapshot` sin cleanup)
- **Severidad**: P0
- **Código**:
```typescript
db.collection('active_trades').get().then(snap => {
    snap.forEach(doc => {
        activeTrades.set(doc.id, doc.data() as ActiveTrade);
    });
    // ⚠️ NO hay unsubscribe si el servidor se reinicia
});

// Listeners sin guardar referencias para cleanup
db.collection('app_settings').doc('global').onSnapshot((snap) => {
    if (snap.exists) globalKillswitches = snap.data()?.killswitches || {};
    // ¿Cómo desuscribirse en graceful shutdown?
});
```

- **Impacto**:
  - Si el servidor se reinicia 10 veces, 10 listeners simultáneos
  - Costo exponencial de lecturas Firestore
  - Facturación inflada

- **Recomendación**:
```typescript
const unsubscribers: (() => void)[] = [];

// Guardar referencias
unsubscribers.push(
    db.collection('app_settings').doc('global').onSnapshot((snap) => {
        if (snap.exists) globalKillswitches = snap.data()?.killswitches || {};
    })
);

// En graceful shutdown
process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] Limpiando listeners...');
    unsubscribers.forEach(unsub => unsub());
});
```

---

# 🟠 PROBLEMAS ALTOS (P1)

## 5. **PROMESAS SIN MANEJO DE ERRORES (FIRE & FORGET)**
- **Ubicación**: `src/db/trading.ts` líneas: 678, 803, 962, 1163, 1173, 1202, 1261, 1932, 1949, 1958
- **Severidad**: P1
- **Ejemplos**:
```typescript
// Línea 678
if (db) db.collection('active_trades').doc(tradeId).set(newTrade).catch(() => {});

// Línea 1949
docRef.set(state).catch(() => {}); // Update status in UI immediately

// Línea 1202
if (db) db.collection('active_trades').doc(tradeId).delete().catch(() => {});
```

- **Riesgo**:
  - `.catch(() => {})` silencia errores sin logging
  - Si Firestore está caído, el trade se crea en RAM pero NO en BD
  - Post-reinicio, el trade desaparece (pérdida de dinero)
  - Imposible debuggear problemas de conectividad

- **Recomendación**:
```typescript
if (db) {
    db.collection('active_trades').doc(tradeId).set(newTrade)
        .catch((err: any) => {
            console.error(`[FIREBASE] Error guardando trade ${tradeId}: ${err.message}`);
            // Retry logic o alertar al usuario
            sendTelegramAlert(`⚠️ Error guardando trade en Firebase: ${err.message}`).catch(() => {});
        });
}
```

---

## 6. **DESAJUSTE DE MODELOS DE DATOS FIRESTORE - @ts-ignore**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L322) (casteado inseguro)
- **Severidad**: P1
- **Código**:
```typescript
// Línea 322
entryTrigger: (data.entryTrigger as any) || dynamicBotConfig.entryTrigger,
```

- **Problema**:
  - Si `data.entryTrigger` no es 'CHOCH' | 'OTE' | 'BOTH', el código lo acepta igual
  - Tipos débiles en interfaz `AssetSessionConfig`
  - No hay validación de estructura antes de usar

- **Desajustes Detectados**:
  - `asset_configs/{ticker}` escrito pero interfaz frontend espera otros campos
  - `trade_journal` campos `rMultiple` puede ser undefined → fallback manual
  - `backtesting_sessions` usa `totalEvents` pero frontend espera `totalTrades`

- **Recomendación**:
  - Crear validador Zod/Yup:
```typescript
const AssetSessionConfigSchema = z.object({
    minPointsForBuy: z.number().min(1),
    minPointsForSell: z.number().min(1),
    entryTrigger: z.enum(['CHOCH', 'OTE', 'BOTH']),
    // ... rest
});

const validated = AssetSessionConfigSchema.parse(data); // Throw si no valida
```

---

## 7. **WEB WORKER MEMORY LEAK - EVENT LISTENERS NO REMOVIDOS**
- **Ubicación**: [jarvis-os/src/components/BacktestingPanel.tsx](jarvis-os/src/components/BacktestingPanel.tsx#L220-L230)
- **Severidad**: P1
- **Código**:
```typescript
const runWorkerTask = useCallback((type: string, payload: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        const id = Date.now() + Math.random();
        const handler = (e: MessageEvent) => {
            if (e.data.id === id) {
                workerRef.current?.removeEventListener('message', handler);
                if (e.data.type === 'DONE') resolve(e.data.result);
                else reject(e.data.error);
            }
        };
        workerRef.current.addEventListener('message', handler);
        workerRef.current.postMessage({ type, id, payload });
        
        // ⚠️ NO HAY TIMEOUT - si worker no responde, handler nunca se remueve
    });
}, []);
```

- **Riesgo**:
  - Si worker falla (crash, hung), promesa nunca se resuelve
  - Handler acumula en memoria indefinidamente
  - Múltiples backtests fallidos = OOM
  - UI se congela progresivamente

- **Recomendación**:
```typescript
const runWorkerTask = useCallback((type: string, payload: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        const id = Date.now() + Math.random();
        const handler = (e: MessageEvent) => {
            if (e.data.id === id) {
                clearTimeout(timeoutId);
                workerRef.current?.removeEventListener('message', handler);
                if (e.data.type === 'DONE') resolve(e.data.result);
                else reject(e.data.error);
            }
        };
        
        const timeoutId = setTimeout(() => {
            workerRef.current?.removeEventListener('message', handler);
            reject(new Error('Worker task timeout after 30s'));
        }, 30000);
        
        workerRef.current.addEventListener('message', handler);
        workerRef.current.postMessage({ type, id, payload });
    });
}, []);
```

---

## 8. **TIPOS `any` EN COMPONENTES CRÍTICOS**
- **Ubicación**: [jarvis-os/src/components/BacktestingPanel.tsx](jarvis-os/src/components/BacktestingPanel.tsx#L202, L241, L735, L749)
- **Severidad**: P1
- **Ejemplos**:
```typescript
// Línea 202
const [optimizedSessionResults, setOptimizedSessionResults] = useState<
    Record<string, { config: any, result: BacktestResult }>
>({});

// Línea 735, 749
let allTrades: any[] = [];
let simulatedTrades: any[] = [];

// Línea 241
interface PortfolioAssetFile {
    name: string;
    ticker: string;
    trades: any[];  // ❌ Sin estructura
}
```

- **Riesgo**:
  - Imposible refactorizar sin riesgo
  - Bugs en runtime (acceso a propiedades inexistentes)
  - TypeScript no detecta inconsistencias

- **Recomendación**:
```typescript
interface OptimizedConfig {
    minBuyPoints: number;
    minSellPoints: number;
    slBufferPercent: number;
    fixedRR: number;
    entryTrigger: 'CHOCH' | 'OTE' | 'BOTH';
}

interface BacktestTrade {
    id: string;
    ticker: string;
    direction: 'BUY' | 'SELL';
    entryPrice: number;
    tp1Price: number;
    tp2Price: number;
    slPrice: number;
    pnl: number;
    result: 'WIN' | 'LOSS' | 'BREAKEVEN';
}

const [optimizedSessionResults, setOptimizedSessionResults] = useState<
    Record<string, { config: OptimizedConfig; result: BacktestTrade[] }>
>({});
```

---

## 9. **CÁLCULO DE rMultiple INCORRECTO - FALTA VALIDACIÓN**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L740, L925, L1211)
- **Severidad**: P1
- **Código**:
```typescript
// Línea 740, 925
let rMultiple = Number(t.rMultiple);
if (isNaN(rMultiple) || rMultiple === undefined) {
    // Fallback manual que puede ser incorrecto
    if (t.result === 'WIN') {
        rMultiple = 1.5;  // ⚠️ ASUMIR 1.5x sin calcular realmente
    } else if (t.result === 'LOSS') {
        rMultiple = -1.0; // ⚠️ ASUMIR -1.0x
    } else {
        rMultiple = 0;
    }
}
```

- **Problema**:
  - Fallback asume R:R fijo (1.5 para WIN, -1.0 para LOSS)
  - Ignora el riesgo real del trade
  - Auto-tuning se basa en datos incorrectos
  - Histórico de performance inflado

- **Recomendación**:
  - Guardar `rMultiple` EN el momento de cerrar el trade
  - Validar en `recordResult()` antes de guardar

---

## 10. **UNSUBSCRIBE INCOMPLETA EN FIRESTORE LISTENERS**
- **Ubicación**: [jarvis-os/src/components/FundamentalTerminal.tsx](jarvis-os/src/components/FundamentalTerminal.tsx#L238-L267)
- **Severidad**: P1
- **Código**:
```typescript
useEffect(() => {
    const unsubGlobal = onSnapshot(doc(db, 'app_settings', 'global'), ...);
    const unsubFundamentals = onSnapshot(doc(db, 'app_settings', 'fundamentals'), ...);
    const unsubRadar = onSnapshot(query(collection(db, 'radar_states')), ...);
    
    fetchMacroData(); // ⚠️ Async sin await, puede no completar
    
    return () => {
        unsubGlobal();
        unsubFundamentals();
        unsubRadar();
    };
}, []);
```

- **Riesgo**:
  - Si el componente unmounts rápidamente (usuario navega), fetch inicia pero nunca se aborta
  - Múltiples llamadas simultáneas = race conditions
  - 10 navegaciones = 30 listeners activos + 30 fetch requests pendientes

- **Recomendación**:
```typescript
useEffect(() => {
    const abortController = new AbortController();
    const unsubscribers: (() => void)[] = [];
    
    unsubscribers.push(onSnapshot(doc(db, 'app_settings', 'global'), ...));
    unsubscribers.push(onSnapshot(doc(db, 'app_settings', 'fundamentals'), ...));
    unsubscribers.push(onSnapshot(query(collection(db, 'radar_states')), ...));
    
    fetchMacroData(abortController.signal).catch(err => {
        if (err.name !== 'AbortError') console.error('[FundTerm]', err);
    });
    
    return () => {
        abortController.abort();
        unsubscribers.forEach(unsub => unsub());
    };
}, []);
```

---

## 11. **CONDICIÓN DE CARRERA EN EVALUACIÓN DE KILLSWITCHES**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L1945-1970) (evaluación ocurre ANTES de creación)
- **Severidad**: P1
- **Escenario**:
```typescript
// 1. Evaluar killswitches (línea 1945-1960)
const isGlobalKilled = await evaluateGlobalKillswitch(nowMs);
if (isGlobalKilled) {
    // Bloquear trade
    activeTrades.delete(oteData.tradeId);
    if (db) db.collection('active_trades').doc(oteData.tradeId).delete().catch(() => {});
    return;
}

// 2. Pero si el trade se creó en evaluateImpulse (línea 676-680)
// antes de llegar aquí, la limpieza es incompleta:
//   - Se eliminó activeTrades (RAM)
//   - Se intentó eliminar Firebase
//   - Pero el journalId en la BD quedó sin vinculación al trade activo
```

- **Riesgo**: Trade órfano en journal sin correspondencia en active_trades

- **Recomendación**: 
  - Crear trade en RAM SOLO tras todas las validaciones
  - O: guardar estado "BLOCKED" en active_trades con motivo

---

## 12. **ASYNC/AWAIT INCONSISTENTE EN INDEX.TS**
- **Ubicación**: [src/index.ts](src/index.ts#L40-70) (listeners sin await)
- **Severidad**: P1
- **Código**:
```typescript
db.collection('trading_incoming')
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
        for (const change of snapshot.docChanges()) {
            if (change.type === 'added') {
                const alertText = change.doc.data().alertText;
                
                try {
                    const { processTradingAlert } = await import('./db/trading.js');
                    await processTradingAlert(alertText);  // ✓ Correctamente esperado
                    
                    // ⚠️ Pero si hay múltiples cambios, se procesan en paralelo sin límite
                    // Podría haber race conditions si 2 PINGs del mismo ticker llegan juntos
                    
                    await db?.collection('trading_incoming').doc(docId).delete();
                } catch (err: any) {
                    console.error('[LOCAL TRADING ERROR]', err.message);
                    await db?.collection('trading_incoming').doc(docId).update({ status: 'failed' });
                }
            }
        }
    });
```

- **Riesgo**:
  - Si llegan 5 alertas de BTCUSD en paralelo, se procesan concurrentemente
  - El lock por ticker (línea 370-380 en trading.ts) maneja esto, pero no hay confirmación
  - Mejor hacer for secuencial explícito

---

# 🟡 PROBLEMAS MODERADOS (P2)

## 13. **FETCH SIN TIMEOUT EN SWARM AI**
- **Ubicación**: [src/db/trading.ts](src/db/trading.ts#L2015) (~línea 2015)
- **Severidad**: P2
- **Código**:
```typescript
const swarmRes = await fetch('http://127.0.0.1:8001/api/analyze-trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({...}),
    signal: AbortSignal.timeout(8000)  // ✓ Tiene timeout
});
```

- **Observación**: Sí tiene timeout (8s), pero:
  - Si el bridge de IA no está corriendo, tarda 8s para cada trade
  - Debería fallar rápido (connrefused después de 1-2s)
  - Recomendación: Usar timeout más corto (3s) o circuit breaker

---

## 14. **POLLING AGRESIVO EN JOURNAL - ACTUALIZACIONES MUY FRECUENTES**
- **Ubicación**: [jarvis-os/src/components/AnalyticsJournal.tsx](jarvis-os/src/components/AnalyticsJournal.tsx#L164-L170)
- **Severidad**: P2
- **Código**:
```typescript
const q = query(collection(db, 'trade_journal'), 
    orderBy('timestamp', 'desc'), 
    limit(100)
);
const unsubscribe = onSnapshot(q, (snapshot) => {
    const data = snapshot.docs.map(doc => ({...}));
    setTrades(data);  // ⚠️ Cada snapshot = setState = re-render
});
```

- **Riesgo**:
  - Si backend inserta 5+ trades/segundo, UI actualiza 5+ veces/segundo
  - CPU/GPU spike, lag notorio
  - Facturación innecesaria de Firestore reads

- **Recomendación**: Debounce (500ms) o agregación de batch updates

---

## 15. **AUTOTUNE INCOMPLETO - PSEUDO-CÓDIGO**
- **Ubicación**: [src/services/autotune.ts](src/services/autotune.ts#L45-65)
- **Severidad**: P2
- **Código**:
```typescript
// 🔎 Analizando Activo: US100
// 🔸 Optimizando sesión: LONDON
// Aquí implementaremos la búsqueda en el espacio de parámetros
// - SL Buffer
// - TP2 Target
// - Min Score
// - Max Loss

// TODO: Búsqueda en Grid Search o Algoritmo Genético
```

- **Problema**:
  - Motor Auto-Tune es **stub**: no hace nada real
  - `checkAndRunAutoTune()` corre cada 24h pero no optimiza
  - Configuración se mantiene estática = sin evolución

- **Recomendación**: Implementar versión V1 mínima:
  - Calcular win rate por (minPointsForBuy, minPointsForSell)
  - Recomendar ajustes ("+1 min points si WR < 40%")
  - Guardar en Firebase para que AdminPanel los muestre

---

## 16. **CÁLCULO DE SESSION EN FRONTEND DESINCRONIZADO**
- **Ubicación**: [jarvis-os/src/components/SessionCard.tsx](jarvis-os/src/components/SessionCard.tsx) (no visto, pero implícito)
- **Severidad**: P2
- **Problema**:
  - Frontend calcula `getCurrentSession()` en JavaScript
  - Backend también calcula en trading.ts
  - Zona horaria: Argentina (UTC-3) pero browser del usuario puede estar en otra
  - Si usuario está en NY, verá "NY" sesión pero servidor cree que es "LONDON"

- **Recomendación**: Usar `session` de Firebase (`app_settings/radar_states/lastKnownSession`)

---

## 17. **SETTIMEOUT ANTI-PATRÓN EN MODAL**
- **Ubicación**: [jarvis-os/src/components/BacktestingPanel.tsx](jarvis-os/src/components/BacktestingPanel.tsx#L359)
- **Severidad**: P2
- **Código**:
```typescript
const handleRun = useCallback((...) => {
    setIsRunning(true);
    
    setTimeout(async () => {
        // Lógica pesada aquí
        const res = await runWorkerTask('RUN_BACKTEST', payload);
        // ...
    }, 50);  // ⚠️ Delay arbitrario
}, [...deps]);
```

- **Problema**:
  - 50ms es impredecible (varía por carga del sistema)
  - Mejor: `requestAnimationFrame()` o `microtask` (Promise.resolve())
  - En dispositivos lentos, causa jank visible

---

## 18. **FALTA VALIDACIÓN DE ENTRADA - TradingView Webhook**
- **Ubicación**: [api/webhook.ts](api/webhook.ts#L11-28) (trading)
- **Severidad**: P2
- **Código**:
```typescript
const alertText = typeof req.body === 'string' ? req.body : 
                 req.body?.text || JSON.stringify(req.body);

console.log(`[WEBHOOK TW] ${alertText.substring(0, 120)}...`);

db.collection('trading_incoming').add({
    alertText,  // ⚠️ Sin sanitización, sin schema validation
    received_at: new Date().toISOString(),
    status: 'pending'
}).catch((e: any) => console.error('[WEBHOOK TW] Firestore write error:', e.message));
```

- **Riesgo**:
  - Si TradingView envía payload malformado, se guarda igual
  - Luego `processTradingAlert()` falla con regex confuso
  - Imposible parsear manualmente

- **Recomendación**:
```typescript
const alertText = typeof req.body === 'string' ? req.body : req.body?.text;
if (!alertText || typeof alertText !== 'string') {
    console.error('[WEBHOOK TW] Invalid body', req.body);
    return res.status(400).json({ error: 'Invalid alert format' });
}

// Validar estructura mínima
if (!alertText.includes('|') && !alertText.includes(',')) {
    return res.status(400).json({ error: 'Invalid alert format (no delimiters)' });
}

await db.collection('trading_incoming').add({ alertText, ... });
```

---

# 📊 ANÁLISIS DE INTEGRIDAD DE DATOS

## Desajustes de Modelos Detectados

### 1. **Colección `trade_journal`**
```typescript
// Backend escribe:
{
    id, ticker, direction, grade, points, events,
    entryPrice, tp1Price, tp2Price, slPrice,
    tp1Hit, tp2Hit, slHit,
    result: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'TIMEOUT',
    rMultiple, pnl, durationMin,
    mode: 'live' | 'backtesting'
}

// Frontend espera (en AnalyticsJournal.tsx):
{
    id, ticker, direction, grade, points,
    timestamp, result,
    // ⚠️ Campos faltantes: rMultiple, mode, duration
}
```
**Riesgo**: Incompletitud de datos en UI analytics.

---

### 2. **Colección `asset_configs`**
```typescript
// Backend (trading.ts línea 320):
{
    minPointsForBuy, minPointsForSell,
    slBufferPercent, fixedRR, oteEntryPercent,
    entryTrigger,
    maxSellsPerDay, sellScorePenalty,
    maxBuysPerDay, buyScorePenalty,
    sessions: { LONDON: {...}, NY: {...}, ASIA: {...} }
}

// Frontend AdminPanel espera:
{
    // Similar, pero sin validación schema
}

// 🔴 PROBLEMA: Si backend escribe campo "maxTradesPerDay"
//    pero frontend lee "maxSellsPerDay + maxBuysPerDay",
//    pueden desincronizarse
```

---

### 3. **Colección `backtesting_sessions`**
```typescript
// Backend escribe:
{
    id, ticker, startDate, endDate, configNote,
    minBuyPoints, minSellPoints,
    timestamp, status: 'running' | 'completed' | 'failed',
    mode: 'replay',
    totalEvents, tfCount,
    processedEvents, skippedNoTs  // post-ejecución
}

// Frontend espera:
{
    // Similar, pero ¿qué pasa en "stopped" state?
    // Campos finales se asignan con merge: true (¿si falla?)
}
```

**Riesgo**: Estado incompleto si crash durante merge.

---

## Lecturas Excesivas de Firestore

| Listener | Frecuencia | Costo Mensual (estim.) |
|----------|-----------|----------------------|
| `app_settings.global` | Cada update | ~1,000 reads/día |
| `app_settings.bot_config` | Cada update | ~1,000 reads/día |
| `asset_configs` | Cada update | ~2,000 reads/día |
| `trade_journal` (analytics) | Real-time | ~10,000 reads/día |
| `radar_states` (FundTerm) | Real-time | ~5,000 reads/día |
| **TOTAL** | | **~70-100K reads/mes** → **$0.30-0.50/mes** |

⚠️ Con 2-3 instancias concurrentes = **$1-1.50/mes** innecesarios.

**Recomendación**: Usar cache local + manual refresh en lugar de listeners para configs no críticas.

---

# 🔧 RESUMEN DE RECOMENDACIONES INMEDIATAS

| Prioridad | Acción | Archivo | Tiempo Est. |
|-----------|--------|---------|-------------|
| 🔴 P0 | Mover FINNHUB_KEY a .env | `macro_data.ts` | 5 min |
| 🔴 P0 | Validar R:R ratio (no div by 0) | `trading.ts:603,564` | 15 min |
| 🔴 P0 | Agregar versioning a trades | `trading.ts` | 30 min |
| 🔴 P0 | Guardar unsubscribers, cleanup en shutdown | `trading.ts`, `index.ts` | 30 min |
| 🟠 P1 | Validar `entryTrigger` con Zod | `trading.ts:322` | 20 min |
| 🟠 P1 | Agregar timeout a Web Worker | `BacktestingPanel.tsx:220` | 15 min |
| 🟠 P1 | Tipado completo para trades | `BacktestingPanel.tsx:735` | 45 min |
| 🟠 P1 | Validar rMultiple al guardar | `journal.ts:logTrade` | 20 min |
| 🟠 P1 | Schemas Firestore (Zod) | `db/trading.ts` | 60 min |
| 🟡 P2 | Debounce listeners | `AnalyticsJournal.tsx` | 20 min |

---

# 📋 CHECKLIST PRE-PRODUCCIÓN

- [ ] API Keys en `.env` (FINNHUB_KEY, etc.)
- [ ] Revocar claves hardcodeadas actuales
- [ ] Validación schema Zod en todas las escrituras de Firestore
- [ ] Cleanup de listeners en graceful shutdown
- [ ] Timeouts en todos los fetch/promises
- [ ] R:R ratio validation (riskDistance > 0)
- [ ] Tipado fuerte en componentes críticos (sin `any`)
- [ ] Tests E2E para race conditions (múltiples trades simultáneos)
- [ ] Monitoreo de Firestore reads (Dashboard Firebase)
- [ ] Logs estructurados (JSON) para debugging

---

# 📞 CONCLUSIÓN

**Estado General**: ✅ **FUNCIONAL EN BACKTEST** | ⚠️ **REQUIERE HARDENING PARA PRODUCCIÓN**

### Crítico (Hoy):
1. API keys expuestas → revocar + mover a env
2. R:R ratio div by 0 → agregar guard
3. Memory leaks listeners → cleanup

### Alto (Esta semana):
1. Validación schema Firestore
2. Promesas sin error handling
3. Web Worker timeout

### Moderado (Próximas 2 semanas):
1. Tipado completo (`any` → interfaces)
2. Optimizar listeners (debounce)
3. Completar Auto-Tune MVP

**Señal de GO a Producción**: Cuando todos los P0 estén resueltos + tests E2E con 2+ trades simultáneos.

