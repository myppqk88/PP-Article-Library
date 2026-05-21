"""OCR fallback for scanned PDFs.

Used by `organize.extract_pdf_text` when the regular text extraction returns
too little (= the PDF is image-only / scanned). Renders each page to PNG via
PyMuPDF, runs the configured OCR engine, and returns concatenated text.

Engines (selectable via settings.ocr.engine):
    rapidocr  — RapidOCR / ONNX runtime (default). Pure pip, ~50MB total,
                models bundled in the wheel. Cross-platform.
    easyocr   — EasyOCR / PyTorch. ~350MB install. Higher recall on noisy
                scans but heavier.
    cloud     — Call a hosted OCR API (Mistral / 火山豆包 / 阿里通义读图).
                Settings.ocr.cloud.provider picks which. Pay-per-page.
    none      — Skip OCR entirely (legacy behavior).

Cache: results stored to library/text/{hash}.ocr.txt — keyed by file hash, so
re-runs read from disk. Delete the .ocr.txt to force re-OCR.

This module catches its own ImportError on engine boot so the rest of the
workbench keeps working if the user hasn't pip installed yet — it just logs
a hint and returns "".
"""

from __future__ import annotations

import os
import sys
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


def _log(msg: str) -> None:
    print(f"[ocr] {msg}", file=sys.stderr, flush=True)


# ============================================================================
# Engine dispatcher
# ============================================================================
def run_ocr_on_pdf(
    pdf_path: Path,
    settings: dict[str, Any],
    file_hash: str = "",
    force: bool = False,
) -> str:
    """Run OCR over a PDF and return concatenated text.

    Caches to library/text/{hash}.ocr.txt when file_hash is supplied. If the
    cached file exists and force=False, returns it without re-running OCR.

    Returns empty string on any failure (logged to stderr).
    """
    ocr_cfg = settings.get("ocr", {}) or {}
    engine = str(ocr_cfg.get("engine", "rapidocr")).strip().lower()

    if engine in {"none", "off", "disabled", ""}:
        return ""

    # Check cache
    text_dir = ROOT / settings.get("paths", {}).get("text_dir", "library/text")
    text_dir.mkdir(parents=True, exist_ok=True)
    cache_path = text_dir / f"{file_hash}.ocr.txt" if file_hash else None
    if cache_path and cache_path.exists() and not force:
        _log(f"cache hit: {cache_path.name}")
        return cache_path.read_text(encoding="utf-8")

    # Render PDF pages to images
    try:
        images = _render_pdf_to_images(pdf_path, settings)
    except Exception as exc:
        _log(f"render failed for {pdf_path.name}: {exc}")
        return ""
    if not images:
        return ""

    _log(f"running engine={engine} on {len(images)} pages of {pdf_path.name}")

    try:
        if engine == "rapidocr":
            text = _ocr_with_rapidocr(images)
        elif engine == "easyocr":
            text = _ocr_with_easyocr(images, ocr_cfg)
        elif engine in {"cloud", "api"}:
            text = _ocr_with_cloud(images, ocr_cfg, settings)
        else:
            _log(f"unknown engine '{engine}' — falling back to rapidocr")
            text = _ocr_with_rapidocr(images)
    except ImportError as exc:
        _log(
            f"engine '{engine}' not installed: {exc}.\n"
            f"  Install with: pip install -r requirements.txt\n"
            f"  Or pick another engine in 设置→主模型→OCR."
        )
        return ""
    except Exception as exc:
        import traceback
        traceback.print_exc()
        _log(f"engine '{engine}' failed: {exc}")
        return ""

    text = text.strip()
    if cache_path and text:
        from common import atomic_write_text
        atomic_write_text(cache_path, text)
        _log(f"wrote {len(text)} chars → {cache_path.name}")
    return text


# ============================================================================
# Page → image rendering
# ============================================================================
def _render_pdf_to_images(pdf_path: Path, settings: dict[str, Any]) -> list[Any]:
    """Render PDF pages to numpy arrays via PyMuPDF.

    Returns list of (page_num_1based, np.ndarray RGB) tuples.
    """
    import fitz  # PyMuPDF
    import numpy as np
    from PIL import Image

    dpi = int(settings.get("pdf", {}).get("image_dpi", 150))
    ocr_cfg = settings.get("ocr", {}) or {}
    max_pages = int(ocr_cfg.get("max_pages", 30))

    doc = fitz.open(str(pdf_path))
    try:
        page_count = len(doc)
        max_pages = min(max_pages, page_count)
        images = []
        for i in range(max_pages):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img = Image.frombytes(
                "RGB",
                (pix.width, pix.height),
                pix.samples,
            )
            arr = np.array(img)
            images.append((i + 1, arr))
        return images
    finally:
        doc.close()


# ============================================================================
# Engine: RapidOCR (default)
# ============================================================================
def _ocr_with_rapidocr(images: list[Any]) -> str:
    """RapidOCR via onnxruntime. Models are bundled in the wheel."""
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    parts: list[str] = []
    for page_num, arr in images:
        result, _ = ocr(arr)
        parts.append(f"\n\n--- Page {page_num} ---")
        if result:
            # result: list of (bbox, text, confidence)
            # bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — corners
            # Sort by y-coord (top of bbox) for reading order
            try:
                result.sort(key=lambda r: min(p[1] for p in r[0]))
            except Exception:
                pass
            for entry in result:
                try:
                    _, text, _conf = entry
                except (ValueError, TypeError):
                    continue
                if text and text.strip():
                    parts.append(text.strip())
    return "\n".join(parts)


# ============================================================================
# Engine: EasyOCR
# ============================================================================
def _ocr_with_easyocr(images: list[Any], ocr_cfg: dict[str, Any]) -> str:
    """EasyOCR via PyTorch. Heavier but sometimes more accurate."""
    import easyocr

    langs = ocr_cfg.get("easyocr_langs", ["ch_sim", "en"])
    reader = easyocr.Reader(langs, gpu=False)
    parts: list[str] = []
    for page_num, arr in images:
        result = reader.readtext(arr, detail=0, paragraph=True)
        parts.append(f"\n\n--- Page {page_num} ---")
        if result:
            parts.extend(line.strip() for line in result if line and line.strip())
    return "\n".join(parts)


# ============================================================================
# Engine: Cloud OCR APIs (Mistral / 火山豆包 / 阿里通义)
# ============================================================================
def _ocr_with_cloud(images: list[Any], ocr_cfg: dict[str, Any], settings: dict[str, Any]) -> str:
    """Generic OpenAI-compatible vision endpoint for OCR.

    Sends each rendered page as base64 image to a vision LLM with a prompt
    asking for verbatim OCR. Works with any provider that speaks OpenAI's
    chat-completions schema and accepts image_url content parts.
    """
    import base64
    import io
    import requests
    from PIL import Image

    cloud = ocr_cfg.get("cloud", {}) or {}
    base_url = str(cloud.get("base_url", "")).rstrip("/")
    model = str(cloud.get("model", "")).strip()
    api_key_env = str(cloud.get("api_key_env", "")).strip()
    key = os.environ.get(api_key_env, "") if api_key_env else ""
    if not base_url:
        raise RuntimeError("cloud OCR: base_url is empty")
    if not model:
        raise RuntimeError("cloud OCR: model is empty")
    if not key:
        raise RuntimeError(f"cloud OCR: no API key in env {api_key_env}")

    parts: list[str] = []
    for page_num, arr in images:
        img = Image.fromarray(arr)
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        resp = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "请识别并输出这张论文页面图片里所有文字，按从上到下从左到右的阅读顺序，原样输出，不要总结、不要解释。如果有公式，用 LaTeX 表示。",
                            },
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{b64}"},
                            },
                        ],
                    }
                ],
                "max_tokens": 4000,
                "temperature": 0.0,
            },
            timeout=int(cloud.get("timeout_seconds", 90)),
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"cloud OCR HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        parts.append(f"\n\n--- Page {page_num} ---")
        parts.append(text.strip())
    return "\n".join(parts)


# ============================================================================
# CLI test entry
# ============================================================================
if __name__ == "__main__":
    import yaml
    if len(sys.argv) < 2:
        print("usage: python ocr.py <pdf_path> [engine]")
        sys.exit(1)
    pdf = Path(sys.argv[1]).resolve()
    settings = yaml.safe_load((ROOT / "config" / "settings.yaml").read_text(encoding="utf-8"))
    if len(sys.argv) > 2:
        settings.setdefault("ocr", {})["engine"] = sys.argv[2]
    out = run_ocr_on_pdf(pdf, settings, file_hash="", force=True)
    print(out)
