"""snap-rail og card generator + website version stamper.

Single source of truth for the product version is apps/desktop/package.json
(the same field electron-builder derives the exe / NSIS / feed versions from).
This script derives everything version-shaped on the website from it:

  - website/public/og.png          regenerated: brand lockup + version line,
                                   right product screenshot carried over
  - website/index.html             `softwareVersion` and the feed
                                   `downloadUrl` are stamped to the version

Usage:
  py website/scripts/generate-og.py           # stamp og.png + index.html
  py website/scripts/generate-og.py --check   # verify both match; exit 1 on drift
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ICON_GENERATOR = ROOT / 'docs' / 'brand' / 'icon' / 'a3-industrial' / 'generate.py'
INDEX_HTML = ROOT / 'website' / 'index.html'
OG_PNG = ROOT / 'website' / 'public' / 'og.png'
OLD_OG = ROOT / 'docs' / 'brand' / 'icon' / 'a3-industrial' / 'og-reference.png'

W, H = 1200, 630
S = 2  # text layer supersample; the screenshot crop is composited at 1x

BG = (11, 15, 20)          # #0b0f14, the factory night theme bg
AMBER = (242, 169, 0)      # #f2a900, sampled from the existing card
WHITE = (231, 236, 241)    # #e7ecf1, site --d-text
DESC = (184, 195, 206)     # #b8c3ce
META = (147, 161, 174)     # #93a1ae, site --d-muted

RIGHT_CROP = (712, 80, 1160, 618)  # framed product screenshot, kept verbatim

HEADLINE_L1 = '接上设备，'
HEADLINE_L2 = '马上得到结果。'
DESC_LINES = (
    '一台可组装的工业终端：填 IP、点测试、套模板。',
    '驱动、点表、界面、场景包，按你的设备来装。',
)


def load_version():
    manifest = ROOT / 'apps' / 'desktop' / 'package.json'
    return json.loads(manifest.read_text(encoding='utf-8'))['version']


def load_icon_image():
    spec = importlib.util.spec_from_file_location('snap_rail_icon_gen', ICON_GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.render_icon_512()


def load_fonts():
    def truetype(names, size):
        for name in names:
            path = Path('C:/Windows/Fonts') / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
        raise SystemExit(f'none of {names} found in C:/Windows/Fonts')

    return {
        'wordmark': truetype(['msyhbd.ttc', 'simhei.ttf'], 38 * S),
        'headline': truetype(['msyhbd.ttc', 'simhei.ttf'], 82 * S),
        'desc': truetype(['msyh.ttc', 'simhei.ttf'], 29 * S),
        'meta': truetype(['CascadiaMono.ttf', 'CascadiaCode.ttf', 'consola.ttf'], 25 * S),
    }


def render_base(version):
    """Deep-space card at 1x: brand lockup, headline, desc, versioned meta line."""
    canvas = Image.new('RGBA', (W * S, H * S), BG + (255,))
    draw = ImageDraw.Draw(canvas)
    fonts = load_fonts()

    draw.rectangle([0, 0, 10 * S, H * S], fill=AMBER + (255,))

    icon = load_icon_image().resize((64 * S, 64 * S), Image.Resampling.LANCZOS)
    canvas.paste(icon, (64 * S, 56 * S), icon)
    draw.text((146 * S, 68 * S), 'snap-rail', font=fonts['wordmark'], fill=WHITE + (255,))

    draw.text((64 * S, 176 * S), HEADLINE_L1, font=fonts['headline'], fill=WHITE + (255,))
    draw.text((64 * S, 282 * S), HEADLINE_L2, font=fonts['headline'], fill=AMBER + (255,))
    for i, line in enumerate(DESC_LINES):
        draw.text((64 * S, (424 + i * 42) * S), line, font=fonts['desc'], fill=DESC + (255,))
    draw.text(
        (64 * S, 556 * S),
        f'v{version} · Apache-2.0 · Windows 10/11',
        font=fonts['meta'], fill=META + (255,),
    )

    return canvas.resize((W, H), Image.Resampling.LANCZOS)


def render_og(version, reference):
    og = render_base(version)
    og.paste(reference.crop(RIGHT_CROP), RIGHT_CROP[:2])
    return og.convert('RGB')


def stamp_index(version):
    """Point softwareVersion and the feed downloadUrl at the version. Idempotent."""
    with open(INDEX_HTML, encoding='utf-8', newline='') as file:
        text = file.read()
    text, n_ver = re.subn(
        r'("softwareVersion"\s*:\s*")[^"]+(")',
        rf'\g<1>{version}\g<2>',
        text,
    )
    text, n_url = re.subn(
        r'snap-rail-\d+\.\d+\.\d+-x64-setup\.exe',
        f'snap-rail-{version}-x64-setup.exe',
        text,
    )
    if n_ver != 1 or n_url != 1:
        raise SystemExit(f'unexpected index.html shape: softwareVersion x{n_ver}, downloadUrl x{n_url}')
    with open(INDEX_HTML, 'w', encoding='utf-8', newline='') as file:
        file.write(text)
    return n_ver + n_url


def check(version):
    problems = []
    text = INDEX_HTML.read_text(encoding='utf-8')
    if f'"softwareVersion": "{version}"' not in text:
        problems.append('index.html softwareVersion != package.json version')
    if f'snap-rail-{version}-x64-setup.exe' not in text:
        problems.append('index.html downloadUrl != package.json version')
    reference = Image.open(OLD_OG)
    current = Image.open(OG_PNG)
    if current.size != (W, H):
        problems.append(f'og.png size {current.size} != {(W, H)}')
    else:
        expected = render_og(version, reference)
        if expected.tobytes() != current.convert('RGB').tobytes():
            problems.append('og.png pixels drift from the generator output')
    return problems


def main():
    argv = sys.argv[1:]
    version = load_version()
    if not OLD_OG.exists():
        # first run: keep the current card as the screenshot reference
        OLD_OG.write_bytes(OG_PNG.read_bytes())
        print(f'reference card saved: {OLD_OG.name}')
    reference = Image.open(OLD_OG)

    if '--check' in argv:
        problems = check(version)
        if problems:
            print('verify:og — drift:')
            for problem in problems:
                print(f'  - {problem}')
            sys.exit(1)
        print(f'verify:og — clean (v{version})')
        return

    changes = stamp_index(version)
    render_og(version, reference).save(OG_PNG)
    print(f'og.png regenerated, index.html stamped ({changes} fields) at v{version}')


if __name__ == '__main__':
    main()
