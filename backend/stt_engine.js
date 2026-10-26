const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function transcribeAudio(audioBuffer) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is missing for Whisper STT");
    }

    // Ignore tiny audio chunks (noise/misfires) which crash the API
    if (!audioBuffer || audioBuffer.length < 10000) {
        console.log(`[STT Engine] Ignored tiny audio chunk (${audioBuffer?.length} bytes).`);
        return "";
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const isGroq = apiKey.startsWith('gsk_');
    const model = process.env.STT_MODEL || (isGroq ? 'whisper-large-v3' : 'whisper-1');

    const formData = new FormData();
    // Pass the buffer directly to prevent form-data stream length calculation bugs (which caused 400 Bad Request)
    formData.append('file', audioBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', model);
    formData.append('temperature', '0.0');
    formData.append('prompt', 'Jarvis, hey Jarvis. Yes Sir. How can I help you today? Namaskara, oota aitha? Macha, open YouTube. Kannada song play madi. This context includes Kanglish and Kannada terms.');

    try {
        const defaultBase = isGroq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
        const baseUrl = process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL !== 'https://api.openai.com/v1' 
            ? process.env.OPENAI_BASE_URL 
            : defaultBase;
            
        const response = await axios.post(`${baseUrl}/audio/transcriptions`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${apiKey}`
            }
        });
        
        let text = response.data.text.trim();
        const lower = text.toLowerCase();
        
        // Filter out infamous Whisper silence hallucinations
        const hallucinations = [
            'thank you.',
            'thank you',
            'thank you!',
            'thank you for watching!',
            'thank you for watching.',
            'thanks for watching!',
            'thanks for watching.',
            'subscribe.',
            'subscribe',
            'продолжение следует...',
            '.',
            '..'
        ];

        if (hallucinations.includes(lower) || lower.length <= 1) {
            return "";
        }

        return text;
    } catch (error) {
        console.error("[STT Engine] Error during transcription:", error?.response?.data || error.message);
        throw error;
    }
}

module.exports = { transcribeAudio };
