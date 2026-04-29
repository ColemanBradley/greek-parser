const crypto = require('crypto');

// ── Google Sheets helpers ────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getAccessToken(email, rawKey) {
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };
  const header  = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const jwt = `${unsigned}.${sig}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function sheetsGet(token, sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsUpdate(token, sheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  return res.json();
}

async function sheetsAppend(token, sheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  return res.json();
}

const COLUMNS = ['Lexical Form','Gloss','Part of Speech','Inflected Forms Seen','Language','Date Added','Parse Count'];

async function ensureHeaders(token, sheetId, sheetName) {
  const res = await sheetsGet(token, sheetId, `${sheetName}!A1:G1`);
  const row = res.values?.[0];
  if (!row || row[0] !== 'Lexical Form') {
    await sheetsUpdate(token, sheetId, `${sheetName}!A1:G1`, [COLUMNS]);
  }
}

async function writeParsedWords(words) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) return;

  const token = await getAccessToken(SA_EMAIL, SA_KEY);
  const sheetName = 'Greek';
  await ensureHeaders(token, SHEET_ID, sheetName);

  // Fetch all existing rows once
  const res  = await sheetsGet(token, SHEET_ID, `${sheetName}!A:G`);
  const rows = res.values || [];

  for (const word of words) {
    if (!word.lexical_form) continue;
    const rowIdx = rows.slice(1).findIndex(r => r[0] === word.lexical_form);

    if (rowIdx >= 0) {
      // Update existing — add inflected form, increment count
      const existing = rows[rowIdx + 1];
      const forms    = new Set((existing[3] || '').split('|').filter(Boolean));
      if (word.word) forms.add(word.word);
      const newCount = (parseInt(existing[6] || '0') + 1).toString();
      const sheetRow = rowIdx + 2;
      const updated  = [
        existing[0],
        existing[1] || word.lexical_meaning || '',
        existing[2] || word.part_of_speech  || '',
        Array.from(forms).join('|'),
        existing[4] || 'greek',
        existing[5] || new Date().toISOString().split('T')[0],
        newCount,
      ];
      await sheetsUpdate(token, SHEET_ID, `${sheetName}!A${sheetRow}:G${sheetRow}`, [updated]);
      // Update local rows array so subsequent words in same parse see it
      rows[rowIdx + 1] = updated;
    } else {
      // Append new row
      const today  = new Date().toISOString().split('T')[0];
      const newRow = [
        word.lexical_form        || '',
        word.lexical_meaning     || '',
        word.part_of_speech      || '',
        word.word                || '',
        'greek',
        today,
        '1',
      ];
      await sheetsAppend(token, SHEET_ID, `${sheetName}!A:G`, [newRow]);
      rows.push(newRow);
    }
  }
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { imageBase64, mediaType, manualText } = body;

  let userContent = [];
  if (imageBase64 && mediaType) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
    userContent.push({ type: 'text', text: 'Please analyze the Koine Greek text visible in this image.' });
  } else if (manualText) {
    userContent.push({ type: 'text', text: `Please analyze this Koine Greek text: ${manualText}` });
  } else {
    return { statusCode: 400, body: JSON.stringify({ error: 'No image or text provided' }) };
  }

  const systemPrompt = `You are a Koine Greek morphological parser. Respond ONLY with valid JSON, no markdown.

Output this exact shape:
{"translation":{"english":"English translation","note":"one grammatically significant note or empty string"},"words":[{"word":"inflected form","lexical_form":"dictionary form with diacritics","part_of_speech":"noun|verb|adjective|pronoun|article|preposition|conjunction|adverb|particle","person":"1st|2nd|3rd|N/A","number":"singular|plural|N/A","gender":"masculine|feminine|neuter|N/A","case":"nominative|genitive|dative|accusative|vocative|N/A","tense":"present|imperfect|future|aorist|perfect|pluperfect|N/A","voice":"active|middle|passive|middle-passive|N/A","mood":"indicative|subjunctive|optative|imperative|infinitive|participle|N/A","inflected_meaning":"meaning of this form in context","lexical_meaning":"base dictionary meaning","notes":"parsing note or empty string"}]}

Rules: Use N/A for inapplicable categories. Include diacritics on lexical forms. For participles include tense/voice/gender/case/number. For infinitives include tense/voice.`;

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
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' }) };
    }

    const rawText = data.content.map(b => b.text || '').join('');
    const clean   = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not parse JSON from model response. Raw: ' + clean.slice(0, 300) })
      };
    }

    const words       = Array.isArray(parsed) ? parsed : (parsed.words || []);
    const translation = Array.isArray(parsed) ? null   : (parsed.translation || null);

    // Write to Sheets — await it so we see errors in logs
    if (words.length > 0) {
      try {
        await writeParsedWords(words);
        console.log(`Cached ${words.length} words to Google Sheets`);
      } catch(err) {
        console.error('Sheets cache error:', err.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words, translation })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
