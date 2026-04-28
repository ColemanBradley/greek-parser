// Identify a biblical passage reference from an image using Claude vision.
// Returns just a reference string like "John 3:16" — cheap, fast, minimal tokens.

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { imageBase64, mediaType } = body;
  if (!imageBase64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: 'No image provided' }) };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        system: 'You identify biblical passage references from images. Respond with ONLY the reference in the format "Book Chapter:Verse" (e.g. "John 3:16" or "1 Cor 13:4-7"). If you see a range use a dash. If you cannot identify a reference, respond with the single word: NONE.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'What biblical passage reference is shown in this image?' }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: data.error?.message || 'Claude API error' }) };

    const raw = (data.content[0]?.text || '').trim();
    if (raw === 'NONE' || !raw) return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: null }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: raw })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
