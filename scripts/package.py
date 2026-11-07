"""Build a loadable extension zip in dist/.

Only runtime files are included; tests, tooling and git files are excluded.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

INCLUDE_DIRS = (
    "background",
    "shared",
    "content",
    "popup",
    "options",
    "assets",
    "profile",
    "preset",
)
INCLUDE_FILES = ("manifest.json", "README.md", "LICENSE")
EXCLUDED_NAMES = {".DS_Store", "Thumbs.db"}


def manifest_version() -> str:
    with (ROOT / "manifest.json").open("r", encoding="utf-8") as handle:
        return str(json.load(handle)["version"])


def validate_manifest() -> list[str]:
    errors: list[str] = []
    with (ROOT / "manifest.json").open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    referenced: list[str] = []
    referenced.append(manifest["background"]["service_worker"])
    referenced.append(manifest["action"]["default_popup"])
    referenced.append(manifest["options_ui"]["page"])
    for entry in manifest.get("content_scripts", []):
        referenced.extend(entry.get("js", []))
    referenced.extend(manifest.get("icons", {}).values())
    referenced.extend(manifest.get("action", {}).get("default_icon", {}).values())
    # The background worker loads these with importScripts.
    referenced.extend(
        [
            "shared/config.js",
            "shared/languages.js",
            "shared/detect.js",
            "shared/text.js",
            "shared/protocol-responses.js",
            "shared/protocol.js",
            "shared/usage.js",
            "shared/models.js",
            "shared/vision.js",
            "shared/billing.js",
            "shared/presets.js",
            "shared/glossary.js",
            "shared/novel.js",
            "background/api-transport.js",
            "background/api-anthropic.js",
            "background/api-terms.js",
            "background/api-models.js",
            "background/api-vision.js",
            "background/api.js",
            "background/worker-settings.js",
            "background/worker-state.js",
            "background/worker-vision.js",
            "background/worker-requests.js",
            "background/worker-pages.js",
            "background/worker-capture.js",
            "background/worker-image-panel.js",
            "background/worker-pretranslation.js",
            "background/worker-glossary-tidy.js",
        ]
    )
    referenced.extend(
        [
            "profile/index.json",
            "profile/deepseek.json",
            "profile/openai.json",
            "profile/anthropic.json",
            "profile/xai.json",
            "profile/gemini.json",
            "profile/custom.json",
            "preset/index.json",
            "preset/system-prompts.js",
            "preset/general.json",
            "preset/academic.json",
            "preset/light-novel.json",
        ]
    )
    # Content files are injected dynamically.
    referenced.extend(
        [
            "content/overlay.js",
            "content/content.js",
        ]
    )

    for relative in sorted(set(referenced)):
        if not (ROOT / relative).is_file():
            errors.append(f"missing referenced file: {relative}")
    return errors


def iter_runtime_files():
    for filename in INCLUDE_FILES:
        path = ROOT / filename
        if path.is_file():
            yield path
    for directory in INCLUDE_DIRS:
        base = ROOT / directory
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and path.name not in EXCLUDED_NAMES:
                yield path


def main() -> int:
    errors = validate_manifest()
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    version = manifest_version()
    DIST.mkdir(parents=True, exist_ok=True)
    target = DIST / f"baka-translator-v{version}.zip"
    # Unpacked extension IDs follow the folder path, so upgrades must land in the same folder.
    top = "baka-translator"

    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in iter_runtime_files():
            archive.write(path, f"{top}/{path.relative_to(ROOT).as_posix()}")

    print(f"Built {target} ({target.stat().st_size / 1024:.1f} KiB)")
    print(f"Extract it, then load the '{top}' folder via Load unpacked in your browser:")
    print("Chrome: chrome://extensions/ | Brave: brave://extensions/ | Edge: edge://extensions/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
