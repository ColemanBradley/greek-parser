// Verse lookup using api.esv.org for English reference confirmation
// and scripture.api.bible for Greek text (SBLGNT)
// Falls back to bible-api.com if primary fails

const BOOK_NAMES = {
  40:'Matthew',41:'Mark',42:'Luke',43:'John',44:'Acts',
  45:'Romans',46:'1 Corinthians',47:'2 Corinthians',48:'Galatians',
  49:'Ephesians',50:'Philippians',51:'Colossians',52:'1 Thessalonians',
  53:'2 Thessalonians',54:'1 Timothy',55:'2 Timothy',56:'Titus',
  57:'Philemon',58:'Hebrews',59:'James',60:'1 Peter',61:'2 Peter',
  62:'1 John',63:'2 John',64:'3 John',65:'Jude',66:'Revelation'
};

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

const stripHtml = s => s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

async function tryBolls(bookNum, chapter, verseStart, verseEnd) {
  // Try both SBLGNT and THGNT
  for (const tr of ['SBLGNT', 'THGNT']) {
    try {
      const res = await fetch(
        `https://bolls.life/get-text/${tr}/${bookNum}/${chapter}/`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) continue;
      const selected = data.filter(v => v.verse >= verseStart && v.verse <= verseEnd);
      if (!selected.length) continue;
      return { text: selected.map(v => stripHtml(v.text)).join(' '), source: tr };
    } catch(e) { continue; }
  }
  return null;
}

async function tryGetBible(bookNum, chapter, verseStart, verseEnd) {
  // getbible.net — returns SBLGNT for NT
  // Book abbreviations for getbible
  const abbr = BOOK_NAMES[bookNum]?.toLowerCase().replace(/\s+/g,'').replace(/\d/g, n => n) || '';
  try {
    const res = await fetch(
      `https://getbible.net/v2/sblgnt/${bookNum}/${chapter}.json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // data.verses is an object keyed by verse number
    const verses = data.verses || {};
    const parts = [];
    for (let v = verseStart; v <= verseEnd; v++) {
      if (verses[v]) parts.push(stripHtml(verses[v].verse));
    }
    if (!parts.length) return null;
    return { text: parts.join(' '), source: 'SBLGNT (getbible)' };
  } catch(e) { return null; }
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

  // Try bolls.life first, then getbible.net
  let result = await tryBolls(bookNum, chapter, verseStart, verseEnd);
  if (!result) result = await tryGetBible(bookNum, chapter, verseStart, verseEnd);

  if (!result) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: `Could not retrieve Greek text for ${reference}. Both lookup sources failed — check your connection and try again.` })
    };
  }

  // Build clean display reference
  const bookDisplay = BOOK_NAMES[bookNum] || reference.trim().replace(/\s*\d+:\d+.*$/, '').trim();
  const verseDisplay = verseStart === verseEnd
    ? `${chapter}:${verseStart}`
    : `${chapter}:${verseStart}–${verseEnd}`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: result.text,
      reference: `${bookDisplay} ${verseDisplay}`,
      source: result.source,
    }),
  };
};
