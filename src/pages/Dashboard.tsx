import { useEffect, useState } from 'react'
import { Loader2, Users, Package } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import { getPeriodRange, periodLabels, type PeriodType } from '../lib/dateRanges'
import PeriodSelector from '../components/PeriodSelector'

interface TopEntry {
  name: string
  value: number
}

interface LatestInvoice {
  invoice_number: string
  type: 'بيع' | 'طلبية'
  party: string
  total: number
  date: string
}

interface ChartPoint {
  date: string
  sales: number
  profit: number
}

export default function Dashboard() {
  const [period, setPeriod] = useState<PeriodType>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [totalSales, setTotalSales] = useState(0)
  const [totalOrdersCost, setTotalOrdersCost] = useState(0)
  const [totalProfit, setTotalProfit] = useState(0)
  const [invoicesCount, setInvoicesCount] = useState(0)
  const [topCustomers, setTopCustomers] = useState<TopEntry[]>([])
  const [topSellingProducts, setTopSellingProducts] = useState<TopEntry[]>([])
  const [leastSellingProducts, setLeastSellingProducts] = useState<TopEntry[]>([])
  const [latestInvoices, setLatestInvoices] = useState<LatestInvoice[]>([])
  const [chartData, setChartData] = useState<ChartPoint[]>([])

  useEffect(() => {
    let cancelled = false
    const range = getPeriodRange(period, customFrom, customTo)

    async function loadStats() {
      setLoading(true)
      const fromIso = range.from.toISOString()
      const toIso = range.to.toISOString()

      // كل الاستعلامات هنا محصورة بالفترة المختارة بس — مش كل تاريخ
      // النظام من أول يوم، عشان الصفحة تفضل سريعة حتى مع سنين من
      // البيانات المتراكمة
      const [
        salesRes, ordersRes, saleItemsRes,
        customersRes, productsRes, warehousesRes,
      ] = await Promise.all([
        fetchAll((from, to) => supabase.from('sales_invoices').select('*')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('created_at', { ascending: false }).order('id').range(from, to)),
        fetchAll((from, to) => supabase.from('orders').select('*')
          .gte('created_at', fromIso).lte('created_at', toIso)
          .order('created_at', { ascending: false }).order('id').range(from, to)),
        fetchAll((from, to) => supabase.from('sales_invoice_items').select('*, sales_invoices!inner(created_at)')
          .gte('sales_invoices.created_at', fromIso).lte('sales_invoices.created_at', toIso)
          .order('id').range(from, to)),
        fetchAll((from, to) => supabase.from('customers').select('id, name').order('id').range(from, to)),
        fetchAll((from, to) => supabase.from('products').select('id, name').order('id').range(from, to)),
        supabase.from('warehouses').select('id, name'),
      ])

      if (cancelled) return

      const sales = salesRes.data ?? []
      const orders = ordersRes.data ?? []
      const saleItems = saleItemsRes.data ?? []
      const customerMap = Object.fromEntries((customersRes.data ?? []).map((c) => [c.id, c.name]))
      const productMap = Object.fromEntries((productsRes.data ?? []).map((p) => [p.id, p.name]))
      const warehouseMap = Object.fromEntries((warehousesRes.data ?? []).map((w) => [w.id, w.name]))

      setTotalSales(sales.reduce((sum, s) => sum + s.total_amount, 0))
      setTotalOrdersCost(orders.reduce((sum, o) => sum + o.total_cost, 0))
      setInvoicesCount(sales.length)

      // الربح الدقيق: الإيراد ناقص التكلفة الفعلية الحقيقية (actual_cost)
      // المسجّلة وقت البيع من نظام الدفعات (FIFO)، مش تقدير
      let profit = 0
      const dailyMap: Record<string, { sales: number; profit: number }> = {}

      saleItems.forEach((it) => {
        const inv = it.sales_invoices as unknown as { created_at: string } | null
        const itemRevenue = it.quantity * it.unit_price
        const itemProfit = itemRevenue - (it.actual_cost ?? 0)
        profit += itemProfit

        if (inv) {
          const day = new Date(inv.created_at).toISOString().slice(0, 10)
          if (!dailyMap[day]) dailyMap[day] = { sales: 0, profit: 0 }
          dailyMap[day].sales += itemRevenue
          dailyMap[day].profit += itemProfit
        }
      })
      setTotalProfit(profit)

      // نقط الرسم البياني بعدد أيام الفترة المختارة بالظبط (يوم/أسبوع/شهر
      // بيدّوا رسم يومي مقروء، وسنة كاملة بتدّي رسم كثيف لكن لسه سريع)
      const dayCount = Math.min(
        Math.round((range.to.getTime() - range.from.getTime()) / (1000 * 60 * 60 * 24)) + 1,
        366
      )
      const chart: ChartPoint[] = []
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(range.from)
        d.setDate(d.getDate() + i)
        const key = d.toISOString().slice(0, 10)
        chart.push({
          date: d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }),
          sales: Math.round((dailyMap[key]?.sales ?? 0) * 100) / 100,
          profit: Math.round((dailyMap[key]?.profit ?? 0) * 100) / 100,
        })
      }
      setChartData(chart)

      const customerTotals: Record<string, number> = {}
      sales.forEach((s) => {
        if (!s.customer_id) return
        customerTotals[s.customer_id] = (customerTotals[s.customer_id] ?? 0) + s.total_amount
      })
      setTopCustomers(
        Object.entries(customerTotals).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, value]) => ({ name: customerMap[id] ?? 'غير معروف', value }))
      )

      const sellingTotals: Record<string, number> = {}
      saleItems.forEach((it) => {
        sellingTotals[it.product_id] = (sellingTotals[it.product_id] ?? 0) + Number(it.quantity)
      })
      setTopSellingProducts(
        Object.entries(sellingTotals).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([id, value]) => ({ name: productMap[id] ?? 'غير معروف', value }))
      )
      setLeastSellingProducts(
        Object.entries(sellingTotals).sort((a, b) => a[1] - b[1]).slice(0, 5)
          .map(([id, value]) => ({ name: productMap[id] ?? 'غير معروف', value }))
      )

      const combined: LatestInvoice[] = [
        ...sales.map((s) => ({
          invoice_number: s.invoice_number, type: 'بيع' as const,
          party: s.customer_id ? customerMap[s.customer_id] ?? 'عميل نقدي' : 'عميل نقدي',
          total: s.total_amount, date: s.created_at,
        })),
        ...orders.map((o) => ({
          invoice_number: o.order_number, type: 'طلبية' as const,
          party: warehouseMap[o.warehouse_id] ?? '-',
          total: o.total_cost, date: o.created_at,
        })),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 8)

      setLatestInvoices(combined)
      setLoading(false)
    }

    loadStats()
    return () => { cancelled = true }
  }, [period, customFrom, customTo])

  const profitMargin = totalSales > 0 ? (totalProfit / totalSales) * 100 : 0

  return (
    <div className="page-enter p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 md:mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">لوحة الإحصائيات</h1>
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      {loading ? (
        <div className="p-8 flex items-center gap-2 text-slate-500">
          <Loader2 size={16} className="animate-spin" />
          جاري تحميل الإحصائيات...
        </div>
      ) : (
      <>
      {/* الربح هو الرقم الأهم، فبياخد مساحة وتباين أكبر؛ باقي الأرقام أهدى في قائمة واحدة */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
        <div className="md:col-span-3 rounded-2xl bg-navy-900 text-white p-6 flex flex-col justify-between min-h-[9.5rem]">
          <p className="text-sm text-white/65">الأرباح الدقيقة — {periodLabels[period]}</p>
          <div>
            <p className="font-mono-data font-bold text-4xl md:text-5xl leading-none">{totalProfit.toFixed(0)}</p>
            <p className="text-sm text-white/65 mt-3">
              هامش {profitMargin.toFixed(0)}% من مبيعات {totalSales.toFixed(0)}
            </p>
          </div>
        </div>
        <dl className="md:col-span-2 card px-5 py-2 divide-y divide-border-soft self-stretch flex flex-col justify-center">
          <div className="flex items-center justify-between py-3">
            <dt className="text-sm text-slate-500">المبيعات</dt>
            <dd className="font-mono-data font-bold text-navy-900">{totalSales.toFixed(0)}</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-sm text-slate-500">تكلفة الطلبيات</dt>
            <dd className="font-mono-data font-bold text-navy-900">{totalOrdersCost.toFixed(0)}</dd>
          </div>
          <div className="flex items-center justify-between py-3">
            <dt className="text-sm text-slate-500">عدد الفواتير</dt>
            <dd className="font-mono-data font-bold text-navy-900">{invoicesCount}</dd>
          </div>
        </dl>
      </div>

      <p className="text-xs text-emerald-600 mb-4">
        ✓ الأرباح دلوقتي دقيقة 100%، محسوبة من التكلفة الحقيقية الفعلية لكل قطعة اتباعت (نظام تتبع الدفعات FIFO).
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="card p-5">
          <p className="font-display font-bold text-navy-900 mb-3">المبيعات — {periodLabels[period]}</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e9f2" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="sales" stroke="#f0930f" strokeWidth={2} dot={false} name="المبيعات" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <p className="font-display font-bold text-navy-900 mb-3">الأرباح — {periodLabels[period]}</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e9f2" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="profit" stroke="#101d40" strokeWidth={2} dot={false} name="الربح" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users size={16} className="text-accent-dark" />
            <p className="font-display font-bold text-navy-900">أهم العملاء</p>
          </div>
          {topCustomers.length === 0 ? <p className="text-sm text-slate-500">لا توجد بيانات كافية</p> : (
            <ul className="space-y-2">
              {topCustomers.map((c, i) => (
                <li key={i} className="flex justify-between gap-2 text-sm">
                  <span className="truncate">{c.name}</span>
                  <span className="font-mono-data font-medium shrink-0">{c.value.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Package size={16} className="text-accent-dark" />
            <p className="font-display font-bold text-navy-900">الأكثر مبيعًا</p>
          </div>
          {topSellingProducts.length === 0 ? <p className="text-sm text-slate-500">لا توجد بيانات كافية</p> : (
            <ul className="space-y-2">
              {topSellingProducts.map((p, i) => (
                <li key={i} className="flex justify-between gap-2 text-sm">
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono-data font-medium shrink-0">{p.value} قطعة</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Package size={16} className="text-slate-400" />
            <p className="font-display font-bold text-navy-900">الأقل مبيعًا</p>
          </div>
          {leastSellingProducts.length === 0 ? <p className="text-sm text-slate-500">لا توجد بيانات كافية</p> : (
            <ul className="space-y-2">
              {leastSellingProducts.map((p, i) => (
                <li key={i} className="flex justify-between gap-2 text-sm">
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono-data font-medium shrink-0">{p.value} قطعة</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <p className="font-display font-bold text-navy-900 mb-3">آخر الحركات</p>
          {latestInvoices.length === 0 ? <p className="text-sm text-slate-500">لا توجد حركات بعد</p> : (
            <ul className="space-y-2">
              {latestInvoices.map((inv, i) => (
                <li key={i} className="flex justify-between gap-2 text-sm">
                  <span className="truncate">
                    <span className={inv.type === 'بيع' ? 'text-emerald-600' : 'text-red-600'}>{inv.type}</span>
                    {' '}— {inv.party}
                  </span>
                  <span className="font-mono-data font-medium shrink-0">{inv.total}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  )
}
