"""Generate the tray glyph from the app's visual language.

The 512px app icon (a dark device between two blue rails with a green status
dot) turns to mush at the 16-32px a Windows tray slot renders, so the tray gets
its own mark: a dark rounded body, two rails, and the green dot — redrawn at
tray size with heavier strokes instead of a downscale.

    python scripts/gen-tray-icon.py

Writes apps/desktop/resources/tray.png (32x32, transparent) and
apps/desktop/resources/tray@2x.png (64x64) for HiDPI trays.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "desktop" / "resources"

BODY = (26, 32, 43, 255)       # the icon's dark device body (#0b0f14 family)
BODY_RIM = (72, 91, 122, 255)  # a lighter rim so the body reads on a dark taskbar
RAIL = (107, 143, 224, 255)    # the blue rail (#6b8fe0)
RAIL_DIM = (74, 107, 176, 255)  # the second, dimmer rail
DOT = (63, 191, 111, 255)      # the green status dot (#3fbf6f)


def draw(size: int) -> Image.Image:
    """Draw the tray glyph at `size` px (32 is the reference grid)."""
    scale = size / 32.0
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)

    def box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        return (x0 * scale, y0 * scale, x1 * scale, y1 * scale)

    width = max(1, round(2.4 * scale))
    # The device body: a rounded rectangle centred in the tile, rimmed so it
    # survives a dark taskbar.
    pen.rounded_rectangle(box(9.5, 3.5, 22.5, 28.5), radius=4 * scale, fill=BODY,
                          outline=BODY_RIM, width=max(1, round(scale)))
    # The two rails running through it, the lower one dimmer.
    pen.rounded_rectangle(box(2, 12.2, 30, 14.6), radius=1.2 * scale, fill=RAIL)
    pen.rounded_rectangle(box(2, 18.4, 30, 20.8), radius=1.2 * scale, fill=RAIL_DIM)
    # The status dot, redrawn over the rails so it reads at 16px.
    pen.ellipse(box(13.4, 6.4, 18.6, 11.6), fill=DOT)
    if width > 2:  # a hint of separation between body and rails at large sizes
        pen.rounded_rectangle(box(9.5, 3.5, 22.5, 28.5), radius=4 * scale, outline=(11, 15, 20, 255), width=1)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in ((32, "tray.png"), (64, "tray@2x.png")):
        path = OUT / name
        draw(size).save(path, format="PNG")
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()