"""
Step W2: download a national flag for every country in the world fire record.

Reads the country names out of Clean_dataset/world_monthly.csv, resolves each to
an ISO 3166-1 alpha-2 code, and saves that flag as SVG under
Frontend/assets/flags/. Also writes flags/index.json, the name -> code map the
website uses, so the browser never has to guess a code from a name.

Flags are served from this project, not from a CDN: the site then works offline,
nothing is requested from a third party while a judge is using it, and a flag
cannot disappear because someone else's service changed.

Source: flagcdn.com, which publishes the ISO 3166-1 set as plain SVG.

Usage:
    python flags_build.py [--out Frontend/assets/flags] [--force]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

CODES_URL = "https://flagcdn.com/en/codes.json"
FLAG_URL = "https://flagcdn.com/{code}.svg"
WORLD_CSV = os.path.join("Clean_dataset", "world_monthly.csv")
UA = {"User-Agent": "buriningview-flags/1.0"}

# FIRMS spells some countries its own way. Each of these was checked by hand.
OVERRIDES = {
    "Aland Islands": "ax",
    "Brunei Darussalam": "bn",
    "Cote d Ivoire": "ci",
    "Curacao": "cw",
    "Czech Republic": "cz",
    # Both Congos normalise to "congo" once "democratic" and "republic" are
    # stripped, so the larger one has to be pinned explicitly. It is also the
    # country with the most fire on Earth, so getting it wrong is very visible.
    "Democratic Republic of the Congo": "cd",     # Kinshasa
    "Republic of Congo": "cg",                    # Brazzaville
    "Dem Rep Korea": "kp",                        # North Korea
    "Heard I and McDonald Islands": "hm",
    "Lao PDR": "la",
    "Macedonia Former Yugoslav Republic of": "mk",
    "Republic of Korea": "kr",                    # South Korea
    "Reunion": "re",
    "Russian Federation": "ru",
    "Saint Helena": "sh",
    "Sao Tome and Principe": "st",
    "Swaziland": "sz",                            # now Eswatini; FIRMS keeps the old name
}

# Words that differ between the two spellings often enough to be worth ignoring.
NOISE = re.compile(r"\b(the|of|republic|islands|island|rep|dem|democratic|federated|"
                   r"states|former|yugoslav)\b")


def normalise(name: str) -> str:
    text = name.lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return " ".join(NOISE.sub(" ", text).split())


def fetch(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=os.path.join("Frontend", "assets", "flags"))
    parser.add_argument("--force", action="store_true", help="re-download flags already saved")
    args = parser.parse_args()

    if not os.path.exists(WORLD_CSV):
        raise SystemExit(f"{WORLD_CSV} not found - run world_build.py first")
    os.makedirs(args.out, exist_ok=True)

    with open(WORLD_CSV, encoding="utf-8") as handle:
        countries = sorted({row["country"] for row in csv.DictReader(handle)})
    print(f"{len(countries)} countries in the fire record")

    catalogue = json.loads(fetch(CODES_URL).decode("utf-8"))
    by_name: dict[str, str] = {}
    for code, label in catalogue.items():
        by_name.setdefault(normalise(label), code)

    mapping: dict[str, str] = {}
    unmatched: list[str] = []
    for name in countries:
        code = OVERRIDES.get(name) or by_name.get(normalise(name))
        if code:
            mapping[name] = code
        else:
            unmatched.append(name)

    print(f"resolved {len(mapping)} to a flag" + (f", {len(unmatched)} without one" if unmatched else ""))
    for name in unmatched:
        print(f"   no flag: {name}")

    # Two countries sharing a code means the name matching collapsed a real
    # distinction. Say so loudly rather than shipping one country another's flag.
    shared: dict[str, list[str]] = {}
    for name, code in mapping.items():
        shared.setdefault(code, []).append(name)
    clashes = {c: n for c, n in shared.items() if len(n) > 1}
    for code, names in sorted(clashes.items()):
        print(f"   WARNING both map to '{code}': {', '.join(names)} - add an override")

    wanted = sorted(set(mapping.values()))
    todo = [c for c in wanted
            if args.force or not os.path.exists(os.path.join(args.out, f"{c}.svg"))]
    print(f"{len(wanted)} distinct flags, {len(todo)} to download")

    failed: list[str] = []

    def grab(code: str) -> None:
        try:
            data = fetch(FLAG_URL.format(code=code))
            if not data.lstrip()[:5].lower().startswith(b"<svg") and b"<svg" not in data[:400]:
                raise ValueError("not an SVG")
            with open(os.path.join(args.out, f"{code}.svg"), "wb") as fh:
                fh.write(data)
        except (urllib.error.URLError, ValueError, OSError) as exc:
            failed.append(f"{code}: {exc}")

    if todo:
        with ThreadPoolExecutor(max_workers=12) as pool:
            list(pool.map(grab, todo))

    # drop any country whose flag did not arrive, so the site never points at a missing file
    broken = {c for c in wanted if not os.path.exists(os.path.join(args.out, f"{c}.svg"))}
    if broken:
        mapping = {n: c for n, c in mapping.items() if c not in broken}

    index_path = os.path.join(args.out, "index.json")
    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump(dict(sorted(mapping.items())), fh, ensure_ascii=False, indent=0)

    total = sum(os.path.getsize(os.path.join(args.out, f"{c}.svg"))
                for c in wanted if c not in broken)
    print(f"\nSaved {len(wanted) - len(broken)} flags ({total / 1024:.0f} KB) -> {args.out}")
    print(f"Wrote {index_path} with {len(mapping)} countries")
    for line in failed:
        print(f"   failed: {line}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
