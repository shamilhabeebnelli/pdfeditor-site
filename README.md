# PDF Desk

A free, private PDF editor that runs entirely in your browser. No uploads, no
accounts, no page limits, no watermarks.

Live at **https://pdfeditor.denelli.in**

## Features

- **Edit existing text** — click any text line, change the words. Position,
  size and alignment of the original are preserved; the style family is matched
  automatically (serif / sans / mono) with **B** / *I* toggles for bold and
  italic.
- **Whiteout** — drag a rectangle to cover anything on the page.
- **Add text** — place new text anywhere, as a multi-line block. Word-like
  formatting: **B** / *I* / U / S (bold, italic, underline, strikethrough) and
  bulleted or numbered lists (one item per line).
- **Zoom, undo, multi-page** documents.
- **Two export modes**
  - *Normal export* — original file plus your patches. Small, fast, text stays
    selectable.
  - *Flatten export* — pages are re-rendered as images and rebuilt into a
    brand-new PDF. The original page content, annotations, attachments and
    metadata do not carry over, so covered content is truly gone from the
    file. Text becomes part of the page image (any script your device can
    display) and is no longer selectable.

## Privacy

Files never leave your device. All parsing, editing and export happen locally
in your browser with JavaScript/WebAssembly. There is no server component.

## Honest scope and limitations

- Text editing is cover-and-replace, not content-stream surgery: the original
  text is hidden under an opaque patch. In a *normal* export the covered data
  can still exist inside the file (e.g. it may still be extractable). Use
  *Flatten export* when the covered content must be gone for real.
- Replacements use the closest matching built-in font (Times / Helvetica /
  Courier family with bold/italic). A document whose text uses a different
  embedded font will show a small visual difference; the original embedded font
  cannot be reused to draw new glyphs without the original font file. Lines
  where substitution applies are marked when you click them. Where the
  document already uses a PDF standard font (Times/Helvetica/Courier family),
  the match is metric-identical.
- A replacement wider than the original would cover content to its right;
  the editor detects this and asks before applying ("Cover anyway" /
  "Cancel"). Nothing else on the page is reflowed or moved.
- Direct text edits support Latin-script characters (the PDF standard fonts).
  For other scripts use Flatten export: the text is drawn into the page image
  (not selectable text).
- Scanned (image-only) pages have no text layer, so there is no text to click
  and edit; whiteout and added text still work. The app tells you when a page
  looks scanned.
- Whiteout patches are opaque white. On a colored background, flatten or match
  expectations accordingly.

## Run locally

Any static file server works (ES modules require http, not file://):

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Tests

`test/run-test.mjs` exercises the same `editor-core.mjs` the browser ships:
it builds a known PDF, applies a text edit and a whiteout, and verifies the
export with pdffonts, pdftotext, pixel-diffing (`check-pixels.py`) and a
flatten round-trip. A Playwright E2E drives the real UI in Chrome (load, edit,
bold toggle, whiteout drag, add text, undo, both exports, scanned-page notice).

## Dependencies (vendored in `vendor/`)

| Package | Version | License |
| --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | latest | MIT |

Both licenses permit free use, modification and redistribution, including
commercial use. See `vendor/pdf.min.mjs` / `pdf-lib.esm.min.js` headers and the
upstream LICENSE files.

## Deployment

Static site on GitHub Pages. The `CNAME` file maps `pdfeditor.denelli.in`;
DNS has a `CNAME` record `pdfeditor -> shamilhabeebnelli.github.io`.
