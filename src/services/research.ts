/**
 * Deep Research Service
 * 
 * Multi-step research agent: search → read → synthesize
 * Inspired by: awesome-llm-apps/ai_deep_research_agent
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

const geminiClient = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

export interface ResearchReport {
    title: string;
    summary: string;
    sections: { title: string; content: string; sources: string[]; }[];
    conclusion: string;
    driveLink?: string;
}

interface SearchResult { url: string; snippet: string; }

async function searchWeb(query: string, max: number = 8): Promise<SearchResult[]> {
    try {
        const nodeFetch = (await import('node-fetch')).default;
        const res = await nodeFetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 }
        );
        const html = await res.text();
        const results: SearchResult[] = [];
        const regex = /<a class="result__url"[^>]*href="([^"]+)"[^>]*>.*?<\/a>.*?<a class="result__snippet[^>]*>(.*?)<\/a>/gs;
        let match, count = 0;
        while ((match = regex.exec(html)) !== null && count < max) {
            let link = match[1];
            if (link.startsWith('//')) link = 'https:' + link;
            const snippet = match[2].replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim();
            if (snippet.length > 20) { results.push({ url: link, snippet }); count++; }
        }
        return results;
    } catch (e: any) { console.error(`[RESEARCH] Search error:`, e.message); return []; }
}

async function readPage(url: string, maxChars: number = 4000): Promise<string> {
    try {
        const nodeFetch = (await import('node-fetch')).default;
        const res = await nodeFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const html = await res.text();
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        return text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
    } catch (e: any) { console.error(`[RESEARCH] Read error ${url}:`, e.message); return ''; }
}

const RESEARCH_PROMPT = `Eres un analista de investigación. Sintetiza los fragmentos web en un reporte JSON.
Responde SOLO JSON válido sin backticks:
{"title":"...","summary":"resumen 2-3 oraciones","sections":[{"title":"...","content":"...","sourceIndices":[0,1]}],"conclusion":"..."}
Escribe en español. Máximo 3 secciones.`;

export async function deepResearch(query: string): Promise<ResearchReport> {
    console.log(`[RESEARCH] Starting: "${query}"`);
    if (!geminiClient) {
        return { title: `Investigación: ${query}`, summary: 'LLM no disponible.', sections: [], conclusion: 'Error.' };
    }

    // Step 1: Generate search queries
    let searchQueries: string[];
    try {
        const r = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: `Tema: "${query}"\nGenera 3 búsquedas web (inglés/español) cubriendo ángulos técnico, fundamental, y noticias. Una por línea, sin numeración.` }] }],
            config: { maxOutputTokens: 100, temperature: 0.5 }
        });
        const t = r.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        searchQueries = t.split('\n').filter(q => q.trim().length > 5).slice(0, 3);
        if (searchQueries.length === 0) searchQueries = [query, `${query} analysis`, `${query} noticias`];
    } catch { searchQueries = [query, `${query} analysis`, `${query} noticias`]; }

    // Step 2: Search
    const allResults = (await Promise.all(searchQueries.map(q => searchWeb(q, 4)))).flat();
    const unique = allResults.filter((r, i, a) => a.findIndex(x => x.url === r.url) === i);
    console.log(`[RESEARCH] Found ${unique.length} unique results`);
    if (unique.length === 0) {
        return { title: `Investigación: ${query}`, summary: 'Sin resultados.', sections: [], conclusion: 'Sin datos.' };
    }

    // Step 3: Read top pages
    const pages = await Promise.all(unique.slice(0, 5).map(async r => ({
        url: r.url, snippet: r.snippet, content: await readPage(r.url, 3000)
    })));
    const valid = pages.filter(p => p.content.length > 100);

    // Step 4: Synthesize
    let ctx = `TEMA: ${query}\n\nFUENTES:\n\n`;
    valid.forEach((p, i) => { ctx += `[${i}] ${p.url}\n${p.snippet}\n${p.content.substring(0, 2000)}\n\n`; });

    try {
        const synth = await geminiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: ctx }] }],
            config: { systemInstruction: RESEARCH_PROMPT, maxOutputTokens: 1500, temperature: 0.3 }
        });
        const text = synth.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error('Empty response');
        const parsed = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
        return {
            title: parsed.title || `Investigación: ${query}`,
            summary: parsed.summary || '',
            sections: (parsed.sections || []).map((s: any) => ({
                title: s.title, content: s.content,
                sources: (s.sourceIndices || []).filter((i: number) => i < valid.length).map((i: number) => valid[i].url)
            })),
            conclusion: parsed.conclusion || ''
        };
    } catch (e: any) {
        console.error(`[RESEARCH] Synthesis error:`, e.message);
        return {
            title: `Investigación: ${query}`, summary: `${valid.length} fuentes, error en síntesis.`,
            sections: valid.map(p => ({ title: new URL(p.url).hostname, content: p.snippet, sources: [p.url] })),
            conclusion: 'Error en síntesis LLM.'
        };
    }
}

export function formatResearchReport(report: ResearchReport): string {
    let msg = `📚 *${report.title}*\n\n${report.summary}\n\n`;
    for (const s of report.sections) {
        msg += `━━━━━━━━━━━━━━━━\n📌 *${s.title}*\n${s.content}\n`;
        if (s.sources.length > 0) msg += `🔗 ${s.sources.join('\n🔗 ')}\n`;
        msg += '\n';
    }
    msg += `━━━━━━━━━━━━━━━━\n🎯 *Conclusión:* ${report.conclusion}`;
    return msg.length > 4000 ? msg.substring(0, 3950) + '\n\n... [TRUNCADO]' : msg;
}
