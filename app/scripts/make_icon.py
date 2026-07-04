#!/usr/bin/env python3
"""Generate the CouchPilot app icon set into assets/images/.

Art: minimal geometric white couch (rounded-rect back, two seat cushions,
two arms) on a #0b1220 field, with a green status dot floating top-right
above the couch arm.

Run from anywhere:  python3 scripts/make_icon.py
Requires Pillow.
"""

import os

from PIL import Image, ImageDraw

BG = (0x0B, 0x12, 0x20, 255)  # #0b1220
WHITE = (255, 255, 255, 255)
GREEN = (0x34, 0xD3, 0x99, 255)  # #34d399

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "images")

# Supersample factor for smooth edges (drawn big, LANCZOS-downscaled).
SS = 4


def draw_art(size: int, couch_color, dot: bool, dot_color=GREEN) -> Image.Image:
    """Render the couch (+ optional status dot) on a transparent canvas.

    Geometry is authored in 1024-space and scaled to `size`. The couch spans
    ~62% of the width and sits vertically centered, slightly low.
    """
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def s(v: float) -> float:
        return v * size / 1024 * SS

    def rrect(x0, y0, x1, y1, r):
        d.rounded_rectangle([s(x0), s(y0), s(x1), s(y1)], radius=s(r), fill=couch_color)

    # Couch bounding box: x 194..830 (~62% width), y 370..730 (center ~550,
    # slightly below the canvas center of 512).
    GAP = 8

    # Arms (full height of the seat area)
    rrect(194, 440, 194 + 92, 730, 42)  # left arm
    rrect(830 - 92, 440, 830, 730, 42)  # right arm

    # Backrest between the arms
    back_x0 = 194 + 92 + GAP
    back_x1 = 830 - 92 - GAP
    rrect(back_x0, 370, back_x1, 600, 40)

    # Two seat cushions below the backrest, GAP apart
    cush_y0 = 600 + GAP
    half = (back_x1 - back_x0 - GAP) / 2
    rrect(back_x0, cush_y0, back_x0 + half, 730, 26)
    rrect(back_x1 - half, cush_y0, back_x1, 730, 26)

    if dot:
        # Status dot floating top-right, above the right arm
        r = 40
        cx, cy = 806, 318
        d.ellipse([s(cx - r), s(cy - r), s(cx + r), s(cy + r)], fill=dot_color)

    return img.resize((size, size), Image.LANCZOS)


def on_bg(art: Image.Image, size: int) -> Image.Image:
    base = Image.new("RGBA", (size, size), BG)
    base.alpha_composite(art)
    return base


def main() -> None:
    out = os.path.normpath(OUT_DIR)
    os.makedirs(out, exist_ok=True)

    def save(img: Image.Image, name: str) -> None:
        path = os.path.join(out, name)
        img.save(path)
        print(f"wrote {path} {img.size} {img.mode}")

    # icon.png: 1024, opaque (App Store icons must have no alpha)
    art_1024 = draw_art(1024, WHITE, dot=True)
    icon = on_bg(art_1024, 1024).convert("RGB")
    save(icon, "icon.png")

    # android-icon-foreground.png: 1024, art at 66% scale on transparent
    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    small = draw_art(676, WHITE, dot=True)  # 1024 * 0.66 ≈ 676
    fg.alpha_composite(small, ((1024 - 676) // 2, (1024 - 676) // 2))
    save(fg, "android-icon-foreground.png")

    # android-icon-background.png: solid brand background
    save(Image.new("RGBA", (1024, 1024), BG), "android-icon-background.png")

    # android-icon-monochrome.png: white art on transparent (dot white too)
    save(draw_art(1024, WHITE, dot=True, dot_color=WHITE), "android-icon-monochrome.png")

    # splash-icon.png: 512, white couch (no dot) on transparent
    save(draw_art(512, WHITE, dot=False), "splash-icon.png")

    # favicon.png: 48, the full icon shrunk down
    save(on_bg(art_1024, 1024).resize((48, 48), Image.LANCZOS), "favicon.png")


if __name__ == "__main__":
    main()
