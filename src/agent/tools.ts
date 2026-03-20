import { execSync } from 'child_process';

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
  handler: (args: ToolArgs) => Promise<string> | string;
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
      // Whitelist de comandos permitidos por seguridad
      const ALLOWED_COMMANDS = [
        'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'du',
        'pwd', 'whoami', 'date', 'echo', 'which', 'dirname', 'basename',
        'git status', 'git log', 'git diff', 'git branch', 'git remote',
        'npm run', 'npm test', 'npm list', 'npx tsc --noEmit',
        'node --version', 'npm --version',
        'curl', 'wget'
      ];

      const cmdStart = args.command.trim().split(' ')[0];
      const isAllowed = ALLOWED_COMMANDS.some(allowed =>
        args.command.trim().startsWith(allowed) || cmdStart === allowed.split(' ')[0]
      );

      // Bloquear comandos peligrosos
      const DANGEROUS_PATTERNS = [
        /rm\s+-rf/, /rm\s+--/, /rm\s+\/$/,
        />\s*\/dev/, /mkfs/, /dd\s+if=/,
        /chmod\s+777/, /chown\s+root/,
        /\|\s*bash/, /\|\s*sh/, /\|\s*zsh/,
        /sudo/, /su\s+/, /passwd/,
        /eval\s*\(/, /exec\s*\(/
      ];

      const isDangerous = DANGEROUS_PATTERNS.some(pattern => pattern.test(args.command));

      if (!isAllowed || isDangerous) {
        return `Error: Comando no permitido por seguridad: "${args.command}". Comandos permitidos: ls, cat, head, tail, grep, find, git status/log/diff, npm run/test.`;
      }

      try {
          const stdout = execSync(args.command as string, { encoding: 'utf-8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
          return stdout.length > 2500 ? stdout.substring(0, 2500) + '\n...[TRUNCATED FOR LENGTH. IF YOU NEED MORE DETAIL, REFINE YOUR SEARCH]' : stdout;
      } catch (err: unknown) {
          const error = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          const output = error.stdout?.toString() || error.stderr?.toString() || '';
          const msg = `Error executing command: ${error.message}\nOutput: ${output}`;
          return msg.length > 2500 ? msg.substring(0, 2500) + '\n...[TRUNCATED FOR LENGTH. COMMAND FAILED OR TIMED OUT]' : msg;
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error al subir a Google Drive: ${message}`;
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
      const path = await import('path');

      // Whitelist de directorios permitidos para evitar path traversal
      const ALLOWED_DIRS = [
        '/home/agustinbonino/Descargas/JARVIS',
        '/home/agustinbonino/Descargas',
        '/tmp'
      ];

      const resolvedPath = path.resolve(args.filePath);

      const isAllowed = ALLOWED_DIRS.some(allowedDir => {
        const normalized = path.resolve(allowedDir);
        return resolvedPath.startsWith(normalized + path.sep) || resolvedPath === normalized;
      });

      if (!isAllowed) {
        return `Error: Acceso denegado. El archivo debe estar en: ${ALLOWED_DIRS.join(', ')}`;
      }

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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error al enviar el archivo a Telegram: ${message}`;
      }
    }
  },
  set_reminder: {
    name: 'set_reminder',
    description: 'Programa un recordatorio o alarma para enviarle un mensaje al usuario en una cantidad específica de minutos. Úsalo cuando el usuario te pida "recuérdame en X tiempo".',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Cantidad de minutos a esperar antes de enviar el recordatorio.' },
        message: { type: 'string', description: 'El mensaje que debes enviarle al usuario cuando se cumpla el tiempo.' }
      },
      required: ['minutes', 'message']
    },
    handler: async (args: { minutes: number; message: string }) => {
      const { bot } = await import('../bot/telegram.js');
      const { config } = await import('../config.js');
      const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
      
      const milliseconds = Math.max(1, args.minutes) * 60 * 1000;
      
      // Lanzar el timer sin await para no bloquear
      setTimeout(async () => {
        try {
          await bot.api.sendMessage(targetUserId, `⏰ **Recordatorio:**\n\n${args.message}`, { parse_mode: 'Markdown' });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.error('[REMINDER ERROR]', message);
        }
      }, milliseconds);
      
      return `Recordatorio agendado exitosamente para dentro de ${args.minutes} minutos.`;
    }
  },
  send_voice_note: {
    name: 'send_voice_note',
    description: 'Genera y envía una nota de voz al usuario. Úsalo SÓLO cuando el usuario explícitamente pida "responde con audio", "canta", "dimelo en un audio". No lo uses por defecto.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'El texto que debe ser hablado (sintetizado a voz). Máximo ~1000 caracteres.' }
      },
      required: ['text']
    },
    handler: async (args: { text: string }) => {
      const { generateVoice } = await import('../llm/elevenlabs.js');
      const { bot } = await import('../bot/telegram.js');
      const { config } = await import('../config.js');
      const { InputFile } = await import('grammy');
      const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
      
      try {
        const audioBuffer = await generateVoice(args.text);
        if (audioBuffer) {
           await bot.api.sendVoice(targetUserId, new InputFile(audioBuffer, 'voice.mp3'));
           return 'El audio fue generado y enviado exitosamente.';
        } else {
           return 'Error: No se pudo generar el audio (Buffer nulo).';
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error al generar/enviar el audio: ${message}`;
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

export const executeTool = async (name: string, args: ToolArgs): Promise<string> => {
  if (!tools[name]) {
    return `Error: Tool ${name} not found.`;
  }
  try {
    return await tools[name].handler(args);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error executing internal tool ${name}: ${message}`;
  }
};
