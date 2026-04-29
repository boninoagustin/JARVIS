import { execSync } from 'child_process';
import { getAllTools as getMcpTools, executeToolByName, initializeAll as initMcp } from '../mcp/router.js';

// Tipo para los argumentos de herramientas
type ToolArgs = Record<string, unknown>;

// The interface expected by our custom LLM routing
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: any) => Promise<string> | string;
}

export const tools: Record<string, ToolSchema> = {
  deep_research: {
    name: 'deep_research',
    description: 'Ejecuta una investigación profunda sobre un tema. Busca en la web, lee artículos, y sintetiza un reporte estructurado. Ideal para analizar activos, tendencias de mercado, o cualquier tema complejo.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'El tema a investigar. Ej: "BTCUSD análisis semanal" o "impacto de tasas de interés en mercados"' }
      },
      required: ['query']
    },
    handler: async (args: { query: string }) => {
      const { deepResearch, formatResearchReport } = await import('../services/research.js');
      try {
        const report = await deepResearch(args.query);
        return formatResearchReport(report);
      } catch (err: unknown) {
        return `Error en la investigación: ${(err as Error).message}`;
      }
    }
  },
  analyze_asset: {
    name: 'analyze_asset',
    description: 'Analiza un activo financiero con datos fundamentales (precio, volumen, market cap), noticias recientes, y sentimiento del mercado. Devuelve un análisis con nivel de confianza.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'El símbolo del activo. Ej: "BTCUSD", "EURUSD", "US100", "XAUUSD"' },
        direction: { type: 'string', description: 'Dirección esperada del trade: "BUY" o "SELL". Si no se sabe, usar "BUY".' }
      },
      required: ['ticker']
    },
    handler: async (args: { ticker: string; direction?: string }) => {
      const { analyzeInvestment, formatInvestmentAlert } = await import('../services/investment.js');
      try {
        const dir = (args.direction?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
        const analysis = await analyzeInvestment(args.ticker, dir);
        return formatInvestmentAlert(analysis);
      } catch (err: unknown) {
        return `Error analizando ${args.ticker}: ${(err as Error).message}`;
      }
    }
  },
  journal_trade: {
    name: 'journal_trade',
    description: 'Registra el resultado de un trade del journal. El usuario indica el ID del trade y si fue WIN, LOSS, o BREAKEVEN.',
    parameters: {
      type: 'object',
      properties: {
        tradeId: { type: 'string', description: 'ID del trade (ej: ABC123)' },
        result: { type: 'string', description: 'Resultado: WIN, LOSS, o BREAKEVEN' },
        pnl: { type: 'number', description: 'Ganancia/pérdida en porcentaje (opcional)' }
      },
      required: ['tradeId', 'result']
    },
    handler: async (args: { tradeId: string; result: string; pnl?: number }) => {
      const { recordResult } = await import('../services/journal.js');
      const validResults = ['WIN', 'LOSS', 'BREAKEVEN'];
      const res = args.result.toUpperCase();
      if (!validResults.includes(res)) return `Resultado inválido. Usa: WIN, LOSS, o BREAKEVEN.`;
      const ok = await recordResult(args.tradeId, res as any, args.pnl);
      return ok ? `✅ Trade #${args.tradeId} registrado como ${res}.` : `❌ No encontré el trade #${args.tradeId}.`;
    }
  },
  trading_performance: {
    name: 'trading_performance',
    description: 'Muestra las métricas de rendimiento del trading: win rate, trades por activo, por calidad, etc.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Cantidad de días a analizar (default: 30)' }
      }
    },
    handler: async (args: { days?: number }) => {
      const { getPerformance, formatPerformance } = await import('../services/journal.js');
      const metrics = await getPerformance(args.days || 30);
      return formatPerformance(metrics);
    }
  },
  query_trades: {
    name: 'query_trades',
    description: 'Consulta el historial de trades con lenguaje natural. Ej: "¿Qué pasó la última vez que hubo CHoCH en EURUSD?" o "¿Cuántos trades ganadores tuve esta semana?"',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'La pregunta sobre el historial de trading' }
      },
      required: ['query']
    },
    handler: async (args: { query: string }) => {
      const { queryTradeHistory } = await import('../services/trade_rag.js');
      return await queryTradeHistory(args.query);
    }
  },
  crypto_sentiment_agent: {
    name: 'crypto_sentiment_agent',
    description: 'Busca el sentimiento actual y noticias recientes de una criptomoneda o mercado financiero en la web.',
    parameters: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'El nombre del activo o criptomoneda a buscar (Ej: Bitcoin SEC news, Ethereum update)' }
      },
      required: ['asset']
    },
    handler: async (args: { asset: string }) => {
      try {
        const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
        const response = await fetchFn(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.asset + ' news sentiment today')}`);
        const html = await response.text();
        
        // Extracción rudimentaria de títulos y snippets (sin dependencias extra)
        const matches = [...html.matchAll(/<a class="result__snippet[^>]*>(.*?)<\/a>/g)];
        const results = matches.slice(0, 5).map(m => m[1].replace(/<\/?[^>]+(>|$)/g, "")).join('\n\n');
        
        if (!results) return "No se encontraron noticias recientes o sentimiento claro. Intenta otra búsqueda.";
        
        return `Resultados de sentimiento y noticias recientes para "${args.asset}":\n\n${results}\n\nCon base en esto, actúa como un analista y define si el sentimiento es Alcista, Bajista o Neutral.`;
      } catch (err: any) {
        return `Error obteniendo sentimiento: ${err.message}`;
      }
    }
  },
  trading_swarm: {
    name: 'trading_swarm',
    description: 'Activa un Swarm Multi-Agente (Comité de Inversión) para evaluar un trade. Incluye análisis técnico, fundamental, de riesgo y decisión del CEO.',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'El activo a evaluar (ej. BTCUSD, EURUSD, US100)' },
        direction: { type: 'string', description: 'Dirección sugerida: BUY o SELL' },
        balance: { type: 'number', description: 'Balance estimado de la cuenta para calcular riesgo (opcional, default 1000)' }
      },
      required: ['ticker', 'direction']
    },
    handler: async (args: { ticker: string; direction: string; balance?: number }) => {
      const { analyzeInvestmentSwarm } = await import('../services/investment.js');
      try {
        const dir = args.direction.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        return await analyzeInvestmentSwarm(args.ticker, dir, args.balance);
      } catch (err: any) {
        return `Error en el Swarm: ${err.message}`;
      }
    }
  }
};

export const getToolsForLLM = async () => {
  const mcpTools = await getMcpTools();

  const internalToolsInfo = Object.values(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }));

  const mcpToolsInfo = mcpTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }));

  return [...internalToolsInfo, ...mcpToolsInfo];
};

export const executeTool = async (name: string, args: ToolArgs): Promise<string> => {
  if (tools[name]) {
    try {
      return await tools[name].handler(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing internal tool ${name}: ${message}`;
    }
  } else {
    // Route to MCP router (auto-discovers which server handles the tool)
    return await executeToolByName(name, args);
  }
};

// Initialize MCP servers at import time
initMcp().catch(e => console.error('[MCP] Init error:', e.message));
