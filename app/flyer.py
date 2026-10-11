"""Act -> print-ready flyer PDF (PDF-route P3).

The Act tab's winning draft is typeset onto ONE page, LETTER, ready to print
and paste in the shop window: mint header band + CallCrowd mark, big wrapped
headline (the draft title), comfortable body copy, a "why the swarm says so"
ribbon of 2-3 punchy points pulled from the verdict's segment impacts /
objections, and a footer with the business town + hours (only when an hours
evidence card exists) + "Made with CallCrowd".

Deterministic: Canvas(invariant=1) fixes the creation date + document id, so
the same session + draft -> byte-identical PDF. No network, no timestamps.
Routing/gating stays in app.main (render_flyer raises only on missing draft).
"""
from __future__ import annotations

import io
import logging
import os

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

log = logging.getLogger("flyer")

MINT = HexColor("#45D0C6")
DARK = HexColor("#0E0E10")
INK = HexColor("#111111")
GRAY = HexColor("#4B5563")
HAIRLINE = HexColor("#D1D5DB")
MINT_DARK = HexColor("#0E7C74")     # readable mint brand text on white
MINT_TINT = HexColor("#EAF9F7")     # "why" ribbon wash

PAGE_W, PAGE_H = letter              # 612 x 792 pt
MARGIN = 54.0

_LOGO_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "static", "assets", "logo.png")
_seen_sessions: set[str] = set()     # "first render" log bookkeeping only


# ---------------------------------------------------------------- text helpers


def _wrap(text: str, font: str, size: float, max_w: float) -> list[str]:
    """Greedy word wrap measured by reportlab stringWidth — deterministic."""
    lines: list[str] = []
    for para in str(text or "").split("\n"):
        words = para.split()
        if not words:
            lines.append("")
            continue
        cur = words[0]
        for w in words[1:]:
            trial = cur + " " + w
            if stringWidth(trial, font, size) <= max_w:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def _trim(text: str, max_chars: int = 120) -> str:
    """Punchy one-liner: cut at a sentence/clause boundary inside the budget."""
    t = " ".join(str(text or "").split())
    if len(t) <= max_chars:
        return t
    cut = t[:max_chars]
    for stop in (".", "!", "?", ",", ";", "—"):
        pos = cut.rfind(stop)
        if pos > max_chars * 0.55:
            return cut[:pos + (1 if stop in ".!?" else 0)]
    return cut.rstrip() + "…"


def _why_points(verdict: dict) -> list[str]:
    """2-3 strongest supporting bullet lines: segment impacts first, then the
    objections' top lines when the impacts run short. Evidence-lite by design."""
    v = verdict or {}
    pts: list[str] = []
    for si in (v.get("segment_impact") or []):
        if not isinstance(si, dict):
            continue
        seg = " ".join(str(si.get("segment", "")).split())
        imp = " ".join(str(si.get("impact", "")).split())
        if not imp:
            continue
        label = (seg + ": ") if seg else ""
        pts.append(_trim(label + imp))
        if len(pts) == 3:
            return pts
    for o in (v.get("objections") or []):
        if len(pts) == 3:
            break
        t = " ".join(str(o).split())
        if not t:
            continue
        head = _trim(t.split(".")[0], 110)
        if head and head not in pts:
            pts.append(head)
    return pts[:3]


def _hours_line(evidence: list) -> str:
    """The session's business hours — first evidence card whose type is hours,
    or whose claim/quote carries a time-of-day pattern ('11 AM', '9:00').
    Empty string when none exists (footer hours skipped)."""
    import re
    timeish = re.compile(r"\d{1,2}\s*(am|pm)|\d{1,2}:\d{2}", re.I)
    for c in evidence:
        if not isinstance(c, dict):
            continue
        body = (str(c.get("claim", "")).strip()
                or str(c.get("quote", "")).strip())
        if not body:
            continue
        if str(c.get("type", "")).strip().lower() == "hours":
            return _trim(body, 90)
        blob = str(c.get("claim", "")) + " " + str(c.get("quote", "")) or ""
        if "hour" in blob.lower() and timeish.search(str(c.get("claim", ""))):
            return _trim(str(c.get("claim", "")).strip(), 90)
    return ""


# ---------------------------------------------------------------- rendering


def render_flyer(session: dict, draft: dict) -> bytes:
    """The winning Act draft, typeset onto one printable page. Returns PDF bytes."""
    session = session or {}
    draft = draft or {}
    biz = session.get("business") or {}
    name = " ".join(str(biz.get("name") or "Your Business").split()) or "Your Business"
    town = " ".join(str(biz.get("town") or "").split())
    title = " ".join(str(draft.get("title") or "").split()) or "Our decision"
    body = str(draft.get("body_text") or "").strip()
    why = _why_points(session.get("verdict") or {})
    hours = _hours_line(session.get("evidence") or [])

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, invariant=1, pageCompression=0)
    c.setTitle(f"CallCrowd flyer — {name}")
    c.setAuthor("CallCrowd")

    # ---- header band (full-bleed mint) ------------------------------------
    band_h = 168.0
    band_bottom = PAGE_H - band_h
    c.setFillColor(MINT)
    c.rect(0, band_bottom, PAGE_W, band_h, stroke=0, fill=1)

    # half-tone dot grid in the band's lower-left corner (kept left of MARGIN)
    try:
        c.setFillAlpha(0.12)
    except Exception:  # noqa: BLE001 — very old reportlab: just skip the dots
        pass
    c.setFillColor(DARK)
    for gx in range(3):
        for gy in range(9):
            c.circle(20.0 + gx * 12.0, band_bottom + 16.0 + gy * 13.0, 1.5,
                     stroke=0, fill=1)
    try:
        c.setFillAlpha(1.0)
    except Exception:  # noqa: BLE001
        pass

    # CallCrowd mark on a white chip, top-right corner (logo.png, NOT wordmark)
    chip_w, chip_h = 122.0, 34.0
    chip_x, chip_y = PAGE_W - 20 - chip_w, PAGE_H - 16 - chip_h
    c.setFillColor(HexColor("#FFFFFF"))
    c.roundRect(chip_x, chip_y, chip_w, chip_h, 9, stroke=0, fill=1)
    logo_size = 24.0
    if os.path.isfile(_LOGO_PATH):
        try:
            c.drawImage(ImageReader(_LOGO_PATH), chip_x + 7,
                        chip_y + (chip_h - logo_size) / 2.0,
                        logo_size, logo_size, mask="auto")
        except Exception:  # noqa: BLE001 — fall through to a plain bubble mark
            c.setFillColor(MINT)
            c.circle(chip_x + 7 + logo_size / 2, chip_y + chip_h / 2,
                     logo_size / 2, stroke=0, fill=1)
    c.setFillColor(DARK)
    c.setFont("Helvetica-Bold", 12.5)
    c.drawString(chip_x + 7 + logo_size + 8, chip_y + chip_h / 2 - 4.5, "CallCrowd")

    # business name (big, bold, auto-shrinks when long) + town line, bottom-anchored
    name_max_w = PAGE_W - 20 - chip_w - 16 - MARGIN   # stop short of the chip
    name_size, name_lines = 40.0, _wrap(name, "Helvetica-Bold", 40.0, name_max_w)
    while len(name_lines) > 2 and name_size > 26:
        name_size -= 3
        name_lines = _wrap(name, "Helvetica-Bold", name_size, name_max_w)
    first_baseline = (band_bottom + 58 + name_size * 1.08 * (len(name_lines) - 1))
    c.setFillColor(DARK)
    c.setFont("Helvetica-Bold", name_size)
    ny = first_baseline
    for ln in name_lines:
        c.drawString(MARGIN, ny, ln)
        ny -= name_size * 1.08
    if town:
        c.setFont("Helvetica", 12.5)
        c.drawString(MARGIN, first_baseline - name_size * 1.08, " ".join(town.split()))

    # dark accent bar under the band
    c.setFillColor(DARK)
    c.rect(0, band_bottom - 5, PAGE_W, 5, stroke=0, fill=1)

    # ---- headline (draft title) --------------------------------------------
    y = band_bottom - 40.0
    head_max_w = PAGE_W - 2 * MARGIN - 18
    head_size, head_lines = 40.0, []
    for size in (40.0, 36.0, 32.0, 27.0, 23.0):
        head_lines = _wrap(title, "Helvetica-Bold", size, head_max_w)
        if len(head_lines) <= 2:
            head_size = size
            break
    if len(head_lines) > 2:  # pathological title: smallest size, top lines only
        head_size = 23.0
        head_lines = _wrap(title, "Helvetica-Bold", head_size, head_max_w)
    head_lines = head_lines[:2] if head_size >= 36 else head_lines[:3]

    # mint vertical accent beside the headline
    bar_h = len(head_lines) * head_size * 1.12
    c.setFillColor(MINT)
    c.roundRect(MARGIN - 2, y - bar_h + head_size * 0.55, 7, bar_h, 3.5,
                stroke=0, fill=1)
    c.setFillColor(INK)
    hx = MARGIN + 18.0
    for ln in head_lines:
        c.setFont("Helvetica-Bold", head_size)
        c.drawString(hx, y, ln)
        y -= head_size * 1.12

    # ---- "why" ribbon (precomputed first: the body layout budgets for it) ----
    rb_x, rb_y = MARGIN, 78.0
    rb_w = PAGE_W - 2 * MARGIN
    why_rows: list[tuple[str, list[str]]] = []
    if why:
        for p in why:
            lines = _wrap(p, "Helvetica", 11.5, rb_w - 58)
            why_rows.append((p, lines[:2]))
        rb_h = 50.0 + sum(len(lns) for _, lns in why_rows) * 16.0

    # ---- body copy (draft body_text) ---------------------------------------
    y -= 16.0
    body_top = y
    body_bottom = rb_y + rb_h + 14 if why else MARGIN + 34
    size, leading = 13.0, 20.0
    blines = _wrap(body, "Helvetica", size, PAGE_W - 2 * MARGIN)
    while len(blines) * leading > (body_top - body_bottom) and size > 10.5:
        size -= 0.5
        leading = size * 1.45
        blines = _wrap(body, "Helvetica", size, PAGE_W - 2 * MARGIN)
    fit = int((body_top - body_bottom) // leading) if leading else 60
    elided = False
    if len(blines) > fit and fit > 1:
        elided = True
        blines = blines[:fit]
        if len(blines[-1]) > 2:
            blines[-1] = blines[-1].rstrip()[:-1].rstrip() + "…"
        else:
            blines[-1] = "…"
    c.setFillColor(INK)
    c.setFont("Helvetica", size)
    for ln in blines:
        c.drawString(MARGIN, y, ln)
        y -= leading
    if elided:
        c.setFillColor(GRAY)
        c.setFont("Helvetica-Oblique", 8.5)
        c.drawString(MARGIN, y + leading - 8,
                     "full text: CallCrowd session — copyable in the console")

    # ---- "why" ribbon -------------------------------------------------------
    if why:
        c.setFillColor(MINT_TINT)
        c.roundRect(rb_x, rb_y, rb_w, rb_h, 10, stroke=0, fill=1)
        c.setFillColor(MINT)
        c.roundRect(rb_x, rb_y + rb_h - 5, 48, 5, 2.5, stroke=0, fill=1)
        ky = rb_y + rb_h - 26
        c.setFillColor(MINT_DARK)
        c.setFont("Helvetica-Bold", 8.5)
        c.drawString(rb_x + 16, ky, "WHY THE SWARM SAYS SO")
        ty = ky - 20
        for _, lines in why_rows:
            c.setFillColor(MINT)
            c.circle(rb_x + 16 + 3.5, ty + 3.5, 2.6, stroke=0, fill=1)
            c.setFillColor(INK)
            c.setFont("Helvetica", 11.5)
            for ln in lines:
                c.drawString(rb_x + 16 + 14, ty, ln)
                ty -= 16
        c.setStrokeColor(HAIRLINE)

    # ---- footer --------------------------------------------------------------
    foot_y = 46.0
    c.setStrokeColor(HAIRLINE)
    c.setLineWidth(0.7)
    c.line(MARGIN, foot_y + 22, PAGE_W - MARGIN, foot_y + 22)
    left = town or name
    if hours:
        left = f"{town or name} · {hours}" if (town or name) else hours
    brand = "Made with CallCrowd"
    brand_w = stringWidth(brand, "Helvetica-Bold", 10.5)
    left_max_w = PAGE_W - 2 * MARGIN - brand_w - 34
    while left and stringWidth(left, "Helvetica", 10.5) > left_max_w:
        left = left[:-1].rstrip()
    c.setFillColor(GRAY)
    c.setFont("Helvetica", 10.5)
    c.drawString(MARGIN, foot_y, left)
    c.setFillColor(MINT_DARK)
    c.rect(PAGE_W - MARGIN - brand_w - 14, foot_y + 3.2, 7, 7, stroke=0, fill=1)
    c.setFillColor(DARK)
    c.setFont("Helvetica-Bold", 10.5)
    c.drawRightString(PAGE_W - MARGIN, foot_y, brand)

    c.showPage()
    c.save()
    data = buf.getvalue()
    sid = str(session.get("session_id") or "?")
    if sid not in _seen_sessions:
        _seen_sessions.add(sid)
        log.info("flyer: first render for session %s (%d bytes, draft %s)",
                 sid, len(data), draft.get("id"))
    return data