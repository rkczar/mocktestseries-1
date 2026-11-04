#!/usr/bin/env python3
"""OCR of ONE page for the AI Question Importer (run by lib/ai-import/tools.ts as a bounded child process).

Input is either a PDF page (rendered here with poppler's pdftoppm) or an image file. The original file is only read.
Output (stdout) is one JSON object:
  engine, width, height, dpi, ink (share of dark pixels), seconds,
  lines: [{text, score, box: [x0, y0, x1, y1], poly: [[x, y] x4], reread?: {text, score, dpi}}]
Boxes are pixels of the page image at `dpi`. A line read with low confidence is read again from a sharper crop
(400 dpi for PDFs, 2x upscale for images); the first reading is always kept next to the second, and the line's
`text` is the better-scored of the two. A colored watermark across the text is lightened before OCR (output
`watermark: true`). Nothing is corrected or guessed here.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

PDFTOPPM = "/usr/bin/pdftoppm"
LOW = 0.90  # lines below this confidence are read again from a sharper crop
REREAD_DPI = 400
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
                    k = REREAD_DPI / a.dpi
                    crop = render(a.pdf, a.page, REREAD_DPI, os.path.join(tmp, f"crop{i}"), (int(x0 * k), int(y0 * k), max(1, int((x1 - x0) * k)), max(1, int((y1 - y0) * k))))
                    dpi = REREAD_DPI
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
    from importlib.metadata import version

    print(json.dumps({"engine": f"rapidocr {version('rapidocr')} PP-OCRv6", "width": width, "height": height, "dpi": a.dpi if a.pdf else None, "ink": round(ink, 5), "watermark": bool(clean), "rereads": rereads, "seconds": round(time.time() - t0, 2), "lines": lines}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
