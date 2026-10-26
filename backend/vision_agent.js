const axios = require('axios');
const screenshot = require('screenshot-desktop');

async function callGeminiVision(base64Image, prompt) {
    const key = process.env.GEMINI_API_KEY_1; // Use the main key
    if (!key) throw new Error("GEMINI_API_KEY_1 is missing in .env");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`;

    const payload = {
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: "image/jpeg",
                            data: base64Image
                        }
                    }
                ]
            }
        ]
    };

    try {
        const response = await axios.post(url, payload);
        if (response.data.candidates && response.data.candidates.length > 0) {
            return response.data.candidates[0].content.parts[0].text;
        }
        return "I could not extract information from the image.";
    } catch (error) {
        const errorMsg = error.response ? `${error.response.status} - ${JSON.stringify(error.response.data)}` : error.message;
        console.error(`[Vision Agent Error]`, errorMsg);
        throw new Error(`Vision API Failed: ${errorMsg}`);
    }
}

async function analyzeScreen(prompt = "Briefly describe what is currently on my screen in 1-2 sentences.") {
    try {
        const imgBuffer = await screenshot({ format: 'jpg' });
        const base64Image = imgBuffer.toString('base64');
        return await callGeminiVision(base64Image, prompt);
    } catch (error) {
        console.error("[Screen Capture Error]", error);
        throw error;
    }
}

async function analyzeWebcamFrame(base64Image, prompt = "Briefly describe the object or person visible in this webcam frame.") {
    // Strip data URL prefix if present
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
    return await callGeminiVision(cleanBase64, prompt);
}

module.exports = { analyzeScreen, analyzeWebcamFrame };
