import nodeFetch from 'node-fetch';
import { config } from '../config.js';

// Daniel - Steady Broadcaster. Sounds close to JARVIS/Paul Bettany and speaks Spanish fluently
const VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; 

export async function generateVoice(text: string): Promise<Buffer | null> {
    if (!config.ELEVENLABS_API_KEY) {
        console.warn('[ELEVENLABS] API Key missing in environment.');
        return null;
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
    
    console.log('[ELEVENLABS] Generating voice...');
    try {
        const response = await nodeFetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': config.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error ${response.status}: ${errorText}`);
        }

        const buffer = await response.buffer();
        console.log('[ELEVENLABS] Voice generated successfully.');
        return buffer;
    } catch (error) {
        console.error('[ELEVENLABS ERROR]', error);
        return null;
    }
}
