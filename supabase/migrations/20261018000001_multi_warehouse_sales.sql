-- ============================================================================
-- فاتورة بيع من أكتر من مخزن (فوق 20261016000001)
--
-- قبل كده الفاتورة كانت على مخزن واحد. دلوقتي كل سطر في الفاتورة له مخزنه:
--  1) sales_invoice_items.warehouse_id و sales_return_items.warehouse_id (الصفوف القديمة بتتعبّى
--     من مخزن فاتورتها).
--  2) create_sale_invoice: كل صنف بيتباع (وبيتخصم من مخزونه ودفعاته) من مخزنه. لو السطر مفيهوش
--     warehouse_id بيتباع من مخزن الفاتورة (p_warehouse_id) زي الأول، فالنداءات القديمة بتشتغل.
--  3) void_sale_invoice: بيرجّع كل صنف لمخزنه الفعلي من حركات المخزون.
--  4) create_sales_return: المرتجع بيرجع للمخزن اللي اتباع منه الصنف، والكمية المرتجعة بتتقارن
--     بالمباع من نفس المخزن.
--  sales_invoices.warehouse_id بيفضل موجود كمخزن "أساسي" للفاتورة (الأول أو المختار وقت البيع).
--
-- جرّب على نسخة تجريبية الأول وشغّل: npm run test:db
-- ============================================================================

alter table public.sales_invoice_items add column if not exists warehouse_id uuid references public.warehouses(id);
alter table public.sales_return_items add column if not exists warehouse_id uuid references public.warehouses(id);

update public.sales_invoice_items i
set warehouse_id = inv.warehouse_id
from public.sales_invoices inv
where i.invoice_id = inv.id and i.warehouse_id is null;

update public.sales_return_items ri
set warehouse_id = inv.warehouse_id
from public.sales_returns sr
join public.sales_invoices inv on inv.id = sr.sales_invoice_id
where ri.return_id = sr.id and ri.warehouse_id is null;

alter table public.sales_invoice_items alter column warehouse_id set not null;
alter table public.sales_return_items alter column warehouse_id set not null;

create index if not exists idx_sales_invoice_items_warehouse on public.sales_invoice_items (warehouse_id);


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
  v_wh uuid;
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
  -- كل صنف ممكن يتباع من مخزن مختلف (warehouse_id على السطر). لو مفيش، بيتباع من مخزن الفاتورة
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where nullif(i->>'warehouse_id', '') is not null
      and not exists (select 1 from public.warehouses w where w.id = (i->>'warehouse_id')::uuid)
  ) then
    raise exception 'مخزن أحد الأصناف غير موجود';
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
    v_wh := coalesce(nullif(v_item->>'warehouse_id', '')::uuid, p_warehouse_id);
    v_line_total := round((v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric, 2);
    v_base_qty := (v_item->>'quantity')::numeric * public.unit_factor_strict(v_product_id, v_item->>'unit_name');

    select quantity into v_current_qty
    from public.inventory
    where product_id = v_product_id and warehouse_id = v_wh
    for update;

    if v_current_qty is null or v_current_qty < v_base_qty then
      raise exception 'الكمية غير متوفرة في المخزون لأحد الأصناف';
    end if;

    insert into public.sales_invoice_items
      (invoice_id, product_id, warehouse_id, unit_name, quantity, unit_price, line_total)
    values
      (v_invoice_id, v_product_id, v_wh, v_item->>'unit_name',
       (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric, v_line_total)
    returning id into v_item_id;

    -- استهلاك الدفعات الأقدم أولًا (FIFO) وتسجيل التكلفة الحقيقية
    v_remaining_needed := v_base_qty;
    v_item_cost := 0;

    for v_lot in
      select id, quantity_remaining, unit_cost from public.inventory_lots
      where product_id = v_product_id and warehouse_id = v_wh and quantity_remaining > 0
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
    where product_id = v_product_id and warehouse_id = v_wh;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_wh, 'sale', -v_base_qty, v_invoice_id, auth.uid());
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


-- ---------- إلغاء فاتورة بيع ----------

create or replace function public.void_sale_invoice(p_invoice_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_balance numeric;
  v_debt numeric;
  v_reduce numeric := 0;
  v_extra_refund numeric := 0;
  v_refund numeric;
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
    select product_id, warehouse_id, -sum(quantity) as qty
    from public.inventory_movements
    where reference_id = p_invoice_id and movement_type = 'sale'
    group by product_id, warehouse_id
  loop
    v_has_movements := true;

    insert into public.inventory (product_id, warehouse_id, quantity)
    values (v_mov.product_id, v_mov.warehouse_id, v_mov.qty)
    on conflict (product_id, warehouse_id)
    do update set quantity = public.inventory.quantity + v_mov.qty, updated_at = now();

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_mov.product_id, v_mov.warehouse_id, 'adjustment', v_mov.qty, p_invoice_id, auth.uid());
  end loop;

  -- فواتير قديمة من غير حركات مسجّلة: نرجع للطريقة القديمة (معامل الوحدة)
  if not v_has_movements then
    for v_item in select * from public.sales_invoice_items where invoice_id = p_invoice_id
    loop
      v_base_qty := v_item.quantity * coalesce(public.unit_factor(v_item.product_id, v_item.unit_name), 1);

      insert into public.inventory (product_id, warehouse_id, quantity)
      values (v_item.product_id, v_item.warehouse_id, v_base_qty)
      on conflict (product_id, warehouse_id)
      do update set quantity = public.inventory.quantity + v_base_qty, updated_at = now();

      insert into public.inventory_movements
        (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
      values
        (v_item.product_id, v_item.warehouse_id, 'adjustment', v_base_qty, p_invoice_id, auth.uid());
    end loop;
  end if;

  -- الدين اللي الفاتورة عملته بيتشال من رصيد العميل، بس لحد ما الرصيد يوصل صفر. اللي زاد معناه إن
  -- العميل سدّد جزء منه بعد الفاتورة، فبيترد له نقدًا (والرصيد مينزلش تحت صفر).
  if v_invoice.customer_id is not null then
    select balance into v_balance from public.customers where id = v_invoice.customer_id for update;
    v_debt := v_invoice.total_amount - v_invoice.paid_amount;
    v_reduce := greatest(least(v_debt, v_balance), 0);
    v_extra_refund := greatest(v_debt - v_reduce, 0);
    update public.customers set balance = balance - v_reduce where id = v_invoice.customer_id;
  end if;

  v_refund := v_invoice.paid_amount + v_extra_refund;
  if v_refund > 0 then
    insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
    values ('sale_in', -v_refund, p_invoice_id,
            'إلغاء فاتورة بيع رقم ' || v_invoice.invoice_number, auth.uid());
  end if;

  perform public.notify('تم إلغاء فاتورة بيع رقم ' || v_invoice.invoice_number);

  delete from public.sales_invoice_items where invoice_id = p_invoice_id; -- بيمسح sale_item_lot_usage تلقائيًا (Cascade)
  delete from public.sales_invoices where id = p_invoice_id;
end;
$function$;


-- ---------- مرتجع بيع ----------

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
  v_wh uuid;
  v_wh_count int;
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

    -- المخزن اللي هيرجع له الصنف: اللي بعتّه الواجهة، أو مخزن السطر الأصلي لو الصنف اتباع من مخزن واحد بس
    v_wh := nullif(v_item->>'warehouse_id', '')::uuid;
    if v_wh is null then
      select count(distinct warehouse_id), min(warehouse_id::text)::uuid into v_wh_count, v_wh
      from public.sales_invoice_items
      where invoice_id = p_sales_invoice_id and product_id = v_product_id and unit_name = v_unit_name;
      if v_wh_count > 1 then
        raise exception 'الصنف ده اتباع من أكتر من مخزن، حدد المخزن اللي هيرجع له';
      end if;
    end if;

    select sum(quantity), sum(line_total), sum(actual_cost)
    into v_orig_qty, v_orig_amount, v_orig_cost
    from public.sales_invoice_items
    where invoice_id = p_sales_invoice_id and product_id = v_product_id and unit_name = v_unit_name
      and warehouse_id = v_wh;

    if v_orig_qty is null then
      raise exception 'الصنف ده مش موجود في الفاتورة بالوحدة المحددة';
    end if;

    select coalesce(sum(sri.quantity), 0) into v_already
    from public.sales_return_items sri
    join public.sales_returns sr on sr.id = sri.return_id
    where sr.sales_invoice_id = p_sales_invoice_id
      and sri.product_id = v_product_id
      and sri.unit_name = v_unit_name
      and sri.warehouse_id = v_wh;

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
      (return_id, product_id, warehouse_id, unit_name, quantity, unit_price, line_total, cost_amount)
    values
      (v_return_id, v_product_id, v_wh, v_unit_name, v_qty, v_unit_refund, v_line_total, v_line_cost);

    insert into public.inventory_lots
      (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining)
    values
      (v_product_id, v_wh, 'return', v_return_id, v_cost_per_base, v_base_qty, v_base_qty);

    insert into public.inventory (product_id, warehouse_id, quantity)
    values (v_product_id, v_wh, v_base_qty)
    on conflict (product_id, warehouse_id)
    do update set quantity = public.inventory.quantity + v_base_qty, updated_at = now();

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_wh, 'adjustment', v_base_qty, v_return_id, auth.uid());

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
