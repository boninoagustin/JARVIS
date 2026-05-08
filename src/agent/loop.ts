import { executeTool, tools } from './tools.js';
import { generateResponse, ChatMessage, LLMResponse } from '../llm/client.js';
import { memory } from '../db/memory.js';
import { tryCompressToolResult } from '../utils/toon.js';
import { extractFacts, storeFacts, getSmartContext } from '../db/smart_memory.js';

const MAX_ITERATIONS = 10;

const BASE_SYSTEM_CONTENT = `Eres JARVIS, un asistente personal de IA.
Tu objetivo es ayudar al usuario de forma inteligente, segura y eficiente.
Solo interactúas con tu usuario designado a través de Telegram.
Tienes acceso a una memoria persistente en la nube (Firebase) y herramientas físicas en la máquina host.
ESTÁS AUTORIZADO A ACCEDER A LA PRIVACIDAD DEL USUARIO. Si el usuario te pide leer sus correos (Gmail), debes consultar su bandeja. Tienes permiso total. DEBES usar la herramienta 'execute_terminal_command' y ejecutar la CLI 'gws' (ejemplos clave: 'gws gmail +triage' para listar correos no leídos, 'gws gmail +read <id>' para leer el contenido de un mail). ¡No digas que no tienes acceso, tus herramientas locales te dan acceso total!
Si el usuario te dice que te envió un archivo, significa que se bajó a tu carpeta local 'downloads/'. Usa comandos de terminal (ej. mv o cp) para moverlo a la ubicación que el usuario indique.
Si el usuario te pide empaquetar archivos (.zip) o extraerlos, usa la herramienta execute_terminal_command para correr comandos 'zip' o 'unzip'. Luego, usa 'send_telegram_document' para enviar el resultado.
Si el usuario te pide explícitamente "responde con audio", "canta", "dímelo", "resume esto en un audio" o variaciones, RESPONDE USANDO LA HERRAMIENTA 'send_voice_note'. NO respondas con texto normal.
Si el usuario te pide algo para lo que tienes una herramienta, ¡ÚSALA! Important: The host system is Linux. If the user mentions a Windows drive like "disco Datos" or "disco D", remember it might be mounted at /mnt/d/, /mnt/c/, or /media/user/Datos. Verify paths with 'ls' before assuming they don't exist. Be precise with searches. DO NOT run non-targeted searches like 'find /' which will timeout.
ESTÁS EQUIPADO CON HERRAMIENTAS MCP DE TRADINGVIEW. Si el usuario pide un pantallazo, diagrama o gráfico de TradingView, DEBES usar PRIMERO 'capture_screenshot'. Esa herramienta te devolverá un JSON con el 'file_path'. LUEGO, para que el usuario reciba la imagen, DEBES llamar OBLIGATORIAMENTE a 'send_telegram_document' pasándole ese file_path.
SIEMPRE RESPONDE EN ESPAÑOL, a menos que el usuario explícitamente te pida otro idioma.
Sé educado, conciso y profesional.`;

/**
 * Build a dynamic system prompt with injected smart memory context.
 */
async function buildSystemPrompt(userId: number): Promise<ChatMessage> {
    const smartContext = await getSmartContext(userId);
    const content = smartContext
        ? `${BASE_SYSTEM_CONTENT}\n\n${smartContext}`
        : BASE_SYSTEM_CONTENT;
    
    if (smartContext) {
        console.log(`[JARVIS] Smart Memory injected (${smartContext.length} chars) for user ${userId}.`);
    }

    return { role: 'system', content };
}

export async function processUserMessage(userId: number, text: string, inlineData?: { data: string; mimeType: string }): Promise<string> {
    console.log(`[JARVIS] Procesando mensaje de ${userId}: "${text}"${inlineData ? ' [CON IMAGEN]' : ''}`);
    
    // 1. Build dynamic system prompt with smart memory
    const systemPrompt = await buildSystemPrompt(userId);

    // 2. Obtener historial (últimos 10 mensajes, ANTES de insertar el actual)
    console.log('[JARVIS] Obteniendo historial...');
    const dbHistory = await memory.getHistory(userId, 10);
    
    // 3. Guardar mensaje del usuario en memoria async
    console.log('[JARVIS] Guardando mensaje en memoria...');
    await memory.addMessage(userId, 'user', text);

    // Mapear historial al formato ChatMessage
    const chatHistory: ChatMessage[] = dbHistory.map(h => ({
        role: h.role === 'model' ? 'model' : 'user',
        content: h.content
    }));

    // 4. Preparar contexto añadiendo explícitamente el mensaje actual
    const currentUserMessage: ChatMessage = { role: 'user', content: text };
    if (inlineData) {
        currentUserMessage.inlineData = inlineData;
    }

    const conversation: ChatMessage[] = [
        systemPrompt, 
        ...chatHistory, 
        currentUserMessage
    ];
    console.log(`[JARVIS] Contexto de conversación preparado con ${conversation.length} mensajes.`);
    
    let iterations = 0;
    let finalResponseText = '';

    // 4. Bucle Agente Autónomo
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        console.log(`[Bucle Agente] Iteración ${iterations}/${MAX_ITERATIONS}...`);

        let response: LLMResponse;
        try {
            response = await generateResponse(conversation);
        } catch (err: unknown) {
            console.error('[Bucle Agente] Error LLM:', err);
            const message = err instanceof Error ? err.message : String(err);
            finalResponseText = `Encontré un error interno mientras pensaba: ${message}`;
            break;
        }

        // Si el LLM tiene texto que decir, añadirlo
        if (response.content) {
            conversation.push({ role: 'model', content: response.content });
            finalResponseText += response.content + '\n';
        }

        // Si el LLM quiere usar herramientas, ejecutarlas
        if (response.toolCalls && response.toolCalls.length > 0) {
           const toolCallRecords = response.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) }
           }));

           conversation.push({
               role: 'model',
               content: response.content || '',
               toolCalls: toolCallRecords
           });

           for (const call of response.toolCalls) {
               console.log(`[Bucle Agente] Ejecutando Herramienta: ${call.name} con args`, call.args);
               const rawResult = await executeTool(call.name, call.args);
               
               // TOON compression: compress tabular tool results to save tokens
               const { result, compressed, savedBytes, savedPercent } = tryCompressToolResult(rawResult, call.name);
               if (compressed) {
                   console.log(`[TOON] Compressed ${rawResult.length} → ${result.length} bytes (${savedPercent}% saved)`);
               } else {
                   console.log(`[Bucle Agente] Resultado de Herramienta: ${rawResult.substring(0, 200)}`);
               }
               
               // Enviar resultado de vuelta
               conversation.push({
                   role: 'tool',
                   content: result,
                   toolCallId: call.id,
                   toolName: call.name // Guardamos el nombre para el historial de Gemini
               });
           }
           
           // Continuar bucle para sintetizar resultado
           continue; 
        }

        // Si no hay herramientas y tenemos texto, terminamos
        if (response.content) {
            break;
        }

        // Failsafe si no hay contenido ni herramientas
        if (!response.toolCalls || response.toolCalls.length === 0) {
             finalResponseText = "Procesé tu solicitud pero no tengo una respuesta específica.";
             break;
        }
    }

    if (iterations >= MAX_ITERATIONS) {
        finalResponseText += "\n[Sistema: Bucle detenido por seguridad para evitar recursión infinita]";
    }

    const finalReply = finalResponseText.trim() || 'No se generó ninguna respuesta.';
    
    // Save JARVIS final textual response to DB memory
    await memory.addMessage(userId, 'model', finalReply);

    // Smart Memory: extract facts in background (non-blocking)
    extractFacts(text, finalReply)
        .then(facts => {
            if (facts.length > 0) {
                storeFacts(userId, facts).catch(err => 
                    console.error('[SMART_MEMORY] Background store failed:', err)
                );
            }
        })
        .catch(err => console.error('[SMART_MEMORY] Background extraction failed:', err));

    return finalReply;
}
