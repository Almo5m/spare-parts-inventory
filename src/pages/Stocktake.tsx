import { useEffect, useState } from 'react'
import { Loader2, ClipboardCheck, ChevronDown, ChevronUp } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { nullableArg } from '../lib/rpcArgs'
import { fetchAll } from '../lib/fetchAll'
import Select from '../components/Select'
import type { Database } from '../lib/database.types'

type Warehouse = Database['public']['Tables']['warehouses']['Row']
type StocktakeRow = Database['public']['Tables']['stocktakes']['Row']
type StocktakeItemRow = Database['public']['Tables']['stocktake_items']['Row']

interface CountRow {
  productId: string
  partNumber: string
  name: string
  systemQty: number
  countedQty: string
}

export default function Stocktake() {
  const [tab, setTab] = useState<'new' | 'history'>('new')

  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [rows, setRows] = useState<CountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [notes, setNotes] = useState('')
  const [onlyDifferences, setOnlyDifferences] = useState(false)
  // بيتزوّد بعد كل جرد ناجح عشان الكميات المسجّلة تتحمّل من القاعدة تاني
  const [reloadKey, setReloadKey] = useState(0)

  const [history, setHistory] = useState<StocktakeRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [historyItems, setHistoryItems] = useState<StocktakeItemRow[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [warehouseNames, setWarehouseNames] = useState<Record<string, string>>({})
  const [productNames, setProductNames] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    supabase.from('warehouses').select('*').order('created_at').then(({ data }) => {
      if (cancelled) return
      if (data) {
        setWarehouses(data)
        setWarehouseNames(Object.fromEntries(data.map((w) => [w.id, w.name])))
        const def = data.find((w) => w.is_default) ?? data[0]
        if (def) setWarehouseId(def.id)
      }
    })
    fetchAll((from, to) => supabase.from('products').select('id, name').order('id').range(from, to)).then(({ data }) => {
      if (cancelled) return
      if (data) setProductNames(Object.fromEntries(data.map((p) => [p.id, p.name])))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!warehouseId) return
    let cancelled = false
    setLoading(true)

    Promise.all([
      fetchAll((from, to) => supabase
        .from('inventory')
        .select('product_id, quantity, products(part_number, name)')
        .eq('warehouse_id', warehouseId)
        .order('product_id')
        .range(from, to)),
    ]).then(([inv]) => {
      if (cancelled) return

      const combined: CountRow[] = (inv.data ?? []).map((row) => {
        const product = row.products as unknown as { part_number: string; name: string } | null
        return {
          productId: row.product_id,
          partNumber: product?.part_number ?? '-',
          name: product?.name ?? '-',
          systemQty: row.quantity,
          countedQty: String(row.quantity),
        }
      })
      setRows(combined)
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [warehouseId, reloadKey])

  const loadHistory = () => {
    setHistoryLoading(true)
    supabase
      .from('stocktakes')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (data) setHistory(data)
        setHistoryLoading(false)
      })
  }

  useEffect(() => {
    if (tab === 'history') loadHistory()
  }, [tab])

  const toggleExpand = async (stocktakeId: string) => {
    if (expandedId === stocktakeId) {
      setExpandedId(null)
      return
    }
    setExpandedId(stocktakeId)
    setItemsLoading(true)
    const { data } = await supabase
      .from('stocktake_items')
      .select('*')
      .eq('stocktake_id', stocktakeId)
    setHistoryItems(data ?? [])
    setItemsLoading(false)
  }

  const handleCountChange = (productId: string, value: string) => {
    setRows((prev) =>
      prev.map((r) => (r.productId === productId ? { ...r, countedQty: value } : r))
    )
  }

  const displayedRows = onlyDifferences
    ? rows.filter((r) => Number(r.countedQty) !== r.systemQty)
    : rows

  const differencesCount = rows.filter((r) => Number(r.countedQty) !== r.systemQty).length

  const handleSubmit = async () => {
    setError('')
    setSuccess('')

    const negativeRow = rows.find((r) => r.countedQty !== '' && Number(r.countedQty) < 0)
    if (negativeRow) {
      setError(`الكمية المعدودة لصنف "${negativeRow.name}" مينفعش تكون رقم سالب`)
      return
    }

    const changedItems = rows
      .filter((r) => r.countedQty !== '' && Number(r.countedQty) !== r.systemQty)
      .map((r) => ({ product_id: r.productId, counted_quantity: Number(r.countedQty) }))

    if (changedItems.length === 0) {
      setError('مفيش أي فرق بين المخزون الفعلي والمسجّل، مفيش داعي لعملية جرد')
      return
    }

    if (!confirm(`هيتم تعديل كمية ${changedItems.length} صنف في المخزون حسب الجرد. متأكد؟`)) return

    setSaving(true)

    const { error } = await supabase.rpc('apply_stocktake', {
      p_warehouse_id: warehouseId,
      p_notes: nullableArg(notes || null),
      p_items: changedItems,
    })

    if (error) {
      setError(error.message)
    } else {
      setSuccess(`تم تسوية ${changedItems.length} صنف بنجاح، والمخزون بقى مطابق للجرد الفعلي`)
      setNotes('')
      setReloadKey((k) => k + 1)
    }
    setSaving(false)
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-5 md:mb-6">الجرد</h1>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('new')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'new' ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
          }`}
        >
          جرد جديد
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'history' ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
          }`}
        >
          سجل الجرد
        </button>
      </div>

      {tab === 'new' ? (
        <>
          <div className="flex justify-end mb-4">
            <div className="w-full sm:w-64">
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.is_default ? ' (افتراضي)' : ''}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="card p-4 md:p-5 mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-sm text-slate-500">
              الجدول ده بيعرض بس الأصناف اللي ليها مخزون مسجّل في المخزن ده.
              اكتب الكمية الفعلية اللي شايفها قدام كل صنف.
            </p>
            <button
              onClick={() => setOnlyDifferences(!onlyDifferences)}
              className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                onlyDifferences
                  ? 'bg-accent text-white'
                  : 'bg-white border border-border-soft text-slate-600 hover:bg-surface'
              }`}
            >
              {onlyDifferences ? 'عرض الكل' : `فيها فرق (${differencesCount})`}
            </button>
          </div>

          <div className="card overflow-hidden mb-5">
            <div className="table-scroll">
              <table className="w-full text-right">
                <thead className="bg-navy-900 text-white text-sm">
                  <tr>
                    <th className="p-3 whitespace-nowrap">رقم القطعة</th>
                    <th className="p-3 whitespace-nowrap">الصنف</th>
                    <th className="p-3 whitespace-nowrap">الكمية المسجّلة</th>
                    <th className="p-3 whitespace-nowrap">الكمية الفعلية (عدّها)</th>
                    <th className="p-3 whitespace-nowrap">الفرق</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={5} className="p-6 text-center text-slate-500">
                      <div className="flex items-center justify-center gap-2"><Loader2 size={16} className="animate-spin" />جاري التحميل...</div>
                    </td></tr>
                  ) : displayedRows.length === 0 ? (
                    <tr><td colSpan={5} className="p-6 text-center text-slate-500">لا يوجد مخزون مسجّل في هذا المخزن بعد</td></tr>
                  ) : (
                    displayedRows.map((row) => {
                      const diff = (Number(row.countedQty) || 0) - row.systemQty
                      return (
                        <tr
                          key={row.productId}
                          className={`border-t border-border-soft transition-colors ${diff !== 0 ? 'bg-accent/5' : 'hover:bg-surface'}`}
                        >
                          <td className="p-3 font-mono-data whitespace-nowrap">{row.partNumber}</td>
                          <td className="p-3 whitespace-nowrap">{row.name}</td>
                          <td className="p-3 font-mono-data whitespace-nowrap text-slate-500">{row.systemQty}</td>
                          <td className="p-3 whitespace-nowrap">
                            <input
                              type="number"
                              min="0"
                              value={row.countedQty}
                              onChange={(e) => handleCountChange(row.productId, e.target.value)}
                              className="w-24 border border-border-soft rounded-lg px-2 py-1.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </td>
                          <td className={`p-3 font-mono-data whitespace-nowrap font-bold ${
                            diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'
                          }`}>
                            {diff > 0 ? `+${diff}` : diff}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-5 md:p-6">
            <input
              type="text"
              placeholder="ملاحظة على عملية الجرد (اختياري)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full border border-border-soft rounded-xl px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />

            {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
            {success && <p className="text-emerald-600 text-sm mb-3">{success}</p>}

            <button
              onClick={handleSubmit}
              disabled={saving || loading}
              className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <ClipboardCheck size={16} />}
              {saving ? 'جاري التسوية...' : 'تسجيل الجرد وتسوية الفروقات'}
            </button>
          </div>
        </>
      ) : (
        <div className="card overflow-hidden">
          {historyLoading ? (
            <div className="flex items-center justify-center gap-2 p-6 text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              جاري التحميل...
            </div>
          ) : history.length === 0 ? (
            <p className="p-6 text-center text-slate-500">لا توجد عمليات جرد سابقة</p>
          ) : (
            <ul>
              {history.map((h) => (
                <li key={h.id} className="border-t border-border-soft first:border-t-0">
                  <button
                    onClick={() => toggleExpand(h.id)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface transition-colors text-right"
                  >
                    <div>
                      <p className="font-medium text-navy-900">{warehouseNames[h.warehouse_id] ?? '-'}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {new Date(h.created_at).toLocaleString('ar-EG')}
                        {h.notes ? ` — ${h.notes}` : ''}
                      </p>
                    </div>
                    {expandedId === h.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>

                  {expandedId === h.id && (
                    <div className="panel-enter bg-surface p-4 border-t border-border-soft">
                      {itemsLoading ? (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <Loader2 size={14} className="animate-spin" />
                          جاري التحميل...
                        </div>
                      ) : (
                        <div className="table-scroll">
                          <table className="w-full text-sm bg-white rounded-lg overflow-hidden border border-border-soft">
                            <thead className="bg-navy-900 text-white">
                              <tr>
                                <th className="p-2 text-right whitespace-nowrap">الصنف</th>
                                <th className="p-2 text-right whitespace-nowrap">المسجّل قبل الجرد</th>
                                <th className="p-2 text-right whitespace-nowrap">المعدود فعليًا</th>
                                <th className="p-2 text-right whitespace-nowrap">الفرق</th>
                              </tr>
                            </thead>
                            <tbody>
                              {historyItems.map((item) => (
                                <tr key={item.id} className="border-t border-border-soft">
                                  <td className="p-2 whitespace-nowrap">{productNames[item.product_id] ?? item.product_id}</td>
                                  <td className="p-2 font-mono-data whitespace-nowrap text-slate-500">{item.system_quantity}</td>
                                  <td className="p-2 font-mono-data whitespace-nowrap">{item.counted_quantity}</td>
                                  <td className={`p-2 font-mono-data whitespace-nowrap font-bold ${
                                    item.difference > 0 ? 'text-emerald-600' : item.difference < 0 ? 'text-red-600' : 'text-slate-400'
                                  }`}>
                                    {item.difference > 0 ? `+${item.difference}` : item.difference}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
