/**
 * Mixture of Agents — Multi-LLM Voting System
 * 
 * Queries Gemini, Groq, and OpenRouter in parallel with the same trading
 * evaluation prompt. Aggregates votes to produce a consensus decision.
 * 
 * Only activated for high-quality signals (8+ points in Scalper).
 * Inspired by: awesome-llm-apps/mixture_of_agents
 */

import { GoogleGenAI } from '@google/genai';
import { Groq } from 'groq-sdk';
import OpenAI from 'openai';
import { config } from '../config.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;
const groqClient = config.GROQ_API_KEY ? new Groq({ apiKey: config.GROQ_API_KEY }) : null;
const openRouterClient = config.OPENROUTER_API_KEY ? new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.OPENROUTER_API_KEY }) : null;

// ─── Interfaces ───

export interface AgentVote {
    provider: string;
    decision: 'CONFIRM' | 'REJECT';
    reasoning: string;
    confidence: number;
}

export interface MixtureResult {
    consensus: 'CONFIRMED' | 'MIXED' | 'REJECTED';
    votes: AgentVote[];
    overallConfidence: number;
    summary: string;
}

// ─── Voting Prompt ───

const VOTING_PROMPT = `Eres un trader institucional evaluando un setup de trading. Analiza el contexto y decide si el trade es válido.

RESPONDE SOLO EN JSON sin backticks:
{"decision":"CONFIRM" o "REJECT","reasoning":"explicación en 1 oración","confidence":0-100}

Criterios para CONFIRM: confluencia macro, liquidez barrida, zonas institucionales tocadas, alineación multi-timeframe.
Criterios para REJECT: falta de confirmación, contra-tendencia sin soporte, ruido de mercado.`;

// ─── Individual LLM Calls ───

async function askGemini(context: string): Promise<AgentVote | null> {
    if (!geminiClient) return null;
    try {
        const res = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: context }] }],
            config: { systemInstruction: VOTING_PROMPT, maxOutputTokens: 150, temperature: 0.2 }
        });
        const text = res.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) return null;
        const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        return {
            provider: 'Gemini',
            decision: parsed.decision === 'CONFIRM' ? 'CONFIRM' : 'REJECT',
            reasoning: parsed.reasoning || '',
            confidence: Math.min(100, Math.max(0, parsed.confidence || 50))
        };
    } catch (e: any) {
        console.error('[MIXTURE] Gemini vote error:', e.message);
        return null;
    }
}

async function askGroq(context: string): Promise<AgentVote | null> {
    if (!groqClient) return null;
    try {
        const completion = await groqClient.chat.completions.create({
            messages: [
                { role: 'system', content: VOTING_PROMPT },
                { role: 'user', content: context }
            ],
            model: 'llama-3.3-70b-versatile',
            max_tokens: 150,
            temperature: 0.2
        });
        const text = completion.choices[0]?.message?.content?.trim();
        if (!text) return null;
        const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        return {
            provider: 'Groq (Llama)',
            decision: parsed.decision === 'CONFIRM' ? 'CONFIRM' : 'REJECT',
            reasoning: parsed.reasoning || '',
            confidence: Math.min(100, Math.max(0, parsed.confidence || 50))
        };
    } catch (e: any) {
        console.error('[MIXTURE] Groq vote error:', e.message);
        return null;
    }
}

async function askOpenRouter(context: string): Promise<AgentVote | null> {
    if (!openRouterClient) return null;
    try {
        const completion = await openRouterClient.chat.completions.create({
            messages: [
                { role: 'system', content: VOTING_PROMPT },
                { role: 'user', content: context }
            ],
            model: config.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
            max_tokens: 150,
            temperature: 0.2
        });
        const text = completion.choices[0]?.message?.content?.trim();
        if (!text) return null;
        const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        return {
            provider: 'OpenRouter',
            decision: parsed.decision === 'CONFIRM' ? 'CONFIRM' : 'REJECT',
            reasoning: parsed.reasoning || '',
            confidence: Math.min(100, Math.max(0, parsed.confidence || 50))
        };
    } catch (e: any) {
        console.error('[MIXTURE] OpenRouter vote error:', e.message);
        return null;
    }
}

// ─── Main Evaluation ───

/**
 * Evaluate a trading signal using multiple LLMs in parallel.
 * Returns a consensus decision based on majority voting.
 */
export async function evaluateWithMixture(
    context: string,
    direction: 'BUY' | 'SELL'
): Promise<MixtureResult> {
    console.log(`[MIXTURE] Evaluating ${direction} signal with 3 LLMs...`);

    const evalContext = `SETUP DE TRADING:\nDirección: ${direction}\n\n${context}`;

    // Query all 3 LLMs in parallel
    const [geminiVote, groqVote, orVote] = await Promise.all([
        askGemini(evalContext),
        askGroq(evalContext),
        askOpenRouter(evalContext)
    ]);

    const votes = [geminiVote, groqVote, orVote].filter((v): v is AgentVote => v !== null);
    
    if (votes.length === 0) {
        return {
            consensus: 'MIXED',
            votes: [],
            overallConfidence: 0,
            summary: '🗳️ No se obtuvieron votos de ningún LLM.'
        };
    }

    // Count votes
    const confirms = votes.filter(v => v.decision === 'CONFIRM').length;
    const total = votes.length;
    const avgConfidence = Math.round(votes.reduce((sum, v) => sum + v.confidence, 0) / total);

    let consensus: 'CONFIRMED' | 'MIXED' | 'REJECTED';
    if (confirms >= Math.ceil(total / 2 + 0.1)) {
        consensus = 'CONFIRMED'; // Majority confirms
    } else if (confirms === 0) {
        consensus = 'REJECTED'; // All reject
    } else {
        consensus = 'MIXED'; // Split decision
    }

    // Build summary
    const voteDetails = votes.map(v => {
        const icon = v.decision === 'CONFIRM' ? '✅' : '❌';
        return `${icon} *${v.provider}:* ${v.decision} (${v.confidence}%) — ${v.reasoning}`;
    }).join('\n');

    const consensusIcon = consensus === 'CONFIRMED' ? '🟢' : consensus === 'REJECTED' ? '🔴' : '🟡';

    return {
        consensus,
        votes,
        overallConfidence: avgConfidence,
        summary: `🗳️ *Votación Multi-IA:* ${consensusIcon} ${consensus} (${confirms}/${total})\n📊 Confianza promedio: ${avgConfidence}%\n\n${voteDetails}`
    };
}
