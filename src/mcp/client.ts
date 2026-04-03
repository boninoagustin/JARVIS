import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../config.js';

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let isInitializing = false;

// We export these internal state so we don't fetch tools again if not needed
let cachedTools: any[] | null = null;

export async function initializeN8nMCP() {
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
    console.log('[MCP] Initializing n8n-mcp client...');
    
    // Configurar entorno para n8n-mcp
    const env: Record<string, string> = {
      ...process.env,
      MCP_MODE: 'stdio',
      LOG_LEVEL: 'error',
      DISABLE_CONSOLE_OUTPUT: 'true',
    };

    if (config.N8N_API_URL) {
      env['N8N_API_URL'] = config.N8N_API_URL;
    }
    if (config.N8N_API_KEY) {
      env['N8N_API_KEY'] = config.N8N_API_KEY;
    }

    mcpTransport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', 'n8n-mcp'],
        env
    });

    mcpClient = new Client({
        name: 'jarvis-mcp-client',
        version: '1.0.0'
    }, {
        capabilities: {}
    });

    await mcpClient.connect(mcpTransport);
    console.log('[MCP] n8n-mcp client connected successfully.');
    
    // Fetch tools to cache them immediately
    const toolsResponse = await mcpClient.listTools();
    cachedTools = toolsResponse.tools;
    console.log(`[MCP] Loaded ${cachedTools.length} tools from n8n-mcp.`);

  } catch (error) {
    console.error('[MCP] Failed to initialize N8N MCP:', error);
    mcpClient = null;
    mcpTransport = null;
  } finally {
    isInitializing = false;
  }

  return mcpClient;
}

export async function getN8nTools() {
  await initializeN8nMCP();
  if (!mcpClient || !cachedTools) return [];

  // Mapeamos las herramientas de MCP al formato ToolSchema de JARVIS
  return cachedTools.map(tool => ({
    name: tool.name,
    description: tool.description || `Tool ${tool.name} from N8N MCP`,
    parameters: {
      type: 'object',
      properties: tool.inputSchema?.properties || {},
      required: tool.inputSchema?.required || []
    },
    handler: async (args: any) => {
      return executeN8nTool(tool.name, args);
    }
  }));
}

export async function executeN8nTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await initializeN8nMCP();
  if (!client) {
    return `Error: MCP client is not initialized to run tool ${name}.`;
  }
  
  try {
    const result = await client.callTool({
      name,
      arguments: args
    }) as any;
    
    // Adapt MCP text results
    const textContent = result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    return textContent || 'The tool executed but returned no text content.';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Error executing N8N MCP tool '${name}': ${msg}`;
  }
}
