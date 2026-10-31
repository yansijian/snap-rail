"""Scratch: third pass — combine the row with an active module and a hot-swap cue."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
src = (HERE / "generate.py").read_text(encoding="utf-8")
ns: dict = {"__name__": "gen", "__file__": str(HERE / "generate.py")}
sys.modules["gen"] = type(sys)("gen")
exec(compile(src, "generate.py", "exec"), ns)  # noqa: S102

RRect, Spec, render = ns["RRect"], ns["Spec"], ns["render"]

RAIL = RRect((96, 700, 928, 820), 40, "cobalt", highlight=(6, 28))

VARIANTS = {
    "K active + lift": (
        RAIL,
        RRect((176, 280, 352, 700), 48, "face"),
        RRect((416, 280, 656, 700), 48, "cobalt"),
        RRect((720, 216, 896, 636), 48, "face"),
    ),
    "L active + out": (
        RAIL,
        RRect((176, 280, 352, 700), 48, "face"),
        RRect((416, 280, 656, 700), 48, "cobalt"),
        RRect((744, 120, 920, 540), 48, "face"),
    ),
    "M seat notches": (
        RRect(
            (96, 700, 928, 820),
            40,
            "cobalt",
            punch=((392, 676, 680, 748, 24), (696, 676, 872, 748, 24)),
            highlight=(6, 28),
        ),
        RRect((176, 280, 352, 700), 48, "face"),
        RRect((416, 280, 656, 748), 48, "cobalt"),
        RRect((720, 280, 896, 748), 48, "face"),
    ),
    "N two + gap": (
        RAIL,
        RRect((176, 280, 352, 700), 48, "cobalt"),
        RRect((416, 280, 656, 700), 48, "face"),
    ),
    "O four equal": (
        RAIL,
        RRect((160, 300, 328, 700), 44, "face"),
        RRect((392, 300, 560, 700), 44, "cobalt"),
        RRect((624, 300, 792, 700), 44, "face"),
        RRect((856, 300, 1024, 700), 44, "face"),
    ),
}

FONT = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 14)
cell, gap = 240, 20
cols = 5
sheet = Image.new("RGB", (gap + cols * (cell + gap), 14 + 200 + 120), (18, 22, 28))
d = ImageDraw.Draw(sheet)
for i, (name, shapes) in enumerate(VARIANTS.items()):
    spec = Spec(id="x", name=name, claim="", geometry="", shapes=shapes, says=(), unclear=())
    x = gap + i * (cell + gap)
    big = render(spec, 200)
    sheet.paste(big, (x, 12), big)
    d.text((x, 12 + 200 + 6), name, font=FONT, fill=(150, 165, 180))
    xx = x
    for s in (32, 16):
        im = render(spec, s)
        z = 3 if s == 32 else 5
        zoom = im.resize((s * z, s * z), Image.NEAREST)
        sheet.paste(zoom, (xx, 12 + 200 + 28), zoom)
        xx += s * z + 8
sheet.save(HERE / "_sweep.png")
print("ok")
