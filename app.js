// app.js — PDF Desk: fully local PDF text edit + whiteout.
import * as pdfjsLib from './vendor/pdf.min.mjs';
import * as pdfLib from './vendor/pdf-lib.esm.min.js';
import { applyOps, buildFlattened, mapFontFamily, stdFontKey } from './editor-core.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const pagesEl = $('#pages');
const noticeEl = $('#notice');

let pdfDoc = null;
let pdfBytes = null;
let fileName = 'document.pdf';
let scale = 1.35;
let tool = 'edit';
let ops = [];                 // committed operations, in PDF point coordinates
let pageViews = [];           // per-page { wrap, canvas, overlay, zones:[], heightPts, widthPts }
let scannedPages = [];

const FAMILY_CSS = {
  serif: '"Times New Roman", Times, serif',
  mono: '"Courier New", Courier, monospace',
  sans: 'Arial, Helvetica, sans-serif',
};
const cssFont = (family, bold, italic) =>
  `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${''}`; // style string built per call site
const cssFontFamily = (family) => FAMILY_CSS[family] || FAMILY_CSS.sans;

const measureCtx = document.createElement('canvas').getContext('2d');
function measureTextPx(text, family, bold, italic, px) {
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${cssFontFamily(family)}`;
  return measureCtx.measureText(text).width;
}

function notice(msg) { noticeEl.style.display = msg ? 'block' : 'none'; noticeEl.textContent = msg; }
function refreshButtons() {
  $('#export').disabled = !pdfDoc;
  $('#undo').disabled = ops.length === 0;
  $('#clear').disabled = ops.length === 0;
  $('#pagebadge').textContent = Math.round(scale / 1.35 * 100) + '%';
}

// ---------- file loading ----------
async function openFile(file) {
  fileName = file.name || 'document.pdf';
  pdfBytes = await file.arrayBuffer();
  ops = []; pageViews = []; scannedPages = [];
  pagesEl.innerHTML = '';
  pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  $('#drop').style.display = 'none';
  for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
  if (scannedPages.length) {
    notice(`Page${scannedPages.length > 1 ? 's' : ''} ${scannedPages.join(', ')} appear${scannedPages.length > 1 ? '' : 's'} to be scanned (image only): no editable text there. Whiteout and Add text still work on those pages.`);
  } else {
    notice('');
  }
  refreshButtons();
}

async function renderPage(pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const wrap = document.createElement('div'); wrap.className = 'pagewrap';
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.style.width = vp.width + 'px'; overlay.style.height = vp.height + 'px';
  wrap.append(canvas, overlay); pagesEl.append(wrap);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

  const view = { pageNum, wrap, canvas, overlay, zones: [], widthPts: vp.width / scale, heightPts: vp.height / scale };
  pageViews[pageNum - 1] = view;

  const tc = await page.getTextContent();
  let itemCount = 0;
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    itemCount++;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (!isFinite(fh) || fh < 2) continue;
    // item.fontName is a pdf.js-internal id; resolve the real font name so
    // family/weight matching works. Falls back to the raw id if unresolved.
    let realFont = item.fontName;
    try {
      const f = page.commonObjs.get(item.fontName);
      if (f) realFont = f.name || f.loadedName || realFont;
    } catch { /* keep raw id */ }
    const style = mapFontFamily(realFont);
    const zone = { used: false, x: tx[4], y: tx[5] - fh, w: item.width * scale, h: fh * 1.2,
                   baselineY: tx[5], fh, str: item.str, exact: isStandardFont(realFont), ...style };
    view.zones.push(zone);
  }
  if (itemCount === 0) scannedPages.push(pageNum);
  paintOverlay(view);
}

// ---------- overlay painting ----------
function paintOverlay(view) {
  view.overlay.innerHTML = '';
  ops.forEach((op, idx) => {
    if (op.page !== view.pageNum - 1) return;
    if (op.kind === 'whiteout' || op.kind === 'text') {
      const r = document.createElement('div');
      r.className = 'wrect';
      r.style.left = op.rect.x * scale + 'px';
      r.style.top = (view.heightPts - op.rect.y - op.rect.h) * scale + 'px';
      r.style.width = op.rect.w * scale + 'px';
      r.style.height = op.rect.h * scale + 'px';
      r.title = 'Click to remove this patch';
      r.onclick = () => { removeOp(idx); };
      view.overlay.append(r);
    }
    if (op.kind === 'text' || op.kind === 'addtext') {
      const t = document.createElement('div');
      t.className = 'tstamp';
      t.style.cssText = `left:${op.rect.x * scale}px;top:${(view.heightPts - op.baselineY - op.size) * scale}px;font:${op.italic ? 'italic ' : ''}${op.bold ? 'bold ' : ''}${op.size * scale}px ${cssFontFamily(op.family)};line-height:1.25;white-space:pre;text-decoration:${op.underline ? 'underline ' : ''}${op.strike ? 'line-through' : ''};`;
      t.textContent = displayLines(op);
      view.overlay.append(t);
    }
  });
  if (tool === 'edit') {
    for (const z of view.zones) {
      if (z.used) continue;
      const d = document.createElement('div');
      d.className = 'textzone';
      d.style.left = z.x + 'px'; d.style.top = z.y + 'px';
      d.style.width = Math.max(z.w, 6) + 'px'; d.style.height = z.h + 'px';
      d.onclick = (ev) => { ev.stopPropagation(); startEdit(view, z); };
      view.overlay.append(d);
    }
  }
}

function displayLines(op) {
  return String(op.text || '').split('\n').map((line, i) => {
    if (op.listStyle === 'bullet') return '\u2022 ' + line;
    if (op.listStyle === 'number') return `${i + 1}. ${line}`;
    return line;
  }).join('\n');
}
function repaintAll() { for (const v of pageViews) if (v) paintOverlay(v); }
function removeOp(idx) { ops.splice(idx, 1); repaintAll(); refreshButtons(); }

// True only when the document's font IS one of the PDF standard-14 (so the
// built-in substitute is metric-identical). Everything else gets a notice.
function isStandardFont(name) {
  const n = String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[\s,].*$/, '');
  return /^(times(-?(roman|bold|italic|bolditalic))?|helvetica(-?(bold|oblique|boldoblique))?|courier(-?(bold|oblique|boldoblique))?|symbol|zapfdingbats)$/i.test(n);
}

// ---------- edit bar (input + bold/italic toggles) ----------
function makeEditBar(view, left, top, widthPx, sizePx, family, bold, italic, value, opts = {}) {
  const bar = document.createElement('div');
  bar.className = 'editbar';
  bar.style.left = left + 'px'; bar.style.top = top + 'px';
  const input = document.createElement(opts.multiline ? 'textarea' : 'input');
  input.className = 'editbox';
  input.value = value;
  input.style.width = Math.max(widthPx, 60) + 'px';
  if (opts.multiline) { input.rows = 4; input.title = 'Enter = new line, Ctrl+Enter = apply'; }
  const bBtn = document.createElement('button'); bBtn.textContent = 'B'; bBtn.title = 'Bold';
  const iBtn = document.createElement('button'); iBtn.textContent = 'I'; iBtn.title = 'Italic'; iBtn.className = 'i';
  const uBtn = document.createElement('button'); uBtn.textContent = 'U'; uBtn.title = 'Underline'; uBtn.className = 'u';
  const sBtn = document.createElement('button'); sBtn.textContent = 'S'; sBtn.title = 'Strikethrough'; sBtn.className = 's';
  const state = { family, bold, italic, underline: false, strike: false, listStyle: 'none' };
  const applyStyle = () => {
    input.style.font = `${state.italic ? 'italic ' : ''}${state.bold ? 'bold ' : ''}${sizePx}px ${cssFontFamily(state.family)}`;
    input.style.textDecoration = `${state.underline ? 'underline ' : ''}${state.strike ? 'line-through' : ''}`.trim();
    bBtn.classList.toggle('on', state.bold);
    iBtn.classList.toggle('on', state.italic);
    uBtn.classList.toggle('on', state.underline);
    sBtn.classList.toggle('on', state.strike);
    blBtn.classList.toggle('on', state.listStyle === 'bullet');
    nlBtn.classList.toggle('on', state.listStyle === 'number');
  };
  bBtn.onmousedown = (e) => { e.preventDefault(); state.bold = !state.bold; applyStyle(); };
  iBtn.onmousedown = (e) => { e.preventDefault(); state.italic = !state.italic; applyStyle(); };
  uBtn.onmousedown = (e) => { e.preventDefault(); state.underline = !state.underline; applyStyle(); };
  sBtn.onmousedown = (e) => { e.preventDefault(); state.strike = !state.strike; applyStyle(); };
  const blBtn = document.createElement('button'); blBtn.textContent = '\u2022'; blBtn.title = 'Bulleted list (one item per line)'; blBtn.className = 'bl';
  const nlBtn = document.createElement('button'); nlBtn.textContent = '1.'; nlBtn.title = 'Numbered list (one item per line)'; nlBtn.className = 'nl';
  blBtn.onmousedown = (e) => { e.preventDefault(); state.listStyle = state.listStyle === 'bullet' ? 'none' : 'bullet'; applyStyle(); };
  nlBtn.onmousedown = (e) => { e.preventDefault(); state.listStyle = state.listStyle === 'number' ? 'none' : 'number'; applyStyle(); };
  bar.append(input, bBtn, iBtn, uBtn, sBtn);
  if (opts.lists) bar.append(blBtn, nlBtn);
  if (opts.substituted) {
    const cap = document.createElement('span');
    cap.className = 'substnote';
    cap.textContent = 'closest built-in font (original can\'t be reused)';
    cap.title = 'This document uses its own embedded font. The edit keeps the exact position and size, drawn with the closest matching built-in font.';
    bar.append(cap);
  }
  view.overlay.append(bar);
  applyStyle();
  input.focus(); input.select();
  return { bar, input, state };
}

// ---------- text editing ----------
function startEdit(view, z) {
  const { bar, input, state } = makeEditBar(view, z.x, z.y, z.w + 30, z.fh, z.family, z.bold, z.italic, z.str, { substituted: !z.exact });
  let done = false;
  const sizePt = z.fh / scale;
  const origWpt = z.w / scale;

  const doCommit = (val) => {
    done = true;
    bar.remove();
    if (val === z.str && state.bold === z.bold && state.italic === z.italic) return;
    z.used = true;
    const newWpt = val ? measureTextPx(val, state.family, state.bold, state.italic, z.fh) / scale : 0;
    ops.push({
      page: view.pageNum - 1, kind: 'text',
      rect: { x: z.x / scale - 1, y: view.heightPts - z.baselineY / scale - sizePt * 0.32,
              w: Math.max(origWpt, newWpt) + 2, h: sizePt * 1.3 },
      text: val, family: state.family, bold: state.bold, italic: state.italic,
      underline: state.underline, strike: state.strike,
      font: stdFontKey(state.family, state.bold, state.italic),
      size: sizePt,
      baselineY: view.heightPts - z.baselineY / scale,
      color: { r: 0, g: 0, b: 0 },
    });
    repaintAll(); refreshButtons();
  };

  const attempt = () => {
    if (done) return;
    const val = input.value;
    const newWpt = val ? measureTextPx(val, state.family, state.bold, state.italic, z.fh) / scale : 0;
    if (val && newWpt > origWpt + 1) {
      // Replacement is wider than the original: it would cover whatever stands
      // to the right. Never do that silently - ask first. Set done before the
      // DOM swap so the input's blur can't re-enter.
      done = true;
      showOverflowConfirm(view, bar, () => doCommit(val), () => { bar.remove(); });
      return;
    }
    doCommit(val);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attempt();
    if (e.key === 'Escape') { done = true; bar.remove(); }
  });
  input.addEventListener('blur', attempt);
}

function showOverflowConfirm(view, bar, onApply, onCancel) {
  bar.innerHTML = '';
  const warn = document.createElement('div');
  warn.className = 'ovfbar';
  const msg = document.createElement('span');
  msg.textContent = 'Wider than the original - it will cover whatever is to the right.';
  const ok = document.createElement('button'); ok.textContent = 'Cover anyway'; ok.className = 'warnapply';
  const no = document.createElement('button'); no.textContent = 'Cancel';
  ok.onclick = onApply; no.onclick = onCancel;
  warn.append(msg, ok, no);
  bar.append(warn);
}

// ---------- whiteout drag + add text ----------
// Pointer events unify mouse, pen and touch. For a finger drag to draw instead
// of scrolling the page, the overlay needs touch-action: none; it is applied
// only while the whiteout tool is active (#pages.drawtouch, see CSS), so page
// scrolling keeps working in the other tools.
pagesEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.editbar')) return;
  const overlay = e.target.closest('.overlay');
  if (!overlay) return;
  const view = pageViews.find((v) => v && v.overlay === overlay);
  if (!view) return;
  if (!e.isPrimary) return; // single-pointer gestures only (ignore 2nd finger)
  // Mouse: preventDefault preserves the existing focus/editbox behavior.
  // Whiteout on touch: suppress compatibility mouse events (touch-action: none
  // already keeps the gesture from scrolling). In edit/add-text touch mode the
  // gesture is left to the browser so a finger drag can still pan the page.
  if (e.pointerType === 'mouse' || tool === 'whiteout') e.preventDefault();
  const rect = overlay.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

  if (tool === 'whiteout') {
    const pid = e.pointerId;
    const box = document.createElement('div');
    box.className = 'wrect'; overlay.append(box);
    const unhook = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
      box.style.left = Math.min(sx, cx) + 'px'; box.style.top = Math.min(sy, cy) + 'px';
      box.style.width = Math.abs(cx - sx) + 'px'; box.style.height = Math.abs(cy - sy) + 'px';
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      unhook();
      const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
      const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
      box.remove();
      if (w < 4 || h < 4) return;
      ops.push({ page: view.pageNum - 1, kind: 'whiteout',
                 rect: { x: Math.min(sx, cx) / scale,
                         y: view.heightPts - Math.max(sy, cy) / scale,
                         w: w / scale, h: h / scale } });
      repaintAll(); refreshButtons();
    };
    const cancel = (ev) => {
      if (ev.pointerId !== pid) return;
      unhook(); box.remove(); // gesture taken over by the browser (e.g. scroll): drop the draft
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  if (tool === 'addtext') {
    const sizePt = 14;
    const { bar, input, state } = makeEditBar(view, sx, sy - sizePt * scale, 220, sizePt * scale, 'sans', false, false, '', { multiline: true, lists: true });
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const val = input.value.replace(/\s+$/, ''); bar.remove();
      if (!val) return;
      ops.push({ page: view.pageNum - 1, kind: 'addtext',
                 rect: { x: sx / scale, y: 0, w: 0, h: 0 },
                 text: val, family: state.family, bold: state.bold, italic: state.italic,
                 underline: state.underline, strike: state.strike, listStyle: state.listStyle,
                 font: stdFontKey(state.family, state.bold, state.italic),
                 size: sizePt,
                 baselineY: view.heightPts - sy / scale, color: { r: 0, g: 0, b: 0 } });
      repaintAll(); refreshButtons();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
      if (e.key === 'Escape') { committed = true; bar.remove(); }
    });
    input.addEventListener('blur', commit);
  }
});

// ---------- toolbar ----------
document.querySelectorAll('button.tool').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('button.tool').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); tool = b.dataset.tool;
  // whiteout mode: finger drags on a page draw a patch instead of scrolling
  pagesEl.classList.toggle('drawtouch', tool === 'whiteout');
  repaintAll();
}));
$('#undo').onclick = () => { ops.pop(); repaintAll(); refreshButtons(); };
$('#clear').onclick = () => { ops = []; pageViews.forEach((v) => v && v.zones.forEach((z) => (z.used = false))); repaintAll(); refreshButtons(); };
$('#zoomin').onclick = () => rezoom(scale * 1.2);
$('#zoomout').onclick = () => rezoom(scale / 1.2);
async function rezoom(ns) {
  if (!pdfDoc) return;
  scale = Math.min(4, Math.max(0.4, ns));
  pagesEl.innerHTML = ''; pageViews = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) await renderPage(i);
  refreshButtons();
}

// ---------- export ----------
$('#export').onclick = async () => {
  const btn = $('#export'); btn.disabled = true; btn.textContent = 'Working…';
  try {
    let result;
    if ($('#flattenChk').checked) {
      result = await flattenExport();
    } else {
      result = await applyOps(pdfLib, pdfBytes, ops);
    }
    if (result.failures && result.failures.length) {
      notice(`Could not write ${result.failures.length} text item(s): v1 edits support Latin-script characters only. Tip: Flatten export has no such limit. (${result.failures.map((f) => f.text.slice(0, 20)).join(', ')})`);
    }
    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    notice('Export failed: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Export PDF';
  }
};

async function flattenExport() {
  const flatScale = 2; // ~144 dpi raster
  const pages = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: flatScale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    const heightPts = vp.height / flatScale;
    for (const op of ops) {
      if (op.page !== i - 1) continue;
      if (op.kind === 'whiteout' || op.kind === 'text') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(op.rect.x * flatScale, (heightPts - op.rect.y - op.rect.h) * flatScale,
                     op.rect.w * flatScale, op.rect.h * flatScale);
      }
      if (op.kind === 'text' || op.kind === 'addtext') {
        ctx.fillStyle = '#000';
        ctx.font = `${op.italic ? 'italic ' : ''}${op.bold ? 'bold ' : ''}${op.size * flatScale}px ${cssFontFamily(op.family)}`;
        ctx.textBaseline = 'alphabetic';
        const tx = op.rect.x * flatScale;
        const lineH = op.size * 1.25 * flatScale;
        String(op.text || '').split('\n').forEach((line, i) => {
          const ty = (heightPts - op.baselineY) * flatScale + i * lineH;
          let prefix = '', indent = 0;
          if (op.listStyle === 'bullet') { prefix = '\u2022 '; indent = op.size * 0.9 * flatScale; }
          if (op.listStyle === 'number') { prefix = `${i + 1}. `; indent = op.size * 1.1 * flatScale; }
          if (prefix) ctx.fillText(prefix, tx, ty);
          ctx.fillText(line, tx + indent, ty);
          if (op.underline || op.strike) {
            const w = ctx.measureText(prefix + line).width;
            const thick = Math.max(op.size * flatScale * 0.05, 1);
            if (op.underline) ctx.fillRect(tx, ty + op.size * flatScale * 0.12, w, thick);
            if (op.strike) ctx.fillRect(tx, ty - op.size * flatScale * 0.28, w, thick);
          }
        });
      }
    }
    const blob = await new Promise((res) => c.convertToBlob ? c.convertToBlob({ type: 'image/png' }).then(res) : c.toBlob(res, 'image/png'));
    pages.push({ widthPts: vp.width / flatScale, heightPts, png: new Uint8Array(await blob.arrayBuffer()) });
  }
  return buildFlattened(pdfLib, pages);
}

// ---------- input wiring ----------
$('#file').addEventListener('change', (e) => e.target.files[0] && openFile(e.target.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && /\.pdf$/i.test(f.name)) openFile(f);
});
refreshButtons();
