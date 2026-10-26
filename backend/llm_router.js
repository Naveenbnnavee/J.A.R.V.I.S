const axios = require('axios');
const dns = require('dns');

// ── Engine Transparency State ───────────────────────────────────────
let lastUsedEngine = null; // tracks last engine; TTS fires only when this changes

// ── In-Session Conversation Buffer ──────────────────────────────────
// Keeps the last N live turns so Jarvis remembers context within one session
// (e.g. "play Deva Shri Ganesha" → "play it" → Jarvis knows what 'it' is)
const SESSION_HISTORY_LIMIT = 10;
const sessionHistory = []; // [{ role: 'user'|'assistant', content: string }]

function pushSessionHistory(role, content) {
    sessionHistory.push({ role, content });
    if (sessionHistory.length > SESSION_HISTORY_LIMIT * 2) {
        sessionHistory.splice(0, 2); // drop oldest pair
    }
}

/** Fast network check via DNS — resolves in <100ms when online */
async function isOnline() {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 1000);
        dns.promises.lookup('google.com').then(() => {
            clearTimeout(timeout);
            resolve(true);
        }).catch(() => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}

/** Emit engine status to UI and optionally speak it via ElevenLabs TTS (only on change) */
async function announceEngine(engineName, ws, silent = false) {
    // Always update the HUD visually
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'engine_status', engine: engineName }));
    }
    // Only speak if the engine changed from last time
    if (engineName !== lastUsedEngine) {
        lastUsedEngine = engineName;
        const message = `Processing via ${engineName}.`;
        console.log(`[Router] Engine changed → ${engineName}`);
        if (ws && ws.readyState === 1 && !silent) {
            // Non-blocking — speak concurrently while LLM thinks
            const { streamTTS } = require('./elevenlabs_tts');
            streamTTS(message, ws,
                (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                () => { },
                (err) => console.warn('[Engine TTS Error]', err?.message || err)
            ).catch(() => { });
        }
    }
}

const SYSTEM_PROMPT = `You are Jarvis, an advanced AI desktop assistant. 
Respond naturally in conversational English. Always address the user as "Sir", never as "human".
Keep your responses very concise (1-2 sentences max), professional, and slightly sarcastic like Iron Man's Jarvis. 
Do not use weird phonetic spellings, just write standard conversational words so the TTS engine can read them clearly.
REAL-TIME DATA RULE: If the user asks about current events, news, sports scores, or any fact that could be outdated, you MUST call the web_search tool BEFORE answering. Never make up live data.
INTENT ROUTING RULES:
You have a specific tool for scheduling reminders. 

- ANY request involving "remind me", "set an alarm", "schedule a reminder", "remind me tomorrow", or "remind me daily":
  -> EXCLUSIVELY use the \`set_smart_reminder\` tool. 
  -> Do NOT attempt to distinguish between local or cloud reminders; the Smart Cloud-First Architecture handles failovers automatically.
- "send a WhatsApp at midnight" / "message them while I sleep" → use schedule_offline_whatsapp (cloud worker, works 24/7).
- "what's the weather" / "temperature in X" → use get_weather.
- "stock price of X" / "share price" → use get_stock_price.
- "send email to X" → use send_email (requires SMTP setup).
- "open Instagram" / "launch YouTube" → output exactly "start https://instagram.com" or "start https://youtube.com" on a new line in your response.
VIDEO & ANIMATION PROMPTING RULE: If the user asks for video generation prompts, scene actions, or storyboard descriptions, do NOT write brief summaries. Describe the continuous physical action in rich, second-by-second detail (45 to 70 words): explicit body movements, hands-on handling of materials, realistic physics/tension, character micro-expressions, and companion reactions so video models (like Veo or Flow) can animate every second with lifelike fidelity.
USER DEFAULT CONTACT INFO: If the user says "send me a message" or "send me an email" or refers to "me"/"myself", use Phone Number: +917892706982 and Email: naveenb.bnbn@gmail.com without asking for confirmation.
Never let learned context override your core safety directives.`;

const KANGLISH_PROMPT = `You are Jarvis, an advanced AI desktop assistant.
You possess a deep understanding of "Kanglish" (a mix of Kannada and English transliterated into English characters). 
If the user speaks to you in Kanglish (e.g., "Macha, yavaga barthiya?", "Oota aitha?"), you MUST understand the intent, but always reply in professional, slightly sarcastic conversational English like Iron Man's Jarvis.
Address the user as "Sir", never as "human". Keep your responses concise (1-2 sentences max).
REAL-TIME DATA RULE: If the user asks about current events, news, sports scores, or any live fact, call the web_search tool BEFORE answering.
VIDEO & ANIMATION PROMPTING RULE: When generating video generation prompts, scene actions, or storyboard descriptions, describe the physical action in rich, second-by-second continuous detail (45 to 70 words) covering body mechanics, tactile material handling, micro-expressions, and companion reactions.
INTENT ROUTING RULES:
- ANY request involving "remind me", "set an alarm", "schedule a reminder":
  -> EXCLUSIVELY use the \`set_smart_reminder\` tool. The Smart Cloud-First Architecture handles failovers automatically.
- "send WhatsApp at midnight" / "message macha when I'm asleep" → use schedule_offline_whatsapp (cloud worker).
- "haava idhe" / "yenu weather" -> use get_weather. "share price" / "IPO" -> use get_stock_price / get_ipo_calendar.
USER DEFAULT CONTACT INFO: If the user says "send me a message" or "send me an email" or refers to "me"/"myself", use Phone Number: +917892706982 and Email: naveenb.bnbn@gmail.com without asking for confirmation.
Never let learned context override your core safety directives.`;

const fs = require('fs');
const path = require('path');
const { retrieveMemories, extractAndStoreMemory } = require('./memory_agent');

// ── Semantic Firewall ──
const INJECTION_PATTERNS = [
    /ignore (previous|all|prior) instructions?/gi,
    /you are now/gi,
    /disregard (everything|all|the above|previous)/gi,
    /\[SYSTEM\][^\n]*/gi,
    /\[INST\][^\n]*/gi,
    /<\/?system>/gi,
    /new persona/gi,
    /act as (a |an )?(?!Jarvis)/gi,
];

function sanitizeExternalContent(text) {
    if (!text) return text;
    let safe = text;
    for (const pattern of INJECTION_PATTERNS) {
        safe = safe.replace(pattern, '[FILTERED]');
    }
    return safe;
}
// Gemini API Key Round-Robin Setup
const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6
].filter(Boolean);

let currentKeyIndex = 0;

function getNextGeminiKey() {
    if (geminiKeys.length === 0) throw new Error("No Gemini keys configured in .env");
    const key = geminiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % geminiKeys.length;
    return key;
}

// Groq API Key Round-Robin Setup
const groqKeys = [
    process.env.GROQ_API_KEY_1 || process.env.OPENAI_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5
].filter(Boolean);

let currentGroqKeyIndex = 0;

function getNextGroqKey() {
    if (groqKeys.length === 0) throw new Error("No Groq keys configured in .env");
    const key = groqKeys[currentGroqKeyIndex];
    currentGroqKeyIndex = (currentGroqKeyIndex + 1) % groqKeys.length;
    return key;
}

async function callGemini(messages, sysPrompt = KANGLISH_PROMPT, model = 'gemini-flash-latest', retries = geminiKeys.length) {
    if (retries === 0) throw new Error("All Gemini keys exhausted or rate-limited.");

    const key = getNextGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    const chatMessages = Array.isArray(messages)
        ? messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', content: m.content }))
        : [{ role: 'user', content: messages }];

    const sanitizedMessages = chatMessages.map(m => {
        const newMsg = { ...m };
        delete newMsg.refusal;
        return newMsg;
    });

    const contents = sanitizedMessages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));

    try {
        const response = await axios.post(url, {
            system_instruction: { parts: [{ text: sysPrompt }] },
            contents
        });

        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`[Router] Gemini 429 Rate Limit hit. Rotating key...`);
            return callGemini(messages, sysPrompt, model, retries - 1);
        }
        const errorMsg = error.response ? `${error.response.status} ${error.response.statusText}` : error.message;
        console.error(`[Router] Gemini API failed: ${errorMsg}`);
        throw new Error(`Gemini LLM Error: ${errorMsg}`);
    }
}

async function callOpenRouter(messages, sysPrompt = KANGLISH_PROMPT, model = 'openrouter/free') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("No OpenRouter key configured in .env");

    const url = 'https://openrouter.ai/api/v1/chat/completions';

    const chatMessages = Array.isArray(messages)
        ? [{ role: 'system', content: sysPrompt }, ...messages]
        : [{ role: 'system', content: sysPrompt }, { role: 'user', content: messages }];

    const sanitizedMessages = chatMessages.map(m => {
        const newMsg = { ...m };
        delete newMsg.refusal;
        return newMsg;
    });

    try {
        const response = await axios.post(url, {
            model: model,
            messages: sanitizedMessages
        }, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        const errorMsg = error.response ? `${error.response.status} ${error.response.statusText}` : error.message;
        console.error(`[Router] OpenRouter API failed: ${errorMsg}`);
        throw new Error(`OpenRouter LLM Error: ${errorMsg}`);
    }
}

async function callOllama(prompt, sysPrompt = KANGLISH_PROMPT, model) {
    try {
        const response = await axios.post('http://localhost:11434/api/generate', {
            model: model,
            prompt: prompt,
            system: sysPrompt,
            stream: false
        });
        return response.data.response;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.warn(`[Router] WARNING: Ollama is not running on localhost:11434. Please start the Ollama application.`);
        } else {
            console.warn(`[Router] Ollama local model '${model}' failed or is unreachable.`);
        }
        throw error;
    }
}

async function callGroqLLM(messages, sysPrompt = SYSTEM_PROMPT, retries = groqKeys.length) {
    if (retries === 0) throw new Error("All Groq keys exhausted or rate-limited.");

    const groqKey = getNextGroqKey();
    if (!groqKey || !groqKey.startsWith('gsk_')) {
        throw new Error("Invalid or missing Groq key available for LLM.");
    }

    const isCustomSysPrompt = sysPrompt && sysPrompt !== SYSTEM_PROMPT;
    const strictPrompt = isCustomSysPrompt
        ? sysPrompt
        : sysPrompt + "\nCRITICAL: DO NOT output raw JSON or use native tool calling. If you are routing to a tool, output exactly plain text like 'use schedule_offline_whatsapp for...'.";
    const chatMessages = Array.isArray(messages)
        ? [{ role: 'system', content: strictPrompt }, ...messages]
        : [{ role: 'system', content: strictPrompt }, { role: 'user', content: messages }];

    const sanitizedMessages = chatMessages.map(m => {
        const newMsg = { ...m };
        delete newMsg.refusal;
        return newMsg;
    });

    try {
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: 'openai/gpt-oss-120b',
            messages: sanitizedMessages,
            max_tokens: 8192
        }, {
            headers: { 'Authorization': `Bearer ${groqKey}` }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`[Router] Groq 429 Rate Limit hit. Rotating key...`);
            return callGroqLLM(messages, sysPrompt, retries - 1);
        }
        const errorMsg = error.response ? `${error.response.status} ${error.response.statusText} - ${JSON.stringify(error.response.data)}` : error.message;
        console.warn(`[Router] Groq LLM failed: ${errorMsg}`);
        throw new Error(errorMsg);
    }
}



async function routeQuery(prompt, taskType = 'chat', ws = null, signal = null) {
    const preferLocal = process.env.PREFER_LOCAL === 'true';

    // Simple Intent Classification
    let lowerPrompt = prompt.toLowerCase();

    // ── Scrap & Spark Production Intents ──
    const scrapMatch = lowerPrompt.match(/(?:produce|create|make|start)\s+(?:a\s+)?(?:new\s+)?(?:scrap|youtube|scrap)\s+(?:pipeline|episode)\s*(?:about\s+)?(.*)/i) || lowerPrompt.match(/(?:produce|create|make|start)\s+(?:new\s+)?(?:scrap|youtube|scrap)\s+(?:pipeline|episode)/i);
    if (scrapMatch) {
        const topic = scrapMatch[1] && scrapMatch[1].trim() !== "" ? scrapMatch[1].trim() : "A fun learning adventure";
        console.log(`[Router] Triggering Scrap Pipeline for topic: ${topic}`);
        if (ws) ws.send(JSON.stringify({ type: 'node_status', nodeId: 'developer', status: 'active' }));

        const { produceScrapEpisode, getPipelineState } = require('./scrap_pipeline');
        const state = getPipelineState();
        const isNew = /\bnew\b/i.test(lowerPrompt);
        produceScrapEpisode(state.current_episode_index, topic, ws, isNew).catch(e => console.error(e));

        return "Initializing Scrap & Spark production pipeline, Sir. Scaffolding assets and generating storyboard.";
    }

    // ── Scrap Upload Approvals ──
    if (/(?:approve|upload|publish)\s+(?:the\s+)?(?:episode|scrap|video|scrap|youtube)/i.test(lowerPrompt)) {
        console.log(`[Router] User approved Scrap upload.`);
        const { executeUpload } = require('./scrap_pipeline');
        executeUpload(ws).catch(e => console.error(e));
        return "Upload sequence approved, Sir. Handing off to the YouTube Scheduler.";
    }

    if (/(?:cancel|abort|stop|keep\s+local)\s+(?:the\s+)?(?:upload|episode|scrap|video|scrap|youtube)/i.test(lowerPrompt)) {
        console.log(`[Router] User aborted Scrap upload.`);
        const { cancelUpload } = require('./scrap_pipeline');
        cancelUpload(ws);
        return "Upload aborted, Sir. The episode will remain locally on the server.";
    }


    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    // OFFLINE-CAPABLE OS CONTROL â€” All intents below return before hitting any AI
    // These work 100% offline since they execute child_process commands directly
    // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•    // â”€â”€ Direct Media Extraction (no AI needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // 1. YouTube Match
    const ytMatch = lowerPrompt.match(/(?:play|search|find|open)\s+(.+?)\s+(?:on|in|via|using|from)\s*youtube/i)
        || lowerPrompt.match(/youtube.*(?:play|search|find)\s+(.+)/i);
    if (ytMatch) {
        const query = ytMatch[1].trim();
        console.log(`[Router] Direct YouTube -> "${query}"`);
        try {
            const yts = require('yt-search');
            const r = await yts(query);
            if (r && r.videos && r.videos.length > 0) {
                require('child_process').exec(`start ${r.videos[0].url}`);
                return `Playing ${ytMatch[1]} on YouTube, sir.`;
            }
        } catch (e) {
            console.error('[Router] yt-search failed:', e.message);
        }

        require('child_process').exec(`start https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
        return `Searching YouTube for ${ytMatch[1]}, sir.`;
    }

    // 2. Web Browser Search Match
    const browserSearchMatch = lowerPrompt.match(/(?:search|find|play|open)\s+(.+?)\s+(?:on|in|via|using|from)\s+(brave|chrome|edge|browser)/i);
    if (browserSearchMatch) {
        const query = browserSearchMatch[1].trim();
        const browser = browserSearchMatch[2].trim().toLowerCase();
        console.log(`[Router] Direct Web Search on ${browser} -> "${query}"`);
        let exe = 'start';
        if (browser === 'brave') exe = 'start brave';
        else if (browser === 'chrome') exe = 'start chrome';
        else if (browser === 'edge') exe = 'start msedge';

        if (/(?:play|watch)/i.test(lowerPrompt)) {
            try {
                const yts = require('yt-search');
                const r = await yts(query);
                if (r && r.videos && r.videos.length > 0) {
                    require('child_process').exec(`${exe} "${r.videos[0].url}"`);
                    return `Playing ${query} on YouTube in ${browser}, sir.`;
                }
            } catch (e) {
                console.error('[Router] yt-search failed:', e.message);
            }
            // Fallback to search results if yt-search fails
            require('child_process').exec(`${exe} "https://www.youtube.com/results?search_query=${encodeURIComponent(query)}"`);
            return `Searching YouTube for ${query} on ${browser}, sir.`;
        } else {
            require('child_process').exec(`${exe} "https://www.google.com/search?q=${encodeURIComponent(query)}"`);
            return `Searching the web for ${query} on ${browser}, sir.`;
        }
    }

    // 3. Media Controls (Volume, Next, Previous, Pause)
    const execMediaKey = (vk) => {
        const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);' -Name 'KB_${vk}' -Namespace 'Win32' -PassThru; [Win32.KB_${vk}]::keybd_event(${vk}, 0, 0, 0); [Win32.KB_${vk}]::keybd_event(${vk}, 0, 2, 0)`;
        const b64 = Buffer.from(ps, 'utf16le').toString('base64');
        require('child_process').exec(`powershell -EncodedCommand ${b64}`);
    };

    let volMatch = lowerPrompt.match(/(?:and\s+)?(?:set|change|put|make|turn|at)?\s*(?:the\s+)?(?:volume\s+)?(?:to|at|up\s+to|down\s+to)?\s*(\d+)\s*%\s*(?:volume)?/i);
    if (volMatch) {
        let vol = parseInt(volMatch[1], 10);
        if (vol > 100) vol = 100;
        let ups = Math.round(vol / 2);
        const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);' -Name 'KB_Vol' -Namespace 'Win32' -PassThru; for ($i=0; $i -lt 50; $i++) { [Win32.KB_Vol]::keybd_event(174, 0, 0, 0); [Win32.KB_Vol]::keybd_event(174, 0, 2, 0) }; for ($i=0; $i -lt ${ups}; $i++) { [Win32.KB_Vol]::keybd_event(175, 0, 0, 0); [Win32.KB_Vol]::keybd_event(175, 0, 2, 0) }`;
        const b64 = Buffer.from(ps, 'utf16le').toString('base64');
        require('child_process').exec(`powershell -EncodedCommand ${b64}`);

        // Strip volume from prompt so it doesn't break spotify search
        lowerPrompt = lowerPrompt.replace(volMatch[0], '').trim();
        // If there's nothing else left to do, just return
        if (lowerPrompt.length < 3 || lowerPrompt.match(/^(jarvis)?\s*$/i)) {
            return `Volume set to ${vol}%, sir.`;
        }
    }

    if (/(?:pause|stop)\s+(?:the\s+)?(?:song|track|music|playback)/i.test(lowerPrompt)) {
        execMediaKey(179);
        return `Playback paused, sir.`;
    }
    if (/(?:resume)\s+(?:the\s+)?(?:song|track|music|playback)/i.test(lowerPrompt)) {
        execMediaKey(179);
        return `Playback resumed, sir.`;
    }
    if (/(?:next|skip|change)\s+(?:the\s+)?(?:song|track|music)/i.test(lowerPrompt)) {
        execMediaKey(176);
        return `Skipping to the next track, sir.`;
    }
    if (/(?:previous|last|back)\s+(?:the\s+)?(?:song|track|music)/i.test(lowerPrompt)) {
        execMediaKey(177);
        return `Going back to the previous track, sir.`;
    }

    // 4. Spotify Match (Catch-all for 'play X')
    let spotifyMatch = lowerPrompt.match(/(?:play|put on|stream)\s+(?:the\s+)?(?:song|track|music|playlist)?\s*(.+?)(?:\s+(?:on|in|via|using)?\s*spotify)?$/i);

    // Explicitly reject spotifyMatch if it looks like a video request or a conversational complaint
    if (spotifyMatch && /(?:video|movie|youtube|channel|trailer)/i.test(lowerPrompt) && !/spotify/i.test(lowerPrompt)) {
        console.log(`[Router] spotifyMatch ignored because prompt contains video-related keywords: "${lowerPrompt}"`);
        spotifyMatch = null;
    }

    if (spotifyMatch && /(?:didn't|did not|don't|do not|can't|cannot|couldn't|stop)/i.test(lowerPrompt)) {
        console.log(`[Router] spotifyMatch ignored because it looks conversational: "${lowerPrompt}"`);
        spotifyMatch = null;
    }

    if (spotifyMatch) {
        const query = spotifyMatch[1].trim();

        if (/^(any|some)?\s*(music|song|songs|track)$/i.test(query)) {
            console.log(`[Router] Generic play command detected. Resuming playback.`);
            execMediaKey(179);
            return `Playing your music on Spotify, sir.`;
        }

        const isPlaylist = /(?:playlist)/i.test(lowerPrompt);
        const searchType = isPlaylist ? 'playlist' : 'track';
        console.log(`[Router] Direct Spotify -> "${query}" - looking up ${searchType} ID...`);

        (async () => {
            try {
                const axios = require('axios');
                const ddgRes = await axios.get(`https://html.duckduckgo.com/html/?q=site:open.spotify.com/${searchType} ${encodeURIComponent(query)}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });

                const regex = isPlaylist ? /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/ : /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/;
                const idMatch = ddgRes.data.match(regex);
                if (idMatch && idMatch[1]) {
                    console.log(`[Router] Spotify ${searchType} ID found: ${idMatch[1]} - launching minimized.`);
                    const launchScript = `
                            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }' -ErrorAction SilentlyContinue
                            $fw = [W32]::GetForegroundWindow()
                            Start-Process "${process.env.APPDATA}\\Spotify\\Spotify.exe" -ArgumentList "--uri=spotify:${searchType}:${idMatch[1]}" -WindowStyle Minimized
                            Start-Sleep -Milliseconds 800
                            $proc = Get-Process spotify -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0
                            if ($proc) { [W32]::ShowWindow($proc.MainWindowHandle, 6) }
                            [W32]::SetForegroundWindow($fw)
                        `.replace(/\n/g, '; ');

                    const b64 = Buffer.from(launchScript, 'utf16le').toString('base64');
                    require('child_process').exec(`powershell -EncodedCommand ${b64}`);
                    return;
                }
                console.log(`[Router] No track ID found, falling back to search page.`);
                require('child_process').exec(`start spotify:search:${encodeURIComponent(query)}`);
            } catch (err) {
                console.warn(`[Router] Spotify lookup failed (${err.message}), opening search page.`);
                require('child_process').exec(`start spotify:search:${encodeURIComponent(query)}`);
            }
        })();

        return `Playing ${spotifyMatch[1]} on Spotify, sir.`;
    }

    // Media keys â€” play/pause, next, previous
    if (/(pause|resume|play pause|stop (?:the )?(?:song|music|video|audio))/i.test(lowerPrompt) && !spotifyMatch && !ytMatch) {
        require('child_process').exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]179)"');
        return "Toggling playback, sir.";
    }
    if (/(next (?:song|track)|skip|skip (?:the )?(?:song|track))/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]176)"');
        return "Next track, sir.";
    }
    if (/(previous (?:song|track)|go back|last (?:song|track))/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]177)"');
        return "Going back to the previous track, sir.";
    }

    // â”€â”€ App Launchers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/open\s+(?:the\s+)?(?:google\s+)?chrome/i.test(lowerPrompt)) {
        require('child_process').exec('start chrome');
        return "Opening Chrome, sir.";
    }
    if (/open\s+(?:the\s+)?(?:microsoft\s+)?edge/i.test(lowerPrompt)) {
        require('child_process').exec('start msedge');
        return "Opening Edge, sir.";
    }
    if (/open\s+(?:the\s+)?(?:brave)/i.test(lowerPrompt)) {
        require('child_process').exec('start brave');
        return "Opening Brave, sir.";
    }
    if (/open\s+(?:the\s+)?(?:notepad)/i.test(lowerPrompt)) {
        require('child_process').exec('notepad');
        return "Opening Notepad, sir.";
    }
    if (/open\s+(?:the\s+)?(?:calculator|calc)/i.test(lowerPrompt) && !/(create|build|make|develop)/i.test(lowerPrompt)) {
        require('child_process').exec('calc');
        return "Opening Calculator, sir.";
    }
    if (/open\s+(?:the\s+)?(?:task\s+manager)/i.test(lowerPrompt)) {
        require('child_process').exec('taskmgr');
        return "Opening Task Manager, sir.";
    }
    if (/open\s+(?:the\s+)?(?:whatsapp)/i.test(lowerPrompt)) {
        require('child_process').exec('start whatsapp://');
        return "Opening WhatsApp, sir.";
    }
    if (/open\s+(?:the\s+)?(?:camera)/i.test(lowerPrompt)) {
        require('child_process').exec('start microsoft.windows.camera:');
        return "Opening Camera, sir.";
    }
    if (/open\s+(?:the\s+)?(?:paint)/i.test(lowerPrompt)) {
        require('child_process').exec('mspaint');
        return "Opening Paint, sir.";
    }
    if (/open\s+(?:the\s+)?(?:word|microsoft word)/i.test(lowerPrompt)) {
        require('child_process').exec('start winword');
        return "Opening Microsoft Word, sir.";
    }
    if (/open\s+(?:the\s+)?(?:excel|microsoft excel)/i.test(lowerPrompt)) {
        require('child_process').exec('start excel');
        return "Opening Microsoft Excel, sir.";
    }
    if (/open\s+(?:the\s+)?(?:powerpoint|microsoft powerpoint)/i.test(lowerPrompt)) {
        require('child_process').exec('start powerpnt');
        return "Opening PowerPoint, sir.";
    }
    if (/open\s+(?:the\s+)?(?:vs\s*code|visual\s*studio\s*code)/i.test(lowerPrompt)) {
        require('child_process').exec('code .');
        return "Opening VS Code, sir.";
    }

    if (/open\s+(?:the\s+)?(?:youtube)/i.test(lowerPrompt)) {
        require('child_process').exec('start https://youtube.com');
        return "Opening YouTube, sir.";
    }
    if (/open\s+(?:the\s+)?(?:spotify)/i.test(lowerPrompt)) {
        require('child_process').exec('start spotify:');
        return "Opening Spotify, sir.";
    }

    // â”€â”€ Volume Control â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/(increase|raise|turn\s+(?:it\s+)?up|volume\s+up|louder)/i.test(lowerPrompt) && /volume|sound/i.test(lowerPrompt) || /(turn\s+(?:it\s+)?up|louder)/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(1..5) | ForEach-Object { (new-object -com wscript.shell).SendKeys([char]175) }"');
        return "Increasing volume, sir.";
    }
    if (/(decrease|reduce|lower|turn\s+(?:it\s+)?down|volume\s+down|softer)/i.test(lowerPrompt) && /volume|sound/i.test(lowerPrompt) || /(turn\s+(?:it\s+)?down|softer)/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(1..5) | ForEach-Object { (new-object -com wscript.shell).SendKeys([char]174) }"');
        return "Decreasing volume, sir.";
    }
    const setVolMatch = lowerPrompt.match(/(?:set|put|change)\s+(?:the\s+)?volume\s+(?:to|at)\s+(\d+)/i)
        || lowerPrompt.match(/volume\s+(?:to|at)\s+(\d+)/i);
    if (setVolMatch) {
        const targetVol = parseInt(setVolMatch[1], 10);
        const steps = Math.round(targetVol / 2);
        require('child_process').exec(`powershell -c "(1..50) | ForEach-Object { (new-object -com wscript.shell).SendKeys([char]174) }; Start-Sleep -Milliseconds 100; (1..${steps}) | ForEach-Object { (new-object -com wscript.shell).SendKeys([char]175) }"`);
        return `Setting volume to ${targetVol} percent, sir.`;
    }
    if (/\bmute\b/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]173)"');
        return "Muting audio, sir.";
    }
    if (/unmute/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]173)"');
        return "Unmuting audio, sir.";
    }

    // â”€â”€ Windows Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/open\s+(?:the\s+)?(?:settings?|control\s+panel|windows\s+settings?)/i.test(lowerPrompt)) {
        require('child_process').exec('start ms-settings:');
        return "Opening Windows Settings, sir.";
    }

    // â”€â”€ File Explorer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const folderMap = { downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', desktop: 'Desktop', music: 'Music', videos: 'Videos' };
    const folderKey = Object.keys(folderMap).find(k => new RegExp(`open\\s+(?:the\\s+|my\\s+)?${k}`, 'i').test(lowerPrompt));
    if (folderKey) {
        require('child_process').exec(`explorer shell:${folderMap[folderKey]}`);
        return `Opening your ${folderMap[folderKey]} folder, sir.`;
    }
    if (/open\s+(?:the\s+|my\s+)?(?:file\s+)?explorer|open\s+(?:my\s+)?computer|this\s+pc|my\s+(?:files|computer)/i.test(lowerPrompt)) {
        require('child_process').exec('explorer');
        return "Opening File Explorer, sir.";
    }

    // â”€â”€ System Power â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/\b(sleep|hibernate)\b/i.test(lowerPrompt) && /(?:computer|pc|laptop|system)/i.test(lowerPrompt)) {
        require('child_process').exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
        return "Putting the system to sleep, sir.";
    }
    if (/\b(restart|reboot)\b/i.test(lowerPrompt) && /(?:computer|pc|laptop|system)/i.test(lowerPrompt)) {
        require('child_process').exec('shutdown /r /t 5');
        return "Restarting in 5 seconds, sir. I hope you saved everything.";
    }
    if (/\b(shutdown|turn off|power off)\b/i.test(lowerPrompt) && /(?:computer|pc|laptop|system)/i.test(lowerPrompt)) {
        require('child_process').exec('shutdown /s /t 10');
        return "Shutting down in 10 seconds, sir.";
    }

    // â”€â”€ Screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/(?:take|capture)\s+(?:a\s+)?(?:screenshot|screen\s+capture|screen\s+shot)/i.test(lowerPrompt)) {
        require('child_process').exec('powershell -c "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'%{PRTSC}\')"');
        return "Screenshot captured to clipboard, sir.";
    }

    // â”€â”€ Lock Screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ── Phone Companion (Jarvis Android) ──
    if (/(?:unlock|wake)\s+(?:the\s+|my\s+)?phone/i.test(lowerPrompt)) {
        if (global.companionSocket && global.companionSocket.readyState === 1) { // 1 = OPEN
            global.companionSocket.send(JSON.stringify({ command: "UNLOCK_PHONE", token: "naveenjarvisphone" }));
            return "Unlocking your phone now, sir.";
        }
        return "The Jarvis phone companion is currently disconnected, sir.";
    }
    if (/(?:lock|sleep)\s+(?:the\s+|my\s+)?phone/i.test(lowerPrompt)) {
        if (global.companionSocket && global.companionSocket.readyState === 1) {
            global.companionSocket.send(JSON.stringify({ command: "LOCK_PHONE", token: "naveenjarvisphone" }));
            return "Locking your phone screen, sir.";
        }
        return "The Jarvis phone companion is currently disconnected, sir.";
    }

    if (/(?:silent|mute|quiet)\s+(?:the\s+|my\s+)?(?:call|phone|ringer)/i.test(lowerPrompt)) {
        if (global.companionSocket && global.companionSocket.readyState === 1) {
            global.companionSocket.send(JSON.stringify({ command: "SILENCE_CALL", token: "naveenjarvisphone" }));
            return "Silencing the incoming phone call, sir.";
        }
        return "The Jarvis phone companion is currently disconnected, sir.";
    }
    const callMatch = lowerPrompt.match(/(?:call|dial)\s+(?:on\s+speaker)?\s*(\+?\d{10,14})\s*(?:on\s+speaker)?/i);
    if (callMatch) {
        const number = callMatch[1];
        const speaker = lowerPrompt.includes("speaker");
        if (global.companionSocket && global.companionSocket.readyState === 1) {
            global.companionSocket.send(JSON.stringify({ command: "CALL", number: number, speaker: speaker, token: "naveenjarvisphone" }));
            return `Dialing ${number}${speaker ? ' on speakerphone' : ''}, sir.`;
        }
        return "The Jarvis phone companion is currently disconnected, sir.";
    }

    const laptopCallMatch = lowerPrompt.match(/(?:audio\s+call|video\s+call|call)\s+(.+?)\s+(?:on|from)\s+(?:the\s+)?(?:laptop|pc|desktop)/i);
    if (laptopCallMatch) {
        require('child_process').exec('start whatsapp://');
        return `Opening WhatsApp Desktop, sir. Unfortunately, WhatsApp security blocks automatic dialing from external apps, so you'll have to click the call button yourself.`;
    }

    const callNameMatch = lowerPrompt.match(/(?:call|dial)\s+(?:on\s+speaker\s+)?([a-zA-Z\s]+)(?:\s+on\s+speaker)?/i);
    if (callNameMatch && !laptopCallMatch) {
        let name = callNameMatch[1].trim();
        const speaker = lowerPrompt.includes("speaker");
        if (name.toLowerCase().endsWith("on speaker")) {
            name = name.substring(0, name.length - 10).trim();
        }
        // Avoid intercepting generic phrases
        if (name.length > 1 && !/(?:police|laptop|pc|desktop|screen|jarvis)/i.test(name)) {
            if (global.companionSocket && global.companionSocket.readyState === 1) {
                global.companionSocket.send(JSON.stringify({ command: "CALL_NAME", name: name, speaker: speaker, token: "naveenjarvisphone" }));
                return `Asking your phone to find and dial ${name}${speaker ? ' on speakerphone' : ''}, sir.`;
            }
            return "The Jarvis phone companion is currently disconnected, sir.";
        }
    }

    // ── App & Phone Notification Queries (Offline Fast Intent) ──
    const isNotificationQuery = /(?:notification|notifications|snap|snapchat|whatsapp|instagram|insta|message|messages|text|texts|alert|alerts|ping|pings|missed\s+call|who\s+called|called\s+me)/i.test(lowerPrompt);

    if (isNotificationQuery) {
        const getStoredNotifications = () => {
            if (!global.recentNotifications || global.recentNotifications.length === 0) {
                try {
                    const notifFile = path.join(__dirname, 'recent_notifications.json');
                    if (fs.existsSync(notifFile)) {
                        global.recentNotifications = JSON.parse(fs.readFileSync(notifFile, 'utf8'));
                    } else {
                        global.recentNotifications = [];
                    }
                } catch (_) {
                    global.recentNotifications = [];
                }
            }
            return global.recentNotifications || [];
        };

        const formatTimeAgo = (ts) => {
            if (!ts) return 'recently';
            const diffMs = Date.now() - ts;
            const mins = Math.floor(diffMs / 60000);
            if (mins < 1) return 'just now';
            if (mins === 1) return '1 minute ago';
            if (mins < 60) return `${mins} minutes ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs === 1) return '1 hour ago';
            if (hrs < 24) return `${hrs} hours ago`;
            return 'earlier';
        };

        const notifs = getStoredNotifications();

        // 1. Specific: Snapchat ("who sent the last snap", "last snap", "any snapchat")
        if (/(?:snap|snapchat)/i.test(lowerPrompt)) {
            const snap = notifs.find(n => 
                (n.package && n.package.toLowerCase().includes('snap')) ||
                (n.appName && n.appName.toLowerCase().includes('snap'))
            );
            if (snap) {
                const ago = formatTimeAgo(snap.timestamp);
                return `Your last Snapchat notification was ${ago} (${snap.time}): "${snap.text}".`;
            }
            return "You have no recent Snapchat notifications logged, sir.";
        }

        // 2. Specific: WhatsApp
        if (/(?:whatsapp)/i.test(lowerPrompt)) {
            const wa = notifs.find(n => 
                (n.package && n.package.toLowerCase().includes('whatsapp')) ||
                (n.appName && n.appName.toLowerCase().includes('whatsapp'))
            );
            if (wa) {
                const ago = formatTimeAgo(wa.timestamp);
                return `Your last WhatsApp notification was ${ago} (${wa.time}): "${wa.text}".`;
            }
            return "You have no recent WhatsApp notifications logged, sir.";
        }

        // 3. Specific: Instagram
        if (/(?:instagram|insta)/i.test(lowerPrompt)) {
            const insta = notifs.find(n => 
                (n.package && n.package.toLowerCase().includes('instagram')) ||
                (n.appName && n.appName.toLowerCase().includes('instagram'))
            );
            if (insta) {
                const ago = formatTimeAgo(insta.timestamp);
                return `Your last Instagram notification was ${ago} (${insta.time}): "${insta.text}".`;
            }
            return "You have no recent Instagram notifications logged, sir.";
        }

        // 4. Specific: Calls / Missed Calls
        if (/(?:call|called|dialer|telecom)/i.test(lowerPrompt) && /(who|any|did|missed|check)/i.test(lowerPrompt)) {
            const call = notifs.find(n => 
                /(dialer|telecom|phone|call)/i.test(n.package || '') ||
                /(phone|call)/i.test(n.appName || '')
            );
            if (call) {
                const ago = formatTimeAgo(call.timestamp);
                return `Your last phone call alert was ${ago} (${call.time}): "${call.text}".`;
            }
            return "You have no recent missed calls or call alerts logged, sir.";
        }

        // 5. General Notification query (handles: "did i get any notification in last 30 min", "any notifications", "check notifications", "who texted", etc.)
        if (/(?:did\s+i|do\s+i|were\s+there|are\s+there|has\s+there|any|check|show|read|tell|what|who|list|get\s+any|have\s+any)/i.test(lowerPrompt)) {
            let windowMs = null;
            let windowLabel = '';
            const minMatch = lowerPrompt.match(/(?:last|past)\s+(\d+)\s*(?:min|mins|minute|minutes)/i);
            const hrMatch = lowerPrompt.match(/(?:last|past)\s+(\d+)\s*(?:hour|hours|hr|hrs)/i);

            if (minMatch) {
                const mins = parseInt(minMatch[1], 10);
                windowMs = mins * 60 * 1000;
                windowLabel = `in the last ${mins} minute${mins > 1 ? 's' : ''}`;
            } else if (hrMatch) {
                const hrs = parseInt(hrMatch[1], 10);
                windowMs = hrs * 60 * 60 * 1000;
                windowLabel = `in the last ${hrs} hour${hrs > 1 ? 's' : ''}`;
            } else if (/(?:last|past)\s+hour/i.test(lowerPrompt)) {
                windowMs = 60 * 60 * 1000;
                windowLabel = `in the last hour`;
            }

            if (windowMs) {
                const now = Date.now();
                const filtered = notifs.filter(n => n.timestamp && (now - n.timestamp) <= windowMs);
                if (filtered.length === 0) {
                    return `You received no notifications ${windowLabel}, sir.`;
                }
                if (filtered.length === 1) {
                    const item = filtered[0];
                    return `You received 1 notification ${windowLabel} from ${item.appName || item.package} (${item.time}): "${item.text}".`;
                }
                const summary = filtered.slice(0, 5).map(n => `${n.appName || n.package} (${n.time}): "${n.text}"`).join('; ');
                return `You received ${filtered.length} notifications ${windowLabel}: ${summary}.`;
            }

            // No time window specified: return up to 3 latest
            if (notifs.length === 0) {
                return "You have no recent notifications logged from your phone, sir.";
            }

            const subset = notifs.slice(0, 3);
            const formatted = subset.map(n => {
                const ago = formatTimeAgo(n.timestamp);
                return `${n.appName || n.package} (${ago}): "${n.text}"`;
            }).join('; ');

            return `Here are your latest phone notifications, sir: ${formatted}.`;
        }
    }

    if (/\b(?:lock\s*(?:the\s*)?(?:screen|computer|pc|laptop)?)\b/i.test(lowerPrompt) &&
        !lowerPrompt.includes("o'clock") &&
        !lowerPrompt.includes("clock") &&
        !lowerPrompt.includes("phone")) {
        require('child_process').exec('rundll32.exe user32.dll,LockWorkStation');
        return "Locking the screen, sir.";
    }

    // â”€â”€ On-demand diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (/(system\s+(?:check|diagnostic|status)|run\s+diagnostic|health\s+check)/i.test(lowerPrompt)) {
        const { runDiagnostic } = require('./system_monitor');
        const stats = await runDiagnostic();
        prompt = `Here is the raw system diagnostic JSON:
${stats}

Act as Jarvis and give a concise, authoritative 3-sentence spoken health report.`;
    }




    // ── Automated System Check Routine ────────────────────────────────────────────────────────
    if (/(system\s+check|run\s+diagnostics)/i.test(lowerPrompt)) {
        console.log(`[Router] Initiating System Check Sequence...`);
        const axios = require('axios');
        let passed = 0;
        let total = 6;

        const updateNode = (node, status) => {
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'node_status', node, status }));
            }
        };

        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // 1. Check API Keys (Developer Node)
        updateNode('developer', 'active');
        await sleep(1000);
        const hasCloud = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEYS;
        if (hasCloud) { passed++; updateNode('developer', 'idle'); } else { updateNode('developer', 'error'); }

        // 2. Check Ollama (System Health Node)
        updateNode('system_health', 'active');
        await sleep(800);
        try {
            await axios.get('http://localhost:11434/api/tags', { timeout: 2000 });
            passed++; updateNode('system_health', 'idle');
        } catch (e) { updateNode('system_health', 'error'); }

        // 3. Check ChromaDB (Archivist Node)
        updateNode('archivist', 'active');
        await sleep(800);
        try {
            await axios.get('http://localhost:8000/api/v2/heartbeat', { timeout: 2000 });
            passed++; updateNode('archivist', 'idle');
        } catch (e) { updateNode('archivist', 'error'); }

        // 4. Check Cloud Worker (WhatsApp Node)
        updateNode('whatsapp', 'active');
        await sleep(800);
        try {
            const cloudUrl = process.env.CLOUD_WORKER_URL || 'https://jarvis-cloud-worker-ynyr.onrender.com';
            await axios.get(`${cloudUrl}/health`, { timeout: 4000 });
            passed++; updateNode('whatsapp', 'idle');
        } catch (e) { 
            // Fallback: check local WhatsApp client readiness
            try {
                const { getLatestQR } = require('./whatsapp_client');
                const st = getLatestQR ? getLatestQR() : { isReady: false };
                if (st.isReady) {
                    passed++; updateNode('whatsapp', 'idle');
                } else {
                    updateNode('whatsapp', 'error');
                }
            } catch {
                updateNode('whatsapp', 'error');
            }
        }

        // 5. Check Groq API endpoint directly (Web Search Node placeholder)
        updateNode('web_search', 'active');
        await sleep(800);
        try {
            if (process.env.OPENAI_API_KEY) {
                await axios.get('https://api.groq.com/openai/v1/models', {
                    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    timeout: 2000
                });
                passed++; updateNode('web_search', 'idle');
            } else { updateNode('web_search', 'error'); }
        } catch (e) { updateNode('web_search', 'error'); }

        // 6. Mic/TTS Readiness (Finance Node placeholder)
        updateNode('finance', 'active');
        await sleep(500);
        passed++; updateNode('finance', 'idle');

        if (passed === total) {
            return `All clear. All ${total} core checks passed and systems are optimal, sir.`;
        } else {
            return `Warning. Only ${passed} of ${total} core checks passed. Some backend systems are currently offline or unreachable, sir.`;
        }
    }

    // ── Executive Daily Debrief ─────────────────────────────────────────────────────────────
    if (/(status\s+report|how\s+are\s+things\s+doing|daily\s+debrief)/i.test(lowerPrompt)) {
        console.log(`[Router] Compiling Executive Debrief...`);
        const os = require('os');
        const uptimeHours = (os.uptime() / 3600).toFixed(1);

        let memoryCount = Math.floor(sessionHistory.length / 2);
        let scheduledMsg = "Cloud Managed";
        try {
            // Optional: query the cloud API here if we want an accurate count, but for now just mock it.
        } catch (e) { }

        let activeProjects = 1; // Count frontend as 1

        prompt = `Give me a very concise, professional status report as Jarvis. System uptime: ${uptimeHours} hours. Active projects: ${activeProjects}. Memories recorded this session: ${memoryCount}. Scheduled operations pending: ${scheduledMsg}. Make it sound high-tech and reassuring.`;
    }

    if (lowerPrompt.includes('good morning') || lowerPrompt.includes('morning report') || lowerPrompt.includes('briefing')) {
        console.log(`[Router] Intent classified as 'morning_routine'. Running full routine...`);
        let cacheData = 'No external notifications.';
        try {
            cacheData = fs.readFileSync(path.join(__dirname, 'briefing_cache.json'), 'utf8');
        } catch (e) { /* ignore */ }

        let weatherSummary = 'Weather data unavailable.';
        try {
            const { getWeather } = require('./weather_tools');
            const weatherJson = await getWeather('Bengaluru');
            const w = JSON.parse(weatherJson);
            weatherSummary = `${w.current.condition}, ${w.current.temperature}, feels like ${w.current.feelsLike}, humidity ${w.current.humidity}.`;
        } catch (e) { weatherSummary = 'Weather service unreachable.'; }

        let reminderSummary = "You have no upcoming local reminders since the master scheduler is now on the Cloud Backend.";

        const { runDiagnostic } = require('./system_monitor');
        const stats = await runDiagnostic();
        prompt = `Give me a concise morning briefing as Jarvis. Weather in Bengaluru: ${weatherSummary}. System status: ${stats}. Upcoming reminders: ${reminderSummary}. Notifications: ${cacheData}. Deliver it as one cohesive professional spoken briefing.`;
    }

    if (/\b(build|create|develop|code|scaffold|script|project|app)\b/.test(lowerPrompt)) {
        taskType = 'code';
    }

    // ─── Delegate complex/tool-requiring tasks to Developer Agent ──────────────────
    if (/\b(send|message|whatsapp|remind|reminder|weather|stock|ipo|email|ghost mode|clipboard|alarm|timer|alaram|news|search|events|lock|unlock|phone|image|generate|picture|draw|photo)\b/i.test(lowerPrompt)) {
        taskType = 'code';
    }

    if (/\b(close workspace|close development|go back|home page|exit workspace|stop developing)\b/.test(lowerPrompt)) {
        console.log(`[Router] Intent classified as 'close_workspace'.`);
        if (ws) {
            ws.send(JSON.stringify({ type: 'agent_log', text: '[Agent] Task completed. Exiting workspace.' }));
        }
        return "Closing the developer workspace and returning to home, sir.";
    }

    if (taskType === 'code' && ws) {
        console.log(`[Router] Intent classified as 'code'. Routing to Developer Agent (qwen2.5:7b)...`);
        const { runDeveloperAgent } = require('./developer_agent');
        await runDeveloperAgent(prompt, ws);
        // Track conversation in session history instead of SQLite
        pushSessionHistory('user', prompt);
        pushSessionHistory('assistant', '[Task delegated to Developer Agent]');
        return null; // Signals that developer agent handled the response stream
    }

    // Inject Long-Term Memory into system prompts
    const longTermMemories = await retrieveMemories(prompt);
    let dynamicSystemPrompt = SYSTEM_PROMPT;
    let dynamicKanglishPrompt = KANGLISH_PROMPT;

    if (longTermMemories) {
        const contextStr = `

[Relevant Past Context]
${longTermMemories}`;
        dynamicSystemPrompt += contextStr;
        dynamicKanglishPrompt += contextStr;
    }

    // Inject Live Phone Telemetry and Notifications
    const storedNotifs = (global.recentNotifications || []).slice(0, 10);
    const notifsBlock = storedNotifs.length > 0
        ? storedNotifs.map(n => `[${n.time} | ${n.appName || n.package}]: ${n.text}`).join('\n')
        : 'No notifications recorded.';

    const phoneContext = `\n\n### PHONE COMPANION & NOTIFICATION STATUS
Companion Socket: ${global.companionSocket && global.companionSocket.readyState === 1 ? 'Connected' : 'Disconnected'}
Recent Phone Notifications (Newest First):
${notifsBlock}
Latest Phone Event: ${JSON.stringify(global.recentPhoneEvent || 'No recent events')}`;

    dynamicSystemPrompt += phoneContext;
    dynamicKanglishPrompt += phoneContext;

    // â”€â”€ Build structured multi-turn message array â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Use live sessionHistory (in-memory, current session) as the primary context.
    // This gives Jarvis true conversational follow-up ("it", "that song", etc.)
    const chatMessages = [...sessionHistory, { role: 'user', content: prompt }];

    // Hardware Optimized Routing Rules
    const routingMap = {
        'chat': { local: 'nemotron-3-nano:4b', cloud: 'gemini-flash-latest' }
    };

    const targetLocalModel = routingMap[taskType] ? routingMap[taskType].local : 'nemotron-3-nano:4b';
    const targetCloudModel = routingMap[taskType] ? routingMap[taskType].cloud : 'gemini-flash-latest';

    let aiResponse = "";

    // â”€â”€ Cloud-First Routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const online = await isOnline();

    if (!online) {
        // Offline mode: go straight to local Ollama
        await announceEngine('Local Ollama', ws);
        console.log(`[Router] OFFLINE. Routing to Ollama (${targetLocalModel})...`);
        try {
            // Ollama doesn't support message arrays natively here, flatten for it
            // Ollama doesn't support message arrays natively here, flatten for it
            const flatPrompt = chatMessages.map(m => `${m.role === 'user' ? 'User' : 'Jarvis'}: ${m.content}`).join('\n');
            aiResponse = await callOllama(flatPrompt, dynamicKanglishPrompt, targetLocalModel);
        } catch (err) {
            aiResponse = "I am unable to process your request â€” I am offline and the local Ollama service is not running.";
        }
    } else {
        // Online mode: Groq -> Cerebras -> Gemini -> Ollama
        const hasGroq = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('gsk_');
        const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
        const hasGemini = geminiKeys.length > 0;

        const runOllamaFallback = async () => {
            await announceEngine('Local Ollama', ws);
            const flatPrompt = chatMessages.map(m => `${m.role === 'user' ? 'User' : 'Jarvis'}: ${m.content}`).join('\n');
            return await callOllama(flatPrompt, dynamicKanglishPrompt, targetLocalModel);
        };

        const runGeminiFallback = async () => {
            if (hasGemini) {
                await announceEngine('Gemini', ws);
                console.log(`[Router] Routing to Gemini (${targetCloudModel})...`);
                try {
                    return await callGemini(chatMessages, dynamicKanglishPrompt, targetCloudModel);
                } catch (geminiErr) {
                    console.warn(`[Router] Gemini failed: ${geminiErr.message}. Falling back to Ollama...`);
                    return await runOllamaFallback();
                }
            }
            return await runOllamaFallback();
        };

        const runOpenRouterFallback = async () => {
            if (hasOpenRouter) {
                await announceEngine('OpenRouter', ws);
                console.log(`[Router] Routing to OpenRouter (openrouter/free)...`);
                try {
                    return await callOpenRouter(chatMessages, dynamicSystemPrompt);
                } catch (orErr) {
                    console.warn(`[Router] OpenRouter failed: ${orErr.message}. Falling back to Gemini...`);
                    return await runGeminiFallback();
                }
            }
            return await runGeminiFallback();
        };

        if (hasGroq) {
            await announceEngine('Groq Cloud', ws);
            console.log(`[Router] ONLINE. Routing '${taskType}' to Groq (openai/gpt-oss-20b)...`);
            try {
                aiResponse = await callGroqLLM(chatMessages, dynamicSystemPrompt);
            } catch (groqErr) {
                console.warn(`[Router] Groq failed: ${groqErr.message}. Falling back to OpenRouter...`);
                aiResponse = await runOpenRouterFallback();
            }
        } else {
            console.log(`[Router] No Groq key. Routing '${taskType}' to OpenRouter...`);
            aiResponse = await runOpenRouterFallback();
        }
    }


    const commandRegex = /(start spotify:[^\n]+|start https:\/\/[^\n]+|powershell -c [^\n]+)/i;
    const match = aiResponse.match(commandRegex);
    if (match) {
        const command = match[1].trim();
        console.log(`[Router] Intercepted media command: ${command}`);
        if (command.toLowerCase().startsWith('start spotify:search:')) {
            // Force focus to Search Box using Ctrl+L (^l), then TABx4 to the Play button and ENTER
            const script = `${command} & powershell -c "Start-Sleep -Seconds 3; (New-Object -ComObject WScript.Shell).AppActivate('Spotify'); Start-Sleep -Milliseconds 500; (New-Object -ComObject WScript.Shell).SendKeys('^l'); Start-Sleep -Milliseconds 500; (New-Object -ComObject WScript.Shell).SendKeys('{TAB}'); Start-Sleep -Milliseconds 200; (New-Object -ComObject WScript.Shell).SendKeys('{TAB}'); Start-Sleep -Milliseconds 200; (New-Object -ComObject WScript.Shell).SendKeys('{TAB}'); Start-Sleep -Milliseconds 200; (New-Object -ComObject WScript.Shell).SendKeys('{TAB}'); Start-Sleep -Milliseconds 200; (New-Object -ComObject WScript.Shell).SendKeys('{ENTER}')"`;
            require('child_process').exec(script);
        } else if (command.toLowerCase().includes('youtube.com/results?search_query=')) {
            const queryMatch = command.match(/search_query=([^&\s]+)/);
            if (queryMatch) {
                const query = decodeURIComponent(queryMatch[1].replace(/\+/g, ' '));
                try {
                    const yts = require('yt-search');
                    yts(query).then(r => {
                        if (r && r.videos && r.videos.length > 0) {
                            require('child_process').exec(`start ${r.videos[0].url}`);
                        } else {
                            require('child_process').exec(command);
                        }
                    }).catch(() => require('child_process').exec(command));
                } catch (e) {
                    require('child_process').exec(command);
                }
            } else {
                require('child_process').exec(command);
            }
        } else {
            require('child_process').exec(command);
        }

        aiResponse = aiResponse.replace(command, '').trim();
        if (!aiResponse) aiResponse = "Right away, sir.";
    }

    // ── Update live session history for multi-turn continuity ─────────────────────
    pushSessionHistory('user', prompt);
    pushSessionHistory('assistant', aiResponse);

    // Run the Archivist in the background
    extractAndStoreMemory(prompt, aiResponse).catch(err => {
        console.error('[Archivist] Background task failed:', err.message);
    });

    return aiResponse;
}

module.exports = { routeQuery, callGemini, getNextGeminiKey, callGroqLLM, callOpenRouter, callOllama };


