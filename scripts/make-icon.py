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

import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"

BASE = 1024


def _sharp_small_frame(frame: Image.Image, target: int) -> Image.Image:
    """Downscale to a small ICO size with staged resampling.

    PIL's ICO plugin resizes straight from the 1024px master in one
    LANCZOS pass. A single >10x reduction drops most pixels on the floor
    and leaves the 16/32/48px taskbar frames soft and muddy, which reads
    as a blurry icon under HiDPI scaling. Halving down to just above the
    target keeps fine edges alive, and a light unsharp mask restores the
    contrast the small raster loses.
    """
    size = frame.size[0]
    while size > target * 2:
        size = max(target * 2, size // 2)
        frame = frame.resize((size, size), Image.LANCZOS)
    frame = frame.resize((target, target), Image.LANCZOS)
    if target >= 32:
        # 16px frames have too few pixels for a contrast boost to help;
        # sharpening everything above that restores edge definition.
        return frame.filter(ImageFilter.UnsharpMask(radius=1, percent=80, threshold=2))
    return frame


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
    ico_sizes = [
        (16, 16),
        (32, 32),
        (48, 48),
        (64, 64),
        (128, 128),
        (256, 256),
    ]
    # Pre-render each frame with the staged downscale instead of letting
    # PIL's ICO plugin resize straight from the 1024px master: the direct
    # single-pass reduction leaves the small taskbar frames soft, which
    # reads as a blurry icon under HiDPI scaling (see issue #2050).
    ico_frames = [_sharp_small_frame(master, w) for (w, _) in ico_sizes]
    # The ICO base frame must be the largest one; smaller frames are kept
    # as-is from append_images when their size matches.
    ico_frames[-1].save(
        windows_icon,
        format="ICO",
        append_images=ico_frames[:-1],
        sizes=ico_sizes,
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # macOS menu bar icons are template images: the opaque pixels are tinted
    # by the system. The application icon has an opaque light tile, so using
    # it directly would turn that tile into the tray silhouette. Derive the
    # dark PI mark as a transparent, monochrome image instead.
    tray_icon = master.convert("L")
    tray_alpha = ImageChops.multiply(
        tray_icon.point(
            lambda luminance: max(0, min(255, (160 - luminance) * 255 // 80))
        ),
        master.getchannel("A"),
    )
    # The source artwork also contains a soft outline around its light app
    # tile. Keep the known PI mark area so that outline cannot leak into the
    # menu bar template silhouette.
    mark_clip = Image.new("L", master.size, 0)
    mark_draw = ImageDraw.Draw(mark_clip)
    mark_draw.rectangle((120, 115, 850, 800), fill=255)
    mark_draw.rectangle((120, 115, 250, 250), fill=0)
    tray_alpha = ImageChops.multiply(tray_alpha, mark_clip)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.putalpha(tray_alpha)
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("canonical logo does not contain a dark PI mark")
    mark = tray_icon_mac.crop(mark_bounds).resize((768, 768), Image.LANCZOS)
    tray_icon_mac = Image.new("RGBA", master.size, (0, 0, 0, 0))
    tray_icon_mac.paste(mark, (128, 128), mark)
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
