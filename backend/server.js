const path = require('path');
const envPath = process.pkg ? path.join(path.dirname(process.execPath), '.env') : path.join(process.cwd(), '.env');
require('dotenv').config({ path: envPath });
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { routeQuery } = require('./llm_router');
const { transcribeAudio } = require('./stt_engine');
const { streamTTS } = require('./elevenlabs_tts');
const { initWhatsApp, getLatestQR } = require('./whatsapp_client');
const { verifyVoice } = require('./voice_gate');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

// ─── Boot Diagnostic ─────────────────────────────────────────────────────────
let bootReport = null;   // filled once on startup
let firstWakePending = true; // speak boot report on first wake word

// ─── Jarvis Persistent Logger & CrashGuard ──────────────────────────────────
const logFilePath = path.join(__dirname, 'jarvis.log');
function jarvisLog(tag, message) {
    const timeStr = new Date().toISOString();
    const line = `[${timeStr}] [${tag}] ${message}\n`;
    console.log(`[${tag}] ${message}`);
    try {
        fs.appendFileSync(logFilePath, line, 'utf8');
    } catch (e) {}
}
global.jarvisLog = jarvisLog;
jarvisLog('System', 'Jarvis backend logging initialized.');

process.on('uncaughtException', (err) => {
    jarvisLog('CrashGuard', `Caught uncaught exception: ${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', (reason) => {
    jarvisLog('CrashGuard', `Caught unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});


// ─── Phone Telemetry State ───────────────────────────────────────────────────
global.recentPhoneEvent = null;

// ─── Voice Auth Session Store ────────────────────────────────────────────────
// Maps sessionKey → { transcript, expires, ws }
const pendingSessions = new Map();

const MASTER_PIN = process.env.MASTER_UI_PIN || '1234';

// ─── Scrap Pipeline Config (Inactive by default) ───────────────────────────────
let scrapConfig = {
    isEnabled: false,       // Must be OFF by default on server boot
    mode: 'manual',         // 'manual' or 'auto'
    status: 'IDLE',
    currentEpisodeDir: null // Tracks last known active episode dir
};

// ─── Telegram Bot Initialization ─────────────────────────────────────────────
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    
    // Suppress polling errors when offline
    bot.on('polling_error', () => {});

    bot.on('callback_query', async (query) => {
        // Acknowledge immediately to dismiss loading spinner
        bot.answerCallbackQuery(query.id).catch(console.error);

        const data = query.data;
        if (data && data.startsWith('approve_')) {
            const sessionKey = data.replace('approve_', '');
            
            // Clean up expired sessions
            for (const [k, v] of pendingSessions.entries()) {
                if (Date.now() > v.expires) pendingSessions.delete(k);
            }

            const session = pendingSessions.get(sessionKey);
            if (!session) {
                bot.editMessageText('❌ Session expired or already approved.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).catch(console.error);
                return;
            }

            // Verify WebSocket state
            if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
                bot.editMessageText('❌ Client disconnected. Please try again.', {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }).catch(console.error);
                pendingSessions.delete(sessionKey);
                return;
            }

            // Execute command
            pendingSessions.delete(sessionKey);
            bot.editMessageText(`✅ Approved: _"${session.transcript}"_`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            }).catch(console.error);

            console.log(`[VoiceGate] Remote Telegram approval accepted. Executing: "${session.transcript}"`);
            
            // Send auth success to UI
            session.ws.send(JSON.stringify({ type: 'AUTH_RESULT', success: true, message: 'Authorized remotely via Telegram.' }));

            try {
                const responseText = await routeQuery(session.transcript, 'chat', session.ws, null);
                if (responseText) {
                    await streamTTS(responseText, session.ws,
                        (audioBase64, format) => {
                            session.ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format }));
                        },
                        () => console.log("[TTS] Finished streaming response."),
                        (err) => {
                            if (err.message === 'AbortError') return;
                            console.error("[TTS Error]", err);
                        },
                        null
                    );
                }
            } catch (err) {
                console.error('[Router] Error after Telegram auth:', err.message);
                session.ws.send(JSON.stringify({ type: 'stt_error', error: 'Execution failed.' }));
            }
        }
    });
}

/** Send an alert via Telegram if credentials are configured */
async function sendTelegramAlert(transcript, sessionKey) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!bot || !chatId) return; // Telegram not configured — skip silently

    const text = `🚨 *Jarvis Security Alert*\nVoice not recognized.\nBlocked command: _"${transcript}"_\n\nEnter your PIN in the Jarvis UI or tap Approve below.`;
    try {
        const options = { parse_mode: 'Markdown' };
        if (sessionKey) {
            options.reply_markup = {
                inline_keyboard: [
                    [{ text: 'Approve 🔓', callback_data: `approve_${sessionKey}` }]
                ]
            };
        }
        await bot.sendMessage(chatId, text, options);
        console.log('[VoiceGate] Telegram alert sent.');
    } catch (e) {
        console.warn('[VoiceGate] Telegram alert failed:', e.message);
    }
}

async function runBootDiagnostic() {
    const issues = [];
    const ok = [];

    // 1. Ollama check
    try {
        await axios.get('http://localhost:11434', { timeout: 1500 });
        ok.push('Local Ollama is online');
    } catch {
        issues.push('Local Ollama is offline — all AI requests will use cloud fallback');
    }

    // 2. Critical env keys
    const envChecks = [
        { key: 'OPENAI_API_KEY', label: 'Groq API' },
        { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API' },
        { key: 'GEMINI_API_KEY_1', label: 'Gemini API' },
        { key: 'ELEVENLABS_API_KEY_1', label: 'ElevenLabs TTS' },
    ];
    for (const { key, label } of envChecks) {
        if (process.env[key]) ok.push(`${label} key is configured`);
        else issues.push(`${label} key is missing`);
    }
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
        issues.push('Google Cloud Project ID is missing — Stitch UI designer will be disabled');
    }

    // 3. SQLite memory (removed)

    let report = 'Systems online, Sir. ';
    if (ok.length > 0) report += ok.join('. ') + '. ';
    if (issues.length > 0) report += 'However, ' + issues.join('. Also, ') + '.';
    else report += 'All systems are fully operational.';

    console.log('[Boot Diagnostic] Complete:', report);
    return report;
}


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ─── WhatsApp QR Browser Viewer ─────────────────────────────────────────────
app.get('/qr', (req, res) => {
    const status = (typeof getLatestQR === 'function') ? getLatestQR() : { isReady: false, qr: null };
    
    if (status.isReady) {
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jarvis WhatsApp Status</title>
    <meta http-equiv="refresh" content="10">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #131b2e; border: 1px solid #10b981; border-radius: 16px; padding: 40px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 440px; }
        .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid #10b981; padding: 6px 18px; border-radius: 9999px; font-weight: 700; font-size: 13px; letter-spacing: 0.05em; margin-bottom: 20px; }
        h1 { margin: 0 0 12px 0; font-size: 24px; font-weight: 700; }
        p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0; }
        .icon { font-size: 48px; margin-bottom: 12px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">✅</div>
        <div class="badge">WHATSAPP CONNECTED</div>
        <h1>WhatsApp Client is Active</h1>
        <p>Jarvis is securely authenticated and ready to send WhatsApp notifications, episode updates, and alerts.</p>
    </div>
</body>
</html>`);
    }

    if (!status.qr) {
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jarvis WhatsApp Status</title>
    <meta http-equiv="refresh" content="3">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #131b2e; border: 1px solid #334155; border-radius: 16px; padding: 40px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 440px; }
        .spinner { border: 4px solid rgba(255,255,255,0.1); border-left-color: #38bdf8; border-radius: 50%; width: 44px; height: 44px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        h1 { margin: 0 0 10px 0; font-size: 22px; font-weight: 700; }
        p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0; }
    </style>
</head>
<body>
    <div class="card">
        <div class="spinner"></div>
        <h1>Initializing WhatsApp Engine...</h1>
        <p>Generating session credentials. This page will refresh automatically in 3 seconds once the QR code is ready.</p>
    </div>
</body>
</html>`);
    }

    const qrImgUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=' + encodeURIComponent(status.qr);
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scan WhatsApp QR - Jarvis</title>
    <meta http-equiv="refresh" content="20">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #131b2e; border: 1px solid #25d366; border-radius: 20px; padding: 36px; text-align: center; box-shadow: 0 25px 50px rgba(37, 211, 102, 0.15); max-width: 460px; width: 100%; }
        h1 { margin: 0 0 8px 0; font-size: 22px; color: #25d366; font-weight: 700; }
        p { color: #cbd5e1; font-size: 14px; line-height: 1.5; margin: 0; }
        .qr-container { background: #ffffff; padding: 16px; border-radius: 14px; display: inline-block; margin: 24px 0 20px 0; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
        .qr-container img { display: block; width: 300px; height: 300px; }
        .instructions { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px 18px; text-align: left; margin-top: 10px; font-size: 13px; color: #94a3b8; }
        .instructions strong { color: #e2e8f0; display: block; margin-bottom: 6px; }
        .instructions ol { margin: 0; padding-left: 20px; line-height: 1.6; }
        .meta-notice { margin-top: 16px; font-size: 12px; color: #64748b; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Link WhatsApp to Jarvis</h1>
        <p>Point your phone's WhatsApp scanner at the QR code below:</p>
        <div class="qr-container">
            <img src="${qrImgUrl}" alt="WhatsApp Authentication QR Code" />
        </div>
        <div class="instructions">
            <strong>How to scan:</strong>
            <ol>
                <li>Open <b>WhatsApp</b> on your mobile phone.</li>
                <li>Go to <b>Settings</b> &rarr; <b>Linked Devices</b>.</li>
                <li>Tap <b>Link a Device</b> and point camera at this screen.</li>
            </ol>
        </div>
        <div class="meta-notice">Page automatically refreshes every 20s until authenticated.</div>
    </div>
</body>
</html>`);
});


// ─── Phone Telemetry Webhook (MacroDroid) ────────────────────────────────────
app.post('/api/phone-event', (req, res) => {
    global.recentPhoneEvent = req.body;
    console.log(`[PhoneBridge] Telemetry received:`, req.body);
    
    // Broadcast the alert to all connected React UI clients
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== companionSocket) {
            client.send(JSON.stringify({
                type: 'phone_alert',
                payload: req.body
            }));
        }
    });
    
    res.sendStatus(200);
});

// ─── Jarvis Companion App Notification Storage & Hook ──────────────────────────
const NOTIFICATIONS_STORAGE_PATH = path.join(__dirname, 'recent_notifications.json');
try {
    if (fs.existsSync(NOTIFICATIONS_STORAGE_PATH)) {
        global.recentNotifications = JSON.parse(fs.readFileSync(NOTIFICATIONS_STORAGE_PATH, 'utf8'));
    } else {
        global.recentNotifications = [];
    }
} catch (e) {
    global.recentNotifications = [];
}

function getFriendlyAppName(pkg) {
    if (!pkg) return 'Unknown App';
    const lower = pkg.toLowerCase();
    if (lower.includes('snapchat') || lower.includes('snap')) return 'Snapchat';
    if (lower.includes('whatsapp')) return 'WhatsApp';
    if (lower.includes('instagram')) return 'Instagram';
    if (lower.includes('telegram')) return 'Telegram';
    if (lower.includes('gmail') || lower.includes('mail')) return 'Gmail';
    if (lower.includes('dialer') || lower.includes('telecom') || lower.includes('call')) return 'Phone Call';
    if (lower.includes('mms') || lower.includes('sms') || lower.includes('messaging')) return 'Messages';
    if (lower.includes('youtube')) return 'YouTube';
    if (lower.includes('twitter') || lower.includes('x.android')) return 'X (Twitter)';
    if (lower.includes('discord')) return 'Discord';
    if (lower.includes('slack')) return 'Slack';
    return pkg.replace('com.', '').replace('.android', '').replace('.app', '');
}

function saveNotification(payload) {
    if (!global.recentNotifications) global.recentNotifications = [];
    const pkg = payload.package || payload.pkg || 'unknown';
    const text = payload.text || payload.message || payload.body || '';
    const title = payload.title || '';
    const eventType = payload.type || 'NOTIFICATION';
    const appName = getFriendlyAppName(pkg);

    const entry = {
        id: Date.now() + Math.random(),
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString(),
        date: new Date().toLocaleDateString(),
        package: pkg,
        appName: appName,
        title: title,
        text: text,
        type: eventType
    };

    console.log(`[Companion] Notification stored from ${appName} (${pkg}): ${text}`);
    global.recentNotifications.unshift(entry);
    if (global.recentNotifications.length > 50) global.recentNotifications.pop();

    try {
        fs.writeFileSync(NOTIFICATIONS_STORAGE_PATH, JSON.stringify(global.recentNotifications, null, 2));
    } catch (err) {
        console.error('[Notification Store Error]', err.message);
    }

    global.recentPhoneEvent = { type: eventType, package: pkg, appName: appName, text: text, time: entry.time };

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== companionSocket) {
            client.send(JSON.stringify({
                type: 'phone_alert',
                payload: global.recentPhoneEvent
            }));
        }
    });

    return entry;
}

app.post('/companion/notify', (req, res) => {
    if (req.body && req.body.token === 'naveenjarvisphone') {
        saveNotification(req.body);
        res.sendStatus(200);
    } else {
        res.sendStatus(403);
    }
});

// ─── Scrap Pipeline REST Endpoints ─────────────────────────────────────────

app.get('/api/scrap/status', (req, res) => {
    const { getPipelineState } = require('./scrap_pipeline');
    const pipelineState = getPipelineState();

    // Also scan for latest episode_state.json
    let episodeState = null;
    try {
        const BASE_DIR = 'D:\\youtube\\episodes';
        if (fs.existsSync(BASE_DIR)) {
            const epDirs = fs.readdirSync(BASE_DIR)
                .filter(d => fs.statSync(path.join(BASE_DIR, d)).isDirectory());
                
            const activePrefix = `EP${String(pipelineState.current_episode_index).padStart(2, '0')}_`;
            const activeDir = epDirs.find(d => d.startsWith(activePrefix));
            
            if (activeDir) {
                const stateFile = path.join(BASE_DIR, activeDir, 'episode_state.json');
                if (fs.existsSync(stateFile)) {
                    episodeState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                }
                scrapConfig.currentEpisodeDir = path.join(BASE_DIR, activeDir);
            }
        }
    } catch (e) { /* ignore */ }

    // If AWAITING_CLIPS, scan raw_clips dir and count ready/missing clips
    let clipsInfo = null;
    if (episodeState && episodeState.status === 'AWAITING_CLIPS' && episodeState.episode_dir) {
        const rawClipsDir = path.join(episodeState.episode_dir, '03_raw_clips');
        const totalScenes = episodeState.total_scenes;
        const readyClips = [];
        const missingScenes = [];
        for (let i = 1; i <= totalScenes; i++) {
            const sceneNum = String(i).padStart(2, '0');
            const clipPath = path.join(rawClipsDir, `scene_${sceneNum}.mp4`);
            if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 100 * 1024) {
                readyClips.push(i);
            } else {
                missingScenes.push(i);
            }
        }
        clipsInfo = { readyCount: readyClips.length, totalScenes, missingScenes, readyClips };
    }

    res.json({ scrapConfig, pipelineState, episodeState, clipsInfo });
});

app.post('/api/scrap/config', (req, res) => {
    const { isEnabled, mode } = req.body;
    const { updatePipelineState } = require('./scrap_pipeline');
    
    if (typeof isEnabled === 'boolean') {
        scrapConfig.isEnabled = isEnabled;
        updatePipelineState({ youtube_pipeline_enabled: isEnabled });
    }
    if (mode === 'manual' || mode === 'auto') scrapConfig.mode = mode;
    
    console.log('[Scrap Config]', scrapConfig);
    res.json({ success: true, scrapConfig });
});

app.post('/api/scrap/start', async (req, res) => {
    if (!scrapConfig.isEnabled) {
        return res.status(403).json({ success: false, error: 'Scrap pipeline is disabled. Enable it first.' });
    }
    const { getPipelineState, produceScrapEpisode } = require('./scrap_pipeline');
    const state = getPipelineState();
    const broadcastWS = {
        send: (data) => { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); }
    };
    scrapConfig.status = 'RUNNING';
    produceScrapEpisode(
        state.current_episode_index || 1,
        req.body.title || 'Scrap & Spark Episode',
        broadcastWS,
        false,
        scrapConfig.mode
    ).then(() => { scrapConfig.status = scrapConfig.mode === 'manual' ? 'AWAITING_CLIPS' : 'IDLE'; })
     .catch(e => {
        if (e.message === 'ABORTED') {
            scrapConfig.status = 'Idle';
        } else {
            scrapConfig.status = 'ERROR'; 
            console.error('[Scrap Start Error]', e); 
        }
     });
    res.json({ success: true, message: `Pipeline started in ${scrapConfig.mode} mode.` });
});

app.post('/api/scrap/upload', (req, res) => {
    const { executeUpload } = require('./scrap_pipeline');
    const broadcastWS = { send: (data) => { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); } };
    executeUpload(broadcastWS).catch(e => console.error(e));
    res.json({ success: true });
});

app.post('/api/scrap/cancel_upload', (req, res) => {
    const { cancelUpload } = require('./scrap_pipeline');
    const broadcastWS = { send: (data) => { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); } };
    cancelUpload(broadcastWS);
    res.json({ success: true });
});

app.post('/api/scrap/assemble', async (req, res) => {
    console.log('[API] Received /api/scrap/assemble request!');
    const { assembleScrapEpisode } = require('./scrap_pipeline');
    const BASE_DIR = 'D:\\youtube\\episodes';

    // Find the episode dir to assemble (use episodeDir from body or scan for latest AWAITING_CLIPS)
    let episodeDir = req.body.episodeDir || scrapConfig.currentEpisodeDir;
    if (!episodeDir) {
        try {
            const epDirs = fs.readdirSync(BASE_DIR).filter(d => fs.statSync(path.join(BASE_DIR, d)).isDirectory()).sort().reverse();
            for (const d of epDirs) {
                const stateFile = path.join(BASE_DIR, d, 'episode_state.json');
                if (fs.existsSync(stateFile)) {
                    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                    if (st.status === 'AWAITING_CLIPS') { episodeDir = path.join(BASE_DIR, d); break; }
                }
            }
        } catch (e) {}
    }
    if (!episodeDir) return res.status(400).json({ success: false, error: 'No AWAITING_CLIPS episode found.' });

    const episodeStateFile = path.join(episodeDir, 'episode_state.json');
    const stateData = JSON.parse(fs.readFileSync(episodeStateFile, 'utf8'));
    const totalScenes = stateData.total_scenes;
    const rawClipsDir = path.join(episodeDir, '03_raw_clips');

    // Validate all clips exist and are > 100KB
    const missingScenes = [];
    for (let i = 1; i <= totalScenes; i++) {
        const sceneNum = String(i).padStart(2, '0');
        const clipPath = path.join(rawClipsDir, `scene_${sceneNum}.mp4`);
        if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size <= 100 * 1024) {
            missingScenes.push(i);
        }
    }
    if (missingScenes.length > 0) {
        return res.status(400).json({ success: false, missingScenes, message: `${missingScenes.length} scene(s) missing or under 100KB.` });
    }

    // All valid — kick off async assembly
    const broadcastWS = {
        send: (data) => { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); }); }
    };
    scrapConfig.status = 'ASSEMBLING';
    res.json({ success: true, message: 'Assembly started. Monitor pipeline logs for progress.' });
    assembleScrapEpisode(episodeDir, broadcastWS)
        .then(finalPath => {
            scrapConfig.status = 'IDLE';
            broadcastWS.send(JSON.stringify({ type: 'scrap_assembled', finalPath }));
        })
        .catch(e => {
            scrapConfig.status = 'ERROR';
            broadcastWS.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Assembly Error] ${e.message}` }));
        });
});

// Serve local media files for programmatic rendering (Remotion Chromium workaround)
app.use('/youtube', express.static('D:\\youtube'));

// REST Endpoint for standard requests (e.g., executing a command or simple chat)
app.post('/api/ask', async (req, res) => {
    const { prompt, taskType } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        const responseText = await routeQuery(prompt, taskType || 'chat');
        res.json({ response: responseText });
    } catch (error) {
        console.error("[Server Error]", error.message);
        res.status(500).json({ error: 'Failed to process request.' });
    }
});

// REST Endpoint for caching sensor/briefing data
app.post('/api/briefing/cache', (req, res) => {
    try {
        const cachePath = path.join(__dirname, 'briefing_cache.json');
        fs.writeFileSync(cachePath, JSON.stringify(req.body, null, 2));
        res.json({ success: true, message: 'Data cached for briefing.' });
    } catch (err) {
        console.error('[Cache Error]', err);
        res.status(500).json({ error: 'Failed to write cache.' });
    }
});

let currentAbortController = null;

// WebSocket for potential streaming interactions
// --- Companion Phone Connection ---
let companionSocket = null;
global.sendToCompanion = function(commandObj) {
    if (companionSocket && companionSocket.readyState === WebSocket.OPEN) {
        commandObj.token = 'naveenjarvisphone';
        companionSocket.send(JSON.stringify(commandObj));
        jarvisLog('Companion', `Sent command: ${JSON.stringify(commandObj)}`);
        return true;
    }
    return false;
};

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const reqUrl = (req && req.url) ? req.url : '';
    const isCompanionRoute = reqUrl === '/companion' || reqUrl.startsWith('/companion/') || reqUrl.startsWith('/companion?');

    if (isCompanionRoute) {
        jarvisLog('Phone Companion', `Incoming WebSocket connection on path: ${reqUrl}`);
        companionSocket = ws;
        global.companionSocket = ws;
        wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c !== ws) {
                c.send(JSON.stringify({ type: 'log', text: '[Phone Companion] Mobile device connected.' }));
            }
        });
        ws.on('message', (msg) => {
            try {
                let data = JSON.parse(msg);
                if (data.type === 'AUTH' && data.token === 'naveenjarvisphone') {
                    companionSocket = ws;
                    global.companionSocket = ws;
                    jarvisLog('Phone Companion', 'Authenticated successfully with token.');
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN && c !== ws) {
                            c.send(JSON.stringify({ type: 'log', text: '[Phone Companion] Authenticated successfully.' }));
                        }
                    });
                }
                if ((data.type === 'NOTIFICATION' || data.type === 'notification' || data.type === 'PHONE_ALERT') && data.token === 'naveenjarvisphone') {
                    jarvisLog('Phone Companion', `Received notification from: ${data.appName || data.package || 'Phone'}`);
                    saveNotification(data);
                }
            } catch(e) {
                jarvisLog('Phone Companion', `Parse error: ${e.message}`);
            }
        });
        ws.on('close', (code, reason) => { 
            jarvisLog('Phone Companion', `Disconnected (code: ${code}).`);
            if(companionSocket === ws) companionSocket = null; 
            if(global.companionSocket === ws) global.companionSocket = null;
            wss.clients.forEach(c => {
                if (c.readyState === WebSocket.OPEN && c !== ws) {
                    c.send(JSON.stringify({ type: 'log', text: '[Phone Companion] Mobile device disconnected.' }));
                }
            });
        });
        ws.on('error', (err) => {
            jarvisLog('Phone Companion', `Socket error: ${err.message}`);
        });
        return;
    }

    
    console.log('[WebSocket] Client connected.');
    if (activeTunnelUrl) {
        ws.send(JSON.stringify({ type: 'log', text: `[Tunnel] Public link active: ${activeTunnelUrl}` }));
        ws.send(JSON.stringify({ type: 'companion_tunnel_url', url: activeTunnelUrl }));
    } else {
        ws.send(JSON.stringify({ type: 'log', text: '[Tunnel] Initializing public link...' }));
    }

    ws.on('message', async (message, isBinary) => {
        try {
            if (isBinary) {
                console.log(`[WebSocket] Received audio chunk (${message.length} bytes). Processing STT...`);

                // ── Voice Biometric Gate ──
                const { authorized, score } = await verifyVoice(message);
                if (!authorized) {
                    // 1. Transcribe so we know what was said (for PIN fallback)
                    const blockedText = await transcribeAudio(message);
                    
                    // 2. Cache it with a session key (expires in 3 minutes)
                    const sessionKey = crypto.randomBytes(6).toString('hex');
                    pendingSessions.set(sessionKey, {
                        transcript: blockedText || '[unrecognized audio]',
                        expires: Date.now() + 3 * 60 * 1000,
                        ws: ws
                    });

                    // 3. Alert the frontend
                    ws.send(JSON.stringify({
                        type: 'AUTH_REQUIRED',
                        reason: 'VOICE_UNRECOGNIZED',
                        score: score.toFixed(3),
                        sessionKey,
                        hasTelegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
                        message: 'Verification Failed: Input UI PIN'
                    }));

                    // 4. Send Telegram alert (non-blocking)
                    // sendTelegramAlert(blockedText || '[unrecognized audio]', sessionKey).catch(() => {});

                    console.log(`[VoiceGate] Command blocked. Score: ${score.toFixed(3)}. Session: ${sessionKey}`);
                    return;
                }

                // ── Gate passed — proceed to STT ──
                const transcribedText = await transcribeAudio(message);
                if (!transcribedText || transcribedText.trim().length === 0) return;

                console.log(`[STT] User: "${transcribedText}"`);
                ws.send(JSON.stringify({ type: 'log', text: `User: ${transcribedText}` }));

                const lowerText = transcribedText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
                
                if (!currentAbortController) {
                    currentAbortController = new AbortController();
                }

                if (lowerText.includes('jarvis')) {
                    ws.send(JSON.stringify({ type: 'wake_word_detected' }));

                    // Speak boot report on very first wake after server start
                    if (firstWakePending && transcribedText.length > 2) {
                        firstWakePending = false;
                        if (bootReport) {
                            ws.send(JSON.stringify({ type: 'llm_response', text: bootReport }));
                            await streamTTS(bootReport, ws,
                                (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                                () => console.log("[Boot Diagnostic] TTS Finished."),
                                (err) => console.error("[Boot Diagnostic] TTS Error", err),
                                currentAbortController.signal
                            );
                        }
                        // Do NOT return here. Continue to process the user's actual command.
                    }
                }

                if (['stop', 'jarvis stop', 'shut up', 'quiet', 'cancel'].includes(lowerText)) {
                    if (currentAbortController) {
                        console.log('[STT] Voice Interruption detected. Aborting operations.');
                        currentAbortController.abort();
                        currentAbortController = null;
                    }
                    ws.send(JSON.stringify({ type: 'user_interrupt' }));
                    return;
                }

                // If not an interrupt, abort any previous hanging task and start a new one
                if (currentAbortController) {
                    currentAbortController.abort();
                    ws.send(JSON.stringify({ type: 'user_interrupt' }));
                }
                currentAbortController = new AbortController();
                const signal = currentAbortController.signal;
                if (lowerText.includes('approve') || lowerText.includes('yes sir') || lowerText.includes('proceed') || lowerText.includes('approved')) {
                    const { approvalManager } = require('./developer_agent');
                    approvalManager.emit('approval_granted_verbal');
                    ws.send(JSON.stringify({ type: 'agent_log', text: `[Voice Authorized]` }));
                    return;
                }
                if (lowerText.includes('deny') || lowerText.includes('cancel') || lowerText.includes('denied')) {
                    const { approvalManager } = require('./developer_agent');
                    approvalManager.emit('approval_denied_verbal');
                    ws.send(JSON.stringify({ type: 'agent_log', text: `[Voice Denied]` }));
                    return;
                }

                if (lowerText.includes('what am i holding') || lowerText.includes('look at my desk') || lowerText.includes('what is this')) {
                    console.log(`[STT] Webcam vision requested. Triggering frontend...`);
                    ws.send(JSON.stringify({ type: 'trigger_webcam', prompt: transcribedText }));
                    return;
                }

                // 2. Route Query to LLM
                try {
                    const responseText = await routeQuery(transcribedText, 'chat', ws, signal);
                    if (!responseText || signal.aborted) return; // If developer agent took over or aborted

                    console.log(`[LLM Response]: ${responseText}`);
                    ws.send(JSON.stringify({ type: 'llm_response', text: responseText }));

                    // 3. Stream TTS back to frontend
                    await streamTTS(responseText, ws,
                        (audioBase64, format) => {
                            ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format }));
                        },
                        () => console.log("[TTS] Finished streaming response."),
                        (err) => {
                            if (err.message === 'AbortError') return;
                            console.error("[TTS Error]", err);
                            ws.send(JSON.stringify({ type: 'log', text: `[Error] TTS Failed: ${err.message}` }));
                        },
                        signal
                    );
                } catch (err) {
                    console.error("[WebSocket Error]", err);
                    ws.send(JSON.stringify({ type: 'log', text: `[Error] ${err.message}` }));
                    ws.send(JSON.stringify({ type: 'llm_response', text: `Error: ${err.message}` }));
                    await streamTTS(`I encountered an error: ${err.message}`, ws,
                        (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                        () => {},
                        () => {},
                        signal
                    );
                }
            } else {
                const data = JSON.parse(message.toString());
                if (data.type === 'AUTH' && data.token === 'naveenjarvisphone') {
                    companionSocket = ws;
                    global.companionSocket = ws;
                    jarvisLog('Phone Companion', 'Authenticated on default socket, promoted to companion.');
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN && c !== ws) {
                            c.send(JSON.stringify({ type: 'log', text: '[Phone Companion] Mobile device connected & authenticated.' }));
                        }
                    });
                    return;
                }
                if ((data.type === 'NOTIFICATION' || data.type === 'notification' || data.type === 'PHONE_ALERT') && data.token === 'naveenjarvisphone') {
                    jarvisLog('Phone Companion', `Received notification via promoted socket: ${data.appName || data.package || 'Phone'}`);
                    saveNotification(data);
                    return;
                }
                if (data.type === 'approval_granted' || data.type === 'approval_denied') {
                    const { approvalManager } = require('./developer_agent');
                    approvalManager.emit(data.type, data.id);
                    return;
                }

                // ── Forward commands to Phone Companion ──
                if (data.type === 'companion_command') {
                    if (typeof global.sendToCompanion === 'function') {
                        global.sendToCompanion(data.commandObj);
                    }
                    return;
                }

                // ── On-Demand Telegram Alert ──
                if (data.type === 'REQUEST_TELEGRAM_AUTH') {
                    const session = pendingSessions.get(data.sessionKey);
                    if (session) {
                        sendTelegramAlert(session.transcript, data.sessionKey).catch(() => {});
                        ws.send(JSON.stringify({ type: 'log', text: '[Security] Telegram alert dispatched.' }));
                    }
                    return;
                }

                // ── TTS Alert (System announcements) ──
                if (data.type === 'tts_alert') {
                    console.log(`[TTS Alert] Speaking: ${data.text}`);
                    try {
                        await streamTTS(data.text, ws,
                            (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                            () => {},
                            (err) => console.error('[TTS Error]', err)
                        );
                    } catch (e) {
                        console.error('[TTS Alert Error]', e);
                    }
                    return;
                }

                // ── Master PIN Verification ──
                if (data.type === 'SUBMIT_PIN') {
                    const { pin, sessionKey } = data;
                    
                    // Clean up expired sessions first
                    for (const [k, v] of pendingSessions.entries()) {
                        if (Date.now() > v.expires) pendingSessions.delete(k);
                    }

                    const session = pendingSessions.get(sessionKey);
                    if (!session) {
                        ws.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Session expired. Please try again.' }));
                        return;
                    }

                    if (pin !== MASTER_PIN) {
                        ws.send(JSON.stringify({ type: 'AUTH_RESULT', success: false, message: 'Incorrect PIN.' }));
                        console.warn(`[VoiceGate] Incorrect PIN attempt for session ${sessionKey}`);
                        return;
                    }

                    // PIN correct — execute the blocked command
                    const { transcript } = session;
                    pendingSessions.delete(sessionKey);
                    ws.send(JSON.stringify({ type: 'AUTH_RESULT', success: true, message: 'Authorized via PIN.' }));
                    console.log(`[VoiceGate] PIN accepted. Executing: "${transcript}"`);

                    try {
                        const responseText = await routeQuery(transcript, 'chat', ws, null);
                        if (responseText) {
                            ws.send(JSON.stringify({ type: 'llm_response', text: responseText }));
                            await streamTTS(responseText, ws,
                                (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                                () => {},
                                (err) => console.error('[TTS Error]', err)
                            );
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'log', text: `[Error] ${err.message}` }));
                    }
                    return;
                }

                if (data.type === 'get_youtube_pipeline_state') {
                    const { getPipelineState } = require('./scrap_pipeline');
                    const state = getPipelineState();
                    ws.send(JSON.stringify({ type: 'youtube_pipeline_state', enabled: state.youtube_pipeline_enabled, forceLocalTts: !!state.force_local_tts }));
                    return;
                }
                
                if (data.type === 'toggle_local_tts') {
                    const { updatePipelineState } = require('./scrap_pipeline');
                    updatePipelineState({ force_local_tts: data.enabled });
                    ws.send(JSON.stringify({ type: 'local_tts_state', enabled: data.enabled }));
                    ws.send(JSON.stringify({ type: 'log', text: `[System] Voice Engine: ${data.enabled ? 'Local Piper TTS' : 'Cloud Gemini TTS'}` }));
                    return;
                }

                if (data.type === 'toggle_youtube_pipeline') {
                    const { getPipelineState, updatePipelineState, produceScrapEpisode } = require('./scrap_pipeline');
                    updatePipelineState({ youtube_pipeline_enabled: data.enabled });
                    scrapConfig.isEnabled = data.enabled;
                    scrapConfig.mode = 'manual'; // Default to manual to save API costs
                    
                    ws.send(JSON.stringify({ type: 'youtube_pipeline_state', enabled: data.enabled }));
                    ws.send(JSON.stringify({ type: 'log', text: `[System] YouTube Pipeline ${data.enabled ? 'Enabled (Manual Mode)' : 'Disabled'}` }));

                    // If newly enabled, trigger the check immediately
                    if (data.enabled) {
                        const state = getPipelineState();
                        const todayStr = new Date().toISOString().split('T')[0];
                        if (state.last_run_date !== todayStr && !state.pending_review) {
                            ws.send(JSON.stringify({ type: 'agent_log', text: '[Scheduler] Missing Scrap episode detected. Initializing manual catch-up production.' }));
                            
                            const broadcastWS = {
                                send: (msg) => {
                                    wss.clients.forEach(c => {
                                        if (c.readyState === WebSocket.OPEN) c.send(msg);
                                    });
                                }
                            };
                            
                            produceScrapEpisode(state.current_episode_index, state.current_episode_title || "Scrap & Spark Episode", broadcastWS, false, scrapConfig.mode).catch(e => console.error(e));
                        }
                    }
                    return;
                }

                if (data.type === 'vision_query') {
                    console.log(`[WebSocket] Received webcam frame. Processing vision request...`);
                    const { analyzeWebcamFrame } = require('./vision_agent');
                    const description = await analyzeWebcamFrame(data.imageBase64, data.prompt);
                    ws.send(JSON.stringify({ type: 'llm_response', text: description }));
                    await streamTTS(description, ws,
                        (audioBase64, format) => { ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })); },
                        () => { },
                        (err) => console.error("[TTS Error]", err)
                    );
                    return;
                }

                if (data.type === 'stop_generation') {
                    console.log(`[WebSocket] Received stop_generation from client.`);
                    ws.isAborted = true;
                    ws.send(JSON.stringify({ type: 'chat_end' }));
                    return;
                }

                if (data.type === 'chat_message') {
                    ws.isAborted = false; // Reset on new message
                    const { prompt: chatPrompt, silent } = data;
                    console.log(`[Chat] Text message received: ${chatPrompt.substring(0, 60)}... | silent=${silent}`);
                    
                    try {
                        const chatResponse = await routeQuery(chatPrompt, 'chat', ws, null, silent);
                        if (!chatResponse) {
                            ws.send(JSON.stringify({ type: 'chat_end' }));
                            return;
                        }

                        // Stream response word-by-word for live typing effect
                        const words = chatResponse.split(' ');
                        for (const word of words) {
                            ws.send(JSON.stringify({ type: 'chat_chunk', text: word + ' ' }));
                            await new Promise(r => setTimeout(r, 18));
                        }
                        ws.send(JSON.stringify({ type: 'chat_end' }));

                        // Only play TTS if silent mode is OFF
                        if (!silent) {
                            await streamTTS(chatResponse, ws,
                                (audioBase64, format) => { ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })); },
                                () => console.log("[TTS] Chat TTS finished."),
                                (err) => console.error("[TTS Error]", err)
                            );
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'chat_end' }));
                        ws.send(JSON.stringify({ type: 'log', text: `[Chat Error] ${err.message}` }));
                        ws.send(JSON.stringify({ type: 'llm_response', text: `Error: ${err.message}` }));
                    }
                    return;
                }

                const { prompt, taskType } = data;

                console.log(`[WebSocket] Received prompt: ${prompt.substring(0, 50)}...`);
                const responseText = await routeQuery(prompt, taskType || 'chat', ws);
                if (!responseText) return;

                console.log(`[LLM Response]: ${responseText}`);
                ws.send(JSON.stringify({ type: 'llm_response', text: responseText }));
            }
        } catch (error) {
            console.error("[WebSocket Error]", error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'log', text: `[Error] ${error.message}` }));
                ws.send(JSON.stringify({ type: 'llm_response', text: `[System Error]: ${error.message}` }));
            }
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected.');
    });
});

// WebSocket Keepalive Loop (Pings every 10 seconds to aggressively kill ghost connections)
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[WebSocket] Client timed out (No PONG). Terminating ghost socket.');
            if (companionSocket === ws) {
                console.log('[WebSocket] The dead socket was the Phone Companion. Clearing it.');
                companionSocket = null;
                if (global.companionSocket === ws) global.companionSocket = null;
            }
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

// Active Tunnel state
let activeTunnelUrl = null;

function getLocalIp() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
                    return iface.address;
                }
            }
        }
    } catch(e) {}
    return '127.0.0.1';
}

// Telemetry Loop
setInterval(() => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedMemGb = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    const totalMemGb = (totalMem / 1024 / 1024 / 1024).toFixed(1);
    
    // Slight random jitter for latency to look alive (28 - 36ms)
    const latency = Math.floor(Math.random() * 8 + 28);
    // Core temp mock jitter (34 - 36)
    const temp = Math.floor(Math.random() * 2 + 34);

    const localIp = getLocalIp();
    const localCompanionUrl = `ws://${localIp}:${PORT}/companion`;

    const telemetry = {
        type: 'sys_telemetry',
        memoryUsage: `${usedMemGb} GB`,
        memoryTotal: `${totalMemGb} GB`,
        coreTemp: `${temp}°C OPTIMAL`,
        latency: `${latency}ms`,
        phoneConnected: !!(companionSocket && companionSocket.readyState === WebSocket.OPEN),
        tunnelUrl: activeTunnelUrl,
        localCompanionUrl: localCompanionUrl
    };
    
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(telemetry));
    });
}, 2000);

const PORT = process.env.PORT || 3000;
const localtunnel = require('localtunnel');
server.listen(PORT, async () => {
    jarvisLog('Server', `Server active on port ${PORT}`);
    console.log(`[Jarvis Brain] Ready to process Kanglish routing.`);
    
    // Start auto-tunnel for the Jarvis Companion app with resilient fallback
    let tunnelInstance = null;
    let isConnectingTunnel = false;

    async function startTunnel() {
        if (isConnectingTunnel) return;
        isConnectingTunnel = true;
        const preferredSubdomain = process.env.COMPANION_SUBDOMAIN || 'jarvis-nav-companion';
        try {
            if (tunnelInstance) {
                try { tunnelInstance.close(); } catch(e) {}
                tunnelInstance = null;
            }
            jarvisLog('Tunnel', `Connecting localtunnel with subdomain: ${preferredSubdomain}...`);
            const tunnel = await localtunnel({ port: PORT, subdomain: preferredSubdomain });
            tunnelInstance = tunnel;
            activeTunnelUrl = tunnel.url;
            isConnectingTunnel = false;
            jarvisLog('Tunnel', `Secure public link established: ${tunnel.url}`);
            
            // Broadcast to connected clients so UI displays the exact live URL and logs
            wss.clients.forEach(c => {
                if (c.readyState === WebSocket.OPEN) {
                    c.send(JSON.stringify({ type: 'log', text: `[Tunnel] Secure link active: ${tunnel.url}` }));
                    c.send(JSON.stringify({ type: 'companion_tunnel_url', url: tunnel.url, localUrl: `ws://${getLocalIp()}:${PORT}/companion` }));
                }
            });
            
            tunnel.on('close', () => {
                jarvisLog('Tunnel', 'Connection dropped. Restarting tunnel in 3s...');
                activeTunnelUrl = null;
                tunnelInstance = null;
                wss.clients.forEach(c => {
                    if (c.readyState === WebSocket.OPEN) {
                        c.send(JSON.stringify({ type: 'log', text: '[Tunnel] Connection dropped. Reconnecting...' }));
                        c.send(JSON.stringify({ type: 'companion_tunnel_url', url: null }));
                    }
                });
                setTimeout(startTunnel, 3000);
            });

            tunnel.on('error', (err) => {
                jarvisLog('Tunnel', `Tunnel socket error: ${err.message}. Recycling...`);
                try { tunnel.close(); } catch(e) {}
            });
        } catch(err) {
            isConnectingTunnel = false;
            jarvisLog('Tunnel', `Error establishing localtunnel: ${err.message}`);
            activeTunnelUrl = null;
            tunnelInstance = null;
            wss.clients.forEach(c => {
                if (c.readyState === WebSocket.OPEN) {
                    c.send(JSON.stringify({ type: 'log', text: `[Tunnel] Error: ${err.message}. Retrying in 5s...` }));
                }
            });
            setTimeout(startTunnel, 5000);
        }
    }
    startTunnel();

    // Tunnel healthcheck every 40s to prevent stale 503 tunnels (only runs when idle)
    setInterval(async () => {
        if (!activeTunnelUrl || isConnectingTunnel || (companionSocket && companionSocket.readyState === WebSocket.OPEN)) return;
        try {
            const res = await axios.get(activeTunnelUrl, {
                headers: { 'Bypass-Tunnel-Reminder': 'true' },
                timeout: 8000,
                validateStatus: () => true
            });
            if (res.status === 503 || res.status >= 500) {
                jarvisLog('Tunnel', `Tunnel healthcheck failed (HTTP ${res.status}). Restarting tunnel...`);
                if (tunnelInstance) {
                    try { tunnelInstance.close(); } catch(e) {}
                    tunnelInstance = null;
                }
                activeTunnelUrl = null;
                startTunnel();
            }
        } catch(e) {
            jarvisLog('Tunnel', `Tunnel healthcheck probe warning: ${e.message}`);
        }
    }, 40000);

    // Run boot diagnostic (non-blocking)
    runBootDiagnostic().then(report => { bootReport = report; }).catch(console.error);

    // ── Scrap Pipeline Boot & Catch-Up Hook ──
    const { getPipelineState, updatePipelineState, startReviewTimer, produceScrapEpisode } = require('./scrap_pipeline');
    
    // Force YouTube pipeline OFF by default on server restart
    updatePipelineState({ youtube_pipeline_enabled: false });

    setTimeout(() => {
        try {
            const state = getPipelineState();
            const todayStr = new Date().toISOString().split('T')[0];
            
            // Define a broadcast helper to reach any connected clients (if UI connects quickly)
            const broadcastWS = {
                send: (data) => {
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) c.send(data);
                    });
                }
            };

            if (state.pending_review) {
                console.log('[Scheduler] Pending Scrap review detected on boot. Resuming timer...');
                startReviewTimer(broadcastWS);
            } else if (scrapConfig.isEnabled && scrapConfig.mode === 'auto' && state.youtube_pipeline_enabled && state.last_run_date !== todayStr) {
                console.log('[Scheduler] Missing Scrap episode detected for today. Initializing autonomous catch-up production.');
                broadcastWS.send(JSON.stringify({ type: 'agent_log', text: '[Scheduler] Missing Scrap episode detected for today. Initializing autonomous catch-up production.' }));
                // Start asynchronously without blocking server
                produceScrapEpisode(state.current_episode_index, "Autonomous Catch-up Episode", broadcastWS, false).catch(e => console.error(e));
            }
        } catch (err) {
            console.error('[Scrap Boot Hook Error]', err);
        }
    }, 5000); // Wait 5 seconds after boot to give UI time to connect

    // Initialize WhatsApp client on startup (non-blocking)
    initWhatsApp().catch(err => console.warn('[WhatsApp] Init skipped:', err.message));

    // ── CLOUD-FIRST HEARTBEAT ENGINE ──
    const axios = require('axios');
    const CLOUD_URL = process.env.CLOUD_WORKER_URL || 'https://jarvis-cloud-worker-ynyr.onrender.com';
    const CLOUD_SECRET = process.env.CLOUD_WORKER_SECRET || 'Jarviscloudnaveen2003';

    // 1. Heartbeat Loop (Every 2 minutes, pauses if cloud is down)
    let cloudConsecutiveErrors = 0;
    setInterval(async () => {
        if (cloudConsecutiveErrors >= 5) {
            // If cloud is failing repeatedly, reduce frequency to every 5 minutes to conserve bandwidth
            if (Date.now() % 300000 > 60000) return;
        }
        try {
            await axios.post(`${CLOUD_URL}/api/heartbeat`, {}, {
                headers: { 'x-jarvis-secret': CLOUD_SECRET },
                timeout: 5000
            });
            cloudConsecutiveErrors = 0;
        } catch (err) {
            cloudConsecutiveErrors++;
            if (cloudConsecutiveErrors <= 2) {
                console.warn('[Heartbeat] Failed to pulse cloud:', err.message);
            }
        }
    }, 120000);

    // 2. Audio Polling Loop (Every 30s instead of 10s to save 66% bandwidth, with backoff)
    setInterval(async () => {
        if (cloudConsecutiveErrors >= 5) return; // Skip polling if cloud is suspended
        try {
            const res = await axios.get(`${CLOUD_URL}/api/local-reminders`, {
                headers: { 'x-jarvis-secret': CLOUD_SECRET },
                timeout: 5000
            });
            const reminders = res.data.reminders || [];
            
            for (const r of reminders) {
                console.log(`[Cloud Delegated Reminder] Firing: ${r.message}`);
                
                const notifier = require('node-notifier');
                notifier.notify({
                    title: 'Jarvis Reminder',
                    message: r.message,
                    sound: true,
                    wait: false
                });

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'play_chime' }));
                        client.send(JSON.stringify({ type: 'reminder', message: r.message }));
                        streamTTS(r.message, client,
                            (audioBase64, format) => client.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                            () => {},
                            (err) => console.error('[Reminder TTS Error]', err)
                        );
                    }
                });
            }
        } catch (err) {
            // Silently fail if cloud is unreachable
        }
    }, 10000);
});

