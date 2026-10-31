"""snap-rail icon concept — one design grid, one palette, every derivative.

The mark: a full-bleed cobalt rail with a single white module clipped over it.
The module is the hero (a plugin); the rail is the substrate (the kernel). The
30-unit moat around the module is negative space — the seat it drops into — so
the module reads as docked, not pasted. Everything is laid out on a 1024 grid
at multiples of 8, which is what keeps the 16px step honest.

Run: python docs/brand/icon/generate.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
S = 4
N = 1024 * S
TRANS = Image.new("RGBA", (N, N), (0, 0, 0, 0))

# --- palette: factory cobalt night theme (packages/base/ui/src/skins.tsx) ----
TILE = ((0x17, 0x1F, 0x2A), (0x0A, 0x0E, 0x13))
TILE_LIGHT = ((0xE7, 0xED, 0xF5), (0xD1, 0xDA, 0xE7))
COBALT = ((0x5A, 0x76, 0xFF), (0x3A, 0x56, 0xE4))
COBALT_LIGHT = ((0x4A, 0x6C, 0xFF), (0x2F, 0x49, 0xD6))
WHITE = ((0xFF, 0xFF, 0xFF), (0xD8, 0xE1, 0xEC))
WHITE_LIGHT = ((0xFF, 0xFF, 0xFF), (0xEC, 0xF1, 0xF7))
INK = ((0x1B, 0x24, 0x30), (0x0D, 0x13, 0x1A))
GREEN = (0x3F, 0xB9, 0x50)

# --- geometry (design units) ------------------------------------------------
RADIUS_TILE = 228
BAND = (0, 392, 1024, 632)
MODULE = (322, 272, 702, 752)
MOAT = 34
RADIUS_MODULE = 56
LED = (378, 328, 11)


def P(v: float) -> float:
    return v * S


def vgrad(c0, c1, angle: float = 90.0) -> Image.Image:
    """Linear gradient at `angle` degrees (90 = top to bottom), upsampled from a
    small tile so the supersampled canvas stays cheap."""
    if angle == 90.0:
        t = np.linspace(0.0, 1.0, 256, dtype=np.float32)[:, None, None]
        arr = (np.array(c0, np.float32) + (np.array(c1, np.float32) - np.array(c0, np.float32)) * t).astype(np.uint8)
        tile = Image.fromarray(np.repeat(arr, 256, axis=1), "RGB")
        return tile.resize((N, N), Image.BILINEAR).convert("RGBA")
    h = 128
    yy, xx = np.mgrid[0:h, 0:h] / (h - 1)
    a = np.deg2rad(angle)
    t = xx * np.cos(a) + yy * np.sin(a)
    t = (t - t.min()) / max(t.max() - t.min(), 1e-6)
    arr = (np.array(c0, np.float32) + (np.array(c1, np.float32) - np.array(c0, np.float32)) * t[..., None]).astype(np.uint8)
    return Image.fromarray(arr, "RGB").resize((N, N), Image.BILINEAR).convert("RGBA")


def rrmask(rect, r, grow: float = 0.0) -> Image.Image:
    m = Image.new("L", (N, N), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [P(rect[0] - grow), P(rect[1] - grow), P(rect[2] + grow), P(rect[3] + grow)], radius=P(r), fill=255
    )
    return m


def seat_mask(mod=MODULE, moat=MOAT) -> Image.Image:
    """The band silhouette with the module's seat cut out of it."""
    m = rrmask(BAND, 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [P(mod[0] - moat), P(mod[1] - moat), P(mod[2] + moat), P(mod[3] + moat)],
        radius=P(RADIUS_MODULE + moat),
        fill=0,
    )
    return m


def paint(canvas, mask, g=None, color=None, angle: float = 90.0):
    layer = vgrad(*g, angle) if g else Image.new("RGBA", (N, N), (*color, 255))
    canvas.alpha_composite(Image.composite(layer, TRANS, mask))


def shadow(canvas, rect, r, dy=16, blur=16, op=0.4):
    m = rrmask((rect[0], rect[1] + dy, rect[2], rect[3] + dy), r, grow=4).filter(ImageFilter.GaussianBlur(P(blur)))
    sh = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sh.putalpha(m.point(lambda v: int(v * op)))
    canvas.alpha_composite(sh)


def band_edges(canvas, mask):
    """A light top edge and a dark bottom edge: the rail reads as machined."""
    for rect, colour in (
        ((0, BAND[1], 1024, BAND[1] + 6), (255, 255, 255, 46)),
        ((0, BAND[3] - 6, 1024, BAND[3]), (0, 0, 0, 52)),
    ):
        edge = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        ImageDraw.Draw(edge).rectangle([P(rect[0]), P(rect[1]), P(rect[2]), P(rect[3])], fill=colour)
        edge.putalpha(Image.composite(edge.getchannel("A"), Image.new("L", (N, N), 0), mask))
        canvas.alpha_composite(edge)


def led(canvas):
    """One status light. No halo: a badge dot would read as a notification."""
    cx, cy, r = LED
    d = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(d).ellipse([P(cx - r), P(cy - r), P(cx + r), P(cy + r)], fill=(*GREEN, 255))
    canvas.alpha_composite(d)


def clip_tile(canvas):
    tile = rrmask((0, 0, 1024, 1024), RADIUS_TILE)
    canvas.putalpha(Image.composite(canvas.getchannel("A"), Image.new("L", (N, N), 0), tile))


def hairline(canvas, light: bool = False):
    """A 2-unit inner stroke: the tile keeps an edge on any wallpaper."""
    edge = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [0, 0, N - 1, N - 1],
        radius=P(RADIUS_TILE),
        outline=(0, 0, 0, 40) if light else (255, 255, 255, 26),
        width=max(1, int(P(2))),
    )
    canvas.alpha_composite(edge)


def dock(size: int, *, light: bool = False) -> Image.Image:
    """The mark itself: rail + one clipped module."""
    if size <= 24 and not light:
        return _dock_tiny(size)
    small = size <= 32
    # at 32px the seat would collapse to a sub-pixel line; open it up
    moat = MOAT if not small else round(1024 / size * 1.1)
    c = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    paint(c, rrmask((0, 0, 1024, 1024), RADIUS_TILE), g=TILE_LIGHT if light else TILE)
    seat = seat_mask(moat=moat)
    paint(c, seat, g=COBALT_LIGHT if light else COBALT, angle=106)
    band_edges(c, seat)
    if not small:
        shadow(c, MODULE, RADIUS_MODULE, op=0.36 if light else 0.4)
    paint(c, rrmask(MODULE, RADIUS_MODULE), g=INK if light else WHITE)
    if not small:
        led(c)
    hairline(c, light)
    clip_tile(c)
    return c.resize((size, size), Image.LANCZOS)


def _dock_tiny(size: int) -> Image.Image:
    """Under 32px the detail is gone, so the drawing is redone rather than
    downscaled: heavier rail, bigger module, no seat gap, no shadow, no LED."""
    band = (0, 362, 1024, 662)
    mod = (282, 282, 742, 742)
    c = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    paint(c, rrmask((0, 0, 1024, 1024), RADIUS_TILE), g=TILE)
    seat = rrmask(band, 0)
    paint(c, seat, g=COBALT)
    paint(c, rrmask(mod, 76), g=WHITE)
    clip_tile(c)
    return c.resize((size, size), Image.LANCZOS)


def mono(size: int, *, ink: tuple[int, int, int] = (0xFF, 0xFF, 0xFF)) -> Image.Image:
    """Single-colour glyph for the tray and other system chrome."""
    small = size <= 32
    moat = MOAT if not small else max(MOAT, round(1024 / size * 1.1))
    band = seat_mask(moat=moat)
    mod = rrmask(MODULE, RADIUS_MODULE)
    glyph = Image.composite(Image.new("L", (N, N), 255), Image.new("L", (N, N), 0), band)
    glyph = Image.composite(Image.new("L", (N, N), 255), glyph, mod)
    out = Image.new("RGBA", (N, N), (*ink, 255))
    out.putalpha(glyph)
    return out.resize((size, size), Image.LANCZOS)


def din(size: int) -> Image.Image:
    """Alt: three modules of different widths — the whole idea on one rail."""
    c = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    paint(c, rrmask((0, 0, 1024, 1024), RADIUS_TILE), g=TILE)
    band = (0, 596, 1024, 736)
    mods = [(150, 366, 342, 676), (382, 286, 632, 676), (672, 406, 866, 676)]
    m = rrmask(band, 0)
    d = ImageDraw.Draw(m)
    for mod in mods:
        d.rounded_rectangle(
            [P(mod[0] - 26), P(mod[1] - 26), P(mod[2] + 26), P(mod[3] + 26)],
            radius=P(42),
            fill=0,
        )
    paint(c, m, g=COBALT)
    band_edges(c, m)
    for i, mod in enumerate(mods):
        shadow(c, mod, 42, op=0.4)
        paint(c, rrmask(mod, 42), g=COBALT if i == 1 else WHITE)
    clip_tile(c)
    return c.resize((size, size), Image.LANCZOS)


# --- SVG --------------------------------------------------------------------
def _stops(gid: str, pair, x2: str = "0", y2: str = "1") -> str:
    a, b = ("#%02X%02X%02X" % pair[0], "#%02X%02X%02X" % pair[1])
    return (
        f'<linearGradient id="{gid}" x1="0" y1="0" x2="{x2}" y2="{y2}">'
        f'<stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
    )


def svg(light: bool = False) -> str:
    tile = TILE_LIGHT if light else TILE
    rail = COBALT_LIGHT if light else COBALT
    face = INK if light else WHITE
    led = f'<circle cx="{LED[0]}" cy="{LED[1]}" r="{LED[2]}" fill="#3FB950"/>'
    shade = "0.36" if light else "0.4"
    hair = 'stroke="#000" stroke-opacity="0.08"' if light else 'stroke="#fff" stroke-opacity="0.1"'
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="snap-rail">
  <title>snap-rail</title>
  <defs>
    {_stops("tile", tile)}
    {_stops("rail", rail, "0.28", "1")}
    {_stops("face", face)}
    <mask id="seat" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect x="0" y="{BAND[1]}" width="1024" height="{BAND[3] - BAND[1]}" fill="#fff"/>
      <rect x="{MODULE[0] - MOAT}" y="{MODULE[1] - MOAT}" width="{MODULE[2] - MODULE[0] + 2 * MOAT}" height="{MODULE[3] - MODULE[1] + 2 * MOAT}" rx="{RADIUS_MODULE + MOAT}" fill="#000"/>
    </mask>
    <clipPath id="tile"><rect width="1024" height="1024" rx="{RADIUS_TILE}"/></clipPath>
    <filter id="shade" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="16" stdDeviation="14" flood-color="#000" flood-opacity="{shade}"/>
    </filter>
  </defs>
  <g clip-path="url(#tile)">
    <rect width="1024" height="1024" fill="url(#tile)"/>
    <rect x="0" y="{BAND[1]}" width="1024" height="{BAND[3] - BAND[1]}" fill="url(#rail)" mask="url(#seat)"/>
    <rect x="0" y="{BAND[1]}" width="1024" height="6" fill="#fff" fill-opacity="0.18" mask="url(#seat)"/>
    <rect x="0" y="{BAND[3] - 6}" width="1024" height="6" fill="#000" fill-opacity="0.2" mask="url(#seat)"/>
    <rect x="{MODULE[0]}" y="{MODULE[1]}" width="{MODULE[2] - MODULE[0]}" height="{MODULE[3] - MODULE[1]}" rx="{RADIUS_MODULE}" fill="url(#face)" filter="url(#shade)"/>
    {led}
    <rect x="1" y="1" width="1022" height="1022" rx="{RADIUS_TILE - 1}" fill="none" {hair} stroke-width="2"/>
  </g>
</svg>
"""


def sheet() -> None:
    """A single review sheet: hero, size ladder, pixel truth, variants."""
    W, H = 1600, 980
    bg = (0x0E, 0x12, 0x18)
    out = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(out)
    h2 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 21)
    small = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 14)
    mono_f = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 13)
    cn = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
    title = ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf", 34)

    def chip(size, colour, radius=26):
        card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(card).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=colour)
        return card

    d.text((64, 46), "snap-rail", font=title, fill=(230, 236, 243))
    d.text((64, 90), "一条导轨，一个可热插拔的模块", font=h2, fill=(126, 141, 158))
    d.text((W - 64 - 180, 56), "1024 grid / 8pt", font=mono_f, fill=(90, 104, 120))

    hero = dock(420)
    out.paste(hero, (64, 168), hero)
    d.text((64, 602), "主案 · 深色", font=cn, fill=(122, 136, 152))

    # size ladder, all optically centred on one axis
    lx, cy = 556, 360
    d.text((lx, 168), "size ladder", font=small, fill=(90, 104, 120))
    for sz in (192, 128, 96, 64, 48, 32, 24, 16):
        im = dock(sz)
        out.paste(im, (lx, cy - sz // 2), im)
        d.text((lx, cy + 110), str(sz), font=mono_f, fill=(90, 104, 120))
        lx += sz + 24

    # pixel truth: nearest-neighbour blow-ups so the 16px drawing can be judged
    zx, zy = 556, 560
    d.text((zx, zy - 30), "像素核验 · 16 / 24 / 32 px 整数倍放大", font=cn, fill=(90, 104, 120))
    for i, (sz, k) in enumerate(((16, 8), (24, 6), (32, 5))):
        im = dock(sz)
        big = im.resize((sz * k, sz * k), Image.NEAREST)
        out.paste(big, (zx + i * 190, zy + (150 - sz * k) // 2), big)

    # variants
    vy = 760
    d.text((64, vy - 30), "variants", font=small, fill=(90, 104, 120))
    vx = 64
    for label, im in (
        ("浅色主题", dock(160, light=True)),
        ("三模一轨 · 备选", din(160)),
    ):
        out.paste(im, (vx, vy), im)
        d.text((vx, vy + 168), label, font=cn, fill=(122, 136, 152))
        vx += 195

    dark_chip = chip(160, (0x1B, 0x20, 0x28))
    glyph = mono(112)
    dark_chip.paste(glyph, (24, 24), glyph)
    out.paste(dark_chip, (vx, vy), dark_chip)
    d.text((vx, vy + 168), "单色 · 深底托盘", font=cn, fill=(122, 136, 152))
    vx += 195

    light_chip = chip(160, (0xE9, 0xEE, 0xF5))
    glyph = mono(112, ink=INK[1])
    light_chip.paste(glyph, (24, 24), glyph)
    out.paste(light_chip, (vx, vy), light_chip)
    d.text((vx, vy + 168), "单色 · 浅底托盘", font=cn, fill=(122, 136, 152))

    out.save(HERE / "preview.png")


def main() -> None:
    (HERE / "snap-rail-icon.svg").write_text(svg(), encoding="utf-8")
    (HERE / "snap-rail-icon-light.svg").write_text(svg(light=True), encoding="utf-8")
    for size in (1024, 512, 256, 128, 64, 48, 32, 24, 16):
        dock(size).save(HERE / f"snap-rail-icon-{size}.png")
    dock(512, light=True).save(HERE / "snap-rail-icon-light-512.png")
    din(512).save(HERE / "alt-din-row-512.png")
    for size in (64, 48, 32, 24, 16):
        mono(size).save(HERE / f"tray-{size}.png")
        mono(size, ink=INK[1]).save(HERE / f"tray-dark-{size}.png")
    # the .ico carries the same per-size drawings, including the 16px reduction
    ico_sizes = (256, 128, 64, 48, 32, 24, 16)
    frames = {s: dock(s) for s in ico_sizes}
    frames[256].save(
        HERE / "snap-rail.ico",
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=[frames[s] for s in ico_sizes[1:]],
    )
    sheet()


if __name__ == "__main__":
    main()





