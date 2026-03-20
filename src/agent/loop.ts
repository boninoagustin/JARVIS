import { executeTool, tools } from './tools.js';
import { generateResponse, ChatMessage, LLMResponse } from '../llm/client.js';
import { memory } from '../db/memory.js';

const MAX_ITERATIONS = 10;

const SYSTEM_PROMPT: ChatMessage = {
    role: 'system',
    content: `Eres JARVIS, un asistente personal de IA.
Tu objetivo es ayudar al usuario de forma inteligente, segura y eficiente.
Solo interactúas con tu usuario designado a través de Telegram.
Tienes acceso a una memoria persistente en la nube (Firebase) y herramientas físicas en la máquina host.
Si el usuario te dice que te envió un archivo, significa que se bajó a tu carpeta local 'downloads/'. Usa comandos de terminal (ej. mv o cp) para moverlo a la ubicación que el usuario indique.
Si el usuario te pide empaquetar archivos (.zip) o extraerlos, usa la herramienta execute_terminal_command para correr comandos 'zip' o 'unzip'. Luego, usa 'send_telegram_document' para enviar el resultado.
Si el usuario te pide explícitamente "responde con audio", "canta", "dímelo", "resume esto en un audio" o variaciones, RESPONDE USANDO LA HERRAMIENTA 'send_voice_note'. NO respondas con texto normal.
Si el usuario te pide algo para lo que tienes una herramienta, ¡ÚSALA! Important: The host system is Linux. If the user mentions a Windows drive like "disco Datos" or "disco D", remember it might be mounted at /mnt/d/, /mnt/c/, or /media/user/Datos. Verify paths with 'ls' before assuming they don't exist. Be precise with searches. DO NOT run non-targeted searches like 'find /' which will timeout.
SIEMPRE RESPONDE EN ESPAÑOL, a menos que el usuario explícitamente te pida otro idioma.
Sé educado, conciso y profesional.`
};

export async function processUserMessage(userId: number, text: string, inlineData?: { data: string; mimeType: string }): Promise<string> {
    console.log(`[JARVIS] Procesando mensaje de ${userId}: "${text}"${inlineData ? ' [CON IMAGEN]' : ''}`);
    
    // 1. Obtener historial (últimos 10 mensajes, ANTES de insertar el actual)
    console.log('[JARVIS] Obteniendo historial...');
    const dbHistory = await memory.getHistory(userId, 10);
    
    // 2. Guardar mensaje del usuario en memoria async
    console.log('[JARVIS] Guardando mensaje en memoria...');
    await memory.addMessage(userId, 'user', text);

    // Mapear historial al formato ChatMessage
    const chatHistory: ChatMessage[] = dbHistory.map(h => ({
        role: h.role === 'model' ? 'model' : 'user',
        content: h.content
    }));

    // 3. Preparar contexto añadiendo explícitamente el mensaje actual
    const currentUserMessage: ChatMessage = { role: 'user', content: text };
    if (inlineData) {
        currentUserMessage.inlineData = inlineData;
    }

    const conversation: ChatMessage[] = [
        SYSTEM_PROMPT, 
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
               const result = await executeTool(call.name, call.args);
               console.log(`[Bucle Agente] Resultado de Herramienta: ${result}`);
               
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

    return finalReply;
}
