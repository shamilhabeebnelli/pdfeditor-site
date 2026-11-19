#!/usr/bin/env python3
"""Pixel verification for the PDF Desk prototype test renders.
Reads two PGM (P5) grayscale renders: original and edited.
Checks:
  1. whiteout region: original has ink, edited is clean (no dark pixels)
  2. edited-text region: still has ink (new text drawn)
PDF points -> pixels: r dpi render, y flips (PDF origin is bottom-left).
"""
import sys

def read_pgm(path):
    import re
    with open(path, 'rb') as f:
        data = f.read()
    m = re.match(rb'P5\s+(\d+)\s+(\d+)\s+(\d+)\s', data)
    assert m, data[:40]
    w, h = int(m.group(1)), int(m.group(2))
    payload = data[m.end():m.end() + w * h]
    assert len(payload) == w * h
    return w, h, payload

def dark_count(w, h, px, x0, y0, x1, y1, thresh=128):
    n = 0
    for y in range(max(0, y0), min(h, y1)):
        row = y * w
        for x in range(max(0, x0), min(w, x1)):
            if px[row + x] < thresh: n += 1
    return n

def box(dpi, x, y, wpt, hpt, page_h=600):
    s = dpi / 72.0
    px = int(x * s); py = int((page_h - y - hpt) * s)
    return px, py, int((x + wpt) * s) + 1, int((page_h - y) * s) + 1

orig_w, orig_h, orig = read_pgm(sys.argv[1])
edit_w, edit_h, edit = read_pgm(sys.argv[2])
dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 96

# whiteout rect from the test ops: {x:39, y:496, w:200, h:12}
wo = box(dpi, 39, 496, 200, 12)
wo_orig = dark_count(orig_w, orig_h, orig, *wo)
wo_edit = dark_count(edit_w, edit_h, edit, *wo)

# edited text line: rect {x:39, y:535.5, w:240, h:18.2}
tx = box(dpi, 39, 535.5, 240, 18.2)
tx_orig = dark_count(orig_w, orig_h, orig, *tx)
tx_edit = dark_count(edit_w, edit_h, edit, *tx)

print(f"whiteout region dark px: original={wo_orig}, edited={wo_edit}")
print(f"text region dark px:     original={tx_orig}, edited={tx_edit}")

# underline rule: 'Underlined and struck note' baseline 460, size 12,
# underline at y ~ 458.6-458.0, strike at y ~ 463.4-462.8 (pdf pts)
ul = box(dpi, 40, 457.5, 140, 1.6)
st = box(dpi, 40, 462.3, 140, 1.6)
ul_edit = dark_count(edit_w, edit_h, edit, *ul)
st_edit = dark_count(edit_w, edit_h, edit, *st)
print(f"underline band dark px:  edited={ul_edit}")
print(f"strike band dark px:     edited={st_edit}")

ok = True
if not (wo_orig > 50): print("FAIL: original whiteout region unexpectedly clean"); ok = False
if not (wo_edit == 0): print("FAIL: whiteout left visible ink"); ok = False
if not (tx_edit > 50): print("FAIL: no ink where replacement text should be"); ok = False
if not (ul_edit > 30): print("FAIL: underline rule not drawn"); ok = False
if not (st_edit > 30): print("FAIL: strike rule not drawn"); ok = False
print("PIXEL CHECK:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
