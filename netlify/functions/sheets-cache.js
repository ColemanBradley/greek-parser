// Google Sheets lexicon cache
// Checks sheet before Claude, writes new entries after Claude parses

const SHEET_NAME_GREEK  = 'Greek';
const SHEET_NAME_HEBREW = 'Hebrew';
const COLUMNS = ['Lexical Form','Gloss','Part of Speech','Inflected Forms Seen','Language','Date Added','Parse Count'];

// ── Google Sheets auth via service account ──────────────────
function getAuthHeader(email, privateKey) {
  // Build a JWT for Google OAuth2
  const now  = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const unsigned = `${header}.${payload}`;
  return { unsigned, email, privateKey };
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(email, rawKey) {
  // Fix escaped newlines from env var
  const privateKey = rawKey.replace(/\\n/g, '\n');

  // We need to sign the JWT with RS256 — use Node's crypto
  const crypto = require('crypto');
  const now    = Math.floor(Date.now() / 1000);
  const claim  = {
    iss:   email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const unsigned = `${header}.${payload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = sign.sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

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

// ── Sheets API helpers ───────────────────────────────────────
async function sheetsGet(token, sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsAppend(token, sheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  return res.json();
}

async function sheetsUpdate(token, sheetId, range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res  = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  return res.json();
}

async function ensureHeaders(token, sheetId, sheetName) {
  // Check if header row exists, create if not
  const res = await sheetsGet(token, sheetId, `${sheetName}!A1:G1`);
  const row = res.values?.[0];
  if (!row || row[0] !== 'Lexical Form') {
    await sheetsUpdate(token, sheetId, `${sheetName}!A1:G1`, [COLUMNS]);
  }
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;

  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Google Sheets env vars not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, language, lexicalForm, gloss, partOfSpeech, inflectedForm } = body;
  const sheetName = (language === 'hebrew') ? SHEET_NAME_HEBREW : SHEET_NAME_GREEK;

  try {
    const token = await getAccessToken(SA_EMAIL, SA_KEY);
    await ensureHeaders(token, SHEET_ID, sheetName);

    // ── READ: check if lexical form exists ──
    if (action === 'lookup') {
      const res = await sheetsGet(token, SHEET_ID, `${sheetName}!A:G`);
      const rows = res.values || [];
      // Skip header row, search for lexical form in column A
      const match = rows.slice(1).find(r => r[0] === lexicalForm);
      if (match) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            found: true,
            lexicalForm: match[0] || '',
            gloss:        match[1] || '',
            partOfSpeech: match[2] || '',
            inflectedForms: (match[3] || '').split('|').filter(Boolean),
            language:     match[4] || '',
            dateAdded:    match[5] || '',
            parseCount:   parseInt(match[6] || '0'),
          })
        };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: false })
      };
    }

    // ── WRITE: add new entry or update existing ──
    if (action === 'write') {
      const res  = await sheetsGet(token, SHEET_ID, `${sheetName}!A:G`);
      const rows = res.values || [];
      const rowIdx = rows.slice(1).findIndex(r => r[0] === lexicalForm);

      if (rowIdx >= 0) {
        // Update existing row — add inflected form if new, increment count
        const existing   = rows[rowIdx + 1];
        const forms      = new Set((existing[3] || '').split('|').filter(Boolean));
        if (inflectedForm) forms.add(inflectedForm);
        const newCount   = (parseInt(existing[6] || '0') + 1).toString();
        const sheetRow   = rowIdx + 2; // 1-indexed + header
        await sheetsUpdate(token, SHEET_ID, `${sheetName}!A${sheetRow}:G${sheetRow}`, [[
          existing[0],
          existing[1],
          existing[2],
          Array.from(forms).join('|'),
          existing[4],
          existing[5],
          newCount,
        ]]);
      } else {
        // Append new row
        const today = new Date().toISOString().split('T')[0];
        await sheetsAppend(token, SHEET_ID, `${sheetName}!A:G`, [[
          lexicalForm   || '',
          gloss         || '',
          partOfSpeech  || '',
          inflectedForm || '',
          language      || 'greek',
          today,
          '1',
        ]]);
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
