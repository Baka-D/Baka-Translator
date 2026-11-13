"""Generate native Chromium locale files from the Chinese and English UI catalogs."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES = {"zh_CN": "zh-cn.json", "en": "en.json"}


def outputs() -> dict[Path, str]:
    source = {
        locale: json.loads((ROOT / "locales" / filename).read_text(encoding="utf-8"))
        for locale, filename in LOCALES.items()
    }
    for locale, messages in source.items():
        if not isinstance(messages, dict):
            raise ValueError(f"Locale catalog must be an object: {LOCALES[locale]}")
    keys = set(source["zh_CN"])
    if keys != set(source["en"]):
        missing = sorted(keys - set(source["en"]))
        extra = sorted(set(source["en"]) - keys)
        raise ValueError(f"Message keys differ: en.json missing {missing}, extra {extra}")
    result = {locale: {} for locale in LOCALES}
    for key in sorted(keys):
        if not re.fullmatch(r"[a-z][a-z0-9_]*", key):
            raise ValueError(f"Invalid message key: {key}")
        placeholders = None
        for locale in LOCALES:
            value = source[locale][key]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Empty or invalid message: {key}/{locale}")
            current = set(re.findall(r"\$([1-9])", value))
            if placeholders is not None and current != placeholders:
                raise ValueError(f"Placeholder mismatch: {key}")
            placeholders = current
            # Named placeholders avoid Chrome parsing adjacent $1$2 as a $1$ name.
            message = re.sub(r"\$([1-9])|\$", lambda match:
                             f"$arg{match[1]}$" if match[1] else "$$", value)
            entry = {"message": message}
            if current:
                entry["placeholders"] = {
                    f"arg{index}": {"content": f"${index}"} for index in sorted(current)
                }
            result[locale][key] = entry
    return {
        ROOT / "_locales" / locale / "messages.json":
            json.dumps(messages, ensure_ascii=False, indent=2) + "\n"
        for locale, messages in result.items()
    }


def generate(check: bool = False) -> list[str]:
    stale = []
    for path, content in outputs().items():
        if check:
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if generated locales are stale.")
    args = parser.parse_args()
    stale = generate(args.check)
    if stale:
        print("Locale files are stale; run python scripts/localize.py: " + ", ".join(stale))
        return 1
    print("Locale catalogs verified." if args.check else "Locale catalogs generated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
