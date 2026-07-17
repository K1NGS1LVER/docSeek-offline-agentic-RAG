"""
Optional local OCR fallback for scanned / image-only PDFs.

pypdf only reads a PDF's text layer; a scanned document has none, so it yields
nothing. When that happens we render each page to an image with pypdfium2
(a pip wheel that bundles PDFium -- no poppler/system renderer needed) and run
Tesseract over it. Everything stays on-device, consistent with docSeek's
privacy model.

This is best-effort and gracefully absent: it needs the `pypdfium2` and
`pytesseract` packages plus the `tesseract` binary (`brew install tesseract`).
When any of those is missing, is_available() is False and PDF ingestion simply
falls back to whatever text layer exists (possibly empty).
"""

import logging
import shutil
from typing import Optional

logger = logging.getLogger(__name__)

# Render scale for OCR. ~2.0 gives roughly 144 dpi, a good accuracy/speed balance.
RENDER_SCALE = 2.0
# Cap pages OCR'd per document so a huge scan can't hang ingestion.
MAX_OCR_PAGES = 50

_available: Optional[bool] = None


def is_available() -> bool:
    """True if scanned-PDF OCR can run (Python deps + tesseract binary present).

    Cached after the first probe; logs a one-line hint when unavailable.
    """
    global _available
    if _available is not None:
        return _available
    try:
        import pypdfium2  # noqa: F401
        import pytesseract  # noqa: F401
    except Exception as e:
        logger.info(f"OCR Python deps missing ({e}); scanned-PDF OCR disabled.")
        _available = False
        return _available
    if shutil.which("tesseract") is None:
        logger.info("tesseract binary not found; scanned-PDF OCR disabled "
                    "(install with `brew install tesseract`).")
        _available = False
        return _available
    _available = True
    return _available


def ocr_pdf(data: bytes) -> str:
    """OCR a PDF's pages to text. Returns "" if OCR is unavailable or fails.

    Only meant as a fallback when a PDF has no extractable text layer -- OCR is
    much slower than text extraction, so callers should try pypdf first.
    """
    if not is_available():
        return ""
    import pypdfium2 as pdfium
    import pytesseract

    parts = []
    try:
        pdf = pdfium.PdfDocument(data)
    except Exception as e:
        logger.warning(f"OCR could not open PDF: {e}")
        return ""
    try:
        n = min(len(pdf), MAX_OCR_PAGES)
        for i in range(n):
            try:
                page = pdf[i]
                image = page.render(scale=RENDER_SCALE).to_pil()
                text = pytesseract.image_to_string(image)
            except Exception as e:
                logger.warning(f"OCR failed on page {i}: {e}")
                continue
            if text.strip():
                parts.append(text.strip())
    finally:
        pdf.close()
    return "\n\n".join(parts)
