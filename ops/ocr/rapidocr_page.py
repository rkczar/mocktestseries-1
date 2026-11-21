#!/usr/bin/env python3
"""OCR of ONE page for the AI Question Importer (run by lib/ai-import/tools.ts as a bounded child process).

Input is either a PDF page (rendered here with poppler's pdftoppm) or an image file. The original file is only read.
Output (stdout) is one JSON object:
  engine, width, height, dpi, ink (share of dark pixels), seconds,
  lines: [{text, score, box: [x0, y0, x1, y1], poly: [[x, y] x4], reread?: {text, score, dpi}}]
Boxes are pixels of the page image at `dpi`. A line read with low confidence is read again from a sharper crop
(400 dpi for PDFs, 2x upscale for images); the first reading is always kept next to the second, and the line's
`text` is the better-scored of the two. A statement line whose printed number the detector missed gets its empty margin
read again (recover_labels); a label found there is added as its own line with `recovered` provenance. A colored watermark across the text is lightened before OCR (output
`watermark: true`). Nothing is corrected or guessed here.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

PDFTOPPM = "/usr/bin/pdftoppm"
LOW = 0.90  # lines below this confidence are read again from a sharper crop
REREAD_DPI = 400
MAX_PIXELS = 40_000_000  # a page stored at an oversized point size (e.g. a 600-dpi scan saved as 4960x7015 pt) is rendered at a lower dpi


def fit_dpi(pdf, page, dpi):
    """The dpi at which the page renders within MAX_PIXELS (never above `dpi`)."""
    out = subprocess.run(["/usr/bin/pdfinfo", "-f", str(page), "-l", str(page), pdf], capture_output=True, text=True, timeout=60).stdout
    for line in out.splitlines():
        if line.startswith(f"Page {page:4d} size:") or (line.startswith("Page size:") and page == 1):
            parts = line.split(":", 1)[1].split()
            try:
                w, h = float(parts[0]), float(parts[2])
            except (IndexError, ValueError):
                return dpi
            return max(36, min(dpi, int((MAX_PIXELS / (w * h / 72 / 72)) ** 0.5)))
    return dpi
MAX_REREADS = 40


def render(pdf, page, dpi, out_base, crop=None):
    args = [PDFTOPPM, "-png", "-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile"]
    if crop:
        x, y, w, h = crop
        args += ["-x", str(x), "-y", str(y), "-W", str(w), "-H", str(h)]
    subprocess.run(args + [pdf, out_base], check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out_base + ".png"


def ink_share(img):
    """Share of clearly dark pixels (0..1) on a grey copy; used to tell a really blank page from a page OCR missed."""
    import numpy as np

    a = np.asarray(img.convert("L"), dtype=np.uint8)
    return float((a < 128).mean())


WATERMARK_MIN_SHARE = 0.005  # colored pixels on more than 0.5% of the page → treat as a watermark


def strip_watermark(img, out_path):
    """A tinted logo/watermark printed across the text hides lines from the detector. On a page with colored pixels each
    pixel becomes its brightest channel: black/grey text is unchanged, colored marks turn light. Returns the cleaned
    file path, or None when the page has no color. The original file is never changed."""
    import numpy as np
    from PIL import Image

    if img.mode != "RGB":
        return None
    a = np.asarray(img, dtype=np.uint8)
    mx = a.max(axis=2)
    if float(((mx.astype(np.int16) - a.min(axis=2)) > 40).mean()) < WATERMARK_MIN_SHARE:
        return None
    Image.fromarray(mx).save(out_path)
    return out_path


def lines_of(result):
    if result is None or result.txts is None:
        return []
    out = []
    for text, score, poly in zip(result.txts, result.scores, result.boxes.tolist()):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        out.append({"text": text, "score": round(float(score), 4), "box": [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)], "poly": [[round(p[0], 1), round(p[1], 1)] for p in poly]})
    return out


LABEL_ONLY = re.compile(r"^\(?([1-9]|[ivx]{1,4}|[a-h])[.)]$")
LABEL_START = re.compile(r"^\(?([1-9]|[ivx]{1,4}|[a-h])[.)]\s+\S")
LABEL_MIN = 0.90  # a recovered label is kept only when the margin is read as exactly one label at >= this confidence
MAX_LABEL_READS = 30


def label_candidates(lines):
    """Statement lines that lost their printed number (2026-11-20: the detector misses small isolated "1." / "2." boxes —
    CMS 2024 Q69 "Hepatitis B vaccine", Q89 "Valproate"): a label box sits left of an ALIGNED neighbour line within four
    rows (its text starts where this line starts), and nothing is printed in this line's margin. Returns the margin boxes."""
    labels = [l for l in lines if LABEL_ONLY.match(l["text"].strip())]
    out = []
    for l in lines:
        t = l["text"].strip()
        if not labels or LABEL_ONLY.match(t) or LABEL_START.match(t):
            continue
        x0, y0, x1, y1 = l["box"]
        h = y1 - y0
        if h <= 0:
            continue
        mid = (y0 + y1) / 2
        near = []
        for lb in labels:
            bx0, by0, bx1, by1 = lb["box"]
            if abs((by0 + by1) / 2 - mid) > 4.5 * h or bx1 > x0 + 2 or x0 - bx1 > 4 * h:
                continue
            row = [m for m in lines if m is not lb and abs((m["box"][1] + m["box"][3]) / 2 - (by0 + by1) / 2) < 0.5 * h and m["box"][0] > bx1 - 2]
            if row and abs(min(r["box"][0] for r in row) - x0) <= 0.8 * h:
                near.append(lb)
        if not near:
            continue
        lx0 = min(lb["box"][0] for lb in near)
        if any(m is not l and m["box"][2] > lx0 and m["box"][0] < x0 - 2 and abs((m["box"][1] + m["box"][3]) / 2 - mid) < 0.5 * h for m in lines):
            continue
        out.append((l, [max(0.0, lx0 - 0.3 * h), max(0.0, y0 - 0.25 * h), x0 - 1, y1 + 0.25 * h]))
    return out


def recover_labels(ocr, lines, a, img, tmp, width, height):
    """Reads only the empty margin left of each candidate line again (400 dpi for a PDF, 3x upscale for an image). A label
    is added as its own line only when the page itself reads exactly one label there (never inferred from the sequence);
    the line records where it came from. Returns the number of labels added."""
    from PIL import Image

    added = 0
    for i, (line, (x0, y0, x1, y1)) in enumerate(label_candidates(lines)[:MAX_LABEL_READS]):
        x1, y1 = min(width, x1), min(height, y1)
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        try:
            if a.pdf:
                rdpi = min(REREAD_DPI, a.dpi * 2)
                k = rdpi / a.dpi
                crop = render(a.pdf, a.page, rdpi, os.path.join(tmp, f"label{i}"), (int(x0 * k), int(y0 * k), max(1, int((x1 - x0) * k)), max(1, int((y1 - y0) * k))))
            else:
                c = img.crop((int(x0), int(y0), int(x1), int(y1)))
                c = c.resize((c.size[0] * 3, c.size[1] * 3), Image.LANCZOS)
                crop = os.path.join(tmp, f"label{i}.png")
                c.save(crop)
            r = ocr(crop)
            read = [(t, float(sc)) for t, sc in zip(r.txts or [], r.scores or [])]
            if not read:  # a lone small "2." can escape the detector: recognition only, on the whole margin
                r = ocr(crop, use_det=False, use_cls=False, use_rec=True)
                read = [(t, float(sc)) for t, sc in zip(r.txts or [], r.scores or [])]
        except Exception as e:  # a failed margin read changes nothing
            line.setdefault("labelReread", {"error": str(e)[:200]})
            continue
        good = [(t.strip(), sc) for t, sc in read if LABEL_ONLY.match(t.strip()) and sc >= LABEL_MIN]
        if len(good) != 1 or len(read) != 1:
            continue
        text, score = good[0]
        box = [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]
        lines.append({"text": text, "score": round(score, 4), "box": box, "poly": [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], "recovered": {"from": "margin re-read", "forLine": line["text"][:80], "dpi": REREAD_DPI if a.pdf else None}})
        added += 1
    return added


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf")
    ap.add_argument("--page", type=int)
    ap.add_argument("--image")
    ap.add_argument("--dpi", type=int, default=200)
    a = ap.parse_args()
    if not (a.pdf and a.page) and not a.image:
        print(json.dumps({"error": "give --pdf and --page, or --image"}))
        return 2
    t0 = time.time()
    from PIL import Image
    from rapidocr import RapidOCR

    Image.MAX_IMAGE_PIXELS = 80_000_000
    ocr = RapidOCR()
    with tempfile.TemporaryDirectory(prefix="mts-ocr-") as tmp:
        if a.pdf:
            a.dpi = fit_dpi(a.pdf, a.page, a.dpi)
            path = render(a.pdf, a.page, a.dpi, os.path.join(tmp, "page"))
        else:
            path = a.image
        img = Image.open(path)
        img.load()
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        width, height = img.size
        ink = ink_share(img)
        clean = strip_watermark(img, os.path.join(tmp, "clean.png"))
        lines = lines_of(ocr(clean or path))
        rereads = 0
        for i, line in enumerate(sorted(range(len(lines)), key=lambda k: lines[k]["score"])):
            ln = lines[line]
            if ln["score"] >= LOW or rereads >= MAX_REREADS:
                break
            rereads += 1
            x0, y0, x1, y1 = ln["box"]
            pad = max(6.0, (y1 - y0) * 0.35)
            x0, y0 = max(0.0, x0 - pad), max(0.0, y0 - pad)
            x1, y1 = min(width, x1 + pad), min(height, y1 + pad)
            try:
                if a.pdf:
                    rdpi = min(REREAD_DPI, a.dpi * 2)
                    k = rdpi / a.dpi
                    crop = render(a.pdf, a.page, rdpi, os.path.join(tmp, f"crop{i}"), (int(x0 * k), int(y0 * k), max(1, int((x1 - x0) * k)), max(1, int((y1 - y0) * k))))
                    dpi = rdpi
                else:
                    c = img.crop((int(x0), int(y0), int(x1), int(y1)))
                    c = c.resize((c.size[0] * 2, c.size[1] * 2), Image.LANCZOS)
                    crop = os.path.join(tmp, f"crop{i}.png")
                    c.save(crop)
                    dpi = None
                if clean:
                    with Image.open(crop) as ci:
                        ci.load()
                        crop = strip_watermark(ci.convert("RGB"), os.path.join(tmp, f"crop{i}-clean.png")) or crop
                r = lines_of(ocr(crop))
            except Exception as e:  # a failed re-read keeps the first reading
                ln["reread"] = {"error": str(e)[:200]}
                continue
            if r:
                text = " ".join(x["text"] for x in sorted(r, key=lambda x: x["box"][0]))
                score = min(x["score"] for x in r)
                ln["reread"] = {"text": text, "score": score, "dpi": dpi, "firstText": ln["text"], "firstScore": ln["score"]}
                if score > ln["score"]:
                    ln["text"], ln["score"] = text, score
            else:
                ln["reread"] = {"text": "", "score": 0.0, "dpi": dpi, "firstText": ln["text"], "firstScore": ln["score"]}
        recovered = recover_labels(ocr, lines, a, img, tmp, width, height)
    from importlib.metadata import version

    print(json.dumps({"engine": f"rapidocr {version('rapidocr')} PP-OCRv6", "width": width, "height": height, "dpi": a.dpi if a.pdf else None, "ink": round(ink, 5), "watermark": bool(clean), "rereads": rereads, "labelsRecovered": recovered, "seconds": round(time.time() - t0, 2), "lines": lines}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
