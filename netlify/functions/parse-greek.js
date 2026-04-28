exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { imageBase64, mediaType, manualText } = body;

  // Build the user content
  let userContent = [];

  if (imageBase64 && mediaType) {
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: imageBase64 }
    });
    userContent.push({
      type: "text",
      text: "Please analyze the Koine Greek text visible in this image."
    });
  } else if (manualText) {
    userContent.push({
      type: "text",
      text: `Please analyze this Koine Greek text: ${manualText}`
    });
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: "No image or text provided" }) };
  }

  const systemPrompt = `You are a Koine Greek morphological parser. Respond ONLY with valid JSON, no markdown.

Output this exact shape:
{"translation":{"english":"English translation","note":"one grammatically significant note or empty string"},"words":[{"word":"inflected form","lexical_form":"dictionary form with diacritics","part_of_speech":"noun|verb|adjective|pronoun|article|preposition|conjunction|adverb|particle","person":"1st|2nd|3rd|N/A","number":"singular|plural|N/A","gender":"masculine|feminine|neuter|N/A","case":"nominative|genitive|dative|accusative|vocative|N/A","tense":"present|imperfect|future|aorist|perfect|pluperfect|N/A","voice":"active|middle|passive|middle-passive|N/A","mood":"indicative|subjunctive|optative|imperative|infinitive|participle|N/A","inflected_meaning":"meaning of this form in context","lexical_meaning":"base dictionary meaning","notes":"parsing note or empty string"}]}

Rules: Use N/A for inapplicable categories. Include diacritics on lexical forms. For participles include tense/voice/gender/case/number. For infinitives include tense/voice.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.error?.message || "Anthropic API error" })
      };
    }

    const rawText = data.content.map(b => b.text || "").join("");

    // Strip markdown fences if present
    const clean = rawText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawText, error: "Could not parse JSON from model response" })
      };
    }

    // Support both new shape {translation, words} and legacy array
    const words       = Array.isArray(parsed) ? parsed : (parsed.words || []);
    const translation = Array.isArray(parsed) ? null   : (parsed.translation || null);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words, translation })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
