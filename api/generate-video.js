export default async function handler(req, res) {
    // 1. Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // 2. Validate Environment Token
    const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_API_TOKEN) {
        console.error('[GoDark Backend Error] Missing REPLICATE_API_TOKEN environment variable.');
        return res.status(500).json({ error: 'Server configuration error: Missing Replicate API Token in environment variables.' });
    }

    // 3. Validate Input Payload
    const { inputs } = req.body;
    if (!inputs || typeof inputs !== 'string' || inputs.trim() === '') {
        console.error('[GoDark Backend Error] Missing or invalid prompt inputs in request body.');
        return res.status(400).json({ error: 'Missing prompt inputs. Please provide a valid narrative script.' });
    }

    // 4. Configure Replicate Model (Zeroscope V2 576w equivalent)
    const REPLICATE_MODEL_VERSION = "9f747673945c62801b13b84701c783929c0ee784e4748ec062204894dda1a351";
    
    try {
        console.log(`[GoDark Backend] Initiating Replicate prediction for prompt: "${inputs.substring(0, 50)}..."`);
        
        // 5. Create the Prediction
        const createRes = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                version: REPLICATE_MODEL_VERSION,
                input: { prompt: inputs }
            })
        });

        if (!createRes.ok) {
            const errorData = await createRes.json().catch(() => ({}));
            console.error('[GoDark Backend Error] Replicate Prediction Creation Failed:', errorData);
            
            if (createRes.status === 401) return res.status(401).json({ error: 'Unauthorized. Invalid Replicate API token on server.' });
            if (createRes.status === 402) return res.status(402).json({ error: 'Payment required. Replicate billing issue or out of credits.' });
            if (createRes.status === 429) return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
            
            return res.status(createRes.status).json({ error: errorData.detail || 'Failed to start video generation via Replicate.' });
        }

        let prediction = await createRes.json();
        const pollUrl = prediction.urls.get;

        // 6. Poll for Completion (Limit polling to 50 seconds to avoid Vercel 60s timeout limit)
        const startTime = Date.now();
        const timeoutMs = 50000; 

        while (
            prediction.status !== "succeeded" &&
            prediction.status !== "failed" &&
            prediction.status !== "canceled"
        ) {
            if (Date.now() - startTime > timeoutMs) {
                console.error('[GoDark Backend Error] Polling timed out. Vercel execution limit approaching.');
                return res.status(504).json({ error: 'Generation is taking too long for the serverless timeout. Please try again with a shorter prompt.' });
            }

            // Wait 3 seconds before polling again
            await new Promise((resolve) => setTimeout(resolve, 3000));

            const pollRes = await fetch(pollUrl, {
                headers: {
                    'Authorization': `Bearer ${REPLICATE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!pollRes.ok) {
                console.error(`[GoDark Backend Error] Polling failed with status ${pollRes.status}`);
                return res.status(500).json({ error: 'Failed to poll prediction status from Replicate.' });
            }

            prediction = await pollRes.json();
            console.log(`[GoDark Backend] Prediction Status: ${prediction.status}`);
        }

        // 7. Handle Finished States
        if (prediction.status === "failed") {
            console.error('[GoDark Backend Error] Prediction failed:', prediction.error);
            return res.status(500).json({ error: `Replicate model error: ${prediction.error || 'Unknown rendering failure.'}` });
        }

        if (prediction.status === "canceled") {
            return res.status(499).json({ error: 'The video generation was canceled on the Replicate server.' });
        }

        // 8. Extract Output URL
        const output = prediction.output;
        if (!output) {
            return res.status(500).json({ error: 'Prediction succeeded but no output was returned by the model.' });
        }

        // Replicate output might be an array of URLs or a single URL depending on model schema
        const videoUrl = Array.isArray(output) ? output[0] : output;

        if (!videoUrl || typeof videoUrl !== 'string') {
            console.error('[GoDark Backend Error] Invalid output format:', output);
            return res.status(500).json({ error: 'Invalid output format received from the rendering engine.' });
        }

        // 9. Fetch Video File & Proxy it to Frontend
        console.log(`[GoDark Backend] Downloading generated video from: ${videoUrl}`);
        const videoRes = await fetch(videoUrl);
        
        if (!videoRes.ok) {
            console.error('[GoDark Backend Error] Failed to download video from Replicate output URL.');
            return res.status(502).json({ error: 'Successfully generated, but failed to download the final video file.' });
        }

        const arrayBuffer = await videoRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        console.log(`[GoDark Backend] Successfully fetched video. Size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

        // 10. Stream the Video Back to the Frontend
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', buffer.length);
        return res.status(200).send(buffer);

    } catch (error) {
        console.error('[GoDark Backend Fatal Error] Unhandled exception:', error);
        return res.status(500).json({ error: 'Internal server error during video generation. Network failure or timeout.', details: error.message });
    }
}
