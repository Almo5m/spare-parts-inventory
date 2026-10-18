-- ============================================================================
-- إصلاحات منطق الحسابات (نتيجة الفحص الشامل بتاريخ 2026-10-15)
--
-- اللي بيصلحه الملف ده:
--  1) البيع لعميل نقدي بدفع جزئي كان بيضيّع الدين (مفيش عميل يتسجّل عليه) -> بقى مرفوض.
--  2) المرتجع كان بيتجاهل خصم الفاتورة، وبياخد السعر من الواجهة، وبيحسب التكلفة بمتوسط بسيط.
--     دلوقتي: السعر والتكلفة من الفاتورة الأصلية، والخصم موزّع، والمتوسط مرجّح.
--  3) مرتجع البيع كان بيعمل رصيد دائن للعميل حتى لو الفاتورة مدفوعة، ومفيش أثر في الخزنة.
--     دلوقتي: الجزء المقابل لدين حقيقي بينقص من الرصيد، والباقي استرداد نقدي من الخزنة.
--  4) مرتجعات البيع والشراء كانت بتقبل كمية سالبة ومعامل تحويل صفر -> التحقق جوه الدالة.
--  5) الإلغاء كان بيحسب الكمية من اسم الوحدة الحالي، وبيمسح من غير أي أثر
--     -> بيرجّع من حركات المخزون الفعلية، وبينسخ لقطة في cancelled_documents قبل المسح.
--  6) set_invoice_numbering كان ممكن يحط رقم مكرر ويوقّف البيع كله -> تحقق + الدوال
--     بتتخطى أي رقم مستخدم تلقائيًا.
--  7) record_payment: اتجاه الصرف، والتأكد من وجود العميل، وإزالة فرع الموردين الميت.
--  8) تكلفة الدفعة في الطلبية بقت بعد الخصم، ودقة تكلفة الوحدة بقت 4 خانات.
--  9) apply_stocktake: رفض القائمة الفاضية والأصناف المكررة.
-- 10) notify و log_activity بقوا بيتجاهلوا أي حد مش مستخدم مفعّل.
--
-- جرّب الملف على مشروع تجريبي الأول وشغّل: npm run test:db
-- ============================================================================


-- ---------- أعمدة وجداول جديدة ----------

alter table public.sales_returns add column if not exists cash_refund numeric(14,2) not null default 0;
alter table public.sales_returns add column if not exists cost_amount numeric(14,2) not null default 0;
alter table public.sales_return_items add column if not exists cost_amount numeric(14,2) not null default 0;

-- تعبئة تكلفة المرتجعات القديمة من الدفعات اللي اتعملت وقت المرتجع
update public.sales_returns r
set cost_amount = coalesce((
  select sum(l.unit_cost * l.quantity_received) from public.inventory_lots l
  where l.source_type = 'return' and l.source_id = r.id
), 0)
where r.cost_amount = 0;

update public.sales_return_items ri
set cost_amount = coalesce((
  select sum(l.unit_cost * l.quantity_received) from public.inventory_lots l
  where l.source_type = 'return' and l.source_id = ri.return_id and l.product_id = ri.product_id
), 0)
where ri.cost_amount = 0;

-- تكلفة الوحدة كانت بخانتين بس (33.33 بدل 33.3333) فالتكلفة الفعلية بتنحرف مع الكميات الكبيرة
alter table public.inventory_lots alter column unit_cost type numeric(14,4);
alter table public.sale_item_lot_usage alter column unit_cost type numeric(14,4);

-- لقطة من أي فاتورة/طلبية تتلغي (الإلغاء بيمسح الصفوف الأصلية)
create table if not exists public.cancelled_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (doc_type in ('sale_invoice', 'order')),
  doc_number text not null,
  doc_id uuid not null,
  snapshot jsonb not null,
  cancelled_by uuid,
  cancelled_at timestamp with time zone not null default now()
);

alter table public.cancelled_documents enable row level security;
revoke all on public.cancelled_documents from anon;

drop policy if exists cancelled_documents_select on public.cancelled_documents;
create policy cancelled_documents_select on public.cancelled_documents
  as permissive for select to authenticated using (public.is_active_user());
-- مفيش سياسة كتابة: الكتابة بتتم من جوه دوال الإلغاء (security definer) بس


-- ---------- دالة مساعدة: معامل تحويل الوحدة ----------

create or replace function public.unit_factor(p_product_id uuid, p_unit_name text)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
  select case
    when p.base_unit = p_unit_name then 1::numeric
    else coalesce(
      (select pu.conversion_factor from public.product_units pu
       where pu.product_id = p.id and pu.unit_name = p_unit_name),
      1::numeric)
  end
  from public.products p
  where p.id = p_product_id
$function$;

revoke all on function public.unit_factor(uuid, text) from public, anon;
grant execute on function public.unit_factor(uuid, text) to authenticated;


-- ---------- ترقيم الفواتير ----------

create or replace function public.set_invoice_numbering(p_next_sales_number integer, p_next_order_number integer)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_max_sale bigint;
  v_max_order bigint;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_next_sales_number is not null then
    if p_next_sales_number < 1 then
      raise exception 'رقم الفاتورة التالي لازم يكون 1 أو أكبر';
    end if;
    select coalesce(max((substring(invoice_number from '^S-(\d{1,9})$'))::bigint), 0)
    into v_max_sale from public.sales_invoices;
    if p_next_sales_number <= v_max_sale then
      raise exception 'الرقم التالي (%) لازم يكون أكبر من آخر فاتورة موجودة (%)', p_next_sales_number, v_max_sale;
    end if;
  end if;

  if p_next_order_number is not null then
    if p_next_order_number < 1 then
      raise exception 'رقم الطلبية التالي لازم يكون 1 أو أكبر';
    end if;
    select coalesce(max((substring(order_number from '^O-(\d{1,9})$'))::bigint), 0)
    into v_max_order from public.orders;
    if p_next_order_number <= v_max_order then
      raise exception 'الرقم التالي (%) لازم يكون أكبر من آخر طلبية موجودة (%)', p_next_order_number, v_max_order;
    end if;
  end if;

  update public.company_settings
  set next_sales_invoice_number = coalesce(p_next_sales_number, next_sales_invoice_number),
      next_order_number = coalesce(p_next_order_number, next_order_number)
  where id = true;
end;
$function$;


-- ---------- فاتورة بيع ----------

create or replace function public.create_sale_invoice(p_customer_id uuid, p_warehouse_id uuid, p_items jsonb, p_paid_amount numeric, p_discount_amount numeric DEFAULT 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice_id uuid;
  v_invoice_number text;
  v_seq int;
  v_subtotal numeric := 0;
  v_discount numeric;
  v_total numeric;
  v_item jsonb;
  v_base_qty numeric;
  v_line_total numeric;
  v_status payment_status;
  v_current_qty numeric;
  v_product_id uuid;
  v_item_id uuid;
  v_remaining_needed numeric;
  v_item_cost numeric;
  v_lot record;
  v_take numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لا يمكن إنشاء فاتورة بدون أصناف';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where (i->>'product_id') is null
       or (i->>'unit_name') is null
       or coalesce((i->>'quantity')::numeric, 0) <= 0
       or coalesce((i->>'unit_price')::numeric, -1) < 0
       or coalesce((i->>'conversion_factor')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات الأصناف غير صحيحة: الكمية ومعامل التحويل لازم يكونوا أكبر من صفر، والسعر مينفعش يكون سالب';
  end if;

  if p_warehouse_id is null or not exists (select 1 from public.warehouses where id = p_warehouse_id) then
    raise exception 'المخزن غير موجود';
  end if;
  if p_customer_id is not null and not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'العميل غير موجود';
  end if;

  -- إجمالي كل سطر بيتقرّب لقرشين زي ما بيتخزّن، عشان الإجماليات تطابق مجموع الأسطر
  select coalesce(sum(round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)), 0)
  into v_subtotal
  from jsonb_array_elements(p_items) i;

  if v_subtotal <= 0 then
    raise exception 'إجمالي الفاتورة لازم يكون أكبر من صفر';
  end if;

  v_discount := round(coalesce(p_discount_amount, 0), 2);
  if v_discount < 0 or v_discount > v_subtotal then
    raise exception 'الخصم لازم يكون بين صفر وإجمالي الفاتورة قبل الخصم';
  end if;

  v_total := greatest(v_subtotal - v_discount, 0);

  if p_paid_amount is null or p_paid_amount < 0 or p_paid_amount > v_total then
    raise exception 'المبلغ المدفوع لازم يكون بين صفر وإجمالي الفاتورة بعد الخصم';
  end if;

  -- العميل النقدي مفيش حساب نسجّل عليه الباقي، فلازم يدفع بالكامل
  if p_customer_id is null and p_paid_amount < v_total then
    raise exception 'البيع لعميل نقدي لازم يتدفع بالكامل. اختار عميل لو عايز تسجّل الباقي كدين عليه';
  end if;

  -- رقم الفاتورة: بنتخطى أي رقم متسجّل بالفعل بدل ما البيع يقف
  select next_sales_invoice_number into v_seq from public.company_settings where id = true for update;
  if v_seq is null then
    raise exception 'إعدادات الشركة غير موجودة';
  end if;
  while exists (select 1 from public.sales_invoices where invoice_number = 'S-' || lpad(v_seq::text, 6, '0')) loop
    v_seq := v_seq + 1;
  end loop;
  update public.company_settings set next_sales_invoice_number = v_seq + 1 where id = true;
  v_invoice_number := 'S-' || lpad(v_seq::text, 6, '0');

  if p_paid_amount >= v_total then
    v_status := 'paid';
  elsif p_paid_amount > 0 then
    v_status := 'partial';
  else
    v_status := 'unpaid';
  end if;

  insert into public.sales_invoices
    (invoice_number, customer_id, warehouse_id, total_amount, paid_amount, discount_amount, payment_status, created_by)
  values
    (v_invoice_number, p_customer_id, p_warehouse_id, v_total, p_paid_amount, v_discount, v_status, auth.uid())
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_line_total := round((v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric, 2);
    v_base_qty := (v_item->>'quantity')::numeric * (v_item->>'conversion_factor')::numeric;

    select quantity into v_current_qty
    from public.inventory
    where product_id = v_product_id and warehouse_id = p_warehouse_id
    for update;

    if v_current_qty is null or v_current_qty < v_base_qty then
      raise exception 'الكمية غير متوفرة في المخزون لأحد الأصناف';
    end if;

    insert into public.sales_invoice_items
      (invoice_id, product_id, unit_name, quantity, unit_price, line_total)
    values
      (v_invoice_id, v_product_id, v_item->>'unit_name',
       (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric, v_line_total)
    returning id into v_item_id;

    -- استهلاك الدفعات الأقدم أولًا (FIFO) وتسجيل التكلفة الحقيقية
    v_remaining_needed := v_base_qty;
    v_item_cost := 0;

    for v_lot in
      select id, quantity_remaining, unit_cost from public.inventory_lots
      where product_id = v_product_id and warehouse_id = p_warehouse_id and quantity_remaining > 0
      order by created_at asc
      for update
    loop
      exit when v_remaining_needed <= 0;
      v_take := least(v_lot.quantity_remaining, v_remaining_needed);

      update public.inventory_lots
      set quantity_remaining = quantity_remaining - v_take
      where id = v_lot.id;

      insert into public.sale_item_lot_usage (sale_invoice_item_id, lot_id, quantity, unit_cost)
      values (v_item_id, v_lot.id, v_take, v_lot.unit_cost);

      v_item_cost := v_item_cost + v_take * v_lot.unit_cost;
      v_remaining_needed := v_remaining_needed - v_take;
    end loop;

    -- لو الدفعات متسجلاش كفاية (مخزون قديم قبل تفعيل النظام ده)، نكمل
    -- الباقي بسعر التكلفة الحالي المسجّل على الصنف كأفضل تقدير متاح
    if v_remaining_needed > 0 then
      v_item_cost := v_item_cost + v_remaining_needed *
        (select cost_price from public.products where id = v_product_id);
    end if;

    update public.sales_invoice_items set actual_cost = v_item_cost where id = v_item_id;

    update public.inventory
    set quantity = quantity - v_base_qty, updated_at = now()
    where product_id = v_product_id and warehouse_id = p_warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, p_warehouse_id, 'sale', -v_base_qty, v_invoice_id, auth.uid());
  end loop;

  if p_customer_id is not null and p_paid_amount < v_total then
    update public.customers
    set balance = balance + (v_total - p_paid_amount)
    where id = p_customer_id;
  end if;

  if p_paid_amount > 0 then
    insert into public.treasury_transactions (type, amount, reference_id, created_by)
    values ('sale_in', p_paid_amount, v_invoice_id, auth.uid());
  end if;

  return v_invoice_id;
end;
$function$;


-- ---------- طلبية شراء ----------

create or replace function public.create_order(p_warehouse_id uuid, p_notes text, p_items jsonb, p_discount_amount numeric DEFAULT 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order_id uuid;
  v_order_number text;
  v_seq int;
  v_subtotal numeric := 0;
  v_discount numeric;
  v_total numeric;
  v_ratio numeric;
  v_item jsonb;
  v_base_qty numeric;
  v_line_total numeric;
  v_product_id uuid;
  v_unit_cost_per_base numeric;
  v_sale_price numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لا يمكن إنشاء طلبية بدون أصناف';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where (i->>'product_id') is null
       or (i->>'unit_name') is null
       or coalesce((i->>'quantity')::numeric, 0) <= 0
       or coalesce((i->>'unit_cost')::numeric, -1) < 0
       or coalesce((i->>'conversion_factor')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات الأصناف غير صحيحة: الكمية ومعامل التحويل لازم يكونوا أكبر من صفر، والتكلفة مينفعش تكون سالبة';
  end if;

  if p_warehouse_id is null or not exists (select 1 from public.warehouses where id = p_warehouse_id) then
    raise exception 'المخزن غير موجود';
  end if;

  select coalesce(sum(round((i->>'quantity')::numeric * (i->>'unit_cost')::numeric, 2)), 0)
  into v_subtotal
  from jsonb_array_elements(p_items) i;

  if v_subtotal <= 0 then
    raise exception 'إجمالي الطلبية لازم يكون أكبر من صفر';
  end if;

  v_discount := round(coalesce(p_discount_amount, 0), 2);
  if v_discount < 0 or v_discount > v_subtotal then
    raise exception 'الخصم لازم يكون بين صفر وإجمالي الطلبية قبل الخصم';
  end if;

  v_total := greatest(v_subtotal - v_discount, 0);
  -- نسبة الخصم بتتوزّع على تكلفة الدفعات، عشان التكلفة الفعلية (والربح) تطابق اللي اتدفع فعلًا
  v_ratio := v_total / v_subtotal;

  select next_order_number into v_seq from public.company_settings where id = true for update;
  if v_seq is null then
    raise exception 'إعدادات الشركة غير موجودة';
  end if;
  while exists (select 1 from public.orders where order_number = 'O-' || lpad(v_seq::text, 6, '0')) loop
    v_seq := v_seq + 1;
  end loop;
  update public.company_settings set next_order_number = v_seq + 1 where id = true;
  v_order_number := 'O-' || lpad(v_seq::text, 6, '0');

  insert into public.orders (order_number, warehouse_id, status, total_cost, discount_amount, notes, created_by)
  values (v_order_number, p_warehouse_id, 'received', v_total, v_discount, p_notes, auth.uid())
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_line_total := round((v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric, 2);
    v_base_qty := (v_item->>'quantity')::numeric * (v_item->>'conversion_factor')::numeric;
    v_unit_cost_per_base := (v_line_total * v_ratio) / greatest(v_base_qty, 0.0001);
    v_sale_price := nullif(v_item->>'sale_price', '')::numeric;

    insert into public.order_items
      (order_id, product_id, unit_name, quantity, unit_cost, line_total, default_sale_price)
    values
      (v_order_id, v_product_id, v_item->>'unit_name',
       (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric, v_line_total, v_sale_price);

    insert into public.inventory_lots
      (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining, default_sale_price)
    values
      (v_product_id, p_warehouse_id, 'order', v_order_id, v_unit_cost_per_base, v_base_qty, v_base_qty, v_sale_price);

    insert into public.inventory (product_id, warehouse_id, quantity)
    values (v_product_id, p_warehouse_id, v_base_qty)
    on conflict (product_id, warehouse_id)
    do update set quantity = public.inventory.quantity + v_base_qty, updated_at = now();

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, p_warehouse_id, 'purchase', v_base_qty, v_order_id, auth.uid());
  end loop;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values ('purchase_out', -v_total, v_order_id, 'طلبية رقم ' || v_order_number, auth.uid());

  return v_order_id;
end;
$function$;


-- ---------- مرتجع بيع ----------
-- السعر والتكلفة بيتاخدوا من الفاتورة الأصلية (مش من الواجهة)، والخصم موزّع بالنسبة.
-- الواجهة بتبعت product_id و unit_name و quantity بس؛ أي سعر أو معامل تحويل بتبعته بيتتجاهل.

create or replace function public.create_sales_return(p_sales_invoice_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice record;
  v_return_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_unit_name text;
  v_qty numeric;
  v_orig_qty numeric;
  v_orig_amount numeric;
  v_orig_cost numeric;
  v_already numeric;
  v_factor numeric;
  v_base_qty numeric;
  v_ratio numeric;
  v_unit_refund numeric;
  v_line_total numeric;
  v_line_cost numeric;
  v_cost_per_base numeric;
  v_total numeric := 0;
  v_cost_total numeric := 0;
  v_prev_returns numeric;
  v_balance numeric;
  v_debt_cut numeric;
  v_cash numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لازم تحدد صنف واحد على الأقل بكمية أكبر من صفر للمرتجع';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where (i->>'product_id') is null
       or (i->>'unit_name') is null
       or coalesce((i->>'quantity')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات المرتجع غير صحيحة: الصنف والوحدة مطلوبين والكمية لازم تكون أكبر من صفر';
  end if;

  select * into v_invoice from public.sales_invoices where id = p_sales_invoice_id for update;
  if not found then
    raise exception 'الفاتورة غير موجودة';
  end if;

  -- نسبة الخصم: إجمالي الفاتورة بعد الخصم ÷ قبله
  v_ratio := case
    when (v_invoice.total_amount + v_invoice.discount_amount) > 0
      then v_invoice.total_amount / (v_invoice.total_amount + v_invoice.discount_amount)
    else 1
  end;

  insert into public.sales_returns (sales_invoice_id, customer_id, total_amount, notes, created_by)
  values (p_sales_invoice_id, v_invoice.customer_id, 0, p_notes, auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_unit_name := v_item->>'unit_name';
    v_qty := (v_item->>'quantity')::numeric;

    select sum(quantity), sum(line_total), sum(actual_cost)
    into v_orig_qty, v_orig_amount, v_orig_cost
    from public.sales_invoice_items
    where invoice_id = p_sales_invoice_id and product_id = v_product_id and unit_name = v_unit_name;

    if v_orig_qty is null then
      raise exception 'الصنف ده مش موجود في الفاتورة بالوحدة المحددة';
    end if;

    select coalesce(sum(sri.quantity), 0) into v_already
    from public.sales_return_items sri
    join public.sales_returns sr on sr.id = sri.return_id
    where sr.sales_invoice_id = p_sales_invoice_id
      and sri.product_id = v_product_id
      and sri.unit_name = v_unit_name;

    if (v_already + v_qty) > v_orig_qty then
      raise exception 'الكمية المرتجعة أكبر من الكمية المباعة فعليًا لهذا الصنف';
    end if;

    v_factor := coalesce(public.unit_factor(v_product_id, v_unit_name), 1);
    v_base_qty := v_qty * v_factor;

    v_unit_refund := round((v_orig_amount / v_orig_qty) * v_ratio, 2);
    v_line_total := round(v_unit_refund * v_qty, 2);
    v_line_cost := round((v_orig_cost / v_orig_qty) * v_qty, 2);
    -- تكلفة الوحدة الأساسية الحقيقية اللي اتباعت بيها (مرجّحة بالكمية، مش متوسط بسيط)
    v_cost_per_base := v_orig_cost / (v_orig_qty * v_factor);

    insert into public.sales_return_items
      (return_id, product_id, unit_name, quantity, unit_price, line_total, cost_amount)
    values
      (v_return_id, v_product_id, v_unit_name, v_qty, v_unit_refund, v_line_total, v_line_cost);

    insert into public.inventory_lots
      (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining)
    values
      (v_product_id, v_invoice.warehouse_id, 'return', v_return_id, v_cost_per_base, v_base_qty, v_base_qty);

    insert into public.inventory (product_id, warehouse_id, quantity)
    values (v_product_id, v_invoice.warehouse_id, v_base_qty)
    on conflict (product_id, warehouse_id)
    do update set quantity = public.inventory.quantity + v_base_qty, updated_at = now();

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_invoice.warehouse_id, 'adjustment', v_base_qty, v_return_id, auth.uid());

    v_total := v_total + v_line_total;
    v_cost_total := v_cost_total + v_line_cost;
  end loop;

  -- الجزء اللي بيقابل دين فعلي على العميل بينقص من رصيده، والباقي بيترد نقدًا من الخزنة
  select coalesce(sum(total_amount), 0) into v_prev_returns
  from public.sales_returns
  where sales_invoice_id = p_sales_invoice_id and id <> v_return_id;

  v_debt_cut := 0;
  if v_invoice.customer_id is not null then
    select balance into v_balance from public.customers where id = v_invoice.customer_id for update;
    v_debt_cut := least(
      greatest(v_invoice.total_amount - v_invoice.paid_amount - v_prev_returns, 0)
        - greatest(v_invoice.total_amount - v_invoice.paid_amount - v_prev_returns - v_total, 0),
      greatest(coalesce(v_balance, 0), 0)
    );
    if v_debt_cut > 0 then
      update public.customers set balance = balance - v_debt_cut where id = v_invoice.customer_id;
    end if;
  end if;

  v_cash := v_total - v_debt_cut;

  update public.sales_returns
  set total_amount = v_total, cash_refund = v_cash, cost_amount = v_cost_total
  where id = v_return_id;

  if v_cash > 0 then
    insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
    values ('sale_in', -v_cash, v_return_id, 'استرداد مرتجع فاتورة رقم ' || v_invoice.invoice_number, auth.uid());
  end if;

  perform public.notify('تم تسجيل مرتجع بيع لفاتورة رقم ' || v_invoice.invoice_number);

  return v_return_id;
end;
$function$;


-- ---------- مرتجع طلبية ----------

create or replace function public.create_order_return(p_order_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order record;
  v_return_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_unit_name text;
  v_qty numeric;
  v_base_qty numeric;
  v_orig_qty numeric;
  v_orig_amount numeric;
  v_already numeric;
  v_factor numeric;
  v_ratio numeric;
  v_unit_refund numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_lot record;
  v_needed numeric;
  v_take numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لازم تحدد صنف واحد على الأقل بكمية أكبر من صفر للمرتجع';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where (i->>'product_id') is null
       or (i->>'unit_name') is null
       or coalesce((i->>'quantity')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات المرتجع غير صحيحة: الصنف والوحدة مطلوبين والكمية لازم تكون أكبر من صفر';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'الطلبية غير موجودة';
  end if;

  v_ratio := case
    when (v_order.total_cost + v_order.discount_amount) > 0
      then v_order.total_cost / (v_order.total_cost + v_order.discount_amount)
    else 1
  end;

  insert into public.order_returns (order_id, warehouse_id, total_amount, notes, created_by)
  values (p_order_id, v_order.warehouse_id, 0, p_notes, auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_unit_name := v_item->>'unit_name';
    v_qty := (v_item->>'quantity')::numeric;

    select sum(quantity), sum(line_total) into v_orig_qty, v_orig_amount
    from public.order_items
    where order_id = p_order_id and product_id = v_product_id and unit_name = v_unit_name;

    if v_orig_qty is null then
      raise exception 'الصنف ده مش موجود في الطلبية بالوحدة المحددة';
    end if;

    select coalesce(sum(ori.quantity), 0) into v_already
    from public.order_return_items ori
    join public.order_returns orr on orr.id = ori.return_id
    where orr.order_id = p_order_id
      and ori.product_id = v_product_id
      and ori.unit_name = v_unit_name;

    if (v_already + v_qty) > v_orig_qty then
      raise exception 'الكمية المرتجعة أكبر من الكمية المشتراة فعليًا لهذا الصنف';
    end if;

    v_factor := coalesce(public.unit_factor(v_product_id, v_unit_name), 1);
    v_base_qty := v_qty * v_factor;

    v_unit_refund := round((v_orig_amount / v_orig_qty) * v_ratio, 2);
    v_line_total := round(v_unit_refund * v_qty, 2);

    -- نرجّع الكمية من دفعات نفس الطلبية دي بالتحديد (مش أي دفعة تانية)
    v_needed := v_base_qty;
    for v_lot in
      select id, quantity_remaining from public.inventory_lots
      where source_type = 'order' and source_id = p_order_id and product_id = v_product_id
        and quantity_remaining > 0
      order by created_at asc
      for update
    loop
      exit when v_needed <= 0;
      v_take := least(v_lot.quantity_remaining, v_needed);
      update public.inventory_lots set quantity_remaining = quantity_remaining - v_take where id = v_lot.id;
      v_needed := v_needed - v_take;
    end loop;

    if v_needed > 0 then
      raise exception 'لا يمكن إرجاع كمية أكبر من المتوفر فعليًا من هذه الطلبية في المخزون';
    end if;

    insert into public.order_return_items
      (return_id, product_id, unit_name, quantity, unit_cost, line_total)
    values
      (v_return_id, v_product_id, v_unit_name, v_qty, v_unit_refund, v_line_total);

    update public.inventory
    set quantity = quantity - v_base_qty, updated_at = now()
    where product_id = v_product_id and warehouse_id = v_order.warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_order.warehouse_id, 'adjustment', -v_base_qty, v_return_id, auth.uid());

    v_total := v_total + v_line_total;
  end loop;

  update public.order_returns set total_amount = v_total where id = v_return_id;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values ('purchase_out', v_total, v_return_id, 'مرتجع طلبية رقم ' || v_order.order_number, auth.uid());

  perform public.notify('تم تسجيل مرتجع لطلبية رقم ' || v_order.order_number);

  return v_return_id;
end;
$function$;


-- ---------- إلغاء فاتورة بيع ----------

create or replace function public.void_sale_invoice(p_invoice_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_invoice record;
  v_item record;
  v_usage record;
  v_mov record;
  v_has_movements boolean := false;
  v_base_qty numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_invoice from public.sales_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'الفاتورة غير موجودة أو تم إلغاؤها بالفعل';
  end if;

  if exists (select 1 from public.sales_returns where sales_invoice_id = p_invoice_id) then
    raise exception 'مينفعش تلغي فاتورة عليها مرتجعات. المرتجع اتسجّل بالفعل، فالفاتورة اتعدّلت فعليًا';
  end if;

  -- لقطة من الفاتورة قبل ما تتمسح
  insert into public.cancelled_documents (doc_type, doc_number, doc_id, snapshot, cancelled_by)
  values (
    'sale_invoice', v_invoice.invoice_number, v_invoice.id,
    jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'items', coalesce(
        (select jsonb_agg(to_jsonb(i)) from public.sales_invoice_items i where i.invoice_id = p_invoice_id),
        '[]'::jsonb)
    ),
    auth.uid()
  );

  -- رجّع الكمية بالظبط لنفس الدفعات اللي اتاخدت منها
  for v_usage in
    select u.* from public.sale_item_lot_usage u
    join public.sales_invoice_items i on i.id = u.sale_invoice_item_id
    where i.invoice_id = p_invoice_id
  loop
    update public.inventory_lots
    set quantity_remaining = quantity_remaining + v_usage.quantity
    where id = v_usage.lot_id;
  end loop;

  -- رجّع المخزون من حركات البيع المسجّلة فعلًا (مش من معامل الوحدة الحالي)
  for v_mov in
    select product_id, -sum(quantity) as qty
    from public.inventory_movements
    where reference_id = p_invoice_id and movement_type = 'sale' and warehouse_id = v_invoice.warehouse_id
    group by product_id
  loop
    v_has_movements := true;

    insert into public.inventory (product_id, warehouse_id, quantity)
    values (v_mov.product_id, v_invoice.warehouse_id, v_mov.qty)
    on conflict (product_id, warehouse_id)
    do update set quantity = public.inventory.quantity + v_mov.qty, updated_at = now();

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_mov.product_id, v_invoice.warehouse_id, 'adjustment', v_mov.qty, p_invoice_id, auth.uid());
  end loop;

  -- فواتير قديمة من غير حركات مسجّلة: نرجع للطريقة القديمة (معامل الوحدة)
  if not v_has_movements then
    for v_item in select * from public.sales_invoice_items where invoice_id = p_invoice_id
    loop
      v_base_qty := v_item.quantity * coalesce(public.unit_factor(v_item.product_id, v_item.unit_name), 1);

      insert into public.inventory (product_id, warehouse_id, quantity)
      values (v_item.product_id, v_invoice.warehouse_id, v_base_qty)
      on conflict (product_id, warehouse_id)
      do update set quantity = public.inventory.quantity + v_base_qty, updated_at = now();

      insert into public.inventory_movements
        (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
      values
        (v_item.product_id, v_invoice.warehouse_id, 'adjustment', v_base_qty, p_invoice_id, auth.uid());
    end loop;
  end if;

  if v_invoice.customer_id is not null then
    update public.customers
    set balance = balance - (v_invoice.total_amount - v_invoice.paid_amount)
    where id = v_invoice.customer_id;
  end if;

  if v_invoice.paid_amount > 0 then
    insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
    values ('sale_in', -v_invoice.paid_amount, p_invoice_id,
            'إلغاء فاتورة بيع رقم ' || v_invoice.invoice_number, auth.uid());
  end if;

  perform public.notify('تم إلغاء فاتورة بيع رقم ' || v_invoice.invoice_number);

  delete from public.sales_invoice_items where invoice_id = p_invoice_id; -- بيمسح sale_item_lot_usage تلقائيًا (Cascade)
  delete from public.sales_invoices where id = p_invoice_id;
end;
$function$;


-- ---------- إلغاء طلبية ----------

create or replace function public.void_order(p_order_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order record;
  v_lot record;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'الطلبية غير موجودة أو تم إلغاؤها بالفعل';
  end if;

  if exists (select 1 from public.order_returns where order_id = p_order_id) then
    raise exception 'مينفعش تلغي طلبية عليها مرتجعات. المرتجع اتسجّل بالفعل، فالطلبية اتعدّلت فعليًا';
  end if;

  for v_lot in
    select * from public.inventory_lots
    where source_type = 'order' and source_id = p_order_id
    for update
  loop
    if v_lot.quantity_remaining < v_lot.quantity_received then
      raise exception 'لا يمكن إلغاء الطلبية: جزء من الكمية تم بيعه بالفعل من المخزون';
    end if;
  end loop;

  insert into public.cancelled_documents (doc_type, doc_number, doc_id, snapshot, cancelled_by)
  values (
    'order', v_order.order_number, v_order.id,
    jsonb_build_object(
      'order', to_jsonb(v_order),
      'items', coalesce(
        (select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id = p_order_id),
        '[]'::jsonb)
    ),
    auth.uid()
  );

  for v_lot in select * from public.inventory_lots where source_type = 'order' and source_id = p_order_id
  loop
    update public.inventory
    set quantity = quantity - v_lot.quantity_remaining, updated_at = now()
    where product_id = v_lot.product_id and warehouse_id = v_lot.warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_lot.product_id, v_lot.warehouse_id, 'adjustment', -v_lot.quantity_remaining, p_order_id, auth.uid());
  end loop;

  delete from public.inventory_lots where source_type = 'order' and source_id = p_order_id;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values ('purchase_out', v_order.total_cost, p_order_id, 'إلغاء طلبية رقم ' || v_order.order_number, auth.uid());

  perform public.notify('تم إلغاء طلبية رقم ' || v_order.order_number);

  delete from public.order_items where order_id = p_order_id;
  delete from public.orders where id = p_order_id;
end;
$function$;


-- ---------- الدفعات ----------

create or replace function public.record_payment(p_party_type party_type, p_party_id uuid, p_direction payment_direction, p_amount numeric, p_notes text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_payment_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'المبلغ يجب أن يكون أكبر من صفر';
  end if;

  -- جدول الموردين اتشال من النظام، فالدفعات للعملاء بس
  if p_party_type <> 'customer' then
    raise exception 'الدفعات مدعومة للعملاء فقط';
  end if;

  perform 1 from public.customers where id = p_party_id for update;
  if not found then
    raise exception 'العميل غير موجود';
  end if;

  insert into public.payments (party_type, party_id, direction, amount, notes, created_by)
  values (p_party_type, p_party_id, p_direction, p_amount, p_notes, auth.uid())
  returning id into v_payment_id;

  -- تحصيل (in) بينقص مديونية العميل، وصرف (out) له بيزوّدها
  update public.customers
  set balance = balance + case when p_direction = 'in' then -p_amount else p_amount end
  where id = p_party_id;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values (
    (case when p_direction = 'in' then 'payment_in' else 'payment_out' end)::treasury_type,
    case when p_direction = 'in' then p_amount else -p_amount end,
    v_payment_id, p_notes, auth.uid()
  );

  return v_payment_id;
end;
$function$;


-- ---------- الجرد ----------

create or replace function public.apply_stocktake(p_warehouse_id uuid, p_notes text, p_items jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_stocktake_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_counted numeric;
  v_system numeric;
  v_diff numeric;
  v_remaining_needed numeric;
  v_take numeric;
  v_lot record;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_warehouse_id is null or not exists (select 1 from public.warehouses where id = p_warehouse_id) then
    raise exception 'المخزن غير موجود';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لا توجد أصناف للجرد';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where (i->>'product_id') is null
       or coalesce((i->>'counted_quantity')::numeric, -1) < 0
  ) then
    raise exception 'بيانات الجرد غير صحيحة: الصنف مطلوب والكمية المعدودة لازم تكون صفر أو أكتر';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) i
    group by i->>'product_id' having count(*) > 1
  ) then
    raise exception 'فيه صنف مكرر في الجرد';
  end if;

  insert into public.stocktakes (warehouse_id, notes, created_by)
  values (p_warehouse_id, p_notes, auth.uid())
  returning id into v_stocktake_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_counted := (v_item->>'counted_quantity')::numeric;

    select coalesce(quantity, 0) into v_system
    from public.inventory
    where product_id = v_product_id and warehouse_id = p_warehouse_id
    for update;

    v_system := coalesce(v_system, 0);
    v_diff := v_counted - v_system;

    insert into public.stocktake_items
      (stocktake_id, product_id, system_quantity, counted_quantity, difference)
    values
      (v_stocktake_id, v_product_id, v_system, v_counted, v_diff);

    if v_diff > 0 then
      -- زيادة: دفعة جديدة بسعر التكلفة الحالي كأفضل تقدير
      insert into public.inventory_lots
        (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining)
      values
        (v_product_id, p_warehouse_id, 'stocktake', v_stocktake_id,
         (select cost_price from public.products where id = v_product_id), v_diff, v_diff);

      insert into public.inventory (product_id, warehouse_id, quantity)
      values (v_product_id, p_warehouse_id, v_diff)
      on conflict (product_id, warehouse_id)
      do update set quantity = public.inventory.quantity + v_diff, updated_at = now();

    elsif v_diff < 0 then
      -- نقص: استهلاك FIFO من الدفعات الموجودة فعليًا (تلف/فقد)
      v_remaining_needed := abs(v_diff);

      for v_lot in
        select id, quantity_remaining from public.inventory_lots
        where product_id = v_product_id and warehouse_id = p_warehouse_id and quantity_remaining > 0
        order by created_at asc
        for update
      loop
        exit when v_remaining_needed <= 0;
        v_take := least(v_lot.quantity_remaining, v_remaining_needed);
        update public.inventory_lots set quantity_remaining = quantity_remaining - v_take where id = v_lot.id;
        v_remaining_needed := v_remaining_needed - v_take;
      end loop;

      update public.inventory
      set quantity = quantity + v_diff, updated_at = now()
      where product_id = v_product_id and warehouse_id = p_warehouse_id;
    end if;

    if v_diff <> 0 then
      insert into public.inventory_movements
        (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
      values
        (v_product_id, p_warehouse_id, 'adjustment', v_diff, v_stocktake_id, auth.uid());
    end if;
  end loop;

  perform public.notify('تم عمل جرد مخزون وتسوية الفروقات');

  return v_stocktake_id;
end;
$function$;


-- ---------- المخزن الافتراضي ----------

create or replace function public.set_default_warehouse(p_warehouse_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_warehouse_id is null or not exists (select 1 from public.warehouses where id = p_warehouse_id) then
    raise exception 'المخزن غير موجود';
  end if;

  update public.warehouses set is_default = false where is_default = true;
  update public.warehouses set is_default = true where id = p_warehouse_id;
end;
$function$;


-- ---------- الإشعارات وسجل الأنشطة: المستخدم المفعّل بس ----------

create or replace function public.log_activity(p_action text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_name text;
begin
  if not public.is_active_user() then
    return;
  end if;

  select full_name into v_name from public.users where id = auth.uid();
  insert into public.activity_log (user_id, user_name, action)
  values (auth.uid(), v_name, p_action);
end;
$function$;

create or replace function public.notify(p_message text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_name text;
begin
  if not public.is_active_user() then
    return;
  end if;

  insert into public.notifications (message, created_by)
  values (p_message, auth.uid());

  select full_name into v_name from public.users where id = auth.uid();
  insert into public.activity_log (user_id, user_name, action)
  values (auth.uid(), v_name, p_message);
end;
$function$;


-- ---------- دالة ميتة (مش متوصلة بأي trigger ومفيش جدول فواتير شراء) ----------

drop function if exists public.trg_notify_purchase();
