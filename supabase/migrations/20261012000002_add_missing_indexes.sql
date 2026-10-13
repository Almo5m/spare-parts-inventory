-- ============================================================================
-- فهارس ناقصة
-- Postgres مبيعملش فهرس تلقائي لأعمدة الـ foreign key ولا لأعمدة التواريخ، والتطبيق بيفلتر
-- بيها كتير (الفترة الزمنية في التقارير والداشبورد، فواتير عميل، أصناف فاتورة...).
-- مع الأرقام الحالية الصغيرة مش هتحس بفرق، لكن بعد شهور من الفواتير أو بعد استيراد آلاف
-- الأصناف هتفرق. كلها if not exists، فآمن تتنفذ أكتر من مرة. مفيش أي تغيير في البيانات.
-- ============================================================================

create index if not exists idx_sales_invoices_created_at on public.sales_invoices (created_at desc);
create index if not exists idx_sales_invoices_customer on public.sales_invoices (customer_id);
create index if not exists idx_sales_invoices_warehouse on public.sales_invoices (warehouse_id);
create index if not exists idx_sales_invoice_items_invoice on public.sales_invoice_items (invoice_id);
create index if not exists idx_sales_invoice_items_product on public.sales_invoice_items (product_id);

create index if not exists idx_orders_created_at on public.orders (created_at desc);
create index if not exists idx_orders_warehouse on public.orders (warehouse_id);
create index if not exists idx_order_items_order on public.order_items (order_id);
create index if not exists idx_order_items_product on public.order_items (product_id);

create index if not exists idx_inventory_lots_source on public.inventory_lots (source_id);
create index if not exists idx_inventory_warehouse on public.inventory (warehouse_id);
create index if not exists idx_sale_item_lot_usage_item on public.sale_item_lot_usage (sale_invoice_item_id);
create index if not exists idx_sale_item_lot_usage_lot on public.sale_item_lot_usage (lot_id);

create index if not exists idx_payments_party on public.payments (party_id, created_at desc);
create index if not exists idx_sales_returns_customer on public.sales_returns (customer_id);
create index if not exists idx_sales_returns_invoice on public.sales_returns (sales_invoice_id);
create index if not exists idx_order_returns_order on public.order_returns (order_id);
create index if not exists idx_stocktake_items_stocktake on public.stocktake_items (stocktake_id);

create index if not exists idx_activity_log_created_at on public.activity_log (created_at desc);
create index if not exists idx_notifications_created_at on public.notifications (created_at desc);
create index if not exists idx_products_category on public.products (category_id);
