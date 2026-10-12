# مرجع مخطط قاعدة البيانات (مولّد من ملف الأنواع)

> **مرجع للقراءة فقط.** ده مستخرج من `src/lib/database.types.ts`، يعني فيه الجداول والأعمدة وأنواعها وتوقيعات الدوال،
> لكنه **مش بديل للـ migrations**: مفيهوش القيم الافتراضية، القيود، الفهارس، سياسات RLS، الـ triggers، ولا أجسام دوال SQL.
> للتعريفات الكاملة شغّل `supabase/export/export-definitions.sql` (التعليمات في `supabase/README.md`).

## الجداول

### `activity_log`

| العمود | النوع | يقبل null |
|---|---|---|
| `action` | `string` | لا |
| `created_at` | `string` | لا |
| `id` | `string` | لا |
| `is_read` | `boolean` | لا |
| `user_id` | `string | null` | نعم |
| `user_name` | `string | null` | نعم |

### `audit_log`

| العمود | النوع | يقبل null |
|---|---|---|
| `action` | `string` | لا |
| `created_at` | `string` | لا |
| `details` | `Json | null` | نعم |
| `id` | `string` | لا |
| `record_id` | `string | null` | نعم |
| `table_name` | `string | null` | نعم |
| `user_id` | `string | null` | نعم |

### `car_models`

| العمود | النوع | يقبل null |
|---|---|---|
| `brand` | `string` | لا |
| `id` | `string` | لا |
| `model` | `string` | لا |
| `year_from` | `number | null` | نعم |
| `year_to` | `number | null` | نعم |

### `categories`

| العمود | النوع | يقبل null |
|---|---|---|
| `id` | `string` | لا |
| `name` | `string` | لا |

### `company_settings`

| العمود | النوع | يقبل null |
|---|---|---|
| `company_name` | `string` | لا |
| `id` | `boolean` | لا |
| `invoice_footer_message` | `string | null` | نعم |
| `logo_data_url` | `string | null` | نعم |
| `next_order_number` | `number` | لا |
| `next_sales_invoice_number` | `number` | لا |
| `notify_debts` | `boolean` | لا |
| `notify_low_stock` | `boolean` | لا |
| `phone` | `string | null` | نعم |

### `customers`

| العمود | النوع | يقبل null |
|---|---|---|
| `address` | `string | null` | نعم |
| `balance` | `number` | لا |
| `created_at` | `string` | لا |
| `id` | `string` | لا |
| `name` | `string` | لا |
| `phone` | `string | null` | نعم |

### `inventory`

| العمود | النوع | يقبل null |
|---|---|---|
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `updated_at` | `string` | لا |
| `warehouse_id` | `string` | لا |

### `inventory_lots`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `default_sale_price` | `number | null` | نعم |
| `id` | `string` | لا |
| `product_id` | `string` | لا |
| `quantity_received` | `number` | لا |
| `quantity_remaining` | `number` | لا |
| `source_id` | `string | null` | نعم |
| `source_type` | `string` | لا |
| `unit_cost` | `number` | لا |
| `warehouse_id` | `string` | لا |

### `inventory_movements`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `id` | `string` | لا |
| `movement_type` | `Database["public"]["Enums"]["inventory_movement_type"]` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `reference_id` | `string | null` | نعم |
| `warehouse_id` | `string` | لا |

### `notifications`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `id` | `string` | لا |
| `message` | `string` | لا |

### `order_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `default_sale_price` | `number | null` | نعم |
| `id` | `string` | لا |
| `line_total` | `number` | لا |
| `order_id` | `string` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `unit_cost` | `number` | لا |
| `unit_name` | `string` | لا |

### `order_return_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `id` | `string` | لا |
| `line_total` | `number` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `return_id` | `string` | لا |
| `unit_cost` | `number` | لا |
| `unit_name` | `string` | لا |

### `order_returns`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `order_id` | `string` | لا |
| `total_amount` | `number` | لا |
| `warehouse_id` | `string` | لا |

### `orders`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `discount_amount` | `number` | لا |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `order_number` | `string` | لا |
| `status` | `Database["public"]["Enums"]["order_status"]` | لا |
| `total_cost` | `number` | لا |
| `warehouse_id` | `string` | لا |

### `payments`

| العمود | النوع | يقبل null |
|---|---|---|
| `amount` | `number` | لا |
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `direction` | `Database["public"]["Enums"]["payment_direction"]` | لا |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `party_id` | `string` | لا |
| `party_type` | `Database["public"]["Enums"]["party_type"]` | لا |
| `related_invoice_id` | `string | null` | نعم |

### `product_car_compatibility`

| العمود | النوع | يقبل null |
|---|---|---|
| `car_model_id` | `string` | لا |
| `product_id` | `string` | لا |

### `product_units`

| العمود | النوع | يقبل null |
|---|---|---|
| `barcode` | `string | null` | نعم |
| `conversion_factor` | `number` | لا |
| `id` | `string` | لا |
| `product_id` | `string` | لا |
| `unit_name` | `string` | لا |

### `products`

| العمود | النوع | يقبل null |
|---|---|---|
| `barcode` | `string | null` | نعم |
| `base_unit` | `string` | لا |
| `category_id` | `string | null` | نعم |
| `cost_price` | `number` | لا |
| `created_at` | `string` | لا |
| `id` | `string` | لا |
| `is_active` | `boolean` | لا |
| `min_stock_alert` | `number | null` | نعم |
| `name` | `string` | لا |
| `part_number` | `string` | لا |
| `sale_price` | `number` | لا |

### `sale_item_lot_usage`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `id` | `string` | لا |
| `lot_id` | `string` | لا |
| `quantity` | `number` | لا |
| `sale_invoice_item_id` | `string` | لا |
| `unit_cost` | `number` | لا |

### `sales_invoice_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `actual_cost` | `number` | لا |
| `id` | `string` | لا |
| `invoice_id` | `string` | لا |
| `line_total` | `number` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `unit_name` | `string` | لا |
| `unit_price` | `number` | لا |

### `sales_invoices`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `customer_id` | `string | null` | نعم |
| `discount_amount` | `number` | لا |
| `id` | `string` | لا |
| `invoice_number` | `string` | لا |
| `paid_amount` | `number` | لا |
| `payment_status` | `Database["public"]["Enums"]["payment_status"]` | لا |
| `total_amount` | `number` | لا |
| `warehouse_id` | `string` | لا |

### `sales_return_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `id` | `string` | لا |
| `line_total` | `number` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `return_id` | `string` | لا |
| `unit_name` | `string` | لا |
| `unit_price` | `number` | لا |

### `sales_returns`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `customer_id` | `string | null` | نعم |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `sales_invoice_id` | `string` | لا |
| `total_amount` | `number` | لا |

### `stocktake_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `counted_quantity` | `number` | لا |
| `difference` | `number` | لا |
| `id` | `string` | لا |
| `product_id` | `string` | لا |
| `stocktake_id` | `string` | لا |
| `system_quantity` | `number` | لا |

### `stocktakes`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `warehouse_id` | `string` | لا |

### `treasury_transactions`

| العمود | النوع | يقبل null |
|---|---|---|
| `amount` | `number` | لا |
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `id` | `string` | لا |
| `notes` | `string | null` | نعم |
| `reference_id` | `string | null` | نعم |
| `type` | `Database["public"]["Enums"]["treasury_type"]` | لا |

### `users`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `default_warehouse_id` | `string | null` | نعم |
| `full_name` | `string` | لا |
| `id` | `string` | لا |
| `is_active` | `boolean` | لا |
| `phone` | `string | null` | نعم |
| `role` | `Database["public"]["Enums"]["user_role"]` | لا |
| `username` | `string` | لا |

### `warehouse_transfer_items`

| العمود | النوع | يقبل null |
|---|---|---|
| `id` | `string` | لا |
| `product_id` | `string` | لا |
| `quantity` | `number` | لا |
| `transfer_id` | `string` | لا |

### `warehouse_transfers`

| العمود | النوع | يقبل null |
|---|---|---|
| `created_at` | `string` | لا |
| `created_by` | `string | null` | نعم |
| `from_warehouse_id` | `string` | لا |
| `id` | `string` | لا |
| `to_warehouse_id` | `string` | لا |

### `warehouses`

| العمود | النوع | يقبل null |
|---|---|---|
| `address` | `string | null` | نعم |
| `created_at` | `string` | لا |
| `id` | `string` | لا |
| `is_active` | `boolean` | لا |
| `is_default` | `boolean` | لا |
| `name` | `string` | لا |

## الدوال (RPC)

| الدالة | البارامترات (علامة ? = اختياري) | الرجوع |
|---|---|---|
| `apply_stocktake` | `p_items: Json`<br>`p_notes: string`<br>`p_warehouse_id: string` | `string` |
| `cleanup_old_notifications` | بدون | `undefined` |
| `create_order` | `p_discount_amount?: number`<br>`p_items: Json`<br>`p_notes: string`<br>`p_warehouse_id: string` | `string` |
| `create_order_return` | `p_items: Json`<br>`p_notes?: string`<br>`p_order_id: string` | `string` |
| `create_sale_invoice` | `p_customer_id: string`<br>`p_discount_amount?: number`<br>`p_items: Json`<br>`p_paid_amount: number`<br>`p_warehouse_id: string` | `string` |
| `create_sales_return` | `p_items: Json`<br>`p_notes?: string`<br>`p_sales_invoice_id: string` | `string` |
| `is_active_user` | بدون | `boolean` |
| `log_activity` | `p_action: string` | `undefined` |
| `notify` | `p_message: string` | `undefined` |
| `record_payment` | `p_amount: number`<br>`p_direction: Database["public"]["Enums"]["payment_direction"]`<br>`p_notes?: string`<br>`p_party_id: string`<br>`p_party_type: Database["public"]["Enums"]["party_type"]` | `string` |
| `set_default_warehouse` | `p_warehouse_id: string` | `undefined` |
| `set_invoice_numbering` | `p_next_order_number: number`<br>`p_next_sales_number: number` | `undefined` |
| `void_order` | `p_order_id: string` | `undefined` |
| `void_sale_invoice` | `p_invoice_id: string` | `undefined` |
