/**
 * Multi-MCP Router — Centralized MCP Server Management
 * 
 * Replaces individual MCP client files (client.ts, tradingview.ts) with
 * a single router that dynamically registers, initializes, and routes
 * tool calls to the appropriate MCP server.
 * 
 * Inspired by: awesome-llm-apps/multi_mcp_agent_router
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../config.js';
import path from 'path';

// ─── Interfaces ───

interface MCPServerConfig {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    timeout?: number;
}

interface MCPServerInstance {
    config: MCPServerConfig;
    client: Client | null;
    transport: StdioClientTransport | null;
    tools: any[];
    isInitializing: boolean;
}

// ─── Tool-to-Server Mapping ───

const toolToServer: Map<string, string> = new Map();

// ─── Server Registry ───

const servers: Map<string, MCPServerInstance> = new Map();

/**
 * Register an MCP server configuration.
 * Does NOT initialize it — call initializeAll() after registering.
 */
export function registerServer(cfg: MCPServerConfig): void {
    servers.set(cfg.name, {
        config: cfg,
        client: null,
        transport: null,
        tools: [],
        isInitializing: false
    });
    console.log(`[MCP Router] Registered server: ${cfg.name}`);
}

/**
 * Initialize a single MCP server instance.
 */
async function initializeServer(instance: MCPServerInstance): Promise<void> {
    if (instance.client) return;
    if (instance.isInitializing) {
        while (instance.isInitializing) {
            await new Promise(r => setTimeout(r, 100));
        }
        return;
    }

    instance.isInitializing = true;
    const name = instance.config.name;

    try {
        console.log(`[MCP Router] Initializing ${name}...`);

        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            MCP_MODE: 'stdio',
            ...(instance.config.env || {})
        };

        instance.transport = new StdioClientTransport({
            command: instance.config.command,
            args: instance.config.args,
            env
        });

        instance.client = new Client(
            { name: `jarvis-${name}-client`, version: '1.0.0' },
            { capabilities: {} }
        );

        await instance.client.connect(instance.transport);

        // Auto-discover tools
        const toolsResponse = await instance.client.listTools();
        instance.tools = toolsResponse.tools || [];

        // Register tool-to-server mapping
        for (const tool of instance.tools) {
            toolToServer.set(tool.name, name);
        }

        console.log(`[MCP Router] ${name} connected — ${instance.tools.length} tools discovered.`);
    } catch (error: any) {
        console.error(`[MCP Router] Failed to initialize ${name}:`, error.message);
        instance.client = null;
        instance.transport = null;
        instance.tools = [];
    } finally {
        instance.isInitializing = false;
    }
}

/**
 * Initialize all registered MCP servers in parallel.
 */
export async function initializeAll(): Promise<void> {
    const initPromises = Array.from(servers.values()).map(s => initializeServer(s));
    await Promise.allSettled(initPromises);
    
    const totalTools = Array.from(servers.values()).reduce((sum, s) => sum + s.tools.length, 0);
    console.log(`[MCP Router] All servers initialized. Total tools: ${totalTools}`);
}

/**
 * Get all tools from all registered MCP servers in unified format.
 */
export async function getAllTools(): Promise<any[]> {
    // Ensure all servers are initialized
    for (const instance of servers.values()) {
        if (!instance.client && !instance.isInitializing) {
            await initializeServer(instance);
        }
    }

    const allTools: any[] = [];
    for (const instance of servers.values()) {
        for (const tool of instance.tools) {
            allTools.push({
                name: tool.name,
                description: tool.description || `Tool ${tool.name} from ${instance.config.name}`,
                parameters: {
                    type: 'object',
                    properties: tool.inputSchema?.properties || {},
                    required: tool.inputSchema?.required || []
                }
            });
        }
    }
    return allTools;
}

/**
 * Execute a tool by name, automatically routing to the correct MCP server.
 */
export async function executeToolByName(
    name: string,
    args: Record<string, unknown>
): Promise<string> {
    const serverName = toolToServer.get(name);
    if (!serverName) {
        return `Error: Tool '${name}' not found in any registered MCP server.`;
    }

    const instance = servers.get(serverName);
    if (!instance?.client) {
        return `Error: MCP server '${serverName}' is not connected.`;
    }

    try {
        const timeout = instance.config.timeout || 15000;
        const result = await Promise.race([
            instance.client.callTool({ name, arguments: args }) as any,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout (${timeout}ms) calling ${name} on ${serverName}`)), timeout)
            )
        ]);

        const textContent = result.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');

        return textContent || 'The tool executed but returned no text content.';
    } catch (error: any) {
        return `Error executing MCP tool '${name}' on ${serverName}: ${error.message}`;
    }
}

/**
 * Get which server handles a given tool.
 */
export function getServerForTool(toolName: string): string | undefined {
    return toolToServer.get(toolName);
}

/**
 * Get a summary of all registered servers and their tool counts.
 */
export function getRouterStatus(): string {
    const lines: string[] = ['[MCP Router Status]'];
    for (const [name, instance] of servers) {
        const status = instance.client ? '✅' : '❌';
        lines.push(`${status} ${name}: ${instance.tools.length} tools`);
    }
    return lines.join('\n');
}

// ─── Default Server Registration ───
// Register n8n and TradingView by default

if (config.N8N_API_URL || config.N8N_API_KEY) {
    const n8nEnv: Record<string, string> = {
        LOG_LEVEL: 'error',
        DISABLE_CONSOLE_OUTPUT: 'true'
    };
    if (config.N8N_API_URL) n8nEnv['N8N_API_URL'] = config.N8N_API_URL;
    if (config.N8N_API_KEY) n8nEnv['N8N_API_KEY'] = config.N8N_API_KEY;

    registerServer({
        name: 'n8n',
        command: 'npx',
        args: ['-y', 'n8n-mcp'],
        env: n8nEnv
    });
}

registerServer({
    name: 'tradingview',
    command: 'node',
    args: [path.resolve(process.cwd(), 'node_modules/tradingview-mcp/src/server.js')],
    timeout: 15000
});
