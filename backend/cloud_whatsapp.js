const chrono = require('chrono-node');
const axios = require('axios');
require('dotenv').config();

const CLOUD_WORKER_URL = process.env.CLOUD_WORKER_URL || 'https://jarvis-cloud-worker-ynyr.onrender.com';
const CLOUD_SECRET = process.env.CLOUD_WORKER_SECRET || 'Jarviscloudnaveen2003';

/**
 * Natural language offline scheduling for WhatsApp.
 * Uses chrono-node to extract time from the prompt.
 * If time is found, sends a scheduled request to the cloud worker.
 * If no time is found, sends immediately via the cloud worker.
 */
async function scheduleWhatsAppMessage(prompt, targetNumber, message) {
    let sendAt = null;

    // Parse natural language time from the prompt, forcing future dates
    if (prompt) {
        const parsedResults = chrono.parse(prompt, new Date(), { forwardDate: true });
        if (parsedResults && parsedResults.length > 0) {
            // Get the JS Date object for the parsed time
            sendAt = parsedResults[0].start.date().toISOString();
            console.log(`[Jarvis Local] Extracted scheduled time: ${sendAt}`);
        }
    }

    try {
        const payload = {
            type: 'whatsapp',
            target_number: targetNumber,
            message: message
        };

        if (sendAt) {
            payload.sendAt = sendAt;
        }

        const response = await axios.post(`${CLOUD_WORKER_URL}/api/schedule`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-jarvis-secret': CLOUD_SECRET
            }
        });

        if (sendAt) {
            return `Message successfully scheduled for ${new Date(sendAt).toLocaleString()} via the cloud worker.`;
        } else {
            return `Message sent immediately via the cloud worker.`;
        }

    } catch (error) {
        console.error('[Jarvis Local] Error scheduling message via cloud:', error.message);
        throw new Error(`Failed to contact cloud worker: ${error.response?.data?.error || error.message}`);
    }
}

async function cancelScheduledWhatsAppMessage(targetNumber) {
    try {
        // Updated to use the unified delete mechanism if applicable, but assuming it exists on the backend.
        // Wait, did we change the cancel route? Let's check. Assuming the route is still valid or we just pass 'type': whatsapp if needed.
        const payload = { target_number: targetNumber };
        const response = await axios.delete(`${CLOUD_WORKER_URL}/api/cancel-whatsapp`, {
            data: payload,
            headers: {
                'Content-Type': 'application/json',
                'x-jarvis-secret': CLOUD_SECRET
            }
        });
        
        const count = response.data.cancelled_count || 0;
        if (count > 0) {
            return `Successfully cancelled ${count} scheduled message(s) for ${targetNumber}.`;
        } else {
            return `No pending scheduled messages found for ${targetNumber}.`;
        }
    } catch (error) {
        console.error('[Jarvis Local] Error cancelling message via cloud:', error.message);
        throw new Error(`Failed to cancel message: ${error.response?.data?.error || error.message}`);
    }
}

async function scheduleSmartReminder(message, timePrompt, recurrenceType = 'none', endDateStr = null) {
    let sendAt = null;

    if (timePrompt) {
        const parsedResults = chrono.parse(timePrompt, new Date(), { forwardDate: true });
        if (parsedResults && parsedResults.length > 0) {
            sendAt = parsedResults[0].start.date().toISOString();
            console.log(`[Jarvis Local] Extracted reminder scheduled time: ${sendAt}`);
        } else {
            // Fallback if chrono-node fails to parse (e.g. daily reminder with no start time)
            sendAt = new Date().toISOString();
        }
    } else {
        sendAt = new Date().toISOString();
    }

    try {
        let endDateIso = undefined;
        if (recurrenceType === 'range' && endDateStr) {
            const endParsed = chrono.parse(endDateStr, new Date(), { forwardDate: true });
            if (endParsed && endParsed.length > 0) {
                endDateIso = endParsed[0].start.date().toISOString();
            }
        }

        const payload = {
            type: 'reminder',
            message: message,
            sendAt: sendAt,
            recurrenceType: recurrenceType,
            endDate: endDateIso
        };

        const response = await axios.post(`${CLOUD_WORKER_URL}/api/schedule`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-jarvis-secret': CLOUD_SECRET
            }
        });

        return `Cloud calendar reminder successfully set for ${new Date(sendAt).toLocaleString()}.`;
    } catch (error) {
        console.error('[Jarvis Local] Error scheduling cloud reminder:', error.message);
        throw new Error(`Failed to set cloud calendar reminder: ${error.response?.data?.error || error.message}`);
    }
}

module.exports = {
    scheduleWhatsAppMessage,
    cancelScheduledWhatsAppMessage,
    scheduleSmartReminder
};
