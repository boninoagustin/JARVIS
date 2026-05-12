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
