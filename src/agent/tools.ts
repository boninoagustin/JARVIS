import { execSync } from 'child_process';
import { getN8nTools, executeN8nTool } from '../mcp/client.js';
import { getTradingViewTools, executeTradingViewTool } from '../mcp/tradingview.js';

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
        'curl', 'wget', 'gws'
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
  },
  search_local_file: {
    name: 'search_local_file',
    description: 'Busca un archivo en el PC local por su nombre o parte de él. Retorna las rutas absolutas donde se encontró. Usa esto antes de enviar un archivo por Telegram si no sabes la ruta exacta.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Nombre o parte del nombre del archivo a buscar. Ej: "factura" o "reporte.pdf"' },
        directory: { type: 'string', description: 'Directorio base (ej. /home/agustinbonino/Descargas). Si se omite, buscará en carpetas comunes.' }
      },
      required: ['filename']
    },
    handler: async (args: { filename: string; directory?: string }) => {
      const { execSync } = await import('child_process');
      const baseDirs = args.directory ? [args.directory] : [
          '/home/agustinbonino/Descargas/JARVIS',
          '/home/agustinbonino/Documentos',
          '/home/agustinbonino/Descargas',
          '/home/agustinbonino/Imágenes'
      ];
      
      const safeFilename = args.filename.replace(/[^a-zA-Z0-9_\-\.]/g, '*');
      let stdout = '';
      
      for (const dir of baseDirs) {
        try {
          const cmd = `find "${dir}" -type f -iname "*${safeFilename}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -n 10`;
          stdout += execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
        } catch (err) { /* ignore */ }
      }
      
      if (!stdout.trim()) return `No se encontraron archivos que coincidan con '${args.filename}'. Intenta ampliar la búsqueda o pedir más detalles.`;
      return `Archivos encontrados (puedes usar send_telegram_document con estas rutas):\n${stdout.trim()}`;
    }
  },
  remember_fact: {
    name: 'remember_fact',
    description: 'Guarda un hecho o preferencia sobre el usuario en la memoria persistente a largo plazo.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'El hecho a recordar. Ej: "Al usuario le gusta el color azul" o "Su proyecto principal es JARVIS".' }
      },
      required: ['fact']
    },
    handler: async (args: { fact: string }) => {
      const { memory } = await import('../db/memory.js');
      const { config } = await import('../config.js');
      const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
      await memory.addFact(targetUserId, args.fact);
      return `Hecho recordado exitosamente en Firebase: "${args.fact}"`;
    }
  },
  get_facts: {
    name: 'get_facts',
    description: 'Recupera todos los hechos y preferencias guardados sobre el usuario desde la memoria persistente a largo plazo.',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      const { memory } = await import('../db/memory.js');
      const { config } = await import('../config.js');
      const targetUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
      const facts = await memory.getFacts(targetUserId);
      if (facts.length === 0) return 'No hay hechos recordados sobre el usuario aún.';
      return `Hechos recordados sobre el usuario:\n- ${facts.join('\n- ')}`;
    }
  },
  search_web: {
    name: 'search_web',
    description: 'Busca en la web y devuelve un resumen de los resultados principales y sus URLs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'La consulta de búsqueda.' }
      },
      required: ['query']
    },
    handler: async (args: { query: string }) => {
      const nodeFetch = (await import('node-fetch')).default;
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
        const res = await nodeFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36' }
        });
        const html = await res.text();
        
        const results: string[] = [];
        const regex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
        let match;
        let count = 0;
        
        while ((match = regex.exec(html)) !== null && count < 6) {
            let snippet = match[3].replace(/<\/?[^>]+(>|$)/g, "").replace(/\s+/g, ' ').trim();
            let link = match[1];
            if (link.startsWith('//')) link = 'https:' + link;
            results.push(`URL: ${link}\nSnippet: ${snippet}`);
            count++;
        }
        
        if (results.length === 0) return "No se encontraron resultados parseables. Quizás DuckDuckGo bloqueó la consulta HTML.";
        return `Resultados para "${args.query}":\n\n${results.join('\n\n')}`;
      } catch (err: unknown) {
        return `Error buscando en la web: ${(err as Error).message}`;
      }
    }
  },
  fetch_webpage: {
    name: 'fetch_webpage',
    description: 'Descarga y extrae el texto principal de una página web específica usando su URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'La URL de la página a leer.' }
      },
      required: ['url']
    },
    handler: async (args: { url: string }) => {
      const puppeteer = (await import('puppeteer')).default;
      let browser;
      try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const text = await page.evaluate(() => document.body.innerText);
        await browser.close();
        
        return text.length > 5000 ? text.substring(0, 5000) + '... [TRUNCADO PARA AHORRAR CONTEXTO]' : text;
      } catch (err: unknown) {
        if (browser) await browser.close();
        return `Error leyendo la página web: ${(err as Error).message}`;
      }
    }
  },
  create_calendar_event: {
    name: 'create_calendar_event',
    description: 'Crea un evento en el Google Calendar principal asociado a JARVIS.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Título del evento' },
        description: { type: 'string', description: 'Descripción detallada' },
        startTimeIso: { type: 'string', description: 'Fecha/hora de inicio en formato ISO 8601 (ej. 2026-03-26T10:00:00-03:00)' },
        endTimeIso: { type: 'string', description: 'Fecha/hora de fin en formato ISO 8601 (ej. 2026-03-26T11:00:00-03:00)' }
      },
      required: ['summary', 'description', 'startTimeIso', 'endTimeIso']
    },
    handler: async (args: { summary: string; description: string; startTimeIso: string; endTimeIso: string }) => {
      const { createEvent } = await import('../google/calendar.js');
      try {
        const event = await createEvent(args.summary, args.description, args.startTimeIso, args.endTimeIso);
        return `Evento creado exitosamente: ${event.htmlLink}`;
      } catch (err: unknown) {
        return `Error creando evento: ${(err as Error).message}`;
      }
    }
  },
  get_calendar_events: {
    name: 'get_calendar_events',
    description: 'Recupera los próximos eventos de Google Calendar.',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Número máximo de eventos a devolver (por defecto 10)' }
      }
    },
    handler: async (args: { maxResults?: number }) => {
      const { getEvents } = await import('../google/calendar.js');
      try {
        const events = await getEvents(args.maxResults || 10);
        if (!events || events.length === 0) return 'No se encontraron eventos próximos.';
        const list = events.map((e: any) => `- ${e.summary} (${e.start.dateTime || e.start.date})`).join('\n');
        return `Próximos eventos:\n${list}`;
      } catch (err: unknown) {
        return `Error obteniendo eventos: ${(err as Error).message}`;
      }
    }
  }
};

export const getToolsForLLM = async () => {
  const n8nTools = await getN8nTools();
  const tvTools = await getTradingViewTools();

  const internalToolsInfo = Object.values(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  }));

  const mcpToolsInfo = [...n8nTools, ...tvTools].map(t => ({
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
    // Si no está localmente, verificamos a cuál MCP pertenece
    const n8nTools = await getN8nTools();
    if (n8nTools.find(t => t.name === name)) {
      return await executeN8nTool(name, args);
    }
    
    const tvTools = await getTradingViewTools();
    if (tvTools.find(t => t.name === name)) {
      return await executeTradingViewTool(name, args);
    }

    return `Error: Tool ${name} not found locally or in any MCP servers.`;
  }
};
