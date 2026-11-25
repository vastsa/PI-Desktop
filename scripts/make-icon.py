#!/usr/bin/env python3
"""Derive Pie Code platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` file is the brand source of
truth. This script preserves that file and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil` (macOS only)
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/linux-icons/  - 16/24/32/48/64/96/512px Linux icons
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon
  apps/desktop/src/assets/brand/logo.png - renderer-sized color icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops

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
    package_icons = BUILD / "linux-icons"
    package_icons.mkdir(exist_ok=True)
    for size in (16, 24, 32, 48, 64, 96, 512):
        master.resize((size, size), Image.LANCZOS).save(package_icons / f"{size}x{size}.png")
    renderer_icon = ROOT / "apps" / "desktop" / "src" / "assets" / "brand" / "logo.png"
    master.resize((192, 192), Image.LANCZOS).save(renderer_icon)

    # macOS tints template icons. Keep only the warm letter and crust,
    # which have more red than blue, and omit the blue tile.
    red, _, blue, alpha = master.split()
    tray_alpha = ImageChops.multiply(
        ImageChops.subtract(red, blue).point(lambda warmth: min(255, warmth * 4)),
        alpha,
    )
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain a warm Pie Code mark")
    mark = tray_alpha.crop(mark_bounds)
    mark.thumbnail((768, 768), Image.LANCZOS)
    template_alpha = Image.new("L", master.size)
    template_alpha.paste(mark, ((BASE - mark.width) // 2, (BASE - mark.height) // 2))
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(template_alpha)
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
        print(f"wrote {package_icons}")
        print(f"wrote {tray_icon_mac_path}")
        print("skipped icon.icns (iconutil is unavailable)")
        return

    icns = BUILD / "icon.icns"
    subprocess.run(
        [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
    )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icons}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
