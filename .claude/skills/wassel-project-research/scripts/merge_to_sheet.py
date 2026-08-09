"""Merge Paseetah + web-research markdown tables into a single sources.csv.

This script is the deterministic merge step in the Wassel pipeline:

  paseetah.md (Arabic, 15 cols)        ──┐
                                          │ merge
  web_research.md (Arabic, 15 cols)    ──┘ ──>  sources.csv (45+ rows, UTF-8 BOM)

It walks a fixed 45-row seed list (9 categories × 5 metrics each) and for each
(الفئة, المؤشر) pair looks up a matching row in either input. Unfilled seed
rows are written as "غير متوفر" — gap visibility is the whole point.

Precedence rules:
  - Numeric market categories (pricing / market activity / supply / yield):
      Paseetah wins, web is fallback.
  - Project / regulatory / location categories (specs / location / demand /
    competition / regulatory):
      Web wins (these aren't Paseetah's strong suit), Paseetah is fallback.
  - If both sources have a value AND they disagree on number (>10% delta)
    or on string (different strings): emit BOTH rows, both tagged
    حالة التحقق = متضارب.

This script is pure Python (stdlib only). No network, no Google API. The
resulting CSV gets uploaded to Google Sheets by the orchestrator subagent in
a later phase.

Usage:
    python merge_to_sheet.py <paseetah.md> <web_research.md> <out.csv> [<project_name>] [<run_date>]

All four paths are absolute. project_name and run_date are optional; if
omitted they default to "" and today's ISO date.
"""

from __future__ import annotations

import csv
import datetime
import re
import sys
from pathlib import Path
from typing import Iterable, NamedTuple

# ---------------------------------------------------------------------------
# The 15-column sheet schema, in the exact Arabic wording used by the sheet.
# This order is the canonical order everywhere downstream — do not reshuffle.
# ---------------------------------------------------------------------------

COLUMNS = [
    "الفئة",
    "المؤشر",
    "القيمة",
    "الوحدة",
    "النطاق",
    "الجغرافيا",
    "الفترة الزمنية",
    "تاريخ الاستخراج",
    "المصدر الأساسي",
    "رابط المصدر",
    "المصدر الثانوي",
    "حالة التحقق",
    "مستوى الثقة",
    "طريقة التجميع",
    "ملاحظات",
]

# ---------------------------------------------------------------------------
# The 45-row seed list. Every /wassel run produces at least these rows; any
# row without data becomes "غير متوفر" so gaps are visible.
#
# Each entry is (category, metric_label, default_unit, paseetah_wins).
# paseetah_wins=True → precedence goes to Paseetah numeric data; web is fallback.
# paseetah_wins=False → web wins (categories Paseetah doesn't cover well).
# ---------------------------------------------------------------------------

SEED_ROWS = [
    # 1. التسعير
    ("التسعير", "متوسط سعر المتر",                         "ريال/م²",      True),
    ("التسعير", "نطاق السعر (أدنى – أعلى)",                "ريال",         True),
    ("التسعير", "علاوة السعر مقابل متوسط الحي",            "%",            True),
    ("التسعير", "اتجاه السعر خلال ٣-٥ سنوات",              "%",            True),
    ("التسعير", "سعر الإطلاق مقابل إعادة البيع",           "ريال/م²",      False),

    # 2. نشاط السوق
    ("نشاط السوق", "عدد الصفقات آخر ١٢ شهر",               "صفقة",         True),
    ("نشاط السوق", "إجمالي قيمة الصفقات آخر ١٢ شهر",       "ريال",         True),
    ("نشاط السوق", "معدل الامتصاص (نسبة البيع)",           "%",            True),
    ("نشاط السوق", "متوسط أيام البيع",                     "يوم",          True),
    ("نشاط السوق", "التغير السنوي في حجم الصفقات",         "%",            True),

    # 3. العرض
    ("العرض", "إجمالي المعروض السكني في الحي",             "وحدة",         True),
    ("العرض", "المشاريع قيد الإنشاء / الإطلاق",            "مشروع",        True),
    ("العرض", "نسبة الشواغر",                              "%",            True),
    ("العرض", "أشهر المخزون",                              "شهر",          True),
    ("العرض", "حصة المربع من إجمالي الحي",                 "%",            False),

    # 4. مواصفات المنتج
    ("مواصفات المنتج", "مزيج الوحدات (شقق/فلل/دور)",        "%",            False),
    ("مواصفات المنتج", "متوسط مساحة الوحدة",               "م²",           False),
    ("مواصفات المنتج", "مساحة الأرض / المخطط",             "م²",           False),
    ("مواصفات المنتج", "مستوى التشطيب السائد",             "—",            False),
    ("مواصفات المنتج", "المرافق (مسبح، نادي، أمن، تكييف، منزل ذكي)", "—", False),

    # 5. العائد والاستثمار
    ("العائد والاستثمار", "العائد الإجمالي على الاستثمار",  "%",            True),
    ("العائد والاستثمار", "العائد الصافي بعد المصاريف",     "%",            True),
    ("العائد والاستثمار", "متوسط الإيجار السنوي للمتر",     "ريال/م²",     True),
    ("العائد والاستثمار", "كاب-ريت (Cap Rate)",             "%",            True),
    ("العائد والاستثمار", "فترة الاسترداد المقدرة",         "سنة",          True),

    # 6. الموقع
    ("الموقع", "المسافة إلى وسط الأعمال (CBD)",             "كم",           False),
    ("الموقع", "قرب المرافق (مدارس، مستشفيات، مساجد، مولات)", "—",         False),
    ("الموقع", "واجهة الطريق وجودة الوصول",                 "—",            False),
    ("الموقع", "قابلية المشي والحركة",                       "—",            False),
    ("الموقع", "الوصول إلى المترو / النقل العام",           "—",            False),

    # 7. الطلب والسكان
    ("الطلب والسكان", "ملف المشتري المستهدف",               "—",            False),
    ("الطلب والسكان", "متوسط دخل الأسرة",                   "ريال",         False),
    ("الطلب والسكان", "متوسط / وسيط حجم الأسرة",            "فرد",          True),
    ("الطلب والسكان", "النسبة السعودية مقابل غير السعودية", "%",            True),
    ("الطلب والسكان", "معدل نمو سكان الحي",                 "%",            True),

    # 8. المنافسة
    ("المنافسة", "المشاريع المنافسة المباشرة",              "مشروع",        False),
    ("المنافسة", "نسبة البيع للمشاريع المقارنة",            "%",            False),
    ("المنافسة", "وتيرة البيع الشهرية للمقارنات",           "وحدة/شهر",     False),
    ("المنافسة", "فجوة التمييز مقابل المنافسين",            "—",            False),
    ("المنافسة", "الحصة المحتملة من السوق",                 "%",            False),

    # 9. التنظيمي
    ("التنظيمي", "التصنيف التنظيمي للمنطقة",                "—",            False),
    ("التنظيمي", "نسبة البناء والارتفاع المسموح",           "—",            False),
    ("التنظيمي", "تصنيفات خاصة (روشن، أرض بيضاء، إلخ)",     "—",            False),
    ("التنظيمي", "قيود الاستخدام والاستعمال",               "—",            False),
    ("التنظيمي", "الضرائب والرسوم الإضافية",                "—",            False),
]

assert len(SEED_ROWS) == 45, f"seed list must be 45 rows, got {len(SEED_ROWS)}"


# ---------------------------------------------------------------------------
# Markdown-table parsing.
#
# We accept any markdown table whose header row contains "الفئة" and "المؤشر"
# somewhere. Column order doesn't have to match COLUMNS exactly — we re-map
# by header name. Extra columns are preserved into `ملاحظات`. Missing cells
# are empty strings.
# ---------------------------------------------------------------------------

class Row(NamedTuple):
    category: str
    metric: str
    data: dict  # column-name -> value, all string


_HEADER_CELL_RE = re.compile(r"\s*\|\s*")


def _split_row(line: str) -> list[str]:
    """Split a markdown table row by `|`, stripping outer pipes and whitespace."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def parse_markdown_tables(text: str) -> list[Row]:
    """Extract rows from every markdown table in `text` whose header contains
    both الفئة and المؤشر. Returns flat list across all tables."""
    rows: list[Row] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        # Find a header row with "الفئة" and "المؤشر"
        if "|" in lines[i] and "الفئة" in lines[i] and "المؤشر" in lines[i]:
            headers = _split_row(lines[i])
            # Next line should be the separator (|---|---|…). Skip it.
            sep = lines[i + 1] if i + 1 < len(lines) else ""
            if not re.match(r"^\s*\|[\s|:\-]+\|\s*$", sep):
                # Not a real table header — skip this line
                i += 1
                continue
            i += 2
            # Consume body rows until a non-pipe line
            while i < len(lines) and "|" in lines[i] and lines[i].strip().startswith("|"):
                cells = _split_row(lines[i])
                if len(cells) < 2:
                    i += 1
                    continue
                data = dict(zip(headers, cells + [""] * (len(headers) - len(cells))))
                cat = data.get("الفئة", "").strip()
                met = data.get("المؤشر", "").strip()
                if cat and met:
                    rows.append(Row(cat, met, data))
                i += 1
        else:
            i += 1
    return rows


# ---------------------------------------------------------------------------
# Merge logic.
# ---------------------------------------------------------------------------

def _normalize_numeric(s: str) -> float | None:
    """Extract a comparable float from a cell like '٧٨٠٠' or '7,800' or '~8,070'.
    Returns None if no numeric part found. Handles Arabic-Indic digits."""
    if not s:
        return None
    # Arabic-Indic → Western
    trans = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
    s2 = s.translate(trans)
    # Strip everything that isn't digit, dot, minus
    m = re.search(r"-?\d[\d,]*\.?\d*", s2.replace(",", ""))
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _values_conflict(a: str, b: str) -> bool:
    """Return True if two non-empty cells disagree in a way worth flagging.
    Numeric: >10% relative delta. String: different after whitespace normalize."""
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b:
        return False
    if a == "غير متوفر" or b == "غير متوفر":
        return False
    na, nb = _normalize_numeric(a), _normalize_numeric(b)
    if na is not None and nb is not None:
        if max(abs(na), abs(nb)) == 0:
            return False
        return abs(na - nb) / max(abs(na), abs(nb)) > 0.10
    # Non-numeric: compare normalized strings
    return re.sub(r"\s+", " ", a) != re.sub(r"\s+", " ", b)


def _blank_seed_row(category: str, metric: str, unit: str, run_date: str) -> dict:
    """Default row for a seed entry that had no data found anywhere."""
    return {
        "الفئة": category,
        "المؤشر": metric,
        "القيمة": "غير متوفر",
        "الوحدة": unit,
        "النطاق": "غير محدد",
        "الجغرافيا": "",
        "الفترة الزمنية": "",
        "تاريخ الاستخراج": run_date,
        "المصدر الأساسي": "",
        "رابط المصدر": "",
        "المصدر الثانوي": "",
        "حالة التحقق": "غير موجود",
        "مستوى الثقة": "منخفض",
        "طريقة التجميع": "",
        "ملاحظات": "",
    }


def _canonicalize(row: Row, run_date: str) -> dict:
    """Coerce a parsed Row into a full 15-column dict, filling empty cells
    with sensible defaults. Extra columns not in COLUMNS are appended to
    `ملاحظات` so no source data is silently dropped."""
    out: dict[str, str] = {c: "" for c in COLUMNS}
    for k, v in row.data.items():
        if k in out:
            out[k] = v
    if not out["تاريخ الاستخراج"]:
        out["تاريخ الاستخراج"] = run_date
    if not out["حالة التحقق"]:
        out["حالة التحقق"] = "غير واضح"
    if not out["مستوى الثقة"]:
        out["مستوى الثقة"] = "متوسط"
    if not out["النطاق"]:
        out["النطاق"] = "غير محدد"
    # Fold any extra (non-schema) columns into notes so they're preserved.
    extras = [f"{k}={v}" for k, v in row.data.items() if k not in out and v]
    if extras:
        sep = " | " if out["ملاحظات"] else ""
        out["ملاحظات"] = (out["ملاحظات"] + sep + "; ".join(extras)).strip()
    return out


def merge(
    paseetah_rows: list[Row],
    web_rows: list[Row],
    run_date: str,
) -> list[dict]:
    """Walk the 45 seed rows. For each (category, metric) emit either:
      - one merged row (sources agree, or only one source has data), OR
      - two متضارب rows (sources disagree).
    Rows in the inputs that don't match any seed (category, metric) are
    appended AFTER the 45 seed rows as bonus rows (preserved, not dropped)."""
    # Index inputs by (category, metric) for O(1) lookup.
    def _key(r: Row) -> tuple[str, str]:
        return (r.category.strip(), r.metric.strip())

    pas_by_key: dict[tuple[str, str], Row] = {}
    web_by_key: dict[tuple[str, str], Row] = {}
    for r in paseetah_rows:
        pas_by_key.setdefault(_key(r), r)
    for r in web_rows:
        web_by_key.setdefault(_key(r), r)

    seen_keys: set[tuple[str, str]] = set()
    output: list[dict] = []

    for category, metric, unit, paseetah_wins in SEED_ROWS:
        key = (category, metric)
        seen_keys.add(key)
        pr = pas_by_key.get(key)
        wr = web_by_key.get(key)

        if pr is None and wr is None:
            output.append(_blank_seed_row(category, metric, unit, run_date))
            continue

        pr_dict = _canonicalize(pr, run_date) if pr else None
        wr_dict = _canonicalize(wr, run_date) if wr else None

        # Ensure defaults
        if pr_dict and not pr_dict["الوحدة"]:
            pr_dict["الوحدة"] = unit
        if wr_dict and not wr_dict["الوحدة"]:
            wr_dict["الوحدة"] = unit
        if pr_dict and not pr_dict["طريقة التجميع"]:
            pr_dict["طريقة التجميع"] = "بيسيطة - محادثة"
        if wr_dict and not wr_dict["طريقة التجميع"]:
            wr_dict["طريقة التجميع"] = "بحث ويب"

        if pr_dict and wr_dict:
            if _values_conflict(pr_dict["القيمة"], wr_dict["القيمة"]):
                # Emit both, flag متضارب
                pr_dict = {**pr_dict, "حالة التحقق": "متضارب"}
                wr_dict = {**wr_dict, "حالة التحقق": "متضارب"}
                # Keep precedence order: the winner first, loser second
                if paseetah_wins:
                    output.extend([pr_dict, wr_dict])
                else:
                    output.extend([wr_dict, pr_dict])
            else:
                # Agree (or one is empty) — pick the preferred source, fold the other into notes
                primary = pr_dict if paseetah_wins else wr_dict
                secondary = wr_dict if paseetah_wins else pr_dict
                merged = dict(primary)
                if secondary["القيمة"] and not primary["القيمة"]:
                    merged["القيمة"] = secondary["القيمة"]
                if secondary["رابط المصدر"] and not primary["رابط المصدر"]:
                    merged["رابط المصدر"] = secondary["رابط المصدر"]
                if secondary["المصدر الأساسي"] and secondary["المصدر الأساسي"] != primary["المصدر الأساسي"]:
                    sep = " | " if merged["ملاحظات"] else ""
                    merged["ملاحظات"] = (
                        merged["ملاحظات"] + sep
                        + f"مصدر ثانوي مؤكِّد: {secondary['المصدر الأساسي']}"
                    )
                output.append(merged)
        elif pr_dict:
            output.append(pr_dict)
        else:
            # wr_dict only
            output.append(wr_dict)  # type: ignore[arg-type]

    # Bonus rows: anything in the inputs that didn't match a seed key.
    for r in paseetah_rows:
        if _key(r) not in seen_keys:
            d = _canonicalize(r, run_date)
            if not d["طريقة التجميع"]:
                d["طريقة التجميع"] = "بيسيطة - محادثة"
            sep = " | " if d["ملاحظات"] else ""
            d["ملاحظات"] = (d["ملاحظات"] + sep + "صف إضافي خارج قائمة البذور").strip()
            output.append(d)
            seen_keys.add(_key(r))
    for r in web_rows:
        if _key(r) not in seen_keys:
            d = _canonicalize(r, run_date)
            if not d["طريقة التجميع"]:
                d["طريقة التجميع"] = "بحث ويب"
            sep = " | " if d["ملاحظات"] else ""
            d["ملاحظات"] = (d["ملاحظات"] + sep + "صف إضافي خارج قائمة البذور").strip()
            output.append(d)
            seen_keys.add(_key(r))

    return output


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def write_csv(rows: list[dict], path: Path) -> None:
    """Write rows to UTF-8-BOM CSV so Excel (and Google Sheets import) renders
    Arabic correctly. Column order follows COLUMNS."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in COLUMNS})


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    paseetah_path = Path(argv[1])
    web_path = Path(argv[2])
    out_path = Path(argv[3])
    project_name = argv[4] if len(argv) > 4 else ""
    run_date = argv[5] if len(argv) > 5 else datetime.date.today().isoformat()

    paseetah_text = paseetah_path.read_text(encoding="utf-8") if paseetah_path.exists() else ""
    web_text = web_path.read_text(encoding="utf-8") if web_path.exists() else ""

    paseetah_rows = parse_markdown_tables(paseetah_text)
    web_rows = parse_markdown_tables(web_text)

    merged = merge(paseetah_rows, web_rows, run_date)
    write_csv(merged, out_path)

    # Short stderr summary (stdout is reserved in case the orchestrator pipes it).
    filled = sum(1 for r in merged if r["القيمة"] and r["القيمة"] != "غير متوفر")
    conflicts = sum(1 for r in merged if r["حالة التحقق"] == "متضارب")
    gaps = sum(1 for r in merged if r["حالة التحقق"] == "غير موجود")
    print(
        f"[merge] project={project_name!r} rows={len(merged)} "
        f"filled={filled} gaps={gaps} conflicts={conflicts} "
        f"paseetah_parsed={len(paseetah_rows)} web_parsed={len(web_rows)} "
        f"-> {out_path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
