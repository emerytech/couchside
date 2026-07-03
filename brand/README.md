# CouchPilot brand pack

Everything here regenerates from one command:

```bash
python3 brand/make_brand.py
```

The logomark geometry is the single source of truth in `make_brand.py` and is
byte-identical to `app/scripts/make_icon.py`, so the iOS/Android app icon, the
website favicon, and every marketing logo are the same mark. Don't hand-edit the
generated files — change `make_brand.py` and re-run.

## The mark

A minimal geometric couch (backrest, two cushions, two arms) with a green
**status dot** floating top-right. The couch says living-room; the dot is the
"your box is online" signal that the whole product is about.

## Files

| Path | Use |
|------|-----|
| `svg/mark.svg` | Primary logomark, white couch + green dot, transparent. Overlay on dark surfaces. |
| `svg/mark-mono-white.svg` | All-white, for busy/dark photography. |
| `svg/mark-mono-navy.svg` | All-navy, for light surfaces. |
| `svg/icon.svg` | The app-icon badge (mark on a navy rounded square). |
| `svg/favicon.svg` | Same badge, ships as the site favicon. |
| `svg/wordmark.svg` | `CouchPilot` two-tone wordmark, Space Mono. |
| `svg/lockup-horizontal.svg` | Badge + wordmark + tagline, side by side. |
| `svg/lockup-stacked.svg` | Badge above wordmark. |
| `png/icon-1024.png`, `icon-512.png` | Raster app icon / store listing. |
| `png/favicon-{16,32,48,64}.png`, `apple-touch-icon-180.png`, `favicon.ico` | Web favicons. |
| `png/og-image-1200x630.png` | Social / Open Graph share card. |
| `png/github-social-1280x640.png` | GitHub repo social preview (Settings → Social preview). |
| `png/wordmark-2tone-transparent.png` | Wordmark for slide decks / overlays. |
| `tokens.css`, `tokens.json` | Color + type tokens. |
| `fonts/SpaceMono-Regular.ttf` | The brand typeface (SIL Open Font License). |

## Color

| Token | Hex | Role |
|-------|-----|------|
| navy | `#0b1220` | Page / icon background |
| navyDeep | `#070d18` | Deeper panels, vignette |
| card | `#141c2e` | Cards, buttons |
| ink | `#e6edf7` | Primary text, "Couch" |
| muted | `#8b98ad` | Secondary text |
| green | `#34d399` | Status dot, "Pilot", success |
| blue | `#60a5fa` | Links, secondary accent |

## Type

**Space Mono** everywhere — it is the app's own typeface, so the brand reads as
one system across product and marketing. Wordmark is two-tone: `Couch` in ink,
`Pilot` in green (echoing the status dot). Tagline: **Remote console for your HTPC.**

## Usage rules

- Keep clear space around the mark equal to the height of one couch arm.
- Never recolor the couch to anything but white, navy, or the two-tone lockup.
- Never put the green mark-dot on a light background (it's tuned for navy).
- Minimum favicon size 16px — the badge is designed to survive it; don't shrink the transparent `mark.svg` below 24px (the arms merge).
- Don't add gradients, bevels, or shadows. The brand is flat.
