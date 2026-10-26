const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');

async function getYouTubeAuth() {
    const credentialsPath = path.join(__dirname, 'client_secret.json');
    const tokenPath = path.join(__dirname, 'token.json');

    if (!fs.existsSync(credentialsPath)) {
        throw new Error('client_secret.json not found in backend directory. Please download OAuth2 Desktop credentials from Google Cloud Console.');
    }

    const content = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    // Support both desktop app ("installed") or web app credentials
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        (redirect_uris && redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob'
    );

    // Check if we have previously stored a token.
    if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    } else {
        return new Promise((resolve, reject) => {
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/youtube.upload'],
            });
            console.log('\n======================================');
            console.log('IMPORTANT: YouTube Authorization Required');
            console.log('Authorize this app by visiting this url:', authUrl);
            console.log('======================================\n');

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            rl.question('Enter the code from that page here: ', (code) => {
                rl.close();
                oAuth2Client.getToken(code, (err, token) => {
                    if (err) return reject(new Error('Error retrieving access token: ' + err.message));
                    oAuth2Client.setCredentials(token);
                    fs.writeFileSync(tokenPath, JSON.stringify(token));
                    console.log('Token stored to', tokenPath);
                    resolve(oAuth2Client);
                });
            });
        });
    }
}

/**
 * Uploads an assembled video to YouTube and schedules it.
 * To maximize reach and viral potential, we set it to public and madeForKids = false.
 */
async function uploadToYouTube(videoPath, scriptJson, episodeNumber, shortsPath = null) {
    console.log(`[YouTube Scheduler] Preparing to upload ${videoPath}...`);

    let youtube;
    try {
        const authClient = await getYouTubeAuth();
        youtube = google.youtube({ version: 'v3', auth: authClient });
    } catch (e) {
        console.error(`[YouTube Scheduler] Authentication failed: ${e.message}`);
        throw e;
    }

    const fileSize = fs.statSync(videoPath).size;

    // --- SEO & Viral Metadata Generation (Scrap & Spark) ---
    const baseTitle = scriptJson.seo?.title || scriptJson.title || "A Backyard Adventure";
    // Place curiosity / action hook first, avoid repetitive brand name duplication
    const cleanActionTitle = baseTitle.replace(/^Scrap\s*&\s*Spark\s*:?\s*/i, '').trim();
    let viralTitle = `${cleanActionTitle} | Scrap & Spark Ep ${episodeNumber || 1}`;
    if (viralTitle.length > 100) viralTitle = viralTitle.substring(0, 97) + '...';

    const defaultViralTags = [
        'scrap and spark',
        '3d animation',
        'diy engineering',
        'miniature robot',
        'stem for kids',
        'science experiment',
        'satisfying build',
        'wall-e',
        'miniature world',
        'robotics for kids',
        'kids cartoons',
        'educational animation',
        'diy crafts',
        'how it works',
        'stop motion style',
        'science for children'
    ];
    const scriptTags = Array.isArray(scriptJson.seo?.tags) ? scriptJson.seo.tags.map(t => String(t).toLowerCase().trim()) : [];
    const viralTags = Array.from(new Set([...scriptTags, ...defaultViralTags])).slice(0, 30);

    const baseDescription = scriptJson.seo?.description || "Join Scrap and Spark on a miniature engineering adventure in the backyard!";
    const viralDescription = `${baseDescription}

⚙️ Meet Scrap, the tiny copper robot, and Spark, his mechanical bee sidekick! Together they explore a giant world from the ground up, solving engineering mysteries using everyday human objects like paperclips, rubber bands, and popsicle sticks.

Perfect for kids who love STEM, building, DIY, and exploring how things work!
🔔 Subscribe for more Scrap & Spark engineering adventures!

${viralTags.slice(0, 10).map(t => '#' + t.replace(/[^a-z0-9]/g, '')).join(' ')} #scrapandspark #stemforkids #kidscartoons #macroanimation`;
    // ---------------------------------------

    try {
        const res = await youtube.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: viralTitle,
                    description: viralDescription,
                    tags: viralTags,
                    categoryId: '27' // Education
                },
                status: {
                    privacyStatus: 'public',
                    selfDeclaredMadeForKids: false // Set to false to allow comments, mini-player, and maximum algorithmic reach
                }
            },
            media: {
                body: fs.createReadStream(videoPath)
            }
        }, {
            onUploadProgress: evt => {
                const progress = (evt.bytesRead / fileSize) * 100;
                process.stdout.write(`\r[YouTube Scheduler] Uploading Long-Form: ${Math.round(progress)}%`);
            }
        });

        const videoId = res.data.id;
        console.log(`\n[YouTube Scheduler] Long-Form Upload successful! Video ID: ${videoId}`);

        // --- Upload Custom Thumbnail (Isolated so failure does NOT re-trigger video upload) ---
        const thumbnailPath = path.join(path.dirname(videoPath), 'thumbnail.png');
        if (fs.existsSync(thumbnailPath)) {
            try {
                console.log(`[YouTube Scheduler] Uploading custom thumbnail: ${thumbnailPath}...`);
                await youtube.thumbnails.set({
                    videoId: videoId,
                    media: {
                        body: fs.createReadStream(thumbnailPath)
                    }
                });
                console.log(`[YouTube Scheduler] Thumbnail uploaded successfully!`);
            } catch (thumbErr) {
                console.warn(`[YouTube Scheduler] Warning: Thumbnail upload failed (${thumbErr.message}). Channel may require phone verification at youtube.com/verify. Long-form video remains published.`);
            }
        } else {
            console.log(`[YouTube Scheduler] No custom thumbnail found at ${thumbnailPath}. Skipping thumbnail upload.`);
        }

        // --- Upload Vertical Short if provided (Isolated to prevent duplicate long-form uploads) ---
        if (shortsPath && fs.existsSync(shortsPath)) {
            try {
                console.log(`\n[YouTube Scheduler] Starting Shorts upload: ${shortsPath}`);
                const shortsSize = fs.statSync(shortsPath).size;
                
                let shortTitle = scriptJson.shorts_meta?.title || `${cleanActionTitle} #Shorts`;
                if (!shortTitle.toLowerCase().includes('#shorts')) shortTitle += ' #Shorts';
                if (shortTitle.length > 100) shortTitle = shortTitle.substring(0, 97) + '...';

                let shortDesc = scriptJson.shorts_meta?.description || "Wait until the end! 😱 Scrap & Spark build something incredible! Subscribe for full episodes.";
                if (!shortDesc.toLowerCase().includes('#shorts')) {
                    shortDesc += "\n\n#shorts #youtubeshorts #viral #animation #diy #robot #stem #miniature #satisfying #scrapandspark";
                }

                const defaultShortsTags = ['shorts', 'youtubeshorts', 'scrap and spark', 'diy', 'stem', 'animation', '3danimation', 'robot', 'satisfying', 'miniature', 'viral', 'viralshorts', 'trending', 'stemforkids', 'satisfyingbuild'];
                const shortsTags = Array.from(new Set([...scriptTags, ...defaultShortsTags])).map(t => String(t).toLowerCase().trim()).slice(0, 25);

                const shortRes = await youtube.videos.insert({
                    part: 'snippet,status',
                    requestBody: {
                        snippet: {
                            title: shortTitle,
                            description: shortDesc,
                            tags: shortsTags,
                            categoryId: '27' // Education
                        },
                        status: {
                            privacyStatus: 'public',
                            selfDeclaredMadeForKids: false // Maximize shorts feed reach
                        }
                    },
                    media: {
                        body: fs.createReadStream(shortsPath)
                    }
                }, {
                    onUploadProgress: evt => {
                        const progress = (evt.bytesRead / shortsSize) * 100;
                        process.stdout.write(`\r[YouTube Scheduler] Uploading Short: ${Math.round(progress)}%`);
                    }
                });
                console.log(`\n[YouTube Scheduler] Shorts Upload successful! Video ID: ${shortRes.data.id}`);
            } catch (shortsErr) {
                console.warn(`[YouTube Scheduler] Warning: Shorts upload failed (${shortsErr.message}). Long-form upload succeeded.`);
            }
        }

        return res.data;
    } catch (e) {
        console.error(`\n[YouTube Scheduler] Long-form video upload failed: ${e.message}`);
        throw e;
    }
}

module.exports = { uploadToYouTube };
