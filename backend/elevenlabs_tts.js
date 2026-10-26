const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const say = require('say');

class ElevenLabsKeyRotator {
    constructor() {
        this.keys = [
            process.env.ELEVENLABS_API_KEY_1,
            process.env.ELEVENLABS_API_KEY_2,
            process.env.ELEVENLABS_API_KEY_3,
            process.env.ELEVENLABS_API_KEY
        ].filter(Boolean);
        this.currentIndex = 0;
    }

    getCurrentKey() {
        if (this.keys.length === 0) return null;
        return this.keys[this.currentIndex];
    }

    rotateKey() {
        this.currentIndex++;
        if (this.currentIndex >= this.keys.length) {
            console.error('[ElevenLabs] All API keys exhausted (Quota Limit).');
            return false;
        }
        console.log(`[ElevenLabs] Switched to API Key #${this.currentIndex + 1}`);
        return true;
    }
}

const keyRotator = new ElevenLabsKeyRotator();

function generateFallbackAudio(text, ws, onAudioChunk, onComplete, onError, signal = null) {
    if (signal && signal.aborted) return;
    console.log('[Fallback] Using edge-tts for TTS generation.');
    const timestamp = Date.now();
    const tempFile = path.join(os.tmpdir(), `fallback_${timestamp}.mp3`);
    const tempTextFile = path.join(os.tmpdir(), `fallback_text_${timestamp}.txt`);
    
    fs.writeFileSync(tempTextFile, text, 'utf-8');
    
    // Using Python's edge-tts
    exec(`edge-tts -f "${tempTextFile}" --write-media "${tempFile}"`, (error, stdout, stderr) => {
        if (signal && signal.aborted) {
            if (fs.existsSync(tempTextFile)) fs.unlinkSync(tempTextFile);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            return;
        }
        if (error) {
            console.warn('[Edge-TTS Failed] Network might be completely offline. Falling back to native OS synthesis (Level 3 Survival Mode).');
            if (fs.existsSync(tempTextFile)) fs.unlinkSync(tempTextFile);
            
            // Level 3 Fallback: Native OS Synthesis
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'tts_start' }));
            }
            
            // We use 'Microsoft Mark' (Male voice suitable for Jarvis) if available, otherwise it falls back to the default system voice.
            say.speak(text, 'Microsoft Mark', 1.0, (sayErr) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'tts_end' }));
                }
                if (sayErr) {
                    console.error('[Native TTS Error]', sayErr);
                    if (onError) onError(new Error('Native OS TTS Fallback Failed'));
                } else {
                    if (onComplete) onComplete();
                }
            });
            return;
        }
        
        try {
            const buffer = fs.readFileSync(tempFile);
            onAudioChunk(buffer.toString('base64'), 'mp3');
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); // Cleanup
            if (fs.existsSync(tempTextFile)) fs.unlinkSync(tempTextFile);
            if (onComplete) onComplete();
        } catch (readErr) {
            if (fs.existsSync(tempTextFile)) fs.unlinkSync(tempTextFile);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (onError) onError(readErr);
        }
    });
}

async function streamTTS(text, ws, onAudioChunk, onComplete, onError, signal = null) {
    // TTS Code Filter: Strip raw markdown code blocks to prevent Jarvis from reading syntax aloud
    text = text.replace(/```[\s\S]*?```/g, " [I have generated the code in the console] ");

    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    const apiKey = keyRotator.getCurrentKey();
    const model = 'eleven_turbo_v2_5'; 

    if (!apiKey) {
        console.warn("[ElevenLabs] No API key found. Falling back immediately.");
        return generateFallbackAudio(text, ws, onAudioChunk, onComplete, onError, signal);
    }

    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=pcm_16000`;
    const elevenWs = new WebSocket(wsUrl);

    let abortHandler = null;
    if (signal) {
        if (signal.aborted) return;
        abortHandler = () => {
            console.log('[ElevenLabs TTS] Aborted by user.');
            elevenWs.terminate();
            if (onError) onError(new Error('AbortError'));
        };
        signal.addEventListener('abort', abortHandler);
    }

    elevenWs.on('open', () => {
        elevenWs.send(JSON.stringify({
            text: " ",
            voice_settings: { stability: 0.5, similarity_boost: 0.8 },
            xi_api_key: apiKey
        }));

        elevenWs.send(JSON.stringify({
            text: text + " ",
            try_trigger_generation: true
        }));
        
        elevenWs.send(JSON.stringify({ text: "" }));
    });

    elevenWs.on('message', (data) => {
        const response = JSON.parse(data);
        
        if (response.error) {
            if (response.error.includes('quota') || response.error.includes('402') || response.error.includes('429')) {
                console.warn('[ElevenLabs] Quota exceeded on current key.');
                elevenWs.close();
                if (keyRotator.rotateKey()) {
                    streamTTS(text, ws, onAudioChunk, onComplete, onError, signal);
                } else {
                    generateFallbackAudio(text, ws, onAudioChunk, onComplete, onError, signal);
                }
                return;
            }
        }
        
        if (response.audio) {
            // Forward base64 PCM chunk directly to frontend for instant playback
            onAudioChunk(response.audio, 'pcm_16000');
        }
        if (response.isFinal) {
            elevenWs.close();
        }
    });

    elevenWs.on('close', () => {
        if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
        }
        if (signal && signal.aborted) return;
        if (onComplete) onComplete();
    });

    elevenWs.on('error', (err) => {
        if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
        }
        if (signal && signal.aborted) return;
        console.error("[ElevenLabs TTS] WS Error:", err.message);
        if (err.message.includes('402') || err.message.includes('429')) {
            if (keyRotator.rotateKey()) {
                streamTTS(text, ws, onAudioChunk, onComplete, onError, signal);
            } else {
                generateFallbackAudio(text, ws, onAudioChunk, onComplete, onError, signal);
            }
        } else {
            console.warn('[ElevenLabs] Network/Connection error. Falling back...');
            generateFallbackAudio(text, ws, onAudioChunk, onComplete, onError, signal);
        }
    });
}

module.exports = { streamTTS };
