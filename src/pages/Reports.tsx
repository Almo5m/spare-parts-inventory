import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, FileSpreadsheet, BarChart3, Lightbulb } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import { netRatio } from '../lib/money'
import { invoicePartyName } from '../lib/party'
import { exportMultiSheetExcel } from '../lib/exportExcel'
import { exportWarehouseInventory } from '../lib/exportInventory'
import { getPeriodRange, type PeriodType } from '../lib/dateRanges'
import PeriodSelector from '../components/PeriodSelector'
import ReportQuickJump from '../components/ReportQuickJump'
import type { Database } from '../lib/database.types'

type Warehouse = Database['public']['Tables']['warehouses']['Row']
type ReportTab = 'sales' | 'profit' | 'orders' | 'inventory' | 'customers' | 'debts' | 'returns' | 'stocktake'

const tabLabels: Record<ReportTab, string> = {
  sales: 'المبيعات', profit: 'الأرباح', orders: 'الطلبيات', inventory: 'المخزون',
  customers: 'العملاء', debts: 'الديون', returns: 'المرتجعات', stocktake: 'الجرد',
}

export default function Reports() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<ReportTab>('sales')
  const [period, setPeriod] = useState<PeriodType>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<Record<string, string | number>[]>([])
  const [rowLinks, setRowLinks] = useState<(string | null)[]>([])
  const [summary, setSummary] = useState<{ label: string; value: string }[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [exportingWarehouseId, setExportingWarehouseId] = useState<string | null>(null)

  useEffect(() => {
    supabase.from('warehouses').select('*').order('created_at').then(({ data }) => {
      if (data) setWarehouses(data)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const range = getPeriodRange(period, customFrom, customTo)
    setLoading(true)

    async function load() {
      const fromIso = range.from.toISOString()
      const toIso = range.to.toISOString()

      if (tab === 'sales') {
        const { data } = await fetchAll((from, to) => supabase
          .from('sales_invoices')
          .select('*, customers(name)')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('created_at', { ascending: false }).order('id')
          .range(from, to))
        const list = data ?? []
        const total = list.reduce((s, i) => s + i.total_amount, 0)
        setSummary([
          { label: 'عدد الفواتير', value: String(list.length) },
          { label: 'إجمالي المبيعات', value: total.toFixed(2) },
        ])
        setRows(list.map((i) => ({
          'رقم الفاتورة': i.invoice_number,
          'العميل': invoicePartyName((i.customers as unknown as { name: string } | null)?.name, i.customer_name),
          'التاريخ': new Date(i.created_at).toLocaleDateString('ar-EG'),
          'الإجمالي': i.total_amount,
        })))
        setRowLinks(list.map((i) => `/reports/sale/${i.id}`))
      }

      if (tab === 'profit') {
        const { data: items } = await fetchAll((from, to) => supabase
          .from('sales_invoice_items')
          .select('*, sales_invoices!inner(id, created_at, invoice_number, total_amount, discount_amount)')
          .gte('sales_invoices.created_at', fromIso).lte('sales_invoices.created_at', toIso)
          .order('id')
          .range(from, to))

        const list = items ?? []
        let totalProfit = 0
        let totalRevenue = 0
        const byInvoice: Record<string, { id: string; revenue: number; profit: number }> = {}

        list.forEach((it) => {
          const inv = it.sales_invoices as unknown as
            { id: string; invoice_number: string; total_amount: number; discount_amount: number }
          // الإيراد بعد توزيع خصم الفاتورة على أسطرها
          const revenue = it.quantity * it.unit_price * netRatio(inv.total_amount, inv.discount_amount)
          const profit = revenue - (it.actual_cost ?? 0)
          totalRevenue += revenue
          totalProfit += profit
          if (!byInvoice[inv.invoice_number]) byInvoice[inv.invoice_number] = { id: inv.id, revenue: 0, profit: 0 }
          byInvoice[inv.invoice_number].revenue += revenue
          byInvoice[inv.invoice_number].profit += profit
        })

        // المرتجعات اللي اتسجلت في الفترة بتتخصم من الإيراد والربح (قيمتها ناقص تكلفتها)
        const { data: retData } = await fetchAll((from, to) => supabase
          .from('sales_returns')
          .select('total_amount, cost_amount')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('id')
          .range(from, to))
        const retTotal = (retData ?? []).reduce((s, r) => s + r.total_amount, 0)
        const retCost = (retData ?? []).reduce((s, r) => s + r.cost_amount, 0)
        totalRevenue -= retTotal
        totalProfit -= retTotal - retCost

        const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

        setSummary([
          { label: 'إجمالي الإيراد (بعد الخصم والمرتجعات)', value: totalRevenue.toFixed(2) },
          { label: 'مرتجعات الفترة', value: retTotal.toFixed(2) },
          { label: 'إجمالي الربح الدقيق', value: totalProfit.toFixed(2) },
          { label: 'هامش الربح', value: `${margin.toFixed(1)}%` },
        ])
        const profitEntries = Object.entries(byInvoice)
        const profitRows = profitEntries.map(([inv, v]) => ({
          'رقم الفاتورة': inv,
          'الإيراد': v.revenue.toFixed(2),
          'الربح الدقيق': v.profit.toFixed(2),
        }))
        setRows(profitRows)
        setRowLinks(profitEntries.map(([, v]) => `/reports/sale/${v.id}`))
      }

      if (tab === 'orders') {
        const { data } = await fetchAll((from, to) => supabase
          .from('orders')
          .select('*, warehouses(name)')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('created_at', { ascending: false }).order('id')
          .range(from, to))
        const list = data ?? []
        const total = list.reduce((s, o) => s + o.total_cost, 0)
        setSummary([
          { label: 'عدد الطلبيات', value: String(list.length) },
          { label: 'إجمالي التكلفة', value: total.toFixed(2) },
        ])
        setRows(list.map((o) => ({
          'رقم الطلبية': o.order_number,
          'المخزن': (o.warehouses as unknown as { name: string } | null)?.name ?? '-',
          'التاريخ': new Date(o.created_at).toLocaleDateString('ar-EG'),
          'التكلفة': o.total_cost,
        })))
        setRowLinks(list.map((o) => `/reports/order/${o.id}`))
      }

      if (tab === 'inventory') {
        const { data } = await fetchAll((from, to) => supabase
          .from('inventory')
          .select('product_id, quantity, products(part_number, name), warehouses(name)')
          .order('product_id').order('warehouse_id')
          .range(from, to))
        const list = data ?? []
        setSummary([{ label: 'عدد سجلات المخزون', value: String(list.length) }])
        setRows(list.map((r) => {
          const product = r.products as unknown as { part_number: string; name: string } | null
          const warehouse = r.warehouses as unknown as { name: string } | null
          return {
            'رقم القطعة': product?.part_number ?? '-',
            'الصنف': product?.name ?? '-',
            'المخزن': warehouse?.name ?? '-',
            'الكمية': r.quantity,
          }
        }))
        setRowLinks(list.map((r) => `/reports/product/${r.product_id}`))
      }

      if (tab === 'customers') {
        const { data } = await fetchAll((from, to) => supabase.from('customers').select('*').order('name').order('id').range(from, to))
        const list = data ?? []
        setSummary([{ label: 'عدد العملاء', value: String(list.length) }])
        setRows(list.map((c) => ({
          'الاسم': c.name, 'الهاتف': c.phone ?? '-', 'الرصيد': c.balance,
        })))
        setRowLinks(list.map((c) => `/statement/${c.id}`))
      }

      if (tab === 'debts') {
        const { data } = await fetchAll((from, to) => supabase.from('customers').select('*').gt('balance', 0).order('balance', { ascending: false }).order('id').range(from, to))
        const list = data ?? []
        const total = list.reduce((s, c) => s + c.balance, 0)
        setSummary([
          { label: 'عدد العملاء المدينين', value: String(list.length) },
          { label: 'إجمالي الديون', value: total.toFixed(2) },
        ])
        setRows(list.map((c) => ({ 'الاسم': c.name, 'الهاتف': c.phone ?? '-', 'المديونية': c.balance })))
        setRowLinks(list.map((c) => `/statement/${c.id}`))
      }

      if (tab === 'returns') {
        const { data: salesReturns } = await fetchAll((from, to) => supabase
          .from('sales_returns').select('*, sales_invoices(invoice_number)')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('id').range(from, to))
        const { data: orderReturns } = await fetchAll((from, to) => supabase
          .from('order_returns').select('*, orders(order_number)')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('id').range(from, to))

        const list1 = salesReturns ?? []
        const list2 = orderReturns ?? []
        const total = list1.reduce((s, r) => s + r.total_amount, 0) + list2.reduce((s, r) => s + r.total_amount, 0)

        setSummary([
          { label: 'عدد المرتجعات', value: String(list1.length + list2.length) },
          { label: 'إجمالي قيمة المرتجعات', value: total.toFixed(2) },
        ])
        setRows([
          ...list1.map((r) => ({
            'النوع': 'مرتجع بيع',
            'مرجع': (r.sales_invoices as unknown as { invoice_number: string } | null)?.invoice_number ?? '-',
            'التاريخ': new Date(r.created_at).toLocaleDateString('ar-EG'),
            'القيمة': r.total_amount,
          })),
          ...list2.map((r) => ({
            'النوع': 'مرتجع طلبية',
            'مرجع': (r.orders as unknown as { order_number: string } | null)?.order_number ?? '-',
            'التاريخ': new Date(r.created_at).toLocaleDateString('ar-EG'),
            'القيمة': r.total_amount,
          })),
        ])
        setRowLinks([
          ...list1.map((r) => `/reports/sale/${r.sales_invoice_id}`),
          ...list2.map((r) => `/reports/order/${r.order_id}`),
        ])
      }

      if (tab === 'stocktake') {
        const { data } = await fetchAll((from, to) => supabase
          .from('stocktakes').select('*, warehouses(name)')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('created_at', { ascending: false }).order('id')
          .range(from, to))
        const list = data ?? []
        setSummary([{ label: 'عدد عمليات الجرد', value: String(list.length) }])
        setRows(list.map((s) => ({
          'المخزن': (s.warehouses as unknown as { name: string } | null)?.name ?? '-',
          'التاريخ': new Date(s.created_at).toLocaleDateString('ar-EG'),
          'ملاحظات': s.notes ?? '',
        })))
        setRowLinks(list.map((s) => `/reports/warehouse/${s.warehouse_id}`))
      }

      if (!cancelled) setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [tab, period, customFrom, customTo])

  const hasLinks = rowLinks.some(Boolean)

  const handleExport = () => {
    exportMultiSheetExcel(`تقرير-${tabLabels[tab]}`, [
      { name: 'ملخص', rows: summary.map((s) => ({ 'البيان': s.label, 'القيمة': s.value })) },
      { name: tabLabels[tab], rows },
    ])
  }

  const handleExportWarehouse = async (w: Warehouse) => {
    setExportingWarehouseId(w.id)
    try {
      await exportWarehouseInventory(w.id, w.name)
    } finally {
      setExportingWarehouseId(null)
    }
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-6xl mx-auto">
      <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-5 md:mb-6">التقارير</h1>

      <div className="mb-5">
        <ReportQuickJump />
      </div>

      <div className="flex flex-wrap gap-2 mb-5">
        {(Object.keys(tabLabels) as ReportTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
              tab === t ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
            }`}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
        <button
          onClick={handleExport}
          disabled={rows.length === 0}
          className="flex items-center justify-center gap-2 bg-emerald-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          <FileSpreadsheet size={16} />
          تصدير Excel
        </button>
      </div>

      {tab === 'profit' && (
        <div className="flex items-start gap-2 bg-accent/10 text-accent-dark rounded-xl px-3.5 py-3 mb-5 text-sm">
          <Lightbulb size={16} className="shrink-0 mt-0.5" />
          <p>
            الجدول ده بيوريك الربح مجمّع على مستوى الفاتورة. لو عايز الربح الدقيق 100% لطلبية شراء
            معينة (مرتبط بدفعتها بالظبط)، دوّر عليها برقمها في مربع البحث السريع فوق.
          </p>
        </div>
      )}

      {tab === 'inventory' && warehouses.length > 0 && (
        <div className="card p-4 mb-5">
          <p className="text-sm font-medium text-navy-900 mb-3">تصدير مخزون تفصيلي لكل مخزن (ملف Excel مستقل لكل مخزن)</p>
          <div className="flex flex-wrap gap-2">
            {warehouses.map((w) => (
              <button
                key={w.id}
                onClick={() => handleExportWarehouse(w)}
                disabled={exportingWarehouseId === w.id}
                className="flex items-center gap-2 bg-white border border-border-soft rounded-xl px-3 py-2 text-sm text-slate-600 hover:border-emerald-500 hover:text-emerald-700 transition-colors disabled:opacity-50"
              >
                {exportingWarehouseId === w.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FileSpreadsheet size={14} />
                )}
                {w.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {summary.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {summary.map((s, i) => (
            <div key={i} className="card p-4">
              <p className="text-xs text-slate-500 mb-1">{s.label}</p>
              <p className="font-mono-data font-bold text-lg text-navy-900">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-right text-sm">
            {loading ? (
              <tbody><tr><td className="p-6 text-center text-slate-500">
                <div className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />جاري التحميل...</div>
              </td></tr></tbody>
            ) : rows.length === 0 ? (
              <tbody><tr><td className="p-6 text-center text-slate-500">لا توجد بيانات في الفترة المحددة</td></tr></tbody>
            ) : (
              <>
                <thead className="bg-navy-900 text-white">
                  <tr>
                    {Object.keys(rows[0]).map((key) => (
                      <th key={key} className="p-3 whitespace-nowrap font-normal">{key}</th>
                    ))}
                    {hasLinks && <th className="p-3"></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-t border-border-soft hover:bg-surface transition-colors">
                      {Object.values(row).map((val, j) => (
                        <td key={j} className="p-3 font-mono-data whitespace-nowrap">{val}</td>
                      ))}
                      {hasLinks && (
                        <td className="p-3 text-left whitespace-nowrap">
                          {rowLinks[i] && (
                            <button
                              onClick={() => navigate(rowLinks[i]!)}
                              className="flex items-center gap-1 text-xs text-accent-dark hover:underline"
                            >
                              <BarChart3 size={13} />
                              عرض التقرير
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
