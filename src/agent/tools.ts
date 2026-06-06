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
  ctrader_status: {
    name: 'ctrader_status',
    description: 'Muestra el estado de la cuenta de cTrader: balance, equity, posiciones abiertas, y si está conectado.',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const { getAccountInfo, getCTraderStatus } = await import('../services/ctrader.js');
      const status = getCTraderStatus();
      
      if (!status.configured) {
        return '⚠️ cTrader no está configurado. Faltan credenciales en .env (CTRADER_CLIENT_ID, CTRADER_ACCESS_TOKEN).';
      }
      
      const info = await getAccountInfo();
      if (!info) {
        return `🔌 cTrader: ${status.connected ? 'Conectado' : 'Desconectado'} | Modo: ${status.demo ? '🧪 DEMO' : '🔴 LIVE'}\n⚠️ No se pudo obtener info de la cuenta.`;
      }
      
      return `🏦 *ESTADO cTRADER*\n\n` +
        `🔌 Conexión: ${status.connected ? '✅ Conectado' : '❌ Desconectado'}\n` +
        `📊 Modo: ${status.demo ? '🧪 DEMO' : '🔴 LIVE'}\n` +
        `💰 Balance: $${info.balance.toFixed(2)}\n` +
        `📈 Equity: $${info.equity.toFixed(2)}\n` +
        `💵 Moneda: ${info.currency}\n` +
        `📋 Posiciones abiertas: ${info.openPositions}`;
    }
  },
  ctrader_close_all: {
    name: 'ctrader_close_all',
    description: 'KILLSWITCH: Cierra TODAS las posiciones abiertas en cTrader inmediatamente. Usar solo en emergencias.',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Debe ser true para confirmar el cierre de todas las posiciones' }
      },
      required: ['confirm']
    },
    handler: async (args: { confirm: boolean }) => {
      if (!args.confirm) {
        return '⚠️ Debes confirmar con confirm=true para cerrar todas las posiciones.';
      }
      
      const { closeAllPositions } = await import('../services/ctrader.js');
      const result = await closeAllPositions();
      
      if (result.closed === 0 && result.failed === 0) {
        return '✅ No hay posiciones abiertas para cerrar.';
      }
      
      return `🚨 *KILLSWITCH EJECUTADO*\n\n` +
        `✅ Cerradas: ${result.closed}\n` +
        `❌ Fallidas: ${result.failed}`;
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
