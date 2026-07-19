const fs = require('fs');
const file = '/home/bon/Descargas/JARVIS/src/llm/client.ts';
let code = fs.readFileSync(file, 'utf8');

const newFallbacks = `
            try {
                console.log('[LLM] Attempting Gemini 3.5 Flash...');
                return await tryGeminiModel('gemini-3.5-flash');
            } catch (error: any) {
                console.error('[LLM] Gemini 3.5 Flash failed:', error.message);
            }

            try {
                console.log('[LLM] Attempting Gemini 3.1 Flash Lite...');
                return await tryGeminiModel('gemini-3.1-flash-lite');
            } catch (error: any) {
                console.error('[LLM] Gemini 3.1 Flash Lite failed:', error.message);
            }
`;

// Insert the new fallbacks right before the existing Gemini 3 Flash Preview block
code = code.replace(
    /try \{\s*console\.log\('\\[LLM\\] Attempting Gemini 3 Flash Preview\.\.\.'\);/,
    newFallbacks.trim() + '\n\n            try {\n                console.log(\'[LLM] Attempting Gemini 3 Flash Preview...\');'
);

fs.writeFileSync(file, code);
