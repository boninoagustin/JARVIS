import { config } from '../config.js';
import { getToolsForLLM } from '../agent/tools.js';

const geminiClient = config.GEMINI_API_KEY ? new (await import('@google/genai').then(m => m.GoogleGenAI))({ apiKey: config.GEMINI_API_KEY }) : null;
// @ts-ignore
const groqClient = config.GROQ_API_KEY ? new (await import('groq-sdk').then(m => m.default))({ apiKey: config.GROQ_API_KEY }) : null;
const openRouterClient = config.OPENROUTER_API_KEY ? config.OPENROUTER_API_KEY : null;

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMResponse {
    text: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export async function generateResponse(messages: ChatMessage[]): Promise<LLMResponse> {
    // 🔇 LLM DESACTIVADO — cuota gratuita de Gemini agotada.
    // El bot opera solo con SMC + AlphaModel (sin análisis de sentimiento).
    // Para reactivar: reemplazar todo el cuerpo de esta función con el
    // código original en git (commit anterior).
    return { text: 'LLM desactivado. Operando con señales SMC.', toolCalls: [] };
}
