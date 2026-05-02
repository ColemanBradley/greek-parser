const crypto = require('crypto');

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

const COLUMNS = ['Lexical Form','Gloss','Part of Speech','Inflected Forms Seen','Language','Parse JSON'];

async function ensureHeaders(token, sheetId, sheetName) {
  const res = await sheetsGet(token, sheetId, `${sheetName}!A1:F1`);
  if (res.error) throw new Error(`Sheet tab error: ${JSON.stringify(res.error)}`);
  const row = res.values?.[0];
  if (!row || row[0] !== 'Lexical Form') {
    const upd = await sheetsUpdate(token, sheetId, `${sheetName}!A1:F1`, [COLUMNS]);
    if (upd.error) throw new Error(`Header write error: ${JSON.stringify(upd.error)}`);
  }
}


// ── Check sheet cache for a list of inflected forms ──────────
// Returns { cached: [{wordData, inflectedForm}], uncached: [inflectedForm] }
async function checkCache(inflectedForms, language) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) return { cached: [], uncached: inflectedForms };

  try {
    const token     = await getAccessToken(SA_EMAIL, SA_KEY);
    const sheetName = language === 'hebrew' ? 'Hebrew' : 'Greek';
    const res       = await sheetsGet(token, SHEET_ID, `${sheetName}!A:F`);
    const rows      = res.values || [];
    if (res.error || rows.length < 2) return { cached: [], uncached: inflectedForms };

    const cached   = [];
    const uncached = [];

    for (const form of inflectedForms) {
      const normForm = form.normalize('NFC');
      // Search each row's inflected forms (col D) for this exact form
      const match = rows.slice(1).find(r => {
        const forms = (r[3] || '').split('|').filter(Boolean);
        return forms.some(f => f.normalize('NFC') === normForm);
      });

      if (match && match[5]) {
        // Found with JSON data
        try {
          const wordData = JSON.parse(match[5]);
          // Override word field with the actual inflected form being searched
          wordData.word = form;
          cached.push({ wordData, inflectedForm: form });
        } catch(e) { uncached.push(form); }
      } else {
        uncached.push(form);
      }
    }
    return { cached, uncached };
  } catch(e) {
    console.error('Cache check error:', e.message);
    return { cached: [], uncached: inflectedForms };
  }
}

async function writeParsedWords(words, language) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) return;

  const token     = await getAccessToken(SA_EMAIL, SA_KEY);
  const sheetName = language === 'hebrew' ? 'Hebrew' : 'Greek';
  await ensureHeaders(token, SHEET_ID, sheetName);

  const res  = await sheetsGet(token, SHEET_ID, `${sheetName}!A:F`);
  const rows = res.values || [];
  if (res.error) throw new Error(`Read error: ${JSON.stringify(res.error)}`);

  const newRows   = [];
  const updates   = [];
  const newRowIdx = {};

  for (const word of words) {
    if (!word.lexical_form) continue;
    const normLex = word.lexical_form.normalize('NFC');

    // Already queued in this parse — just update inflected forms
    if (newRowIdx[normLex] !== undefined) {
      const idx   = newRowIdx[normLex];
      const forms = new Set((newRows[idx][3] || '').split('|').filter(Boolean));
      if (word.word) forms.add(word.word);
      newRows[idx][3] = Array.from(forms).join('|');
      continue;
    }

    // Already in sheet — update inflected forms
    const rowIdx = rows.slice(1).findIndex(r => r[0] && r[0].normalize('NFC') === normLex);
    if (rowIdx >= 0) {
      const existing = rows[rowIdx + 1];
      const forms    = new Set((existing[3] || '').split('|').filter(Boolean));
      if (word.word) forms.add(word.word);
      const sheetRow = rowIdx + 2;
      const updated  = [
        normLex,
        existing[1] || word.lexical_meaning || '',
        existing[2] || word.part_of_speech  || '',
        Array.from(forms).join('|'),
        existing[4] || language || 'greek',
        existing[5] || JSON.stringify(word),
      ];
      updates.push({ range: `${sheetName}!A${sheetRow}:F${sheetRow}`, values: [updated] });
      rows[rowIdx + 1] = updated;
    } else {
      // Brand new word
      const newRow = [
        normLex,
        word.lexical_meaning || '',
        word.part_of_speech  || '',
        word.word            || '',
        language             || 'greek',
        JSON.stringify(word),
      ];
      newRowIdx[normLex] = newRows.length;
      newRows.push(newRow);
    }
  }

  if (updates.length > 0) {
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    });
    const r2 = await res2.json();
    if (r2.error) throw new Error(`Batch update error: ${JSON.stringify(r2.error)}`);
  }

  if (newRows.length > 0) {
    const appendRes = await sheetsAppend(token, SHEET_ID, `${sheetName}!A:F`, newRows);
    if (appendRes.error) throw new Error(`Append error: ${JSON.stringify(appendRes.error)}`);
  }

  console.log(`Sheets: ${newRows.length} new, ${updates.length} updated`);
}


// ── Get phrase translation only (cheap — no word-by-word parsing) ──
async function getTranslationOnly(text, language) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return null;

  const lang = language === 'hebrew' ? 'Biblical Hebrew' : 'Koine Greek';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role:'user', content:
          `Translate this ${lang} phrase and provide one brief grammatical note. Respond ONLY with valid JSON, no markdown: {"english":"translation here","note":"one grammatical note or empty string"}\n\nText: ${text}`
        }]
      })
    });
    const data = await res.json();
    if (!res.ok) return null;
    const raw   = data.content.map(b => b.text||'').join('');
    const clean = raw.replace(/\`\`\`json\s*/gi,'').replace(/\`\`\`\s*/gi,'').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('Translation fetch error:', e.message);
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { imageBase64, mediaType, manualText, language } = body;

  // ── Cache-first: if text input, extract words and check sheet ──
  // For image input we can't pre-check (we don't know the words yet)
  // For text input, split on whitespace and check each word first
  let cachedWords = [];
  let wordsToParseFromClaude = null; // null = parse everything, array = parse only these

  if (manualText && !imageBase64) {
    const lang = language || 'greek';
    // Split text into individual words (handles spaces, punctuation)
    const rawWords = manualText.trim().split(/[\s··,;.·]+/).filter(Boolean);
    if (rawWords.length > 0) {
      try {
        const { cached, uncached } = await checkCache(rawWords, lang);
        cachedWords = cached.map(c => c.wordData);
        if (uncached.length === 0) {
          // Everything cached — still get translation (uses Haiku, very cheap)
          console.log(`Full cache hit: ${cachedWords.length} words`);
          const translation = await getTranslationOnly(manualText, language || 'greek');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              words: cachedWords,
              translation,
              fromCache: cachedWords.length,
              fromClaude: 0
            })
          };
        }
        // Partial cache hit — only ask Claude about uncached words
        if (cached.length > 0) {
          wordsToParseFromClaude = uncached;
          console.log(`Partial cache: ${cached.length} cached, ${uncached.length} need Claude`);
        }
      } catch(e) {
        console.error('Pre-check error:', e.message);
        // Fall through to full Claude parse
      }
    }
  }

  // Build the text Claude needs to parse
  const textForClaude = wordsToParseFromClaude
    ? wordsToParseFromClaude.join(' ')
    : manualText;

  let userContent = [];
  if (imageBase64 && mediaType) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
    userContent.push({ type: 'text', text: 'Please analyze the Koine Greek text visible in this image.' });
  } else if (textForClaude) {
    userContent.push({ type: 'text', text: `Please analyze this Koine Greek text: ${textForClaude}` });
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
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();
    if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: data.error?.message || 'Anthropic API error' }) };

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

    if (words.length > 0) {
      try {
        await writeParsedWords(words, language || 'greek');
      } catch(err) {
        console.error('Sheets cache error:', err.message);
      }
    }

    // Merge cached words with Claude words, preserving original order
    const allWords = [...cachedWords, ...words];
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        words: allWords,
        translation,
        fromCache: cachedWords.length,
        fromClaude: words.length
      })
    };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
