"""
Tally's Receipt Register (.xlsx) -> receipts.json, for scripts/tally-receipts.ts.

    python3 scripts/parse-receipt-register.py out.json "RECEIPTS FY 2024-25.xlsx" ...

Reads only. The register exports as three kinds of row: a receipt header (date,
party, voucher number, credit amount), then its allocation lines (`Agst Ref` /
`New Ref` against a bill number, or `On Account` against nothing), then the bank
line that banked it. A receipt is one arrival of money and the lines beneath it
are where it went, which is exactly `payment_receipts` -> `payments` here.

Every register is checked against its own printed Total before it is written: a
parser that silently drops rows would understate what arrived, and understating
what arrived is how a paying customer ends up on a collections list.
"""

import json
import sys

import openpyxl

ALLOC_KINDS = ("Agst Ref", "New Ref", "On Account", "Advance")


def number(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def financial_year(rows):
    """
    From the register's own "1-Apr-25 to 31-Mar-26" line, never from the file
    name. The label becomes half of each receipt's idempotency key, so a run
    against a renamed copy of a file must not write the same receipts twice.

    It is derived from the START of the range and not the end, because a register
    exported part-way through a year ends in its own year — "1-Apr-26 to
    31-Jul-26" is FY26-27, and reading the end date would call it FY26-26 and
    make a later full-year export of the same year look like a different one.
    """
    for r in rows[:20]:
        text = str(r[0] or "")
        if " to " in text and "-" in text:
            start = text.split(" to ", 1)[0].strip()
            year = int(start.split("-")[-1])
            return f"FY{year:02d}-{year + 1:02d}"
    raise SystemExit("no date-range line found — cannot label this register")


def parse(path):
    rows = [
        list(r)
        for r in openpyxl.load_workbook(
            path, data_only=True, read_only=True
        ).worksheets[0].iter_rows(values_only=True)
    ]

    # The preamble is the company's letterhead and runs to a different depth in
    # each year's export, so the header row is found rather than assumed.
    start = next(
        (i + 2 for i, r in enumerate(rows[:20]) if str(r[0]).strip() == "Date"), 7
    )
    fy_label = financial_year(rows)

    receipts, current, printed_total = [], None, None
    for r in rows[start:]:
        if str(r[0]).strip() == "Total:":
            printed_total = next((number(c) for c in reversed(r) if number(c)), None)
            break
        if r[0] not in (None, ""):
            current = {
                "fy": fy_label,
                # Tally writes a carriage return into some party names.
                "party": str(r[1]).replace("_x000D_", "").strip(),
                "date": str(r[0])[:10],
                "vch": r[7],
                "amount": number(r[9]),
                "bank": None,
                "alloc": [],
            }
            receipts.append(current)
        elif current is not None:
            tag = str(r[1]).strip() if r[1] else ""
            if tag in ALLOC_KINDS:
                current["alloc"].append(
                    {
                        "kind": tag,
                        "bill": str(r[2]).strip() if r[2] else None,
                        "amount": number(r[4]),
                    }
                )
            else:
                current["bank"] = tag

    total = round(sum(r["amount"] or 0 for r in receipts), 2)
    if printed_total is None or abs(printed_total - total) > 0.5:
        raise SystemExit(
            f"{path}: parsed {total} but the register prints {printed_total} — "
            "rows were lost, refusing to write"
        )
    print(f"{fy_label}: {len(receipts)} receipts, {total:,.2f}, reconciled")
    return receipts


def main():
    out, paths = sys.argv[1], sys.argv[2:]
    if not paths:
        raise SystemExit(__doc__)
    everything = []
    for path in paths:
        everything.extend(parse(path))
    json.dump(everything, open(out, "w"))
    print(f"wrote {len(everything)} receipts to {out}")


if __name__ == "__main__":
    main()
