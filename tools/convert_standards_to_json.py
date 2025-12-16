#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any, Callable

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
STANDARDS_DIR = ROOT / "age_grade_standards"

TIME_RE = re.compile(r"^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$")  # [H:]MM:SS(.sss)


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", str(s).strip())


def normalize_key(s: str) -> str:
    # more aggressive: remove spaces + punctuation so Stan/Std/typos are easier to match
    return re.sub(r"[^a-z0-9]+", "", str(s).strip().lower())


def num_to_int_if_whole(x: Any) -> int | float | None:
    """
    Convert numeric-ish values to int if they're whole (e.g., 1225.0 -> 1225).
    Keep as float only if truly fractional. Return None for NaN.
    """
    if pd.isna(x):
        return None
    v = float(x)
    if v.is_integer():
        return int(v)
    return v


def hms_to_seconds(x: Any) -> float | None:
    if pd.isna(x):
        return None

    if isinstance(x, pd.Timedelta):
        return x.total_seconds()
    if isinstance(x, pd.Timestamp):
        return (x - x.normalize()).total_seconds()

    if isinstance(x, dt.time):
        return x.hour * 3600 + x.minute * 60 + x.second + x.microsecond / 1_000_000
    if isinstance(x, dt.datetime):
        return x.hour * 3600 + x.minute * 60 + x.second + x.microsecond / 1_000_000
    if isinstance(x, dt.timedelta):
        return x.total_seconds()

    if isinstance(x, (int, float)):
        # Excel can store times as fractions of a day
        if 0 < float(x) <= 1:
            return float(x) * 86400.0
        return float(x)

    s = str(x).strip()
    m = TIME_RE.match(s)
    if not m:
        raise ValueError(f"Unrecognized time format: {x!r}")
    h = int(m.group(1) or 0)
    mm = int(m.group(2))
    ss = float(m.group(3))
    return h * 3600 + mm * 60 + ss


def find_header_row(raw_df: pd.DataFrame, needle="age", max_rows=50) -> int | None:
    for r in range(min(max_rows, len(raw_df))):
        row = raw_df.iloc[r].astype(str).str.strip().str.lower()
        if any(v == needle or v.startswith(needle) for v in row.values):
            return r
    return None


def read_sheet_with_detected_header(path: Path, sheet: str) -> pd.DataFrame:
    raw = pd.read_excel(path, sheet_name=sheet, header=None)
    hdr = find_header_row(raw, needle="age") or 0
    df = pd.read_excel(path, sheet_name=sheet, header=hdr)
    df.columns = [normalize(c) for c in df.columns]
    return df


def find_age_col(cols) -> str:
    # prefer exact-ish age column
    for c in cols:
        cl = c.strip().lower()
        if cl == "age" or cl.startswith("age ") or cl.startswith("age(") or cl.startswith("age/") or cl.startswith("age-"):
            return c
    for c in cols:
        if "age" in c.lower():
            return c
    raise RuntimeError(f"Could not locate Age column. Columns: {list(cols)}")


def choose_sheets(path: Path) -> dict[str, str]:
    """
    Returns mapping: {"factors": sheetName, "sec": sheetName, "hms": sheetName}
    Handles 2025 female Stan/typos + 2010 'Age factors'.
    """
    xls = pd.ExcelFile(path)
    sheets = xls.sheet_names
    by_norm = {normalize_key(s): s for s in sheets}

    def pick(candidates_norm: list[str]) -> str | None:
        for k in candidates_norm:
            if k in by_norm:
                return by_norm[k]
        return None

    factors = pick([
        normalize_key("AgeStdFactors"),
        normalize_key("Age Factors"),
        normalize_key("Age factors"),
        normalize_key("Age Facctors"),  # typo in 2025 female
    ])
    sec = pick([
        normalize_key("AgeStdSec"),
        normalize_key("AgeStanSec"),  # 2025 female
    ])
    hms = pick([
        normalize_key("AgeStdHMS"),
        normalize_key("AgeStanHMS"),  # 2025 female
    ])

    # last resort: try “contains” style matching
    if not factors:
        for s in sheets:
            if "factor" in s.lower():
                factors = s
                break
    if not sec:
        for s in sheets:
            if "sec" in s.lower():
                sec = s
                break
    if not hms:
        for s in sheets:
            if "hms" in s.lower():
                hms = s
                break

    missing = [k for k, v in [("factors", factors), ("sec", sec), ("hms", hms)] if not v]
    if missing:
        raise RuntimeError(f"{path.name}: missing sheets {missing}. Available: {sheets}")

    return {"factors": factors, "sec": sec, "hms": hms}


def df_to_age_event_map(
    df: pd.DataFrame,
    value_parser: Callable[[Any], Any]
) -> tuple[list[int], list[str], dict[str, dict[str, Any]]]:
    age_col = find_age_col(df.columns)

    # keep numeric ages
    df = df[df[age_col].apply(lambda x: pd.notna(x) and str(x).strip().isdigit())].copy()
    df[age_col] = df[age_col].astype(int)

    ages = df[age_col].tolist()
    events = [c for c in df.columns if c != age_col]

    out: dict[str, dict[str, Any]] = {}
    for event in events:
        mapping: dict[str, Any] = {}
        col = df[[age_col, event]].dropna(subset=[age_col])
        for _, row in col.iterrows():
            age = int(row[age_col])
            v = row[event]
            mapping[str(age)] = value_parser(v)
        out[normalize(event)] = mapping

    return ages, [normalize(e) for e in events], out


def convert_one(path: Path) -> Path:
    # infer year/sex from filename and folder
    year = path.parent.name
    sex = "F" if "female" in path.name.lower() else "M"

    sheets = choose_sheets(path)

    df_factors = read_sheet_with_detected_header(path, sheets["factors"])
    df_sec = read_sheet_with_detected_header(path, sheets["sec"])
    df_hms = read_sheet_with_detected_header(path, sheets["hms"])

    # ✅ Change: store whole seconds as ints in AgeStdSec (e.g., 1225.0 -> 1225)
    ages_sec, events_sec, map_sec = df_to_age_event_map(df_sec, num_to_int_if_whole)

    # Keep HMS-derived seconds as floats if they happen to be fractional
    ages_hms, events_hms, map_hms = df_to_age_event_map(df_hms, hms_to_seconds)

    # ✅ Optional-but-nice: factors as ints when whole (often they’ll be fractional anyway)
    ages_fac, events_fac, map_fac = df_to_age_event_map(df_factors, num_to_int_if_whole)

    out = {
        "meta": {
            "category": "road",
            "year": int(year) if year.isdigit() else year,
            "sex": sex,
            "source_file": str(path.as_posix()),
            "sheets_used": sheets,
        },
        "AgeStdSec": {
            "ages": ages_sec,
            "events": events_sec,
            "standards_seconds": map_sec,
        },
        "AgeStdHMS": {
            "ages": ages_hms,
            "events": events_hms,
            "standards_seconds": map_hms,
        },
        "AgeStdFactors": {
            "ages": ages_fac,
            "events": events_fac,
            "factors": map_fac,
        },
    }

    out_path = path.with_suffix(".json")
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out_path


def main():
    files: list[Path] = []
    for ext in ("*.xls", "*.xlsx"):
        files.extend(STANDARDS_DIR.rglob(ext))

    # only convert RoadStd files (safer if you later add other stuff)
    files = [p for p in files if "roadstd" in p.name.lower()]

    if not files:
        raise SystemExit(f"No RoadStd Excel files found under {STANDARDS_DIR}")

    print(f"Found {len(files)} files.")
    for p in sorted(files):
        try:
            out = convert_one(p)
            print(f"OK  {p.name}  ->  {out.name}")
        except Exception as e:
            print(f"FAIL {p} : {e}")
            raise


if __name__ == "__main__":
    main()
