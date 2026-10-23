
#!/usr/bin/env python3
"""
اختبارات قاعدة البيانات: بتشغّل ملفات supabase/migrations على PostgreSQL مؤقت،
ومش بتتصل بقاعدة بيانات Supabase الحقيقية.

التشغيل:
    python -m pip install pgserver
    python supabase/tests/db_scenarios.py

بتطبع PASS/FAIL لكل حالة، وبترجع كود خروج 1 لو أي اختبار فشل.
"""

import os
import pathlib
import subprocess
import sys
import tempfile

# الطباعة بالعربي على ويندوز
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

try:
    import pgserver
except ImportError:
    sys.exit(
        "محتاج تثبيت الأداة بالأمر: "
        "python -m pip install pgserver"
    )

MIGRATIONS = pathlib.Path(__file__).resolve().parent.parent / "migrations"

USER = "11111111-1111-1111-1111-111111111111"

WH, PRODUCT, CUSTOMER = (
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444",
)

STUBS = """
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;

create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
);

create function auth.uid()
returns uuid
language sql stable
as $$
    select nullif(
        current_setting('request.jwt.claim.sub', true), ''
    )::uuid
$$;

grant usage on schema public, auth
to anon, authenticated, service_role;

alter default privileges in schema public
grant all on tables to anon, authenticated, service_role;

alter default privileges in schema public
grant execute on functions to anon, authenticated, service_role;
"""

SEED = f"""
insert into auth.users(id, email)
values ('{USER}', 'u@warehouse.local');

insert into public.users(id, full_name, username, role)
values ('{USER}', 'Owner', 'owner1', 'owner');

insert into public.company_settings(id) values (true);

insert into public.warehouses(id, name, is_default)
values ('{WH}', 'Main', true);

insert into public.products(id, part_number, name, base_unit)
values ('{PRODUCT}', 'P-1', 'Brake pad', 'قطعة');

insert into public.customers(id, name)
values ('{CUSTOMER}', 'Ali');
"""

AS_USER = (
    f"set role authenticated; "
    f"select set_config('request.jwt.claim.sub','{USER}',false);\n"
)


class Db:
    def __init__(self, files):
        self.srv = pgserver.get_server(
            tempfile.mkdtemp(),
            cleanup_mode="delete",
        )

        bin_dir = pathlib.Path(pgserver.__file__).parent / "pginstall" / "bin"

        self.psql = next(
            (
                p
                for p in (bin_dir / "psql.exe", bin_dir / "psql")
                if p.exists()
            ),
            bin_dir / "psql",
        )

        self.last_stdout = ""
        self.last_stderr = ""

        self.run(STUBS, strict=True)

        for filename in files:
            sql = (MIGRATIONS / filename).read_text(encoding="utf-8")
            self.run(sql, strict=True)

    def run(self, sql, strict=False):
        """ترجع (نجح؟، النص). في الوضع strict تتوقف عند أول خطأ."""
        prefix = "\\set ON_ERROR_STOP on\n" if strict else ""

        p = subprocess.run(
            [
                str(self.psql),
                "-X",
                "-A",
                "-t",
                "-d",
                self.srv.get_uri(),
                "-f",
                "-",
            ],
            input=prefix + sql,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={
                **os.environ,
                "PGCLIENTENCODING": "UTF8",
            },
        )

        # نفصل نتيجة SQL عن التحذيرات التي تظهر في stderr.
        self.last_stdout = p.stdout.strip()
        self.last_stderr = p.stderr.strip()

        output = "\n".join(
            part
            for part in (self.last_stdout, self.last_stderr)
            if part
        )

        ok = p.returncode == 0 and "ERROR:" not in output

        if strict and not ok:
            sys.exit(f"فشل تنفيذ SQL:\n{output[:800]}")

        return ok, output

    def as_user(self, sql):
        return self.run(AS_USER + sql)

    def value(self, sql):
        """تقرأ نتيجة SQL من stdout فقط، وتتجاهل تحذيرات stderr."""
        self.run(sql)

        if not self.last_stdout:
            return ""

        return self.last_stdout.splitlines()[-1].strip()


failures = 0


def check(name, cond, detail=""):
    global failures

    print(
        ("PASS  " if cond else "FAIL  ")
        + name
        + ("" if cond else f"   <-- {detail}")
    )

    failures += 0 if cond else 1


def order_items(qty, cost, cf=1):
    return (
        f"jsonb_build_array(jsonb_build_object("
        f"'product_id','{PRODUCT}',"
        f"'unit_name','قطعة',"
        f"'conversion_factor',{cf},"
        f"'quantity',{qty},"
        f"'unit_cost',{cost},"
        f"'sale_price',150))"
    )


def sale_items(qty, price, cf=1, unit="قطعة"):
    return (
        f"jsonb_build_array(jsonb_build_object("
        f"'product_id','{PRODUCT}',"
        f"'unit_name','{unit}',"
        f"'conversion_factor',{cf},"
        f"'quantity',{qty},"
        f"'unit_price',{price}))"
    )


ALL = (
    ["00000000000000_baseline.sql"]
    + sorted(f.name for f in MIGRATIONS.glob("2*.sql"))
)


# ---------------------------------------------------------------
# الأمان
print("== الأمان (anon بدون تسجيل دخول) ==")

before = Db(["00000000000000_baseline.sql"])

ok, _ = before.run("set role anon; select public.notify('fake');")

check(
    "[قبل التحصين] anon كان يقدر يكتب إشعار مزيف (الثغرة الأصلية)",
    ok,
)

db = Db(ALL)

security_tests = [
    ("notify", "select public.notify('x')"),
    ("log_activity", "select public.log_activity('x')"),
    (
        "cleanup_old_notifications",
        "select public.cleanup_old_notifications()",
    ),
    (
        "create_sale_invoice",
        f"select public.create_sale_invoice(null,'{WH}','[]'::jsonb,0,0)",
    ),
    ("قراءة products", "select * from public.products"),
    (
        "كتابة products",
        "insert into public.products(part_number,name,base_unit) "
        "values ('x','x','x')",
    ),
]

for label, sql in security_tests:
    ok, _ = db.run("set role anon; " + sql)
    check(f"[بعد التحصين] anon ممنوع: {label}", not ok)

ok, _ = db.run("set role authenticated; truncate public.products;")

check(
    "[بعد التحصين] authenticated ممنوع TRUNCATE",
    not ok,
)


# ---------------------------------------------------------------
# منطق الأعمال
print("== العمليات الأساسية (FIFO، الأرصدة، الإلغاء) ==")

db.run(SEED, strict=True)

db.as_user(
    f"select public.create_order('{WH}','o1',"
    f"{order_items(10, 100)},0);"
)

db.as_user(
    f"select public.create_order('{WH}','o2',"
    f"{order_items(10, 120)},0);"
)

check(
    "المخزون بعد طلبيتين = 20",
    db.value("select quantity from public.inventory").startswith("20"),
)

ok, _ = db.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(15, 200)},1000,0);"
)

check("بيع 15 قطعة مقبول", ok)

check(
    "التكلفة الفعلية FIFO = 10×100 + 5×120 = 1600",
    db.value(
        "select sum(actual_cost) from public.sales_invoice_items"
    ) == "1600.00",
)

check(
    "رصيد العميل = 3000 - 1000 = 2000",
    db.value("select balance from public.customers") == "2000.00",
)

check(
    "دفعات متبقية: صفر و5",
    db.value(
        "select string_agg(quantity_remaining::text, ',' "
        "order by created_at) from public.inventory_lots"
    ) == "0.0000,5.0000",
)

ok, _ = db.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(50, 200)},0,0);"
)

check("بيع كمية أكبر من المتاح مرفوض", not ok)

ok, _ = db.as_user(
    "select public.void_order(id) from public.orders "
    "where order_number like '%1';"
)

check("إلغاء طلبية اتباع منها مرفوض", not ok)

db.as_user(
    "select public.void_sale_invoice(id) from public.sales_invoices;"
)

check(
    "إلغاء الفاتورة بيرجّع المخزون والدفعات والرصيد",
    db.value(
        "select quantity from public.inventory"
    ).startswith("20")
    and db.value(
        "select balance from public.customers"
    ) == "0.00"
    and db.value(
        "select string_agg(quantity_remaining::text, ',' "
        "order by created_at) from public.inventory_lots"
    ) == "10.0000,10.0000",
)

before_n = int(
    db.value("select count(*) from public.notifications")
)

db.as_user(
    "insert into public.products(part_number,name,base_unit) "
    "values ('P-2','Filter','قطعة');"
)

check(
    "الـ trigger لسه بيعمل إشعار بعد سحب الصلاحيات",
    int(db.value("select count(*) from public.notifications")) > before_n,
)


# ---------------------------------------------------------------
# مدخلات غلط
print("== مدخلات غلط مباشرة على الدوال (لازم تترفض) ==")

bad = {
    "خصم أكبر من إجمالي الفاتورة": (
        f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
        f"{sale_items(2, 200)},0,5000);"
    ),
    "خصم سالب": (
        f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
        f"{sale_items(2, 200)},0,-50);"
    ),
    "معامل تحويل صفر في فاتورة": (
        f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
        f"{sale_items(2, 200, 0)},0,0);"
    ),
    "صنف سالب جنب صنف عادي (حقن مخزون)": (
        f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
        f"jsonb_build_array("
        f"jsonb_build_object('product_id','{PRODUCT}',"
        f"'unit_name','قطعة','conversion_factor',1,"
        f"'quantity',3,'unit_price',200),"
        f"jsonb_build_object('product_id','{PRODUCT}',"
        f"'unit_name','قطعة','conversion_factor',1,"
        f"'quantity',-2,'unit_price',200)),0,0);"
    ),
    "مدفوع أكبر من الإجمالي": (
        f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
        f"{sale_items(1, 200)},999,0);"
    ),
    "طلبية بخصم أكبر من الإجمالي": (
        f"select public.create_order('{WH}','x',"
        f"{order_items(1, 100)},500);"
    ),
    "طلبية بتكلفة سالبة": (
        f"select public.create_order('{WH}','x',"
        f"{order_items(1, -100)},0);"
    ),
    "جرد بكمية سالبة": (
        f"select public.apply_stocktake('{WH}','t',"
        f"jsonb_build_array(jsonb_build_object("
        f"'product_id','{PRODUCT}',"
        f"'counted_quantity',-3)));"
    ),
}

stock_before = db.value("select quantity from public.inventory")

for name, sql in bad.items():
    ok, _ = db.as_user(sql)
    check(f"مرفوض: {name}", not ok)

check(
    "المخزون محدش لمسه بعد كل المحاولات الغلط",
    db.value("select quantity from public.inventory") == stock_before,
)

ok, _ = db.run(
    f"insert into public.product_units"
    f"(product_id,unit_name,conversion_factor) "
    f"values ('{PRODUCT}','x',0);"
)

check("مرفوض: وحدة قياس بمعامل تحويل صفر", not ok)


# ---------------------------------------------------------------
# حالات سليمة
print("== حالات سليمة لسه شغالة بعد التحقق الجديد ==")

ok, _ = db.as_user(
    f"select public.apply_stocktake('{WH}','t',"
    f"jsonb_build_array(jsonb_build_object("
    f"'product_id','{PRODUCT}','counted_quantity',12)));"
)

check(
    "جرد سليم",
    ok and db.value(
        "select quantity from public.inventory"
    ).startswith("12"),
)

db.run(
    f"insert into public.product_units"
    f"(product_id,unit_name,conversion_factor) "
    f"values ('{PRODUCT}','كرتونة',6);"
)

ok, _ = db.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(1, 500, 6, 'كرتونة')},500,0);"
)

check(
    "بيع بالكرتونة (1 كرتونة = 6 قطع) والمخزون بيتخصم 6",
    ok and db.value(
        "select quantity from public.inventory"
    ).startswith("6"),
)

ok, _ = db.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(1, 100)},0,100);"
)

check(
    "خصم يساوي الإجمالي بالظبط مقبول (فاتورة مجانية مقصودة)",
    ok,
)


# ---------------------------------------------------------------
# المرتجعات والدفعات
print("== المرتجعات والدفعات (مع القيود الجديدة) ==")

db2 = Db(ALL)
db2.run(SEED, strict=True)

db2.as_user(
    f"select public.create_order('{WH}','o',"
    f"{order_items(10, 100)},0);"
)

db2.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(4, 200)},0,0);"
)

check(
    "بعد بيع 4 بدون دفع: رصيد العميل 800 والمخزون 6",
    db2.value("select balance from public.customers") == "800.00"
    and db2.value(
        "select quantity from public.inventory"
    ).startswith("6"),
)

ret_items = (
    f"jsonb_build_array(jsonb_build_object("
    f"'product_id','{PRODUCT}','unit_name','قطعة',"
    f"'conversion_factor',1,'quantity',1,'unit_price',200))"
)

ok, msg = db2.as_user(
    f"select public.create_sales_return("
    f"(select id from public.sales_invoices),"
    f"{ret_items},'مرتجع');"
)

check("مرتجع بيع 1 قطعة مقبول", ok, msg[-200:])

check(
    "بعد المرتجع: رصيد العميل 600 والمخزون 7",
    db2.value("select balance from public.customers") == "600.00"
    and db2.value(
        "select quantity from public.inventory"
    ).startswith("7"),
)

ok, msg = db2.as_user(
    "select public.record_payment("
    "'customer',(select id from public.customers),"
    "'in',100,'دفعة');"
)

check(
    "تحصيل 100 من العميل مقبول والرصيد يبقى 500",
    ok and db2.value(
        "select balance from public.customers"
    ) == "500.00",
    msg[-200:],
)

ok, _ = db2.as_user(
    "select public.record_payment("
    "'customer',(select id from public.customers),"
    "'in',-5,'x');"
)

check("تحصيل بمبلغ سالب مرفوض", not ok)

oret = (
    f"jsonb_build_array(jsonb_build_object("
    f"'product_id','{PRODUCT}','unit_name','قطعة',"
    f"'conversion_factor',1,'quantity',2,'unit_cost',100))"
)

ok, msg = db2.as_user(
    f"select public.create_order_return("
    f"(select id from public.orders),"
    f"{oret},'رجوع للمورد');"
)

check(
    "مرتجع طلبية 2 قطعة مقبول والمخزون يبقى 5",
    ok and db2.value(
        "select quantity from public.inventory"
    ).startswith("5"),
    msg[-200:],
)

too_many_return_items = ret_items.replace(
    "'quantity',1",
    "'quantity',99",
)

ok, _ = db2.as_user(
    f"select public.create_sales_return("
    f"(select id from public.sales_invoices),"
    f"{too_many_return_items},'x');"
)

check("مرتجع بيع أكبر من المباع مرفوض", not ok)


# ---------------------------------------------------------------
# إصلاحات فحص 2026-10-15: الخصم، النقدي، المرتجعات، الترقيم، الدفعات
print("== إصلاحات منطق الحسابات (migration 20261015000001) ==")


def ret_item(qty, unit="قطعة"):
    return (
        f"jsonb_build_array(jsonb_build_object("
        f"'product_id','{PRODUCT}','unit_name','{unit}',"
        f"'quantity',{qty}))"
    )


db3 = Db(ALL)
db3.run(SEED, strict=True)

db3.as_user(
    f"select public.create_order('{WH}','o',{order_items(30, 100)},0);"
)

# 1) عميل نقدي
ok, _ = db3.as_user(
    f"select public.create_sale_invoice(null,'{WH}',"
    f"{sale_items(1, 100)},50,0);"
)
check("بيع نقدي بدفع جزئي مرفوض (الدين كان بيضيع)", not ok)

ok, _ = db3.as_user(
    f"select public.create_sale_invoice(null,'{WH}',"
    f"{sale_items(2, 200)},400,0);"
)
check("بيع نقدي مدفوع بالكامل مقبول", ok)

# 2) مرتجع فاتورة عليها خصم ومفيهاش دفع: العميل يتخصم له الصافي بعد الخصم بس
db3.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(4, 250)},0,100);"
)
check(
    "فاتورة 1000 بخصم 100: رصيد العميل 900",
    db3.value("select balance from public.customers") == "900.00",
)

ok, msg = db3.as_user(
    f"select public.create_sales_return("
    f"(select id from public.sales_invoices where customer_id is not null),"
    f"{ret_item(4)},'x');"
)
check("مرتجع الفاتورة كلها مقبول", ok, msg[-200:])
check(
    "المرتجع بالصافي بعد الخصم (900 مش 1000) والرصيد يرجع صفر",
    db3.value("select total_amount from public.sales_returns") == "900.00"
    and db3.value("select balance from public.customers") == "0.00"
    and db3.value("select cash_refund from public.sales_returns") == "0.00",
)

# 3) مرتجع فاتورة مدفوعة بالكامل: استرداد نقدي من الخزنة بدل رصيد دائن
db3.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(1, 200)},200,0);"
)
db3.as_user(
    f"select public.create_sales_return("
    f"(select id from public.sales_invoices "
    f"where total_amount = 200 and customer_id is not null),"
    f"{ret_item(1)},'x');"
)
check(
    "مرتجع فاتورة مدفوعة: استرداد نقدي 200 والرصيد يفضل صفر",
    db3.value(
        "select cash_refund from public.sales_returns "
        "where total_amount = 200"
    ) == "200.00"
    and db3.value("select balance from public.customers") == "0.00"
    and db3.value(
        "select count(*) from public.treasury_transactions "
        "where type = 'sale_in' and amount = -200"
    ) == "1",
)

# 4) مدخلات غلط في المرتجع
inv_id = "(select id from public.sales_invoices where total_amount = 200 and customer_id is not null)"
for label, sql in {
    "كمية سالبة في مرتجع بيع": (
        f"select public.create_sales_return({inv_id},{ret_item(-1)},'x');"
    ),
    "وحدة مش موجودة في الفاتورة": (
        f"select public.create_sales_return({inv_id},{ret_item(1, 'كرتونة')},'x');"
    ),
    "كمية سالبة في مرتجع طلبية": (
        f"select public.create_order_return("
        f"(select id from public.orders),{ret_item(-1)},'x');"
    ),
}.items():
    ok, _ = db3.as_user(sql)
    check(f"مرفوض: {label}", not ok)

# 5) إلغاء فاتورة عليها مرتجع مرفوض برسالة واضحة، وإلغاء سليم بيسجّل لقطة
ok, msg = db3.as_user(f"select public.void_sale_invoice({inv_id});")
check("إلغاء فاتورة عليها مرتجع مرفوض", not ok and "مرتجعات" in msg, msg[-200:])

db3.as_user(
    "select public.void_sale_invoice(id) from public.sales_invoices "
    "where customer_id is null;"
)
check(
    "الإلغاء بيسجّل لقطة في cancelled_documents",
    db3.value("select count(*) from public.cancelled_documents") == "1",
)

# 6) ترقيم الفواتير
ok, _ = db3.as_user("select public.set_invoice_numbering(1, null);")
check("ترقيم أقل من آخر فاتورة موجودة مرفوض", not ok)

ok, _ = db3.as_user("select public.set_invoice_numbering(0, null);")
check("ترقيم صفر مرفوض", not ok)

db3.run("update public.company_settings set next_sales_invoice_number = 1;")
ok, msg = db3.as_user(
    f"select public.create_sale_invoice(null,'{WH}',"
    f"{sale_items(1, 100)},100,0);"
)
check(
    "لو العداد اتلخبط البيع بيتخطى الأرقام المستخدمة بدل ما يقف",
    ok and db3.value(
        "select count(*) = count(distinct invoice_number) "
        "from public.sales_invoices"
    ) == "t",
    msg[-200:],
)

# 7) الدفعات
ok, _ = db3.as_user(
    "select public.record_payment('customer',"
    "'99999999-9999-9999-9999-999999999999','in',10,'x');"
)
check("دفعة لعميل مش موجود مرفوضة", not ok)

ok, _ = db3.as_user(
    "select public.record_payment('supplier',"
    "(select id from public.customers),'in',10,'x');"
)
check("دفعة لمورد مرفوضة (الموردين اتشالوا)", not ok)

ok, _ = db3.as_user(
    "select public.record_payment('customer',"
    "(select id from public.customers),'out',50,'استرداد');"
)
check(
    "صرف لعميل مرفوض (مفيش أرصدة دائنة للعملاء)",
    not ok and db3.value("select balance from public.customers") == "0.00",
)

# 8) جرد
ok, _ = db3.as_user(
    f"select public.apply_stocktake('{WH}','t','[]'::jsonb);"
)
check("جرد بقائمة فاضية مرفوض", not ok)

# 9) متوسط التكلفة المرجّح في المرتجع
db4 = Db(ALL)
db4.run(SEED, strict=True)
db4.as_user(f"select public.create_order('{WH}','a',{order_items(10, 100)},0);")
db4.as_user(f"select public.create_order('{WH}','b',{order_items(2, 400)},0);")
db4.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',"
    f"{sale_items(11, 200)},2200,0);"
)
db4.as_user(
    f"select public.create_sales_return((select id from public.sales_invoices),"
    f"{ret_item(1)},'x');"
)
check(
    "تكلفة الدفعة المرتجعة مرجّحة: 1400÷11 = 127.2727 (مش المتوسط البسيط 250)",
    db4.value(
        "select unit_cost from public.inventory_lots "
        "where source_type = 'return'"
    ) == "127.2727",
)

# 10) خصم الطلبية داخل تكلفة الدفعة
db4.as_user(f"select public.create_order('{WH}','c',{order_items(10, 100)},100);")
check(
    "خصم الطلبية موزّع على تكلفة الدفعة (900÷10 = 90)",
    db4.value(
        "select unit_cost from public.inventory_lots l "
        "join public.orders o on o.id = l.source_id "
        "where o.notes = 'c'"
    ) == "90.0000",
)


# ---------------------------------------------------------------
# فاتورة بيع من أكتر من مخزن (migration 20261018000001)
print("== فاتورة من أكتر من مخزن ==")

db5 = Db(ALL)
db5.run(SEED, strict=True)
db5.run("insert into public.warehouses (name) values ('الفرع');")
WH2 = db5.value("select id from public.warehouses where name = 'الفرع'")
db5.as_user(f"select public.create_order('{WH}','a',{order_items(10, 100)},0);")
db5.as_user(f"select public.create_order('{WH2}','b',{order_items(10, 100)},0);")


def wh_line(wh, qty, price=200):
    return (
        f"jsonb_build_object('product_id','{PRODUCT}','warehouse_id','{wh}',"
        f"'unit_name','قطعة','conversion_factor',1,"
        f"'quantity',{qty},'unit_price',{price})"
    )


def wh_qty(wh):
    return db5.value(
        f"select quantity from public.inventory "
        f"where warehouse_id = '{wh}' and product_id = '{PRODUCT}'"
    )


multi = f"jsonb_build_array({wh_line(WH, 4)},{wh_line(WH2, 3)})"

ok, msg = db5.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',{multi},1400,0);"
)
check("فاتورة فيها أصناف من مخزنين مقبولة", ok, msg[-200:])
check(
    "كل مخزن اتخصم منه كميته بس (6 و 7)",
    wh_qty(WH).startswith("6") and wh_qty(WH2).startswith("7"),
)
check(
    "أسطر الفاتورة مسجّل عليها مخزنين مختلفين",
    db5.value("select count(distinct warehouse_id) from public.sales_invoice_items") == "2",
)
check(
    "دفعات كل مخزن اتسحب منها بس",
    db5.value(
        "select count(*) from public.sale_item_lot_usage u "
        "join public.inventory_lots l on l.id = u.lot_id "
        f"where l.warehouse_id = '{WH2}'"
    ) == "1",
)

# الكمية الزيادة في مخزن واحد مرفوضة حتى لو المجموع الكلي كفاية
too_much = f"jsonb_build_array({wh_line(WH, 7)})"
ok, _ = db5.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',{too_much},0,0);"
)
check("بيع كمية أكبر من رصيد المخزن المحدد مرفوض (حتى لو المخزن التاني فيه)", not ok)

ok, _ = db5.as_user(
    "select public.create_sale_invoice(null,"
    f"'{WH}',jsonb_build_array({wh_line('99999999-9999-9999-9999-999999999999', 1)}),200,0);"
)
check("مخزن غير موجود على السطر مرفوض", not ok)

# سطر من غير warehouse_id بيتباع من مخزن الفاتورة (النداءات القديمة)
legacy = (
    f"jsonb_build_array(jsonb_build_object('product_id','{PRODUCT}','unit_name','قطعة',"
    f"'conversion_factor',1,'quantity',1,'unit_price',200))"
)
ok, msg = db5.as_user(
    f"select public.create_sale_invoice(null,'{WH2}',{legacy},200,0);"
)
check(
    "سطر من غير مخزن بيتباع من مخزن الفاتورة",
    ok and wh_qty(WH2).startswith("6"),
    msg[-200:],
)

# إلغاء الفاتورة بيرجّع كل صنف لمخزنه
ok, msg = db5.as_user(
    "select public.void_sale_invoice(id) from public.sales_invoices "
    "where total_amount = 1400;"
)
check(
    "إلغاء الفاتورة متعددة المخازن بيرجّع كل مخزن لكميته (10 و 9: الفرعي كان 6 بعد بيعة السطر القديم)",
    ok and wh_qty(WH).startswith("10") and wh_qty(WH2).startswith("9"),
    msg[-200:],
)

# مرتجع من فاتورة متعددة المخازن
db5.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',{multi},1400,0);"
)
inv_multi = "(select id from public.sales_invoices where total_amount = 1400)"


def ret_wh(qty, wh=None):
    extra = f",'warehouse_id','{wh}'" if wh else ""
    return (
        f"jsonb_build_array(jsonb_build_object('product_id','{PRODUCT}',"
        f"'unit_name','قطعة','quantity',{qty}{extra}))"
    )


ok, _ = db5.as_user(
    f"select public.create_sales_return({inv_multi},{ret_wh(1)},'x');"
)
check("مرتجع من غير تحديد المخزن مرفوض لو الصنف اتباع من مخزنين", not ok)

ok, _ = db5.as_user(
    f"select public.create_sales_return({inv_multi},{ret_wh(4, WH2)},'x');"
)
check("مرتجع أكبر من المباع من المخزن المحدد (3) مرفوض", not ok)

wh_before = (wh_qty(WH), wh_qty(WH2))
ok, msg = db5.as_user(
    f"select public.create_sales_return({inv_multi},{ret_wh(2, WH2)},'x');"
)
check(
    "مرتجع 2 للمخزن الفرعي بيرجع له هو بس",
    ok and wh_qty(WH) == wh_before[0] and wh_qty(WH2) != wh_before[1],
    msg[-200:],
)


# ---------------------------------------------------------------
# اسم العميل النقدي على الفاتورة (migration 20261022000001)
print("== اسم العميل النقدي ==")

named_line = (
    f"jsonb_build_array(jsonb_build_object('product_id','{PRODUCT}','unit_name','قطعة',"
    f"'conversion_factor',1,'quantity',1,'unit_price',200))"
)

ok, msg = db5.as_user(
    f"select public.create_sale_invoice(null,'{WH}',{named_line},200,0,'أحمد علي');"
)
check(
    "فاتورة نقدية بتحفظ اسم العميل",
    ok and db5.value(
        "select customer_name from public.sales_invoices "
        "where customer_name is not null and customer_id is null"
    ) == "أحمد علي",
    msg[-200:],
)

ok, _ = db5.as_user(
    f"select public.create_sale_invoice('{CUSTOMER}','{WH}',{named_line},200,0,'اسم مكتوب بالغلط');"
)
check(
    "لو فيه عميل مسجّل الاسم المكتوب بيتتجاهل",
    ok and db5.value(
        "select count(*) from public.sales_invoices "
        "where customer_id is not null and customer_name is not null"
    ) == "0",
)

ok, _ = db5.as_user(
    f"select public.create_sale_invoice(null,'{WH}',{named_line},200,0,repeat('ا',150));"
)
check(
    "الاسم الأطول من 120 حرف بيتقص",
    ok and db5.value(
        "select max(char_length(customer_name)) from public.sales_invoices"
    ) == "120",
)

ok, _ = db5.as_user(
    f"select public.create_sale_invoice(null,'{WH}',{named_line},200,0);"
)
check("النداء القديم من غير اسم لسه شغال", ok)


# ---------------------------------------------------------------
print()

print(
    "كل الاختبارات نجحت ✅"
    if failures == 0
    else f"{failures} اختبار فشل ❌"
)

sys.exit(1 if failures else 0)
