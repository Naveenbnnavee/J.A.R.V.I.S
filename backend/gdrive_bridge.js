const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(__dirname, 'drive_token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'client_secret.json');

async function getDriveAuth() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error(`Missing ${CREDENTIALS_PATH}. Please provide OAuth credentials.`);
    }

    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    } else {
        return await getNewToken(oAuth2Client);
    }
}

async function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
    console.log('[Drive Bridge] Authorize this app by visiting this url:', authUrl);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve, reject) => {
        rl.question('[Drive Bridge] Enter the code from that page here: ', (code) => {
            rl.close();
            oAuth2Client.getToken(code, (err, token) => {
                if (err) return reject(new Error('Error retrieving access token: ' + err.message));
                oAuth2Client.setCredentials(token);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                console.log('[Drive Bridge] Token stored to', TOKEN_PATH);
                resolve(oAuth2Client);
            });
        });
    });
}

async function getOrCreateFolder(drive, folderName) {
    const res = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive'
    });
    if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id;
    } else {
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder'
        };
        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return folder.data.id;
    }
}

/**
 * Uploads prompts and waits for rendered videos.
 */
async function runDriveBridge(scriptJson, assetsDir, outputClipsDir) {
    console.log(`[Drive Bridge] Connecting to Google Drive...`);
    
    let drive;
    try {
        const authClient = await getDriveAuth();
        drive = google.drive({ version: 'v3', auth: authClient });
    } catch (e) {
        console.error(`[Drive Bridge] Error authenticating to Google Drive:`, e.message);
        throw e;
    }

    const queueFolderId = await getOrCreateFolder(drive, 'Jarvis_Render_Queue');
    const completedFolderId = await getOrCreateFolder(drive, 'Jarvis_Completed_Renders');

    console.log(`[Drive Bridge] Clearing old files from Jarvis_Render_Queue...`);
    try {
        const oldFilesRes = await drive.files.list({
            q: `'${queueFolderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });
        for (const f of oldFilesRes.data.files) {
            try {
                await drive.files.delete({ fileId: f.id });
            } catch (e) {
                console.log(`[Drive Bridge] Skipped deleting old file: ${f.name} (permissions)`);
            }
        }
    } catch (e) {
        console.error(`[Drive Bridge] Failed to clear old files:`, e.message);
    }

    console.log(`[Drive Bridge] Uploading script.json to Jarvis_Render_Queue...`);
    
    const scriptPath = path.join(outputClipsDir, '..', '01_script', 'script.json');
    if (fs.existsSync(scriptPath)) {
        await drive.files.create({
            resource: {
                name: `script.json`,
                parents: [queueFolderId]
            },
            media: {
                mimeType: 'application/json',
                body: fs.createReadStream(scriptPath)
            },
            fields: 'id'
        });
        console.log(`[Drive Bridge] script.json uploaded successfully.`);
    }

    console.log(`[Drive Bridge] Uploading starter frames from 03_frames...`);
    const framesDir = path.join(outputClipsDir, '..', '03_frames');
    if (fs.existsSync(framesDir)) {
        const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
        for (const frame of frames) {
            const framePath = path.join(framesDir, frame);
            await drive.files.create({
                resource: {
                    name: frame,
                    parents: [queueFolderId]
                },
                media: {
                    mimeType: 'image/png',
                    body: fs.createReadStream(framePath)
                },
                fields: 'id'
            });
            console.log(`[Drive Bridge] Uploaded starter frame: ${frame}`);
        }
    }

    console.log(`[Drive Bridge] Polling Jarvis_Completed_Renders every 60 seconds...`);
    let expectedRenders = scriptJson.length;
    let downloadedFiles = new Set(); // Track downloaded files so we don't re-download

    while (downloadedFiles.size < expectedRenders) {
        console.log(`[Drive Bridge] Checking for completed renders (${downloadedFiles.size}/${expectedRenders})...`);
        
        try {
            const res = await drive.files.list({
                q: `'${completedFolderId}' in parents and mimeType='video/mp4' and trashed=false`,
                fields: 'files(id, name)'
            });

            const files = res.data.files;
            
            for (let file of files) {
                if (!downloadedFiles.has(file.name)) {
                    console.log(`[Drive Bridge] Downloading ${file.name}...`);
                    const dest = path.join(outputClipsDir, file.name);
                    const destStream = fs.createWriteStream(dest);
                    
                    const response = await drive.files.get(
                        { fileId: file.id, alt: 'media' },
                        { responseType: 'stream' }
                    );
                    
                    await new Promise((resolve, reject) => {
                        response.data
                            .on('end', () => resolve())
                            .on('error', err => reject(err))
                            .pipe(destStream);
                    });

                    console.log(`[Drive Bridge] Saved ${file.name} to 04_clips. Deleting from cloud...`);
                    try {
                        await drive.files.delete({ fileId: file.id });
                    } catch (deleteErr) {
                        if (deleteErr.code === 403 || (deleteErr.message && deleteErr.message.includes('permission'))) {
                            console.log("[Drive Bridge] Skipping cloud deletion due to cross-account ownership.");
                        } else {
                            throw deleteErr;
                        }
                    }
                    downloadedFiles.add(file.name);
                }
            }
        } catch (err) {
            console.error(`[Drive Bridge] Error while polling or downloading: ${err.message}`);
        }

        if (downloadedFiles.size < expectedRenders) {
            await new Promise(r => setTimeout(r, 60000)); // wait 60s before next poll
        }
    }
    
    console.log(`[Drive Bridge] All ${expectedRenders} renders downloaded successfully.`);
}

module.exports = { runDriveBridge };
