// editor-core.mjs — shared, dependency-injected export logic.
// Works in the browser (vendored pdf-lib ESM) and in Node (npm pdf-lib) so the
// exact code that ships is the code that gets tested.
//
// Op model. All geometry is in PDF user space (points, bottom-left origin),
// so ops are independent of the on-screen zoom level.
//   { page: 0-based page index,
//     kind: 'whiteout' | 'text' | 'addtext',
//     rect: { x, y, w, h },        // cover rect for 'whiteout' and 'text'
//     text: 'replacement text',    // for 'text' and 'addtext'
//     family: 'serif' | 'mono' | 'sans',   // style family
//     bold: bool, italic: bool,    // weight/slant toggles
//     underline: bool, strike: bool,       // drawn as rules (std fonts have no U/S variants)
//     font: 'HelveticaBold',       // pdf-lib StandardFonts KEY (derived; kept for simple callers)
//     size: 12,                    // points
//     baselineY: 542.3,            // baseline for text ops
//     color: { r, g, b }           // 0..1
//   }

export const FAMILY_SETS = {
  serif: { normal: 'TimesRoman', bold: 'TimesRomanBold', italic: 'TimesRomanItalic', boldItalic: 'TimesRomanBoldItalic' },
  mono: { normal: 'Courier', bold: 'CourierBold', italic: 'CourierOblique', boldItalic: 'CourierBoldOblique' },
  sans: { normal: 'Helvetica', bold: 'HelveticaBold', italic: 'HelveticaOblique', boldItalic: 'HelveticaBoldOblique' },
};

const FAMILY_MATCH = [
  [/times|roman|serif|georgia|palatino|book/i, 'serif'],
  [/courier|mono|typewriter|consol/i, 'mono'],
];

// Map an original PDF font name (often subset-prefixed, e.g.
// "ABCDEF+TimesNewRomanPS-BoldMT") to family + detected weight/slant.
// Honest limitation: a subset embedded font cannot generally be reused to draw
// NEW glyphs, so exact-font preservation is not possible without the original
// font file. We preserve family style, weight, slant, size and position.
export function mapFontFamily(originalFontName) {
  const raw = String(originalFontName || '');
  const name = raw.replace(/^[A-Z]{6}\+/, ''); // strip subset prefix
  const bold = /bold|black|heavy|semibold|demi/i.test(name);
  const italic = /italic|oblique|slanted/i.test(name);
  let family = 'sans';
  for (const [re, fam] of FAMILY_MATCH) if (re.test(name)) { family = fam; break; }
  return { family, bold, italic };
}

export function stdFontKey(family, bold, italic) {
  const set = FAMILY_SETS[family] || FAMILY_SETS.sans;
  if (bold && italic) return set.boldItalic;
  if (bold) return set.bold;
  if (italic) return set.italic;
  return set.normal;
}

// Back-compat helper used by tests and simple callers.
export function mapFont(originalFontName) {
  const { family, bold, italic } = mapFontFamily(originalFontName);
  return stdFontKey(family, bold, italic);
}

// Apply ops to a PDF. pdfLib is the pdf-lib module (injected).
// Returns { bytes: Uint8Array, failures: [{ text, reason }] } — a text op
// fails when its characters cannot be WinAnsi-encoded by the standard fonts
// (v1 edit text is Latin-script only; flatten export has no such limit).
export async function applyOps(pdfLib, pdfBytes, ops) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const fontCache = new Map();
  const failures = [];
  const fontFor = async (name) => {
    if (!fontCache.has(name)) {
      fontCache.set(name, await doc.embedFont(StandardFonts[name] || StandardFonts.Helvetica));
    }
    return fontCache.get(name);
  };

  for (const op of ops) {
    const page = doc.getPage(op.page);
    if (!page) { failures.push({ text: op.text || '', reason: `no page ${op.page}` }); continue; }
    if (op.kind === 'whiteout' || op.kind === 'text') {
      page.drawRectangle({
        x: op.rect.x, y: op.rect.y, width: op.rect.w, height: op.rect.h,
        color: rgb(1, 1, 1), opacity: 1, borderWidth: 0,
      });
    }
    if (op.kind === 'text' || op.kind === 'addtext') {
      const key = op.font || stdFontKey(op.family, op.bold, op.italic);
      const font = await fontFor(key);
      const c = op.color || { r: 0, g: 0, b: 0 };
      try {
        // Multi-line blocks (add-text) walk downward from the click baseline;
        // list styles add a hanging-indent prefix. Nothing else on the page moves.
        const lines = String(op.text || '').split('\n');
        const lineH = op.size * 1.25;
        const thick = Math.max(op.size * 0.05, 0.6);
        lines.forEach((line, i) => {
          const by = op.baselineY - i * lineH;
          let prefix = '', indent = 0;
          if (op.listStyle === 'bullet') { prefix = '\u2022 '; indent = op.size * 0.9; }
          if (op.listStyle === 'number') { prefix = `${i + 1}. `; indent = op.size * 1.1; }
          if (prefix) {
            page.drawText(prefix, { x: op.rect.x, y: by, size: op.size, font, color: rgb(c.r, c.g, c.b) });
          }
          page.drawText(line, { x: op.rect.x + indent, y: by, size: op.size, font, color: rgb(c.r, c.g, c.b) });
          if (op.underline || op.strike) {
            const w = font.widthOfTextAtSize(prefix + line, op.size);
            if (op.underline) page.drawRectangle({ x: op.rect.x, y: by - op.size * 0.12, width: w, height: thick, color: rgb(c.r, c.g, c.b) });
            if (op.strike) page.drawRectangle({ x: op.rect.x, y: by + op.size * 0.28, width: w, height: thick, color: rgb(c.r, c.g, c.b) });
          }
        });
      } catch (err) {
        failures.push({ text: op.text || '', reason: String(err && err.message || err).slice(0, 120) });
      }
    }
  }
  return { bytes: await doc.save(), failures };
}

// Flatten: rebuild the PDF from rendered page images (PNG bytes per page).
// After flattening, covered content is genuinely gone from the file, but all
// text becomes non-selectable.
// pages: array of { widthPts, heightPts, png: Uint8Array }
export async function buildFlattened(pdfLib, pages) {
  const { PDFDocument } = pdfLib;
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([p.widthPts, p.heightPts]);
    const img = await doc.embedPng(p.png);
    page.drawImage(img, { x: 0, y: 0, width: p.widthPts, height: p.heightPts });
  }
  return { bytes: await doc.save(), failures: [] };
  }
