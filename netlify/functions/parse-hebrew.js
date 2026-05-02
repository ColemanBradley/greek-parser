const crypto = require('crypto');

// ── Google Sheets helpers (same as parse-greek.js) ──────────
function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getAccessToken(email, rawKey) {
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss:email, scope:'https://www.googleapis.com/auth/spreadsheets', aud:'https://oauth2.googleapis.com/token', exp:now+3600, iat:now };
  const h = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const p = b64url(JSON.stringify(claim));
  const unsigned = `${h}.${p}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey,'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const jwt = `${unsigned}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function sheetsGet(token, sheetId, range) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, { headers:{Authorization:`Bearer ${token}`} });
  return res.json();
}
async function sheetsUpdate(token, sheetId, range, values) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method:'PUT', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({values})
  });
  return res.json();
}
async function sheetsAppend(token, sheetId, range, values) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({values})
  });
  return res.json();
}

const COLUMNS = ['Lexical Form','Gloss','Part of Speech','Inflected Forms Seen','Language','Parse JSON'];

async function ensureHeaders(token, sheetId, sheetName) {
  const res = await sheetsGet(token, sheetId, `${sheetName}!A1:E1`);
  if (res.error) throw new Error(`Sheet tab error: ${JSON.stringify(res.error)}`);
  const row = res.values?.[0];
  if (!row || row[0] !== 'Lexical Form') {
    const upd = await sheetsUpdate(token, sheetId, `${sheetName}!A1:E1`, [COLUMNS]);
    if (upd.error) throw new Error(`Header write error: ${JSON.stringify(upd.error)}`);
  }
}


async function checkCache(inflectedForms) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) return { cached: [], uncached: inflectedForms };
  try {
    const token = await getAccessToken(SA_EMAIL, SA_KEY);
    const res   = await sheetsGet(token, SHEET_ID, 'Hebrew!A:F');
    const rows  = res.values || [];
    if (res.error || rows.length < 2) return { cached: [], uncached: inflectedForms };
    const cached = [], uncached = [];
    for (const form of inflectedForms) {
      const normForm = form.normalize('NFC');
      const match = rows.slice(1).find(r => {
        const forms = (r[3]||'').split('|').filter(Boolean);
        return forms.some(f => f.normalize('NFC') === normForm);
      });
      if (match && match[5]) {
        try {
          const wordData = JSON.parse(match[5]);
          wordData.word = form;
          cached.push({ wordData, inflectedForm: form });
        } catch(e) { uncached.push(form); }
      } else { uncached.push(form); }
    }
    return { cached, uncached };
  } catch(e) {
    console.error('Hebrew cache check error:', e.message);
    return { cached: [], uncached: inflectedForms };
  }
}

async function writeParsedWords(words) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) return;

  const token     = await getAccessToken(SA_EMAIL, SA_KEY);
  const sheetName = 'Hebrew';
  await ensureHeaders(token, SHEET_ID, sheetName);

  const res  = await sheetsGet(token, SHEET_ID, `${sheetName}!A:F`);
  const rows = res.values || [];

  const newRows = [], updates = [], newRowIdx = {};

  for (const word of words) {
    if (!word.lexical_form) continue;
    const normLex = word.lexical_form.normalize('NFC');

    if (newRowIdx[normLex] !== undefined) {
      const idx   = newRowIdx[normLex];
      const forms = new Set((newRows[idx][3]||'').split('|').filter(Boolean));
      if (word.word) forms.add(word.word);
      newRows[idx][3] = Array.from(forms).join('|');
      continue;
    }

    const rowIdx = rows.slice(1).findIndex(r => r[0] && r[0].normalize('NFC') === normLex);
    if (rowIdx >= 0) {
      const existing = rows[rowIdx+1];
      const forms    = new Set((existing[3]||'').split('|').filter(Boolean));
      if (word.word) forms.add(word.word);
      const updated  = [normLex, existing[1]||word.lexical_meaning||'', existing[2]||word.part_of_speech||'', Array.from(forms).join('|'), 'hebrew', existing[5]||JSON.stringify(word)];
      updates.push({ range:`Hebrew!A${rowIdx+2}:F${rowIdx+2}`, values:[updated] });
      rows[rowIdx+1] = updated;
    } else {
      const newRow = [normLex, word.lexical_meaning||'', word.part_of_speech||'', word.word||'', 'hebrew', JSON.stringify(word)];
      newRowIdx[normLex] = newRows.length;
      newRows.push(newRow);
    }
  }

  if (updates.length > 0) {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({valueInputOption:'USER_ENTERED', data:updates})
    });
    const d = await r.json();
    if (d.error) throw new Error(`Batch update error: ${JSON.stringify(d.error)}`);
  }
  if (newRows.length > 0) {
    const appendRes = await sheetsAppend(token, SHEET_ID, 'Hebrew!A:F', newRows);
    if (appendRes.error) throw new Error(`Append error: ${JSON.stringify(appendRes.error)}`);
  }
  console.log(`Hebrew Sheets: ${newRows.length} new, ${updates.length} updated`);
}


// ── Get phrase translation only ──────────────────────────────
async function getTranslationOnly(text) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role:'user', content:
          'Translate this Biblical Hebrew phrase and provide one brief grammatical note. Respond ONLY with valid JSON, no markdown: {"english":"translation here","note":"one grammatical note or empty string"}\n\nText: ' + text
        }]
      })
    });
    const data = await res.json();
    if (!res.ok) return null;
    const raw   = data.content.map(b => b.text||'').join('');
    const clean = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
    return JSON.parse(clean);
  } catch(e) { return null; }
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode:405, body:'Method Not Allowed' };

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode:500, body:JSON.stringify({error:'API key not configured'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON body'}) }; }

  const { imageBase64, mediaType, manualText } = body;

  let cachedWords = [];
  let textForClaude = manualText;

  if (manualText && !imageBase64) {
    const rawWords = manualText.trim().split(/[\s\u05c3\u05be,;.]+/).filter(Boolean);
    if (rawWords.length > 0) {
      try {
        const { cached, uncached } = await checkCache(rawWords);
        cachedWords = cached.map(c => c.wordData);
        if (uncached.length === 0) {
          const translation = await getTranslationOnly(manualText);
          return { statusCode:200, headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ words:cachedWords, translation, fromCache:cachedWords.length, fromClaude:0 }) };
        if (cached.length > 0) textForClaude = uncached.join(' ');
      } catch(e) { console.error('Pre-check error:', e.message); }
    }
  }

  let userContent = [];
  if (imageBase64 && mediaType) {
    userContent.push({ type:'image', source:{ type:'base64', media_type:mediaType, data:imageBase64 } });
    userContent.push({ type:'text', text:'Please analyze the Biblical Hebrew text visible in this image.' });
  } else if (textForClaude) {
    userContent.push({ type:'text', text:`Please analyze this Biblical Hebrew text: ${textForClaude}` });
  } else {
    return { statusCode:400, body:JSON.stringify({error:'No image or text provided'}) };
  }

  const systemPrompt = `You are a Biblical Hebrew morphological parser trained in BHS grammar (Kelley, Waltke-O'Connor, HALOT).

Respond ONLY with valid JSON, no markdown. Output this exact shape:
{"translation":{"english":"English translation of the whole phrase","note":"one grammatically significant note or empty string"},"words":[{"word":"inflected Hebrew form as it appears (with niqqud if present)","lexical_form":"dictionary/lexicon form (with niqqud if possible)","part_of_speech":"noun|verb|adjective|pronoun|article|preposition|conjunction|adverb|particle|suffix","root":"3-letter root in unpointed Hebrew (e.g. ברא)","binyan":"Qal|Niphal|Piel|Pual|Hiphil|Hophal|Hithpael|N/A","stem":"Perfect|Imperfect|Imperative|Infinitive Construct|Infinitive Absolute|Participle Active|Participle Passive|N/A","person":"1st|2nd|3rd|N/A","number":"singular|plural|dual|N/A","gender":"masculine|feminine|common|N/A","state":"absolute|construct|N/A","definiteness":"definite|indefinite|N/A","inflected_meaning":"meaning of this specific form in context","lexical_meaning":"base dictionary meaning","notes":"any important parsing notes, unusual forms, or study helps (empty string if none)"}]}

Rules: Use N/A for inapplicable categories. Include niqqud on lexical forms when possible. Handle both pointed and unpointed text. For verbs always include binyan and stem. For nouns include state and definiteness.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:8000, system:systemPrompt, messages:[{role:'user',content:userContent}] })
    });

    const data = await response.json();
    if (!response.ok) return { statusCode:response.status, body:JSON.stringify({error:data.error?.message||'Anthropic API error'}) };

    const rawText = data.content.map(b => b.text||'').join('');
    const clean   = rawText.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      return { statusCode:200, headers:{'Content-Type':'application/json'},
        body:JSON.stringify({error:'Could not parse JSON from model response. Raw: '+clean.slice(0,300)}) };
    }

    const words       = Array.isArray(parsed) ? parsed : (parsed.words||[]);
    const translation = Array.isArray(parsed) ? null   : (parsed.translation||null);

    if (words.length > 0) {
      try { await writeParsedWords(words); }
      catch(err) { console.error('Hebrew Sheets error:', err.message); }
    }

    const allWords = [...cachedWords, ...words];
    return { statusCode:200, headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ words:allWords, translation, fromCache:cachedWords.length, fromClaude:words.length }) };

  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
