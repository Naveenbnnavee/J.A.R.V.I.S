const axios = require('axios');

/**
 * Trigger a MacroDroid webhook on the user's phone.
 * @param {string} action - 'lock' or 'unlock'
 */
async function executePhoneCommand(action) {
    const deviceId = process.env.MACRODROID_DEVICE_ID;
    if (!deviceId) {
        throw new Error("MACRODROID_DEVICE_ID is not configured in .env");
    }
    
    // Webhook URL: https://trigger.macrodroid.com/[DEVICE_ID]/[action]_phone
    const url = `https://trigger.macrodroid.com/${deviceId}/${action}_phone`;
    
    try {
        console.log(`[PhoneBridge] Sending '${action}' command to MacroDroid...`);
        const response = await axios.get(url);
        
        if (response.status === 200) {
            return `Successfully sent the ${action} command to the phone.`;
        } else {
            return `Command sent, but received unexpected status: ${response.status}`;
        }
    } catch (e) {
        console.error(`[PhoneBridge] MacroDroid webhook failed:`, e.message);
        throw new Error(`Failed to contact the phone via MacroDroid: ${e.message}`);
    }
}

module.exports = { executePhoneCommand };
