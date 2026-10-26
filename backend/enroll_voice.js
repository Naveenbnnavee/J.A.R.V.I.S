/**
 * enroll_voice.js — Jarvis Voice Biometric Enrollment
 * 
 * USAGE OPTIONS:
 *   Option A — Record live from microphone (requires SoX):
 *     node enroll_voice.js
 *
 *   Option B — Use a pre-recorded WAV file (easiest on Windows!):
 *     node enroll_voice.js --file "C:\path\to\recording.wav"
 *
 * HOW TO CREATE A RECORDING ON WINDOWS (without SoX):
 *   1. Open "Voice Recorder" from the Start Menu
 *   2. Record yourself speaking for at least 30 seconds
 *   3. Right-click the recording → "Open file location"
 *   4. The .m4a file is in %USERPROFILE%\Documents\Sound recordings\
 *   5. Convert to WAV with: ffmpeg -i recording.m4a recording.wav
 *      OR use an online converter (e.g. cloudconvert.com)
 *   6. Run: node enroll_voice.js --file "path\to\recording.wav"
 */

require('dotenv').config();
const { SpeakerEmbeddingExtractor, readWave } = require('sherpa-onnx-node');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_DIR = path.join(__dirname, 'config');
const PROFILE_PATH = path.join(CONFIG_DIR, 'voice_profile.json');
const MODEL_DIR = path.join(CONFIG_DIR, 'speaker_model');
const MODEL_PATH = path.join(MODEL_DIR, 'model.onnx');

const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-reco-models/3d-speaker-speech_eres2netv2_sv_zh-cn_3dspeaker_16k.onnx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function downloadFile(url, dest) {
    const { pipeline } = require('stream/promises');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
    
    const contentLength = response.headers.get('content-length');
    let downloaded = 0;
    
    // Read stream to monitor progress
    const reader = response.body.getReader();
    const chunks = [];
    
    while(true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        if (contentLength) {
            const pct = ((downloaded / parseInt(contentLength)) * 100).toFixed(1);
            process.stdout.write(`\r[Enroll] Downloading... ${pct}%`);
        } else {
            process.stdout.write(`\r[Enroll] Downloading... ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
        }
    }
    console.log('');
    
    // Combine chunks and write
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(dest, buffer);
}

/** Record from microphone using SoX */
async function recordFromMic(outputPath, durationSeconds = 15) {
    const { spawn } = require('child_process');
    
    // Find SoX executable
    let soxPath = 'sox';
    const possiblePaths = [
        'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe',
        'C:\\Program Files\\sox-14-4-2\\sox.exe',
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            soxPath = p;
            break;
        }
    }

    return new Promise((resolve, reject) => {
        console.log(`[Enroll] Recording ${durationSeconds}s from microphone...`);
        console.log('[Enroll] Please speak naturally — read anything aloud.\n');

        const args = [
            '-t', 'waveaudio', 'default', '-q', '-c', '1', '-r', '16000', '-b', '16', '-e', 'signed-integer', '-t', 'wav',
            outputPath, 'trim', '0', durationSeconds.toString()
        ];

        const soxProcess = spawn(soxPath, args);

        let remaining = durationSeconds;
        process.stdout.write(`\r[Enroll] Recording... ${remaining}s remaining   `);
        const timer = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                process.stdout.write(`\r[Enroll] Recording... ${remaining}s remaining   `);
            } else {
                process.stdout.write(`\r[Enroll] Recording complete.               \n`);
                clearInterval(timer);
            }
        }, 1000);

        soxProcess.on('error', (err) => {
            clearInterval(timer);
            reject(err);
        });

        soxProcess.on('close', (code) => {
            clearInterval(timer);
            if (code === 0) {
                setTimeout(resolve, 500);
            } else {
                reject(new Error(`SoX exited with code ${code}`));
            }
        });
    });
}

/** Extract embedding from a WAV file */
function extractEmbedding(wavPath) {
    if (!fs.existsSync(wavPath)) throw new Error(`WAV file not found: ${wavPath}`);
    
    const extractor = new SpeakerEmbeddingExtractor({
        model: MODEL_PATH,
        numThreads: 2,
        debug: false,
    });

    console.log('[Enroll] Reading WAV file...');
    const wave = readWave(wavPath);
    console.log(`[Enroll] Audio duration: ${(wave.samples.length / wave.sampleRate).toFixed(1)}s at ${wave.sampleRate}Hz`);
    
    if (wave.samples.length < wave.sampleRate * 3) {
        throw new Error('Recording too short! Please provide at least 5 seconds of speech.');
    }

    console.log('[Enroll] Extracting speaker embedding...');
    const stream = extractor.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    return extractor.compute(stream);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // Parse --file argument
    const fileArgIdx = process.argv.indexOf('--file');
    const providedFile = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;

    // Create dirs
    [CONFIG_DIR, MODEL_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

    // Download model if missing
    if (!fs.existsSync(MODEL_PATH)) {
        console.log('[Enroll] Downloading speaker embedding model...');
        await downloadFile(MODEL_URL, MODEL_PATH);
        console.log('[Enroll] Model downloaded successfully.');
    } else {
        console.log('[Enroll] Speaker model already present.');
    }

    let wavPath;

    if (providedFile) {
        // ── Option B: use pre-recorded file ──────────────────────────────────
        wavPath = path.resolve(providedFile);
        console.log(`[Enroll] Using provided file: ${wavPath}`);
    } else {
        // ── Option A: record live from mic ────────────────────────────────────
        console.log('\n[Enroll] =====================================================');
        console.log('[Enroll]  LIVE MICROPHONE ENROLLMENT');
        console.log('[Enroll]  Requires SoX (https://sox.sourceforge.net)');
        console.log('[Enroll] =====================================================\n');
        console.log('[Enroll] TIP: If this fails, use the --file option instead.');
        console.log('[Enroll]      See instructions at the top of this file.\n');

        const tmpWav = path.join(CONFIG_DIR, '_enroll_tmp.wav');
        try {
            await recordFromMic(tmpWav, 15);
            wavPath = tmpWav;
        } catch (recErr) {
            console.error('\n[Enroll] ✗ Microphone recording failed:', recErr.message);
            console.error('\n[Enroll] ──────────────────────────────────────────────');
            console.error('[Enroll]  OPTION B: Use Windows Voice Recorder instead!');
            console.error('[Enroll]  1. Press Win+S → search "Voice Recorder"');
            console.error('[Enroll]  2. Record yourself speaking for 30+ seconds');
            console.error('[Enroll]  3. Save and convert to WAV');
            console.error('[Enroll]  4. Run: node enroll_voice.js --file "path\\to\\file.wav"');
            console.error('[Enroll] ──────────────────────────────────────────────');
            process.exit(1);
        }
    }

    // Extract and save embedding
    const embedding = extractEmbedding(wavPath);

    // Clean up temp file if we recorded it
    if (!providedFile && fs.existsSync(path.join(CONFIG_DIR, '_enroll_tmp.wav'))) {
        fs.unlinkSync(path.join(CONFIG_DIR, '_enroll_tmp.wav'));
    }

    const profile = {
        version: 1,
        model: 'eres2netv2',
        created: new Date().toISOString(),
        dim: embedding.length,
        embedding: Array.from(embedding)
    };
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));

    console.log('\n[Enroll] ✓ ================================================');
    console.log(`[Enroll] ✓ Voice profile saved → ${PROFILE_PATH}`);
    console.log(`[Enroll] ✓ Embedding size: ${embedding.length} dimensions`);
    console.log('[Enroll] ✓ Restart node server.js to activate the security gate!');
    console.log('[Enroll] ================================================\n');
}

main().catch(err => {
    console.error('[Enroll] Fatal error:', err.message);
    process.exit(1);
});
