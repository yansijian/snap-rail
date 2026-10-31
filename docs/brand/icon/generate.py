"""snap-rail icon v2 — candidate renderer and review sheet.

The product is one host plus swappable capability modules (everything is a
plugin, hot-swapped at runtime, on industrial terminals). So the mark has to
state exactly one thing: a base that a part snaps onto. Each candidate below is
a different way of stating it.

Every candidate is plain data drawn by one shape kernel, so the raster, the SVG
and the review page cannot drift apart.

Run: python docs/brand/icon/generate.py
"""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
GRID = 1024
TILE_R = 228
SEAM = 64  # the one hard rule: never separate two shapes by less than 64 units


@dataclass(frozen=True)
class Grad:
    a: tuple[int, int, int]
    b: tuple[int, int, int]
    angle: float = 90.0


TILE_DARK = Grad((0x17, 0x1F, 0x2A), (0x0A, 0x0E, 0x13))
TILE_LIGHT = Grad((0xE7, 0xED, 0xF5), (0xD1, 0xDA, 0xE7))
COBALT_DARK = Grad((0x5A, 0x76, 0xFF), (0x3A, 0x56, 0xE4), 106.0)
COBALT_LIGHT = Grad((0x4A, 0x6C, 0xFF), (0x2F, 0x49, 0xD6), 106.0)
FACE_DARK = Grad((0xF2, 0xF6, 0xFB), (0xDC, 0xE5, 0xF0))
FACE_LIGHT = Grad((0x1B, 0x24, 0x30), (0x0D, 0x13, 0x1A))

ROLES = {"cobalt": (COBALT_DARK, COBALT_LIGHT), "face": (FACE_DARK, FACE_LIGHT)}


@dataclass(frozen=True)
class RRect:
    rect: tuple[float, float, float, float]
    r: float
    role: str
    punch: tuple[tuple[float, float, float, float, float], ...] = ()
    highlight: tuple[float, int] | None = None  # (height, alpha) along the top edge


@dataclass(frozen=True)
class Spec:
    id: str
    name: str
    claim: str
    geometry: str
    shapes: tuple[RRect, ...]
    says: tuple[str, ...]
    unclear: tuple[str, ...]


# --- candidates -------------------------------------------------------------
RAIL = RRect((96, 660, 928, 780), 16, "cobalt", highlight=(6, 28))

CANDIDATES = (
    Spec(
        id="e1",
        name="E1 · 一轨三模 · 热插拔",
        claim="一条轨道上装着三个模块，最右边那个正被拔起来",
        geometry="轨道 832×120 · 模块 176/240/176×420 · 缝 64 · 抬升 64",
        shapes=(
            RAIL,
            RRect((152, 240, 328, 660), 26, "face"),
            RRect((392, 240, 632, 660), 26, "cobalt"),
            RRect((696, 176, 872, 596), 26, "face"),
        ),
        says=(
            "轨道、模块、空位：一眼是“底座上装了一排模块”。",
            "最右那块抬起来，方向就是拔出去，插拔动作看得见。",
            "中间那块是钴蓝：三个里有一个是“当前这个”。",
        ),
        unclear=(
            "模块数量一多，16px 会糊；需要单独的 16px 画法（两块）。",
            "抬起来的那块也可能被读成“掉落”，要靠间隙和位置站稳。",
        ),
    ),
    Spec(
        id="e2",
        name="E2 · 一轨四模",
        claim="四个模块排满一条轨道，中间那块亮着",
        geometry="轨道 832×120 · 四块 160×400 · 缝 64",
        shapes=(
            RAIL,
            RRect((96, 260, 256, 660), 24, "face"),
            RRect((320, 260, 480, 660), 24, "cobalt"),
            RRect((544, 260, 704, 660), 24, "face"),
            RRect((768, 260, 928, 660), 24, "face"),
        ),
        says=(
            "排满的轨道最能说明“一切皆插件”：这里已经有四块。",
            "一块亮着、三块沉着，主次和数量都在。",
        ),
        unclear=(
            "四块在 16px 必然糊成一条带齿的横杠。",
            "间距一致，缺一点“可以被换掉”的动感。",
        ),
    ),
    Spec(
        id="e3",
        name="E3 · 一轨两模",
        claim="一条轨道，两块模块：一块在位，一块空位",
        geometry="轨道 832×120 · 两块 200×440 · 缝 160",
        shapes=(
            RAIL,
            RRect((176, 220, 376, 660), 26, "face"),
            RRect((536, 220, 736, 660), 26, "cobalt"),
        ),
        says=(
            "最少的信息量：底座 + 两块。小尺寸最稳。",
            "中间那道大空隙读作“还能再装”，留了余地。",
        ),
        unclear=(
            "两块太少，读不出“插件系统”，更像“两个面板”。",
            "空位是留白不是形状，可能只是被当成排版。",
        ),
    ),
)


# --- raster -----------------------------------------------------------------
def _k(size: int) -> int:
    """Supersample factor: small icons need more of it to land on a clean pixel."""
    if size <= 32:
        return 8
    if size <= 128:
        return 4
    return 2


def _mask(w: int, rect, r: float, punch=()) -> Image.Image:
    k = w / GRID
    m = Image.new("L", (w, w), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([rect[0] * k, rect[1] * k, rect[2] * k, rect[3] * k], radius=r * k, fill=255)
    for p in punch:
        d.rounded_rectangle([p[0] * k, p[1] * k, p[2] * k, p[3] * k], radius=p[4] * k, fill=0)
    return m


def _grad_image(g: Grad, rect, w: int) -> tuple[Image.Image, tuple[int, int]]:
    k = w / GRID
    x0, y0, x1, y1 = (v * k for v in rect)
    bw, bh = max(2, int(round(x1 - x0))), max(2, int(round(y1 - y0)))
    yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32)
    a = math.radians(g.angle)
    dx, dy = math.cos(a), math.sin(a)
    half = (abs(dx) * bw + abs(dy) * bh) / 2
    t = ((xx - bw / 2) * dx + (yy - bh / 2) * dy) / (2 * half) + 0.5
    t = np.clip(t, 0.0, 1.0)[..., None]
    top = np.array(g.a, np.float32)
    arr = (top + (np.array(g.b, np.float32) - top) * t).astype(np.uint8)
    return Image.fromarray(arr, "RGB").convert("RGBA"), (int(round(x0)), int(round(y0)))


def _paint(canvas: Image.Image, layer: Image.Image, mask: Image.Image) -> None:
    canvas.alpha_composite(Image.composite(layer, Image.new("RGBA", canvas.size, (0, 0, 0, 0)), mask))


def render(spec: Spec, size: int, light: bool = False) -> Image.Image:
    w = size * _k(size)
    k = w / GRID
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    tile_mask = _mask(w, (0, 0, GRID, GRID), TILE_R)
    grad, pos = _grad_image(TILE_LIGHT if light else TILE_DARK, (0, 0, GRID, GRID), w)
    tile_layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    tile_layer.paste(grad, pos)
    _paint(canvas, tile_layer, tile_mask)

    for s in spec.shapes:
        mask = _mask(w, s.rect, s.r, s.punch)
        g = ROLES[s.role][1 if light else 0]
        grad, pos = _grad_image(g, s.rect, w)
        layer = Image.new("RGBA", (w, w), (0, 0, 0, 0))
        layer.paste(grad, pos)
        _paint(canvas, layer, mask)
        if s.highlight:
            height, alpha = s.highlight
            edge = Image.new("RGBA", (w, w), (0, 0, 0, 0))
            ImageDraw.Draw(edge).rectangle(
                [s.rect[0] * k, s.rect[1] * k, s.rect[2] * k, (s.rect[1] + height) * k],
                fill=(255, 255, 255, alpha),
            )
            edge.putalpha(Image.composite(edge.getchannel("A"), Image.new("L", (w, w), 0), mask))
            canvas.alpha_composite(edge)

    canvas.putalpha(Image.composite(canvas.getchannel("A"), Image.new("L", (w, w), 0), tile_mask))
    return canvas.resize((size, size), Image.LANCZOS)


# --- svg --------------------------------------------------------------------
def _line(g: Grad, rect) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = rect
    a = math.radians(g.angle)
    dx, dy = math.cos(a), math.sin(a)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = (abs(dx) * (x1 - x0) + abs(dy) * (y1 - y0)) / 2
    return cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half


def _hex(c: tuple[int, int, int]) -> str:
    return "#%02X%02X%02X" % c


def _grad_tag(gid: str, g: Grad, rect) -> str:
    x1, y1, x2, y2 = _line(g, rect)
    return (
        f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
        f'x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}">'
        f'<stop offset="0" stop-color="{_hex(g.a)}"/>'
        f'<stop offset="1" stop-color="{_hex(g.b)}"/></linearGradient>'
    )


def svg(spec: Spec, light: bool = False) -> str:
    tile_grad = TILE_LIGHT if light else TILE_DARK
    defs = [_grad_tag("tile", tile_grad, (0, 0, GRID, GRID))]
    body = [f'<rect width="{GRID}" height="{GRID}" fill="url(#tile)"/>']

    for i, s in enumerate(spec.shapes):
        g = ROLES[s.role][1 if light else 0]
        defs.append(_grad_tag(f"g{i}", g, s.rect))
        mask_attr = ""
        if s.punch:
            holes = "".join(
                f'<rect x="{p[0]}" y="{p[1]}" width="{p[2] - p[0]}" height="{p[3] - p[1]}" '
                f'rx="{p[4]}" fill="#000"/>'
                for p in s.punch
            )
            defs.append(
                f'<mask id="m{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="{GRID}" height="{GRID}">'
                f'<rect x="{s.rect[0]}" y="{s.rect[1]}" width="{s.rect[2] - s.rect[0]}" '
                f'height="{s.rect[3] - s.rect[1]}" rx="{s.r}" fill="#fff"/>{holes}</mask>'
            )
            mask_attr = f' mask="url(#m{i})"'
        body.append(
            f'<rect x="{s.rect[0]}" y="{s.rect[1]}" width="{s.rect[2] - s.rect[0]}" '
            f'height="{s.rect[3] - s.rect[1]}" rx="{s.r}" fill="url(#g{i})"{mask_attr}/>'
        )
        if s.highlight:
            height, alpha = s.highlight
            body.append(
                f'<rect x="{s.rect[0]}" y="{s.rect[1]}" width="{s.rect[2] - s.rect[0]}" '
                f'height="{height}" fill="#fff" fill-opacity="{alpha / 255:.2f}" mask="url(#m{i})"/>'
            )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {GRID} {GRID}" width="{GRID}" '
        f'height="{GRID}" role="img" aria-label="snap-rail {spec.name}">\n'
        f"  <title>snap-rail · {spec.name}</title>\n"
        f"  <defs>\n    " + "\n    ".join(defs) + "\n  </defs>\n"
        f'  <clipPath id="tile"><rect width="{GRID}" height="{GRID}" rx="{TILE_R}"/></clipPath>\n'
        f'  <g clip-path="url(#tile)">\n    ' + "\n    ".join(body) + "\n  </g>\n</svg>\n"
    )


# --- review page ------------------------------------------------------------
def _uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _card(spec: Spec) -> str:
    hero = _uri(render(spec, 512))
    light = _uri(render(spec, 160, light=True))
    ladder = "".join(
        f'<figure><img src="{_uri(render(spec, s))}" width="{s}" height="{s}" alt="">'
        f"<figcaption>{s}</figcaption></figure>"
        for s in (64, 48, 32, 24, 16)
    )
    zoom = _uri(render(spec, 16))
    says = "".join(f"<li>{t}</li>" for t in spec.says)
    unclear = "".join(f"<li>{t}</li>" for t in spec.unclear)
    return f"""
    <article class="card" id="{spec.id}">
      <header class="card-h">
        <span class="tag">{spec.id.upper()}</span>
        <h2>{spec.name.split(' · ')[1]}</h2>
        <p class="claim">{spec.claim}</p>
      </header>
      <div class="hero"><img src="{hero}" alt="{spec.name}"></div>
      <p class="geo">{spec.geometry}</p>
      <div class="ladder">{ladder}</div>
      <div class="pair">
        <figure class="zoom"><img class="pixel" src="{zoom}" width="128" height="128" alt="">
          <figcaption>16px · 8× 真实像素</figcaption></figure>
        <figure class="lightfig"><img src="{light}" width="128" height="128" alt="">
          <figcaption>浅底 · 160px</figcaption></figure>
      </div>
      <dl class="notes">
        <dt>它说了什么</dt><dd><ul>{says}</ul></dd>
        <dt>它没说清的</dt><dd><ul>{unclear}</ul></dd>
      </dl>
    </article>"""


def explore_html(specs: tuple[Spec, ...]) -> str:
    cards = "\n".join(_card(s) for s in specs)
    return f"""<!doctype html>
<html lang="zh-CN" data-bg="desktop">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>snap-rail · 图标选型</title>
<style>
  :root {{
    --surface: #12161d;
    --card: #171d26;
    --line: #232b36;
    --text: #e6ecf3;
    --muted: #8b98a8;
    --faint: #5f6b7a;
    --accent: #5a76ff;
  }}
  html[data-bg="light"] {{ --surface: #eef2f7; --card: #ffffff; --line: #dbe3ec; --text: #1b2430; --muted: #5d6d7e; --faint: #8b98a8; }}
  html[data-bg="white"] {{ --surface: #ffffff; --card: #f7f9fc; --line: #e3e9f1; --text: #1b2430; --muted: #5d6d7e; --faint: #8b98a8; }}
  html[data-bg="desktop"] {{ --surface: #0b0f14; --card: #12171f; --line: #1e2631; --text: #e6ecf3; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--surface); color: var(--text);
    font: 15px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    transition: background .2s;
  }}
  .wrap {{ max-width: 1560px; margin: 0 auto; padding: 40px 40px 64px; }}
  h1 {{ font-size: 30px; margin: 0 0 6px; letter-spacing: -.01em; }}
  .sub {{ margin: 0; color: var(--muted); }}
  .rules {{ display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 22px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 13px; }}
  .rules li::before {{ content: "·"; margin-right: 8px; color: var(--accent); }}
  .bar {{ display: flex; align-items: center; gap: 10px; margin: 26px 0 30px; }}
  .bar span {{ color: var(--faint); font-size: 13px; margin-right: 2px; }}
  .bar button {{
    font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: var(--card); color: var(--muted);
  }}
  .bar button[aria-pressed="true"] {{ border-color: var(--accent); color: var(--accent); }}
  .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 26px; }}
  @media (max-width: 1200px) {{ .grid {{ grid-template-columns: 1fr; }} }}
  .card {{ background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px 22px 26px; }}
  .card-h {{ display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; align-items: baseline; }}
  .tag {{ font: 600 12px/1 ui-monospace, Consolas, monospace; letter-spacing: .08em; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 5px; padding: 4px 6px; }}
  .card-h h2 {{ margin: 0; font-size: 20px; font-weight: 600; }}
  .claim {{ grid-column: 1 / -1; margin: 2px 0 0; color: var(--muted); font-size: 14px; }}
  .hero {{ margin: 18px 0 10px; }}
  .hero img {{ width: 100%; height: auto; border-radius: 14px; display: block; }}
  .geo {{ margin: 0 0 16px; color: var(--faint); font: 12px/1.5 ui-monospace, Consolas, monospace; }}
  .ladder {{ display: flex; align-items: flex-end; gap: 18px; padding: 14px 0 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }}
  .ladder figure {{ margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }}
  .ladder figcaption {{ color: var(--faint); font: 11px ui-monospace, Consolas, monospace; }}
  .pair {{ display: flex; gap: 22px; margin: 18px 0 6px; }}
  .pair figure {{ margin: 0; }}
  .pair figcaption {{ color: var(--faint); font-size: 11px; margin-top: 6px; }}
  .pixel {{ image-rendering: pixelated; border-radius: 6px; }}
  .notes {{ margin: 14px 0 0; font-size: 13.5px; }}
  .notes dt {{ color: var(--faint); font-size: 12px; letter-spacing: .04em; margin-top: 14px; }}
  .notes dd {{ margin: 4px 0 0; color: var(--muted); }}
  .notes ul {{ margin: 0; padding-left: 18px; }}
  .notes li + li {{ margin-top: 4px; }}
  footer {{ margin-top: 34px; color: var(--faint); font-size: 13px; }}
  .dropped {{ margin: 30px 0 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted); font-size: 13px; }}
  code {{ font: 12px ui-monospace, Consolas, monospace; color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); padding: 2px 6px; border-radius: 4px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>snap-rail · 图标选型</h1>
  <p class="sub">不做导轨，做接合部：一台底座，和一个能从它上面摘下来的部件。</p>
  <ul class="rules">
    <li>1024 网格，圆角 228</li>
    <li>缝宽固定 64（16px 上的 1px）</li>
    <li>颜色只取出厂钴蓝 token</li>
    <li>不画齿轮、电路、状态灯</li>
  </ul>

  <div class="bar">
    <span>背景</span>
    <button data-set="desktop" aria-pressed="true">深色任务栏</button>
    <button data-set="light" aria-pressed="false">浅色任务栏</button>
    <button data-set="white" aria-pressed="false">纯白</button>
  </div>

  <main class="grid">{cards}</main>

  <p class="dropped">上一轮我砍得太狠了：两块方块并排、一大一小坐着——语义全丢了，看不出“插件”。这一轮把信息加回来：<b>一条底座 + 一排模块</b>。轨道有明确的两端，模块是同一个规格，间距相等，所以读的是“体系”而不是“数据”。被淘汰的还有：机架抽拉（读成抽屉柜）、悬浮对槽（读成下载按钮）、三块不同高（读成柱状图）。</p>

  <footer>选型请在对话里回 <code>E1</code> / <code>E2</code> / <code>E3</code>，我按选中的那一个出全套尺寸与 SVG。</footer>
</div>
<script>
  const buttons = [...document.querySelectorAll('.bar button')];
  for (const b of buttons) {{
    b.addEventListener('click', () => {{
      document.documentElement.dataset.bg = b.dataset.set;
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === b));
    }});
  }}
</script>
</body>
</html>
"""


def main() -> None:
    for s in CANDIDATES:
        render(s, 512).save(HERE / f"explore-{s.id}-512.png")
    (HERE / "explore.html").write_text(explore_html(CANDIDATES), encoding="utf-8")
    print("wrote explore.html + 3 candidate renders")


if __name__ == "__main__":
    main()

