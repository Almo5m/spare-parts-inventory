import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ArrowRight, AlertTriangle } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import type { Database } from '../lib/database.types'

type Warehouse = Database['public']['Tables']['warehouses']['Row']

export default function WarehouseReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null)
  const [stock, setStock] = useState<{ part_number: string; name: string; qty: number; min: number }[]>([])
  const [totalSales, setTotalSales] = useState(0)
  const [totalOrdersCost, setTotalOrdersCost] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    Promise.all([
      supabase.from('warehouses').select('*').eq('id', id).single(),
      fetchAll((from, to) => supabase.from('inventory').select('quantity, products(part_number, name, min_stock_alert)').eq('warehouse_id', id).order('product_id').range(from, to)),
      fetchAll((from, to) => supabase.from('sales_invoices').select('total_amount').eq('warehouse_id', id).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('orders').select('total_cost').eq('warehouse_id', id).order('id').range(from, to)),
    ]).then(([w, inv, sales, orders]) => {
      if (cancelled) return
      if (w.data) setWarehouse(w.data)

      setStock(
        (inv.data ?? []).map((r) => {
          const p = r.products as unknown as { part_number: string; name: string; min_stock_alert: number | null } | null
          return {
            part_number: p?.part_number ?? '-',
            name: p?.name ?? '-',
            qty: r.quantity,
            min: p?.min_stock_alert ?? 0,
          }
        })
      )

      setTotalSales((sales.data ?? []).reduce((s, i) => s + i.total_amount, 0))
      setTotalOrdersCost((orders.data ?? []).reduce((s, i) => s + i.total_cost, 0))
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [id])

  if (loading || !warehouse) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  const lowStockCount = stock.filter((s) => s.min > 0 && s.qty <= s.min).length

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <button onClick={() => navigate('/warehouses')} className="flex items-center gap-1 text-sm text-accent-dark hover:underline mb-4">
        <ArrowRight size={14} /> رجوع للمخازن
      </button>

      <div className="card p-5 md:p-6 mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">{warehouse.name}</h1>
        {warehouse.address && <p className="text-sm text-slate-500 mt-1">{warehouse.address}</p>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">عدد الأصناف</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{stock.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">أصناف تحت الحد الأدنى</p>
          <p className="font-mono-data font-bold text-lg text-red-600">{lowStockCount}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي المبيعات منه</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalSales.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي تكلفة طلبياته</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalOrdersCost.toFixed(2)}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <p className="font-display font-bold text-navy-900 p-5 pb-0">المخزون الحالي</p>
        <div className="table-scroll p-5 pt-3">
          <table className="w-full text-sm">
            <thead className="bg-navy-900 text-white">
              <tr>
                <th className="p-2 text-right whitespace-nowrap">رقم القطعة</th>
                <th className="p-2 text-right whitespace-nowrap">الصنف</th>
                <th className="p-2 text-right whitespace-nowrap">الكمية</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {stock.length === 0 ? (
                <tr><td colSpan={4} className="p-4 text-center text-slate-500">لا يوجد مخزون مسجّل في هذا المخزن</td></tr>
              ) : (
                stock.map((s, i) => (
                  <tr key={i} className="border-t border-border-soft">
                    <td className="p-2 font-mono-data whitespace-nowrap">{s.part_number}</td>
                    <td className="p-2 whitespace-nowrap">{s.name}</td>
                    <td className={`p-2 font-mono-data whitespace-nowrap font-bold ${s.min > 0 && s.qty <= s.min ? 'text-red-600' : ''}`}>{s.qty}</td>
                    <td className="p-2">
                      {s.min > 0 && s.qty <= s.min && (
                        <span className="flex items-center gap-1 text-xs text-red-600"><AlertTriangle size={12} />ناقص</span>
                      )}
                    </td>
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
