#!/usr/bin/env python3
"""Regenerate the entire Couchside brand asset pack.

Single source of truth for the logomark geometry (a minimal geometric couch
with a green status dot) and the brand palette. Emits scalable SVG masters and
PIL-rendered raster derivatives (favicons, apple-touch, social/OG cards, the
GitHub social preview) plus a favicon.ico and the color/type tokens.

The couch geometry here is byte-identical to app/scripts/make_icon.py, so the
app icon, the favicon, and every web/marketing logo are unmistakably one mark.

Usage:  python3 brand/make_brand.py
Requires: Pillow (freetype), the bundled fonts/SpaceMono-Regular.ttf.
"""

import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "svg")
PNG = os.path.join(HERE, "png")
FONT_PATH = os.path.join(HERE, "fonts", "SpaceMono-Regular.ttf")

# ---------------------------------------------------------------------------
# Palette (see tokens.json / tokens.css, keep in sync)
# ---------------------------------------------------------------------------
NAVY = "#0b1220"       # page / icon background
NAVY_DEEP = "#070d18"
CARD = "#141c2e"
INK = "#e6edf7"        # primary text
MUTED = "#8b98ad"
GREEN = "#34d399"      # status dot + "side" accent
BLUE = "#60a5fa"
WHITE = "#ffffff"

def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

# ---------------------------------------------------------------------------
# Logomark geometry, authored in a 1024x1024 space.
# ---------------------------------------------------------------------------
GAP = 8
_ARM_W = 92
_L, _R = 194, 830          # couch outer x-extent (~62% of 1024)
_ARM_Y0, _ARM_Y1 = 440, 730
_BACK_Y0, _BACK_Y1 = 370, 600
_BACK_X0 = _L + _ARM_W + GAP          # 294
_BACK_X1 = _R - _ARM_W - GAP          # 730
_CUSH_Y0 = _BACK_Y1 + GAP             # 608
_CUSH_Y1 = _ARM_Y1                    # 730
_HALF = (_BACK_X1 - _BACK_X0 - GAP) / 2  # 214
_DOT_CX, _DOT_CY, _DOT_R = 806, 318, 40

# (x0, y0, x1, y1, radius) rectangles making up the couch body
_BODY = [
    (_L, _ARM_Y0, _L + _ARM_W, _ARM_Y1, 42),                       # left arm
    (_R - _ARM_W, _ARM_Y0, _R, _ARM_Y1, 42),                       # right arm
    (_BACK_X0, _BACK_Y0, _BACK_X1, _BACK_Y1, 40),                  # backrest
    (_BACK_X0, _CUSH_Y0, _BACK_X0 + _HALF, _CUSH_Y1, 26),         # left cushion
    (_BACK_X1 - _HALF, _CUSH_Y0, _BACK_X1, _CUSH_Y1, 26),         # right cushion
]

# ---------------------------------------------------------------------------
# SVG emission
# ---------------------------------------------------------------------------

def couch_svg(body_fill, dot_fill=None, indent="  "):
    """SVG elements for the couch (+ optional dot) in 1024 user-space."""
    out = []
    for x0, y0, x1, y1, r in _BODY:
        out.append(
            f'{indent}<rect x="{x0:g}" y="{y0:g}" width="{x1 - x0:g}" '
            f'height="{y1 - y0:g}" rx="{r:g}" fill="{body_fill}"/>'
        )
    if dot_fill:
        out.append(
            f'{indent}<circle cx="{_DOT_CX}" cy="{_DOT_CY}" r="{_DOT_R}" fill="{dot_fill}"/>'
        )
    return "\n".join(out)


def svg_doc(w, h, body, view=None):
    vb = view or f"0 0 {w} {h}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="{vb}" role="img" aria-label="Couchside">\n{body}\n</svg>\n'
    )


def write_svgs():
    os.makedirs(SVG, exist_ok=True)
    files = {}

    files["mark.svg"] = svg_doc(1024, 1024, couch_svg(WHITE, GREEN))
    files["mark-mono-white.svg"] = svg_doc(1024, 1024, couch_svg(WHITE, WHITE))
    files["mark-mono-navy.svg"] = svg_doc(1024, 1024, couch_svg(NAVY, NAVY))

    # App-icon badge: mark on a navy rounded square.
    files["icon.svg"] = svg_doc(
        1024, 1024,
        f'  <rect width="1024" height="1024" rx="224" fill="{NAVY}"/>\n'
        + couch_svg(WHITE, GREEN),
    )

    # favicon: same badge, tuned to read at 16px (the app icon, unmodified,
    # already reads well shrunk, ship it as-is for a consistent mark).
    files["favicon.svg"] = files["icon.svg"]

    # Wordmark: two-tone "Couch" + green "side" in Space Mono.
    wm = (
        '  <style>text{font-family:"Space Mono",ui-monospace,SFMono-Regular,'
        'Menlo,monospace;font-weight:700}</style>\n'
        f'  <text x="0" y="150" font-size="200" letter-spacing="-6" fill="{INK}">'
        f'Couch<tspan fill="{GREEN}">side</tspan></text>'
    )
    files["wordmark.svg"] = svg_doc(1160, 210, wm, view="0 0 1160 210")

    # Horizontal lockup: badge + wordmark + tagline.
    lock_h = (
        f'  <style>text{{font-family:"Space Mono",ui-monospace,monospace}}</style>\n'
        f'  <g transform="translate(0,20) scale(0.3125)">\n'
        f'    <rect width="1024" height="1024" rx="224" fill="{NAVY}"/>\n'
        f'{couch_svg(WHITE, GREEN, indent="    ")}\n  </g>\n'
        f'  <text x="380" y="150" font-size="118" font-weight="700" '
        f'letter-spacing="-4" fill="{INK}">Couch<tspan fill="{GREEN}">side</tspan></text>\n'
        f'  <text x="384" y="212" font-size="41" fill="{MUTED}">'
        f'Remote console for your HTPC</text>'
    )
    files["lockup-horizontal.svg"] = svg_doc(1600, 360, lock_h, view="0 0 1600 360")

    # Stacked lockup: badge above wordmark.
    lock_v = (
        f'  <style>text{{font-family:"Space Mono",ui-monospace,monospace}}</style>\n'
        f'  <g transform="translate(228,0) scale(0.34)">\n'
        f'    <rect width="1024" height="1024" rx="224" fill="{NAVY}"/>\n'
        f'{couch_svg(WHITE, GREEN, indent="    ")}\n  </g>\n'
        f'  <text x="330" y="470" text-anchor="middle" font-size="120" '
        f'font-weight="700" letter-spacing="-4" fill="{INK}">'
        f'Couch<tspan fill="{GREEN}">side</tspan></text>'
    )
    files["lockup-stacked.svg"] = svg_doc(660, 520, lock_v, view="0 0 660 520")

    for name, content in files.items():
        with open(os.path.join(SVG, name), "w") as f:
            f.write(content)
        print(f"svg  {name}")


# ---------------------------------------------------------------------------
# Raster (PIL): reuses the geometry above at supersampled quality.
# ---------------------------------------------------------------------------
SS = 4  # supersample factor


def render_art(size, body_rgb, dot_rgb=None):
    """RGBA tile (size x size) of the couch art on transparent."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def s(v):
        return v * size / 1024 * SS

    for x0, y0, x1, y1, r in _BODY:
        d.rounded_rectangle([s(x0), s(y0), s(x1), s(y1)], radius=s(r), fill=body_rgb)
    if dot_rgb:
        d.ellipse(
            [s(_DOT_CX - _DOT_R), s(_DOT_CY - _DOT_R),
             s(_DOT_CX + _DOT_R), s(_DOT_CY + _DOT_R)],
            fill=dot_rgb,
        )
    return img.resize((size, size), Image.LANCZOS)


def badge(size, radius_frac=0.219):
    """The app-icon badge: couch art on a navy rounded square."""
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * SS, size * SS], radius=int(size * SS * radius_frac), fill=255
    )
    fill = Image.new("RGBA", (size, size), _rgb(NAVY) + (255,))
    fill.putalpha(mask.resize((size, size), Image.LANCZOS))
    base.alpha_composite(fill)
    base.alpha_composite(render_art(size, _rgb(WHITE), _rgb(GREEN)))
    return base


def font(px):
    return ImageFont.truetype(FONT_PATH, px)


def draw_wordmark(d, x, baseline, px, weight=2):
    """Two-tone 'Couchside' with a faux-bold stroke; returns end-x."""
    f = font(px)
    couch, side = "Couch", "side"
    d.text((x, baseline), couch, font=f, fill=_rgb(INK), anchor="ls",
           stroke_width=weight, stroke_fill=_rgb(INK))
    w = d.textlength(couch, font=f)
    d.text((x + w, baseline), side, font=f, fill=_rgb(GREEN), anchor="ls",
           stroke_width=weight, stroke_fill=_rgb(GREEN))
    return x + w + d.textlength(side, font=f)


def social_card(w, h, mark_px, wordmark_px, tagline, with_badges):
    """Composite an OG / social hero on the navy field."""
    img = Image.new("RGBA", (w, h), _rgb(NAVY) + (255,))
    d = ImageDraw.Draw(img)
    # subtle top vignette for depth (flat two-tone, not a gradient blur)
    d.rectangle([0, 0, w, int(h * 0.5)], fill=_rgb(NAVY_DEEP) + (60,))

    art = render_art(mark_px, _rgb(WHITE), _rgb(GREEN))
    # The couch body sits at y 370..730 of the tile; center that band vertically.
    band_cy = int(mark_px * (370 + 730) / 2 / 1024)
    total_w = mark_px + int(mark_px * 0.10) + int(d.textlength("Couchside", font=font(wordmark_px)))
    ox = (w - total_w) // 2 - int(mark_px * 0.08)
    oy = h // 2 - band_cy - 12
    img.alpha_composite(art, (ox, oy))

    tx = ox + mark_px + int(mark_px * 0.02)
    end = draw_wordmark(d, tx, h // 2 - 6, wordmark_px, weight=max(2, wordmark_px // 22))
    d.text((tx + 4, h // 2 + int(wordmark_px * 0.42)), tagline, font=font(int(wordmark_px * 0.30)),
           fill=_rgb(MUTED), anchor="ls")

    if with_badges:
        by = h - int(h * 0.16)
        for i, label in enumerate(("Download on the App Store", "Get it on Google Play")):
            bx = tx + 4 + i * 280
            d.rounded_rectangle([bx, by, bx + 260, by + 60], radius=12,
                                fill=_rgb(CARD) + (255,), outline=_rgb(MUTED) + (90,), width=1)
            d.text((bx + 130, by + 30), label, font=font(17), fill=_rgb(INK), anchor="mm")
    return img.convert("RGB")


def write_rasters():
    os.makedirs(PNG, exist_ok=True)

    def save(img, name):
        img.save(os.path.join(PNG, name))
        print(f"png  {name}  {img.size}  {img.mode}")

    # Standalone mark (transparent) + white variant
    save(render_art(1024, _rgb(WHITE), _rgb(GREEN)), "mark-1024.png")
    save(render_art(512, _rgb(WHITE), _rgb(GREEN)), "mark-512.png")
    save(render_art(512, _rgb(WHITE), _rgb(WHITE)), "mark-mono-white-512.png")

    # Icon badges
    save(badge(1024), "icon-1024.png")
    save(badge(512), "icon-512.png")

    # Favicons (opaque badge, shrunk) + apple-touch
    b180 = badge(180)
    save(b180, "apple-touch-icon-180.png")
    for n in (16, 32, 48, 64):
        save(badge(256).resize((n, n), Image.LANCZOS), f"favicon-{n}.png")

    # Social / OG assets
    save(social_card(1200, 630, 300, 128, "Remote console for your HTPC", True),
         "og-image-1200x630.png")
    save(social_card(1280, 640, 300, 132, "Remote console for your HTPC", True),
         "github-social-1280x640.png")

    # Wordmark on transparent (white on transparent for overlays)
    wm = Image.new("RGBA", (900, 220), (0, 0, 0, 0))
    end = draw_wordmark(ImageDraw.Draw(wm), 8, 150, 150, weight=6)
    save(wm.crop((0, 0, int(end) + 16, 210)), "wordmark-2tone-transparent.png")

    # favicon.ico (multi-size)
    ico = badge(256)
    ico.save(os.path.join(HERE, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("ico  favicon.ico")


def write_tokens():
    tokens = {
        "navy": NAVY, "navyDeep": NAVY_DEEP, "card": CARD,
        "ink": INK, "muted": MUTED, "green": GREEN, "blue": BLUE, "white": WHITE,
    }
    import json
    with open(os.path.join(HERE, "tokens.json"), "w") as f:
        json.dump({"color": tokens,
                   "font": {"mono": "Space Mono, ui-monospace, SFMono-Regular, Menlo, monospace"}},
                  f, indent=2)
    css = ":root {\n" + "\n".join(
        f"  --cp-{k}: {v};" for k, v in tokens.items()
    ) + '\n  --cp-mono: "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace;\n}\n'
    with open(os.path.join(HERE, "tokens.css"), "w") as f:
        f.write(css)
    print("tokens.json / tokens.css")


if __name__ == "__main__":
    write_svgs()
    write_rasters()
    write_tokens()
    print("\nbrand pack regenerated.")
