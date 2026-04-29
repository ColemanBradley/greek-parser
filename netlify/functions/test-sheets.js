const crypto = require('crypto');

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function getToken() {
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now+3600, iat: now };
  const h = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const p = b64url(JSON.stringify(claim));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${h}.${p}`);
  const sig = sign.sign(SA_KEY,'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const jwt = `${h}.${p}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await res.json();
  return d.access_token;
}

exports.handler = async function(event) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const log = [];
  try {
    const token = await getToken();
    log.push('Token OK');

    // Write header row
    const hurl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Greek!A1:G1')}?valueInputOption=USER_ENTERED`;
    const hres = await fetch(hurl, {
      method:'PUT',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({values:[['Lexical Form','Gloss','Part of Speech','Inflected Forms Seen','Language','Date Added','Parse Count']]})
    });
    const hdata = await hres.json();
    log.push(`Header write status: ${hres.status}`);
    log.push(`Header response: ${JSON.stringify(hdata).slice(0,200)}`);

    // Append a test row
    const aurl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Greek!A:G')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const ares = await fetch(aurl, {
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({values:[['λόγος','word, message','noun','λόγος|λόγον','greek','2026-04-29','1']]})
    });
    const adata = await ares.json();
    log.push(`Append status: ${ares.status}`);
    log.push(`Append response: ${JSON.stringify(adata).slice(0,300)}`);

  } catch(err) {
    log.push(`ERROR: ${err.message}`);
  }
  return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify({log}) };
};
