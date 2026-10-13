-- ============================================================================
-- تحقق من المدخلات على مستوى السيرفر (الدوال نفسها)
--
-- اكتُشفت بتجربة حقيقية على نسخة من القاعدة: استدعاء الدالة مباشرة (من غير الواجهة) كان بيقبل:
--  1) خصم أكبر من إجمالي الفاتورة (فاتورة بصفر جنيه والمخزون بيتخصم، والخصم المسجّل أكبر من الحقيقي)
--  2) معامل تحويل = صفر (بيع من غير ما المخزون يتخصم خالص)
--  3) صنف بكمية سالبة جنب صنف عادي (بيزوّد المخزون بدل ما يخصم)
-- الواجهة بقت بتمنع الحالات دي، وده بيحميها من السيرفر كمان. باقي جسم كل دالة زي ما هو بالظبط.
-- الصلاحيات (grants) محفوظة لأن create or replace مبيغيّرهاش.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_sale_invoice(p_customer_id uuid, p_warehouse_id uuid, p_items jsonb, p_paid_amount numeric, p_discount_amount numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice_id uuid;
  v_invoice_number text;
  v_seq int;
  v_subtotal numeric := 0;
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

  -- تحقق من المدخلات على السيرفر (الواجهة بتتحقق كمان، لكن أي نداء مباشر للدالة لازم يتفحص برضه)
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'لا يمكن إنشاء فاتورة بدون أصناف';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where coalesce((i->>'quantity')::numeric, 0) <= 0
       or coalesce((i->>'unit_price')::numeric, -1) < 0
       or coalesce((i->>'conversion_factor')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات الأصناف غير صحيحة: الكمية ومعامل التحويل لازم يكونوا أكبر من صفر، والسعر مينفعش يكون سالب';
  end if;

  update public.company_settings
  set next_sales_invoice_number = next_sales_invoice_number + 1
  where id = true
  returning next_sales_invoice_number - 1 into v_seq;

  v_invoice_number := 'S-' || lpad(v_seq::text, 6, '0');

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
  into v_subtotal
  from jsonb_array_elements(p_items) i;

  if v_subtotal <= 0 then
    raise exception 'لا يمكن إنشاء فاتورة بدون أصناف';
  end if;

  if coalesce(p_discount_amount, 0) < 0 or coalesce(p_discount_amount, 0) > v_subtotal then
    raise exception 'الخصم لازم يكون بين صفر وإجمالي الفاتورة قبل الخصم';
  end if;

  v_total := greatest(v_subtotal - coalesce(p_discount_amount, 0), 0);

  if p_paid_amount is null or p_paid_amount < 0 or p_paid_amount > v_total then
    raise exception 'المبلغ المدفوع لازم يكون بين صفر وإجمالي الفاتورة بعد الخصم';
  end if;

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
    (v_invoice_number, p_customer_id, p_warehouse_id, v_total, p_paid_amount, coalesce(p_discount_amount, 0), v_status, auth.uid())
  returning id into v_invoice_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_line_total := (v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric;
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

CREATE OR REPLACE FUNCTION public.create_order(p_warehouse_id uuid, p_notes text, p_items jsonb, p_discount_amount numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order_id uuid;
  v_order_number text;
  v_seq int;
  v_subtotal numeric := 0;
  v_total numeric;
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
    where coalesce((i->>'quantity')::numeric, 0) <= 0
       or coalesce((i->>'unit_cost')::numeric, -1) < 0
       or coalesce((i->>'conversion_factor')::numeric, 0) <= 0
  ) then
    raise exception 'بيانات الأصناف غير صحيحة: الكمية ومعامل التحويل لازم يكونوا أكبر من صفر، والتكلفة مينفعش تكون سالبة';
  end if;

  update public.company_settings
  set next_order_number = next_order_number + 1
  where id = true
  returning next_order_number - 1 into v_seq;

  v_order_number := 'O-' || lpad(v_seq::text, 6, '0');

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_cost')::numeric), 0)
  into v_subtotal
  from jsonb_array_elements(p_items) i;

  if v_subtotal <= 0 then
    raise exception 'لا يمكن إنشاء طلبية بدون أصناف';
  end if;

  if coalesce(p_discount_amount, 0) < 0 or coalesce(p_discount_amount, 0) > v_subtotal then
    raise exception 'الخصم لازم يكون بين صفر وإجمالي الطلبية قبل الخصم';
  end if;

  v_total := greatest(v_subtotal - coalesce(p_discount_amount, 0), 0);

  insert into public.orders (order_number, warehouse_id, status, total_cost, discount_amount, notes, created_by)
  values (v_order_number, p_warehouse_id, 'received', v_total, coalesce(p_discount_amount, 0), p_notes, auth.uid())
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_line_total := (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric;
    v_base_qty := (v_item->>'quantity')::numeric * (v_item->>'conversion_factor')::numeric;
    v_unit_cost_per_base := v_line_total / greatest(v_base_qty, 0.0001);
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

CREATE OR REPLACE FUNCTION public.apply_stocktake(p_warehouse_id uuid, p_notes text, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if p_items is not null and exists (
    select 1 from jsonb_array_elements(p_items) i
    where coalesce((i->>'counted_quantity')::numeric, -1) < 0
  ) then
    raise exception 'الكمية المعدودة لازم تكون صفر أو أكتر';
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
    where product_id = v_product_id and warehouse_id = p_warehouse_id;

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

-- معامل تحويل الوحدات الإضافية لازم يكون أكبر من صفر
alter table public.product_units
  add constraint product_units_factor_positive check (conversion_factor > 0) not valid;
-- لو القيد ده رجّع خطأ عند VALIDATE يبقى فيه وحدة قديمة بمعامل صفر أو سالب (تتصلح الأول):
-- select * from public.product_units where conversion_factor <= 0;
-- alter table public.product_units validate constraint product_units_factor_positive;
