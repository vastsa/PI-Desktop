#!/usr/bin/env python3
"""Derive PI-Desktop platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` file is the brand source of
truth. This script preserves that file and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

from collections import deque
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.size != (BASE, BASE):
        raise ValueError(
            f"canonical logo must be {BASE}x{BASE}, got {master.width}x{master.height}"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    windows_icon = BUILD / "icon.ico"
    master.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # macOS menu bar icons are template images: the opaque pixels are tinted
    # by the system. The application icon has an opaque milky-white tile with
    # a colorful StarAI emblem in the center, so using it directly would turn
    # the tile into a solid square silhouette. Flood-fill the milky-white tile
    # background from inside the squircle so the entire central star (including
    # bright internal highlights) becomes one solid monochrome silhouette.
    inner_bg = master.getpixel((180, 180))[:3]
    rgb = master.convert("RGB")
    rgb_pixels = rgb.load()
    bg_r, bg_g, bg_b = inner_bg
    width, height = master.size
    margin = 148
    bg_mask = bytearray(width * height)
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def is_tile_bg(px: int, py: int) -> bool:
        r, g, b = rgb_pixels[px, py]
        return ((r - bg_r) ** 2 + (g - bg_g) ** 2 + (b - bg_b) ** 2) <= 26 * 26

    for x in range(margin, width - margin):
        for y in (margin, height - margin - 1):
            idx = y * width + x
            if not visited[idx] and is_tile_bg(x, y):
                visited[idx] = 1
                bg_mask[idx] = 1
                queue.append((x, y))
    for y in range(margin, height - margin):
        for x in (margin, width - margin - 1):
            idx = y * width + x
            if not visited[idx] and is_tile_bg(x, y):
                visited[idx] = 1
                bg_mask[idx] = 1
                queue.append((x, y))

    while queue:
        cx, cy = queue.popleft()
        for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
            if margin <= nx < width - margin and margin <= ny < height - margin:
                idx = ny * width + nx
                if not visited[idx] and is_tile_bg(nx, ny):
                    visited[idx] = 1
                    bg_mask[idx] = 1
                    queue.append((nx, ny))

    # Keep only the central connected emblem so squircle rim pixels can never leak.
    star_visited = bytearray(width * height)
    tray_alpha = Image.new("L", master.size, 0)
    out_alpha = tray_alpha.load()
    cx0, cy0 = width // 2, height // 2
    if not bg_mask[cy0 * width + cx0]:
        star_q: deque[tuple[int, int]] = deque([(cx0, cy0)])
        star_visited[cy0 * width + cx0] = 1
        while star_q:
            cx, cy = star_q.popleft()
            out_alpha[cx, cy] = 255
            for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                if margin <= nx < width - margin and margin <= ny < height - margin:
                    idx = ny * width + nx
                    if not star_visited[idx] and not bg_mask[idx]:
                        star_visited[idx] = 1
                        star_q.append((nx, ny))

    tray_alpha = ImageChops.multiply(tray_alpha, master.getchannel("A"))
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(tray_alpha)
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain a central StarAI mark")
    bw = mark_bounds[2] - mark_bounds[0]
    bh = mark_bounds[3] - mark_bounds[1]
    scale = 768.0 / max(bw, bh)
    target_w = max(1, int(round(bw * scale)))
    target_h = max(1, int(round(bh * scale)))
    mark = tray_icon_mac.crop(mark_bounds).resize((target_w, target_h), Image.LANCZOS)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.paste(mark, ((BASE - target_w) // 2, (BASE - target_h) // 2), mark)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        master.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        master.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            iconset / f"icon_{sz}x{sz}@2x.png"
        )

    iconutil = shutil.which("iconutil")
    if iconutil is None:
        print(f"used {SOURCE}")
        print(f"wrote {windows_icon}")
        print(f"wrote {package_icon}")
        print(f"wrote {tray_icon_mac_path}")
        print("skipped icon.icns (iconutil is unavailable)")
        return

    icns = BUILD / "icon.icns"
    subprocess.run(
        [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
    )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
