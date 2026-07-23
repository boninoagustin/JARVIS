# Contexto
Jarvis es un sistema algorítmico de análisis de mercados y backtesting (procesa señales SMC/Pine Script). El backend está en Node.js y el frontend en React. La precisión matemática, la consistencia del estado y el rendimiento son críticos.

# Tarea
Realiza un Code Review profundo de los archivos referenciados. Como la arquitectura base y los cuellos de botella ya fueron optimizados, enfócate en la lógica algorítmica y el comportamiento de trading.

# Foco de la auditoría:
1. LÓGICA DE TRADING (SMC/FIBO): ¿Hay ineficiencias matemáticas en cómo se calculan las zonas OTE, el trailing stop (Breakeven) o el ratio Riesgo/Beneficio (R)?
2. GESTIÓN DE RIESGO: ¿Hay vulnerabilidades en el PortfolioModel o en el control de rachas perdedoras (consecutiveLosses)?
3. MEJORAS CUANTITATIVAS: Sugiere enfoques matemáticos o filtros (por ejemplo, análisis de volumen, ATR o manipulación de tiempo) que podrían aplicarse para mejorar la tasa de acierto del bot y proteger el capital.

# Formato de Salida Obligatorio:
No expliques qué hace el código. Ve directo a los hallazgos y sugerencias:
- [🟢 Mejora Cuantitativa | 🟣 Lógica SMC | 🔴 Bug Lógico] - `Archivo` -> `Función`
- **Problema/Oportunidad**: Breve explicación del concepto.
- **Solución**: Código refactorizado o fórmula a aplicar.
