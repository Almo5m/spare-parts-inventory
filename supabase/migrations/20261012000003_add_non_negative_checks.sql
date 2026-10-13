-- ============================================================================
-- قيود "مفيش أرقام سالبة" على مستوى قاعدة البيانات (اختياري، شغّله بعد ما تجرّب)
--
-- ليه: الواجهة والدوال بتمنع الكميات والأسعار السالبة، لكن القاعدة نفسها كانت بتقبلها لو
-- حصل خطأ في كود جديد أو إدخال مباشر. القيود دي آخر خط دفاع.
--
-- NOT VALID معناها: القيد بيتطبق على أي كتابة جديدة فورًا، وبيتجاهل الصفوف القديمة
-- (عشان لو فيه صف قديم غلط ميوقفش التنفيذ). بعدها شغّل استعلامات الفحص اللي في الآخر؛
-- لو رجعت صفر صفوف اعمل VALIDATE.
-- ============================================================================

alter table public.inventory
  add constraint inventory_quantity_non_negative check (quantity >= 0) not valid;

alter table public.inventory_lots
  add constraint inventory_lots_remaining_non_negative check (quantity_remaining >= 0) not valid,
  add constraint inventory_lots_received_positive check (quantity_received > 0) not valid,
  add constraint inventory_lots_cost_non_negative check (unit_cost >= 0) not valid;

alter table public.sales_invoices
  add constraint sales_invoices_amounts_non_negative
  check (total_amount >= 0 and paid_amount >= 0 and discount_amount >= 0) not valid;

alter table public.sales_invoice_items
  add constraint sales_invoice_items_positive check (quantity > 0 and unit_price >= 0) not valid;

alter table public.orders
  add constraint orders_amounts_non_negative check (total_cost >= 0 and discount_amount >= 0) not valid;

alter table public.order_items
  add constraint order_items_positive check (quantity > 0 and unit_cost >= 0) not valid;

-- ---------- فحص الصفوف القديمة (كلهم المفروض يرجّعوا صفر صفوف) ----------
-- select count(*) from public.inventory where quantity < 0;
-- select count(*) from public.inventory_lots where quantity_remaining < 0 or quantity_received <= 0 or unit_cost < 0;
-- select count(*) from public.sales_invoices where total_amount < 0 or paid_amount < 0 or discount_amount < 0;
-- select count(*) from public.sales_invoice_items where quantity <= 0 or unit_price < 0;
-- select count(*) from public.orders where total_cost < 0 or discount_amount < 0;
-- select count(*) from public.order_items where quantity <= 0 or unit_cost < 0;
--
-- لو كلهم صفر:
-- alter table public.inventory validate constraint inventory_quantity_non_negative;
-- alter table public.inventory_lots validate constraint inventory_lots_remaining_non_negative;
-- alter table public.inventory_lots validate constraint inventory_lots_received_positive;
-- alter table public.inventory_lots validate constraint inventory_lots_cost_non_negative;
-- alter table public.sales_invoices validate constraint sales_invoices_amounts_non_negative;
-- alter table public.sales_invoice_items validate constraint sales_invoice_items_positive;
-- alter table public.orders validate constraint orders_amounts_non_negative;
-- alter table public.order_items validate constraint order_items_positive;
