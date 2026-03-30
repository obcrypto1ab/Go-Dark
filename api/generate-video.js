export default async function handler(req, res) {
    // 1. Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    // 2. Validate Environment Token
    const HF_TOKEN = process.env.HF_TOKEN;
    if (!HF_TOKEN) {
        console.error('[GoDark Backend Error] Missing HF_TOKEN environment variable.');
        return res.status(500).json({ error: 'Server configuration error: Missing Hugging Face API Token in environment variables.' });
    }

    // 3. Validate Input Payload
    const { inputs } = req.body;
    if (!inputs) {
        console.error('[GoDark Backend Error] Missing prompt inputs in request body.');
        return res.status(400).json({ error: 'Missing prompt inputs. Please provide a narrative script.' });
    }

    try {
        console.log(`[GoDark Backend] Initiating generation for prompt: "${inputs.substring(0, 50)}..."`);
        
        // 4. Send Request to Hugging Face
        const hfResponse = await fetch('https://api-inference.huggingface.co/models/cerspense/zeroscope_v2_576w', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HF_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ inputs })
        });

        // 5. Handle Hugging Face Errors (Warmup, Rate Limits, Invalid Token, etc.)
        if (!hfResponse.ok) {
            const contentType = hfResponse.headers.get('content-type');
            
            if (contentType && contentType.includes('application/json')) {
                const errorData = await hfResponse.json();
                console.error('[GoDark Backend Error] Hugging Face returned JSON error:', errorData);
                
                // Handle Model Loading/Warmup specifically
                if (errorData.error && errorData.error.includes("currently loading")) {
                    const waitTime = Math.ceil(errorData.estimated_time || 30);
                    return res.status(503).json({ 
                        error: `Model is warming up on the server. Estimated wait: ${waitTime} seconds. Please try again shortly.` 
                    });
                }
                
                // Handle rate limits or other custom HF messages
                return res.status(hfResponse.status).json({ error: errorData.error || 'Hugging Face Inference API failed.' });
            } else {
                // Non-JSON error fallback
                const errorText = await hfResponse.text();
                console.error(`[GoDark Backend Error] Hugging Face returned Status ${hfResponse.status} - Text:`, errorText);
                return res.status(hfResponse.status).json({ error: `Hugging Face API returned an unexpected status: ${hfResponse.status}.` });
            }
        }

        // 6. Process Successful Video Blob
        console.log('[GoDark Backend] Successfully received response from Hugging Face. Processing blob...');
        const arrayBuffer = await hfResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        console.log(`[GoDark Backend] Video buffer size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

        // 7. Stream the Video Back to the Frontend
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', buffer.length);
        return res.status(200).send(buffer);

    } catch (error) {
        console.error('[GoDark Backend Fatal Error] Unhandled exception:', error);
        return res.status(500).json({ error: 'Internal server error during video generation. Network failure or timeout.', details: error.message });
    }
}
