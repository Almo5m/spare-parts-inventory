import { supabase } from './supabaseClient'
import { exportMultiSheetExcel } from './exportExcel'
import { fetchAll } from './fetchAll'

/**
 * تصدير المخزون الكامل لمخزن واحد بالتفصيل — رقم القطعة، الباركود،
 * التصنيف، الوحدة، الكمية، متوسط سعر التكلفة الحقيقي (محسوب من
 * الدفعات المتبقية فعليًا في هذا المخزن)، القيمة الإجمالية للتكلفة،
 * سعر البيع المقترح، وحالة المخزون (طبيعي/تحت الحد الأدنى).
 * كافي تمامًا كملف مراجعة مستقل لكل مخزن.
 */
export async function exportWarehouseInventory(warehouseId: string, warehouseName: string) {
  const [invRes, lotsRes, categoriesRes] = await Promise.all([
    fetchAll((from, to) => supabase
      .from('inventory')
      .select('product_id, quantity, products(part_number, barcode, name, category_id, base_unit, sale_price, min_stock_alert)')
      .eq('warehouse_id', warehouseId)
      .order('product_id')
      .range(from, to)),
    fetchAll((from, to) => supabase
      .from('inventory_lots')
      .select('product_id, unit_cost, quantity_remaining')
      .eq('warehouse_id', warehouseId)
      .gt('quantity_remaining', 0)
      .order('id')
      .range(from, to)),
    fetchAll((from, to) => supabase.from('categories').select('id, name').order('id').range(from, to)),
  ])

  const categoryMap = Object.fromEntries((categoriesRes.data ?? []).map((c) => [c.id, c.name]))

  // متوسط تكلفة مرجّح لكل صنف حسب الدفعات المتبقية فعليًا في المخزن ده
  const costByProduct: Record<string, { totalQty: number; totalValue: number }> = {}
  for (const lot of lotsRes.data ?? []) {
    if (!costByProduct[lot.product_id]) costByProduct[lot.product_id] = { totalQty: 0, totalValue: 0 }
    costByProduct[lot.product_id].totalQty += lot.quantity_remaining
    costByProduct[lot.product_id].totalValue += lot.quantity_remaining * lot.unit_cost
  }

  const list = invRes.data ?? []

  let totalQuantity = 0
  let totalCostValue = 0
  let lowStockCount = 0

  const rowsWithName = list.map((r) => {
    const p = r.products as unknown as {
      part_number: string
      barcode: string | null
      name: string
      category_id: string | null
      base_unit: string
      sale_price: number
      min_stock_alert: number | null
    } | null

    const cost = costByProduct[r.product_id]
    const avgCost = cost && cost.totalQty > 0 ? cost.totalValue / cost.totalQty : 0
    const value = avgCost * r.quantity
    const min = p?.min_stock_alert ?? 0
    const isLow = min > 0 && r.quantity <= min

    totalQuantity += r.quantity
    totalCostValue += value
    if (isLow) lowStockCount += 1

    return {
      name: p?.name ?? '',
      row: {
        'رقم القطعة': p?.part_number ?? '-',
        'الباركود': p?.barcode ?? '-',
        'اسم الصنف': p?.name ?? '-',
        'التصنيف': p?.category_id ? categoryMap[p.category_id] ?? '-' : '-',
        'الوحدة الأساسية': p?.base_unit ?? '-',
        'الكمية الحالية': r.quantity,
        'متوسط سعر التكلفة': Number(avgCost.toFixed(2)),
        'القيمة الإجمالية للتكلفة': Number(value.toFixed(2)),
        'سعر البيع المقترح': p?.sale_price ?? 0,
        'حد التنبيه لنقص المخزون': min,
        'الحالة': isLow ? 'ناقص' : 'طبيعي',
      },
    }
  })

  const rows = rowsWithName
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
    .map((item) => item.row)

  exportMultiSheetExcel(`مخزون-${warehouseName}`, [
    {
      name: 'ملخص',
      rows: [
        { 'البيان': 'المخزن', 'القيمة': warehouseName },
        { 'البيان': 'تاريخ التصدير', 'القيمة': new Date().toLocaleString('ar-EG') },
        { 'البيان': 'عدد الأصناف', 'القيمة': list.length },
        { 'البيان': 'إجمالي الكمية', 'القيمة': totalQuantity },
        { 'البيان': 'إجمالي قيمة المخزون (تكلفة)', 'القيمة': Number(totalCostValue.toFixed(2)) },
        { 'البيان': 'عدد الأصناف تحت الحد الأدنى', 'القيمة': lowStockCount },
      ],
    },
    { name: 'المخزون', rows },
  ])
}
