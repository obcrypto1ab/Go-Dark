// Set Vercel execution timeout limit (if you are on a Pro plan, this extends the 10s default)
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  // 1. Enforce strict POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
  }

  // 2. Safely read environment variable (NEVER exposed to frontend)
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) {
    console.error('[GoDark Backend] Critical: HF_TOKEN is missing in Vercel environment.');
    return res.status(500).json({ error: 'Server Configuration Error: Missing API Token.' });
  }

  // 3. Validate input
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Invalid or empty prompt provided.' });
  }

  // 4. Model Configuration
  const MODEL_ID = 'cerspense/zeroscope_v2_576w';
  // Using the modern Inference Router, strictly avoiding the deprecated api-inference domain
  const HF_ROUTER_URL = `https://router.huggingface.co/hf-inference/models/${MODEL_ID}`;

  // 5. Setup safe timeout (Vercel Hobby standard is 10s, but we configure 55s just in case)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);

  try {
    console.log(`[GoDark Backend] Initiating generation for prompt: "${prompt.substring(0, 40)}..."`);
    
    const response = await fetch(HF_ROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 6. Handle specific Hugging Face error states
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson = {};
      try { errorJson = JSON.parse(errorText); } catch(e) {}

      const status = response.status;
      console.error(`[GoDark Backend] Upstream Error (${status}):`, errorText);

      if (status === 401) return res.status(401).json({ error: 'Unauthorized: Invalid server API token.' });
      if (status === 403) return res.status(403).json({ error: 'Forbidden: Access to this model is restricted.' });
      if (status === 404) return res.status(404).json({ error: 'This model is not currently available through the selected Hugging Face inference flow.' });
      if (status === 429) return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment and try again.' });
      if (status === 503) {
         const estimatedTime = errorJson.estimated_time ? Math.round(errorJson.estimated_time) : 'unknown';
         return res.status(503).json({ error: `The AI model is currently booting up. Estimated time: ${estimatedTime} seconds. Please try again.` });
      }

      return res.status(status).json({ error: errorJson.error || `Upstream provider error: ${status}` });
    }

    // 7. Validate response type
    const contentType = response.headers.get('content-type');
    if (!contentType || (!contentType.includes('video/') && !contentType.includes('image/'))) {
       console.error('[GoDark Backend] Invalid content type received:', contentType);
       return res.status(502).json({ error: 'Invalid response from model provider. Expected a media file.' });
    }

    // 8. Safely convert binary video stream to Base64 for reliable JSON frontend transport
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Media = buffer.toString('base64');

    console.log('[GoDark Backend] Generation successful, returning media bundle.');
    
    return res.status(200).json({
      success: true,
      mediaBase64: `data:${contentType};base64,${base64Media}`,
      mimeType: contentType
    });

  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[GoDark Backend] Execution Exception:', error);
    
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Generation timed out. The model took too long to respond.' });
    }
    return res.status(500).json({ error: 'Internal server error during media generation.' });
  }
}
