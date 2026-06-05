/**
 * Smart Memory System for JARVIS
 * 
 * Automatically extracts and stores user preferences, facts, and context
 * from conversations to provide personalized long-term memory.
 * 
 * Inspired by Mem0 architecture, implemented natively with Firebase + Gemini.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { db } from './memory.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

const FACTS_COLLECTION = 'smart_facts';
const MAX_FACTS_PER_USER = 50; // Prevent unlimited growth

/**
 * System prompt for the fact extraction mini-LLM call.
 * Designed to be extremely concise to minimize token usage.
 */
const EXTRACTION_PROMPT = `You are a memory extraction engine. Given a user message and an assistant response, extract ONLY genuinely useful personal facts, preferences, or recurring context about the user.

Rules:
- Output one fact per line, no bullets or numbering
- Use "category: fact" format (categories: trading, communication, schedule, risk, personal, technical)
- Only extract NEW information that would be useful to remember long-term
- Do NOT extract transient requests ("turn on the lights", "what time is it")
- Do NOT extract facts about the assistant
- If there are NO facts worth remembering, output exactly: NONE
- Keep each fact under 100 characters
- Write facts in the same language as the conversation

Examples of good facts:
trading: Prefiere operar BTCUSD en sesión de NY
communication: Le gusta respuestas cortas y directas
risk: Perfil conservador, máximo 2% por trade
schedule: Opera entre 10am-2pm hora Argentina
personal: Se llama Agustín`;

/**
 * Extract facts from a user-assistant exchange using a lightweight LLM call.
 */
export async function extractFacts(userMessage: string, jarvisResponse: string): Promise<string[]> {
    if (!geminiClient) {
        console.warn('[SMART_MEMORY] No Gemini client available for fact extraction.');
        return [];
    }

    try {
        const response = await geminiClient.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: [{
                role: 'user',
                parts: [{ text: `User message: "${userMessage}"\n\nAssistant response: "${jarvisResponse.substring(0, 500)}"` }]
            }],
            config: {
                systemInstruction: EXTRACTION_PROMPT,
                maxOutputTokens: 200, // Keep it cheap
                temperature: 0.1 // Deterministic extraction
            }
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        
        if (!text || text === 'NONE') return [];

        // Parse facts: one per line, filter empty
        const facts = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line !== 'NONE' && line.includes(':'));

        console.log(`[SMART_MEMORY] Extracted ${facts.length} facts.`);
        return facts;
    } catch (error: any) {
        console.error('[SMART_MEMORY] Fact extraction failed:', error.message);
        return [];
    }
}

/**
 * Store facts in Firebase, deduplicating against existing facts.
 * If a new fact contradicts or updates an existing one in the same category,
 * the old fact is replaced.
 */
export async function storeFacts(userId: number, newFacts: string[]): Promise<void> {
    if (!db || newFacts.length === 0) return;

    try {
        const factsRef = db.collection('conversations')
            .doc(userId.toString())
            .collection(FACTS_COLLECTION);

        // Get existing facts
        const existingSnapshot = await factsRef.orderBy('created_at', 'asc').get();
        const existingFacts = existingSnapshot.docs.map(doc => ({
            id: doc.id,
            fact: doc.data().fact as string,
            category: doc.data().category as string
        }));

        const batch = db.batch();
        let addedCount = 0;

        for (const newFact of newFacts) {
            // Parse category from "category: fact content"
            const colonIndex = newFact.indexOf(':');
            const category = colonIndex > 0 ? newFact.substring(0, colonIndex).trim().toLowerCase() : 'general';
            const factContent = colonIndex > 0 ? newFact.substring(colonIndex + 1).trim() : newFact;

            // Check for duplicates: same category with similar content
            const duplicate = existingFacts.find(ef => {
                if (ef.category !== category) return false;
                // Simple similarity: if 60%+ of words match, consider it a duplicate/update
                const existingWords = new Set(ef.fact.toLowerCase().split(/\s+/));
                const newWords = factContent.toLowerCase().split(/\s+/);
                const matchCount = newWords.filter(w => existingWords.has(w)).length;
                return matchCount / Math.max(newWords.length, 1) > 0.6;
            });

            if (duplicate) {
                // Update existing fact
                const docRef = factsRef.doc(duplicate.id);
                batch.update(docRef, { 
                    fact: factContent, 
                    category,
                    updated_at: new Date()
                });
                console.log(`[SMART_MEMORY] Updated fact [${category}]: "${factContent}"`);
            } else {
                // Check limit before adding
                if (existingFacts.length + addedCount >= MAX_FACTS_PER_USER) {
                    console.warn(`[SMART_MEMORY] User ${userId} reached max facts limit (${MAX_FACTS_PER_USER}).`);
                    break;
                }

                const newDocRef = factsRef.doc();
                batch.set(newDocRef, {
                    fact: factContent,
                    category,
                    created_at: new Date(),
                    updated_at: new Date()
                });
                addedCount++;
                console.log(`[SMART_MEMORY] New fact [${category}]: "${factContent}"`);
            }
        }

        await batch.commit();
        console.log(`[SMART_MEMORY] Stored/updated facts for user ${userId}.`);
    } catch (error: any) {
        console.error('[SMART_MEMORY] Error storing facts:', error.message);
    }
}

/**
 * Retrieve all stored facts for a user, formatted as a context string
 * ready to be injected into the system prompt.
 */
export async function getSmartContext(userId: number): Promise<string> {
    if (!db) return '';

    try {
        const snapshot = await db.collection('conversations')
            .doc(userId.toString())
            .collection(FACTS_COLLECTION)
            .orderBy('category')
            .get();

        if (snapshot.empty) return '';

        // Group by category for clean formatting
        const grouped: Record<string, string[]> = {};
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const cat = data.category || 'general';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(data.fact);
        });

        let context = 'Datos que recuerdas sobre este usuario:\n';
        for (const [category, facts] of Object.entries(grouped)) {
            context += `[${category}] ${facts.join('; ')}\n`;
        }

        return context.trim();
    } catch (error: any) {
        console.error('[SMART_MEMORY] Error fetching smart context:', error.message);
        return '';
    }
}

/**
 * Clear all stored facts for a user (for /forget command).
 */
export async function clearFacts(userId: number): Promise<void> {
    if (!db) return;

    try {
        const MAX_BATCH = 490;
        const collRef = db.collection('conversations')
            .doc(userId.toString())
            .collection(FACTS_COLLECTION);

        let snapshot = await collRef.limit(MAX_BATCH).get();
        let totalDeleted = 0;

        while (!snapshot.empty) {
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            totalDeleted += snapshot.docs.length;
            if (snapshot.docs.length < MAX_BATCH) break;
            snapshot = await collRef.limit(MAX_BATCH).get();
        }

        if (totalDeleted > 0) {
            console.log(`[SMART_MEMORY] Cleared ${totalDeleted} facts for user ${userId}.`);
        }
    } catch (error: any) {
        console.error('[SMART_MEMORY] Error clearing facts:', error.message);
    }
}
