const { ChromaClient } = require('chromadb');
const { DefaultEmbeddingFunction } = require('@chroma-core/default-embed');
const axios = require('axios');
const crypto = require('crypto');

const client = new ChromaClient({ path: "http://localhost:8000" });
const embedder = new DefaultEmbeddingFunction();
let collection = null;

async function initChroma() {
    if (!collection) {
        collection = await client.getOrCreateCollection({
            name: "jarvis_long_term_memory",
            embeddingFunction: embedder
        });
    }
    return collection;
}

const ARCHIVIST_PROMPT = `You are the Archivist, a silent background sub-agent for an AI named Jarvis.
Your sole purpose is to analyze the conversation between the User and Jarvis to extract persistent facts, user preferences, and operational rules.

CRITICAL SECURITY DIRECTIVES:
1. NEVER extract or memorize passwords, API keys, credentials, or sensitive financial data.
2. Only extract information that would be useful for personalizing future interactions.
3. Keep facts concise.

OUTPUT FORMAT:
You MUST output ONLY a valid JSON array of strings containing the extracted facts. Do not output any markdown formatting, backticks, or conversational text.
If no useful facts are found, output an empty array: []

Example Input:
User: "I am building a WhatsApp bot. Also, please use dark mode from now on."
Example Output:
["User is building a WhatsApp bot.", "User prefers dark mode."]`;

async function extractAndStoreMemory(userPrompt, aiResponse) {
    try {
        const col = await initChroma();

        const userContent = `Extract facts from this exchange.\nUser: "${userPrompt}"\nJarvis: "${aiResponse}"`;
        let rawOutput = null;

        // ── Try Hermes via OpenRouter first (User requested for superior self-learning) ──
        if (process.env.OPENROUTER_API_KEY) {
            try {
                const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: 'nousresearch/hermes-3-llama-3.1-70b',
                    messages: [
                        { role: 'system', content: ARCHIVIST_PROMPT },
                        { role: 'user', content: userContent }
                    ]
                }, { headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 60000 });
                rawOutput = response.data.choices[0].message.content.trim();
            } catch (err) {
                console.warn('[Archivist] Hermes/OpenRouter failed, falling back to Ollama:', err.message);
            }
        }

        // ── Try Ollama next (fast, local, free) ─────────────────────────────
        if (rawOutput === null) {
            try {
                const response = await axios.post('http://localhost:11434/api/chat', {
                    model: 'qwen2.5:7b',
                    messages: [
                        { role: 'system', content: ARCHIVIST_PROMPT },
                        { role: 'user', content: userContent }
                    ],
                    stream: false,
                    format: 'json'
                }, { timeout: 60000 });
                rawOutput = response.data.message.content.trim();
            } catch (ollamaErr) {
                const isOffline = ollamaErr.code === 'ECONNREFUSED' || ollamaErr.code === 'ENOTFOUND';
                if (!isOffline) {
                    console.warn('[Archivist] Ollama error:', ollamaErr.message);
                }
            }
        }

        // ── Gemini cloud fallback if Ollama was offline ───────────────────────
        if (rawOutput === null) {
            try {
                const { callGemini } = require('./llm_router');
                const geminiPrompt = `${ARCHIVIST_PROMPT}\n\n${userContent}\n\nRespond with ONLY a valid JSON array of strings.`;
                rawOutput = await callGemini(geminiPrompt, ARCHIVIST_PROMPT, 'gemini-flash-latest');
                if (rawOutput) rawOutput = rawOutput.trim();
            } catch (geminiErr) {
                // Gemini also failed — silently skip, no log spam
                return;
            }
        }

        if (!rawOutput) return;

        let facts = [];
        try {
            // Strip markdown fences if Gemini wrapped the output
            const cleaned = rawOutput.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            facts = JSON.parse(cleaned);
        } catch (e) {
            const match = rawOutput.match(/\[.*\]/s);
            if (match) {
                try { facts = JSON.parse(match[0]); } catch (_) { return; }
            } else {
                return; // Unparseable — skip silently
            }
        }

        if (Array.isArray(facts) && facts.length > 0) {
            const ids = [];
            const documents = [];

            for (const fact of facts) {
                if (fact.toLowerCase().includes("no useful facts") || fact.length < 5) continue;
                documents.push(fact);
                ids.push(`fact_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
            }

            if (documents.length > 0) {
                await col.add({ ids, documents });
                console.log(`[Archivist] Stored ${documents.length} new memories.`);
            }
        }
    } catch (err) {
        // Only log truly unexpected errors (e.g. ChromaDB down)
        if (err.code !== 'ECONNREFUSED') {
            console.error('[Archivist] Error extracting/storing memory:', err.message);
        }
    }
}

async function retrieveMemories(currentPrompt) {
    try {
        const col = await initChroma();
        
        const results = await col.query({
            queryTexts: [currentPrompt],
            nResults: 3
        });

        if (results && results.documents && results.documents[0].length > 0) {
            const memories = results.documents[0];
            return memories.map((m, i) => `${i + 1}. ${m}`).join('\n');
        }
    } catch (err) {
        console.error('[Archivist] Error retrieving memories:', err.message);
    }
    return "";
}

async function forgetMemory(query) {
    try {
        const col = await initChroma();
        
        // Find the closest matching memory to delete
        const results = await col.query({
            queryTexts: [query],
            nResults: 1
        });

        if (results && results.documents && results.documents[0].length > 0) {
            const idToDelete = results.ids[0][0];
            const factDeleted = results.documents[0][0];
            
            await col.delete({
                ids: [idToDelete]
            });
            return `Successfully forgot the following memory: "${factDeleted}"`;
        }
        return "Could not find a matching memory to forget.";
    } catch (err) {
        console.error('[Archivist] Error forgetting memory:', err.message);
        return `Error during unlearn protocol: ${err.message}`;
    }
}

module.exports = {
    extractAndStoreMemory,
    retrieveMemories,
    forgetMemory
};
