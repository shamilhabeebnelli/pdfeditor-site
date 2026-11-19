// Node test: exercises the SAME editor-core.mjs the browser uses.
// 1) builds a known sample PDF, 2) applies a text edit + a whiteout,
// 3) writes edited.pdf and a flattened version for verification.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyOps, buildFlattened, mapFont } from '../editor-core.mjs';

const pdfLib = await import('pdf-lib');

// --- 1. sample document -------------------------------------------------
const doc = await PDFDocument.create();
const page = doc.addPage([400, 600]);
const times = await doc.embedFont(StandardFonts.TimesRoman);
page.drawText('Invoice total: USD 1,250.00', { x: 40, y: 540, size: 14, font: times, color: rgb(0, 0, 0) });
const helv = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Thank you for your business.', { x: 40, y: 500, size: 10, font: helv, color: rgb(0, 0, 0) });
writeFileSync('sample.pdf', await doc.save());

// scanned.pdf: image-like page, no text layer (fixture for the E2E notice test)
const sdoc = await PDFDocument.create();
const sp = sdoc.addPage([400, 600]);
sp.drawRectangle({ x: 40, y: 500, width: 300, height: 40, color: rgb(0.2, 0.2, 0.2) });
writeFileSync('scanned.pdf', await sdoc.save());

// custom-font.pdf: embedded non-standard font (fixture for substitution notice)
const cdoc = await PDFDocument.create();
cdoc.registerFontkit(await import('fontkit'));
const dejavu = await cdoc.embedFont(readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), { subset: false });
const cp = cdoc.addPage([400, 600]);
cp.drawText('Custom embedded font line', { x: 40, y: 540, size: 14, font: dejavu, color: rgb(0, 0, 0) });
writeFileSync('custom-font.pdf', await cdoc.save());

// --- 2. ops, exactly as the app records them ----------------------------
const ops = [
  { page: 0, kind: 'text',
    rect: { x: 39, y: 540 - 0.32 * 14, w: 240, h: 18.2 },
    text: 'Invoice total: USD 1,480.00', font: 'TimesRomanBold', size: 14, baselineY: 540,
    color: { r: 0, g: 0, b: 0 } },
  { page: 0, kind: 'whiteout', rect: { x: 39, y: 496, w: 200, h: 12 } },
  { page: 0, kind: 'addtext', rect: { x: 40, y: 0, w: 0, h: 0 }, text: 'Underlined and struck note',
    font: 'Helvetica', size: 12, baselineY: 460, underline: true, strike: true, color: { r: 0, g: 0, b: 0 } },
  { page: 0, kind: 'addtext', rect: { x: 40, y: 0, w: 0, h: 0 }, text: 'Milk\nEggs',
    font: 'Helvetica', size: 12, baselineY: 420, listStyle: 'bullet', color: { r: 0, g: 0, b: 0 } },
];

const { bytes: edited, failures } = await applyOps(pdfLib, readFileSync('sample.pdf'), ops);
if (failures.length) { console.error('unexpected failures', failures); process.exit(1); }
writeFileSync('edited.pdf', edited);

// unicode beyond WinAnsi must fail honestly, not corrupt the export
const uni = await applyOps(pdfLib, readFileSync('sample.pdf'), [
  { page: 0, kind: 'addtext', rect: { x: 40, y: 0, w: 0, h: 0 }, text: 'പണം ₹', font: 'Helvetica', size: 12, baselineY: 300 },
]);
console.log('unicode edit failure honestly reported:', uni.failures.length === 1 ? 'PASS' : 'FAIL');

// --- 4. flattened variant (raster comes from pdftoppm; see test.sh) -----
const pngPath = process.argv[2];
if (pngPath) {
  const { bytes: flat } = await buildFlattened(pdfLib, [{ widthPts: 400, heightPts: 600, png: readFileSync(pngPath) }]);
  writeFileSync('flattened.pdf', flat);
}

// --- font mapping unit checks -------------------------------------------
const cases = [
  ['ABCDEF+TimesNewRomanPS-BoldMT', 'TimesRomanBold'],
  ['BCDEFG+Arial-ItalicMT', 'HelveticaOblique'],
  ['CourierPrime', 'Courier'],
  ['AAAAAA+ComicSansMS', 'Helvetica'],
];
let ok = true;
for (const [input, want] of cases) {
  const got = mapFont(input);
  if (got !== want) { ok = false; console.error(`mapFont(${input}) = ${got}, want ${want}`); }
}
console.log(ok ? 'mapFont: all cases pass' : 'mapFont: FAILURES');
console.log('wrote sample.pdf, edited.pdf' + (pngPath ? ', flattened.pdf' : ''));
