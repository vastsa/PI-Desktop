#!/usr/bin/env python3
"""Publish capture-rig PNGs as the documentation and README screenshots.

The rig in ``apps/desktop/electron/main/index.ts`` writes 2400x1600 PNGs to
``/tmp/codex-screens`` when the app runs with ``PI_DESKTOP_CAPTURE=1``. Those
frames are the source of truth for every screenshot the project ships, so the
docs never drift from the shell the e2e UI scenarios describe.

Run the rig once per locale (append ``--lang=zh-CN`` to the electron command for
the Chinese pass), then publish each pass:

    python3 scripts/publish-screenshots.py --source /tmp/shots-en --locale en
    python3 scripts/publish-screenshots.py --source /tmp/shots-zh --locale zh

Scenes land in ``docs/public/screenshots/app/<locale>/`` for the gallery page and
the README subset lands in ``docs/public/readme/``. Scenes the rig produces but
this list omits are duplicates of another frame, not surfaces we hide.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GALLERY_ROOT = ROOT / "docs" / "public" / "screenshots" / "app"
README_ROOT = ROOT / "docs" / "public" / "readme"

# Rendered at 2x the ~800px docs content column; webp keeps each frame around
# 35 KB, so the whole bilingual gallery costs a few megabytes.
TARGET_WIDTH = 1600
QUALITY = 82

LOCALES = ("en", "zh")

# Scene id (the rig's shot() name without the "pi-" prefix) in gallery order.
SCENES = (
    # Home and conversation
    "home-light",
    "home-dark",
    "minimap",
    "minimap-hover",
    "model-menu",
    "composer-slash",
    "composer-at",
    # Work panels
    "panel-review",
    "panel-browser",
    "panel-files",
    "panel-menu",
    # Destinations
    "pulls-live",
    "dark-pulls",
    "project-archive-live",
    "dark-project-archive",
    "scheduled-live",
    # Notifications and toasts
    "notifications-light",
    "notifications-dark",
    "notifications-narrow",
    "toasts-light",
    "toasts-dark",
    # Global search
    "search",
    "search-query",
    "search-settings",
    "search-pages",
    "search-anchor",
    "search-dark",
    # Plugins
    "plugins-live",
    "plugins-market",
    "plugins-menu",
    "plugins-row-menu",
    "plugins-template",
    # Extensions
    "extensions-mcp",
    "extensions-scope",
    "extensions-mcp-editor",
    "extensions-skills",
    "extensions-subagents",
    "extensions-subagents-provided",
    "extensions-subagent-editor",
    "extensions-subagents-dark",
    "extensions-mcp-dark",
    # Settings
    "settings-live",
    "dark-settings",
    "settings-models",
    "settings-extensions",
    "settings-extensions-custom",
    # Dark home is grouped with the home scenes on the page.
    "dark-home",
)

# Gallery scene -> README file stem. The Chinese README reads the ".zh" variant.
README_SHOTS = {
    "home-light": "home",
    "minimap": "conversation",
    "plugins-market": "marketplace",
    "model-menu": "models",
    "settings-live": "basics",
}


def publish(source: Path, locale: str) -> int:
    gallery = GALLERY_ROOT / locale
    gallery.mkdir(parents=True, exist_ok=True)
    README_ROOT.mkdir(parents=True, exist_ok=True)

    missing = [scene for scene in SCENES if not (source / f"pi-{scene}.png").exists()]
    if missing:
        print(f"missing {len(missing)} scene(s) in {source}: {', '.join(missing)}")
        return 1

    for scene in SCENES:
        frame = Image.open(source / f"pi-{scene}.png").convert("RGB")
        height = round(frame.height * TARGET_WIDTH / frame.width)
        frame = frame.resize((TARGET_WIDTH, height), Image.LANCZOS)
        frame.save(gallery / f"{scene}.webp", "WEBP", quality=QUALITY, method=6)
        stem = README_SHOTS.get(scene)
        if stem:
            suffix = "" if locale == "en" else f".{locale}"
            frame.save(
                README_ROOT / f"{stem}{suffix}.webp", "WEBP", quality=QUALITY, method=6
            )

    published = sorted(gallery.glob("*.webp"))
    total = sum(path.stat().st_size for path in published)
    print(f"{locale}: {len(published)} gallery frames, {total / 1e6:.2f} MB")
    print(f"{locale}: {len(README_SHOTS)} README frames in {README_ROOT.relative_to(ROOT)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="capture PNG directory")
    parser.add_argument("--locale", required=True, choices=LOCALES, help="UI language of the pass")
    arguments = parser.parse_args()
    return publish(arguments.source, arguments.locale)


if __name__ == "__main__":
    sys.exit(main())
