import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let isInitializing = false;

// We export these internal state so we don't fetch tools again if not needed
let cachedTools: any[] | null = null;

export async function initializeTradingViewMCP() {
  if (mcpClient) return mcpClient;
  if (isInitializing) {
    // Wait until initialized if it's currently initializing
    while (isInitializing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return mcpClient;
  }

  isInitializing = true;
  try {
    console.log('[MCP] Initializing tradingview-mcp client...');
    
    const env: Record<string, string> = {
      ...process.env,
      MCP_MODE: 'stdio'
    };

    mcpTransport = new StdioClientTransport({
        command: 'node',
        args: [path.resolve(process.cwd(), 'node_modules/tradingview-mcp/src/server.js')],
        env
    });

    mcpClient = new Client({
        name: 'jarvis-tv-client',
        version: '1.0.0'
    }, {
        capabilities: {}
    });

    await mcpClient.connect(mcpTransport);
    console.log('[MCP] tradingview-mcp client connected successfully.');
    
    // Fetch tools to cache them immediately
    const toolsResponse = await mcpClient.listTools();
    cachedTools = toolsResponse.tools;
    console.log(`[MCP] Loaded ${cachedTools?.length || 0} tools from tradingview-mcp.`);

  } catch (error) {
    console.error('[MCP] Failed to initialize TradingView MCP:', error);
    mcpClient = null;
    mcpTransport = null;
  } finally {
    isInitializing = false;
  }

  return mcpClient;
}

export async function getTradingViewTools() {
  await initializeTradingViewMCP();
  if (!mcpClient || !cachedTools) return [];

  return cachedTools.map(tool => ({
    name: tool.name,
    description: tool.description || `Tool ${tool.name} from TradingView MCP`,
    parameters: {
      type: 'object',
      properties: tool.inputSchema?.properties || {},
      required: tool.inputSchema?.required || []
    },
    handler: async (args: any) => {
      return executeTradingViewTool(tool.name, args);
    }
  }));
}

export async function executeTradingViewTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await initializeTradingViewMCP();
  if (!client) {
    return `Error: TradingView MCP client is not initialized to run tool ${name}.`;
  }
  
  try {
    const timeoutMs = 15000;
    const result = await Promise.race([
      client.callTool({ name, arguments: args }) as any,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms). Asegúrate de que TradingView Desktop esté abierto en la PC con el puerto de debugging habilitado (--remote-debugging-port=9222).`)), timeoutMs))
    ]);
    
    // Adapt MCP text results
    const textContent = result.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return textContent || 'The tool executed but returned no text content.';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error executing TradingView MCP tool '${name}': ${msg}`;
  }
}
