#!/usr/bin/env python3
"""
استيراد المخزون الافتتاحي من شيتات Excel (مخزنين) إلى Supabase.

السكريبت مبيكتبش في القاعدة. بيقرا الشيتين، وبيطلّع في فولدر out/:
  - opening-stock.sql  : ملف SQL يتنفّذ مرة واحدة من SQL Editor (كله في transaction)
  - import-review.xlsx : ملف مراجعة (المنتجات والكميات لكل مخزن + اللي اتخطّاه + فروق الأسعار)

شكل كل شيت: عمود الاسم، عمود الكمية بالقطعة، عمود السعر (سعر البيع). أول صف عناوين.
أي صف من غير كمية وسعر (زي عناوين الأقسام) بيتخطّى ويتسجّل في تقرير المراجعة.

الاستخدام:
    pip install openpyxl
    python scripts/import_opening_stock.py --main "مخزن1.xlsx" --branch "مخزن2.xlsx"
    python scripts/import_opening_stock.py --main ... --branch ... --merge merge.json --prices prices.json

merge.json (اختياري): {"اسم الصنف في المخزن الفرعي": "نفس الصنف باسمه في المخزن الرئيسي"}
للأصناف اللي أسماءها مختلفة بس هي نفس المنتج. من غيره، أي اسمين مختلفين بيتعاملوا كمنتجين.

prices.json (اختياري): {"اسم الصنف": 475}
بيوحّد سعر الصنف في كل المخازن (لما الشيتين فيهم سعرين مختلفين لنفس الصنف وانت قررت أنهي واحد).

تنبيه خصوصية: فولدر out/ فيه بيانات العميل (أصناف وأسعار وكميات). ما ترفعوش على GitHub
(اتضاف في .gitignore).
"""
import argparse
import json
import re
import sys
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill

WAREHOUSE_NAMES = ("مخزن 1", "مخزن 2")  # الأول هو الافتراضي (الأساسي)، وتتغيّر أسماؤهم من الواجهة بعدين
OPENING_NOTE = "رصيد افتتاحي — استيراد من الشيتات"
CODE_PREFIX = "P-"

_AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def clean(text) -> str:
    """تنضيف الاسم: شيل التشكيل والتطويل وكرر المسافات. مبنغيّرش الإملاء."""
    s = str(text).translate(_AR_DIGITS)
    s = re.sub(r"[\u064B-\u0652\u0640]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def match_key(text) -> str:
    """مفتاح المطابقة بين الشيتين: بيوحّد الهمزات والياء والتاء المربوطة بس للمقارنة."""
    s = clean(text).lower()
    s = re.sub("[أإآ]", "ا", s).replace("ى", "ي").replace("ة", "ه")
    return s


def to_number(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).translate(_AR_DIGITS).replace(",", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


def read_sheet(path: str):
    """بيرجّع (الأصناف، الصفوف المتخطّاة). الصف الصالح لازم يكون فيه اسم وكمية ≥ 0 وسعر ≥ 0."""
    ws = load_workbook(path, data_only=True).active
    items, skipped = [], []
    for row_no, (name, qty, price) in enumerate(ws.iter_rows(min_row=2, max_col=3, values_only=True), start=2):
        if name is None and qty is None and price is None:
            continue
        q, p = to_number(qty), to_number(price)
        if not name or q is None or p is None or q < 0 or p < 0:
            skipped.append({"row": row_no, "name": clean(name) if name else "", "qty": qty, "price": price})
            continue
        items.append({"row": row_no, "name": clean(name), "qty": q, "price": p})
    return items, skipped


def fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else repr(round(n, 4))


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build(main_items, branch_items, merge_map):
    products = {}  # key -> dict
    order = []

    def add(item, wh):
        key = match_key(item["name"])
        if key not in products:
            products[key] = {"name": item["name"], "main": None, "branch": None}
            order.append(key)
        slot = products[key]
        if slot[wh] is not None:
            raise SystemExit(f"الاسم ده مكرر في نفس الشيت ({wh}): {item['name']} (صف {item['row']})")
        slot[wh] = item

    for it in main_items:
        add(it, "main")

    main_keys = {match_key(it["name"]) for it in main_items}
    merge_keys = {match_key(k): match_key(v) for k, v in merge_map.items()}
    for target in merge_keys.values():
        if target not in main_keys:
            raise SystemExit(f"في merge.json اسم مش موجود في المخزن الرئيسي: {target}")

    for it in branch_items:
        k = match_key(it["name"])
        if k in merge_keys:
            it = {**it, "name": products[merge_keys[k]]["name"]}
        add(it, "branch")

    rows = []
    for i, key in enumerate(order, start=1):
        p = products[key]
        rows.append({
            "code": f"{CODE_PREFIX}{i:05d}",
            "name": p["name"],
            "main": p["main"],
            "branch": p["branch"],
        })
    return rows


def apply_price_overrides(rows, overrides):
    """بيوحّد سعر الأصناف المحددة في كل المخازن اللي فيها الصنف."""
    by_key = {match_key(r["name"]): r for r in rows}
    for name, price in overrides.items():
        row = by_key.get(match_key(name))
        if row is None:
            raise SystemExit(f"في prices.json اسم مش موجود في الشيتات: {name}")
        if not isinstance(price, (int, float)) or price < 0:
            raise SystemExit(f"السعر لازم يكون رقم صفر أو أكبر: {name} = {price}")
        for slot in ("main", "branch"):
            if row[slot]:
                row[slot] = {**row[slot], "price": float(price)}


def write_sql(rows, out_path: Path):
    main_rows = [r for r in rows if r["main"]]
    branch_rows = [r for r in rows if r["branch"]]
    main_qty = sum(r["main"]["qty"] for r in main_rows)
    branch_qty = sum(r["branch"]["qty"] for r in branch_rows)

    values = []
    for r in rows:
        m, b = r["main"], r["branch"]
        values.append(
            "  ({code}, {name}, {pm}, {qm}, {pb}, {qb})".format(
                code=sql_text(r["code"]),
                name=sql_text(r["name"]),
                pm=fmt(m["price"]) if m else "null",
                qm=fmt(m["qty"]) if m else "null",
                pb=fmt(b["price"]) if b else "null",
                qb=fmt(b["qty"]) if b else "null",
            )
        )

    sql = f"""-- ============================================================================
-- استيراد المخزون الافتتاحي (اتولّد بـ scripts/import_opening_stock.py)
-- {len(rows)} منتج | {WAREHOUSE_NAMES[0]}: {len(main_rows)} صنف ({fmt(main_qty)} قطعة) | {WAREHOUSE_NAMES[1]}: {len(branch_rows)} صنف ({fmt(branch_qty)} قطعة)
--
-- شغّله مرة واحدة من Supabase > SQL Editor، على قاعدة فاضية (بعد تطبيق كل الـ migrations).
-- كله في transaction: لو أي حاجة اتخالفت (أعداد أو مجاميع) بيتلغي كله ومفيش حاجة بتتسجّل.
-- سعر الشراء = صفر لكل الأصناف (مش معروف لسه). الدفعات الافتتاحية معلّمة بالملاحظة:
--   '{OPENING_NOTE}'
-- عشان نصلّح تكلفتها بعدين بسكريبت إعادة التكلفة.
-- سعر البيع على المنتج = سعر {WAREHOUSE_NAMES[0]} (أو {WAREHOUSE_NAMES[1]} لو الصنف فيه بس).
-- سعر كل مخزن محفوظ على دفعاته (default_sale_price) وشاشة البيع بتقترحه.
-- ============================================================================

begin;

do $$
begin
  if exists (select 1 from public.products) or exists (select 1 from public.warehouses) then
    raise exception 'القاعدة فيها منتجات أو مخازن بالفعل. الملف ده للاستيراد الأول بس';
  end if;
end $$;

-- المخازن
create temp table _wh (code int, id uuid) on commit drop;
with w as (
  insert into public.warehouses (name, is_default)
  values ({sql_text(WAREHOUSE_NAMES[0])}, true), ({sql_text(WAREHOUSE_NAMES[1])}, false)
  returning id, name
)
insert into _wh select case name when {sql_text(WAREHOUSE_NAMES[0])} then 1 else 2 end, id from w;

-- البيانات المصدر (كود، اسم، سعر وكمية كل مخزن)
create temp table _imp (
  code text, name text,
  price_1 numeric, qty_1 numeric,
  price_2 numeric, qty_2 numeric
) on commit drop;

insert into _imp values
{(","+chr(10)).join(values)};

-- المنتجات
insert into public.products (part_number, name, base_unit, cost_price, sale_price)
select code, name, 'قطعة', 0, coalesce(price_1, price_2) from _imp;

-- الرصيد لكل مخزن
create temp table _stock on commit drop as
  select 1 as wcode, code, qty_1 as qty, price_1 as price from _imp where qty_1 is not null
  union all
  select 2, code, qty_2, price_2 from _imp where qty_2 is not null;

-- جرد افتتاحي لكل مخزن (بيعلّم الدفعات عشان تتصلّح تكلفتها بعدين)
create temp table _st (wcode int, id uuid) on commit drop;
with s as (
  insert into public.stocktakes (warehouse_id, notes)
  select id, {sql_text(OPENING_NOTE)} from _wh
  returning id, warehouse_id
)
insert into _st select (select code from _wh where _wh.id = s.warehouse_id), id from s;

insert into public.inventory (product_id, warehouse_id, quantity)
select p.id, w.id, s.qty
from _stock s
join public.products p on p.part_number = s.code
join _wh w on w.code = s.wcode;

insert into public.stocktake_items (stocktake_id, product_id, system_quantity, counted_quantity, difference)
select st.id, p.id, 0, s.qty, s.qty
from _stock s
join public.products p on p.part_number = s.code
join _st st on st.wcode = s.wcode;

insert into public.inventory_lots
  (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining, default_sale_price)
select p.id, w.id, 'stocktake', st.id, 0, s.qty, s.qty, s.price
from _stock s
join public.products p on p.part_number = s.code
join _wh w on w.code = s.wcode
join _st st on st.wcode = s.wcode;

insert into public.inventory_movements (product_id, warehouse_id, movement_type, quantity, reference_id)
select p.id, w.id, 'adjustment', s.qty, st.id
from _stock s
join public.products p on p.part_number = s.code
join _wh w on w.code = s.wcode
join _st st on st.wcode = s.wcode;

-- مطابقة نهائية: لو أي رقم مختلف عن الشيت، الـ transaction كلها بتتلغي
do $$
declare
  v_products int;
  v_inv_1 int; v_inv_2 int;
  v_qty_1 numeric; v_qty_2 numeric;
  v_lots int; v_mov int;
begin
  select count(*) into v_products from public.products;
  select count(*), coalesce(sum(quantity), 0) into v_inv_1, v_qty_1
    from public.inventory i join _wh w on w.id = i.warehouse_id and w.code = 1;
  select count(*), coalesce(sum(quantity), 0) into v_inv_2, v_qty_2
    from public.inventory i join _wh w on w.id = i.warehouse_id and w.code = 2;
  select count(*) into v_lots from public.inventory_lots where source_type = 'stocktake';
  select count(*) into v_mov from public.inventory_movements where movement_type = 'adjustment';

  if v_products <> {len(rows)}
     or v_inv_1 <> {len(main_rows)} or v_qty_1 <> {fmt(main_qty)}
     or v_inv_2 <> {len(branch_rows)} or v_qty_2 <> {fmt(branch_qty)}
     or v_lots <> {len(main_rows) + len(branch_rows)} or v_mov <> {len(main_rows) + len(branch_rows)} then
    raise exception 'المطابقة فشلت: منتجات %, مخزن1 % صنف / % قطعة, مخزن2 % صنف / % قطعة',
      v_products, v_inv_1, v_qty_1, v_inv_2, v_qty_2;
  end if;
end $$;

commit;

-- بعد التنفيذ: راجع الأعداد من واجهة النظام (صفحة المخازن والمنتجات).
"""
    out_path.write_text(sql, encoding="utf-8")


def write_review(rows, main_skipped, branch_skipped, similar, out_path: Path):
    wb = Workbook()
    head_fill = PatternFill("solid", fgColor="1F3A5F")

    def sheet(title, headers, data, widths):
        ws = wb.create_sheet(title)
        ws.sheet_view.rightToLeft = True
        ws.append(headers)
        for c in ws[1]:
            c.font = Font(name="Arial", bold=True, color="FFFFFF")
            c.fill = head_fill
            c.alignment = Alignment(horizontal="center", wrap_text=True)
        for d in data:
            ws.append(d)
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = w
        ws.freeze_panes = "A2"
        return ws

    wb.remove(wb.active)
    sheet("المنتجات", ["كود الصنف", "اسم المنتج", "الوحدة", "سعر الشراء", "سعر البيع", "في مخزن 1", "في مخزن 2"],
          [[r["code"], r["name"], "قطعة", 0,
            (r["main"] or r["branch"])["price"],
            "نعم" if r["main"] else "", "نعم" if r["branch"] else ""] for r in rows],
          [12, 44, 10, 12, 12, 11, 11])
    sheet("مخزن_1", ["كود الصنف", "اسم المنتج", "الكمية بالقطعة", "سعر البيع"],
          [[r["code"], r["name"], r["main"]["qty"], r["main"]["price"]] for r in rows if r["main"]],
          [12, 44, 14, 12])
    sheet("مخزن_2", ["كود الصنف", "اسم المنتج", "الكمية بالقطعة", "سعر البيع"],
          [[r["code"], r["name"], r["branch"]["qty"], r["branch"]["price"]] for r in rows if r["branch"]],
          [12, 44, 14, 12])
    both = [r for r in rows if r["main"] and r["branch"]]
    sheet("في_المخزنين", ["كود الصنف", "اسم المنتج", "كمية مخزن 1", "سعر مخزن 1", "كمية مخزن 2", "سعر مخزن 2", "السعر"],
          [[r["code"], r["name"], r["main"]["qty"], r["main"]["price"], r["branch"]["qty"], r["branch"]["price"],
            "" if r["main"]["price"] == r["branch"]["price"] else "مختلف"] for r in both],
          [12, 44, 12, 12, 12, 12, 10])
    sheet("صفوف_اتخطّت", ["الشيت", "رقم الصف", "المحتوى", "الكمية", "السعر"],
          [["مخزن 1", s["row"], s["name"], s["qty"], s["price"]] for s in main_skipped] +
          [["مخزن 2", s["row"], s["name"], s["qty"], s["price"]] for s in branch_skipped],
          [10, 10, 36, 12, 12])
    sheet("اسماء_متشابهة", ["اسم في مخزن 2", "أقرب اسم في مخزن 1"], similar, [44, 44])
    wb.save(out_path)


def find_similar(main_items, branch_items, merged_names):
    import difflib
    main_keys = {match_key(i["name"]): i["name"] for i in main_items}
    out = []
    for b in branch_items:
        k = match_key(b["name"])
        if k in main_keys or k in merged_names:
            continue
        close = difflib.get_close_matches(k, list(main_keys), n=2, cutoff=0.86)
        if close:
            out.append([b["name"], " | ".join(main_keys[c] for c in close)])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--main", required=True, help="شيت المخزن الأساسي (مخزن 1)")
    ap.add_argument("--branch", required=True, help="شيت المخزن الفرعي (مخزن 2)")
    ap.add_argument("--merge", help="ملف JSON لدمج أسماء مختلفة لنفس الصنف")
    ap.add_argument("--prices", help="ملف JSON لتوحيد سعر أصناف محددة في كل المخازن")
    ap.add_argument("--out", default="out", help="فولدر الإخراج (الافتراضي out)")
    args = ap.parse_args()

    merge_map = json.loads(Path(args.merge).read_text(encoding="utf-8")) if args.merge else {}

    main_items, main_skipped = read_sheet(args.main)
    branch_items, branch_skipped = read_sheet(args.branch)
    rows = build(main_items, branch_items, merge_map)
    if args.prices:
        apply_price_overrides(rows, json.loads(Path(args.prices).read_text(encoding="utf-8")))
    similar = find_similar(main_items, branch_items, {match_key(k) for k in merge_map})

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_sql(rows, out / "opening-stock.sql")
    write_review(rows, main_skipped, branch_skipped, similar, out / "import-review.xlsx")

    both = sum(1 for r in rows if r["main"] and r["branch"])
    print(f"منتجات: {len(rows)} (مخزن 1: {len(main_items)} | مخزن 2: {len(branch_items)} | في الاتنين: {both})")
    print(f"صفوف اتخطّت: مخزن 1 = {len(main_skipped)} | مخزن 2 = {len(branch_skipped)}")
    print(f"أسماء متشابهة محتاجة قرار: {len(similar)}")
    print(f"الملفات في: {out.resolve()}")


if __name__ == "__main__":
    sys.exit(main())
