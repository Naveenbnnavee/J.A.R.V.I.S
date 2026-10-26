/**
 * Clipboard reading tool.
 * Uses clipboardy for cross-platform clipboard access.
 */

let clipboardy;
try {
    clipboardy = require('clipboardy');
} catch (_) {}

async function readClipboard() {
    if (!clipboardy) {
        throw new Error('clipboardy is not installed. Run: npm install clipboardy in the backend directory.');
    }
    const text = await clipboardy.read();
    if (!text || text.trim().length === 0) {
        return 'The clipboard is currently empty, Sir.';
    }
    return text.trim();
}

module.exports = { readClipboard };
