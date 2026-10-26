const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const { callGroqLLM, callOpenRouter, callGemini } = require('./llm_router'); // Reuse existing LLM
const { runDriveBridge } = require('./gdrive_bridge');
const { uploadToYouTube } = require('./youtube_scheduler');
const sharp = require('sharp');
sharp.concurrency(1);
const BASE_DIR = 'D:\\youtube\\episodes';
const ASSETS_DIR = 'D:\\youtube\\assets';
const STATE_FILE = path.join(__dirname, 'pipeline_state.json');
const BGM_PATH = path.join(ASSETS_DIR, 'bgm.mp3');

// ─── GPU Hardware Detection ───────────────────────────────────────────────────
let GLOBAL_VIDEO_ENCODER = 'libx264 -preset fast';
try {
    const ffmpegPath = require('ffmpeg-static');
    const output = execSync(`"${ffmpegPath}" -encoders`, { encoding: 'utf8' });
    if (output.includes('h264_nvenc')) {
        GLOBAL_VIDEO_ENCODER = 'h264_nvenc -preset p4 -cq 21';
        console.log('[Boot Diagnostic] NVIDIA GPU detected. Hardware encoding (NVENC) ENABLED for blazingly fast video rendering.');
    }
} catch (e) {
    console.log('[Boot Diagnostic] No NVIDIA GPU detected. Falling back to CPU encoding.');
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── CC0 BGM Downloader ───────────────────────────────────────────────────────
// Curated CC0 / royalty-free kids instrumental loop URLs (tried in order)
const BGM_URLS = [
    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',
    'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3',
];

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        const req = proto.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                fs.unlinkSync(destPath);
                return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        });
        req.on('error', (err) => {
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

async function downloadBGMIfNeeded(log) {
    const MIN_SIZE = 10 * 1024; // 10 KB — anything less is a stub
    if (fs.existsSync(BGM_PATH) && fs.statSync(BGM_PATH).size > MIN_SIZE) {
        log(`BGM already present (${Math.round(fs.statSync(BGM_PATH).size / 1024)} KB). Skipping download.`);
        return;
    }
    log(`BGM missing or stub. Downloading CC0 kids instrumental loop...`);
    for (const url of BGM_URLS) {
        try {
            log(`  Trying: ${url}`);
            await downloadFile(url, BGM_PATH);
            const size = fs.statSync(BGM_PATH).size;
            if (size > MIN_SIZE) {
                log(`  ✓ BGM downloaded (${Math.round(size / 1024)} KB): ${BGM_PATH}`);
                return;
            }
            log(`  ✗ Downloaded file too small (${size} bytes). Trying next URL...`);
            fs.unlinkSync(BGM_PATH);
        } catch (e) {
            log(`  ✗ Failed: ${e.message}. Trying next URL...`);
        }
    }
    log(`[WARNING] Could not download BGM from any source. Video will have no background music.`);
}

// ─── Character System — Scrap & Spark ────────────────────────────────────────
const CHAR_DESCRIPTIONS = {
    scrap: 'a tiny 3-inch-tall robot crafted from antique copper and pocket-watch gears, with expressive glowing amber glass lens eyes, wire-spring fingers, and a small hinged chest plate that opens',
    spark: 'a miniature mechanical bee made from yellow brass with translucent mica wings, thin copper antennae, and tiny gear-work abdomen that spins when thinking'
};

const POSE_SPECS = [
    { name: 'stand', desc: 'standing upright, servos relaxed, sensor eyes forward, calm and alert' },
    { name: 'inspect', desc: 'leaning forward with magnifying lens extended, one foot raised, studying something closely' },
    { name: 'build', desc: 'hands outstretched manipulating tiny objects, gear-eyes wide with concentration' },
    { name: 'celebrate', desc: 'both arms raised in V-shape, spinning gear abdomen at full speed, lens-eyes gleaming gold' },
    { name: 'think', desc: 'one copper finger on chin, antennae drooping thoughtfully, amber eyes pulsing slowly' },
    { name: 'struggle', desc: 'straining against a large object, feet braced, gear joints visibly stressed' },
    { name: 'hover', desc: 'mica wings fully extended and blurred with motion, hovering slightly off ground' },
    { name: 'cheer', desc: 'hopping on both feet, wings fluttering rapidly, eyes bright and warm amber' },
];

async function generateSpriteImage(charName, pose, outPath, log) {
    const charDesc = CHAR_DESCRIPTIONS[charName] || charName;
    const prompt = `${charDesc}, children's educational TV show character, ${pose.desc}, full body visible from head to toe, completely isolated on solid bright lime green background (#00FF00), Pixar/DreamWorks 3D cartoon quality, soft studio lighting, no shadows on background, no text, no watermark, high resolution`;

    // Try Imagen 3 first (Gemini Pro quality)
    try {
        // Load Gemini key — try process.env first, then read .env file directly
        let geminiKey = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2;
        if (!geminiKey) {
            // Read directly from .env file (for standalone script runs)
            const envPath = path.join(__dirname, '.env');
            if (fs.existsSync(envPath)) {
                const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
                for (const line of envLines) {
                    const m = line.match(/^GEMINI_API_KEY_\d+\s*=\s*"?([^"\n]+)"?/);
                    if (m && m[1]) { geminiKey = m[1].trim(); break; }
                }
            }
        }
        if (!geminiKey) throw new Error('No Gemini API key found');

        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-002',
            prompt,
            config: { numberOfImages: 1, aspectRatio: '3:4', outputMimeType: 'image/png' }
        });
        const imgBytes = response.generatedImages[0].image.imageBytes;
        fs.writeFileSync(outPath, Buffer.from(imgBytes, 'base64'));
        log(`    ✓ [Imagen 3] ${charName}/${pose.name}`);
        return true;
    } catch (imgErr) {
        log(`    ↓ Imagen 3 failed (${imgErr.message}), using Pollinations fallback...`);
    }


    // Fallback: Pollinations AI (free, no key needed)
    try {
        const seedVal = Array.from(charName + pose.name).reduce((a, c) => a + c.charCodeAt(0), 0);
        const encodedPrompt = encodeURIComponent(prompt);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=768&nologo=true&seed=${seedVal}&model=flux`;
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
        log(`    ✓ [Pollinations] ${charName}/${pose.name}`);
        return true;
    } catch (polErr) {
        log(`    ✗ Both generators failed for ${charName}/${pose.name}: ${polErr.message}`);
        return false;
    }
}

async function generateSceneVideo(scene, outPath, log) {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100000) {
        log(`    ⟳ Veo clip for scene ${scene.scene_number} already exists, skipping...`);
        return true;
    }

    const { GoogleGenAI } = require('@google/genai');

    // Build list of keys
    const keys = [];
    for (let i = 1; i <= 6; i++) {
        const k = process.env[`GEMINI_API_KEY_${i}`];
        if (k) keys.push(k);
    }

    // Read from .env file directly if process.env is empty (for standalone script)
    if (keys.length === 0) {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
            for (const line of envLines) {
                const m = line.match(/^GEMINI_API_KEY_\d+\s*=\s*"?([^"\n]+)"?/);
                if (m && m[1]) keys.push(m[1].trim());
            }
        }
    }

    if (keys.length === 0) throw new Error('No Gemini API keys found for Veo generation.');

    const prompt = `A 3D animated scene for a children's educational show. ${scene.visual_prompt}. The characters present are: ${(scene.characters_present || []).join(', ')}. Animation cue: ${scene.animation_cue || 'standing'}. Mood: ${scene.mood || 'happy'}. Pixar/DreamWorks style, high quality, colorful, soft lighting.`;

    // Round robin retry
    let lastError = null;
    for (let i = 0; i < keys.length; i++) {
        try {
            log(`    ► Calling Veo 3.1 for scene ${scene.scene_number} (Key ${i + 1}/${keys.length})...`);
            const ai = new GoogleGenAI({ apiKey: keys[i] });
            const response = await ai.models.generateVideos({
                model: 'veo-3.1-generate-preview',
                prompt: prompt,
            });

            if (response.generatedVideos && response.generatedVideos.length > 0 && response.generatedVideos[0].video?.videoBytes) {
                fs.writeFileSync(outPath, Buffer.from(response.generatedVideos[0].video.videoBytes, 'base64'));
                log(`    ✓ [Veo 3.1] Scene ${scene.scene_number} generated successfully.`);
                return true;
            } else {
                throw new Error("API returned success but no video bytes.");
            }
        } catch (err) {
            lastError = err;
            const errStr = typeof err === 'string' ? err : (err.message ? err.message : JSON.stringify(err));
            if (errStr.includes('429') || errStr.includes('403') || errStr.includes('PERMISSION_DENIED') || errStr.includes('quota')) {
                log(`    ⚠ Key ${i + 1} failed (Quota/Permission). Trying next key...`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            } else {
                // Not a quota/permission error, fail fast
                throw err;
            }
        }
    }

    // If we exhausted all keys, fallback to Free Image + Ken Burns Video generation
    log(`    ⚠ Veo 3.1 quotas exhausted on all ${keys.length} keys.`);
    log(`    ► Falling back to Free Image Generation (Pollinations) + Cinematic Pan Video...`);
    
    try {
        const seedVal = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(prompt);
        const imgUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true&seed=${seedVal}&model=flux`;
        
        const tempImgPath = outPath.replace('.mp4', '_temp.jpg');
        const res = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        fs.writeFileSync(tempImgPath, Buffer.from(await res.arrayBuffer()));
        log(`    ✓ Image generated successfully. Converting to video with cinematic pan...`);

        // Use FFmpeg to create a 5-second video with a slow zoom and pan effect (Ken Burns)
        const { exec } = require('child_process');
        const ffmpegPath = require('ffmpeg-static');
        const cmd = `"${ffmpegPath}" -y -loop 1 -i "${tempImgPath}" -t 5 -vf "zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" -c:v libx264 -pix_fmt yuv420p "${outPath}"`;
        
        await new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error('[FFmpeg Error]', stderr);
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        
        if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
        
        log(`    ✓ Cinematic Fallback Video generated successfully!`);
        return true;
    } catch (fallbackErr) {
        throw new Error(`Veo 3.1 Quota Exhausted, AND Free Fallback failed: ${fallbackErr.message}`);
    }
}

async function generateCharacterSprites(assetsDir, log, forceNew = false) {
    log(`Generating character sprite sheets via Imagen 3...`);
    const spritesRoot = path.join(assetsDir, 'characters', 'sprites');

    for (const charName of Object.keys(CHAR_DESCRIPTIONS)) {
        const charDir = path.join(spritesRoot, charName);
        fs.mkdirSync(charDir, { recursive: true });

        for (const pose of POSE_SPECS) {
            const outPath = path.join(charDir, `${pose.name}.png`);
            if (!forceNew && fs.existsSync(outPath) && fs.statSync(outPath).size > 8000) {
                log(`    ⟳ ${charName}/${pose.name} already exists`);
                continue;
            }
            const ok = await generateSpriteImage(charName, pose, outPath, log);
            if (ok) {
                // Apply background removal using existing rmbg pipeline
                try {
                    const { processCharacterCutouts } = (() => {
                        // Reuse existing bg removal: just call with the sprite dir
                        return { processCharacterCutouts: null };
                    })();
                    // Quick green-screen removal using sharp's chroma key
                    const sharp_ = require('sharp');
                    const { data, info } = await sharp_(outPath)
                        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                    const { width, height, channels } = info;
                    for (let i = 0; i < data.length; i += channels) {
                        const r = data[i], g = data[i + 1], b = data[i + 2];
                        if (g > 100 && g > r * 1.4 && g > b * 1.4) {
                            data[i + 3] = 0; // transparent
                        }
                    }
                    await sharp_(Buffer.from(data), { raw: { width, height, channels } })
                        .png().toFile(outPath);
                } catch (bgErr) {
                    log(`    ⚠ BG removal failed for ${charName}/${pose.name}: ${bgErr.message}`);
                }
                await new Promise(r => setTimeout(r, 1500)); // rate limit
            }
        }
    }
}

function buildSpriteManifest(assetsDir) {
    const manifest = {};
    const spritesRoot = path.join(assetsDir, 'characters', 'sprites');
    for (const charName of Object.keys(CHAR_DESCRIPTIONS)) {
        manifest[charName] = {};
        for (const pose of POSE_SPECS) {
            const p = path.join(spritesRoot, charName, `${pose.name}.png`);
            manifest[charName][pose.name] = fs.existsSync(p) && fs.statSync(p).size > 8000;
        }
    }
    return manifest;
}

function getPipelineState() {
    if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
    return {
        last_run_date: null,
        current_episode_index: 1,
        pending_review: false,
        pending_episode_path: null,
        review_started_at: null,
        current_title: null,
        youtube_pipeline_enabled: false
    };
}

function updatePipelineState(partial) {
    const state = getPipelineState();
    Object.assign(state, partial);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function removeWhiteBackground(inputPath, outputPath, log) {
    const sharp = require('sharp');
    try {
        const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let i = 0; i < data.length; i += 4) {
            // White or near-white threshold
            if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) {
                data[i + 3] = 0;
            }
        }
        await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outputPath);
        return true;
    } catch (e) {
        if (log) log(`✗ Failed to remove background: ${e.message}`);
        return false;
    }
}

function loadWorldLore() {
    const lorePath = path.join(ASSETS_DIR, 'world_lore.json');
    if (!fs.existsSync(lorePath)) return { characters: [], backgrounds: [] };
    return JSON.parse(fs.readFileSync(lorePath, 'utf8'));
}

function appendWorldLore(newAssets) {
    const lorePath = path.join(ASSETS_DIR, 'world_lore.json');
    let lore = loadWorldLore();
    if (newAssets.characters) {
        newAssets.characters.forEach(c => {
            if (!lore.characters.find(lc => lc.name.toLowerCase() === c.name.toLowerCase())) lore.characters.push(c);
        });
    }
    if (newAssets.backgrounds) {
        newAssets.backgrounds.forEach(b => {
            if (!lore.backgrounds.find(lb => lb.name.toLowerCase() === b.name.toLowerCase())) lore.backgrounds.push(b);
        });
    }
    fs.writeFileSync(lorePath, JSON.stringify(lore, null, 2));
}

function getAvailableAssets() {
    const getNames = (dir) => {
        const fullDir = path.join(ASSETS_DIR, dir);
        if (!fs.existsSync(fullDir)) return [];
        return fs.readdirSync(fullDir).map(f => path.basename(f, path.extname(f)));
    };
    return {
        characters: getNames('characters'),
        backgrounds: getNames('backgrounds')
    };
}

let reviewTimer = null;

async function produceScrapEpisode(episodeNumber, title, ws, forceNew = false, mode = 'auto') {
    let isAutonomous = !ws; // If no websocket is provided, assume it's the background autonomous cron job.

    const log = (msg) => {
        console.log(`[Scrap Pipeline] ${msg}`);
        if (ws) {
            ws.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Pipeline] ${msg}` }));
            ws.send(JSON.stringify({ type: 'pipeline_log', text: msg }));
        }
    };
    const setStatus = (status) => {
        if (ws) ws.send(JSON.stringify({ type: 'pipeline_status', status }));
    };

    if (ws) ws.send(JSON.stringify({ type: 'node_status', nodeId: 'developer', status: 'active' }));

    setStatus('Scripting');
    log(`Starting production for Episode ${episodeNumber}: ${title}${forceNew ? ' (FORCED NEW)' : ''}`);

    // 1. Scaffolding
    const epDirName = `EP${episodeNumber.toString().padStart(2, '0')}_${title.replace(/\s+/g, '')}`;
    const epPath = path.join(BASE_DIR, epDirName);

    const dirs = ['01_script', '02_audio', '03_frames', '04_clips', '03_raw_clips', '05_final'];
    dirs.forEach(d => fs.mkdirSync(path.join(epPath, d), { recursive: true }));
    log(`Scaffolding created at ${epPath}`);

    // 2. Script Generation
    const scriptPath = path.join(epPath, '01_script', 'script.json');
    let scriptJson;

    if (!forceNew && fs.existsSync(scriptPath)) {
        log(`Existing script found. Resuming from saved state...`);
        try {
            scriptJson = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
            if (Array.isArray(scriptJson)) {
                scriptJson = { scenes: scriptJson };
            }
        } catch (e) {
            log(`Failed to read existing script: ${e.message}. Generating new...`);
            scriptJson = null;
        }
    }

    if (!scriptJson) {
        log(`Generating new script via LLM...`);
        const worldLore = loadWorldLore();
        let additionalChars = worldLore.characters.map(c => `- ${c.name}: ${c.visual_description}`).join('\n');
        let additionalBgs = worldLore.backgrounds.map(b => `- ${b.name}: ${b.visual_description}`).join('\n');

        const prompt = `You are an expert children's animation screenwriter specializing in miniature DIY engineering stories (Pixar's "Wall-E" meets "Honey, I Shrunk the Kids").

Characters:
- Scrap (PRIMARY PROTAGONIST): A tiny 3-inch-tall robot crafted from antique copper, pocket watch gears, and wire, with expressive glowing glass lens eyes. He is the master builder and inventor.
- Spark (PRIMARY COMPANION): A miniature mechanical bee made from yellow brass with translucent mica wings who communicates with curious chirps. He is Scrap's loyal airborne partner.
${additionalChars ? 'Occasional Known Secondary Characters (MUST BE HEAVILY RARE):\n' + additionalChars : ''}

Setting: A giant, lush suburban backyard seen strictly from ground level (towering blades of grass, giant pebbles, mountain-sized flowerpots, morning dew drops).
${additionalBgs ? 'Additional Known Backgrounds:\n' + additionalBgs : ''}

Episode Number: ${episodeNumber}
Episode Title / Hint: "${title}" (If this is generic like "Scrap & Spark Episode" or "Autonomous Catch-up Episode", you MUST INVENT a highly creative, unique STEM engineering challenge that is DIFFERENT from all previous episodes).

Task: Generate a 12-scene episode script based on the theme above.
Structure:
- Scene 1 (The 3-Second Hook): Start immediately with a high-stakes, dangerous, or highly curious action shot (e.g., Scrap slipping off a giant table, a massive droplet of water falling, a giant shadow looming). Throw the viewer right into the action!
- Scenes 2-4: The Problem (discovering the engineering challenge)
- Scenes 5-9: The Build & Trial (gathering debris like paperclips, rubber bands, popsicle sticks; testing, failing, calibrating)
- Scenes 10-12: The Triumph (the mechanism works, celebrating)
STRICT ALGORITHM & CONTINUITY RULES:
0. Viral STEM SEO: The YouTube title ('seo.title') MUST include parent-friendly STEM keywords like "Build", "DIY", "Science", "Robot", or "Mini Motor" (e.g., "Scrap & Spark Build a Mini Elevator! (DIY Robot Science)").
1. Backgrounds: You MUST choose 1 to 2 locations from the 'Additional Known Backgrounds' list. DO NOT invent new backgrounds.
2. MAIN DUO FOCUS & EXTREME RARITY OF OTHER CHARACTERS (CRITICAL):
- The entire series and story MUST BE heavily and predominantly focused on SCRAP and SPARK as the sole protagonists, inventors, and builders.
- 95%+ of episodes and scenes MUST feature ONLY Scrap and Spark ('characters_present': ["scrap", "spark"]).
- Any secondary or newly invented characters (such as Clank or other creatures) MUST BE HEAVILY RARE. Never feature them in standard episodes unless an episode's specific challenge genuinely calls for a brief 1-scene cameo or helper. They must NEVER overshadow Scrap and Spark.
- If multiple characters are in the 'characters_present' array for a scene, the 'character_action' MUST dictate an action for EVERY single character present. Never leave a character unmentioned.
3. Environment Description Rule (No Backend Labels): You must NEVER use internal biome names like "Navigational" or "Water" in the prompt.
4. Detailed Scene Action & Motion Length (45-70 WORDS REQUIRED): For each scene's 'character_action', provide an ultra-detailed, second-by-second physical motion description strictly between 45 to 70 words. You MUST break down what happens across the seconds in explicit physical detail:
- Beginning (Seconds 0-2): Starting stance, posture, approaching, or reaching toward the object.
- Middle (Seconds 2-4): Continuous, tactile physical interaction with the materials (e.g. two-handed grip, twisting wires, pulling rubber bands taut, turning brass gears, sliding tiny screws) with physical weight, tension, and micro-movements.
- Culmination (Seconds 4-6+): Micro-expressions (Scrap's glowing glass lens eyes focusing, pupil aperture clicking, antenna twitching) and companion dynamics (Spark hovering closely, rapidly buzzing translucent mica wings, antennae glowing, reacting to Scrap's effort).
- NEVER leave any character listed in 'characters_present' inactive or unmentioned.
Focus purely on 45-70 words of step-by-step physical choreography without camera labels or style words so the video AI (Veo/Flow) has rich second-by-second instructions to animate perfectly without cuts or morphing.
5. Dialogue & Pacing: Provide an array of spoken lines. There should be NO narrator. The story must be told purely through conversations and reactions between Scrap, Spark, and other characters. HOWEVER, the TTS engine speaks slowly! To ensure the audio fits the strict 4s, 6s, 8s, or 10s video generation limits, the TOTAL spoken words for a single scene MUST NEVER EXCEED 15 WORDS! (e.g. 5 words for 4s, 15 words for 10s). Keep it extremely punchy and brief!
6. UNIQUE INVENTION (CRITICAL): DO NOT build a bridge using a paperclip every time! The JSON below is just an EXAMPLE. You MUST invent a COMPLETELY NEW and unique contraption for this episode (e.g., a catapult, a pulley elevator, a water wheel, a wind-powered car, a magnifying glass laser, a pendulum clock, etc.). It MUST be different from previous episodes. Ensure continuous storytelling!
7. Small Letters For Tags: All tags and hashtags MUST BE in small lowercase letters only (e.g. "diy engineering", "miniature robot").

Output STRICTLY this JSON object and nothing else:
{
  "title": "Short Catchy Episode Title",
  "seo": {
    "title": "High-CTR YouTube Title under 70 chars with curiosity hook and [DIY Robot Science] (e.g. Can Tiny Robots Build a Working Catapult? ⚙️)",
    "description": "Viral 3-paragraph YouTube description:\nParagraph 1: Magnetic curiosity hook and question.\nParagraph 2: The STEM engineering challenge Scrap & Spark are tackling with everyday scrap materials.\nParagraph 3: Call to action to like, comment with new build ideas, and subscribe.\nInclude relevant timestamps and 5-8 hyper-targeted hashtags at the bottom.",
    "tags": ["scrap and spark", "3d animation", "miniature robot", "diy engineering", "stem for kids", "science experiment", "satisfying build", "miniature world", "wall-e style", "mechanical bee", "kids cartoons", "educational animation", "diy crafts", "how it works", "stop motion style", "robotics for kids", "miniature maker", "creative stem"]
  },
  "shorts_meta": {
    "title": "High curiosity viral short title with hook question under 60 chars #shorts",
    "description": "Wait until the end! 😱 Scrap & Spark test their wildest build yet! What should they build next? Comment below! 👇 #shorts #youtubeshorts #viral #animation #diy #robot #stem #miniature #satisfying #scrapandspark"
  },
  "invention_spec": {
    "materials": "list of exact human materials (e.g. 1 giant rusted paperclip and 2 rubber bands)"
  },
  "new_assets": {
    "characters": [],
    "backgrounds": []
  },
  "scenes": [
    {
      "scene_num": 1,
      "dialogue": [
        { "speaker": "scrap", "text": "Spark, look! A giant rusted paperclip!" },
        { "speaker": "spark", "text": "Bzzzt! It's perfectly sized for a lever!" },
        { "speaker": "scrap", "text": "Let's push it under the pebble!" }
      ],
      "character_action": "Scrap steps cautiously across the damp moss, firmly grasping the rusted paperclip with both hands and wedging it with steady leverage beneath the heavy pebble. His glowing blue lens eyes narrow with deep concentration while Spark hovers in tight circles inches away, his translucent mica wings rapidly buzzing and antennae flashing yellow in supportive anticipation.",
      "sound_design": "Key audio foley cue",
      "background": "sandbox",
      "characters_present": ["scrap", "spark"]
    }
  ]
}`;

        const messages = [{ role: 'user', content: prompt }];
        const sysPrompt = "You are a master children's animation screenwriter and JSON generator. Ensure every character_action is an ultra-detailed, continuous physical action strictly between 45 and 70 words describing second-by-second physical motion, material mechanics, micro-expressions, and companion reactions. Output ONLY a valid JSON object matching the exact schema requested. No markdown fences, no extra text.";

        let scriptResponse;
        try {
            scriptResponse = await callGroqLLM(messages, sysPrompt);
        } catch (groqErr) {
            log(`Groq LLM failed (${groqErr.message}). Falling back to OpenRouter...`);
            try {
                scriptResponse = await callOpenRouter(messages, sysPrompt, 'openrouter/free');
            } catch (orErr) {
                log(`OpenRouter failed (${orErr.message}). Falling back to Gemini...`);
                scriptResponse = await callGemini(messages, sysPrompt, 'gemini-2.5-flash');
            }
        }
        try {
            let cleaned = scriptResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                cleaned = cleaned.substring(firstBrace, lastBrace + 1);
            }
            scriptJson = JSON.parse(cleaned);
            // Normalize: new schema has scenes[].scene_num; old code used scene_number. Add compat.
            if (scriptJson.scenes) {
                scriptJson.scenes = scriptJson.scenes.map((s, i) => ({
                    ...s,
                    scene_number: s.scene_num || s.scene_number || (i + 1),
                }));
            }
            if (scriptJson.seo && Array.isArray(scriptJson.seo.tags)) {
                scriptJson.seo.tags = scriptJson.seo.tags.map(t => String(t).toLowerCase().trim());
            }
            fs.writeFileSync(scriptPath, JSON.stringify(scriptJson, null, 2));
            log(`Script saved. ${scriptJson.scenes.length} scenes generated.`);
        } catch (e) {
            log(`Failed to parse script JSON: ${e.message}`);
            if (ws) ws.send(JSON.stringify({ type: 'node_status', nodeId: 'developer', status: 'error' }));
            return;
        }
    } // End of LLM generation block

    // 2.1 Asset Pre-Generation
    setStatus('Pre-Generating Assets');
    log(`Checking for dynamically invented assets and cutouts...`);
    if (scriptJson.new_assets) {
        appendWorldLore(scriptJson.new_assets);
    }

    const currentLore = loadWorldLore();

    // Check all characters across all scenes in scriptJson
    const allScriptChars = new Set();
    for (const sc of scriptJson.scenes || []) {
        for (const c of (sc.characters_present || [])) {
            allScriptChars.add(c.toLowerCase().trim());
        }
    }
    for (const c of (scriptJson.new_assets?.characters || [])) {
        allScriptChars.add(c.name.toLowerCase().trim());
    }

    for (const charName of allScriptChars) {
        const charFileName = charName.charAt(0).toUpperCase() + charName.slice(1);
        const pngPath = path.join(ASSETS_DIR, 'characters', 'cutouts', `${charFileName}.png`);
        const jpgPath = path.join(ASSETS_DIR, 'characters', 'cutouts', `${charFileName}.jpg`);
        if (!fs.existsSync(pngPath) && !fs.existsSync(jpgPath)) {
            log(`  ► Auto-generating missing 3D cutout asset for character: ${charFileName}...`);
            let desc = scriptJson.new_assets?.characters?.find(c => c.name.toLowerCase() === charName)?.visual_description;
            if (!desc) {
                desc = currentLore.characters?.find(c => c.name.toLowerCase() === charName)?.visual_description;
            }
            if (!desc) {
                desc = `A charming miniature Pixar-style companion named ${charFileName} crafted from miniature mechanical parts.`;
            }
            await getOrGenerateAsset('characters/cutouts', charFileName, desc, log);
        }
    }

    if (scriptJson.new_assets?.backgrounds) {
        for (const bg of scriptJson.new_assets.backgrounds) {
            const bgFileName = bg.name;
            log(`  Checking dynamic background: ${bgFileName}...`);
            await getOrGenerateAsset('backgrounds', bgFileName, bg.visual_description, log);
        }
    }

    // 2.2 Expand Assets
    if (isAutonomous && !getPipelineState().youtube_pipeline_enabled) { log('Aborted by user.'); return; }
    // 2.2 Assets checking complete
    setStatus('Compositing');
    log(`Compositing local starter frames...`);
    const framesDir = path.join(epPath, '03_frames');
    await compositeFrames(scriptJson.scenes, ASSETS_DIR, framesDir, log);

    // 3. Audio Generation via Gemini
    if (isAutonomous && !getPipelineState().youtube_pipeline_enabled) { log('Aborted by user.'); return; }
    setStatus('Audio Generation');
    log(`Generating character dialogue via Gemini TTS...`);
    const clipsDir = path.join(epPath, '04_clips');
    const audioDir = path.join(epPath, '02_audio');

    const { GoogleGenAI } = require('@google/genai');
    const { getNextGeminiKey } = require('./llm_router');
    let currentKey = getNextGeminiKey();
    let ai = new GoogleGenAI({ apiKey: currentKey });

    const voiceMap = {
        'scrap': 'Charon',
        'spark': 'Aoede',
        'narrator': 'Puck'
    };

    for (const scene of scriptJson.scenes) {
        if (!getPipelineState().youtube_pipeline_enabled) {
            log(`[System] Pipeline aborted by user.`);
            throw new Error("ABORTED");
        }

        const audioPath = path.join(audioDir, `scene_${String(scene.scene_number).padStart(3, '0')}.wav`);

        if (!forceNew && fs.existsSync(audioPath)) {
            log(`Audio for scene ${scene.scene_number} already exists. Skipping Gemini TTS...`);
            scene.audioPath = audioPath;
            continue;
        }

        let rawLines = [];
        if (scene.dialogue && Array.isArray(scene.dialogue)) {
            rawLines = scene.dialogue;
        } else if (scene.narration) {
            rawLines = [{ speaker: 'narrator', text: scene.narration }];
        } else if (scene.lyric) {
            rawLines = [{ speaker: 'narrator', text: scene.lyric }];
        }

        if (rawLines.length === 0) {
            log(`No dialogue/narration for scene ${scene.scene_number}. Skipping audio...`);
            continue;
        }

        // Smart Optimization: Group consecutive lines from the SAME speaker into a single API call!
        let lines = [];
        for (const rl of rawLines) {
            if (lines.length > 0 && lines[lines.length - 1].speaker.toLowerCase() === rl.speaker.toLowerCase()) {
                lines[lines.length - 1].text += " " + rl.text;
            } else {
                lines.push({ speaker: rl.speaker, text: rl.text });
            }
        }

        // Hard safety filter: NEVER generate TTS for narrator lines.
        lines = lines.filter(l => l.speaker.toLowerCase() !== 'narrator');


        let scenePcmBuffers = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const voice = voiceMap[line.speaker.toLowerCase()] || 'Kore';
            const promptText = (line.speaker.toLowerCase() === 'narrator')
                ? `Read this narration in a warm, curious, David Attenborough-style nature documentary tone — awe-inspiring but gentle and accessible to children: "${line.text}"`
                : `Read this dialogue with infectious enthusiasm for a children's show. You are playing the character ${line.speaker}: "${line.text}"`;

            let lineSuccess = false;
            let attempts = 0;
            let currentKeyRetries = 0;
            let totalKeySwitches = 0;

            while (!lineSuccess && attempts < 15) {
                if (!getPipelineState().youtube_pipeline_enabled) {
                    log(`[System] Audio generation aborted by user.`);
                    throw new Error("ABORTED");
                }

                try {
                    attempts++;
                    if (getPipelineState().force_local_tts) throw new Error("FORCE_LOCAL_TTS");
                    log(`Generating audio for scene ${scene.scene_number} line ${i + 1}/${lines.length} (${line.speaker} -> ${voice}) [Attempt ${attempts}]...`);
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.1-flash-tts-preview',
                        contents: promptText,
                        config: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
                            }
                        }
                    });
                    const inlineData = response.candidates[0].content.parts.find(p => p.inlineData).inlineData;
                    let audioBuffer = Buffer.from(inlineData.data, 'base64');

                    // If Gemini returns a WAV header, strip it so we can seamlessly concatenate the raw PCM
                    if (audioBuffer.length > 44 && audioBuffer.toString('utf8', 0, 4) === 'RIFF') {
                        audioBuffer = audioBuffer.slice(44);
                    }

                    scenePcmBuffers.push(audioBuffer);
                    lineSuccess = true;
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    if (e.message && (e.message.includes('403') || e.message.includes('PERMISSION_DENIED') || e.message === "FORCE_LOCAL_TTS")) {
                        try {
                            if (e.message === "FORCE_LOCAL_TTS") throw new Error("FORCE_LOCAL_TTS");

                            currentKey = getNextGeminiKey();
                            totalKeySwitches++;
                            if (totalKeySwitches >= 6) throw new Error("Exhausted all keys");
                            log(`Permission Denied (403) on this key. Switching to next Gemini API key immediately...`);
                            ai = new GoogleGenAI({ apiKey: currentKey });
                            currentKeyRetries = 0;
                            await new Promise(r => setTimeout(r, 1000));
                        } catch (keyErr) {
                            if (keyErr.message !== "FORCE_LOCAL_TTS") {
                                log(`[Fallback] All Gemini API keys exhausted. Initiating Local Piper TTS Fallback...`);
                            } else {
                                log(`[Local TTS] Generating via Piper...`);
                            }
                            try {
                                const { execSync } = require('child_process');
                                const tempWavPath = path.join(__dirname, `temp_out_${Date.now()}.wav`);
                                const tempPcmPath = path.join(__dirname, `temp_pcm_${Date.now()}.pcm`);

                                // Clean up the prompt for the local TTS (remove the acting instructions)
                                const cleanText = line.text;

                                let modelName = 'narrator';
                                if (voice === 'Charon') modelName = 'scrap';
                                if (voice === 'Aoede') modelName = 'spark';

                                const piperPath = path.join(__dirname, 'bin', 'piper', 'piper.exe');
                                const modelPath = path.join(__dirname, 'bin', 'piper', 'voices', `${modelName}.onnx`);

                                if (!fs.existsSync(piperPath)) throw new Error("Piper binary missing.");

                                execSync(`"${piperPath}" --model "${modelPath}" --output_file "${tempWavPath}"`, { input: cleanText });

                                const ffmpegPath = require('ffmpeg-static');
                                execSync(`"${ffmpegPath}" -y -i "${tempWavPath}" -f s16le -ac 1 -ar 24000 "${tempPcmPath}"`);

                                const pcmBuffer = fs.readFileSync(tempPcmPath);
                                scenePcmBuffers.push(pcmBuffer);

                                fs.unlinkSync(tempWavPath);
                                fs.unlinkSync(tempPcmPath);

                                lineSuccess = true;
                                log(`  ✓ Local fallback succeeded for ${line.speaker}`);
                                break;
                            } catch (fallbackErr) {
                                log(`Failed to generate audio via fallback for scene ${scene.scene_number}: ${fallbackErr.message}`);
                                break;
                            }
                        }
                    } else if (e.message && e.message.includes('429')) {
                        currentKeyRetries++;
                        if (currentKeyRetries >= 2) {
                            try {
                                currentKey = getNextGeminiKey();
                                totalKeySwitches++;
                                if (totalKeySwitches >= 6) throw new Error("Exhausted all keys");
                                log(`Rate limited (429) twice on this key. Switching to next Gemini API key...`);
                                ai = new GoogleGenAI({ apiKey: currentKey });
                                currentKeyRetries = 0;
                                await new Promise(r => setTimeout(r, 2000));
                            } catch (keyErr) {
                                log(`[Fallback] All Gemini API keys exhausted. Initiating Local Piper TTS Fallback...`);
                                try {
                                    const { execSync } = require('child_process');
                                    const tempTextPath = path.join(__dirname, `temp_text_${Date.now()}.txt`);
                                    const tempWavPath = path.join(__dirname, `temp_out_${Date.now()}.wav`);
                                    const tempPcmPath = path.join(__dirname, `temp_pcm_${Date.now()}.pcm`);

                                    try {
                                        const cleanText = line.text;
                                        fs.writeFileSync(tempTextPath, cleanText);

                                        let modelName = 'narrator';
                                        if (voice === 'Charon') modelName = 'scrap';
                                        if (voice === 'Aoede') modelName = 'spark';

                                        const piperPath = path.join(__dirname, 'bin', 'piper', 'piper.exe');
                                        const modelPath = path.join(__dirname, 'bin', 'piper', 'voices', `${modelName}.onnx`);

                                        if (!fs.existsSync(piperPath)) throw new Error("Piper binary missing.");

                                        execSync(`"${piperPath}" --model "${modelPath}" --text_file "${tempTextPath}" --output_file "${tempWavPath}"`);

                                        const ffmpegPath = require('ffmpeg-static');
                                        execSync(`"${ffmpegPath}" -y -i "${tempWavPath}" -f s16le -ac 1 -ar 24000 "${tempPcmPath}"`);

                                        const pcmBuffer = fs.readFileSync(tempPcmPath);
                                        scenePcmBuffers.push(pcmBuffer);
                                    } finally {
                                        if (fs.existsSync(tempTextPath)) fs.unlinkSync(tempTextPath);
                                        if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
                                        if (fs.existsSync(tempPcmPath)) fs.unlinkSync(tempPcmPath);
                                    }

                                    lineSuccess = true;
                                    log(`  ✓ Local fallback succeeded for ${line.speaker}`);
                                    break;
                                } catch (fallbackErr) {
                                    log(`Failed to generate audio via fallback for scene ${scene.scene_number}: ${fallbackErr.message}`);
                                    break;
                                }
                            }
                        } else {
                            const delayStr = e.message.match(/retry in ([\d\.]+)s/);
                            const delaySecs = delayStr ? parseFloat(delayStr[1]) : 10;
                            log(`Rate limited (429). Waiting ${delaySecs.toFixed(1)}s before giving up on this key...`);
                            await new Promise(r => setTimeout(r, (delaySecs + 1) * 1000));
                        }
                    } else {
                        log(`Failed to generate audio for scene ${scene.scene_number}: ${e.message}. Retrying in 5s...`);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
            }
        }

        if (scenePcmBuffers.length > 0) {
            let combinedPcm = Buffer.concat(scenePcmBuffers);

            // Wrap the massive concatenated PCM stream in a single WAV header for Remotion
            const sampleRate = 24000;
            const numChannels = 1;
            const bitsPerSample = 16;
            const header = Buffer.alloc(44);
            header.write('RIFF', 0);
            header.writeUInt32LE(36 + combinedPcm.length, 4);
            header.write('WAVE', 8);
            header.write('fmt ', 12);
            header.writeUInt32LE(16, 16);
            header.writeUInt16LE(1, 20);
            header.writeUInt16LE(numChannels, 22);
            header.writeUInt32LE(sampleRate, 24);
            header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
            header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
            header.writeUInt16LE(bitsPerSample, 34);
            header.write('data', 36);
            header.writeUInt32LE(combinedPcm.length, 40);

            const finalWavBuffer = Buffer.concat([header, combinedPcm]);
            fs.writeFileSync(audioPath, finalWavBuffer);
            scene.audioPath = audioPath;
        }
    }
    // 3.5 Pre-process scenes: attach bgPath + characters_present
    const KNOWN_CHAR_NAMES = ['scrap', 'spark'];
    for (const scene of scriptJson.scenes) {
        const vp = (scene.character_action || scene.visual_prompt || '').toLowerCase();

        let bgImg = scene.background || 'meadow';
        if (!bgImg.toLowerCase().endsWith('.png') && !bgImg.toLowerCase().endsWith('.jpg')) {
            bgImg += '.jpg';
        }

        scene.bgPath = `http://localhost:3000/youtube/assets/backgrounds/${bgImg}`;

        let found = KNOWN_CHAR_NAMES.filter(c => vp.includes(c));
        if (!scene.characters_present || scene.characters_present.length === 0) {
            scene.characters_present = found.length > 0 ? found : ['scrap', 'spark'];
        }
    }

    // 3.6 Calculate audio durations and write scene_prompts.txt
    const rawClipsDir = path.join(epPath, '03_raw_clips');
    const scenes = scriptJson.scenes;
    const totalScenes = scenes.length;
    let promptsContent = '';
    for (const scene of scenes) {
        const sceneNum = String(scene.scene_number).padStart(2, '0');
        const audioPath = scene.audioPath || path.join(epPath, '02_audio', `scene_${String(scene.scene_number).padStart(3, '0')}.wav`);
        let audioDuration = '?';
        let veoTarget = 4;
        try {
            if (fs.existsSync(audioPath)) {
                const stat = fs.statSync(audioPath);
                // Subtract the 44-byte WAV header for calculation (2 bytes per sample at 24000Hz)
                let durationSecs = (stat.size > 44 ? stat.size - 44 : stat.size) / 48000.0;

                if (durationSecs > 4 && durationSecs <= 6) veoTarget = 6;
                else if (durationSecs > 6 && durationSecs <= 8) veoTarget = 8;
                else if (durationSecs > 8) veoTarget = 10;

                const ffmpegPath = require('ffmpeg-static');
                const paddedAudioPath = audioPath.replace('.wav', '_padded.wav');

                if (durationSecs > 10) {
                    const speed = durationSecs / 10.0;
                    execSync(`"${ffmpegPath}" -y -i "${audioPath}" -filter:a "atempo=${speed}" -t 10 "${paddedAudioPath}"`);
                } else {
                    execSync(`"${ffmpegPath}" -y -i "${audioPath}" -filter_complex "apad" -t ${veoTarget} "${paddedAudioPath}"`);
                }

                fs.copyFileSync(paddedAudioPath, audioPath);
                fs.unlinkSync(paddedAudioPath);

                audioDuration = (veoTarget).toFixed(1);
            }
        } catch (_) { }
        const bgName = scene.background || 'sandbox';
        const lorePath = path.join(ASSETS_DIR, 'world_lore.json');
        let loreBackground = { visual_description: "a beautiful miniature world" };
        if (fs.existsSync(lorePath)) {
            const worldLore = JSON.parse(fs.readFileSync(lorePath, 'utf8'));
            loreBackground = worldLore.backgrounds?.find(b => b.id?.toLowerCase() === bgName?.toLowerCase()) || loreBackground;
        }
        
        const action = scene.character_action || scene.visual_prompt || 'Scrap stands there.';
        const materials = scriptJson.invention_spec?.materials || 'everyday human objects';
        const finalVeoPrompt = `(SILENT VIDEO — DO NOT GENERATE AUDIO). ${action} CINEMATIC ACTION & CAMERA: Continuous fluid macro shot, slow ground-level tracking camera smoothly following the characters' physical motion with lifelike weight and tactile interaction. STATIC ELEMENTS: The environment is ${loreBackground.visual_description}. The invention is made EXACTLY of ${materials}. DO NOT introduce steel beams, heavy industrial machinery, or human hands. STYLE: 3D Pixar-style cinematic macro animation, photorealistic morning sunlight, ray-traced reflections on miniature brass and copper, soft cast shadows, creamy bokeh. Smooth 30fps. SILENT VIDEO.`;

        promptsContent += [
            `========================================`,
            `SCENE ${scene.scene_number} of ${totalScenes}`,
            `[VEO TARGET]: GENERATE EXACTLY A ** ${veoTarget}s ** VIDEO! (Audio strictly padded to ${audioDuration}s)`,
            `File name to save: scene_${sceneNum}.mp4`,
            `Sound Design: ${scene.sound_design || 'ambient backyard sounds'}`,
            `----------------------------------------`,
            `VEO 3 MACRO PROMPT:`,
            finalVeoPrompt,
            `========================================`,
            ''
        ].join('\n');
    }
    const promptsFilePath = path.join(epPath, 'scene_prompts.txt');
    fs.writeFileSync(promptsFilePath, promptsContent);
    log(`scene_prompts.txt written with ${totalScenes} scenes.`);

    // Write episode_state.json
    const episodeStateFile = path.join(epPath, 'episode_state.json');
    fs.writeFileSync(episodeStateFile, JSON.stringify({
        status: 'AWAITING_CLIPS',
        total_scenes: totalScenes,
        episode_dir: epPath,
        title: title,
        episode_number: episodeNumber
    }, null, 2));

    if (mode === 'manual') {
        setStatus('AWAITING_CLIPS');
        log(`[Manual Mode] Pipeline paused. Place scene_01.mp4 – scene_${String(totalScenes).padStart(2, '0')}.mp4 into ${rawClipsDir} then click Assemble.`);
        if (ws) ws.send(JSON.stringify({ type: 'scrap_awaiting_clips', total_scenes: totalScenes, episode_dir: epPath, prompts_file: promptsFilePath }));
        return;
    }

    // 4. Auto mode: Generate Veo 3 Clips & Sync with FFmpeg
    if (isAutonomous && !getPipelineState().youtube_pipeline_enabled) { log('Aborted by user.'); return; }
    setStatus('Rendering');
    log(`Starting native FFmpeg + Veo 3 Video Assembly...`);
    const finalVideoPath = path.join(epPath, '05_final', 'final_episode.mp4');
    const clipsListPath = path.join(epPath, '04_clips', 'clips_list.txt');
    const exec = require('child_process').exec;

    // Helper to run ffmpeg promise
    const ffmpegPath = require('ffmpeg-static');
    const runFfmpeg = (cmd) => new Promise((resolve, reject) => {
        const fullCmd = cmd.replace(/^ffmpeg\s+/, `"${ffmpegPath}" `);
        exec(fullCmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });

    try {
        let clipsListContent = '';

        // Ensure Title Card
        const titleImgPath = await getOrGenerateAsset('backgrounds', 'title_card_bg', 'A giant weathered metal bottle cap half-buried in mud and towering green grass. Scrap', log);
        const titleClipPath = path.join(epPath, '04_clips', 'scene_000_title.mp4');
        if (!fs.existsSync(titleClipPath)) {
            log(`    ► Generating Title Card clip...`);
            await runFfmpeg(`ffmpeg -y -loop 1 -i "${titleImgPath}" -t 4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black,zoompan=z='min(zoom+0.0015,1.5)':d=120" -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p "${titleClipPath}"`);
        }
        clipsListContent += `file 'scene_000_title.mp4'\n`;

        // Process Scenes
        for (const scene of scriptJson.scenes) {
            const rawVeoPath = path.join(epPath, '04_clips', `veo_raw_${String(scene.scene_number).padStart(3, '0')}.mp4`);
            const syncedClipPath = path.join(epPath, '04_clips', `synced_${String(scene.scene_number).padStart(3, '0')}.mp4`);
            const assPath = path.join(epPath, '04_clips', `sub_${String(scene.scene_number).padStart(3, '0')}.ass`);

            // 4a. Veo 3 Generation (with local caching)
            await generateSceneVideo(scene, rawVeoPath, log);

            // 4b. Sync Audio & Video via FFmpeg (Duration matching via reverse-loop)
            if (!fs.existsSync(syncedClipPath) || fs.statSync(syncedClipPath).size < 10000) {
                log(`    ► Syncing audio and video for scene ${scene.scene_number}...`);
                const audioPath = scene.audioPath;
                // Complex filter: video is reversed, then concatenated to itself (forward + reverse loop).
                // Then truncated to the exact duration of the audio.
                // We also burn the subtitles into the video here.

                // 4c. Generate .ass subtitle for this scene
                // No subtitle burn-in for Scrap & Spark (documentary narration style)
                const watermarkAsset = path.join(ASSETS_DIR, 'channel_watermark.png');
                let filterGraph;
                let ffmpegCmd;

                if (fs.existsSync(watermarkAsset)) {
                    filterGraph = `[0:v]reverse[r];[0:v][r]concat=n=2:v=1[basev];[2:v]scale=120:-1[wmk];[basev][wmk]overlay=W-w-50:H-h-60[v]`;
                    ffmpegCmd = `ffmpeg -y -i "${rawVeoPath}" -i "${audioPath}" -i "${watermarkAsset}" -filter_complex "${filterGraph}" -map "[v]" -map 1:a -shortest -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p -c:a aac -b:a 192k "${syncedClipPath}"`;
                } else {
                    filterGraph = `[0:v]reverse[r];[0:v][r]concat=n=2:v=1[v]`;
                    ffmpegCmd = `ffmpeg -y -i "${rawVeoPath}" -i "${audioPath}" -filter_complex "${filterGraph}" -map "[v]" -map 1:a -shortest -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p -c:a aac -b:a 192k "${syncedClipPath}"`;
                }
                
                await runFfmpeg(ffmpegCmd);
                log(`    ✓ Synced scene ${scene.scene_number}`);
            }

            clipsListContent += `file 'synced_${String(scene.scene_number).padStart(3, '0')}.mp4'\n`;
        }

        // Ensure End Card
        const endImgPath = await getOrGenerateAsset('backgrounds', 'end_card_bg', 'A golden-hour macro shot of a rusty gear lying in moss, with a tiny yellow brass bee hovering nearby. Spark', log);
        const endClipPath = path.join(epPath, '04_clips', `scene_999_end.mp4`);
        if (!fs.existsSync(endClipPath)) {
            log(`    ► Generating End Card clip...`);
            await runFfmpeg(`ffmpeg -y -loop 1 -i "${endImgPath}" -t 4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black,zoompan=z='min(zoom+0.0015,1.5)':d=120" -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p "${endClipPath}"`);
        }
        clipsListContent += `file 'scene_999_end.mp4'\n`;

        // Write clips list for concat
        fs.writeFileSync(clipsListPath, clipsListContent);

        // 5. Final Mix with Ducked BGM
        log(`    ► Stitching all scenes and mixing BGM...`);
        const bgmPath = path.join(ASSETS_DIR, 'bgm.wav');
        const stitchedPath = path.join(epPath, '05_final', 'stitched_no_bgm.mp4');

        // Concat all synced scenes
        await runFfmpeg(`ffmpeg -y -f concat -safe 0 -i "${clipsListPath}" -c copy "${stitchedPath}"`);

        // Mix BGM ducked at -18dB
        if (fs.existsSync(bgmPath)) {
            log(`    ► Mixing CC0 BGM...`);
            await runFfmpeg(`ffmpeg -y -i "${stitchedPath}" -i "${bgmPath}" -filter_complex "[1:a]volume=-18dB[bgm];[0:a][bgm]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "${finalVideoPath}"`);
        } else {
            // No BGM, just copy
            fs.copyFileSync(stitchedPath, finalVideoPath);
        }

        log(`FFmpeg render complete: ${finalVideoPath}`);
    } catch (e) {
        log(`FFmpeg rendering failed: ${e.message}`);
        if (ws) ws.send(JSON.stringify({ type: 'node_status', nodeId: 'developer', status: 'error' }));
        return;
    }

    if (ws) ws.send(JSON.stringify({ type: 'node_status', nodeId: 'developer', status: 'idle' }));

    // 6. State Update & Review Timeout
    updatePipelineState({
        pending_review: true,
        pending_episode_path: finalVideoPath,
        review_started_at: Date.now(),
        current_title: title
    });

    setStatus('Complete');

    log(`Episode rendered and awaiting review. Auto-uploading in 10 minutes.`);

    // Also send the voice notification
    if (ws) {
        const { streamTTS } = require('./elevenlabs_tts');
        const alertMsg = "Sir, today's Scrap and Spark episode has completed rendering and is awaiting review. Uploading automatically in 10 minutes.";
        streamTTS(alertMsg, ws,
            (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
            () => { }, (err) => console.warn(err)
        );
    }

    startReviewTimer(ws);
}

function startReviewTimer(ws) {
    const state = getPipelineState();
    if (!state.pending_review) return;

    if (reviewTimer) clearTimeout(reviewTimer);

    const now = Date.now();
    const elapsed = now - (state.review_started_at || now);
    const tenMinutes = 10 * 60 * 1000;
    let remaining = tenMinutes - elapsed;

    const log = (msg) => {
        console.log(`[Scrap Pipeline] ${msg}`);
        if (ws) ws.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Pipeline] ${msg}` }));
    };

    if (remaining <= 0) {
        log(`Timer expired while offline. Executing upload immediately.`);
        executeUpload(ws);
    } else {
        log(`Timer started. ${Math.round(remaining / 1000)} seconds remaining.`);
        reviewTimer = setTimeout(() => {
            executeUpload(ws);
        }, remaining);
    }
}

async function executeUpload(ws) {
    const state = getPipelineState();
    const log = (msg) => {
        console.log(`[Scrap Pipeline] ${msg}`);
        if (ws) ws.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Pipeline] ${msg}` }));
    };
    if (!state.pending_review || !state.pending_episode_path) return;

    log(`Executing upload for ${state.current_title}...`);
    try {
        const fs = require('fs');
        const path = require('path');
        const episodeDir = state.pending_episode_path;
        const videoPath = path.join(episodeDir, '05_final', 'final_episode.mp4');
        const scriptPath = path.join(episodeDir, '01_script', 'script.json');

        if (!fs.existsSync(videoPath)) {
            throw new Error(`Video file not found at ${videoPath}`);
        }

        let scriptJson = { title: state.current_title, scenes: [] };
        if (fs.existsSync(scriptPath)) {
            scriptJson = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
        }

        const epMatch = episodeDir.match(/EP(\d+)/i);
        const epNum = epMatch ? parseInt(epMatch[1]) : 1;

        const shortsPath = path.join(episodeDir, '05_final', 'shorts_episode.mp4');
        const finalShortsPath = fs.existsSync(shortsPath) ? shortsPath : null;

        let uploadSuccess = false;
        let attempts = 0;
        const maxAttempts = 5;
        let lastErr = null;

        while (!uploadSuccess && attempts < maxAttempts) {
            try {
                attempts++;
                if (attempts > 1) {
                    log(`Retrying upload (Attempt ${attempts}/${maxAttempts})...`);
                }
                await uploadToYouTube(videoPath, scriptJson, epNum, finalShortsPath);
                uploadSuccess = true;
            } catch (err) {
                lastErr = err;
                log(`Upload attempt ${attempts} failed: ${err.message}`);
                if (attempts < maxAttempts) {
                    log(`Waiting 30 seconds before next attempt...`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
            }
        }

        if (!uploadSuccess) {
            throw new Error(`Failed to upload after ${maxAttempts} attempts. Last error: ${lastErr.message}`);
        }

        // Update state on success
        const todayStr = new Date().toISOString().split('T')[0];

        // Update local episode state for UI to detect upload
        const epStateFile = path.join(episodeDir, 'episode_state.json');
        if (fs.existsSync(epStateFile)) {
            const epData = JSON.parse(fs.readFileSync(epStateFile, 'utf8'));
            epData.status = 'UPLOADED';
            epData.pending_review = false;
            epData.last_run_date = todayStr;
            fs.writeFileSync(epStateFile, JSON.stringify(epData, null, 2));
        }

        updatePipelineState({
            last_run_date: todayStr,
            current_episode_index: epNum + 1,
            pending_review: false,
            pending_episode_path: null,
            review_started_at: null,
            current_title: null
        });
        log(`Upload complete and state reset.`);
        if (ws) {
            const { streamTTS } = require('./elevenlabs_tts');
            streamTTS("Upload complete, sir.", ws,
                (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
                () => { }, (err) => console.warn(err)
            );
        }
    } catch (err) {
        log(`Upload failed: ${err.message}`);
        // Reset state so the pipeline isn't permanently stuck if the file is missing
        updatePipelineState({
            status: 'IDLE',
            pending_review: false,
            pending_episode_path: null,
            review_started_at: null,
            current_title: null
        });
        log(`Pipeline state reset due to upload failure.`);
    }
}

function cancelUpload(ws) {
    if (reviewTimer) clearTimeout(reviewTimer);
    const fs = require('fs');
    const path = require('path');
    const state = getPipelineState();

    // Update local episode state for UI
    if (state.pending_episode_path) {
        const epStateFile = path.join(state.pending_episode_path, 'episode_state.json');
        if (fs.existsSync(epStateFile)) {
            const epData = JSON.parse(fs.readFileSync(epStateFile, 'utf8'));
            epData.status = 'CANCELLED';
            epData.pending_review = false;
            fs.writeFileSync(epStateFile, JSON.stringify(epData, null, 2));
        }
    }

    updatePipelineState({
        status: 'IDLE',
        pending_review: false,
        pending_episode_path: null,
        review_started_at: null,
        current_title: null
    });
    const log = (msg) => {
        console.log(`[Scrap Pipeline] ${msg}`);
        if (ws) ws.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Pipeline] ${msg}` }));
    };
    log(`Upload cancelled. Files retained locally.`);
}

function assembleVideo(clipsDir, audioPath, finalOutPath, log) {
    const files = fs.readdirSync(clipsDir).filter(f => f.endsWith('.mp4')).sort();
    if (files.length === 0) {
        throw new Error("No rendered clips found for assembly.");
    }

    // Create concat text file
    const listPath = path.join(clipsDir, 'concat_list.txt');
    const listContent = files.map(f => `file '${path.join(clipsDir, f)}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    try {
        // Concatenate video clips
        const mergedVideo = path.join(clipsDir, 'merged_video.mp4');
        execSync(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${mergedVideo}"`, { stdio: 'ignore' });

        // Add Audio if exists
        if (fs.existsSync(audioPath)) {
            execSync(`ffmpeg -y -i "${mergedVideo}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${finalOutPath}"`, { stdio: 'ignore' });
        } else {
            fs.copyFileSync(mergedVideo, finalOutPath);
        }
        log(`Final video assembled at ${finalOutPath}`);
    } catch (e) {
        log(`FFmpeg assembly failed: ${e.message}`);
    }
}

async function compositeFrames(scriptJson, assetsDir, framesDir, log) {
    if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

    const sharp = require('sharp');
    const charsDir = path.join(assetsDir, 'characters', 'cutouts');
    const knownChars = ['scrap', 'spark'];

    for (let i = 0; i < scriptJson.length; i++) {
        const scene = scriptJson[i];
        const outPath = path.join(framesDir, `scene_${(i + 1).toString().padStart(3, '0')}.png`);
        if (fs.existsSync(outPath)) {
            log(`  Skipping frame for scene ${i + 1}: already composited.`);
            continue;
        }

        let activeChars = scene.characters_present;
        if (!activeChars || activeChars.length === 0) {
            // fallback keyword parsing
            const prompt = (scene.visual_prompt || "").toLowerCase();
            activeChars = knownChars.filter(c => prompt.includes(c));
            if (activeChars.length === 0) activeChars = ['scrap', 'spark'];
        }

        const canvasWidth = 1920;
        const canvasHeight = 1080;

        let baseImage;
        const bgsDir = path.join(assetsDir, 'backgrounds');
        let bgMatched = false;

        let selectedBg = 'Water.png'; // Default Biome

        if (scene.background) {
            selectedBg = scene.background;
            if (!selectedBg.toLowerCase().endsWith('.png') && !selectedBg.toLowerCase().endsWith('.jpg')) {
                if (fs.existsSync(path.join(bgsDir, `${selectedBg}.png`))) selectedBg += '.png';
                else if (fs.existsSync(path.join(bgsDir, `${selectedBg}.jpg`))) selectedBg += '.jpg';
                else selectedBg += '.png';
            }
        } else {
            // Keyword matching for Biomes based on the LLM's visual prompt
            const prompt = (scene.visual_prompt || "").toLowerCase();
            if (prompt.includes('indoor') || prompt.includes('plant') || prompt.includes('pot') || prompt.includes('soil') || prompt.includes('dark')) {
                selectedBg = 'Low-Light.png';
            } else if (prompt.includes('tool') || prompt.includes('shed') || prompt.includes('wood') || prompt.includes('rust') || prompt.includes('nail') || prompt.includes('industrial')) {
                selectedBg = 'Industrial.png';
            } else if (prompt.includes('patio') || prompt.includes('brick') || prompt.includes('canyon') || prompt.includes('gap') || prompt.includes('moss') || prompt.includes('bridge')) {
                selectedBg = 'Navigational.png';
            } else if (prompt.includes('puddle') || prompt.includes('water') || prompt.includes('mud') || prompt.includes('ocean')) {
                selectedBg = 'Water.png';
            }
        }

        if (fs.existsSync(bgsDir)) {
            const bgPath = path.join(bgsDir, selectedBg);
            if (fs.existsSync(bgPath)) {
                try {
                    const bgBuffer = await sharp(bgPath)
                        .resize({ width: canvasWidth, height: canvasHeight, fit: 'cover' })
                        .toBuffer();
                    baseImage = sharp(bgBuffer);
                    bgMatched = true;
                } catch (err) {
                    log(`Failed to load background ${selectedBg}: ${err.message}`);
                }
            }
        }

        // Fallback layer
        if (!bgMatched) {
            baseImage = sharp({
                create: {
                    width: canvasWidth,
                    height: canvasHeight,
                    channels: 4,
                    background: { r: 135, g: 206, b: 235, alpha: 1 }
                }
            });
        }

        const composites = [];
        const spacing = canvasWidth / (activeChars.length + 1);

        for (let j = 0; j < activeChars.length; j++) {
            let charName = activeChars[j].toLowerCase();
            const fileName = charName.charAt(0).toUpperCase() + charName.slice(1);
            let charPath = path.join(charsDir, fileName + ".png");
            if (!fs.existsSync(charPath)) {
                charPath = path.join(charsDir, fileName + ".jpg"); // Pollinations generated images
            }

            if (fs.existsSync(charPath)) {
                // Resize characters (Macro scale)
                const targetHeight = Math.floor(canvasHeight * 0.45);
                const resizedCharBuffer = await sharp(charPath)
                    .resize({ height: targetHeight, fit: 'contain' })
                    .toBuffer();

                const meta = await sharp(resizedCharBuffer).metadata();
                const xPos = Math.floor((spacing * (j + 1)) - (meta.width / 2));
                const yPos = Math.floor(canvasHeight * 0.85 - meta.height); // Anchor them lower down near the ground

                composites.push({
                    input: resizedCharBuffer,
                    left: xPos,
                    top: yPos
                });
            } else {
                log(`Character cutout not found: ${charPath}`);
            }
        }


        if (composites.length > 0) {
            await baseImage.composite(composites).toFile(outPath);
            log(`Composited frame for scene ${i + 1} with [${activeChars.join(', ')}] on ${selectedBg}`);
        } else {
            await baseImage.toFile(outPath);
            log(`Composited frame for scene ${i + 1} with NO characters on ${selectedBg}`);
        }
    }
}

async function getOrGenerateAsset(assetCategory, assetName, specificSubject, log) {
    const ASSETS_DIR = 'D:\\youtube\\assets';
    const catDir = path.join(ASSETS_DIR, assetCategory);

    // Ensure directories exist
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    const localPath = path.join(catDir, `${assetName}.jpg`);
    const pngPath = path.join(catDir, `${assetName}.png`);

    // Prioritize local PNG for characters
    if (assetCategory === 'characters/cutouts' && fs.existsSync(pngPath)) {
        log(`    ✓ Asset already exists locally: ${assetCategory}/${assetName}.png`);
        return pngPath;
    }

    // Prioritize local file
    if (fs.existsSync(localPath)) {
        log(`    ✓ Asset already exists locally: ${assetCategory}/${assetName}.jpg`);
        return localPath;
    }

    log(`    ► Generating missing style-locked asset: ${assetName}...`);

    // Dynamic character physical description injection
    let subject = specificSubject;
    const lowerSubject = subject.toLowerCase();

    if (lowerSubject.includes('scrap')) {
        subject += " Scrap is a 3-inch-tall miniature robot crafted from weathered antique copper and brass watchmaker gears with glowing cyan camera-lens eyes.";
    }
    if (lowerSubject.includes('spark')) {
        subject += " Spark is a miniature mechanical bumblebee crafted from polished yellow brass with translucent mica wings and glowing yellow antenna tips.";
    }

    if (assetCategory === 'characters/cutouts') {
        subject += ". ISOLATED ON A PURE SOLID WHITE BACKGROUND. Full body character portrait.";
        const styleLock = "3D Pixar animation studio full-body character model render, miniature mechanical steampunk DIY robot aesthetic matching Wall-E. Intricate details of antique copper, watchmaker gears, coiled steel springs, brass screws, and glowing camera-lens eyes. Full body character portrait, ray-traced metal reflections, sharp studio lighting, ISOLATED ON PURE SOLID WHITE BACKGROUND. ";
        prompt = styleLock + subject;
    } else if (assetCategory === 'backgrounds') {
        subject += ". EMPTY SCENERY, NO CHARACTERS, NO FACES, NO EYES. Environment only.";
        const styleLock = "3D Pixar-style cinematic photography, low camera angle, bug's eye view, 8k resolution, Unreal Engine 5 render style, beautiful lighting. ";
        prompt = styleLock + subject;
    } else {
        const styleLock = "3D Pixar-style cinematic macro photography, ground-level extreme close-up, 8k resolution, Unreal Engine 5 render style. ";
        prompt = styleLock + subject;
    }

    const encodedPrompt = encodeURIComponent(prompt);
    // Add seed and nologo to ensure clean generation
    // Use random seed to avoid cached identical images if retrying
    const seed = Math.floor(Math.random() * 100000);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true&model=flux&seed=${seed}`;

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            let imageBuffer = Buffer.from(await response.arrayBuffer());

            // Dynamically calculate crop area to avoid 'bad extract area' if image resolution varies
            log(`      ► Removing AI watermark...`);
            const metadata = await sharp(imageBuffer).metadata();
            const extractWidth = Math.floor(metadata.width * 0.96);
            const extractHeight = Math.floor(metadata.height * 0.96);
            const leftOffset = Math.floor((metadata.width - extractWidth) / 2);

            imageBuffer = await sharp(imageBuffer)
                .extract({ left: leftOffset, top: 0, width: extractWidth, height: extractHeight })
                .resize(1920, 1080, { fit: 'cover' })
                .jpeg({ quality: 95 })
                .toBuffer();

            fs.writeFileSync(localPath, imageBuffer);

            if (assetCategory === 'characters/cutouts') {
                log(`      ► Removing white background for cutout...`);
                const ok = await removeWhiteBackground(localPath, pngPath, log);
                if (ok) {
                    fs.unlinkSync(localPath);
                    log(`    ✓ Asset generated and saved as transparent PNG: ${pngPath}`);
                    return pngPath;
                }
            }

            log(`    ✓ Asset generated and saved: ${localPath}`);
            return localPath;
        } catch (err) {
            retries--;
            if (retries === 0) {
                log(`    ✗ Failed to generate asset ${assetName}: ${err.message}`);
                return null;
            }
            log(`    ✗ Generation failed (${err.message}). Retrying...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function generateStandaloneTTS(text, outPath, log) {
    require('dotenv').config({ path: require('path').join(__dirname, '.env') });
    const { GoogleGenAI } = require('@google/genai');
    let geminiKey = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2;
    if (!geminiKey && process.env.GEMINI_API_KEYS) geminiKey = process.env.GEMINI_API_KEYS.split(',')[0];
    if (!geminiKey) {
        const envPath = require('path').join(__dirname, '.env');
        const fs = require('fs');
        if (fs.existsSync(envPath)) {
            const envData = fs.readFileSync(envPath, 'utf8');
            const match1 = envData.match(/GEMINI_API_KEY_1=(.+)/);
            const matchKeys = envData.match(/GEMINI_API_KEYS=(.+)/);
            if (match1) geminiKey = match1[1].trim();
            else if (matchKeys) geminiKey = matchKeys[1].split(',')[0].trim();
        }
    }
    if (!geminiKey) throw new Error("No Gemini key for TTS");
    let useFallback = false;
    let audioBuffer = null;

    if (getPipelineState().force_local_tts) {
        useFallback = true;
    } else {
        try {
            const ai = new GoogleGenAI({ apiKey: geminiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-tts-preview',
                contents: `Read this line with infectious enthusiasm and a cheerful kids-show tone: "${text}"`,
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } }
                }
            });
            const inlineData = response.candidates[0].content.parts.find(p => p.inlineData).inlineData;
            audioBuffer = Buffer.from(inlineData.data, 'base64');
            if (!inlineData.mimeType || inlineData.mimeType.includes('audio/wav') === false) {
                const sampleRate = 24000;
                const header = Buffer.alloc(44);
                header.write('RIFF', 0);
                header.writeUInt32LE(36 + audioBuffer.length, 4);
                header.write('WAVE', 8);
                header.write('fmt ', 12);
                header.writeUInt32LE(16, 16);
                header.writeUInt16LE(1, 20);
                header.writeUInt16LE(1, 22);
                header.writeUInt32LE(sampleRate, 24);
                header.writeUInt32LE(sampleRate * 2, 28);
                header.writeUInt16LE(2, 32);
                header.writeUInt16LE(16, 34);
                header.write('data', 36);
                header.writeUInt32LE(audioBuffer.length, 40);
                audioBuffer = Buffer.concat([header, audioBuffer]);
            }
        } catch (e) {
            log(`[Warning] Gemini TTS failed for title card: ${e.message}. Falling back to Piper...`);
            useFallback = true;
        }
    }

    if (useFallback) {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const piperPath = require('path').join(__dirname, 'bin', 'piper', 'piper.exe');
        const modelPath = require('path').join(__dirname, 'bin', 'piper', 'voices', 'narrator.onnx');
        const tempWavPath = require('path').join(__dirname, `temp_out_${Date.now()}.wav`);

        execSync(`"${piperPath}" --model "${modelPath}" --output_file "${tempWavPath}"`, { input: text });
        audioBuffer = fs.readFileSync(tempWavPath);
        fs.unlinkSync(tempWavPath);
    }

    require('fs').writeFileSync(outPath, audioBuffer);
}

// ─── Standalone Assembly Function (used by POST /api/scrap/assemble) ──────────
async function assembleScrapEpisode(episodeDir, ws) {
    const episodeStateFile = path.join(episodeDir, 'episode_state.json');
    const stateData = JSON.parse(fs.readFileSync(episodeStateFile, 'utf8'));
    const totalScenes = stateData.total_scenes;
    const scriptPath = path.join(episodeDir, '01_script', 'script.json');
    let scriptJson = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    if (Array.isArray(scriptJson)) scriptJson = { scenes: scriptJson };

    const log = (msg) => {
        console.log(`[Scrap Assembly] ${msg}`);
        if (ws) ws.send(JSON.stringify({ type: 'agent_log', text: `[Scrap Assembly] ${msg}` }));
        if (ws) ws.send(JSON.stringify({ type: 'pipeline_log', text: msg }));
    };
    const setStatus = (status) => {
        if (ws) ws.send(JSON.stringify({ type: 'pipeline_status', status }));
    };

    setStatus('Rendering');

    const exec = require('child_process').exec;
    const ffmpegPath = require('ffmpeg-static');
    const runFfmpeg = (cmd) => new Promise((resolve, reject) => {
        const fullCmd = cmd.replace(/^ffmpeg\s+/, `"${ffmpegPath}" `);
        exec(fullCmd, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });

    const rawClipsDir = path.join(episodeDir, '03_raw_clips');
    const clipsDir = path.join(episodeDir, '04_clips');
    const finalDir = path.join(episodeDir, '05_final');
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
    if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

    const clipsListPath = path.join(clipsDir, 'clips_list.txt');
    const finalVideoPath = path.join(finalDir, 'final_episode.mp4');

    let clipsListContent = '';

    // Title Card with Voice and normalization
    const titleCardAsset = path.join(ASSETS_DIR, 'title_card.mp4');
    const titleClipPath = path.join(clipsDir, 'scene_000_title.mp4');
    if (fs.existsSync(titleCardAsset)) {
        if (!fs.existsSync(titleClipPath)) {
            log(`Generating normalized Title Card with voice...`);
            const titleVoicePath = path.join(episodeDir, '02_audio', 'title_voice.wav');
            if (!fs.existsSync(titleVoicePath)) {
                await generateStandaloneTTS("Scrap and Spark!", titleVoicePath, log);
            }
            // Use apad + shortest to guarantee exact length matching the video asset perfectly
            await runFfmpeg(`ffmpeg -y -i "${titleCardAsset}" -i "${titleVoicePath}" -filter_complex "[1:a]apad[aud]" -map 0:v:0 -map "[aud]" -shortest -vf "scale=1280:720,fps=24,format=yuv420p" -c:v ${GLOBAL_VIDEO_ENCODER} -c:a aac -b:a 192k "${titleClipPath}"`);
        }
        clipsListContent += `file 'scene_000_title.mp4'\n`;

        // Generate High-CTR Dynamic Thumbnail using actual episode 3D scene frames
        const thumbnailBasePath = path.join(finalDir, 'thumbnail_base.png');
        const thumbnailPath = path.join(finalDir, 'thumbnail.png');
        if (!fs.existsSync(thumbnailPath)) {
            log(`Generating dynamic high-CTR thumbnail from episode scene art...`);

            const epMatch = episodeDir.match(/EP(\d+)/i);
            const epNum = epMatch ? parseInt(epMatch[1]) : 1;
            const epTitle = scriptJson.title || "A Backyard Adventure";
            
            // Clean action hook for thumbnail text (e.g., "MINI CATAPULT BUILD!")
            let cleanActionHook = epTitle.replace(/^Scrap\s*&\s*Spark\s*:?\s*/i, '').replace(/Episode\s*\d+\s*[-:]?\s*/i, '').trim();
            if (cleanActionHook.length > 28) cleanActionHook = cleanActionHook.substring(0, 26) + '...';
            const topText = cleanActionHook.toUpperCase();
            const bottomText = `WILL IT WORK?! (EP ${epNum})`;

            // 1. Look for the best action frame in 03_frames (prefer scenes 7, 8, 6, 5, 9)
            const framesDir = path.join(episodeDir, '03_frames');
            let chosenFrame = null;
            const preferredScenes = ['scene_007.png', 'scene_008.png', 'scene_006.png', 'scene_005.png', 'scene_009.png', 'scene_010.png', 'scene_001.png'];
            for (const sc of preferredScenes) {
                const candidate = path.join(framesDir, sc);
                if (fs.existsSync(candidate)) {
                    chosenFrame = candidate;
                    break;
                }
            }

            if (chosenFrame) {
                log(`    -> Using high-res scene frame for thumbnail: ${path.basename(chosenFrame)}`);
                fs.copyFileSync(chosenFrame, thumbnailBasePath);
            } else {
                const standardThumbPath = path.join(ASSETS_DIR, 'thumbnail_base.png');
                if (fs.existsSync(standardThumbPath)) {
                    fs.copyFileSync(standardThumbPath, thumbnailBasePath);
                } else {
                    await runFfmpeg(`ffmpeg -y -ss 00:00:01 -i "${titleCardAsset}" -vframes 1 -q:v 2 "${thumbnailBasePath}"`);
                }
            }

            try {
                const escapedTop = topText.replace(/'/g, '’').replace(/:/g, '\\:');
                const escapedBottom = bottomText.replace(/'/g, '’').replace(/:/g, '\\:');
                // Use impact.ttf for modern YouTube viral style with heavy outline + drop shadow
                await runFfmpeg(`ffmpeg -y -i "${thumbnailBasePath}" -vf "scale=1280:720,drawtext=fontfile=C\\\\:/Windows/Fonts/impact.ttf:text='${escapedTop}':fontcolor=yellow:fontsize=70:x=(w-text_w)/2:y=50:borderw=6:bordercolor=black:shadowcolor=black:shadowx=4:shadowy=4,drawtext=fontfile=C\\\\:/Windows/Fonts/impact.ttf:text='${escapedBottom}':fontcolor=white:fontsize=50:x=(w-text_w)/2:y=h-text_h-50:borderw=5:bordercolor=black:shadowcolor=black:shadowx=3:shadowy=3" "${thumbnailPath}"`);
                log(`    ✓ Dynamic thumbnail rendered successfully!`);
            } catch (err) {
                log(`    -> Warning: Font burn failed (${err.message}). Using raw base image.`);
                fs.copyFileSync(thumbnailBasePath, thumbnailPath);
            }
        }
    }

    // Process each scene (no subtitle burn-in — documentary narration style)
    for (const scene of scriptJson.scenes) {
        const sceneNum = String(scene.scene_number).padStart(2, '0');
        const sceneNumPad3 = String(scene.scene_number).padStart(3, '0');
        const rawVeoPath = path.join(rawClipsDir, `scene_${sceneNum}.mp4`);
        const syncedClipPath = path.join(clipsDir, `synced_${sceneNumPad3}.mp4`);
        const audioPath = scene.audioPath || path.join(episodeDir, '02_audio', `scene_${sceneNumPad3}.wav`);

        if (!fs.existsSync(syncedClipPath) || fs.statSync(syncedClipPath).size < 10000) {
            log(`Syncing scene ${scene.scene_number} (audio + video)...`);

            const combinedText = (scene.dialogue || []).map(line => line.text).join(' ');
            // Strip out annoying TTS onomatopoeia like "Bzzzt!"
            let cleanSub = combinedText.replace(/\b(Bzzzt|Bzzt|Bzz)\b[!?.,]*/ig, '').replace(/\s+/g, ' ').trim();
            cleanSub = cleanSub.replace(/'/g, '’').replace(/:/g, '\\:').replace(/"/g, '');

            // Auto word-wrap subtitles (max 40 chars per line) so they don't get cut off on the sides
            let words = cleanSub.split(' ');
            let subLines = [];
            let cur = "";
            for (let w of words) {
                if (cur.length + w.length > 40) { subLines.push(cur.trim()); cur = w + " "; }
                else cur += w + " ";
            }
            if (cur.trim().length > 0) subLines.push(cur.trim());

            const subTxtName = `temp_sub_${sceneNumPad3}_${Date.now()}.txt`;
            const subTxtPath = path.join(process.cwd(), subTxtName);
            fs.writeFileSync(subTxtPath, subLines.join('\n'));

            // Perfect un-stretched 720p scaling with black padding + Subtitle burn-in via textfile
            const watermarkAsset = path.join(ASSETS_DIR, 'channel_watermark.png');
            let filterGraph;
            let ffmpegCmd;

            if (fs.existsSync(watermarkAsset)) {
                filterGraph = `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1:color=black,drawtext=fontfile=C\\\\:/Windows/Fonts/comic.ttf:textfile='${subTxtName}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-text_h-50:borderw=3:bordercolor=black,fps=24,format=yuv420p,split[v1][v2];[v2]reverse[r];[v1][r]concat=n=2:v=1[basev];[2:v]scale=120:-1[wmk];[basev][wmk]overlay=W-w-50:H-h-60[v]`;
                ffmpegCmd = `ffmpeg -y -i "${rawVeoPath}" -i "${audioPath}" -i "${watermarkAsset}" -filter_complex "${filterGraph}" -map "[v]" -map 1:a -shortest -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p -c:a aac -b:a 192k "${syncedClipPath}"`;
            } else {
                filterGraph = `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1:color=black,drawtext=fontfile=C\\\\:/Windows/Fonts/comic.ttf:textfile='${subTxtName}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-text_h-50:borderw=3:bordercolor=black,fps=24,format=yuv420p,split[v1][v2];[v2]reverse[r];[v1][r]concat=n=2:v=1[v]`;
                ffmpegCmd = `ffmpeg -y -i "${rawVeoPath}" -i "${audioPath}" -filter_complex "${filterGraph}" -map "[v]" -map 1:a -shortest -c:v ${GLOBAL_VIDEO_ENCODER} -pix_fmt yuv420p -c:a aac -b:a 192k "${syncedClipPath}"`;
            }

            await runFfmpeg(ffmpegCmd);
            try { fs.unlinkSync(subTxtPath); } catch (e) { }
            log(`  ✓ Synced scene ${scene.scene_number}`);
        }
        clipsListContent += `file 'synced_${sceneNumPad3}.mp4'\n`;
    }

    // End Card normalization with voice
    const endCardAsset = path.join(ASSETS_DIR, 'end_card.mp4');
    const endClipPath = path.join(clipsDir, 'scene_999_end.mp4');
    if (fs.existsSync(endCardAsset)) {
        if (!fs.existsSync(endClipPath)) {
            log(`Generating normalized End Card with voice...`);
            const endVoicePath = path.join(episodeDir, '02_audio', 'end_voice.wav');
            if (!fs.existsSync(endVoicePath)) {
                await generateStandaloneTTS("See you next time!", endVoicePath, log);
            }
            await runFfmpeg(`ffmpeg -y -i "${endCardAsset}" -i "${endVoicePath}" -filter_complex "[1:a]apad[aud]" -map 0:v:0 -map "[aud]" -shortest -vf "scale=1280:720,fps=24,format=yuv420p" -c:v ${GLOBAL_VIDEO_ENCODER} -c:a aac -b:a 192k "${endClipPath}"`);
        }
        clipsListContent += `file 'scene_999_end.mp4'\n`;
    }

    fs.writeFileSync(clipsListPath, clipsListContent);

    // Final concat + BGM
    setStatus('Stitching');
    log(`Stitching all scenes and mixing BGM...`);
    const stitchedPath = path.join(finalDir, 'stitched_no_bgm.mp4');
    await runFfmpeg(`ffmpeg -y -f concat -safe 0 -i "${clipsListPath}" -c copy "${stitchedPath}"`);

    const bgmPath = path.join(ASSETS_DIR, 'bgm.wav');
    if (fs.existsSync(bgmPath)) {
        log(`Mixing CC0 BGM with Timeline Ducking...`);
        // Helper to probe duration accurately using ffmpeg-static
        const getDuration = (filePath) => {
            try {
                const ffmpegPath = require('ffmpeg-static');
                require('child_process').execSync(`"${ffmpegPath}" -i "${filePath}"`, { stdio: 'pipe' });
            } catch (e) {
                const out = (e.stderr || e.stdout || '').toString();
                const match = out.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
                if (match) return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
            }
            log(`[Warning] FFmpeg probe failed for ${path.basename(filePath)}. Guessing duration.`);
            return 4.0;
        };
        const titleDur = getDuration(titleClipPath);
        const endDur = getDuration(endClipPath);
        const totalDur = getDuration(stitchedPath);
        const duckStart = titleDur;
        const duckEnd = totalDur - endDur;

        // Timeline ducking: 0.04 (4% volume) during clips so dialogue is extremely clear, 1.0 (full) during title and end cards. Normalize=0 ensures no overall drop.
        await runFfmpeg(`ffmpeg -y -i "${stitchedPath}" -i "${bgmPath}" -filter_complex "[1:a]volume='if(between(t,${duckStart},${duckEnd}),0.015,1.0)'[bgm_ducked]; [0:a][bgm_ducked]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k "${finalVideoPath}"`);
    } else {
        fs.copyFileSync(stitchedPath, finalVideoPath);
    }

    // Update episode state to PENDING_REVIEW
    fs.writeFileSync(episodeStateFile, JSON.stringify({
        ...stateData,
        status: 'PENDING_REVIEW',
        pending_review: true,
        pending_episode_path: finalVideoPath,
        review_started_at: Date.now(),
        current_title: scriptJson.title || "Scrap & Spark Episode"
    }, null, 2));

    setStatus('Complete');
    log('Episode assembled successfully!');
    log(`Episode rendered and awaiting review. Auto-uploading in 10 minutes.`);

    // Generate Shorts
    try {
        await generateShorts(episodeDir, scriptJson, runFfmpeg, log);
    } catch (shortsErr) {
        log(`[WARNING] Shorts generation failed: ${shortsErr.message}. Continuing with main upload.`);
    }

    // Send voice notification
    if (ws) {
        const { streamTTS } = require('./elevenlabs_tts');
        const alertMsg = "Sir, the Scrap and Spark assembly has completed and is awaiting review. Uploading automatically in 10 minutes.";
        streamTTS(alertMsg, ws,
            (audioBase64, format) => ws.send(JSON.stringify({ type: 'tts_audio', audioBase64, format })),
            () => { }, (err) => console.warn(err)
        );
    }
    // Start the countdown timer for upload
    updatePipelineState({
        status: 'PENDING_REVIEW',
        pending_review: true,
        pending_episode_path: episodeDir,
        review_started_at: Date.now(),
        current_title: scriptJson.title || "Scrap & Spark Episode"
    });
    startReviewTimer(ws);

    return finalVideoPath;
}

async function generateShorts(episodeDir, scriptJson, runFfmpeg, log) {
    log('Generating Vertical Shorts (9:16) & Instagram Package...');
    const ASSETS_DIR = 'D:\\youtube\\assets';
    const finalDir = path.join(episodeDir, '05_final');
    const finalVideoPath = path.join(finalDir, 'final_episode.mp4');

    if (!fs.existsSync(finalVideoPath)) {
        throw new Error("Cannot generate Shorts: final_episode.mp4 not found.");
    }

    const shortsOutroVideo = path.join(finalDir, 'shorts_outro.mp4');

    // Step 1: Outro Video Generation (Use Master Video Asset if available)
    const masterOutroVideo = path.join(ASSETS_DIR, 'shorts_outro.mp4');
    if (fs.existsSync(masterOutroVideo)) {
        log('    -> Using Master Shorts Outro from assets (D:\\youtube\\assets\\shorts_outro.mp4)...');
        await runFfmpeg(`ffmpeg -y -i "${masterOutroVideo}" -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]" -map "[v]" -map 0:a? -c:v ${GLOBAL_VIDEO_ENCODER} -c:a aac -b:a 192k "${shortsOutroVideo}"`);
    } else {
        const shortsCtaSubject = "Vertical macro view of a giant dandelion seed head against a bright blue sky, with a tiny copper robot clinging to the stem. Scrap";
        const generatedOutroImg = await getOrGenerateAsset('backgrounds', 'shorts_cta_bg', shortsCtaSubject, log);
        const shortsOutroImgFallback = path.join(finalDir, 'shorts_outro_fallback.png');
        const shortsOutroAudio = path.join(finalDir, 'shorts_cta.wav');

        let currentOutroImg = generatedOutroImg;
        const standardCtaPath = path.join(ASSETS_DIR, 'shorts_cta_bg.png');
        const standardCtaJpg = path.join(ASSETS_DIR, 'shorts_cta_bg.jpg');

        if (fs.existsSync(standardCtaPath)) {
            currentOutroImg = standardCtaPath;
            log('    -> Using standard Shorts CTA image (.png)');
        } else if (fs.existsSync(standardCtaJpg)) {
            currentOutroImg = standardCtaJpg;
            log('    -> Using standard Shorts CTA image (.jpg)');
        } else if (!generatedOutroImg || !fs.existsSync(generatedOutroImg)) {
            log('    -> Shorts CTA generation failed. Generating fallback cyan placeholder...');
            await runFfmpeg(`ffmpeg -y -f lavfi -i color=c=cyan:s=1080x1920:d=1 -frames:v 1 "${shortsOutroImgFallback}"`);
            currentOutroImg = shortsOutroImgFallback;
        }

        if (!fs.existsSync(shortsOutroAudio)) {
            log('    -> Generating Shorts CTA TTS...');
            await generateStandaloneTTS("Subscribe for more!", shortsOutroAudio, log);
        }

        log('    -> Compiling Shorts Outro...');
        await runFfmpeg(`ffmpeg -y -loop 1 -i "${currentOutroImg}" -i "${shortsOutroAudio}" -filter_complex "[1:a]apad[aud]" -map 0:v:0 -map "[aud]" -shortest -vf "scale=1080:1920,fps=24,format=yuv420p" -c:v ${GLOBAL_VIDEO_ENCODER} -c:a aac -b:a 192k -t 3 "${shortsOutroVideo}"`);
    }

    // Step 2: Dynamic Blurred-Background 9:16 Vertical Video (No Black Bars!)
    const croppedEpisodePath = path.join(finalDir, 'shorts_cropped.mp4');
    const shortsEpisodePath = path.join(finalDir, 'shorts_episode.mp4');
    const listPath = path.join(finalDir, 'shorts_list.txt');

    log('    -> Rendering 9:16 vertical video with immersive blurred background and top hook...');
    
    // Extract short title hook without hashtags or emojis for ffmpeg text burn
    const rawShortHook = (scriptJson.shorts_meta?.title || scriptJson.title || "CAN THEY BUILD IT?!")
        .replace(/#\w+/g, '')
        .replace(/[^\w\s\?!–—\-]/g, '')
        .trim();
    const shortHook = (rawShortHook.length > 30 ? rawShortHook.substring(0, 28) + '...' : rawShortHook).toUpperCase();
    const escapedHook = shortHook.replace(/'/g, '’').replace(/:/g, '\\:');

    await runFfmpeg(`ffmpeg -y -t 55 -i "${finalVideoPath}" -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.05[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,drawtext=fontfile=C\\\\:/Windows/Fonts/impact.ttf:text='${escapedHook}':fontcolor=yellow:fontsize=52:x=(w-text_w)/2:y=180:borderw=5:bordercolor=black:shadowcolor=black:shadowx=3:shadowy=3,drawtext=fontfile=C\\\\:/Windows/Fonts/arialbd.ttf:text='SUBSCRIBE FOR FULL EPISODE!':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-220:borderw=4:bordercolor=black:shadowcolor=black:shadowx=2:shadowy=2[v]" -map "[v]" -map 0:a? -c:v ${GLOBAL_VIDEO_ENCODER} -c:a aac -b:a 192k "${croppedEpisodePath}"`);

    log('    -> Assembling final Shorts video...');
    fs.writeFileSync(listPath, `file 'shorts_cropped.mp4'\nfile 'shorts_outro.mp4'\n`);
    await runFfmpeg(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${shortsEpisodePath}"`);

    // Step 3: Instagram Package
    log('    -> Preparing Instagram Reels package...');
    const igDir = path.join(episodeDir, 'Instagram_Ready');
    fs.mkdirSync(igDir, { recursive: true });

    const igReelPath = path.join(igDir, 'ig_reel.mp4');
    fs.copyFileSync(shortsEpisodePath, igReelPath);

    const igDescPath = path.join(igDir, 'ig_description.txt');
    const igTitle = scriptJson.shorts_meta?.title?.replace(/#\w+/g, '').trim() || 'Wait until the end! 😱';
    const igDesc = `Can Scrap & Spark make this work?! ⚙️✨\n\n${igTitle}\n\nMeet Scrap, the 3-inch robot, and Spark, his mechanical bee! In this episode they solve a miniature engineering puzzle using everyday backyard items.\n\n💬 QUESTION: What invention should they build in the next episode? Drop your craziest ideas below! 👇\n\n👉 Follow @ScrapAndSpark for daily miniature adventures!\n📺 Watch the full 4K episode on YouTube (link in bio)!\n\n.\n#scrapandspark #miniaturerobots #3danimation #diyengineering #stemkids #satisfyingcrafts #stopmotionstyle #macroshot`;
    fs.writeFileSync(igDescPath, igDesc);

    log(`    ✓ Shorts generation complete: ${shortsEpisodePath}`);
    log(`    ✓ Instagram package ready: ${igDir}`);
}

module.exports = {
    produceScrapEpisode,
    assembleScrapEpisode,
    getPipelineState,
    updatePipelineState,
    startReviewTimer,
    executeUpload,
    cancelUpload,
    generateCharacterSprites,
    buildSpriteManifest,
    generateShorts
};

