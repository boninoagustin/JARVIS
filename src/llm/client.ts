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
    toolName?: string; // Original name of the tool (required for Gemini)
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
            console.log('[LLM] Attempting Gemini Native...');
            
            // Extract and clean system instruction
            const systemMsg = messages.find(m => m.role === 'system');
            const history = messages.filter(m => m.role !== 'system');

            // Map tools to Gemini format
            const geminiTools = tools.length > 0 ? [{ 
                functionDeclarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters
                }))
            }] : [];

            // Map history to Gemini content parts
            const contents = history.map(m => {
                if (m.role === 'tool') {
                    return {
                        role: 'user' as const, // Gemini uses 'user' for tool response content in this SDK version
                        parts: [{
                            functionResponse: {
                                name: m.toolName!,
                                response: { result: m.content }
                            }
                        }]
                    };
                }
                
                const parts: any[] = [];
                if (m.content) parts.push({ text: m.content });
                if (m.inlineData) parts.push({ inlineData: m.inlineData });
                
                if (m.toolCalls) {
                    m.toolCalls.forEach(tc => {
                        parts.push({
                            functionCall: {
                                name: tc.function.name,
                                args: JSON.parse(tc.function.arguments)
                            }
                        });
                    });
                }

                return {
                    role: m.role === 'model' ? 'model' as const : 'user' as const,
                    parts: parts
                };
            });

            const response = await geminiClient.models.generateContent({
                model: 'gemini-1.5-flash-latest',
                contents,
                config: {
                    systemInstruction: systemMsg?.content,
                    tools: geminiTools as any
                }
            });

            const text = response.candidates?.[0]?.content?.parts?.find((p: any) => 'text' in p)?.text || null;
            const functionCalls = response.candidates?.[0]?.content?.parts
                ?.filter((p: any) => 'functionCall' in p)
                .map((p: any) => ({
                    id: `call_${Math.random().toString(36).substr(2, 9)}`,
                    name: (p as any).functionCall.name,
                    args: (p as any).functionCall.args
                }));

            return {
                content: text,
                toolCalls: functionCalls?.length ? functionCalls : undefined
            };

        } catch (error: any) {
            console.error('[LLM] Gemini Native failed:', error.message);
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
