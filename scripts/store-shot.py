#!/usr/bin/env python3
"""store-shot.py — wrap a raw device screenshot in the Couchside store treatment.

The App Store / Play screenshots are not raw captures: each is a caption, a green
accent rule, and the screenshot inset into a phone bezel on a dark gradient. That
treatment was originally done by hand and never committed, so the next person to
add a screenshot had nothing to match against and the set would drift. This is
that treatment, measured back off the shipped 2.9.x set and made repeatable.

    scripts/store-shot.py shot.png -o out.png --caption "See your box —|even when the TV is black"
    scripts/store-shot.py shot.png -o out.png --caption "..." --play play-8.png
    scripts/store-shot.py shot.png -o out.png --caption "..." --paint-out 980,2470,1120,2540

`|` splits caption lines. --play also writes the Play variant (padded to 1440
wide; Play caps aspect at 2:1 and 1320x2868 is 2.17). --paint-out blanks a
region with the surrounding colour — used to remove in-app BETA badges, which
must not appear in store art.

EVERY constant below was measured off iphone-6.9/phone-1-console.png rather than
guessed; see the comments for the observed values.
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("needs Pillow:  python3 -m pip install --user Pillow")

# --- measured off the shipped set (iphone-6.9/phone-1-console.png) ------------
CANVAS = (1320, 2868)          # App Store 6.9" native
BG_TOP = (14, 22, 29)          # sampled px[2,2]
BG_BOTTOM = (11, 13, 18)       # sampled px[2,H-3]

PHONE = (118, 500, 1084, 2275)  # x, y, w, h — outer bezel
PHONE_RADIUS = 154              # top-left settles from x=272 at y=500 to x=118 at y=654
BEZEL_FILL = (18, 18, 20)
BEZEL_STROKE = (95, 97, 103)    # 1-2px highlight, inset ~6px
BEZEL_STROKE_INSET = 6
SCREEN_INSET = 33               # screen x starts 151 = 118+33; symmetric at 1201-33

ISLAND = (283, 70)              # black pill, centred, observed x518-800 y~575-645
ISLAND_TOP = 575

CAPTION_TOP = 167               # first glyph row
CAPTION_LINE_STEP = 119         # 286 - 167
CAPTION_MAX_W = 1180            # observed longest line 1170
CAPTION_SIZE_MAX = 99           # SF Pro Bold @99 => cap height 70, exactly the reference
CAPTION_FILL = (248, 250, 252)

ACCENT = (52, 211, 153)         # #34d399, the brand green
ACCENT_RECT = (141, 13)         # observed x590-730, y404-416
ACCENT_TOP = 404

PLAY_W = 1440                   # Play caps aspect at 2:1; 1440x2868 = 1.99


def load_font(size):
    """SF Pro Bold. Metric-matched to the shipped set: at 99px its cap height is
    70px and 'even when the TV is black' renders 1164px against the reference's
    1170 — a 0.5% difference, i.e. this is the font the originals used."""
    for path in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/SFNSDisplay.ttf"):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size)
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                pass
            return f
    for path in ("/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size, index=1)
    raise SystemExit("no usable bold system font found")


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((w, h), Image.NEAREST)


def fit_caption(lines, draw):
    """Largest size at which every line fits CAPTION_MAX_W, capped at the
    reference size so a short caption never renders LARGER than the shipped set."""
    size = CAPTION_SIZE_MAX
    while size > 40:
        f = load_font(size)
        if all(draw.textbbox((0, 0), ln, font=f)[2] <= CAPTION_MAX_W for ln in lines):
            return f
        size -= 2
    return load_font(40)


def build(src_path, caption, paint_out=None):
    shot = Image.open(src_path).convert("RGB")
    if shot.size != CANVAS:
        raise SystemExit(
            f"expected a {CANVAS[0]}x{CANVAS[1]} screenshot (App Store 6.9\" native), got "
            f"{shot.size[0]}x{shot.size[1]}. Capture on a 6.9\" device/simulator."
        )

    if paint_out:
        d = ImageDraw.Draw(shot)
        x0, y0, x1, y1 = paint_out
        # Sample just left of the region so the patch matches the card behind it.
        fill = shot.getpixel((max(0, x0 - 12), (y0 + y1) // 2))
        d.rectangle([x0, y0, x1, y1], fill=fill)

    canvas = gradient(CANVAS, BG_TOP, BG_BOTTOM)
    draw = ImageDraw.Draw(canvas)

    # caption
    lines = [ln for ln in caption.split("|") if ln.strip()]
    font = fit_caption(lines, draw)
    for i, ln in enumerate(lines):
        w = draw.textbbox((0, 0), ln, font=font)[2]
        # textbbox y0 is the glyph-top offset; subtract it so CAPTION_TOP is the
        # actual first inked row, which is how the reference was measured.
        oy = draw.textbbox((0, 0), ln, font=font)[1]
        draw.text(((CANVAS[0] - w) // 2, CAPTION_TOP + i * CAPTION_LINE_STEP - oy),
                  ln, font=font, fill=CAPTION_FILL)

    # accent rule
    aw, ah = ACCENT_RECT
    ax = (CANVAS[0] - aw) // 2
    draw.rounded_rectangle([ax, ACCENT_TOP, ax + aw, ACCENT_TOP + ah],
                           radius=ah // 2, fill=ACCENT)

    # bezel
    px_, py, pw, ph = PHONE
    draw.rounded_rectangle([px_, py, px_ + pw, py + ph], radius=PHONE_RADIUS, fill=BEZEL_FILL)
    i = BEZEL_STROKE_INSET
    draw.rounded_rectangle([px_ + i, py + i, px_ + pw - i, py + ph - i],
                           radius=PHONE_RADIUS - i, outline=BEZEL_STROKE, width=2)

    # screen: scale the shot to the inner width, then mask to rounded corners
    sw = pw - SCREEN_INSET * 2
    sh = round(shot.size[1] * sw / shot.size[0])
    inner = shot.resize((sw, sh), Image.LANCZOS)
    sx, sy = px_ + SCREEN_INSET, py + SCREEN_INSET
    avail = ph - SCREEN_INSET * 2
    if sh > avail:                      # bottom is clipped by the bezel, as in the reference
        inner = inner.crop((0, 0, sw, avail)); sh = avail
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw - 1, sh - 1],
                                           radius=PHONE_RADIUS - SCREEN_INSET, fill=255)
    canvas.paste(inner, (sx, sy), mask)

    # Dynamic Island
    iw, ih = ISLAND
    ix = (CANVAS[0] - iw) // 2
    ImageDraw.Draw(canvas).rounded_rectangle([ix, ISLAND_TOP, ix + iw, ISLAND_TOP + ih],
                                             radius=ih // 2, fill=(0, 0, 0))
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--caption", required=True, help="'|' splits lines")
    ap.add_argument("--play", help="also write the Play variant (1440 wide) here")
    ap.add_argument("--paint-out", help="x0,y0,x1,y1 region to blank (e.g. a BETA badge)")
    a = ap.parse_args()

    region = tuple(int(v) for v in a.paint_out.split(",")) if a.paint_out else None
    img = build(a.src, a.caption, region)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    img.save(a.out)
    print(f"wrote {a.out} {img.size[0]}x{img.size[1]}")

    if a.play:
        pad = Image.new("RGB", (PLAY_W, CANVAS[1]), BG_BOTTOM)
        pad.paste(img, ((PLAY_W - CANVAS[0]) // 2, 0))
        pad.save(a.play)
        print(f"wrote {a.play} {pad.size[0]}x{pad.size[1]}")


if __name__ == "__main__":
    main()
