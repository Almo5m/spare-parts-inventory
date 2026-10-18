-- ============================================================================
-- قواعد الأرصدة والتكاليف الدقيقة (فوق migration 20261015000001)
--
-- اتجرّبت كل نقطة هنا على قاعدة تجريبية قبل الإصلاح (supabase/tests/db_full_flows.py).
-- اللي بيعمله الملف ده وكان ناقص بعد 20261015000001:
--
--  1) رصيد العميل مينزلش تحت صفر أبدًا (مفيش عميل إحنا مدينين له):
--     - record_payment كان بيقبل مبلغ أكبر من الدين (رصيد -600)، وتحصيل من عميل مفيهوش دين،
--       واتجاه "صرف" بيزوّد الدين. دلوقتي: التحصيل لحد قيمة الدين بس.
--     - void_sale_invoice لو العميل سدّد بعد الفاتورة كان بيخلّي رصيده سالب (-1000) والفلوس
--       اللي دفعها عالقة في الخزينة. دلوقتي بتترد له نقدًا والرصيد صفر.
--     - قيد CHECK على القاعدة نفسها كخط دفاع أخير.
--  2) معامل التحويل بيتحسب من السيرفر في البيع والطلبية (كان بيجي من الواجهة: معامل مزوّر 99
--     في طلبية زوّد المخزون 297 بدل 3). وأي وحدة مش معرّفة للصنف بتترفض بدل ما تتعامل كأنها قطعة.
--  3) create_order_return: الاسترداد من الخزينة بتكلفة الدفعات اللي اتسحب منها فعلًا. كان بيستخدم
--     متوسط سعر السطور فلو نفس الصنف اتشرى بسعرين الاسترداد بيزيد عن قيمة المخزون الخارج
--     (اتلقط بمعادلة الأصول: 8.55 جنيه زيادة في حالة 3@10 + 4@20).
--  4) apply_stocktake: زيادة الجرد كانت بتتسجّل بتكلفة cost_price (غالبًا صفر) فالربح بيتضخّم.
--     دلوقتي بمتوسط تكلفة الدفعات المتبقية.
--
-- جرّب على نسخة تجريبية الأول (بعد نسخة احتياطية) وشغّل npm run test:flows.
-- ============================================================================

-- ---------- معامل تحويل صارم للعمليات الجديدة (الوحدة لازم تكون معرّفة للصنف) ----------
-- unit_factor (اللي في 20261015000001) متسامح عمدًا لأنه بيتستخدم في الإلغاء والمرتجعات على عمليات
-- قديمة ممكن وحدتها اتمسحت. العمليات الجديدة لازم تكون صارمة.
create or replace function public.unit_factor_strict(p_product_id uuid, p_unit_name text)
returns numeric
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_base text;
  v_factor numeric;
begin
  select base_unit into v_base from public.products where id = p_product_id;
  if not found then
    raise exception 'الصنف غير موجود';
  end if;
  if p_unit_name is null or p_unit_name = v_base then
    return 1;
  end if;
  select conversion_factor into v_factor
  from public.product_units
  where product_id = p_product_id and unit_name = p_unit_name;
  if v_factor is null then
    raise exception 'الوحدة "%" مش معرّفة لهذا الصنف', p_unit_name;
  end if;
  return v_factor;
end;
$function$;

revoke all on function public.unit_factor_strict(uuid, text) from public, anon;
grant execute on function public.unit_factor_strict(uuid, text) to authenticated;


-- ---------- 1) record_payment: التحصيل لحد قيمة الدين بس ----------
create or replace function public.record_payment(p_party_type party_type, p_party_id uuid, p_direction payment_direction, p_amount numeric, p_notes text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_payment_id uuid;
  v_balance numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'المبلغ يجب أن يكون أكبر من صفر';
  end if;

  -- التحصيل من العملاء بس. مفيش أرصدة دائنة للعملاء في النظام، فمفيش "صرف" ليهم
  if p_party_type <> 'customer' or p_direction <> 'in' then
    raise exception 'التحصيل متاح من العملاء فقط';
  end if;

  select balance into v_balance from public.customers where id = p_party_id for update;
  if not found then
    raise exception 'العميل غير موجود';
  end if;

  if v_balance <= 0 then
    raise exception 'العميل ده مفيهوش مديونية';
  end if;

  if p_amount > v_balance then
    raise exception 'المبلغ (%) أكبر من مديونية العميل (%)', p_amount, v_balance;
  end if;

  insert into public.payments (party_type, party_id, direction, amount, notes, created_by)
  values (p_party_type, p_party_id, p_direction, p_amount, p_notes, auth.uid())
  returning id into v_payment_id;

  update public.customers set balance = balance - p_amount where id = p_party_id;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values ('payment_in', p_amount, v_payment_id, p_notes, auth.uid());

  return v_payment_id;
end;
$function$;


-- ---------- 2) create_sale_invoice: معامل التحويل من السيرفر ----------
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
    v_base_qty := (v_item->>'quantity')::numeric * public.unit_factor_strict(v_product_id, v_item->>'unit_name');

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


-- ---------- 2) create_order: معامل التحويل من السيرفر ----------
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
    v_base_qty := (v_item->>'quantity')::numeric * public.unit_factor_strict(v_product_id, v_item->>'unit_name');
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


-- ---------- 3) create_order_return: الاسترداد بتكلفة الدفعات الفعلية ----------
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
  v_lot_value numeric;
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

    -- الاسترداد بتكلفة الدفعات اللي هتتسحب منها فعلًا (مش متوسط سطور الطلبية): كده الخزينة والمخزون بيتطابقوا
    v_lot_value := 0;
    -- نرجّع الكمية من دفعات نفس الطلبية دي بالتحديد (مش أي دفعة تانية)
    v_needed := v_base_qty;
    for v_lot in
      select id, quantity_remaining, unit_cost from public.inventory_lots
      where source_type = 'order' and source_id = p_order_id and product_id = v_product_id
        and quantity_remaining > 0
      order by created_at asc
      for update
    loop
      exit when v_needed <= 0;
      v_take := least(v_lot.quantity_remaining, v_needed);
      update public.inventory_lots set quantity_remaining = quantity_remaining - v_take where id = v_lot.id;
      v_lot_value := v_lot_value + v_take * v_lot.unit_cost;
      v_needed := v_needed - v_take;
    end loop;

    if v_needed > 0 then
      raise exception 'لا يمكن إرجاع كمية أكبر من المتوفر فعليًا من هذه الطلبية في المخزون';
    end if;

    v_line_total := round(v_lot_value, 2);
    v_unit_refund := v_line_total / v_qty;

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


-- ---------- 1) void_sale_invoice: الفلوس اللي العميل دفعها (وقت البيع أو بعده) بترجع له والرصيد صفر ----------
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


-- ---------- 4) apply_stocktake: زيادة الجرد بمتوسط تكلفة فعلي ----------
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
      -- زيادة: دفعة جديدة بمتوسط تكلفة الدفعات المتبقية (أقرب تقدير للواقع). لو مفيش دفعات متبقية
      -- بنستخدم تكلفة آخر دفعة اتسجلت للصنف، وبعدها cost_price
      insert into public.inventory_lots
        (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining)
      values
        (v_product_id, p_warehouse_id, 'stocktake', v_stocktake_id,
         coalesce(
           (select sum(quantity_remaining * unit_cost) / nullif(sum(quantity_remaining), 0)
              from public.inventory_lots
              where product_id = v_product_id and warehouse_id = p_warehouse_id and quantity_remaining > 0),
           (select unit_cost from public.inventory_lots
              where product_id = v_product_id order by created_at desc limit 1),
           (select cost_price from public.products where id = v_product_id),
           0
         ), v_diff, v_diff);

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


-- ---------- القيد النهائي: رصيد العميل مينزلش تحت صفر ----------
-- NOT VALID: بيتطبق على أي كتابة جديدة فورًا ومبيعطّلش الصفوف القديمة. بس أي عميل رصيده سالب دلوقتي
-- مش هيقدر يتعدّل (حتى اسمه) ولا يتباع له لحد ما رصيده يتصلّح. شوف مين هو الأول:
--     select id, name, balance from public.customers where balance < 0;
-- لو دي بيانات تجريبية وعايز تصفّرها:
--     update public.customers set balance = 0 where balance < 0;
-- وبعدين:
--     alter table public.customers validate constraint customers_balance_non_negative;
alter table public.customers
  add constraint customers_balance_non_negative check (balance >= 0) not valid;
