import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ArrowRight, FileSpreadsheet } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import { exportMultiSheetExcel } from '../lib/exportExcel'
import type { Database } from '../lib/database.types'

type SalesInvoice = Database['public']['Tables']['sales_invoices']['Row']

interface ItemReport {
  name: string
  unitName: string
  quantity: number
  unitPrice: number
  lineTotal: number
  actualCost: number
  profit: number
}

export default function SaleReport() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [invoice, setInvoice] = useState<SalesInvoice | null>(null)
  const [customerName, setCustomerName] = useState('عميل نقدي')
  const [warehouseName, setWarehouseName] = useState('')
  const [items, setItems] = useState<ItemReport[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    const invoiceId = id
    let cancelled = false

    async function load() {
      const { data: invoiceData } = await supabase.from('sales_invoices').select('*').eq('id', invoiceId).single()
      if (!invoiceData) { setLoading(false); return }
      if (cancelled) return
      setInvoice(invoiceData)

      const [customerRes, warehouseRes, itemsRes, productsRes] = await Promise.all([
        invoiceData.customer_id
          ? supabase.from('customers').select('name').eq('id', invoiceData.customer_id).single()
          : Promise.resolve({ data: null }),
        supabase.from('warehouses').select('name').eq('id', invoiceData.warehouse_id).single(),
        supabase.from('sales_invoice_items').select('*').eq('invoice_id', invoiceId),
        fetchAll((from, to) => supabase.from('products').select('id, name').order('id').range(from, to)),
      ])

      if (cancelled) return

      if (customerRes.data) setCustomerName(customerRes.data.name)
      setWarehouseName(warehouseRes.data?.name ?? '-')

      const productMap = Object.fromEntries((productsRes.data ?? []).map((p) => [p.id, p.name]))

      const reports: ItemReport[] = (itemsRes.data ?? []).map((it) => ({
        name: productMap[it.product_id] ?? it.product_id,
        unitName: it.unit_name,
        quantity: it.quantity,
        unitPrice: it.unit_price,
        lineTotal: it.line_total,
        actualCost: it.actual_cost ?? 0,
        profit: it.line_total - (it.actual_cost ?? 0),
      }))

      setItems(reports)
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [id])

  if (loading || !invoice) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  const totalCost = items.reduce((s, i) => s + i.actualCost, 0)
  const totalProfit = items.reduce((s, i) => s + i.profit, 0)
  const margin = invoice.total_amount > 0 ? (totalProfit / invoice.total_amount) * 100 : 0
  const remaining = invoice.total_amount - invoice.paid_amount
  const bestSelling = [...items].sort((a, b) => b.quantity - a.quantity)[0]

  const paymentStatusLabel = { paid: 'مدفوعة بالكامل', partial: 'مدفوعة جزئيًا', unpaid: 'غير مدفوعة' }[invoice.payment_status]

  const handleExport = () => {
    exportMultiSheetExcel(`تقرير-فاتورة-${invoice.invoice_number}`, [
      {
        name: 'ملخص',
        rows: [
          { 'البيان': 'رقم الفاتورة', 'القيمة': invoice.invoice_number },
          { 'البيان': 'العميل', 'القيمة': customerName },
          { 'البيان': 'المخزن', 'القيمة': warehouseName },
          { 'البيان': 'التاريخ', 'القيمة': new Date(invoice.created_at).toLocaleString('ar-EG') },
          { 'البيان': 'الإجمالي', 'القيمة': invoice.total_amount.toFixed(2) },
          { 'البيان': 'الخصم', 'القيمة': invoice.discount_amount.toFixed(2) },
          { 'البيان': 'المدفوع', 'القيمة': invoice.paid_amount.toFixed(2) },
          { 'البيان': 'المتبقي', 'القيمة': remaining.toFixed(2) },
          { 'البيان': 'حالة السداد', 'القيمة': paymentStatusLabel },
          { 'البيان': 'إجمالي التكلفة الفعلية', 'القيمة': totalCost.toFixed(2) },
          { 'البيان': 'الربح الدقيق', 'القيمة': totalProfit.toFixed(2) },
          { 'البيان': 'هامش الربح', 'القيمة': `${margin.toFixed(1)}%` },
        ],
      },
      {
        name: 'الأصناف',
        rows: items.map((it) => ({
          'الصنف': it.name,
          'الوحدة': it.unitName,
          'الكمية': it.quantity,
          'سعر الوحدة': it.unitPrice,
          'الإجمالي': it.lineTotal.toFixed(2),
          'التكلفة الفعلية': it.actualCost.toFixed(2),
          'الربح': it.profit.toFixed(2),
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
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">تقرير فاتورة {invoice.invoice_number}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {customerName} — {warehouseName} — {new Date(invoice.created_at).toLocaleString('ar-EG')}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي الفاتورة</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{invoice.total_amount.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">حالة السداد</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{paymentStatusLabel}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">إجمالي التكلفة الفعلية</p>
          <p className="font-mono-data font-bold text-lg text-navy-900">{totalCost.toFixed(2)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">الربح الدقيق (هامش {margin.toFixed(1)}%)</p>
          <p className="font-mono-data font-bold text-lg text-emerald-600">{totalProfit.toFixed(2)}</p>
        </div>
      </div>

      {remaining > 0 && (
        <p className="text-sm text-red-600 mb-2">متبقي على العميل من الفاتورة دي: {remaining.toFixed(2)}</p>
      )}

      {bestSelling && (
        <p className="text-sm text-slate-600 mb-2">
          أكثر صنف كمية في الفاتورة دي: <span className="font-medium text-navy-900">{bestSelling.name}</span> ({bestSelling.quantity} {bestSelling.unitName})
        </p>
      )}

      <p className="text-xs text-emerald-600 mb-4">
        ✓ التكلفة والربح هنا دقيقين 100% — محسوبين من نفس الدفعات (Lots) اللي اتباعت منها الفاتورة فعليًا.
      </p>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-navy-900 text-white">
              <tr>
                <th className="p-2.5 text-right whitespace-nowrap">الصنف</th>
                <th className="p-2.5 text-right whitespace-nowrap">الوحدة</th>
                <th className="p-2.5 text-right whitespace-nowrap">الكمية</th>
                <th className="p-2.5 text-right whitespace-nowrap">سعر الوحدة</th>
                <th className="p-2.5 text-right whitespace-nowrap">الإجمالي</th>
                <th className="p-2.5 text-right whitespace-nowrap">الربح</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-border-soft">
                  <td className="p-2.5 whitespace-nowrap">{it.name}</td>
                  <td className="p-2.5 whitespace-nowrap text-slate-500">{it.unitName}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.quantity}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.unitPrice}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{it.lineTotal.toFixed(2)}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap text-emerald-600">{it.profit.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
