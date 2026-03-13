import { executeTool, tools } from './tools.js';
import { generateResponse, ChatMessage, LLMResponse } from '../llm/client.js';
import { memory } from '../db/memory.js';

const MAX_ITERATIONS = 5;

// The base system prompt that defines JARVIS behavior
const SYSTEM_PROMPT: ChatMessage = {
    role: 'system',
    content: `You are JARVIS, a personal AI agent running locally. 
You are highly intelligent, strictly follow instructions, and are extremely secure.
You ONLY interact with your designated user via Telegram.
You have access to a persistent cloud memory (Firebase) and physical tools on the host machine.
If the user asks you to do something you have a tool for, USE THE TOOL.
Always respond in the same language the user uses.
Do not hallucinate tool outputs. If a tool fails, tell the user gracefully.`
};

export async function processUserMessage(userId: number, text: string): Promise<string> {
    console.log(`[JARVIS] Processing message from ${userId}: "${text}"`);
    
    // 1. Save user msg to memory
    console.log('[JARVIS] Saving message to memory...');
    await memory.addMessage(userId, 'user', text);

    // 2. Fetch history (last 10 messages)
    console.log('[JARVIS] Fetching history...');
    const dbHistory = await memory.getHistory(userId, 10);
    
    // Map DB history to the ChatMessage interface expected by LLM
    const chatHistory: ChatMessage[] = dbHistory.map(h => ({
        role: h.role === 'model' ? 'model' : 'user',
        content: h.content
    }));

    // 3. Prepare the conversation context
    const conversation: ChatMessage[] = [SYSTEM_PROMPT, ...chatHistory];
    console.log(`[JARVIS] Conversation context prepared with ${conversation.length} messages.`);
    
    let iterations = 0;
    let finalResponseText = '';

    // 4. Autonomous Agent Loop
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        console.log(`[Agent Loop] Iteration ${iterations}/${MAX_ITERATIONS}...`);

        let response: LLMResponse;
        try {
            response = await generateResponse(conversation);
        } catch (err: any) {
            console.error('[Agent Loop] LLM Error:', err);
            finalResponseText = `I encountered an internal error while thinking: ${err.message}`;
            break;
        }

        // If the LLM has text to say, append it
        if (response.content) {
            conversation.push({ role: 'model', content: response.content });
            finalResponseText += response.content + '\n';
        }

        // If the LLM wants to call tools, execute them
        if (response.toolCalls && response.toolCalls.length > 0) {
           const toolCallRecords = response.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) }
           }));
           
           // We push the tool request to history depending on standard (simplified tracking here)
           conversation.push({ 
               role: 'model', 
               content: response.content || '', 
               toolCalls: toolCallRecords as any 
           });

           for (const call of response.toolCalls) {
               console.log(`[Agent Loop] Executing Tool: ${call.name} with args`, call.args);
               const result = await executeTool(call.name, call.args);
               console.log(`[Agent Loop] Tool Result: ${result}`);
               
               // Push tool result back
               conversation.push({
                   role: 'tool',
                   content: result,
                   toolCallId: call.id
               });
           }
           
           // Loop continues so LLM can synthesize the tool result
           continue; 
        }

        // If no tool calls and we got text, we are done
        if (response.content) {
            break;
        }

        // Failsafe exit if LLM returns absolutely nothing
        if (!response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
             finalResponseText = "I processed your request but had nothing to say.";
             break;
        }
    }

    if (iterations >= MAX_ITERATIONS) {
        finalResponseText += "\n[System: Action loop forcibly stopped to prevent infinite recursion]";
    }

    const finalReply = finalResponseText.trim() || 'No response generated.';
    
    // Save JARVIS final textual response to DB memory
    await memory.addMessage(userId, 'model', finalReply);

    return finalReply;
}
