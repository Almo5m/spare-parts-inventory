#!/usr/bin/env python3
"""
اختبار شامل لكل عمليات النظام على Postgres مؤقت (مفيش اتصال ببياناتك).

كل عملية بتتجرّب بكل توابعها: الدفعات (FIFO)، المخزون، حركات المخزون، الخزينة، رصيد العميل، حالة
الفاتورة، الإشعارات وسجل العمليات، وبعدها فحص اتساق شامل:
  - المخزون = مجموع الدفعات = مجموع الحركات لكل صنف في كل مخزن
  - مفيش رصيد عميل سالب ولا مخزون سالب
  - إجمالي الفاتورة/الطلبية = مجموع أصنافها بعد الخصم
  - **معادلة محاسبية**: (الخزينة + قيمة المخزون + ديون العملاء) = (ربح المبيعات - أثر المرتجعات + تسويات الجرد)
    أي دالة تغلّط في أي مبلغ بتبوّظ المعادلة دي.
وفي الآخر اختبار عشوائي (بذرة ثابتة) بيجرّب مئات العمليات الصح والغلط ويفحص الاتساق بعد كل واحدة.

التشغيل:
    python -m pip install pgserver
    python supabase/tests/db_full_flows.py            # أو: npm run test:flows
    python supabase/tests/db_full_flows.py --fuzz 400 --seed 7   # عدد عمليات العشوائي (الافتراضي 150) وبذرة مختلفة
"""
import random
import sys

from helpers import (
    Db, Tester, check_all, order_items, sale_items, return_items, stocktake_items,
    USER, USER2, W1, W2, P1, P2, C1, C2,
)

T = Tester()
FUZZ_STEPS = 150
if "--fuzz" in sys.argv:
    FUZZ_STEPS = int(sys.argv[sys.argv.index("--fuzz") + 1])
FUZZ_SEED = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 20261014


# ============================== اختصارات ==============================
def order(db, lines, discount=0, wh=W1, notes="t"):
    return db.rpc_id(f"select public.create_order('{wh}','{notes}',{order_items(*lines)},{discount});")

def sale(db, cust, lines, paid, discount=0, wh=W1):
    c = f"'{cust}'" if cust else "null"
    return db.rpc_id(f"select public.create_sale_invoice({c},'{wh}',{sale_items(*lines)},{paid},{discount});")

def pay(db, cust, amount, kind="customer", direction="in"):
    return db.rpc_id(f"select public.record_payment('{kind}','{cust}','{direction}',{amount},'سداد');")

def sret(db, inv, lines):
    return db.rpc_id(f"select public.create_sales_return('{inv}',{return_items(*lines)},'مرتجع');")

def oret(db, ordr, lines):
    return db.rpc_id(f"select public.create_order_return('{ordr}',{return_items(*lines)},'مرتجع');")

def stock_take(db, wh, lines):
    return db.rpc_id(f"select public.apply_stocktake('{wh}','جرد',{stocktake_items(*lines)});")

def stock(db, p=P1, w=W1):
    return db.num(f"select coalesce((select quantity from public.inventory where product_id='{p}' and warehouse_id='{w}'),0)")

def cash(db):
    return db.num("select coalesce(sum(amount),0) from public.treasury_transactions")

def bal(db, c=C1):
    return db.num(f"select balance from public.customers where id='{c}'")

def count(db, table, where="true"):
    return int(db.num(f"select count(*) from public.{table} where {where}"))

def lot_remaining(db, source_id, p=P1):
    return db.num(f"select coalesce(sum(quantity_remaining),0) from public.inventory_lots where source_id='{source_id}' and product_id='{p}'")

def consistent(name, db, adjust=0.0):
    problems = check_all(db, adjust)
    T.check(f"اتساق شامل بعد: {name}", not problems, "; ".join(problems))


# ============================== أ) الطلبيات ==============================
T.section("أ) الطلبيات (create_order / void_order)")
db = Db()
notif0, act0 = count(db, "notifications"), count(db, "activity_log")
ok, o1 = order(db, [(P1, "قطعة", 1, 10, 100, 150)], notes="طلبية 1")
T.check("طلبية 1 اتسجّلت", ok, db.error)
T.check("ترقيم O-000001", db.one(f"select order_number from public.orders where id='{o1}'") == "O-000001")
T.approx("إجمالي الطلبية 1000", db.num(f"select total_cost from public.orders where id='{o1}'"), 1000)
T.check("حالة الطلبية received", db.one(f"select status from public.orders where id='{o1}'") == "received")
T.check("سطر واحد في order_items بتكلفة 100", count(db, "order_items", f"order_id='{o1}' and unit_cost=100 and line_total=1000") == 1)
lot = db.rows(f"select source_type, unit_cost, quantity_received, quantity_remaining from public.inventory_lots where source_id='{o1}'")
T.check("دفعة واحدة: order / تكلفة 100 / 10 / 10", len(lot) == 1 and lot[0][0] == "order" and float(lot[0][1]) == 100 and float(lot[0][2]) == 10 and float(lot[0][3]) == 10, str(lot))
T.approx("المخزون 10", stock(db), 10)
mv = db.rows(f"select movement_type, quantity from public.inventory_movements where reference_id='{o1}'")
T.check("حركة مخزون: purchase +10", len(mv) == 1 and mv[0][0] == "purchase" and float(mv[0][1]) == 10, str(mv))
T.approx("الخزينة -1000", cash(db), -1000)
T.check("قيد الخزينة من نوع purchase_out", count(db, "treasury_transactions", f"reference_id='{o1}' and type='purchase_out' and amount=-1000") == 1)
T.check("إشعار وسجل نشاط اتسجّلوا", count(db, "notifications") > notif0 and count(db, "activity_log") > act0)
consistent("طلبية 1", db)

ok, o2 = order(db, [(P1, "كرتونة", 6, 2, 600, 700), (P2, "قطعة", 1, 5, 50, 80)])
T.check("طلبية متعددة الأسطر ووحدات مختلفة", ok, db.error)
T.check("ترقيم O-000002", db.one(f"select order_number from public.orders where id='{o2}'") == "O-000002")
T.approx("إجمالي 2×600 + 5×50 = 1450", db.num(f"select total_cost from public.orders where id='{o2}'"), 1450)
T.approx("كرتونتين = 12 قطعة في المخزون (10 + 12)", stock(db), 22)
T.approx("تكلفة القطعة من الكرتونة = 600/6 = 100", db.num(f"select unit_cost from public.inventory_lots where source_id='{o2}' and product_id='{P1}'"), 100)
T.approx("مخزون P2 = 5", stock(db, P2), 5)
consistent("طلبية بكراتين", db)

ok, o3 = order(db, [(P2, "قطعة", 1, 10, 100, 130)], discount=100)
T.check("طلبية بخصم", ok, db.error)
T.approx("إجمالي بعد الخصم 900", db.num(f"select total_cost from public.orders where id='{o3}'"), 900)
T.approx("تكلفة الدفعة بعد الخصم = 90 مش 100", db.num(f"select unit_cost from public.inventory_lots where source_id='{o3}'"), 90)
T.approx("الخزينة -2350 - 900", cash(db), -3350)
T.approx("الخصم المسجّل 100", db.num(f"select discount_amount from public.orders where id='{o3}'"), 100)
consistent("طلبية بخصم (القيمة المخزنة = اللي اتدفع فعلًا)", db)

ok, o4 = order(db, [(P1, "قطعة", 99, 3, 10, 20)])
T.check("طلبية بمعامل تحويل مزوّر من الواجهة", ok, db.error)
T.approx("السيرفر تجاهل المعامل المزوّر: المخزون +3 مش +297", stock(db), 25)

T.section("أ-2) طلبيات مرفوضة (ومفيش أي أثر جانبي)")
state = (cash(db), count(db, "orders"), count(db, "inventory_lots"))
T.rejected("وحدة غير معرّفة", db, f"select public.create_order('{W1}','x',{order_items((P1,'علبة',1,1,10,10))},0);", "مش معرّفة")
T.rejected("طلبية بدون أصناف", db, f"select public.create_order('{W1}','x','[]'::jsonb,0);", "بدون أصناف")
T.rejected("كمية صفر", db, f"select public.create_order('{W1}','x',{order_items((P1,'قطعة',1,0,10,10))},0);", "بيانات الأصناف غير صحيحة")
T.rejected("تكلفة سالبة", db, f"select public.create_order('{W1}','x',{order_items((P1,'قطعة',1,1,-5,10))},0);", "بيانات الأصناف غير صحيحة")
T.rejected("خصم أكبر من الإجمالي", db, f"select public.create_order('{W1}','x',{order_items((P1,'قطعة',1,1,10,10))},50);", "الخصم")
T.rejected("خصم سالب", db, f"select public.create_order('{W1}','x',{order_items((P1,'قطعة',1,1,10,10))},-1);")
T.rejected("صنف مش موجود", db, f"select public.create_order('{W1}','x',{order_items(('99999999-9999-9999-9999-999999999999','قطعة',1,1,10,10))},0);", "الصنف غير موجود")
T.rejected("مخزن مش موجود", db, f"select public.create_order('99999999-9999-9999-9999-999999999999','x',{order_items((P1,'قطعة',1,1,10,10))},0);")
T.check("لا خزينة ولا طلبيات ولا دفعات اتغيّروا", state == (cash(db), count(db, "orders"), count(db, "inventory_lots")))
ok, o5 = order(db, [(P1, "قطعة", 1, 1, 10, 10)])
T.check("الترقيم لسه متسلسل بعد الرفض (O-000005، مفيش رقم ضايع)", ok and db.one(f"select order_number from public.orders where id='{o5}'") == "O-000005", db.one(f"select order_number from public.orders where id='{o5}'"))

T.section("أ-3) إلغاء الطلبية")
cash_before, p2_before = cash(db), stock(db, P2)
ok = db.user(f"select public.void_order('{o3}');")
T.check("إلغاء طلبية 3 (ما اتباعش منها)", ok, db.error)
T.approx("الفلوس رجعت للخزينة (+900)", cash(db) - cash_before, 900)
T.approx("مخزون P2 رجع 15 → 5", stock(db, P2), p2_before - 10)
T.check("الطلبية وأصنافها ودفعتها اتمسحوا", count(db, "orders", f"id='{o3}'") == 0 and count(db, "order_items", f"order_id='{o3}'") == 0 and count(db, "inventory_lots", f"source_id='{o3}'") == 0)
T.check("حركة إلغاء -10 اتسجّلت", db.num(f"select coalesce(sum(quantity),0) from public.inventory_movements where reference_id='{o3}' and movement_type='adjustment'") == -10)
consistent("إلغاء طلبية", db)

ok, s_ = sale(db, None, [(P2, "قطعة", 1, 2, 120)], 240)
T.check("بيع جزء من دفعة طلبية 2", ok, db.error)
T.rejected("إلغاء طلبية اتباع منها ممنوع", db, f"select public.void_order('{o2}');", "تم بيعه")
T.approx("المخزون ماتغيّرش بعد الرفض", stock(db, P2), 3)

ok, _ = oret(db, o1, [(P1, "قطعة", 1, 1)])
T.check("مرتجع قطعة من طلبية 1", ok, db.error)
T.rejected("إلغاء طلبية عليها مرتجعات ممنوع برسالة واضحة", db, f"select public.void_order('{o1}');", "مرتجعات")
consistent("بعد المرتجع والإلغاء المرفوض", db)

T.rejected("إلغاء طلبية مش موجودة", db, "select public.void_order('99999999-9999-9999-9999-999999999999');", "غير موجودة")


# ============================== ب) فواتير البيع ==============================
T.section("ب) فواتير البيع (create_sale_invoice / void_sale_invoice)")
db = Db()
_, bo1 = order(db, [(P1, "قطعة", 1, 10, 100, 0)])
_, bo2 = order(db, [(P1, "قطعة", 1, 10, 120, 0)])
_, bo3 = order(db, [(P1, "قطعة", 1, 5, 130, 0)], wh=W2)
_, bo4 = order(db, [(P2, "قطعة", 1, 20, 50, 0)])
cash0 = cash(db)

n0, a0 = count(db, "notifications"), count(db, "activity_log")
ok, i1 = sale(db, None, [(P1, "قطعة", 1, 3, 200)], 600)
T.check("بيع نقدي (من غير عميل) مدفوع كامل", ok, db.error)
T.check("ترقيم S-000001", db.one(f"select invoice_number from public.sales_invoices where id='{i1}'") == "S-000001")
inv = db.rows(f"select total_amount, paid_amount, discount_amount, payment_status, customer_id from public.sales_invoices where id='{i1}'")[0]
T.check("إجمالي 600 / مدفوع 600 / paid / من غير عميل", float(inv[0]) == 600 and float(inv[1]) == 600 and inv[3] == "paid" and inv[4] == "", str(inv))
T.approx("تكلفة FIFO = 3 × 100 = 300", db.num(f"select actual_cost from public.sales_invoice_items where invoice_id='{i1}'"), 300)
T.approx("الخزينة +600", cash(db) - cash0, 600)
T.check("قيد خزينة sale_in +600", count(db, "treasury_transactions", f"reference_id='{i1}' and type='sale_in' and amount=600") == 1)
T.approx("دفعة الطلبية 1 فضل منها 7", lot_remaining(db, bo1), 7)
T.check("سجل استهلاك الدفعة (usage) صف واحد", count(db, "sale_item_lot_usage", f"sale_invoice_item_id in (select id from public.sales_invoice_items where invoice_id='{i1}')") == 1)
T.approx("المخزون 20 - 3 = 17", stock(db), 17)
T.check("إشعار وسجل نشاط", count(db, "notifications") > n0 and count(db, "activity_log") > a0)
consistent("بيع نقدي", db)

T.rejected("بيع من غير عميل بدفع جزئي", db, f"select public.create_sale_invoice(null,'{W1}',{sale_items((P1,'قطعة',1,1,200))},100,0);", "لعميل نقدي")
T.rejected("بيع من غير عميل بدون دفع", db, f"select public.create_sale_invoice(null,'{W1}',{sale_items((P1,'قطعة',1,1,200))},0,0);", "لعميل نقدي")

ok, i2 = sale(db, C1, [(P1, "قطعة", 1, 9, 200)], 500)
T.check("بيع آجل جزئي لعميل (يعدّي على دفعتين)", ok, db.error)
T.check("ترقيم S-000002 (الرفض ماضيّعش رقم)", db.one(f"select invoice_number from public.sales_invoices where id='{i2}'") == "S-000002")
T.approx("رصيد العميل = 1800 - 500", bal(db, C1), 1300)
T.check("حالة partial", db.one(f"select payment_status from public.sales_invoices where id='{i2}'") == "partial")
T.approx("التكلفة FIFO: 7×100 + 2×120 = 940", db.num(f"select actual_cost from public.sales_invoice_items where invoice_id='{i2}'"), 940)
T.check("سجلين استهلاك (دفعتين)", count(db, "sale_item_lot_usage", f"sale_invoice_item_id in (select id from public.sales_invoice_items where invoice_id='{i2}')") == 2)
T.approx("دفعة 1 خلصت", lot_remaining(db, bo1), 0)
T.approx("دفعة 2 فضل منها 8", lot_remaining(db, bo2), 8)
T.approx("الخزينة زادت 500 بس", cash(db) - cash0, 1100)
consistent("بيع آجل جزئي", db)

ok, i3 = sale(db, C2, [(P1, "قطعة", 1, 2, 200)], 0)
T.check("بيع آجل بالكامل", ok, db.error)
T.check("حالة unpaid", db.one(f"select payment_status from public.sales_invoices where id='{i3}'") == "unpaid")
T.approx("رصيد العميل 2 = 400", bal(db, C2), 400)
T.approx("الخزينة ماتغيّرتش", cash(db) - cash0, 1100)
T.approx("التكلفة 2 × 120", db.num(f"select actual_cost from public.sales_invoice_items where invoice_id='{i3}'"), 240)

ok, i4 = sale(db, C1, [(P1, "قطعة", 1, 4, 250)], 900, discount=100)
T.check("بيع بخصم", ok, db.error)
T.approx("الإجمالي 1000 - 100 = 900", db.num(f"select total_amount from public.sales_invoices where id='{i4}'"), 900)
T.approx("الخصم 100", db.num(f"select discount_amount from public.sales_invoices where id='{i4}'"), 100)
T.check("مدفوعة بالكامل", db.one(f"select payment_status from public.sales_invoices where id='{i4}'") == "paid")
T.approx("رصيد العميل 1 ماتغيّرش (1300)", bal(db, C1), 1300)
consistent("بيع بخصم", db)

_, bo5 = order(db, [(P1, "قطعة", 1, 10, 140, 0)])
ok, i5 = sale(db, None, [(P1, "كرتونة", 6, 1, 1200)], 1200)
T.check("بيع كرتونة (1 = 6 قطع)", ok, db.error)
T.approx("المخزون نزل 6 قطع (12 → 6)", stock(db), 6)
T.approx("التكلفة 2×120 + 4×140 = 800", db.num(f"select actual_cost from public.sales_invoice_items where invoice_id='{i5}'"), 800)
T.approx("سعر الكرتونة محفوظ كما هو (1200)", db.num(f"select unit_price from public.sales_invoice_items where invoice_id='{i5}'"), 1200)
consistent("بيع كرتونة", db)

ok, i6 = sale(db, None, [(P1, "قطعة", 999, 1, 100)], 100)
T.check("معامل تحويل مزوّر في البيع", ok, db.error)
T.approx("اتخصمت قطعة واحدة بس مش 999", db.num(f"select coalesce(sum(quantity),0) from public.sale_item_lot_usage where sale_invoice_item_id in (select id from public.sales_invoice_items where invoice_id='{i6}')"), 1)

T.section("ب-2) بيع مرفوض (ومفيش أثر جانبي)")
state = (cash(db), count(db, "sales_invoices"), stock(db), bal(db, C1))
T.rejected("كمية أكبر من المتاح", db, f"select public.create_sale_invoice('{C1}','{W1}',{sale_items((P1,'قطعة',1,1000,100))},0,0);")
T.rejected("صنف مفيش منه في المخزن ده", db, f"select public.create_sale_invoice('{C1}','{W2}',{sale_items((P2,'قطعة',1,1,100))},0,0);")
T.rejected("مدفوع أكبر من الإجمالي", db, f"select public.create_sale_invoice('{C1}','{W1}',{sale_items((P1,'قطعة',1,1,100))},500,0);", "المبلغ المدفوع")
T.rejected("خصم أكبر من الإجمالي", db, f"select public.create_sale_invoice('{C1}','{W1}',{sale_items((P1,'قطعة',1,1,100))},0,500);", "الخصم")
T.rejected("بدون أصناف", db, f"select public.create_sale_invoice('{C1}','{W1}','[]'::jsonb,0,0);", "بدون أصناف")
T.rejected("وحدة غير معرّفة", db, f"select public.create_sale_invoice('{C1}','{W1}',{sale_items((P1,'علبة',1,1,100))},0,0);", "مش معرّفة")
T.rejected("عميل مش موجود", db, f"select public.create_sale_invoice('99999999-9999-9999-9999-999999999999','{W1}',{sale_items((P1,'قطعة',1,1,100))},0,0);")
T.check("الخزينة والفواتير والمخزون والرصيد ماتغيّروش", state == (cash(db), count(db, "sales_invoices"), stock(db), bal(db, C1)))
consistent("بيع مرفوض", db)

T.section("ب-3) إلغاء فاتورة البيع")
cash_b, stock_b = cash(db), stock(db)
ok = db.user(f"select public.void_sale_invoice('{i3}');")
T.check("إلغاء فاتورة آجلة غير مدفوعة", ok, db.error)
T.approx("رصيد العميل 2 رجع 0", bal(db, C2), 0)
T.approx("الخزينة ماتغيّرتش (ماكانش مدفوع)", cash(db), cash_b)
T.approx("المخزون رجع +2", stock(db), stock_b + 2)
T.check("الفاتورة وأصنافها وسجل الاستهلاك اتمسحوا", count(db, "sales_invoices", f"id='{i3}'") == 0 and count(db, "sale_item_lot_usage", f"sale_invoice_item_id not in (select id from public.sales_invoice_items)") == 0)
consistent("إلغاء فاتورة غير مدفوعة", db)

cash_b = cash(db)
ok = db.user(f"select public.void_sale_invoice('{i2}');")
T.check("إلغاء فاتورة مدفوعة جزئيًا", ok, db.error)
T.approx("رصيد العميل 1 رجع 0 (الدين اتشال)", bal(db, C1), 0)
T.approx("الـ 500 اللي اتدفعوا اتردّوا من الخزينة", cash(db) - cash_b, -500)
consistent("إلغاء فاتورة مدفوعة جزئيًا", db)

_, i7 = sale(db, C2, [(P2, "قطعة", 1, 5, 200)], 0)
T.approx("دين جديد 1000", bal(db, C2), 1000)
ok, _ = pay(db, C2, 1000)
T.check("العميل سدّد الدين بالكامل بعد الفاتورة", ok, db.error)
cash_b = cash(db)
ok = db.user(f"select public.void_sale_invoice('{i7}');")
T.check("إلغاء فاتورة العميل سدّد دينها بعد كده", ok, db.error)
T.approx("الرصيد صفر (مش سالب)", bal(db, C2), 0)
T.approx("الـ 1000 اللي سدّدها اتردّوا له من الخزينة", cash(db) - cash_b, -1000)
consistent("إلغاء فاتورة بعد سداد الدين", db)

_, i8 = sale(db, C1, [(P2, "قطعة", 1, 4, 200)], 0)
ok, _ = sret(db, i8, [(P2, "قطعة", 1, 1)])
T.check("مرتجع جزء من فاتورة", ok, db.error)
T.rejected("إلغاء فاتورة عليها مرتجعات برسالة واضحة", db, f"select public.void_sale_invoice('{i8}');", "مرتجعات")
T.rejected("إلغاء فاتورة مش موجودة", db, "select public.void_sale_invoice('99999999-9999-9999-9999-999999999999');", "غير موجودة")
consistent("بعد كل الإلغاءات", db)


# ============================== ج) التحصيل من العملاء ==============================
T.section("ج) التحصيل من العملاء (record_payment)")
db = Db()
order(db, [(P1, "قطعة", 1, 20, 100, 0)])
_, ci = sale(db, C1, [(P1, "قطعة", 1, 5, 200)], 0)
T.approx("دين 1000", bal(db, C1), 1000)
cash_b = cash(db)
ok, p1 = pay(db, C1, 400)
T.check("تحصيل 400", ok, db.error)
T.approx("الرصيد 600", bal(db, C1), 600)
pr = db.rows(f"select party_type, direction, amount from public.payments where id='{p1}'")
T.check("سجل الدفعة: customer / in / 400", pr and pr[0][0] == "customer" and pr[0][1] == "in" and float(pr[0][2]) == 400, str(pr))
T.check("قيد الخزينة payment_in +400", count(db, "treasury_transactions", f"reference_id='{p1}' and type='payment_in' and amount=400") == 1)
T.approx("الخزينة +400", cash(db) - cash_b, 400)
consistent("تحصيل جزئي", db)

ok, _ = pay(db, C1, 600)
T.check("تحصيل الباقي بالظبط", ok, db.error)
T.approx("الرصيد صفر", bal(db, C1), 0)
consistent("تحصيل كامل", db)

n_pay, cash_b = count(db, "payments"), cash(db)
T.rejected("تحصيل من عميل مفيهوش دين", db, f"select public.record_payment('customer','{C1}','in',10,'x');", "مفيهوش مديونية")
sale(db, C2, [(P1, "قطعة", 1, 1, 300)], 0)
T.rejected("تحصيل أكبر من الدين (301 على 300)", db, f"select public.record_payment('customer','{C2}','in',301,'x');", "أكبر من مديونية")
T.rejected("عميل مش موجود (مفيش دفعة وهمية)", db, "select public.record_payment('customer','99999999-9999-9999-9999-999999999999','in',50,'x');", "العميل غير موجود")
T.rejected("مبلغ صفر", db, f"select public.record_payment('customer','{C2}','in',0,'x');", "أكبر من صفر")
T.rejected("مبلغ سالب", db, f"select public.record_payment('customer','{C2}','in',-5,'x');", "أكبر من صفر")
T.rejected("اتجاه out من عميل", db, f"select public.record_payment('customer','{C2}','out',10,'x');", "التحصيل متاح")
T.rejected("نوع supplier", db, f"select public.record_payment('supplier','{C2}','in',10,'x');", "التحصيل متاح")
T.check("مفيش دفعات ولا خزينة ولا رصيد اتغيّروا من الرفض", count(db, "payments") == n_pay and cash(db) == cash_b and bal(db, C2) == 300)
ok, _ = pay(db, C2, 300)
T.check("سداد كامل 300 مقبول", ok, db.error)
ok = db.run(f"update public.customers set balance = -5 where id='{C1}';")
T.check("القاعدة نفسها بترفض رصيد سالب حتى بتعديل مباشر", not ok and "customers_balance_non_negative" in db.last_stderr, db.last_stderr[:120])
consistent("رفض الدفعات الغلط", db)


# ============================== د) مرتجعات البيع ==============================
T.section("د) مرتجعات البيع (create_sales_return)")
db = Db()
order(db, [(P1, "قطعة", 1, 20, 100, 0)])
order(db, [(P1, "قطعة", 1, 10, 200, 0)])
_, ri1 = sale(db, C1, [(P1, "قطعة", 1, 4, 300)], 0)
cash_b, st_b = cash(db), stock(db)
n0 = count(db, "notifications")
ok, r1 = sret(db, ri1, [(P1, "قطعة", 1, 1)])
T.check("مرتجع قطعة من فاتورة آجلة", ok, db.error)
T.approx("رصيد العميل 1200 → 900", bal(db, C1), 900)
T.approx("مفيش فلوس اترجعت (العميل لسه مديون)", cash(db), cash_b)
rr = db.rows(f"select total_amount, (total_amount - cash_refund), cash_refund from public.sales_returns where id='{r1}'")[0]
T.check("المرتجع: قيمة 300 / خصم من الدين 300 / نقدي 0", float(rr[0]) == 300 and float(rr[1]) == 300 and float(rr[2]) == 0, str(rr))
T.approx("المخزون +1", stock(db), st_b + 1)
lt = db.rows(f"select source_type, unit_cost, quantity_received from public.inventory_lots where source_id='{r1}'")
T.check("دفعة مرتجع بتكلفة الأصل (100) وكمية 1", len(lt) == 1 and lt[0][0] == "return" and float(lt[0][1]) == 100 and float(lt[0][2]) == 1, str(lt))
T.check("حركة مخزون +1", db.num(f"select coalesce(sum(quantity),0) from public.inventory_movements where reference_id='{r1}'") == 1)
T.check("سطر مرتجع بسعر 300 وإجمالي 300", count(db, "sales_return_items", f"return_id='{r1}' and unit_price=300 and line_total=300") == 1)
T.check("إشعار اتسجّل", count(db, "notifications") > n0)
consistent("مرتجع آجل", db)

_, ri2 = sale(db, C2, [(P1, "قطعة", 1, 2, 500)], 1000)
cash_b = cash(db)
ok, r2 = sret(db, ri2, [(P1, "قطعة", 1, 2)])
T.check("مرتجع كامل لفاتورة مدفوعة بالكامل", ok, db.error)
T.approx("رصيد العميل صفر (مش سالب)", bal(db, C2), 0)
T.approx("الـ 1000 اترجعت نقدًا من الخزينة", cash(db) - cash_b, -1000)
rr = db.rows(f"select (total_amount - cash_refund), cash_refund from public.sales_returns where id='{r2}'")[0]
T.check("خصم من الدين 0 / نقدي 1000", float(rr[0]) == 0 and float(rr[1]) == 1000, str(rr))
T.check("قيد الخزينة sale_in بالسالب", count(db, "treasury_transactions", f"reference_id='{r2}' and type='sale_in' and amount=-1000") == 1)
consistent("مرتجع فاتورة مدفوعة", db)

_, ri3 = sale(db, C1, [(P1, "قطعة", 1, 3, 400)], 1200)
cash_b, debt_other = cash(db), bal(db, C1)
ok, r3 = sret(db, ri3, [(P1, "قطعة", 1, 3)])
T.check("مرتجع من فاتورة مدفوعة وعميل عليه دين من فاتورة تانية", ok, db.error)
T.approx("المرتجع بيخصم من دين فاتورته هو بس: الدين التاني (900) ما اتلمسش", bal(db, C1), debt_other)
T.approx("اللي العميل دفعه (1200) اترجع له نقدًا", cash(db) - cash_b, -1200)
rr = db.rows(f"select (total_amount - cash_refund), cash_refund from public.sales_returns where id='{r3}'")[0]
T.check("خصم من الدين 0 / نقدي 1200", float(rr[0]) == 0 and float(rr[1]) == 1200, str(rr))
consistent("مرتجع مدفوع وعليه دين من فاتورة تانية", db)

_, ri4 = sale(db, None, [(P1, "قطعة", 1, 2, 400)], 800)
cash_b = cash(db)
ok, r4 = sret(db, ri4, [(P1, "قطعة", 1, 1)])
T.check("مرتجع لبيع نقدي من غير عميل", ok, db.error)
T.approx("400 اترجعت نقدًا (كان بيتسجّل صفر قبل الإصلاح)", cash(db) - cash_b, -400)
consistent("مرتجع بيع نقدي", db)

b0 = bal(db, C1)
_, ri5 = sale(db, C1, [(P1, "قطعة", 1, 4, 250)], 0, discount=200)
T.approx("فاتورة 1000 بخصم 200: دين +800", bal(db, C1) - b0, 800)
ok, _ = sret(db, ri5, [(P1, "قطعة", 1, 2)])
T.check("مرتجع نص الفاتورة", ok, db.error)
T.approx("قيمة المرتجع بعد الخصم النسبي = 2×250×0.8 = 400 → الدين +400", bal(db, C1) - b0, 400)
ok, _ = sret(db, ri5, [(P1, "قطعة", 1, 2)])
T.check("مرتجع النص التاني", ok, db.error)
T.approx("دين الفاتورة اتصفّر (المرتجع الكامل مرجّعش الخصم زيادة)", bal(db, C1) - b0, 0)
T.rejected("مرتجع تالت أكبر من المباع", db, f"select public.create_sales_return('{ri5}',{return_items((P1,'قطعة',1,1))},'x');", "أكبر من الكمية المباعة")
consistent("مرتجع فاتورة بخصم", db)

_, ri6 = sale(db, C2, [(P1, "قطعة", 1, 1, 300)], 300)
cash_b = cash(db)
ok, _ = sret(db, ri6, [(P1, "قطعة", 1, 1, 100000)])
T.check("مرتجع بسعر مزوّر 100000", ok, db.error)
T.approx("السيرفر تجاهل السعر المزوّر ورجّع 300 بس", cash(db) - cash_b, -300)

_, ri7 = sale(db, None, [(P1, "قطعة", 1, 5, 100)], 500)
ok1, _ = sret(db, ri7, [(P1, "قطعة", 1, 3)])
T.check("مرتجع 3 من 5", ok1, db.error)
T.rejected("مرتجع 3 تانية (المجموع 6 > 5)", db, f"select public.create_sales_return('{ri7}',{return_items((P1,'قطعة',1,3))},'x');", "أكبر من الكمية المباعة")
ok2, _ = sret(db, ri7, [(P1, "قطعة", 1, 2)])
T.check("مرتجع الباقي (2)", ok2, db.error)
consistent("مرتجعات تراكمية", db)

_, ri8 = sale(db, None, [(P1, "كرتونة", 6, 1, 1200), (P1, "قطعة", 1, 2, 200)], 1600)
T.rejected("مرتجع 3 كراتين (=18 قطعة) رغم إن اتباع 8 قطع بس", db, f"select public.create_sales_return('{ri8}',{return_items((P1,'كرتونة',6,3))},'x');", "أكبر من الكمية المباعة")
st_b = stock(db)
ok, _ = sret(db, ri8, [(P1, "كرتونة", 6, 1)])
T.check("مرتجع كرتونة واحدة", ok, db.error)
T.approx("المخزون +6", stock(db), st_b + 6)
ok, _ = sret(db, ri8, [(P1, "قطعة", 1, 2)])
T.check("مرتجع قطعتين", ok, db.error)
T.rejected("قطعة زيادة (المجموع 9 > 8)", db, f"select public.create_sales_return('{ri8}',{return_items((P1,'قطعة',1,1))},'x');", "أكبر من الكمية المباعة")
consistent("مرتجعات بوحدات مختلطة", db)

T.section("د-2) مرتجعات مرفوضة")
state = (cash(db), stock(db), bal(db, C1), count(db, "sales_returns"))
T.rejected("صنف مش على الفاتورة", db, f"select public.create_sales_return('{ri7}',{return_items((P2,'قطعة',1,1))},'x');", "مش موجود في الفاتورة")
T.rejected("كمية صفر", db, f"select public.create_sales_return('{ri7}',{return_items((P1,'قطعة',1,0))},'x');")
T.rejected("كمية سالبة", db, f"select public.create_sales_return('{ri7}',{return_items((P1,'قطعة',1,-2))},'x');")
T.rejected("بدون أصناف", db, f"select public.create_sales_return('{ri7}','[]'::jsonb,'x');")
T.rejected("فاتورة مش موجودة", db, f"select public.create_sales_return('99999999-9999-9999-9999-999999999999',{return_items((P1,'قطعة',1,1))},'x');", "غير موجودة")
T.rejected("وحدة مفيش عليها سطر في الفاتورة", db, f"select public.create_sales_return('{ri7}',{return_items((P1,'علبة',1,1))},'x');", "بالوحدة المحددة")
T.check("مفيش أي أثر جانبي", state == (cash(db), stock(db), bal(db, C1), count(db, "sales_returns")))
consistent("مرتجعات مرفوضة", db)

T.section("د-3) تكلفة المرتجع بعد FIFO على دفعتين")
db = Db()
order(db, [(P1, "قطعة", 1, 2, 100, 0)])
order(db, [(P1, "قطعة", 1, 2, 200, 0)])
_, fi = sale(db, None, [(P1, "قطعة", 1, 4, 500)], 2000)
T.approx("تكلفة البيع 2×100 + 2×200 = 600", db.num(f"select actual_cost from public.sales_invoice_items where invoice_id='{fi}'"), 600)
ok, fr = sret(db, fi, [(P1, "قطعة", 1, 2)])
T.check("مرتجع قطعتين", ok, db.error)
T.approx("دفعة المرتجع بمتوسط التكلفة الفعلي = 150", db.num(f"select unit_cost from public.inventory_lots where source_id='{fr}'"), 150)
consistent("تكلفة المرتجع", db)


# ============================== هـ) مرتجعات الطلبيات ==============================
T.section("هـ) مرتجعات الطلبيات (create_order_return)")
db = Db()
_, e1 = order(db, [(P1, "قطعة", 1, 10, 100, 0)])
_, e2 = order(db, [(P1, "قطعة", 1, 4, 200, 0)], discount=80)
_, e3 = order(db, [(P2, "قطعة", 1, 5, 50, 0)])
cash_b, st_b = cash(db), stock(db)
ok, er1 = oret(db, e1, [(P1, "قطعة", 1, 3)])
T.check("مرتجع 3 من طلبية 1", ok, db.error)
T.approx("الاسترداد 3 × 100 = 300", cash(db) - cash_b, 300)
T.approx("دفعة الطلبية فضل منها 7", lot_remaining(db, e1), 7)
T.approx("المخزون -3", stock(db), st_b - 3)
T.check("حركة -3", db.num(f"select coalesce(sum(quantity),0) from public.inventory_movements where reference_id='{er1}'") == -3)
T.check("قيد خزينة purchase_out +300", count(db, "treasury_transactions", f"reference_id='{er1}' and type='purchase_out' and amount=300") == 1)
T.check("سجل المرتجع: 300 وسطر بتكلفة 100", count(db, "order_returns", f"id='{er1}' and total_amount=300") == 1 and count(db, "order_return_items", f"return_id='{er1}' and unit_cost=100 and line_total=300") == 1)
consistent("مرتجع طلبية", db)

cash_b = cash(db)
ok, _ = oret(db, e2, [(P1, "قطعة", 1, 2)])
T.check("مرتجع من طلبية بخصم", ok, db.error)
T.approx("الاسترداد 2 × 180 (التكلفة بعد خصم الطلبية) = 360", cash(db) - cash_b, 360)
consistent("مرتجع طلبية بخصم", db)

_, es = sale(db, None, [(P1, "قطعة", 1, 6, 300)], 1800)
T.approx("البيع سحب 6 من طلبية 1 (7 → 1)", lot_remaining(db, e1), 1)
T.rejected("مرتجع 2 من طلبية 1 وفاضل 1 بس", db, f"select public.create_order_return('{e1}',{return_items((P1,'قطعة',1,2))},'x');", "أكبر من المتوفر")
ok, _ = oret(db, e1, [(P1, "قطعة", 1, 1)])
T.check("مرتجع القطعة اللي فاضلة", ok, db.error)
consistent("مرتجع بعد بيع", db)

_, e4 = order(db, [(P1, "كرتونة", 6, 2, 600, 0)])
cash_b, st_b = cash(db), stock(db)
ok, _ = oret(db, e4, [(P1, "كرتونة", 6, 1)])
T.check("مرتجع كرتونة من طلبية", ok, db.error)
T.approx("الاسترداد 6 × 100 = 600", cash(db) - cash_b, 600)
T.approx("المخزون -6", stock(db), st_b - 6)

_, e5 = order(db, [(P2, "قطعة", 1, 3, 10, 0), (P2, "قطعة", 1, 4, 20, 0)])
cash_b = cash(db)
ok, _ = oret(db, e5, [(P2, "قطعة", 1, 5)])
T.check("مرتجع 5 بيمتد على دفعتين (3@10 + 2@20)", ok, db.error)
T.approx("الاسترداد 30 + 40 = 70", cash(db) - cash_b, 70)
consistent("مرتجع على دفعتين", db)

cash_b = cash(db)
ok, _ = oret(db, e3, [(P2, "قطعة", 1, 1, 99999)])
T.check("مرتجع بتكلفة مزوّرة 99999", ok, db.error)
T.approx("السيرفر تجاهل التكلفة المزوّرة واسترد 50", cash(db) - cash_b, 50)

state = (cash(db), stock(db), count(db, "order_returns"))
T.rejected("صنف مش في الطلبية", db, f"select public.create_order_return('{e3}',{return_items((P1,'قطعة',1,1))},'x');", "مش موجود في الطلبية")
T.rejected("كمية صفر", db, f"select public.create_order_return('{e3}',{return_items((P2,'قطعة',1,0))},'x');")
T.rejected("كمية سالبة", db, f"select public.create_order_return('{e3}',{return_items((P2,'قطعة',1,-1))},'x');")
T.rejected("بدون أصناف", db, f"select public.create_order_return('{e3}','[]'::jsonb,'x');")
T.rejected("طلبية مش موجودة", db, f"select public.create_order_return('99999999-9999-9999-9999-999999999999',{return_items((P2,'قطعة',1,1))},'x');", "غير موجودة")
T.check("مفيش أثر جانبي للمرفوض", state == (cash(db), stock(db), count(db, "order_returns")))
consistent("مرتجعات طلبيات مرفوضة", db)


# ============================== و) الجرد ==============================
T.section("و) الجرد (apply_stocktake)")
db = Db()
order(db, [(P1, "قطعة", 1, 10, 100, 0)])
_, f2 = order(db, [(P1, "قطعة", 1, 10, 200, 0)])
adjust = 0.0
ok, st1 = stock_take(db, W1, [(P1, 25)])
T.check("جرد بزيادة 5", ok, db.error)
T.approx("المخزون = 25", stock(db), 25)
lt = db.rows(f"select source_type, unit_cost, quantity_received from public.inventory_lots where source_id='{st1}'")
T.check("دفعة جرد بمتوسط تكلفة الدفعات المتبقية (150) مش صفر", len(lt) == 1 and lt[0][0] == "stocktake" and abs(float(lt[0][1]) - 150) < 0.01 and float(lt[0][2]) == 5, str(lt))
adjust += 5 * 150
T.check("سجل الجرد وبنده (النظام 20 / المعدود 25 / الفرق 5)", count(db, "stocktake_items", f"stocktake_id='{st1}' and system_quantity=20 and counted_quantity=25 and difference=5") == 1)
T.check("حركة +5", db.num(f"select coalesce(sum(quantity),0) from public.inventory_movements where reference_id='{st1}'") == 5)
consistent("جرد بزيادة", db, adjust)

ok, st2 = stock_take(db, W1, [(P1, 18)])
T.check("جرد بنقص 7", ok, db.error)
T.approx("المخزون = 18", stock(db), 18)
adjust -= 7 * 100
T.approx("الخصم من أقدم دفعة (FIFO): فضل 3 من 10", db.num(f"select quantity_remaining from public.inventory_lots where source_type='order' and unit_cost=100"), 3)
consistent("جرد بنقص (FIFO)", db, adjust)

db.run(f"update public.products set cost_price = 30 where id='{P2}'")
ok, st3 = stock_take(db, W1, [(P2, 4)])
T.check("جرد صنف عمره ما اتشرى (من غير دفعات)", ok, db.error)
T.approx("اتكوّن مخزون 4", stock(db, P2), 4)
T.approx("بتكلفة cost_price (30) لأنه مفيش دفعات", db.num(f"select unit_cost from public.inventory_lots where source_id='{st3}'"), 30)
adjust += 4 * 30
consistent("جرد لصنف جديد", db, adjust)

ok, _ = stock_take(db, W1, [(P1, 18)])
T.check("جرد من غير فرق بيعدّي", ok, db.error)
T.approx("المخزون ماتغيّرش", stock(db), 18)
consistent("جرد بدون فروق", db, adjust)
T.rejected("جرد بكمية سالبة", db, f"select public.apply_stocktake('{W1}','x',{stocktake_items((P1,-1))});", "صفر أو أكتر")
T.rejected("جرد في مخزن مش موجود", db, f"select public.apply_stocktake('99999999-9999-9999-9999-999999999999','x',{stocktake_items((P1,5))});")
consistent("جرد مرفوض", db, adjust)


# ============================== ز) الصلاحيات والتوابع العامة ==============================
T.section("ز) الصلاحيات، RLS، والإشعارات")
db = Db()
ok = db.user(f"select public.create_order('{W1}','x',{order_items((P1,'قطعة',1,1,10,10))},0);", user=USER2)
T.check("مستخدم موقوف (is_active=false) مرفوض من إنشاء طلبية", not ok and "غير مصرح" in db.error, db.error)
ok = db.user("select public.void_sale_invoice('99999999-9999-9999-9999-999999999999');", user=USER2)
T.check("مستخدم موقوف مرفوض من إلغاء فاتورة", not ok and "غير مصرح" in db.error, db.error)
ok = db.user(f"select public.record_payment('customer','{C1}','in',1,'x');", user=USER2)
T.check("مستخدم موقوف مرفوض من التحصيل", not ok and "غير مصرح" in db.error, db.error)
db.run(f"set role authenticated; do $$ begin perform set_config('request.jwt.claim.sub','{USER2}',false); end $$; select count(*) from public.products;")
T.check("RLS: المستخدم الموقوف يشوف 0 أصناف", db.last_stdout.strip().splitlines()[-1] == "0", db.last_stdout)
db.run(f"set role authenticated; do $$ begin perform set_config('request.jwt.claim.sub','{USER}',false); end $$; select count(*) from public.products;")
T.check("RLS: المستخدم المفعّل يشوف الأصناف (2)", db.last_stdout.strip().splitlines()[-1] == "2", db.last_stdout)
ok = db.user("insert into public.products(part_number,name,base_unit) values ('Z','Z','قطعة');", user=USER2)
T.check("RLS: المستخدم الموقوف مينفعش يضيف صنف", not ok)

db.run("insert into public.notifications(message, created_at) values ('قديمة', now() - interval '5 days'), ('جديدة', now() - interval '1 day');")
ok = db.user("select public.cleanup_old_notifications();")
T.check("تنظيف الإشعارات الأقدم من 3 أيام", ok and count(db, "notifications", "message='قديمة'") == 0 and count(db, "notifications", "message='جديدة'") == 1, db.error)
for fn, call in [("create_order", f"select public.create_order('{W1}','x','[]'::jsonb,0)"), ("record_payment", f"select public.record_payment('customer','{C1}','in',1,'x')"),
                 ("void_sale_invoice", "select public.void_sale_invoice('99999999-9999-9999-9999-999999999999')"), ("unit_factor", f"select public.unit_factor('{P1}','قطعة')")]:
    ok = db.run("set role anon; " + call + ";")
    T.check(f"anon ممنوع ينفّذ {fn}", not ok)


# ============================== ح) اختبار عشوائي ==============================
T.section(f"ح) اختبار عشوائي ({FUZZ_STEPS} عملية، بذرة {FUZZ_SEED}): فحص الاتساق بعد كل عملية")
rng = random.Random(FUZZ_SEED)
db = Db()
adjust = 0.0
stats = {}
violations = []

def inv_value():
    return db.num("select coalesce(sum(quantity_remaining*unit_cost),0) from public.inventory_lots")

def note(kind, ok):
    s = stats.setdefault(kind, [0, 0])
    s[0 if ok else 1] += 1

def pick(sql):
    r = db.rows(sql)
    return rng.choice(r) if r else None

for step in range(FUZZ_STEPS):
    kind = rng.choices(["order", "sale", "pay", "sret", "oret", "void_sale", "void_order", "stocktake"],
                       weights=[14, 26, 12, 12, 8, 7, 3, 6])[0]
    ok, desc = False, ""
    if kind == "order":
        p = rng.choice([P1, P2]); unit, cf = ("كرتونة", 6) if p == P1 and rng.random() < 0.3 else ("قطعة", 1)
        qty, cost = rng.randint(1, 15), rng.randint(10, 200)
        disc = rng.choice([0, 0, 0, round(qty * cost * rng.random() * 0.2), qty * cost + rng.randint(1, 50)])
        ok, _ = order(db, [(p, unit, cf, qty, cost, 0)], discount=disc, wh=rng.choice([W1, W1, W2]))
        desc = f"order {p[-4:]} {unit} q={qty} c={cost} d={disc}"
    elif kind == "sale":
        cust = rng.choice([C1, C2, None]); p = rng.choice([P1, P2])
        unit, cf = ("كرتونة", 6) if p == P1 and rng.random() < 0.25 else ("قطعة", 1)
        qty, price = rng.randint(1, 12), rng.randint(50, 500)
        sub = qty * price; disc = rng.choice([0, 0, round(sub * rng.random() * 0.3), sub + 1])
        total = max(sub - disc, 0)
        paid = total if cust is None and rng.random() < 0.8 else rng.choice([0, round(total * rng.random()), total, total + 5])
        ok, _ = sale(db, cust, [(p, unit, cf, qty, price)], paid, discount=disc, wh=rng.choice([W1, W1, W2]))
        desc = f"sale cust={cust and cust[-2:]} {unit} q={qty} p={price} d={disc} paid={paid}"
    elif kind == "pay":
        c = rng.choice([C1, C2]); b = bal(db, c)
        amt = rng.choice([round(b * rng.random(), 2), b, b + 1, 0, -3]) if b > 0 else rng.choice([5, 0])
        ok, _ = pay(db, c, amt)
        desc = f"pay {c[-2:]} amt={amt} bal={b}"
    elif kind in ("sret", "void_sale"):
        r = pick("select id from public.sales_invoices")
        if r:
            if kind == "void_sale":
                ok = db.user(f"select public.void_sale_invoice('{r[0]}');"); desc = f"void_sale {r[0][:8]}"
            else:
                it = pick(f"select product_id, unit_name, sum(quantity) from public.sales_invoice_items where invoice_id='{r[0]}' group by 1,2")
                cf = 6 if it[1] == "كرتونة" else 1
                qty = rng.randint(1, max(int(float(it[2])), 1) + 1)
                ok, _ = sret(db, r[0], [(it[0], it[1], cf, qty)]); desc = f"sret {r[0][:8]} {it[1]} q={qty}"
    elif kind in ("oret", "void_order"):
        r = pick("select id from public.orders")
        if r:
            if kind == "void_order":
                ok = db.user(f"select public.void_order('{r[0]}');"); desc = f"void_order {r[0][:8]}"
            else:
                it = pick(f"select product_id, unit_name, sum(quantity) from public.order_items where order_id='{r[0]}' group by 1,2")
                cf = 6 if it[1] == "كرتونة" else 1
                qty = rng.randint(1, max(int(float(it[2])), 1) + 1)
                ok, _ = oret(db, r[0], [(it[0], it[1], cf, qty)]); desc = f"oret {r[0][:8]} {it[1]} q={qty}"
    elif kind == "stocktake":
        before = inv_value()
        p, w = rng.choice([P1, P2]), rng.choice([W1, W2])
        ok, _ = stock_take(db, w, [(p, rng.randint(0, 30))])
        if ok:
            adjust += inv_value() - before
        desc = f"stocktake {p[-4:]} {w[-4:]}"
    note(kind, ok)
    problems = check_all(db, adjust)
    if problems:
        violations.append(f"#{step} {desc}: {'; '.join(problems)}")
        break

T.check(f"{FUZZ_STEPS} عملية عشوائية: الاتساق (مخزون/دفعات/حركات/أرصدة/معادلة الأصول) سليم بعد كل واحدة",
        not violations, violations[0][:300] if violations else "")
print("   ملخص (نجحت / اترفضت):", ", ".join(f"{k}={v[0]}/{v[1]}" for k, v in sorted(stats.items())))
T.check("العشوائي جرّب عمليات ناجحة ومرفوضة من كل نوع رئيسي",
        all(stats.get(k, [0, 0])[0] > 0 for k in ("order", "sale", "pay", "sret", "oret")) and sum(v[1] for v in stats.values()) > 0)

print()
print(f"{T.total - T.failures} من {T.total} اختبار نجحوا " + ("— كل الاختبارات نجحت ✅" if T.failures == 0 else f"— {T.failures} فشل ❌"))
sys.exit(1 if T.failures else 0)
