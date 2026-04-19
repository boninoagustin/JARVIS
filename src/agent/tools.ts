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
    handler: async (args: { command: string }) => {
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
          const { smartTruncate } = await import('../utils/toon.js');
          return smartTruncate(stdout, 2500);
      } catch (err: unknown) {
          const error = err as { stdout?: Buffer; stderr?: Buffer; message: string };
          const output = error.stdout?.toString() || error.stderr?.toString() || '';
          const msg = `Error executing command: ${error.message}\nOutput: ${output}`;
          const { smartTruncate } = await import('../utils/toon.js');
          return smartTruncate(msg, 2500);
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
        console.warn(`[TOOLS] Grammy upload failed, falling back to Vercel API: ${err}`);
        try {
          const fileBuffer = fs.readFileSync(args.filePath);
          const base64Data = fileBuffer.toString('base64');
          
          let fetchFn = globalThis.fetch;
          if (!fetchFn) {
            const nodeFetchObj = await import('node-fetch');
            fetchFn = nodeFetchObj.default as any;
          }
          
          const vercelResponse = await fetchFn('https://jarvis-seven-kappa.vercel.app/api/send-screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ticker: path.basename(args.filePath, path.extname(args.filePath)).replace(/[^a-zA-Z0-9_]/g, ''),
              imageBase64: base64Data,
              message: 'Aquí tienes la captura solicitada.'
            })
          });
          
          if (!vercelResponse.ok) {
            throw new Error(`Vercel API error: ${vercelResponse.status} - ${(await vercelResponse.text())}`);
          }
          return `El archivo ${args.filePath} fue enviado con éxito a Telegram (vía endpoint de fallback).`;
        } catch (fallbackErr: any) {
          return `Error al enviar el archivo a Telegram: ${err instanceof Error ? err.message : String(err)}. Fallback error: ${fallbackErr.message}`;
        }
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
  },
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
  read_youtube_video: {
    name: 'read_youtube_video',
    description: 'Extrae los subtítulos/transcripción de un video de YouTube dado su URL. Útil para resumir videos largos o responder preguntas sobre ellos.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'La URL completa del video de YouTube.' }
      },
      required: ['url']
    },
    handler: async (args: { url: string }) => {
      try {
        const { YoutubeTranscript } = await import('youtube-transcript');
        const transcript = await YoutubeTranscript.fetchTranscript(args.url);
        
        // Unimos el texto
        const fullText = transcript.map(t => t.text).join(' ');
        
        // Usamos nuestro optimizador de contexto por si el video es de 3 horas
        const { smartTruncate } = await import('../utils/toon.js');
        return smartTruncate(fullText, 15000); // Permitimos hasta ~15k caracteres
      } catch (err: any) {
        return `Error al extraer subtítulos (el video puede no tenerlos o tener restricciones): ${err.message}`;
      }
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
