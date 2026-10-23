-- ============================================================================
-- اسم العميل النقدي على الفاتورة (فوق 20261018000001)
--
-- الفاتورة النقدية كانت بتتسجّل "عميل نقدي" من غير أي طريقة نعرف بيها الفاتورة دي لمين.
--  1) sales_invoices.customer_name: اسم اختياري للعميل النقدي (مش حساب ومفيهوش رصيد).
--  2) create_sale_invoice بقت بتاخد p_customer_name (آخر باراميتر، افتراضيه null)، فالنداءات
--     القديمة بتشتغل. الاسم بيتخزّن بس لو مفيش عميل مسجّل، وبيتقص لـ 120 حرف.
--
-- ملحوظة: الدالة القديمة (بـ 5 باراميترز) بتتمسح الأول، عشان وجود نسختين بنفس الاسم
-- كان هيعمل لبس في النداء.
-- جرّب على نسخة تجريبية الأول وشغّل: npm run test:db
-- ============================================================================

alter table public.sales_invoices add column if not exists customer_name text;

alter table public.sales_invoices drop constraint if exists sales_invoices_customer_name_length;
alter table public.sales_invoices
  add constraint sales_invoices_customer_name_length check (customer_name is null or char_length(customer_name) <= 120);

drop function if exists public.create_sale_invoice(uuid, uuid, jsonb, numeric, numeric);

create or replace function public.create_sale_invoice(p_customer_id uuid, p_warehouse_id uuid, p_items jsonb, p_paid_amount numeric, p_discount_amount numeric DEFAULT 0, p_customer_name text DEFAULT NULL)
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
  v_customer_name text;
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

  -- اسم العميل النقدي (للمعرفة بس، مش حساب): بيتخزّن لو مفيش عميل مسجّل
  v_customer_name := case
    when p_customer_id is null then nullif(left(btrim(coalesce(p_customer_name, '')), 120), '')
    else null
  end;

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
    (invoice_number, customer_id, customer_name, warehouse_id, total_amount, paid_amount, discount_amount, payment_status, created_by)
  values
    (v_invoice_number, p_customer_id, v_customer_name, p_warehouse_id, v_total, p_paid_amount, v_discount, v_status, auth.uid())
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

revoke all on function public.create_sale_invoice(uuid, uuid, jsonb, numeric, numeric, text) from public, anon;
grant execute on function public.create_sale_invoice(uuid, uuid, jsonb, numeric, numeric, text) to authenticated;
