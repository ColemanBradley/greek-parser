const crypto = require('crypto');

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

exports.handler = async function(event) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const SA_KEY   = process.env.GOOGLE_PRIVATE_KEY;

  const log = [];

  log.push(`SHEET_ID present: ${!!SHEET_ID}`);
  log.push(`SA_EMAIL present: ${!!SA_EMAIL}`);
  log.push(`SA_KEY present: ${!!SA_KEY}`);
  log.push(`SA_KEY starts with: ${SA_KEY ? SA_KEY.slice(0,30) : 'N/A'}`);
  log.push(`SA_KEY has \\n: ${SA_KEY ? SA_KEY.includes('\\n') : false}`);
  log.push(`SA_KEY has newline: ${SA_KEY ? SA_KEY.includes('\n') : false}`);

  try {
    const privateKey = SA_KEY.replace(/\\n/g, '\n');
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss:   SA_EMAIL,
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
    log.push('JWT signed successfully');

    const res  = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const data = await res.json();
    log.push(`OAuth status: ${res.status}`);
    log.push(`OAuth response: ${JSON.stringify(data).slice(0,200)}`);

    if (data.access_token) {
      log.push('Token obtained! Testing Sheets read...');
      const sres = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('Greek!A1:G1')}`,
        { headers: { Authorization: `Bearer ${data.access_token}` } }
      );
      const sdata = await sres.json();
      log.push(`Sheets status: ${sres.status}`);
      log.push(`Sheets response: ${JSON.stringify(sdata).slice(0,200)}`);
    }
  } catch(err) {
    log.push(`ERROR: ${err.message}`);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log })
  };
};
