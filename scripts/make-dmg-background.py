#!/usr/bin/env python3
"""Paint the macOS DMG background used by electron-builder.

The Finder window is 720x440 with a 128px two-icon install row. This script
emits the 1x plate and the 1440x880 retina companion that electron-builder
picks up as ``dmg-background@2x.png``.

Run: python3 scripts/make-dmg-background.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
ICON_SOURCE = BUILD / "icon_1024.png"

# Logical 1x coordinates. Keep in sync with apps/desktop/package.json build.dmg.
WIDTH = 720
HEIGHT = 440
SCALE = 2
APP = (180, 196)
APPLICATIONS = (540, 196)
ICON_SIZE = 128

PLATE = (24, 24, 24, 255)
LIFT = (52, 52, 52, 255)
RING = (255, 255, 255, 42)
INK = (255, 255, 255, 255)
MUTED = (180, 180, 180, 255)
FAINT = (120, 120, 120, 255)
ARROW = (232, 232, 232, 255)


def _px(value: float) -> int:
    return int(round(value * SCALE))


def _font(path: str, size: float, index: int = 0) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(path, _px(size), index=index)
    except OSError:
        return ImageFont.load_default()


def _center_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    cy: float,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
) -> None:
    x0, y0, x1, y1 = draw.textbbox((0, 0), text, font=font)
    x = _px(WIDTH / 2) - (x1 - x0) // 2 - x0
    y = _px(cy) - (y1 - y0) // 2 - y0
    draw.text((x, y), text, font=font, fill=fill)


def _radial(size: int, color: tuple[int, int, int, int], inner: float = 0.18) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = layer.load()
    radius = (size - 1) / 2
    cx = cy = radius
    red, green, blue, alpha = color
    for y in range(size):
        dy = (y - cy) / radius
        for x in range(size):
            dist = math.hypot((x - cx) / radius, dy)
            if dist >= 1:
                continue
            if dist <= inner:
                falloff = 1.0
            else:
                t = (dist - inner) / (1.0 - inner)
                falloff = (1.0 - t) * (1.0 - t)
            pixels[x, y] = (red, green, blue, int(alpha * falloff))
    return layer


def _paste(base: Image.Image, layer: Image.Image, cx: float, cy: float) -> None:
    x = _px(cx) - layer.width // 2
    y = _px(cy) - layer.height // 2
    base.alpha_composite(layer, (x, y))


def _grain(size: tuple[int, int]) -> Image.Image:
    noise = Image.effect_noise(size, 18).convert("L")
    layer = Image.new("RGBA", size, (255, 255, 255, 0))
    layer.putalpha(noise.point(lambda value: 10 if value > 140 else 0))
    return layer


def _ring(base: Image.Image, cx: float, cy: float) -> None:
    diameter = _px(ICON_SIZE + 16)
    pad = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    draw = ImageDraw.Draw(pad)
    inset = max(1, _px(1.25))
    draw.ellipse(
        (inset, inset, diameter - inset - 1, diameter - inset - 1),
        outline=RING,
        width=max(1, _px(1.25)),
    )
    _paste(base, pad, cx, cy)


def _arrow(base: Image.Image) -> None:
    layer = Image.new("RGBA", (_px(WIDTH), _px(HEIGHT)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    y = _px(APP[1])
    x0 = _px(APP[0] + 86)
    x1 = _px(APPLICATIONS[0] - 98)
    stroke = max(3, _px(2.5))
    draw.line((x0, y, x1 - _px(14), y), fill=ARROW, width=stroke)
    head = [
        (x1 - _px(20), y - _px(12)),
        (x1 + _px(2), y),
        (x1 - _px(20), y + _px(12)),
        (x1 - _px(13), y),
    ]
    draw.polygon(head, fill=ARROW)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.4)))


def _wordmark(base: Image.Image) -> None:
    mark_size = _px(26)
    with Image.open(ICON_SOURCE) as source:
        mark = source.convert("RGBA").resize((mark_size, mark_size), Image.LANCZOS)

    title_font = _font("/System/Library/Fonts/HelveticaNeue.ttc", 21, index=10)
    caption_font = _font("/System/Library/Fonts/HelveticaNeue.ttc", 13, index=0)
    zh_font = _font("/System/Library/Fonts/Hiragino Sans GB.ttc", 12, index=0)

    draw = ImageDraw.Draw(base)
    title = "PI-Desktop"
    x0, y0, x1, y1 = draw.textbbox((0, 0), title, font=title_font)
    gap = _px(10)
    cluster_w = mark_size + gap + (x1 - x0)
    left = _px(WIDTH / 2) - cluster_w // 2
    top = _px(42) - mark_size // 2
    base.alpha_composite(mark, (left, top))
    draw.text(
        (left + mark_size + gap - x0, _px(42) - (y1 - y0) // 2 - y0),
        title,
        font=title_font,
        fill=INK,
    )
    _center_text(draw, "Drag to Applications to install", 328, caption_font, MUTED)
    _center_text(draw, "拖到「应用程序」完成安装", 352, zh_font, FAINT)


def render() -> Image.Image:
    canvas = Image.new("RGBA", (_px(WIDTH), _px(HEIGHT)), PLATE)
    _paste(
        canvas,
        _radial(_px(920), LIFT, inner=0.16).filter(ImageFilter.GaussianBlur(_px(36))),
        WIDTH / 2,
        HEIGHT / 2 + 12,
    )
    for cx, cy in (APP, APPLICATIONS):
        _paste(
            canvas,
            _radial(_px(188), (255, 255, 255, 16), inner=0.28).filter(
                ImageFilter.GaussianBlur(_px(10))
            ),
            cx,
            cy,
        )
        _ring(canvas, cx, cy)
    canvas.alpha_composite(_grain(canvas.size))
    _arrow(canvas)
    _wordmark(canvas)
    return canvas


def main() -> None:
    if not ICON_SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {ICON_SOURCE}")

    BUILD.mkdir(parents=True, exist_ok=True)
    retina = render()
    one_x = retina.resize((WIDTH, HEIGHT), Image.LANCZOS)
    retina_path = BUILD / "dmg-background@2x.png"
    one_x_path = BUILD / "dmg-background.png"
    retina.save(retina_path, format="PNG", optimize=True)
    one_x.save(one_x_path, format="PNG", optimize=True)
    print(f"wrote {one_x_path} ({WIDTH}x{HEIGHT})")
    print(f"wrote {retina_path} ({_px(WIDTH)}x{_px(HEIGHT)})")


if __name__ == "__main__":
    main()
