"""
أدوات مشتركة لاختبارات قاعدة البيانات (Postgres مؤقت، مفيش اتصال ببياناتك).
بيستخدمها db_full_flows.py. (db_scenarios.py مستقل وليه أدواته الخاصة.)
"""
import os
import pathlib
import subprocess
import sys
import tempfile

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    import pgserver
except ImportError:
    sys.exit("محتاج تثبيت الأداة بالأمر: python -m pip install pgserver")

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "migrations"
# SKIP_MIGRATIONS="ملف1,ملف2": بيستبعد migrations من التشغيل (لتجربة إن الاختبارات فعلًا بتلقط الأخطاء القديمة)
_skip = {s for s in os.environ.get("SKIP_MIGRATIONS", "").split(",") if s}
ALL_MIGRATIONS = ["00000000000000_baseline.sql"] + sorted(f.name for f in MIGRATIONS.glob("2*.sql") if f.name not in _skip)

USER = "11111111-1111-1111-1111-111111111111"
USER2 = "11111111-1111-1111-1111-222222222222"      # مستخدم موقوف (is_active = false)
W1 = "22222222-2222-2222-2222-222222222222"
W2 = "22222222-2222-2222-2222-333333333333"
P1 = "33333333-3333-3333-3333-333333333333"        # قطعة + كرتونة (6)
P2 = "55555555-5555-5555-5555-555555555555"        # قطعة فقط
C1 = "44444444-4444-4444-4444-444444444444"
C2 = "44444444-4444-4444-4444-555555555555"

STUBS = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
"""

SEED = f"""
insert into auth.users(id, email) values ('{USER}', 'u@warehouse.local'), ('{USER2}', 'u2@warehouse.local');
insert into public.users(id, full_name, username, role, is_active) values
  ('{USER}', 'Owner', 'owner1', 'owner', true),
  ('{USER2}', 'Disabled', 'disabled1', 'owner', false);
insert into public.company_settings(id) values (true);
insert into public.warehouses(id, name, is_default) values ('{W1}', 'Main', true), ('{W2}', 'Branch', false);
insert into public.products(id, part_number, name, base_unit) values
  ('{P1}', 'P-1', 'Brake pad', 'قطعة'), ('{P2}', 'P-2', 'Oil filter', 'قطعة');
insert into public.product_units(product_id, unit_name, conversion_factor) values ('{P1}', 'كرتونة', 6);
insert into public.customers(id, name) values ('{C1}', 'Ali'), ('{C2}', 'Sara');
"""

# دور authenticated + هوية المستخدم. DO بدل select عشان مايطبعش صف في الناتج.
def as_user_prefix(user=USER):
    return (f"set role authenticated;\n"
            f"do $$ begin perform set_config('request.jwt.claim.sub','{user}',false); end $$;\n")


class Db:
    def __init__(self, seed=True):
        self.srv = pgserver.get_server(tempfile.mkdtemp(), cleanup_mode="delete")
        bin_dir = pathlib.Path(pgserver.__file__).parent / "pginstall" / "bin"
        self.psql = next((p for p in (bin_dir / "psql.exe", bin_dir / "psql") if p.exists()), bin_dir / "psql")
        self.last_stdout = ""
        self.last_stderr = ""
        self.run(STUBS, strict=True)
        for f in ALL_MIGRATIONS:
            self.run((MIGRATIONS / f).read_text(encoding="utf-8"), strict=True)
        if seed:
            self.run(SEED, strict=True)

    def run(self, sql, strict=False):
        prefix = "\\set ON_ERROR_STOP on\n" if strict else ""
        p = subprocess.run(
            [str(self.psql), "-X", "-q", "-A", "-t", "-d", self.srv.get_uri(), "-f", "-"],
            input=prefix + sql, capture_output=True, text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "PGCLIENTENCODING": "UTF8"},
        )
        self.last_stdout = p.stdout.strip()
        self.last_stderr = p.stderr.strip()
        ok = p.returncode == 0 and "ERROR:" not in self.last_stderr
        if strict and not ok:
            sys.exit(f"فشل تنفيذ SQL:\n{(self.last_stdout + chr(10) + self.last_stderr)[:900]}")
        return ok

    def user(self, sql, user=USER):
        return self.run(as_user_prefix(user) + sql)

    @property
    def error(self):
        """رسالة آخر خطأ (من غير التفاصيل الإضافية)."""
        for line in self.last_stderr.splitlines():
            if "ERROR:" in line:
                return line.split("ERROR:", 1)[1].strip()
        return ""

    def rows(self, sql, as_user=False):
        self.user(sql) if as_user else self.run(sql)
        return [line.split("|") for line in self.last_stdout.splitlines() if line.strip()]

    def one(self, sql, as_user=False):
        r = self.rows(sql, as_user)
        return r[0][0] if r and r[0] else ""

    def num(self, sql, as_user=False):
        v = self.one(sql, as_user)
        return float(v) if v not in ("", None) else 0.0

    def rpc_id(self, sql):
        """بينفّذ دالة بترجع uuid كمستخدم مسجّل ويرجّع (نجحت؟، id)."""
        ok = self.user(sql)
        return ok, (self.last_stdout.splitlines()[-1].strip() if ok and self.last_stdout else "")


# ---------- مولّدات JSON للعناصر ----------
def order_items(*lines):
    """كل سطر: (product, unit, cf, qty, unit_cost, sale_price)"""
    parts = [f"jsonb_build_object('product_id','{p}','unit_name','{u}','conversion_factor',{cf},"
             f"'quantity',{q},'unit_cost',{c},'sale_price',{sp})" for (p, u, cf, q, c, sp) in lines]
    return "jsonb_build_array(" + ",".join(parts) + ")"

def sale_items(*lines):
    """كل سطر: (product, unit, cf, qty, unit_price)"""
    parts = [f"jsonb_build_object('product_id','{p}','unit_name','{u}','conversion_factor',{cf},"
             f"'quantity',{q},'unit_price',{pr})" for (p, u, cf, q, pr) in lines]
    return "jsonb_build_array(" + ",".join(parts) + ")"

def return_items(*lines):
    """كل سطر: (product, unit, cf, qty, [price_or_cost مزوّر اختياري])"""
    parts = []
    for ln in lines:
        p, u, cf, q = ln[:4]
        extra = f",'unit_price',{ln[4]},'unit_cost',{ln[4]}" if len(ln) > 4 else ""
        parts.append(f"jsonb_build_object('product_id','{p}','unit_name','{u}','conversion_factor',{cf},'quantity',{q}{extra})")
    return "jsonb_build_array(" + ",".join(parts) + ")"

def stocktake_items(*lines):
    parts = [f"jsonb_build_object('product_id','{p}','counted_quantity',{q})" for (p, q) in lines]
    return "jsonb_build_array(" + ",".join(parts) + ")"


# ---------- إطار الاختبار ----------
class Tester:
    def __init__(self):
        self.failures = 0
        self.total = 0

    def section(self, title):
        print(f"\n== {title} ==")

    def check(self, name, cond, detail=""):
        self.total += 1
        print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else f"   <-- {detail}"))
        if not cond:
            self.failures += 1
        return cond

    def approx(self, name, actual, expected, tol=0.01):
        return self.check(name, abs(actual - expected) <= tol, f"المتوقع {expected} والفعلي {actual}")

    def rejected(self, name, db, sql, contains=None):
        """الاختبار بينجح لو العملية اترفضت (ولو حددت contains: لسبب الرفض الصح بالظبط)."""
        ok = db.user(sql)
        msg = db.error
        passed = (not ok) and (contains is None or contains in msg)
        return self.check(name, passed, f"اترفضت={not ok} الرسالة='{msg[:100]}'" if not passed else "")


# ---------- فحوصات الاتساق الشامل ----------
CHECK_SQL = """
with inv as (select product_id, warehouse_id, quantity as q from public.inventory),
lots as (select product_id, warehouse_id, sum(quantity_remaining) as q from public.inventory_lots group by 1, 2),
mov as (select product_id, warehouse_id, sum(quantity) as q from public.inventory_movements group by 1, 2),
stock_bad as (
  select count(*) c from inv
  full join lots using (product_id, warehouse_id)
  full join mov using (product_id, warehouse_id)
  where abs(coalesce(inv.q,0) - coalesce(lots.q,0)) > 0.0001 or abs(coalesce(inv.q,0) - coalesce(mov.q,0)) > 0.0001
)
select
  (select c from stock_bad),
  (select count(*) from public.customers where balance < 0),
  (select count(*) from public.inventory where quantity < 0),
  (select count(*) from public.inventory_lots where quantity_remaining < 0 or quantity_remaining > quantity_received),
  (select count(*) from public.sales_invoices i
     where abs(i.total_amount - (select coalesce(sum(line_total),0) from public.sales_invoice_items where invoice_id = i.id) + i.discount_amount) > 0.01
        or i.paid_amount > i.total_amount + 0.0001 or i.total_amount < 0),
  (select count(*) from public.orders o
     where abs(o.total_cost - (select coalesce(sum(line_total),0) from public.order_items where order_id = o.id) + o.discount_amount) > 0.01),
  (select count(*) from public.sales_invoices
     where payment_status::text <> case when paid_amount >= total_amount then 'paid' when paid_amount > 0 then 'partial' else 'unpaid' end),
  (select coalesce(sum(amount),0) from public.treasury_transactions),
  (select coalesce(sum(quantity_remaining * unit_cost),0) from public.inventory_lots),
  (select coalesce(sum(balance),0) from public.customers),
  (select coalesce(sum(total_amount),0) from public.sales_invoices),
  (select coalesce(sum(actual_cost),0) from public.sales_invoice_items),
  (select coalesce(sum(total_amount),0) from public.sales_returns),
  (select coalesce(sum(quantity_received * unit_cost),0) from public.inventory_lots where source_type = 'return');
"""

def check_all(db, adjust=0.0):
    """
    بيرجّع قائمة بأي مخالفة. الاتساق المحاسبي:
      صافي الأصول (خزينة + قيمة المخزون + ديون العملاء)
        = ربح المبيعات (إيراد الفواتير - تكلفتها) - أثر المرتجعات (قيمتها - تكلفة اللي رجع) + تسويات الجرد
    لو أي دالة غلّطت في أي مبلغ هيبوظ المعادلة دي.
    """
    r = db.rows(CHECK_SQL)
    if not r:
        return ["الاستعلام ماجابش نتيجة: " + db.last_stderr[:200]]
    v = [float(x) for x in r[0]]
    names = ["المخزون ≠ الدفعات ≠ الحركات", "رصيد عميل سالب", "مخزون سالب", "دفعة خارج الحدود",
             "فاتورة إجماليها مش مطابق لأصنافها", "طلبية إجماليها مش مطابق لأصنافها", "حالة دفع الفاتورة غلط"]
    problems = [f"{names[i]} ({int(v[i])})" for i in range(7) if v[i] > 0]
    cash, inv_value, receivables, revenue, cogs, ret_rev, ret_cost = v[7:14]
    assets = cash + inv_value + receivables
    expected = (revenue - cogs) - (ret_rev - ret_cost) + adjust
    if abs(assets - expected) > 0.1:
        problems.append(f"صافي الأصول {assets:.2f} ≠ المتوقع {expected:.2f} (خزينة {cash:.2f} + مخزون {inv_value:.2f} + ديون {receivables:.2f})")
    return problems
