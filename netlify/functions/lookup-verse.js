// Verse lookup — primary: bolls.life SBLGNT, fallback: THGNT
// No API key required.

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

function parseReference(ref) {
  let s = ref.trim().toLowerCase();
  // Match: optional number prefix + book name(s) + chapter:verse[-verse]
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

async function fetchFromBolls(translation, bookNum, chapter, verseStart, verseEnd) {
  const res = await fetch(
    `https://bolls.life/get-text/${translation}/${bookNum}/${chapter}/`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const verses = await res.json();
  if (!Array.isArray(verses) || !verses.length) throw new Error('empty response');
  const selected = verses.filter(v => v.verse >= verseStart && v.verse <= verseEnd);
  if (!selected.length) throw new Error(`verse ${verseStart} not found in chapter`);
  return selected;
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

  const { bookNum, chapter, verseStart, verseEnd } = parsed;
  const stripHtml = s => s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

  // Try SBLGNT first, fall back to THGNT
  const translations = ['SBLGNT', 'THGNT'];
  let lastErr = 'unknown error';

  for (const tr of translations) {
    try {
      const selected = await fetchFromBolls(tr, bookNum, chapter, verseStart, verseEnd);
      const text = selected.map(v => stripHtml(v.text)).join(' ');

      // Reconstruct display reference from original input
      const parts = reference.trim().split(/\s+/);
      const bookDisplay = parts.slice(0, parts.length - 1).join(' ');
      const verseDisplay = verseStart === verseEnd
        ? `${chapter}:${verseStart}`
        : `${chapter}:${verseStart}–${verseEnd}`;

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, reference: `${bookDisplay} ${verseDisplay}`, translation: tr }),
      };
    } catch(e) {
      lastErr = e.message;
    }
  }

  return {
    statusCode: 404,
    body: JSON.stringify({ error: `Verse not found: ${reference}. (${lastErr})` })
  };
};
