"""snap-rail A3 icon - production renderer (Pillow + numpy).

Renders the confirmed A3 candidate ("悬空触发": industrial DIN-rail module
snapping onto the rail, spark at the contact point) at 4x supersample and
writes every production asset:

  - apps/desktop/build/icon.png          512 RGBA (electron-builder win.icon)
  - apps/desktop/resources/tray.png       32 RGBA (colored tray glyph)
  - apps/desktop/resources/tray@2x.png    64 RGBA
  - docs/brand/icon/a3-industrial/snap-rail-icon-512.png   (record copy)
  - docs/brand/icon/a3-industrial/snap-rail-icon-256.png   (preview)

Geometry is the single source reviewed in the candidate sheet; the favicon
master (snap-rail-icon.svg) next to this script carries the same shapes.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

S = 4                      # supersample factor: 512-space * 4 = 2048 canvas
CANVAS = 512 * S
W = H = CANVAS
RESAMPLE = Image.Resampling.LANCZOS

ROOT = Path(__file__).resolve().parents[4]

# palette (anchored to the factory cobalt theme: colorBg #0b0f14, colorPrimary #4a6cff)
BG_STOPS = ((0.0, (22, 33, 58)), (0.55, (12, 18, 32)), (1.0, (7, 10, 16)))
MOD_TOP = (92, 217, 255)      # #5cd9ff
MOD_BOTTOM = (74, 108, 255)   # #4a6cff
RAIL_TOP = (74, 108, 255)     # #4a6cff
RAIL_BOTTOM = (49, 71, 161)   # #3147a1
STUB = (49, 71, 161)          # #3147a1
SCREEN = (10, 16, 29)         # #0a101d
WAVE = (111, 216, 255)        # #6fd8ff
RING = (127, 217, 255)        # #7fd9ff
LED_LIT = (143, 234, 255)     # #8feaff
LED_DIM = (51, 69, 107)       # #33456b
BUTTON = (47, 66, 112)        # #2f4270
SPARK = (159, 234, 255)       # #9feaff
HALO = (86, 216, 255)         # #56d8ff
LED_CORE = (236, 250, 255)    # #ecfaff
EDGE = (125, 160, 255)        # inner tile stroke, alpha .14


def rounded_mask(box, radius, size=None):
    """Alpha mask (0..1 float) of a rounded rect in 512-space."""
    w = h = size or CANVAS
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(
        [box[0] * S, box[1] * S, box[2] * S, box[3] * S],
        radius=radius * S, fill=255,
    )
    return np.asarray(m, dtype=np.float64) / 255.0


def full_layer(arr, origin, shape):
    """Place a box-local HxWx4 (0..255) array into a full-canvas RGBA image."""
    layer = np.zeros((H, W, 4), dtype=np.float64)
    x0, y0 = origin
    h, w = shape
    layer[y0:y0 + h, x0:x0 + w] = arr
    return Image.fromarray(np.clip(layer, 0, 255).astype(np.uint8), 'RGBA')


def gradient_box(box, radius, c1, c2):
    """Vertical gradient inside a rounded rect, as a compositable image."""
    x0, y0, x1, y1 = box
    w, h = int(round((x1 - x0) * S)), int(round((y1 - y0) * S))
    t = np.linspace(0.0, 1.0, h).reshape(h, 1, 1)
    rgb = np.array(c1, dtype=np.float64).reshape(1, 1, 3) * (1 - t) \
        + np.array(c2, dtype=np.float64).reshape(1, 1, 3) * t
    alpha = rounded_mask(box, radius)[y0 * S:y0 * S + h, x0 * S:x0 * S + w]
    arr = np.zeros((h, w, 4), dtype=np.float64)
    arr[..., :3] = rgb
    arr[..., 3:] = alpha[..., None] * 255.0
    return full_layer(arr, (int(x0 * S), int(y0 * S)), (h, w))


def halo_layer(cx, cy, r, color, a0):
    """SVG-style radial halo: linear falloff from a0 at center to 0 at r."""
    yy, xx = np.mgrid[0:H, 0:W]
    t = np.sqrt((xx - cx * S) ** 2 + (yy - cy * S) ** 2) / (r * S)
    alpha = np.clip(1.0 - t, 0.0, 1.0) * a0
    arr = np.zeros((H, W, 4), dtype=np.float64)
    arr[..., 0] = color[0]
    arr[..., 1] = color[1]
    arr[..., 2] = color[2]
    arr[..., 3] = alpha * 255.0
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGBA')


def translucent_layer(draw_fn):
    """Draw translucent shapes on a fresh transparent canvas."""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(img))
    return img


def bezier(p0, p1, p2, p3, n=32):
    pts = []
    for i in range(n + 1):
        u = i / n
        v = 1 - u
        x = v**3 * p0[0] + 3 * v**2 * u * p1[0] + 3 * v * u**2 * p2[0] + u**3 * p3[0]
        y = v**3 * p0[1] + 3 * v**2 * u * p1[1] + 3 * v * u**2 * p2[1] + u**3 * p3[1]
        pts.append((x * S, y * S))
    return pts


def star_polygon():
    """The concave 4-point spark, sampled from the master SVG path."""
    segs = [
        ((256, 327), (259, 341.5), (263, 344.5), (283, 346)),
        ((283, 346), (263, 346.5), (259, 349.5), (256, 365)),
        ((256, 365), (253, 349.5), (249, 346.5), (229, 346)),
        ((229, 346), (249, 344.5), (253, 341.5), (256, 327)),
    ]
    pts = []
    for seg in segs:
        pts.extend(bezier(*seg))
    return pts


def render_icon_512():
    base = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    # deep-space tile (radial, from the factory night theme bg family)
    yy, xx = np.mgrid[0:H, 0:W]
    t = np.clip(
        np.sqrt((xx - 256 * S) ** 2 + (yy - 184.32 * S) ** 2) / (399.36 * S),
        0.0, 1.0,
    )
    bg = np.zeros((H, W, 4), dtype=np.float64)
    lo = t <= 0.55
    for ch in range(3):
        bg[..., ch] = np.where(
            lo,
            BG_STOPS[0][1][ch] + (BG_STOPS[1][1][ch] - BG_STOPS[0][1][ch]) * (t / 0.55),
            BG_STOPS[1][1][ch] + (BG_STOPS[2][1][ch] - BG_STOPS[1][1][ch]) * ((t - 0.55) / 0.45),
        )
    bg[..., 3] = rounded_mask((0, 0, 512, 512), 116) * 255.0
    base = Image.alpha_composite(base, Image.fromarray(bg.astype(np.uint8), 'RGBA'))

    # rail + slot line
    base = Image.alpha_composite(base, gradient_box((72, 368, 440, 398), 10, RAIL_TOP, RAIL_BOTTOM))
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: d.rounded_rectangle([92 * S, 381 * S, 420 * S, 385 * S], radius=2 * S, fill=(7, 10, 16, 140))
    ))

    draw = ImageDraw.Draw(base)

    # wiring terminals (two groups on top)
    for x in (134, 172, 318, 356):
        draw.rounded_rectangle([x * S, 152 * S, (x + 22) * S, 172 * S], radius=3 * S, fill=STUB + (255,))

    # housing
    base = Image.alpha_composite(base, gradient_box((108, 168, 404, 324), 18, MOD_TOP, MOD_BOTTOM))
    draw = ImageDraw.Draw(base)

    # touch screen + sheen + live waveform + bezel ring
    draw.rounded_rectangle([134 * S, 192 * S, 262 * S, 256 * S], radius=8 * S, fill=SCREEN + (255,))
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: d.polygon(
            [(134 * S, 192 * S), (262 * S, 192 * S), (262 * S, 218 * S), (134 * S, 248 * S)],
            fill=(255, 255, 255, 13),
        )
    ))
    wave = [(148, 240), (170, 226), (188, 234), (208, 214), (226, 222), (248, 210)]
    base = Image.alpha_composite(base, translucent_layer(lambda d: (
        d.line([(x * S, y * S) for x, y in wave], fill=WAVE + (140,), width=4 * S, joint='curve'),
        d.ellipse([(wave[0][0] - 4) * S, (wave[0][1] - 4) * S, (wave[0][0] + 4) * S, (wave[0][1] + 4) * S], fill=WAVE + (140,)),
        d.ellipse([(wave[-1][0] - 4) * S, (wave[-1][1] - 4) * S, (wave[-1][0] + 4) * S, (wave[-1][1] + 4) * S], fill=WAVE + (140,)),
    )))
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: d.rounded_rectangle([134 * S, 192 * S, 262 * S, 256 * S], radius=8 * S, outline=RING + (71,), width=int(2.5 * S))
    ))

    # indicator LEDs (one live with halo, one spare) + buttons
    base = Image.alpha_composite(base, halo_layer(292, 210, 16, HALO, 153))
    draw = ImageDraw.Draw(base)
    draw.ellipse([(292 - 8) * S, (210 - 8) * S, (292 + 8) * S, (210 + 8) * S], fill=LED_LIT + (255,))
    draw.ellipse([(320 - 8) * S, (210 - 8) * S, (320 + 8) * S, (210 + 8) * S], fill=LED_DIM + (255,))
    for x in (284, 330):
        draw.rounded_rectangle([x * S, 238 * S, (x + 34) * S, 252 * S], radius=7 * S, fill=BUTTON + (255,))

    # vent slots
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: [d.rounded_rectangle([x * S, 286 * S, (x + 44) * S, 295 * S], radius=4.5 * S, fill=(10, 16, 29, 97))
                   for x in (153, 207, 261, 315)]
    ))

    # the snap moment: spark at the contact point
    base = Image.alpha_composite(base, halo_layer(256, 346, 42, HALO, 153))
    draw = ImageDraw.Draw(base)
    draw.polygon(star_polygon(), fill=SPARK + (255,))
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: d.ellipse([(297 - 5) * S, (332 - 5) * S, (297 + 5) * S, (332 + 5) * S], fill=SPARK + (217,))
    ))

    # inner tile stroke (last, like the master SVG)
    base = Image.alpha_composite(base, translucent_layer(
        lambda d: d.rounded_rectangle([10 * S, 10 * S, 502 * S, 502 * S], radius=107 * S, outline=EDGE + (36,), width=3 * S)
    ))

    return base.resize((512, 512), RESAMPLE)


def render_tray():
    """Colored tray glyph: device silhouette with knocked-out screen/buttons over the rail."""
    base = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)
    for x in (134, 172, 318, 356):
        draw.rounded_rectangle([x * S, 152 * S, (x + 22) * S, 172 * S], radius=3 * S, fill=MOD_TOP + (255,))
    base = Image.alpha_composite(base, gradient_box((108, 168, 404, 324), 18, MOD_TOP, MOD_BOTTOM))
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle([134 * S, 192 * S, 262 * S, 256 * S], radius=8 * S, fill=(0, 0, 0, 0))
    for x in (284, 330):
        draw.rounded_rectangle([x * S, 238 * S, (x + 34) * S, 252 * S], radius=7 * S, fill=(0, 0, 0, 0))
    draw.ellipse([(292 - 8) * S, (210 - 8) * S, (292 + 8) * S, (210 + 8) * S], fill=LED_CORE + (255,))
    base = Image.alpha_composite(base, gradient_box((72, 368, 440, 398), 10, RAIL_TOP, RAIL_BOTTOM))
    return base.resize((512, 512), RESAMPLE)


def main():
    out_icon = ROOT / 'apps' / 'desktop' / 'build' / 'icon.png'
    out_res = ROOT / 'apps' / 'desktop' / 'resources'
    out_doc = Path(__file__).resolve().parent

    icon = render_icon_512()
    icon.save(out_icon)
    icon.save(out_doc / 'snap-rail-icon-512.png')
    icon.resize((256, 256), RESAMPLE).save(out_doc / 'snap-rail-icon-256.png')

    tray = render_tray()
    tray.resize((64, 64), RESAMPLE).save(out_res / 'tray@2x.png')
    tray.resize((32, 32), RESAMPLE).save(out_res / 'tray.png')

    for p in (out_icon, out_res / 'tray.png', out_res / 'tray@2x.png',
              out_doc / 'snap-rail-icon-512.png', out_doc / 'snap-rail-icon-256.png'):
        with Image.open(p) as im:
            print(f'{p.name}: {im.size} {im.mode}')


if __name__ == '__main__':
    main()
