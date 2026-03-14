import { GoogleGenAI } from '@google/genai';
import { Groq, toFile } from 'groq-sdk';
import { config } from '../config.js';
import { getToolsForLLM } from '../agent/tools.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;
const groqClient = config.GROQ_API_KEY ? new Groq({ apiKey: config.GROQ_API_KEY }) : null;

// The unified message structure
export interface ChatMessage {
    role: 'user' | 'model' | 'system' | 'tool';
    content: string;
    toolCalls?: any[]; // Groq/OpenAI compatible tool calls
    toolCallId?: string; // Groq/OpenAI compatible tool response ID
    inlineData?: { data: string; mimeType: string };
}

export interface LLMResponse {
    content: string | null;
    toolCalls?: { id: string, name: string; args: any }[];
}

export async function generateResponse(messages: ChatMessage[]): Promise<LLMResponse> {
    const tools = getToolsForLLM();

    // 1. Try Gemini
    if (geminiClient) {
        try {
            console.log('[LLM] Attempting Gemini...');
            // Convert messages to Gemini format
            const geminiMessages = messages.map(m => {
                if (m.role === 'tool') {
                    return { role: 'user', parts: [{ text: `[Tool Result for ${m.toolCallId}]:\n${m.content}` }] };
                }
                if (m.toolCalls) {
                    return { role: 'model', parts: [{ text: m.content || '[Tool Invocation]' }] };
                }
                const parts: any[] = [{ text: m.content }];
                if (m.inlineData) {
                    parts.push({ inlineData: m.inlineData });
                }
                return {
                    role: m.role === 'system' ? 'user' : m.role,
                    parts: parts
                }
            });

            // The new generic genai SDK expects format. We use gemini-2.5-flash as default 
            // but let's emulate function calling by appending tool descriptions to system prompt 
            // for simplicity, or leverage their specific native tool calling types if needed.
            // We'll use a standard prompt approach for high fallback compatibility.

            // Since we are building an agent from scratch, let's inject tool schemas 
            // into the system message and request JSON responses when tools are needed.

            console.log('[GEMINI] Calling gemini-flash-latest...');
            const response = await geminiClient.models.generateContent({
                model: 'gemini-flash-latest',
                contents: geminiMessages,
            });
            console.log('[GEMINI] Response received.');

            // Temporary logic: the new @google/genai syntax might differ slightly on tool calls,
            // so we catch errors to fallback gracefully if it fails parsing tools.
            return {
                content: response.text || null,
                toolCalls: response.functionCalls?.map((f: any) => ({
                    id: `call_${Math.random().toString(36).substr(2, 9)}`,
                    name: f.name,
                    args: f.args
                }))
            }
        } catch (error: any) {
            console.error('[LLM] Gemini request failed:', error.message);
        }
    }

    // 2. Try Groq (Fallback)
    if (groqClient) {
        try {
            console.log('[LLM] Attempting Groq Fallback (Llama 3.3 70B)...');
            const groqMessages = messages.map(m => {
                const base: any = { role: m.role === 'model' ? 'assistant' : m.role, content: m.content || '' };
                if (m.toolCalls) base.tool_calls = m.toolCalls;
                if (m.toolCallId) base.tool_call_id = m.toolCallId;
                return base;
            });

            const completion = await groqClient.chat.completions.create({
                messages: groqMessages,
                model: 'llama-3.3-70b-versatile',
                tools: tools as any,
                tool_choice: 'auto'
            });

            const choice = completion.choices[0].message;
            return {
                content: choice.content,
                toolCalls: choice.tool_calls?.map(tc => ({
                    id: tc.id,
                    name: tc.function.name,
                    args: JSON.parse(tc.function.arguments)
                }))
            };
        } catch (error: any) {
            console.error('[LLM] Groq request failed:', error.message);
        }
    }

    // 3. Optional OpenRouter could go here...

    throw new Error('All configured LLM providers failed or no API keys are configured.');
}

/**
 * Audio Transcription using Groq Whisper
 */
export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
    if (!groqClient) {
        throw new Error('Groq API Key not configured. Transcription unavailable.');
    }

    try {
        console.log('[GROQ] Transcribing audio...');
        const fileObj = await toFile(audioBuffer, filename);
        
        const transcription = await groqClient.audio.transcriptions.create({
            file: fileObj,
            model: 'whisper-large-v3-turbo',
            language: 'es', // Force Spanish as requested
            response_format: 'text',
        });

        console.log('[GROQ] Transcription complete.');
        // @ts-ignore - Groq SDK returns string if format is text
        return transcription.trim();
    } catch (error: any) {
        console.error('[GROQ] Transcription failed:', error.message);
        throw new Error(`Failed to transcribe audio: ${error.message}`);
    }
}
