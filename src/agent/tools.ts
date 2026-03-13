import { execSync } from 'child_process';

// The interface expected by our custom LLM routing
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  handler: (args: any) => Promise<string> | string;
}

export const tools: Record<string, ToolSchema> = {
  get_current_time: {
    name: 'get_current_time',
    description: 'Get the current local time of the system JARVIS is running on. DO NOT pass any arguments.',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: () => {
      return new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    }
  },
  execute_terminal_command: { // added a basic extra command to give it some real power in local
    name: 'execute_terminal_command',
    description: 'Executes a safe terminal command and returns the output. Use this to read files, run scripts, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' }
      },
      required: ['command']
    },
    handler: (args: { command: string }) => {
      try {
          return execSync(args.command, { encoding: 'utf-8', timeout: 5000 });
      } catch (err: any) {
          return `Error executing command: ${err.message}\nOutput: ${err.stdout || err.stderr}`;
      }
    }
  }
};

export const getToolsForLLM = () => {
  return Object.values(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }));
};

export const executeTool = async (name: string, args: any): Promise<string> => {
  if (!tools[name]) {
    return `Error: Tool ${name} not found.`;
  }
  try {
    return await tools[name].handler(args);
  } catch (err: any) {
    return `Error executing internal tool ${name}: ${err.message}`;
  }
};
