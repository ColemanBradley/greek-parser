// Free verse lookup via bolls.life — no API key required
// Greek NT translation code: SBLGNT
// Book numbers follow standard Bible book order (NT starts at 40=Matthew)

const BOOK_MAP = {
  // Gospels
  'matthew': 40, 'matt': 40, 'mat': 40, 'mt': 40,
  'mark': 41, 'mrk': 41, 'mar': 41, 'mk': 41,
  'luke': 42, 'luk': 42, 'lk': 42,
  'john': 43, 'jhn': 43, 'jn': 43,
  // Acts
  'acts': 44, 'act': 44,
  // Pauline epistles
  'romans': 45, 'rom': 45,
  '1corinthians': 46, '1cor': 46, '1co': 46,
  '2corinthians': 47, '2cor': 47, '2co': 47,
  'galatians': 48, 'gal': 48,
  'ephesians': 49, 'eph': 49,
  'philippians': 50, 'phil': 50, 'php': 50,
  'colossians': 51, 'col': 51,
  '1thessalonians': 52, '1thess': 52, '1th': 52,
  '2thessalonians': 53, '2thess': 53, '2th': 53,
  '1timothy': 54, '1tim': 54, '1ti': 54,
  '2timothy': 55, '2tim': 55, '2ti': 55,
  'titus': 56, 'tit': 56,
  'philemon': 57, 'phlm': 57, 'phm': 57,
  // General epistles
  'hebrews': 58, 'heb': 58,
  'james': 59, 'jas': 59,
  '1peter': 60, '1pet': 60, '1pe': 60,
  '2peter': 61, '2pet': 61, '2pe': 61,
  '1john': 62, '1jhn': 62, '1jn': 62,
  '2john': 63, '2jhn': 63, '2jn': 63,
  '3john': 64, '3jhn': 64, '3jn': 64,
  'jude': 65,
  'revelation': 66, 'rev': 66, 'rv': 66,
};

function parseReference(ref) {
  // Normalise: "John 3:16", "1 Cor 13:4", "Jn 1:1-3" etc.
  const clean = ref.trim().toLowerCase().replace(/\s+/g, ' ');

  // Extract verse range if present (e.g. 1:1-5)
  const rangeMatch = clean.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!rangeMatch) return null;

  const [, bookRaw, chap, verseStart, verseEnd] = rangeMatch;
  const bookKey = bookRaw.replace(/\s/g, '');
  const bookNum = BOOK_MAP[bookKey];
  if (!bookNum) return null;

  return {
    bookNum,
    chapter: parseInt(chap),
    verseStart: parseInt(verseStart),
    verseEnd: verseEnd ? parseInt(verseEnd) : parseInt(verseStart),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { reference } = body;
  if (!reference) return { statusCode: 400, body: JSON.stringify({ error: 'No reference provided' }) };

  const parsed = parseReference(reference);
  if (!parsed) {
    return { statusCode: 400, body: JSON.stringify({ error: `Could not parse reference "${reference}". Try "John 3:16" or "1 Cor 13:4".` }) };
  }

  const { bookNum, chapter, verseStart, verseEnd } = parsed;

  try {
    // Fetch the whole chapter from bolls.life (returns array of verse objects)
    const res = await fetch(
      `https://bolls.life/get-text/SBLGNT/${bookNum}/${chapter}/`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Could not fetch verse from bolls.life (${res.status})` }) };
    }

    const verses = await res.json();

    // Filter to requested verse range
    const selected = verses.filter(v => v.verse >= verseStart && v.verse <= verseEnd);
    if (!selected.length) {
      return { statusCode: 404, body: JSON.stringify({ error: `Verse not found: ${reference}` }) };
    }

    // Strip any HTML tags from text
    const stripHtml = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const text = selected.map(v => stripHtml(v.text)).join(' ');

    // Build a clean display reference
    const bookDisplay = reference.trim().replace(/\s*\d+:\d+.*$/, '').trim();
    const verseDisplay = verseStart === verseEnd
      ? `${chapter}:${verseStart}`
      : `${chapter}:${verseStart}–${verseEnd}`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        reference: `${bookDisplay} ${verseDisplay}`,
        bookNum,
        chapter,
        verseStart,
        verseEnd,
      }),
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
