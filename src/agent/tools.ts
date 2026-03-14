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
  execute_terminal_command: {
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
  },
  upload_to_drive: {
    name: 'upload_to_drive',
    description: 'Sube un contenido de texto (Markdown) a Google Drive. Útil para guardar ideas, notas o documentos largos.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Nombre del archivo con extensión .md' },
        content: { type: 'string', description: 'Contenido del archivo en formato texto/markdown' }
      },
      required: ['filename', 'content']
    },
    handler: async (args: { filename: string; content: string }) => {
      const { uploadToDrive } = await import('../google/drive.js');
      try {
        const link = await uploadToDrive(args.filename, args.content);
        return `Archivo subido exitosamente. Puedes verlo aquí: ${link}`;
      } catch (err: any) {
        return `Error al subir a Google Drive: ${err.message}`;
      }
    }
  },
  send_telegram_document: {
    name: 'send_telegram_document',
    description: 'Envía un archivo local del servidor al usuario a través de Telegram. Ideal para enviar PDFs, audios, imágenes u otros contenidos locales.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'La ruta absoluta del archivo local que se desea enviar.' }
      },
      required: ['filePath']
    },
    handler: async (args: { filePath: string }) => {
      const fs = await import('fs');
      if (!fs.existsSync(args.filePath)) {
        return `Error: El archivo no existe en la ruta especificada (${args.filePath}).`;
      }
      
      const { bot } = await import('../bot/telegram.js');
      const { InputFile } = await import('grammy');
      const { config } = await import('../config.js');
      
      const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
      
      try {
        await bot.api.sendDocument(targetUserId, new InputFile(args.filePath));
        return `El archivo ${args.filePath} fue enviado con éxito a Telegram.`;
      } catch (err: any) {
        return `Error al enviar el archivo a Telegram: ${err.message}`;
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
