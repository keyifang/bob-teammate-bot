#!/usr/bin/env python3
"""Render a document to PDF.

Reads a JSON object on stdin, writes PDF bytes to the path given by --out.

    {"title": "...", "body": "...", "source": "..."}  ->  --out /path/file.pdf

ReportLab is used deliberately: it is pure Python with no system dependencies,
so it works on Render's slim image AND on Vercel, where WeasyPrint's
Pango/cairo/GTK chain does not. It does not run JavaScript, which is fine -
the body is plain text, not a web page.

The body is treated as text, never as markup. A body containing HTML tags is
printed literally rather than interpreted, matching the HTML exporter.
"""

import argparse
import json
import sys
from datetime import datetime, timezone

from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

# ReportLab's built-in Helvetica is Latin-1 only, so a body containing an em
# dash, a curly quote or a euro sign would otherwise render as "??" - real
# content loss in the user's own document. Common typographic characters are
# therefore transliterated to a readable ASCII equivalent rather than dropped.
#
# This is lossy on purpose: it keeps the text readable on every target with no
# binary font asset and no system dependency. The upgrade path, if fidelity
# matters later, is to register a bundled Unicode TTF (DejaVu) - but that is a
# binary asset in the deploy bundle, which this avoids.
_TRANSLITERATIONS = {
    "—": " - ",   # em dash
    "–": "-",     # en dash
    "‘": "'",     # left single quote
    "’": "'",     # right single quote
    "“": '"',     # left double quote
    "”": '"',     # right double quote
    "…": "...",   # ellipsis
    "•": "-",     # bullet
    "·": "-",     # middle dot
    "→": "->",    # right arrow
    "←": "<-",    # left arrow
    " ": " ",     # non-breaking space
    " ": "\n",    # line separator
    " ": "\n",    # paragraph separator
    "€": "EUR",   # euro
    "£": "GBP",   # pound
    "¥": "JPY",   # yen
    "✓": "[x]",   # check mark
    "✗": "[ ]",   # ballot x
    "×": "x",     # multiplication sign
    "−": "-",     # minus sign
    "°": "deg",   # degree
    "≤": "<=",    # less-or-equal
    "≥": ">=",    # greater-or-equal
    "≈": "~=",    # approximately
    "®": "(R)",   # registered
    "™": "(TM)",  # trademark
    "©": "(c)",   # copyright
}


def _safe(text):
    """Make text renderable in a Latin-1 font without losing meaning."""
    out = []
    for ch in str(text):
        if ch in _TRANSLITERATIONS:
            out.append(_TRANSLITERATIONS[ch])
            continue
        try:
            ch.encode("latin-1")
            out.append(ch)
        except UnicodeEncodeError:
            # Nothing sensible to substitute: a character with no ASCII
            # equivalent is marked rather than allowed to abort the whole
            # export (which would produce no file at all).
            out.append("?")
    return "".join(out)


def _escape(text):
    return _safe(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_story(payload):
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "BobTitle", parent=styles["Heading1"], fontSize=18, spaceAfter=4, alignment=TA_LEFT
    )
    meta_style = ParagraphStyle(
        "BobMeta", parent=styles["Normal"], fontSize=8, textColor="#666666", spaceAfter=12
    )
    body_style = ParagraphStyle(
        "BobBody", parent=styles["Normal"], fontSize=11, leading=15, spaceAfter=6
    )

    story = []
    story.append(Paragraph(_escape(payload.get("title") or "Bob document"), title_style))

    meta_parts = []
    if payload.get("source"):
        meta_parts.append(_escape(payload["source"]))
    meta_parts.append(
        _escape(payload.get("createdAt") or datetime.now(timezone.utc).isoformat())
    )
    # A literal character, not the &middot; entity: ReportLab does not decode
    # HTML entities, so the entity rendered as two broken glyphs in the output.
    story.append(Paragraph(" · ".join(meta_parts), meta_style))

    body = str(payload.get("body") or "")
    if not body.strip():
        story.append(Paragraph("(empty)", body_style))
        return story

    # Blank lines separate paragraphs; single newlines are kept as line breaks
    # inside one paragraph, so a list stays visually a list.
    for block in body.split("\n\n"):
        text = block.strip()
        if not text:
            continue
        story.append(Paragraph(_escape(text).replace("\n", "<br/>"), body_style))

    story.append(Spacer(1, 10 * mm))
    return story


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="path to write the PDF to")
    args = parser.parse_args()

    # stdin is decoded with the LOCALE encoding, which on a Windows/CJK host is
    # gbk - so UTF-8 bytes from the pipe arrive as mojibake and every non-ASCII
    # character is corrupted before the transliteration map can see it. Forcing
    # UTF-8 here makes the result identical on every platform. The bytes are
    # read raw and decoded explicitly for the same reason.
    try:
        raw = sys.stdin.buffer.read()
    except AttributeError:
        raw = sys.stdin.read().encode("utf-8", "replace")

    try:
        payload = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        print(f"invalid JSON on stdin: {err}", file=sys.stderr)
        return 2

    doc = SimpleDocTemplate(
        args.out,
        pagesize=A4,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        title=_safe(payload.get("title") or "Bob document"),
    )
    try:
        doc.build(build_story(payload))
    except Exception as err:  # noqa: BLE001 - the caller needs a message, not a traceback
        print(f"pdf build failed: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
