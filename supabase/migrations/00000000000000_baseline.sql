-- ============================================================================
-- Baseline: الوضع الفعلي لقاعدة البيانات وقت التصدير (2026-10-12)
-- مصدره: supabase/export/export-definitions.sql على المشروع الشغّال.
-- ده تسجيل للي موجود فعلًا (من غير أي تحسين) — التحسينات في migrations لاحقة.
-- الترتيب: enums ← جداول ← قيود (PK/UNIQUE/CHECK ثم FK) ← فهارس ← دوال ← RLS ← سياسات ← triggers
-- (الدوال قبل السياسات لأن السياسات بتنادي is_active_user())
-- ============================================================================

set check_function_bodies = off;


-- ---------- enums ----------

create type public.inventory_movement_type as enum ('purchase', 'sale', 'transfer_in', 'transfer_out', 'adjustment');
create type public.order_status as enum ('pending', 'received', 'cancelled');
create type public.party_type as enum ('customer', 'supplier');
create type public.payment_direction as enum ('in', 'out');
create type public.payment_status as enum ('paid', 'partial', 'unpaid');
create type public.treasury_type as enum ('sale_in', 'purchase_out', 'payment_in', 'payment_out', 'expense', 'manual');
create type public.user_role as enum ('owner', 'warehouse_manager', 'sales', 'purchasing', 'accountant');

-- ---------- tables ----------

create table public.activity_log (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  user_name text,
  action text not null,
  is_read boolean not null default false,
  created_at timestamp with time zone not null default now()
);

create table public.audit_log (
  id uuid not null default gen_random_uuid(),
  user_id uuid,
  action text not null,
  table_name text,
  record_id uuid,
  details jsonb,
  created_at timestamp with time zone not null default now()
);

create table public.car_models (
  id uuid not null default gen_random_uuid(),
  brand text not null,
  model text not null,
  year_from integer,
  year_to integer
);

create table public.categories (
  id uuid not null default gen_random_uuid(),
  name text not null
);

create table public.company_settings (
  id boolean not null default true,
  company_name text not null default 'نظام إدارة المخزن'::text,
  phone text,
  logo_data_url text,
  invoice_footer_message text,
  next_sales_invoice_number integer not null default 1,
  next_order_number integer not null default 1,
  notify_low_stock boolean not null default true,
  notify_debts boolean not null default true
);

create table public.customers (
  id uuid not null default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  balance numeric(14,2) not null default 0,
  created_at timestamp with time zone not null default now()
);

create table public.inventory (
  product_id uuid not null,
  warehouse_id uuid not null,
  quantity numeric(14,4) not null default 0,
  updated_at timestamp with time zone not null default now()
);

create table public.inventory_lots (
  id uuid not null default gen_random_uuid(),
  product_id uuid not null,
  warehouse_id uuid not null,
  source_type text not null,
  source_id uuid,
  unit_cost numeric(12,2) not null,
  quantity_received numeric(14,4) not null,
  quantity_remaining numeric(14,4) not null,
  created_at timestamp with time zone not null default now(),
  default_sale_price numeric(12,2)
);

create table public.inventory_movements (
  id uuid not null default gen_random_uuid(),
  product_id uuid not null,
  warehouse_id uuid not null,
  movement_type inventory_movement_type not null,
  quantity numeric(14,4) not null,
  reference_id uuid,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.notifications (
  id uuid not null default gen_random_uuid(),
  message text not null,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.order_items (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  product_id uuid not null,
  unit_name text not null,
  quantity numeric(14,4) not null,
  unit_cost numeric(12,2) not null,
  line_total numeric(14,2) not null,
  default_sale_price numeric(12,2)
);

create table public.order_return_items (
  id uuid not null default gen_random_uuid(),
  return_id uuid not null,
  product_id uuid not null,
  unit_name text not null,
  quantity numeric(14,4) not null,
  unit_cost numeric(12,2) not null,
  line_total numeric(14,2) not null
);

create table public.order_returns (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  warehouse_id uuid not null,
  total_amount numeric(14,2) not null default 0,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.orders (
  id uuid not null default gen_random_uuid(),
  order_number text not null,
  warehouse_id uuid not null,
  status order_status not null default 'received'::order_status,
  total_cost numeric(14,2) not null default 0,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  discount_amount numeric(12,2) not null default 0
);

create table public.payments (
  id uuid not null default gen_random_uuid(),
  party_type party_type not null,
  party_id uuid not null,
  direction payment_direction not null,
  amount numeric(14,2) not null,
  related_invoice_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.product_car_compatibility (
  product_id uuid not null,
  car_model_id uuid not null
);

create table public.product_units (
  id uuid not null default gen_random_uuid(),
  product_id uuid not null,
  unit_name text not null,
  conversion_factor numeric(12,4) not null,
  barcode text
);

create table public.products (
  id uuid not null default gen_random_uuid(),
  part_number text not null,
  barcode text,
  name text not null,
  category_id uuid,
  base_unit text not null,
  cost_price numeric(12,2) not null default 0,
  sale_price numeric(12,2) not null default 0,
  min_stock_alert numeric(12,2) default 0,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now()
);

create table public.sale_item_lot_usage (
  id uuid not null default gen_random_uuid(),
  sale_invoice_item_id uuid not null,
  lot_id uuid not null,
  quantity numeric(14,4) not null,
  unit_cost numeric(12,2) not null,
  created_at timestamp with time zone not null default now()
);

create table public.sales_invoice_items (
  id uuid not null default gen_random_uuid(),
  invoice_id uuid not null,
  product_id uuid not null,
  unit_name text not null,
  quantity numeric(14,4) not null,
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) not null,
  actual_cost numeric(14,2) not null default 0
);

create table public.sales_invoices (
  id uuid not null default gen_random_uuid(),
  invoice_number text not null,
  customer_id uuid,
  warehouse_id uuid not null,
  total_amount numeric(14,2) not null default 0,
  paid_amount numeric(14,2) not null default 0,
  payment_status payment_status not null default 'unpaid'::payment_status,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  discount_amount numeric(12,2) not null default 0
);

create table public.sales_return_items (
  id uuid not null default gen_random_uuid(),
  return_id uuid not null,
  product_id uuid not null,
  unit_name text not null,
  quantity numeric(14,4) not null,
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) not null
);

create table public.sales_returns (
  id uuid not null default gen_random_uuid(),
  sales_invoice_id uuid not null,
  customer_id uuid,
  total_amount numeric(14,2) not null default 0,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.stocktake_items (
  id uuid not null default gen_random_uuid(),
  stocktake_id uuid not null,
  product_id uuid not null,
  system_quantity numeric(14,4) not null,
  counted_quantity numeric(14,4) not null,
  difference numeric(14,4) not null
);

create table public.stocktakes (
  id uuid not null default gen_random_uuid(),
  warehouse_id uuid not null,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.treasury_transactions (
  id uuid not null default gen_random_uuid(),
  type treasury_type not null,
  amount numeric(14,2) not null,
  reference_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.users (
  id uuid not null,
  full_name text not null,
  username text not null,
  role user_role not null,
  default_warehouse_id uuid,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  phone text
);

create table public.warehouse_transfer_items (
  id uuid not null default gen_random_uuid(),
  transfer_id uuid not null,
  product_id uuid not null,
  quantity numeric(14,4) not null
);

create table public.warehouse_transfers (
  id uuid not null default gen_random_uuid(),
  from_warehouse_id uuid not null,
  to_warehouse_id uuid not null,
  created_by uuid,
  created_at timestamp with time zone not null default now()
);

create table public.warehouses (
  id uuid not null default gen_random_uuid(),
  name text not null,
  address text,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  is_default boolean not null default false
);


-- ---------- constraints ----------

alter table activity_log add constraint activity_log_pkey PRIMARY KEY (id);
alter table audit_log add constraint audit_log_pkey PRIMARY KEY (id);
alter table car_models add constraint car_models_pkey PRIMARY KEY (id);
alter table categories add constraint categories_pkey PRIMARY KEY (id);
alter table company_settings add constraint company_settings_pkey PRIMARY KEY (id);
alter table customers add constraint customers_pkey PRIMARY KEY (id);
alter table inventory add constraint inventory_pkey PRIMARY KEY (product_id, warehouse_id);
alter table inventory_lots add constraint inventory_lots_pkey PRIMARY KEY (id);
alter table inventory_movements add constraint inventory_movements_pkey PRIMARY KEY (id);
alter table notifications add constraint notifications_pkey PRIMARY KEY (id);
alter table order_items add constraint order_items_pkey PRIMARY KEY (id);
alter table order_return_items add constraint order_return_items_pkey PRIMARY KEY (id);
alter table order_returns add constraint order_returns_pkey PRIMARY KEY (id);
alter table orders add constraint orders_pkey PRIMARY KEY (id);
alter table payments add constraint payments_pkey PRIMARY KEY (id);
alter table product_car_compatibility add constraint product_car_compatibility_pkey PRIMARY KEY (product_id, car_model_id);
alter table product_units add constraint product_units_pkey PRIMARY KEY (id);
alter table products add constraint products_pkey PRIMARY KEY (id);
alter table sale_item_lot_usage add constraint sale_item_lot_usage_pkey PRIMARY KEY (id);
alter table sales_invoice_items add constraint sales_invoice_items_pkey PRIMARY KEY (id);
alter table sales_invoices add constraint sales_invoices_pkey PRIMARY KEY (id);
alter table sales_return_items add constraint sales_return_items_pkey PRIMARY KEY (id);
alter table sales_returns add constraint sales_returns_pkey PRIMARY KEY (id);
alter table stocktake_items add constraint stocktake_items_pkey PRIMARY KEY (id);
alter table stocktakes add constraint stocktakes_pkey PRIMARY KEY (id);
alter table treasury_transactions add constraint treasury_transactions_pkey PRIMARY KEY (id);
alter table users add constraint users_pkey PRIMARY KEY (id);
alter table warehouse_transfer_items add constraint warehouse_transfer_items_pkey PRIMARY KEY (id);
alter table warehouse_transfers add constraint warehouse_transfers_pkey PRIMARY KEY (id);
alter table warehouses add constraint warehouses_pkey PRIMARY KEY (id);
alter table orders add constraint orders_order_number_key UNIQUE (order_number);
alter table product_units add constraint product_units_product_id_unit_name_key UNIQUE (product_id, unit_name);
alter table products add constraint products_barcode_key UNIQUE (barcode);
alter table products add constraint products_part_number_key UNIQUE (part_number);
alter table sales_invoices add constraint sales_invoices_invoice_number_key UNIQUE (invoice_number);
alter table users add constraint users_username_key UNIQUE (username);
alter table company_settings add constraint company_settings_singleton CHECK (id);
alter table inventory_lots add constraint inventory_lots_source_type_check CHECK ((source_type = ANY (ARRAY['order'::text, 'stocktake'::text, 'manual'::text, 'return'::text])));
alter table activity_log add constraint activity_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
alter table audit_log add constraint audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
alter table inventory add constraint inventory_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table inventory add constraint inventory_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table inventory_lots add constraint inventory_lots_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table inventory_lots add constraint inventory_lots_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table inventory_movements add constraint inventory_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table inventory_movements add constraint inventory_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table inventory_movements add constraint inventory_movements_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table notifications add constraint notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table order_items add constraint order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
alter table order_items add constraint order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table order_return_items add constraint order_return_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table order_return_items add constraint order_return_items_return_id_fkey FOREIGN KEY (return_id) REFERENCES order_returns(id) ON DELETE CASCADE;
alter table order_returns add constraint order_returns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table order_returns add constraint order_returns_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);
alter table order_returns add constraint order_returns_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table orders add constraint orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table orders add constraint orders_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table payments add constraint payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table product_car_compatibility add constraint product_car_compatibility_car_model_id_fkey FOREIGN KEY (car_model_id) REFERENCES car_models(id) ON DELETE CASCADE;
alter table product_car_compatibility add constraint product_car_compatibility_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
alter table product_units add constraint product_units_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
alter table products add constraint products_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories(id);
alter table sale_item_lot_usage add constraint sale_item_lot_usage_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES inventory_lots(id);
alter table sale_item_lot_usage add constraint sale_item_lot_usage_sale_invoice_item_id_fkey FOREIGN KEY (sale_invoice_item_id) REFERENCES sales_invoice_items(id) ON DELETE CASCADE;
alter table sales_invoice_items add constraint sales_invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE;
alter table sales_invoice_items add constraint sales_invoice_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table sales_invoices add constraint sales_invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table sales_invoices add constraint sales_invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
alter table sales_invoices add constraint sales_invoices_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table sales_return_items add constraint sales_return_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table sales_return_items add constraint sales_return_items_return_id_fkey FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE;
alter table sales_returns add constraint sales_returns_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table sales_returns add constraint sales_returns_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
alter table sales_returns add constraint sales_returns_sales_invoice_id_fkey FOREIGN KEY (sales_invoice_id) REFERENCES sales_invoices(id);
alter table stocktake_items add constraint stocktake_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table stocktake_items add constraint stocktake_items_stocktake_id_fkey FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id) ON DELETE CASCADE;
alter table stocktakes add constraint stocktakes_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table stocktakes add constraint stocktakes_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES warehouses(id);
alter table treasury_transactions add constraint treasury_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table users add constraint users_default_warehouse_id_fkey FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id);
alter table users add constraint users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table warehouse_transfer_items add constraint warehouse_transfer_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
alter table warehouse_transfer_items add constraint warehouse_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id) ON DELETE CASCADE;
alter table warehouse_transfers add constraint warehouse_transfers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
alter table warehouse_transfers add constraint warehouse_transfers_from_warehouse_id_fkey FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id);
alter table warehouse_transfers add constraint warehouse_transfers_to_warehouse_id_fkey FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id);

-- ---------- indexes (اللي مش بسبب قيد) ----------

CREATE INDEX idx_inventory_lots_fifo ON public.inventory_lots USING btree (product_id, warehouse_id, created_at) WHERE (quantity_remaining > (0)::numeric);

-- ---------- functions ----------

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
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from public.notifications
  where created_at < now() - interval '3 days';
end;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.create_order_return(p_order_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order record;
  v_return_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_base_qty numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_lot record;
  v_original_qty numeric;
  v_already_returned numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'الطلبية غير موجودة';
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_cost')::numeric), 0)
  into v_total
  from jsonb_array_elements(p_items) i;

  if v_total <= 0 then
    raise exception 'لازم تحدد صنف واحد على الأقل بكمية أكبر من صفر للمرتجع';
  end if;

  insert into public.order_returns (order_id, warehouse_id, total_amount, notes, created_by)
  values (p_order_id, v_order.warehouse_id, v_total, p_notes, auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;

    select coalesce(sum(quantity), 0) into v_original_qty
    from public.order_items
    where order_id = p_order_id and product_id = v_product_id;

    select coalesce(sum(ori.quantity), 0) into v_already_returned
    from public.order_return_items ori
    join public.order_returns orr on orr.id = ori.return_id
    where orr.order_id = p_order_id and ori.product_id = v_product_id;

    if (v_already_returned + (v_item->>'quantity')::numeric) > v_original_qty then
      raise exception 'الكمية المرتجعة أكبر من الكمية المشتراة فعليًا لهذا الصنف';
    end if;

    v_line_total := (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric;
    v_base_qty := (v_item->>'quantity')::numeric * (v_item->>'conversion_factor')::numeric;

    -- رجّع الكمية لنفس دفعة الطلبية دي بالتحديد (مش أي دفعة تانية)
    select * into v_lot from public.inventory_lots
    where source_type = 'order' and source_id = p_order_id and product_id = v_product_id
    for update;

    if v_lot is null or v_lot.quantity_remaining < v_base_qty then
      raise exception 'لا يمكن إرجاع كمية أكبر من المتوفر فعليًا من هذه الطلبية في المخزون';
    end if;

    update public.inventory_lots
    set quantity_remaining = quantity_remaining - v_base_qty
    where id = v_lot.id;

    insert into public.order_return_items
      (return_id, product_id, unit_name, quantity, unit_cost, line_total)
    values
      (v_return_id, v_product_id, v_item->>'unit_name',
       (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric, v_line_total);

    update public.inventory
    set quantity = quantity - v_base_qty, updated_at = now()
    where product_id = v_product_id and warehouse_id = v_order.warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_order.warehouse_id, 'adjustment', -v_base_qty, v_return_id, auth.uid());
  end loop;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values ('purchase_out', v_total, v_return_id, 'مرتجع طلبية رقم ' || v_order.order_number, auth.uid());

  perform public.notify('تم تسجيل مرتجع لطلبية رقم ' || v_order.order_number);

  return v_return_id;
end;
$function$
;

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

  v_total := greatest(v_subtotal - coalesce(p_discount_amount, 0), 0);

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
$function$
;

CREATE OR REPLACE FUNCTION public.create_sales_return(p_sales_invoice_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice record;
  v_return_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_base_qty numeric;
  v_line_total numeric;
  v_total numeric := 0;
  v_original_qty numeric;
  v_already_returned numeric;
  v_avg_cost numeric;
  v_original_item_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_invoice from public.sales_invoices where id = p_sales_invoice_id;
  if not found then
    raise exception 'الفاتورة غير موجودة';
  end if;

  select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
  into v_total
  from jsonb_array_elements(p_items) i;

  if v_total <= 0 then
    raise exception 'لازم تحدد صنف واحد على الأقل بكمية أكبر من صفر للمرتجع';
  end if;

  insert into public.sales_returns (sales_invoice_id, customer_id, total_amount, notes, created_by)
  values (p_sales_invoice_id, v_invoice.customer_id, v_total, p_notes, auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item->>'product_id')::uuid;

    select coalesce(sum(quantity), 0) into v_original_qty
    from public.sales_invoice_items
    where invoice_id = p_sales_invoice_id and product_id = v_product_id;

    select coalesce(sum(sri.quantity), 0) into v_already_returned
    from public.sales_return_items sri
    join public.sales_returns sr on sr.id = sri.return_id
    where sr.sales_invoice_id = p_sales_invoice_id and sri.product_id = v_product_id;

    if (v_already_returned + (v_item->>'quantity')::numeric) > v_original_qty then
      raise exception 'الكمية المرتجعة أكبر من الكمية المباعة فعليًا لهذا الصنف';
    end if;

    v_line_total := (v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric;
    v_base_qty := (v_item->>'quantity')::numeric * (v_item->>'conversion_factor')::numeric;

    insert into public.sales_return_items
      (return_id, product_id, unit_name, quantity, unit_price, line_total)
    values
      (v_return_id, v_product_id, v_item->>'unit_name',
       (v_item->>'quantity')::numeric, (v_item->>'unit_price')::numeric, v_line_total);

    -- نجيب متوسط تكلفة نفس الصنف من نفس الفاتورة الأصلية عشان نرجّع
    -- الدفعة بنفس التكلفة الحقيقية اللي اتباعت بيها (مش تخمين جديد)
    select id into v_original_item_id from public.sales_invoice_items
    where invoice_id = p_sales_invoice_id and product_id = v_product_id limit 1;

    select coalesce(avg(unit_cost), (select cost_price from public.products where id = v_product_id))
    into v_avg_cost
    from public.sale_item_lot_usage where sale_invoice_item_id = v_original_item_id;

    insert into public.inventory_lots
      (product_id, warehouse_id, source_type, source_id, unit_cost, quantity_received, quantity_remaining)
    values
      (v_product_id, v_invoice.warehouse_id, 'return', v_return_id, v_avg_cost, v_base_qty, v_base_qty);

    update public.inventory
    set quantity = quantity + v_base_qty, updated_at = now()
    where product_id = v_product_id and warehouse_id = v_invoice.warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_product_id, v_invoice.warehouse_id, 'adjustment', v_base_qty, v_return_id, auth.uid());
  end loop;

  if v_invoice.customer_id is not null then
    update public.customers set balance = balance - v_total where id = v_invoice.customer_id;
  end if;

  perform public.notify('تم تسجيل مرتجع بيع لفاتورة رقم ' || v_invoice.invoice_number);

  return v_return_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.users where id = auth.uid() and is_active = true
  )
$function$
;

CREATE OR REPLACE FUNCTION public.log_activity(p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
begin
  select full_name into v_name from public.users where id = auth.uid();
  insert into public.activity_log (user_id, user_name, action)
  values (auth.uid(), v_name, p_action);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify(p_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
begin
  insert into public.notifications (message, created_by)
  values (p_message, auth.uid());

  select full_name into v_name from public.users where id = auth.uid();
  insert into public.activity_log (user_id, user_name, action)
  values (auth.uid(), v_name, p_message);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.record_payment(p_party_type party_type, p_party_id uuid, p_direction payment_direction, p_amount numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payment_id uuid;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  if p_amount <= 0 then
    raise exception 'المبلغ يجب أن يكون أكبر من صفر';
  end if;

  insert into public.payments (party_type, party_id, direction, amount, notes, created_by)
  values (p_party_type, p_party_id, p_direction, p_amount, p_notes, auth.uid())
  returning id into v_payment_id;

  if p_party_type = 'customer' then
    update public.customers set balance = balance - p_amount where id = p_party_id;
  else
    update public.suppliers set balance = balance - p_amount where id = p_party_id;
  end if;

  insert into public.treasury_transactions (type, amount, reference_id, notes, created_by)
  values (
    (case when p_direction = 'in' then 'payment_in' else 'payment_out' end)::treasury_type,
    case when p_direction = 'in' then p_amount else -p_amount end,
    v_payment_id, p_notes, auth.uid()
  );

  return v_payment_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_default_warehouse(p_warehouse_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  update public.warehouses set is_default = false where is_default = true;
  update public.warehouses set is_default = true where id = p_warehouse_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_invoice_numbering(p_next_sales_number integer, p_next_order_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  update public.company_settings
  set next_sales_invoice_number = coalesce(p_next_sales_number, next_sales_invoice_number),
      next_order_number = coalesce(p_next_order_number, next_order_number)
  where id = true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_debt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enabled boolean;
begin
  select notify_debts into v_enabled from public.company_settings where id = true;
  if v_enabled is false then
    return new;
  end if;

  if new.balance > 0 and (TG_OP = 'INSERT' or old.balance <= 0) then
    perform public.notify('💰 عميل جديد مديون: ' || new.name || ' برصيد ' || new.balance);
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_low_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text;
  v_part_number text;
  v_min numeric;
  v_was_low boolean := false;
  v_enabled boolean;
begin
  select notify_low_stock into v_enabled from public.company_settings where id = true;
  if v_enabled is false then
    return new;
  end if;

  select name, part_number, min_stock_alert
  into v_name, v_part_number, v_min
  from public.products where id = new.product_id;

  if v_min is null or v_min <= 0 then
    return new;
  end if;

  if TG_OP = 'UPDATE' then
    v_was_low := old.quantity <= v_min;
  end if;

  if new.quantity <= v_min and not v_was_low then
    perform public.notify(
      '⚠️ المخزون منخفض: ' || v_name || ' (' || v_part_number || ') — الكمية الحالية ' || new.quantity
    );
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_name text;
begin
  select full_name into v_user_name from public.users where id = new.created_by;
  perform public.notify(
    coalesce(v_user_name, 'مستخدم') || ' سجّل طلبية رقم ' || new.order_number ||
    ' بتكلفة ' || new.total_cost
  );
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_product()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.notify('تمت إضافة صنف جديد: ' || new.name || ' (' || new.part_number || ')');
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_purchase()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_name text;
begin
  select full_name into v_user_name from public.users where id = new.created_by;
  perform public.notify(
    coalesce(v_user_name, 'مستخدم') || ' سجّل فاتورة شراء رقم ' || new.invoice_number ||
    ' بقيمة ' || new.total_amount
  );
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_notify_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_name text;
begin
  select full_name into v_user_name from public.users where id = new.created_by;
  perform public.notify(
    coalesce(v_user_name, 'مستخدم') || ' سجّل فاتورة بيع رقم ' || new.invoice_number ||
    ' بقيمة ' || new.total_amount
  );
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.void_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order record;
  v_lot record;
  v_total_received numeric := 0;
  v_total_remaining numeric := 0;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'الطلبية غير موجودة أو تم إلغاؤها بالفعل';
  end if;

  for v_lot in select * from public.inventory_lots where source_type = 'order' and source_id = p_order_id
  loop
    v_total_received := v_total_received + v_lot.quantity_received;
    v_total_remaining := v_total_remaining + v_lot.quantity_remaining;

    if v_lot.quantity_remaining < v_lot.quantity_received then
      raise exception 'لا يمكن إلغاء الطلبية: جزء من الكمية تم بيعه بالفعل من المخزون';
    end if;

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
$function$
;

CREATE OR REPLACE FUNCTION public.void_sale_invoice(p_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invoice record;
  v_item record;
  v_usage record;
  v_base_qty numeric;
begin
  if not public.is_active_user() then
    raise exception 'المستخدم غير مصرح له بهذه العملية';
  end if;

  select * into v_invoice from public.sales_invoices where id = p_invoice_id;
  if not found then
    raise exception 'الفاتورة غير موجودة أو تم إلغاؤها بالفعل';
  end if;

  for v_item in select * from public.sales_invoice_items where invoice_id = p_invoice_id
  loop
    v_base_qty := v_item.quantity * coalesce(
      (select conversion_factor from public.product_units
       where product_id = v_item.product_id and unit_name = v_item.unit_name),
      1
    );

    -- رجّع الكمية بالظبط لنفس الدفعات اللي اتاخدت منها
    for v_usage in select * from public.sale_item_lot_usage where sale_invoice_item_id = v_item.id
    loop
      update public.inventory_lots
      set quantity_remaining = quantity_remaining + v_usage.quantity
      where id = v_usage.lot_id;
    end loop;

    update public.inventory
    set quantity = quantity + v_base_qty, updated_at = now()
    where product_id = v_item.product_id and warehouse_id = v_invoice.warehouse_id;

    insert into public.inventory_movements
      (product_id, warehouse_id, movement_type, quantity, reference_id, created_by)
    values
      (v_item.product_id, v_invoice.warehouse_id, 'adjustment', v_base_qty, p_invoice_id, auth.uid());
  end loop;

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
$function$
;


-- ---------- row level security ----------

alter table public.activity_log enable row level security;
alter table public.audit_log enable row level security;
alter table public.car_models enable row level security;
alter table public.categories enable row level security;
alter table public.company_settings enable row level security;
alter table public.customers enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.notifications enable row level security;
alter table public.order_items enable row level security;
alter table public.order_return_items enable row level security;
alter table public.order_returns enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.product_car_compatibility enable row level security;
alter table public.product_units enable row level security;
alter table public.products enable row level security;
alter table public.sale_item_lot_usage enable row level security;
alter table public.sales_invoice_items enable row level security;
alter table public.sales_invoices enable row level security;
alter table public.sales_return_items enable row level security;
alter table public.sales_returns enable row level security;
alter table public.stocktake_items enable row level security;
alter table public.stocktakes enable row level security;
alter table public.treasury_transactions enable row level security;
alter table public.users enable row level security;
alter table public.warehouse_transfer_items enable row level security;
alter table public.warehouse_transfers enable row level security;
alter table public.warehouses enable row level security;

-- ---------- policies ----------

create policy activity_log_delete on public.activity_log as PERMISSIVE for DELETE to public using (is_active_user());
create policy activity_log_select on public.activity_log as PERMISSIVE for SELECT to public using (is_active_user());
create policy activity_log_update on public.activity_log as PERMISSIVE for UPDATE to public using (is_active_user()) with check (is_active_user());
create policy audit_select on public.audit_log as PERMISSIVE for SELECT to public using (is_active_user());
create policy car_models_all on public.car_models as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy categories_all on public.categories as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy company_settings_all on public.company_settings as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy customers_all on public.customers as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy inventory_all on public.inventory as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy inventory_lots_all on public.inventory_lots as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy inventory_movements_all on public.inventory_movements as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy notifications_select on public.notifications as PERMISSIVE for SELECT to public using (is_active_user());
create policy order_items_all on public.order_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy order_return_items_all on public.order_return_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy order_returns_all on public.order_returns as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy orders_all on public.orders as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy payments_all on public.payments as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy product_car_compatibility_all on public.product_car_compatibility as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy product_units_all on public.product_units as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy products_all on public.products as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy sale_item_lot_usage_all on public.sale_item_lot_usage as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy sales_invoice_items_all on public.sales_invoice_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy sales_invoices_all on public.sales_invoices as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy sales_return_items_all on public.sales_return_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy sales_returns_all on public.sales_returns as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy stocktake_items_all on public.stocktake_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy stocktakes_all on public.stocktakes as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy treasury_transactions_all on public.treasury_transactions as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy users_all on public.users as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy warehouse_transfer_items_all on public.warehouse_transfer_items as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy warehouse_transfers_all on public.warehouse_transfers as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());
create policy warehouses_all on public.warehouses as PERMISSIVE for ALL to public using (is_active_user()) with check (is_active_user());

-- ---------- triggers ----------

CREATE TRIGGER on_customer_debt AFTER INSERT OR UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION trg_notify_debt();
CREATE TRIGGER on_inventory_low_stock AFTER INSERT OR UPDATE ON public.inventory FOR EACH ROW EXECUTE FUNCTION trg_notify_low_stock();
CREATE TRIGGER on_order_created AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_notify_order();
CREATE TRIGGER on_product_created AFTER INSERT ON public.products FOR EACH ROW EXECUTE FUNCTION trg_notify_product();
CREATE TRIGGER on_sale_invoice_created AFTER INSERT ON public.sales_invoices FOR EACH ROW EXECUTE FUNCTION trg_notify_sale();
