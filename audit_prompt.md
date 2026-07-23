# Contexto
Jarvis es un sistema algorítmico de análisis de mercados y backtesting (procesa señales SMC/Pine Script). El backend está en Node.js y el frontend en React. La precisión matemática, la consistencia del estado y el rendimiento son críticos.

# Tarea
Realiza un Code Review profundo de los archivos que te he referenciado. Analiza cómo interactúan entre sí. Te los voy a proporcionar en dos tandas para no diluir tu capacidad de análisis. Presta especial atención a la responsabilidad principal de cada archivo según el siguiente enfoque:

# Archivos y Foco de la auditoría:

### 1. BUGS CRÍTICOS: Concurrencia, Asincronía y Race Conditions
- **`src/db/trading.ts`**: Es el "cuello de embudo" donde entran los webhooks. Audita condiciones de carrera al leer/escribir en Firestore si llegan múltiples webhooks en el mismo milisegundo. Revisa la lógica del módulo SAR (Stop and Reverse) y bloqueos rápidos.
- **`src/services/ctrader.ts`**: Es el puente de ejecución. Busca promesas sin resolver, mal manejo de desconexiones, manejo de latencia y posibles bloqueos del event-loop al comunicarse con la API del broker.

### 2. LÓGICA FINANCIERA: Coma Flotante y Precisión Matemática
- **`src/engine/FrictionModel.ts`**: Archivo crítico financiero. Busca errores típicos de coma flotante de JavaScript (ej. `0.1 + 0.2 = 0.30000004`) en los cálculos de spread, comisiones, margin y PnL.
- **`src/engine/PortfolioModel.ts`**: Maneja el cálculo global de riesgo y Killswitches. Audita la precisión con la que suma los `rMultiple` de los trades diarios y el manejo de los timestamps para los reinicios diarios (zonas horarias).

### 3. RENDIMIENTO: Cuellos de Botella y Backtesting
- **`src/engine/ExecutionModel.ts`** y **`src/engine/AlphaModel.ts`**: Son el corazón del motor de backtesting y procesamiento de señales. Busca bucles pesados al iterar velas/señales, detecta operaciones redundantes, arrays mal optimizados o procesamiento asíncrono ineficiente.

### 4. ARQUITECTURA: Acoplamiento fuerte o mal uso de tipos (any)
- **`src/engine/StateStore.ts`** y **`src/engine/Types.ts`**: Revisa si el estado es realmente inmutable o si hay fugas de estado global que causen efectos secundarios indeseados entre ejecuciones aisladas de trades. 

# Formato de Salida Obligatorio:
No expliques qué hace el código. Ve directo a los hallazgos:
- [🔴 Crítico | 🟡 Rendimiento | 🔵 Arquitectura] - `Archivo` -> `Función`
- **Problema**: Breve explicación.
- **Solución**: Código refactorizado listo para aplicar.
