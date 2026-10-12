import { useEffect, useState } from 'react'
import { Loader2, Undo2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { nullableArg } from '../lib/rpcArgs'
import { fetchAll } from '../lib/fetchAll'
import Select from '../components/Select'
import type { Database } from '../lib/database.types'

type SaleInvoice = Database['public']['Tables']['sales_invoices']['Row']
type SaleItem = Database['public']['Tables']['sales_invoice_items']['Row']
type Order = Database['public']['Tables']['orders']['Row']
type OrderItem = Database['public']['Tables']['order_items']['Row']
type ProductUnit = Database['public']['Tables']['product_units']['Row']

export default function Returns() {
  const [tab, setTab] = useState<'sale' | 'order'>('sale')

  // ---------- مرتجع بيع ----------
  const [invoices, setInvoices] = useState<SaleInvoice[]>([])
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({})
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('')
  const [saleItems, setSaleItems] = useState<(SaleItem & { returnQty: string })[]>([])

  // ---------- مرتجع طلبية ----------
  const [orders, setOrders] = useState<Order[]>([])
  const [warehouseNames, setWarehouseNames] = useState<Record<string, string>>({})
  const [selectedOrderId, setSelectedOrderId] = useState('')
  const [orderItems, setOrderItems] = useState<(OrderItem & { returnQty: string })[]>([])

  const [productNames, setProductNames] = useState<Record<string, string>>({})
  const [productBaseUnits, setProductBaseUnits] = useState<Record<string, string>>({})
  const [productUnits, setProductUnits] = useState<ProductUnit[]>([])
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // معامل التحويل الحقيقي للوحدة (لو كانت الوحدة الأساسية = 1، وإلا
  // بنجيبه من جدول وحدات القياس بتاعة الصنف — عشان مرتجع "كرتونة" مثلًا
  // يرجّع الكمية الصح بالقطعة مش يفترض إنها قطعة واحدة بالغلط)
  const getConversionFactor = (productId: string, unitName: string) => {
    if (productBaseUnits[productId] === unitName) return 1
    const pu = productUnits.find((u) => u.product_id === productId && u.unit_name === unitName)
    return pu?.conversion_factor ?? 1
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('sales_invoices').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(100),
      fetchAll((from, to) => supabase.from('customers').select('id, name').order('id').range(from, to)),
      supabase.from('warehouses').select('id, name'),
      fetchAll((from, to) => supabase.from('products').select('id, name, base_unit').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('product_units').select('*').order('id').range(from, to)),
    ]).then(([inv, ord, c, w, p, pu]) => {
      if (cancelled) return
      if (inv.data) setInvoices(inv.data)
      if (ord.data) setOrders(ord.data)
      if (c.data) setCustomerNames(Object.fromEntries(c.data.map((x) => [x.id, x.name])))
      if (w.data) setWarehouseNames(Object.fromEntries(w.data.map((x) => [x.id, x.name])))
      if (p.data) {
        setProductNames(Object.fromEntries(p.data.map((x) => [x.id, x.name])))
        setProductBaseUnits(Object.fromEntries(p.data.map((x) => [x.id, x.base_unit])))
      }
      if (pu.data) setProductUnits(pu.data)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const loadSaleItems = async (invoiceId: string) => {
    setSelectedInvoiceId(invoiceId)
    setError('')
    setSuccess('')
    if (!invoiceId) { setSaleItems([]); return }

    const [{ data: items }, { data: pastReturns }] = await Promise.all([
      supabase.from('sales_invoice_items').select('*').eq('invoice_id', invoiceId),
      supabase
        .from('sales_return_items')
        .select('product_id, quantity, sales_returns!inner(sales_invoice_id)')
        .eq('sales_returns.sales_invoice_id', invoiceId),
    ])

    // نحسب كام قطعة اتردت بالفعل من كل صنف قبل كده، عشان نوري المستخدم
    // الكمية اللي لسه متاحة يرجعها فعليًا بدل ما يفاجأ بالرفض
    const returnedMap: Record<string, number> = {}
    for (const r of pastReturns ?? []) {
      returnedMap[r.product_id] = (returnedMap[r.product_id] ?? 0) + Number(r.quantity)
    }

    setSaleItems(
      (items ?? []).map((it) => ({
        ...it,
        quantity: it.quantity - (returnedMap[it.product_id] ?? 0),
        returnQty: '0',
      }))
    )
  }

  const loadOrderItems = async (orderId: string) => {
    setSelectedOrderId(orderId)
    setError('')
    setSuccess('')
    if (!orderId) { setOrderItems([]); return }

    const [{ data: items }, { data: pastReturns }] = await Promise.all([
      supabase.from('order_items').select('*').eq('order_id', orderId),
      supabase
        .from('order_return_items')
        .select('product_id, quantity, order_returns!inner(order_id)')
        .eq('order_returns.order_id', orderId),
    ])

    const returnedMap: Record<string, number> = {}
    for (const r of pastReturns ?? []) {
      returnedMap[r.product_id] = (returnedMap[r.product_id] ?? 0) + Number(r.quantity)
    }

    setOrderItems(
      (items ?? []).map((it) => ({
        ...it,
        quantity: it.quantity - (returnedMap[it.product_id] ?? 0),
        returnQty: '0',
      }))
    )
  }

  const handleSaleReturn = async () => {
    setError('')
    setSuccess('')

    const items = saleItems
      .filter((it) => Number(it.returnQty) > 0)
      .map((it) => ({
        product_id: it.product_id,
        unit_name: it.unit_name,
        conversion_factor: getConversionFactor(it.product_id, it.unit_name),
        quantity: Number(it.returnQty),
        unit_price: it.unit_price,
      }))

    if (items.length === 0) {
      setError('حدد كمية أكبر من صفر لصنف واحد على الأقل')
      return
    }


    setSaving(true)
    const { error } = await supabase.rpc('create_sales_return', {
      p_sales_invoice_id: selectedInvoiceId,
      p_items: items,
      p_notes: nullableArg(notes || null),
    })

    if (error) {
      setError(error.message)
    } else {
      setSuccess('تم تسجيل المرتجع بنجاح وتحديث المخزون والرصيد')
      setSaleItems(saleItems.map((it) => ({ ...it, returnQty: '0' })))
      setNotes('')
    }
    setSaving(false)
  }

  const handleOrderReturn = async () => {
    setError('')
    setSuccess('')

    const items = orderItems
      .filter((it) => Number(it.returnQty) > 0)
      .map((it) => ({
        product_id: it.product_id,
        unit_name: it.unit_name,
        conversion_factor: getConversionFactor(it.product_id, it.unit_name),
        quantity: Number(it.returnQty),
        unit_cost: it.unit_cost,
      }))

    if (items.length === 0) {
      setError('حدد كمية أكبر من صفر لصنف واحد على الأقل')
      return
    }

    setSaving(true)
    const { error } = await supabase.rpc('create_order_return', {
      p_order_id: selectedOrderId,
      p_items: items,
      p_notes: nullableArg(notes || null),
    })

    if (error) {
      setError(error.message)
    } else {
      setSuccess('تم تسجيل مرتجع الطلبية بنجاح وتحديث المخزون')
      setOrderItems(orderItems.map((it) => ({ ...it, returnQty: '0' })))
      setNotes('')
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-5 md:mb-6">المرتجعات</h1>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab('sale')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'sale' ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
          }`}
        >
          مرتجع بيع
        </button>
        <button
          onClick={() => setTab('order')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
            tab === 'order' ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
          }`}
        >
          مرتجع طلبية
        </button>
      </div>

      {tab === 'sale' ? (
        <>
          <div className="card p-5 md:p-6 mb-5">
            <label className="block text-sm text-slate-500 mb-2">اختر الفاتورة</label>
            <Select value={selectedInvoiceId} onChange={(e) => loadSaleItems(e.target.value)}>
              <option value="">اختر فاتورة بيع...</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoice_number} — {customerNames[inv.customer_id ?? ''] ?? 'عميل نقدي'}
                </option>
              ))}
            </Select>
          </div>

          {selectedInvoiceId && (
            <>
              <div className="card overflow-hidden mb-5">
                <div className="table-scroll">
                  <table className="w-full text-right">
                    <thead className="bg-navy-900 text-white text-sm">
                      <tr>
                        <th className="p-3 whitespace-nowrap">الصنف</th>
                        <th className="p-3 whitespace-nowrap">الوحدة</th>
                        <th className="p-3 whitespace-nowrap">المتاح للإرجاع</th>
                        <th className="p-3 whitespace-nowrap">السعر</th>
                        <th className="p-3 whitespace-nowrap">كمية المرتجع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saleItems.map((it, i) => (
                        <tr key={it.id} className="border-t border-border-soft">
                          <td className="p-3 whitespace-nowrap">{productNames[it.product_id] ?? it.product_id}</td>
                          <td className="p-3 whitespace-nowrap">{it.unit_name}</td>
                          <td className="p-3 font-mono-data whitespace-nowrap text-slate-500">{it.quantity}</td>
                          <td className="p-3 font-mono-data whitespace-nowrap">{it.unit_price}</td>
                          <td className="p-3 whitespace-nowrap">
                            <input
                              type="number"
                              min="0"
                              max={it.quantity}
                              value={it.returnQty}
                              onChange={(e) => {
                                const updated = [...saleItems]
                                updated[i] = { ...it, returnQty: e.target.value }
                                setSaleItems(updated)
                              }}
                              className="w-24 border border-border-soft rounded-lg px-2 py-1.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card p-5 md:p-6">
                <input
                  type="text"
                  placeholder="سبب المرتجع (اختياري)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full border border-border-soft rounded-xl px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
                />
                {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
                {success && <p className="text-emerald-600 text-sm mb-3">{success}</p>}
                <button
                  onClick={handleSaleReturn}
                  disabled={saving}
                  className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
                  تسجيل المرتجع
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="card p-5 md:p-6 mb-5">
            <label className="block text-sm text-slate-500 mb-2">اختر الطلبية</label>
            <Select value={selectedOrderId} onChange={(e) => loadOrderItems(e.target.value)}>
              <option value="">اختر طلبية...</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.order_number} — {warehouseNames[o.warehouse_id] ?? '-'}
                </option>
              ))}
            </Select>
          </div>

          {selectedOrderId && (
            <>
              <div className="card overflow-hidden mb-5">
                <div className="table-scroll">
                  <table className="w-full text-right">
                    <thead className="bg-navy-900 text-white text-sm">
                      <tr>
                        <th className="p-3 whitespace-nowrap">الصنف</th>
                        <th className="p-3 whitespace-nowrap">الوحدة</th>
                        <th className="p-3 whitespace-nowrap">المتاح للإرجاع</th>
                        <th className="p-3 whitespace-nowrap">التكلفة</th>
                        <th className="p-3 whitespace-nowrap">كمية المرتجع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((it, i) => (
                        <tr key={it.id} className="border-t border-border-soft">
                          <td className="p-3 whitespace-nowrap">{productNames[it.product_id] ?? it.product_id}</td>
                          <td className="p-3 whitespace-nowrap">{it.unit_name}</td>
                          <td className="p-3 font-mono-data whitespace-nowrap text-slate-500">{it.quantity}</td>
                          <td className="p-3 font-mono-data whitespace-nowrap">{it.unit_cost}</td>
                          <td className="p-3 whitespace-nowrap">
                            <input
                              type="number"
                              min="0"
                              max={it.quantity}
                              value={it.returnQty}
                              onChange={(e) => {
                                const updated = [...orderItems]
                                updated[i] = { ...it, returnQty: e.target.value }
                                setOrderItems(updated)
                              }}
                              className="w-24 border border-border-soft rounded-lg px-2 py-1.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card p-5 md:p-6">
                <input
                  type="text"
                  placeholder="سبب المرتجع (اختياري)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full border border-border-soft rounded-xl px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
                />
                {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
                {success && <p className="text-emerald-600 text-sm mb-3">{success}</p>}
                <button
                  onClick={handleOrderReturn}
                  disabled={saving}
                  className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />}
                  تسجيل المرتجع
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
