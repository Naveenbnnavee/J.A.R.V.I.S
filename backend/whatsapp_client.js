const { exec } = require('child_process');

let waClient = null;
let waReady = false;
let latestQR = null;

function getPhoneNumber(contactName) {
    return contactName.replace(/[^0-9+]/g, '');
}

async function resolveChatId(client, contactName) {
    if (!contactName) return null;
    const cleanName = contactName.toLowerCase().trim();
    if (cleanName === 'me' || cleanName === 'myself') {
        if (client.info && client.info.wid && client.info.wid._serialized) {
            return client.info.wid._serialized;
        }
    }

    // If it's already a clean phone number, use it directly
    const digits = getPhoneNumber(contactName);
    if (digits.length >= 10) {
        return digits.startsWith('+') ? `${digits.slice(1)}@c.us` : `${digits}@c.us`;
    }

    // Otherwise, search synced WhatsApp contacts
    const contacts = await client.getContacts();
    const searchName = contactName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    
    // exact match first
    let match = contacts.find(c => {
        const name = c.name ? c.name.toLowerCase() : '';
        const pushname = c.pushname ? c.pushname.toLowerCase() : '';
        return name === searchName || pushname === searchName;
    });
    if (!match) {
        // partial match
        match = contacts.find(c => {
            const name = c.name ? c.name.toLowerCase() : '';
            const pushname = c.pushname ? c.pushname.toLowerCase() : '';
            return name.includes(searchName) || pushname.includes(searchName);
        });
    }
    
    if (match && match.id && match.id._serialized) {
        return match.id._serialized;
    }
    return null;
}

/**
 * Initialize WhatsApp Web client with LocalAuth for persistent sessions.
 * Prints QR code to terminal on first use.
 */
async function initWhatsApp() {
    if (waClient) return waClient;

    let Client, LocalAuth, qrcode;
    try {
        const wa = require('whatsapp-web.js');
        Client = wa.Client;
        LocalAuth = wa.LocalAuth;
        qrcode = require('qrcode-terminal');
    } catch (err) {
        console.warn('[WhatsApp] whatsapp-web.js not available. Falling back to URI scheme only.');
        return null;
    }

    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    waClient.on('qr', (qr) => {
        latestQR = qr;
        console.log('\n[WhatsApp] Scan this QR code with your phone to connect Jarvis:\n');
        qrcode.generate(qr, { small: true });
    });

    waClient.on('ready', () => {
        waReady = true;
        latestQR = null;
        console.log('[WhatsApp] Client is ready! Jarvis can now send messages.');
    });

    waClient.on('auth_failure', () => {
        waReady = false;
        latestQR = null;
        console.error('[WhatsApp] Authentication failed. Please restart and re-scan the QR code.');
    });

    waClient.on('disconnected', () => {
        waReady = false;
        latestQR = null;
        console.warn('[WhatsApp] Client disconnected.');
    });

    try {
        await waClient.initialize();
    } catch (err) {
        console.error('[WhatsApp] Failed to initialize:', err.message);
        waClient = null;
    }

    return waClient;
}

/**
 * Send a WhatsApp message to a contact (by phone number or name).
 * Falls back to native Windows URI scheme if headless client is unavailable.
 */
async function sendWhatsAppMessage(contactName, message) {
    if (waReady && waClient) {
        try {
            const chatId = await resolveChatId(waClient, contactName);
            if (chatId) {
                await waClient.sendMessage(chatId, message);
                return `WhatsApp message sent to ${contactName}.`;
            } else {
                return `Error: Contact '${contactName}' not found in synced contacts. Ask the user for their exact contact name or phone number (+countrycode...).`;
            }
        } catch (err) {
            return `Error sending message: ${err.message}`;
        }
    }

    // Fallback ONLY if the headless client isn't configured/ready
    const phone = getPhoneNumber(contactName);
    const encodedMsg = encodeURIComponent(message);
    const uri = `start whatsapp://send?phone=${phone}&text=${encodedMsg}`;
    exec(uri);
    return `Opened WhatsApp with native app for ${contactName}. The headless automated client is not ready.`;
}

/**
 * Send a WhatsApp media file (photo, video, document).
 */
async function sendWhatsAppMedia(contactName, filePath) {
    try {
        if (waReady && waClient) {
            const chatId = await resolveChatId(waClient, contactName);
            if (chatId) {
                const wa = require('whatsapp-web.js');
                const MessageMedia = wa.MessageMedia;
                const media = MessageMedia.fromFilePath(path.resolve(process.cwd(), filePath));
                await waClient.sendMessage(chatId, media);
                return `Media sent to ${contactName} via WhatsApp.`;
            } else {
                return `[WhatsApp] Contact '${contactName}' not found in synced contacts. Cannot send media.`;
            }
        }
    } catch (err) {
        return `[WhatsApp] Failed to send media: ${err.message}`;
    }
    return `[WhatsApp] Client not ready. Please wait or scan QR code.`;
}

function getLatestQR() {
    return {
        isReady: waReady,
        qr: latestQR
    };
}

module.exports = { initWhatsApp, sendWhatsAppMessage, sendWhatsAppMedia, getLatestQR };
