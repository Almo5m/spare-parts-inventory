import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ArrowRight } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import type { Database } from '../lib/database.types'

type Product = Database['public']['Tables']['products']['Row']

export default function ProductReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [product, setProduct] = useState<Product | null>(null)
  const [stockByWarehouse, setStockByWarehouse] = useState<{ name: string; qty: number }[]>([])
  const [totalSoldQty, setTotalSoldQty] = useState(0)
  const [totalRevenue, setTotalRevenue] = useState(0)
  const [totalProfit, setTotalProfit] = useState(0)
  const [salesHistory, setSalesHistory] = useState<{ date: string; invoice: string; qty: number; price: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    Promise.all([
      supabase.from('products').select('*').eq('id', id).single(),
      supabase.from('inventory').select('quantity, warehouses(name)').eq('product_id', id),
      fetchAll((from, to) => supabase.from('sales_invoice_items').select('*, sales_invoices(invoice_number, created_at)').eq('product_id', id).order('id').range(from, to)),
    ]).then(([p, inv, items]) => {
      if (cancelled) return
      if (p.data) setProduct(p.data)

      setStockByWarehouse(
        (inv.data ?? []).map((r) => ({
          name: (r.warehouses as unknown as { name: string } | null)?.name ?? '-',
          qty: r.quantity,
        }))
      )

      const list = items.data ?? []
      setTotalSoldQty(list.reduce((s, i) => s + Number(i.quantity), 0))
      setTotalRevenue(list.reduce((s, i) => s + i.quantity * i.unit_price, 0))
      setTotalProfit(list.reduce((s, i) => s + (i.quantity * i.unit_price - (i.actual_cost ?? 0)), 0))
      setSalesHistory(
        list
          .map((i) => {
            const inv = i.sales_invoices as unknown as { invoice_number: string; created_at: string } | null
            return {
              date: inv?.created_at ?? '',
              invoice: inv?.invoice_number ?? '-',
              qty: i.quantity,
              price: i.unit_price,
            }
          })
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      )

      setLoading(false)
    })

    return () => { cancelled = true }
  }, [id])

  if (loading || !product) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  const totalStock = stockByWarehouse.reduce((s, w) => s + w.qty, 0)

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <button onClick={() => navigate('/products')} className="flex items-center gap-1 text-sm text-accent-dark hover:underline mb-4">
        <ArrowRight size={14} /> رجوع للأصناف
      </button>

      <div className="card p-5 md:p-6 mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">{product.name}</h1>
        <p className="text-sm text-slate-500 font-mono-data mt-1">{product.part_number}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">المخزون الحالي (كل المخازن)</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalStock}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي الكمية المباعة</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalSoldQty}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي الإيراد</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalRevenue.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">الربح الدقيق</p>
          <p className="font-mono-data font-bold text-lg text-emerald-600">{totalProfit.toFixed(2)}</p>
        </div>
      </div>

      <div className="card p-5 mb-6">
        <p className="font-display font-bold text-navy-900 mb-3">المخزون حسب المخزن</p>
        {stockByWarehouse.length === 0 ? (
          <p className="text-sm text-slate-500">لا يوجد مخزون مسجّل لهذا الصنف</p>
        ) : (
          <ul className="space-y-2">
            {stockByWarehouse.map((w, i) => (
              <li key={i} className="flex justify-between text-sm">
                <span>{w.name}</span>
                <span className="font-mono-data font-medium">{w.qty}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card overflow-hidden">
        <p className="font-display font-bold text-navy-900 p-5 pb-0">سجل المبيعات</p>
        <div className="table-scroll p-5 pt-3">
          <table className="w-full text-sm">
            <thead className="bg-navy-900 text-white">
              <tr>
                <th className="p-2 text-right whitespace-nowrap">الفاتورة</th>
                <th className="p-2 text-right whitespace-nowrap">التاريخ</th>
                <th className="p-2 text-right whitespace-nowrap">الكمية</th>
                <th className="p-2 text-right whitespace-nowrap">السعر</th>
              </tr>
            </thead>
            <tbody>
              {salesHistory.length === 0 ? (
                <tr><td colSpan={4} className="p-4 text-center text-slate-500">لا يوجد سجل مبيعات لهذا الصنف بعد</td></tr>
              ) : (
                salesHistory.map((h, i) => (
                  <tr key={i} className="border-t border-border-soft">
                    <td className="p-2 font-mono-data whitespace-nowrap">{h.invoice}</td>
                    <td className="p-2 whitespace-nowrap text-slate-500">{new Date(h.date).toLocaleDateString('ar-EG')}</td>
                    <td className="p-2 font-mono-data whitespace-nowrap">{h.qty}</td>
                    <td className="p-2 font-mono-data whitespace-nowrap">{h.price}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
