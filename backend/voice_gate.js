/**
 * voice_gate.js — Jarvis Local Speaker Recognition Middleware
 * Uses sherpa-onnx (100% free, runs fully offline).
 * 
 * If no voice profile exists yet → gate is OPEN (fail-safe, no lockouts).
 * After enrollment, every audio chunk is scored. Score < threshold → block.
 */

require('dotenv').config();
const { SpeakerEmbeddingExtractor, SpeakerEmbeddingManager, readWave } = require('sherpa-onnx-node');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROFILE_PATH = path.join(__dirname, 'config', 'voice_profile.json');
const MODEL_PATH   = path.join(__dirname, 'config', 'speaker_model', 'model.onnx');
const THRESHOLD    = parseFloat(process.env.VOICE_CONFIDENCE_THRESHOLD || '0.65');

let extractor = null;
let manager   = null;
let ready     = false;

function isEnrolled() {
    return fs.existsSync(PROFILE_PATH);
}

function init() {
    if (ready) return;

    if (!isEnrolled()) {
        console.log('[VoiceGate] No voice profile found. Run: node enroll_voice.js');
        console.log('[VoiceGate] Gate is OPEN until enrollment is complete.');
        return;
    }

    if (!fs.existsSync(MODEL_PATH)) {
        console.warn('[VoiceGate] Model file missing. Run enroll_voice.js first to download it.');
        return;
    }

    try {
        extractor = new SpeakerEmbeddingExtractor({
            model: MODEL_PATH,
            numThreads: 2,
            debug: false,
        });

        manager = new SpeakerEmbeddingManager(extractor.dim);

        // Load the saved profile into the manager
        const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
        const embedding = new Float32Array(profile.embedding);
        manager.add({ name: 'owner', v: embedding });

        ready = true;
        console.log(`[VoiceGate] ✓ Speaker gate active. Threshold: ${THRESHOLD}`);
    } catch (e) {
        console.error('[VoiceGate] Init failed:', e.stack);
    }
}

// Initialize on module load
init();

/**
 * Verify an audio buffer against the enrolled speaker profile.
 * Audio should be raw PCM, 16-bit signed, 16kHz mono (what the mic sends).
 * @param {Buffer} audioBuffer
 * @returns {{ authorized: boolean, score: number }}
 */
async function verifyVoice(audioBuffer) {
    // Fail-open: no profile enrolled or model not ready
    if (!ready || !extractor || !manager) {
        return { authorized: true, score: 1.0 };
    }

    try {
        // Write to temp file and use sherpa's readWave to guarantee correct sample rate and PCM parsing
        const tmpPath = path.join(os.tmpdir(), `verify_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);
        fs.writeFileSync(tmpPath, audioBuffer);
        const wave = readWave(tmpPath);
        fs.unlinkSync(tmpPath);

        const float32 = wave.samples;

        // Need at least 0.5s of audio (8000 samples at 16kHz)
        if (float32.length < 8000) {
            return { authorized: true, score: 1.0 };
        }

        const stream = extractor.createStream();
        stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: float32 });
        // Inform the extractor that no more audio is coming for this command
        if (typeof stream.inputFinished === 'function') stream.inputFinished();
        
        const embedding = extractor.compute(stream);

        // Manual Cosine Similarity to get the exact score
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
        const enrolledV = new Float32Array(profile.embedding);
        for (let i = 0; i < embedding.length; i++) {
            dotProduct += embedding[i] * enrolledV[i];
            normA += embedding[i] * embedding[i];
            normB += enrolledV[i] * enrolledV[i];
        }
        const exactScore = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

        // Compare against enrolled owner using verify()
        const authorized = manager.verify({ name: 'owner', v: embedding, threshold: THRESHOLD });

        console.log(`[VoiceGate] Verification | Exact Score: ${exactScore.toFixed(3)} | Threshold: ${THRESHOLD} | ${authorized ? '✓ PASS' : '✗ BLOCK'}`);
        return { authorized, score: exactScore };
    } catch (e) {
        console.error('[VoiceGate] Error during verification:', e.message);
        return { authorized: true, score: 1.0 }; // Fail-open on error
    }
}

module.exports = { verifyVoice, isEnrolled };
