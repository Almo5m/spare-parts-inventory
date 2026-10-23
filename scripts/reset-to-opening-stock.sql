-- ============================================================================
-- تصفير العمليات والرجوع للمخزون الافتتاحي (بعد اختبارات أو قبل التسليم)
--
-- بيمسح كل العمليات اللي اتعملت بعد الاستيراد (فواتير بيع، مرتجعات، طلبيات، دفعات، حركات
-- الخزنة، تحويلات، جرد جديد، لقطات الإلغاء، والإشعارات وسجل الأنشطة اللي بعد وقت الاستيراد)،
-- وبيرجّع كمية كل صنف في كل مخزن زي ما كانت وقت الاستيراد (من الدفعات الافتتاحية المعلّمة
-- بالملاحظة 'رصيد افتتاحي — استيراد من الشيتات')، وبيرجّع عدّاد الفواتير والطلبيات لـ 1.
--
-- مبيلمسش: المنتجات (وأسعارها ووحداتها)، المخازن، المستخدمين، الفئات، إعدادات الشركة
-- (الاسم والشعار والتليفون). والعملاء بيتصفّر رصيدهم (أو بيتمسحوا لو فعّلت الخيار تحت).
-- منتج اتضاف بعد الاستيراد بيفضل زي ما هو، بس من غير رصيد.
--
-- ⚠ ده سكريبت مدمّر. استخدمه قبل التشغيل الحقيقي بس، ومش بعد ما تبدأ تسجّل فواتير حقيقية.
--
-- طريقة الاستخدام (من Supabase > SQL Editor):
--   1) خد نسخة احتياطية من الإعدادات في الموقع.
--   2) سيب v_mode = 'PREVIEW' وشغّل: بيحسب كل حاجة ويطلّع تقرير بالأعداد في رسالة خطأ،
--      ومبيغيّرش أي حاجة (الخطأ مقصود: بيلغي التنفيذ).
--   3) لو التقرير مظبوط، غيّر v_mode إلى 'RESET' وشغّل مرة تانية.
-- الملف كله أمر DO واحد: يا كله يتنفذ يا ولا حاجة. متقسّمهوش ومتضيفش begin/commit.
-- ============================================================================

do $reset$
declare
  -- ===== الإعدادات (غيّرهم هنا بس) =====
  v_mode text := 'PREVIEW';               -- 'PREVIEW' (معاينة بس) أو 'RESET' (تنفيذ فعلي)
  v_delete_customers boolean := false;    -- true = يمسح كل العملاء (لو كلهم عملاء تجربة)
  v_allow_many_invoices boolean := false; -- لازم true لو فيه أكتر من 30 فاتورة (حماية من التشغيل بالغلط)

  -- ===== داخلي =====
  v_note constant text := 'رصيد افتتاحي — استيراد من الشيتات';
  v_opening_ids uuid[];
  v_import_time timestamptz;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_n bigint;
  v_invoices int;
  v_bad int;
  v_report text := '';
  v_totals text;
begin
  if v_mode not in ('PREVIEW', 'RESET') then
    raise exception 'غيّر v_mode إلى PREVIEW (معاينة) أو RESET (تنفيذ فعلي)';
  end if;

  select array_agg(id), min(created_at) into v_opening_ids, v_import_time
  from public.stocktakes where notes = v_note;

  if v_opening_ids is null or cardinality(v_opening_ids) = 0 then
    raise exception 'مفيش جرد افتتاحي في القاعدة (ملاحظته: %). السكريبت ده بيرجّع لوضع الاستيراد بس', v_note;
  end if;

  select count(*) into v_invoices from public.sales_invoices;
  if v_invoices > 30 and not v_allow_many_invoices then
    raise exception 'فيه % فاتورة بيع. ده شكله تشغيل حقيقي وممكن تمسح بيانات عميل. لو متأكد غيّر v_allow_many_invoices إلى true', v_invoices;
  end if;

  -- ---------- المبيعات ----------
  delete from public.sale_item_lot_usage;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- استهلاك دفعات: %s', v_n);
  delete from public.sales_returns;       -- بنودها بتتمسح تلقائيًا
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- مرتجعات بيع: %s', v_n);
  delete from public.sales_invoices;      -- بنودها بتتمسح تلقائيًا
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- فواتير بيع: %s', v_n);

  -- ---------- المشتريات ----------
  delete from public.order_returns;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- مرتجعات طلبيات: %s', v_n);
  delete from public.orders;              -- بنودها بتتمسح تلقائيًا
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- طلبيات شراء: %s', v_n);

  -- ---------- الفلوس ----------
  delete from public.payments;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- دفعات: %s', v_n);
  delete from public.treasury_transactions;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- حركات خزنة: %s', v_n);

  -- ---------- المخزون ----------
  delete from public.warehouse_transfers; -- بنودها بتتمسح تلقائيًا
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- تحويلات بين المخازن: %s', v_n);
  delete from public.stocktakes where not (id = any(v_opening_ids));
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- جرد غير الافتتاحي: %s', v_n);

  delete from public.inventory_movements
  where not (movement_type = 'adjustment' and coalesce(reference_id, v_zero) = any(v_opening_ids));
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- حركات مخزون: %s', v_n);

  delete from public.inventory_lots
  where not (source_type = 'stocktake' and coalesce(source_id, v_zero) = any(v_opening_ids));
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- دفعات غير افتتاحية: %s', v_n);

  update public.inventory_lots
  set quantity_remaining = quantity_received
  where source_type = 'stocktake' and source_id = any(v_opening_ids)
    and quantity_remaining <> quantity_received;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- دفعات افتتاحية اتعدّلت كميتها المتبقية: %s', v_n);

  delete from public.inventory i
  where not exists (
    select 1 from public.inventory_lots l
    where l.product_id = i.product_id and l.warehouse_id = i.warehouse_id
  );
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- أرصدة مخزون اتمسحت (أصناف مش في الاستيراد): %s', v_n);

  update public.inventory i
  set quantity = t.total, updated_at = now()
  from (
    select product_id, warehouse_id, sum(quantity_received) as total
    from public.inventory_lots group by product_id, warehouse_id
  ) t
  where t.product_id = i.product_id and t.warehouse_id = i.warehouse_id
    and i.quantity <> t.total;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- أرصدة مخزون اترجّعت لكميتها الافتتاحية: %s', v_n);

  -- ---------- العملاء والعدّادات ----------
  if v_delete_customers then
    delete from public.customers;
    get diagnostics v_n = row_count; v_report := v_report || format(E'\n- عملاء اتمسحوا: %s', v_n);
  else
    update public.customers set balance = 0 where balance <> 0;
    get diagnostics v_n = row_count; v_report := v_report || format(E'\n- عملاء اتصفّر رصيدهم: %s', v_n);
  end if;

  update public.company_settings set next_sales_invoice_number = 1, next_order_number = 1 where id = true;

  -- ---------- سجلات ----------
  delete from public.cancelled_documents;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- لقطات فواتير ملغية: %s', v_n);
  delete from public.notifications where created_at > v_import_time;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- إشعارات بعد الاستيراد: %s', v_n);
  delete from public.activity_log where created_at > v_import_time;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- سجل أنشطة بعد الاستيراد: %s', v_n);
  delete from public.audit_log where created_at > v_import_time;
  get diagnostics v_n = row_count; v_report := v_report || format(E'\n- audit_log بعد الاستيراد: %s', v_n);

  -- ---------- تحقق نهائي (لو فشل، كل حاجة بتتلغي) ----------
  select count(*) into v_bad from public.inventory_lots
  where not (source_type = 'stocktake' and coalesce(source_id, v_zero) = any(v_opening_ids));
  if v_bad > 0 then
    raise exception 'فضل % دفعة مش افتتاحية بعد التصفير', v_bad;
  end if;

  select count(*) into v_bad
  from public.inventory i
  full join (
    select product_id, warehouse_id, sum(quantity_remaining) as total
    from public.inventory_lots group by product_id, warehouse_id
  ) l on l.product_id = i.product_id and l.warehouse_id = i.warehouse_id
  where i.product_id is null or l.product_id is null or i.quantity <> l.total;
  if v_bad > 0 then
    raise exception 'المخزون مش مطابق للدفعات في % صف بعد التصفير', v_bad;
  end if;

  select string_agg(format('%s: %s صنف / %s قطعة', w.name, x.items, x.pieces), E'\n  ' order by w.name)
  into v_totals
  from (
    select warehouse_id, count(*) as items, sum(quantity) as pieces
    from public.inventory group by warehouse_id
  ) x
  join public.warehouses w on w.id = x.warehouse_id;

  v_report := v_report || E'\n\nالمخزون بعد التصفير:\n  ' || coalesce(v_totals, 'فاضي');

  if v_mode = 'PREVIEW' then
    raise exception E'معاينة فقط، ومفيش حاجة اتغيّرت. ده اللي هيحصل لو شغّلت RESET:%', v_report;
  end if;

  raise notice E'تم التصفير:%', v_report;
end
$reset$;
