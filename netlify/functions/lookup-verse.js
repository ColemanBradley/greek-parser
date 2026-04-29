// Verse lookup — serves directly from bundled sblgnt.json
// No external API calls. Reads the static file from the public folder.
const fs   = require('fs');
const path = require('path');

const BOOK_MAP = {
  'matthew':40,'matt':40,'mat':40,'mt':40,
  'mark':41,'mrk':41,'mar':41,'mk':41,
  'luke':42,'luk':42,'lk':42,
  'john':43,'jhn':43,'jn':43,
  'acts':44,'act':44,
  'romans':45,'rom':45,'ro':45,
  '1corinthians':46,'1cor':46,'1co':46,
  '2corinthians':47,'2cor':47,'2co':47,
  'galatians':48,'gal':48,'ga':48,
  'ephesians':49,'eph':49,
  'philippians':50,'phil':50,'php':50,'phi':50,
  'colossians':51,'col':51,
  '1thessalonians':52,'1thess':52,'1th':52,'1thes':52,
  '2thessalonians':53,'2thess':53,'2th':53,'2thes':53,
  '1timothy':54,'1tim':54,'1ti':54,
  '2timothy':55,'2tim':55,'2ti':55,
  'titus':56,'tit':56,
  'philemon':57,'phlm':57,'phm':57,
  'hebrews':58,'heb':58,
  'james':59,'jas':59,'jam':59,
  '1peter':60,'1pet':60,'1pe':60,
  '2peter':61,'2pet':61,'2pe':61,
  '1john':62,'1jhn':62,'1jn':62,
  '2john':63,'2jhn':63,'2jn':63,
  '3john':64,'3jhn':64,'3jn':64,
  'jude':65,'jud':65,
  'revelation':66,'rev':66,'rv':66,'re':66,
};

// Load SBLGNT once at cold start
let sblgnt = null;
function getSBLGNT() {
  if (sblgnt) return sblgnt;
  // Netlify functions can read from the publish directory via __dirname relative path
  // The public folder is deployed alongside functions
  // sblgnt.json lives right next to this function file
  const p = path.join(__dirname, 'sblgnt.json');
  if (fs.existsSync(p)) {
    sblgnt = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return sblgnt;
  }
  return null;
}

function parseReference(ref) {
  const s = ref.trim().toLowerCase();
  const m = s.match(/^((?:\d\s*)?[a-z]+(?:\s+[a-z]+)*)\s+(\d+):(\d+)(?:\s*[-\u2013]\s*(\d+))?$/);
  if (!m) return null;
  const [, bookRaw, chap, vs, ve] = m;
  const bookKey = bookRaw.replace(/\s+/g, '');
  const bookNum = BOOK_MAP[bookKey];
  if (!bookNum) return null;
  return {
    bookNum,
    chapter:    parseInt(chap),
    verseStart: parseInt(vs),
    verseEnd:   ve ? parseInt(ve) : parseInt(vs),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { reference } = body;
  if (!reference) return { statusCode: 400, body: JSON.stringify({ error: 'No reference provided' }) };

  const parsed = parseReference(reference);
  if (!parsed) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Could not parse "${reference}". Try "John 3:16" or "1 Cor 13:4-7".` })
    };
  }

  const db = getSBLGNT();
  if (!db) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'SBLGNT data not found on server. Please redeploy.' })
    };
  }

  const { bookNum, chapter, verseStart, verseEnd } = parsed;
  const parts = [];
  for (let v = verseStart; v <= verseEnd; v++) {
    const key = `${bookNum}:${chapter}:${v}`;
    const text = db.verses[key];
    if (text) parts.push(text);
  }

  if (!parts.length) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: `${reference} not found in SBLGNT.` })
    };
  }

  const bookDisplay = db.books[String(bookNum)] || reference.trim().replace(/\s*\d+:\d+.*$/, '').trim();
  const verseDisplay = verseStart === verseEnd
    ? `${chapter}:${verseStart}`
    : `${chapter}:${verseStart}–${verseEnd}`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text:      parts.join(' '),
      reference: `${bookDisplay} ${verseDisplay}`,
      source:    'SBLGNT',
    }),
  };
};
