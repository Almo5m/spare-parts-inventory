import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ArrowRight, FileSpreadsheet } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import { exportMultiSheetExcel } from '../lib/exportExcel'
import type { Database } from '../lib/database.types'

type Order = Database['public']['Tables']['orders']['Row']

interface ItemReport {
  productId: string
  name: string
  orderedQty: number
  unitCost: number
  soldQty: number
  soldRevenue: number
  remainingQty: number
  lastSaleDate: string | null
  profit: number
}

export default function OrderReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [order, setOrder] = useState<Order | null>(null)
  const [warehouseName, setWarehouseName] = useState('')
  const [items, setItems] = useState<ItemReport[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    const orderId = id
    let cancelled = false

    async function load() {
      const { data: orderData } = await supabase.from('orders').select('*').eq('id', orderId).single()
      if (!orderData) { setLoading(false); return }
      setOrder(orderData)

      const { data: wh } = await supabase.from('warehouses').select('name').eq('id', orderData.warehouse_id).single()
      setWarehouseName(wh?.name ?? '-')

      const { data: orderItems } = await supabase.from('order_items').select('*').eq('order_id', orderId)
      const { data: products } = await fetchAll((from, to) => supabase.from('products').select('id, name').order('id').range(from, to))
      const productMap = Object.fromEntries((products ?? []).map((p) => [p.id, p.name]))

      // كل صنف في الطلبية له دفعة (Lot) واحدة بالظبط مربوطة بيها — ده
      // اللي بيدي دقة كاملة: نعرف بالظبط كام قطعة اتباعت من الطلبية دي
      // نفسها (مش تقريب حسب التاريخ)، وكام فاضل، وبأنهي إيراد بالظبط.
      const { data: lots } = await supabase
        .from('inventory_lots')
        .select('*')
        .eq('source_type', 'order')
        .eq('source_id', orderId)

      const reports: ItemReport[] = []
      for (const item of orderItems ?? []) {
        const lot = (lots ?? []).find((l) => l.product_id === item.product_id)

        let soldQty = 0
        let soldRevenue = 0
        let lastSaleDate: string | null = null

        if (lot) {
          const { data: usage } = await supabase
            .from('sale_item_lot_usage')
            .select('quantity, sales_invoice_items(unit_price, sales_invoices(created_at))')
            .eq('lot_id', lot.id)

          for (const u of usage ?? []) {
            const saleItem = u.sales_invoice_items as unknown as {
              unit_price: number
              sales_invoices: { created_at: string } | null
            } | null
            soldQty += Number(u.quantity)
            soldRevenue += Number(u.quantity) * (saleItem?.unit_price ?? 0)
            const date = saleItem?.sales_invoices?.created_at
            if (date && (!lastSaleDate || date > lastSaleDate)) lastSaleDate = date
          }
        }

        const unitCost = lot?.unit_cost ?? item.unit_cost
        reports.push({
          productId: item.product_id,
          name: productMap[item.product_id] ?? item.product_id,
          orderedQty: item.quantity,
          unitCost,
          soldQty,
          soldRevenue,
          remainingQty: lot?.quantity_remaining ?? 0,
          lastSaleDate,
          profit: soldRevenue - soldQty * unitCost,
        })
      }

      if (!cancelled) {
        setItems(reports)
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [id])

  if (loading || !order) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  const totalOrderedQty = items.reduce((s, i) => s + i.orderedQty, 0)
  const totalSoldQty = items.reduce((s, i) => s + i.soldQty, 0)
  const sellThroughPercent = totalOrderedQty > 0 ? (totalSoldQty / totalOrderedQty) * 100 : 0
  const totalProfit = items.reduce((s, i) => s + i.profit, 0)
  const totalRevenue = items.reduce((s, i) => s + i.soldRevenue, 0)
  const bestSelling = [...items].sort((a, b) => b.soldQty - a.soldQty)[0]

  const handleExport = () => {
    exportMultiSheetExcel(`تقرير-طلبية-${order.order_number}`, [
      {
        name: 'ملخص',
        rows: [
          { 'البيان': 'رقم الطلبية', 'القيمة': order.order_number },
          { 'البيان': 'المخزن', 'القيمة': warehouseName },
          { 'البيان': 'التاريخ', 'القيمة': new Date(order.created_at).toLocaleString('ar-EG') },
          { 'البيان': 'إجمالي تكلفة الطلبية', 'القيمة': order.total_cost.toFixed(2) },
          { 'البيان': 'نسبة بيع الطلبية', 'القيمة': `${sellThroughPercent.toFixed(0)}%` },
          { 'البيان': 'الإيراد الفعلي منها', 'القيمة': totalRevenue.toFixed(2) },
          { 'البيان': 'الربح الدقيق', 'القيمة': totalProfit.toFixed(2) },
          ...(order.notes ? [{ 'البيان': 'ملاحظات', 'القيمة': order.notes }] : []),
        ],
      },
      {
        name: 'الأصناف',
        rows: items.map((it) => ({
          'الصنف': it.name,
          'اتشرت': it.orderedQty,
          'اتباعت': it.soldQty,
          'المتبقي من هذه الطلبية': it.remainingQty,
          'تكلفة الوحدة': it.unitCost,
          'الإيراد منها': it.soldRevenue.toFixed(2),
          'الربح منها': it.profit.toFixed(2),
          'آخر بيع': it.lastSaleDate ? new Date(it.lastSaleDate).toLocaleDateString('ar-EG') : '-',
        })),
      },
    ])
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => navigate('/invoices')} className="flex items-center gap-1 text-sm text-accent-dark hover:underline">
          <ArrowRight size={14} /> رجوع للفواتير والطلبيات
        </button>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 bg-emerald-600 text-white rounded-xl px-3 md:px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          <FileSpreadsheet size={16} />
          <span className="hidden sm:inline">تصدير Excel</span>
        </button>
      </div>

      <div className="card p-5 md:p-6 mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">تقرير طلبية {order.order_number}</h1>
        <p className="text-sm text-slate-500 mt-1">{warehouseName} — {new Date(order.created_at).toLocaleString('ar-EG')}</p>
        {order.notes && <p className="text-sm text-slate-500 mt-1">{order.notes}</p>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي تكلفة الطلبية</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{order.total_cost.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">نسبة بيع الطلبية</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{sellThroughPercent.toFixed(0)}%</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">الإيراد الفعلي منها</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalRevenue.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">الربح الدقيق</p>
          <p className="font-mono-data font-bold text-lg text-emerald-600">{totalProfit.toFixed(2)}</p>
        </div>
      </div>

      {bestSelling && bestSelling.soldQty > 0 && (
        <p className="text-sm text-slate-600 mb-2">
          أكثر صنف مبيعًا من الطلبية دي: <span className="font-medium text-navy-900">{bestSelling.name}</span> ({bestSelling.soldQty} قطعة)
        </p>
      )}

      <p className="text-xs text-emerald-600 mb-4">
        ✓ الأرقام هنا دقيقة 100% — كل صنف متتبّع كدفعة مستقلة (Lot)، مش تقريب حسب التاريخ.
      </p>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-navy-900 text-white">
              <tr>
                <th className="p-2.5 text-right whitespace-nowrap">الصنف</th>
                <th className="p-2.5 text-right whitespace-nowrap">اتشرت</th>
                <th className="p-2.5 text-right whitespace-nowrap">اتباعت</th>
                <th className="p-2.5 text-right whitespace-nowrap">المتبقي من هذه الطلبية</th>
                <th className="p-2.5 text-right whitespace-nowrap">الربح منها</th>
                <th className="p-2.5 text-right whitespace-nowrap">آخر بيع</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-border-soft">
                  <td className="p-2.5 whitespace-nowrap">{it.name}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.orderedQty}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.soldQty}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.remainingQty}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap text-emerald-600">{it.profit.toFixed(2)}</td>
                  <td className="p-2.5 whitespace-nowrap text-slate-500">
                    {it.lastSaleDate ? new Date(it.lastSaleDate).toLocaleDateString('ar-EG') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
