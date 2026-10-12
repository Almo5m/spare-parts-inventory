import { useEffect, useState } from 'react'
import { Loader2, Trash2, Plus } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { nullableArg } from '../lib/rpcArgs'
import { fetchAll } from '../lib/fetchAll'
import { loadDraft, saveDraft, clearDraft } from '../lib/draft'
import { useAuth } from '../context/useAuth'
import Select from '../components/Select'
import ProductSearchSelect from '../components/ProductSearchSelect'
import type { Database } from '../lib/database.types'
import InvoicePrint, { type InvoicePrintData } from '../components/InvoicePrint'

type Product = Database['public']['Tables']['products']['Row']
type ProductUnit = Database['public']['Tables']['product_units']['Row']
type Warehouse = Database['public']['Tables']['warehouses']['Row']

interface CartItem {
  product_id: string
  product_name: string
  unit_name: string
  conversion_factor: number
  quantity: number
  unit_cost: number
  sale_price: number | null
}

interface OrderDraft {
  warehouseId: string
  notes: string
  discount: string
  cart: CartItem[]
}

const DRAFT_KEY = 'new-order'
const emptyOrderDraft: OrderDraft = { warehouseId: '', notes: '', discount: '', cart: [] }

export default function Orders() {
  const { profile } = useAuth()
  // بنقرأ المسودة جوه الكومبوننت نفسه (مش على مستوى الملف) عشان تتحمّل
  // من جديد في كل مرة تدخل الصفحة، مش أول مرة يتحمّل فيها الملف بس
  const [draft] = useState<OrderDraft>(() => loadDraft<OrderDraft>(DRAFT_KEY, emptyOrderDraft))

  const [products, setProducts] = useState<Product[]>([])
  const [units, setUnits] = useState<ProductUnit[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [order, setOrder] = useState<InvoicePrintData | null>(null)

  const [warehouseId, setWarehouseId] = useState(draft.warehouseId)
  const [notes, setNotes] = useState(draft.notes)
  const [discount, setDiscount] = useState(draft.discount)
  const [cart, setCart] = useState<CartItem[]>(draft.cart)

  const [picker, setPicker] = useState({
    product_id: '',
    unit_name: 'قطعة',
    quantity: '1',
    unit_cost: '',
    sale_price: '',
  })

  useEffect(() => {
    saveDraft<OrderDraft>(DRAFT_KEY, { warehouseId, notes, discount, cart })
  }, [warehouseId, notes, discount, cart])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      fetchAll((from, to) => supabase.from('products').select('*').order('name').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('product_units').select('*').order('id').range(from, to)),
      supabase.from('warehouses').select('*').order('created_at'),
    ]).then(([p, u, w]) => {
      if (cancelled) return
      if (p.data) setProducts(p.data)
      if (u.data) setUnits(u.data)
      if (w.data) {
        setWarehouses(w.data)
        if (!warehouseId) {
          const def = w.data.find((x) => x.is_default) ?? w.data[0]
          if (def) setWarehouseId(def.id)
        }
      }
      setLoading(false)
    })

    return () => { cancelled = true }
    // السبب: التحميل الأولي بيحصل مرة واحدة بس، و warehouseId بيتقرا جواه لمرة واحدة
    // (يختار المخزن الافتراضي لو مفيش مسودة) — مينفعش يعيد التحميل كل ما المخزن يتغير.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedProduct = products.find((p) => p.id === picker.product_id)
  const availableUnits = [
    { unit_name: selectedProduct?.base_unit ?? 'قطعة', conversion_factor: 1 },
    ...units
      .filter((u) => u.product_id === picker.product_id)
      .map((u) => ({ unit_name: u.unit_name, conversion_factor: u.conversion_factor })),
  ]

  const handleProductChange = (productId: string) => {
    const product = products.find((p) => p.id === productId)
    setPicker({
      product_id: productId,
      unit_name: product?.base_unit ?? 'قطعة',
      quantity: '1',
      unit_cost: product ? String(product.cost_price) : '',
      sale_price: product && product.sale_price > 0 ? String(product.sale_price) : '',
    })
  }

  const addToCart = () => {
    if (!selectedProduct || !picker.quantity || !picker.unit_cost) return
    const unit = availableUnits.find((u) => u.unit_name === picker.unit_name)
    if (!unit) return

    const quantity = Number(picker.quantity)
    const unitCost = Number(picker.unit_cost)
    if (!(quantity > 0)) {
      setError('الكمية لازم تكون رقم أكبر من صفر')
      return
    }
    if (!(unitCost >= 0)) {
      setError('تكلفة الوحدة مينفعش تكون رقم سالب')
      return
    }
    setError('')

    setCart([
      ...cart,
      {
        product_id: selectedProduct.id,
        product_name: selectedProduct.name,
        unit_name: unit.unit_name,
        conversion_factor: unit.conversion_factor,
        quantity,
        unit_cost: unitCost,
        sale_price: picker.sale_price ? Number(picker.sale_price) : null,
      },
    ])
    setPicker({ product_id: '', unit_name: 'قطعة', quantity: '1', unit_cost: '', sale_price: '' })
  }

  const removeFromCart = (index: number) => {
    setCart(cart.filter((_, i) => i !== index))
  }

  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0)
  const discountValue = Number(discount) || 0
  const total = Math.max(subtotal - discountValue, 0)

  const resetForm = () => {
    setOrder(null)
    setCart([])
    setNotes('')
    setDiscount('')
    setError('')
    clearDraft(DRAFT_KEY)
  }

  const handleSubmit = async () => {
    setError('')

    if (cart.length === 0) {
      setError('أضف صنف واحد على الأقل للطلبية')
      return
    }
    if (!warehouseId) {
      setError('اختر المخزن')
      return
    }
    if (discountValue < 0) {
      setError('الخصم مينفعش يكون رقم سالب')
      return
    }
    if (discountValue > subtotal) {
      setError(`الخصم (${discountValue.toFixed(2)}) أكبر من إجمالي الطلبية قبل الخصم (${subtotal.toFixed(2)})`)
      return
    }

    setSaving(true)

    const { data: orderId, error } = await supabase.rpc('create_order', {
      p_warehouse_id: warehouseId,
      p_notes: nullableArg(notes || null),
      p_items: cart.map((item) => ({
        product_id: item.product_id,
        unit_name: item.unit_name,
        conversion_factor: item.conversion_factor,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        sale_price: item.sale_price,
      })),
      p_discount_amount: discountValue,
    })

    if (error) {
      setError(error.message)
      setSaving(false)
      return
    }

    const { data: orderRow } = await supabase
      .from('orders')
      .select('order_number, created_at')
      .eq('id', orderId)
      .single()

    setOrder({
      type: 'purchase',
      invoiceNumber: orderRow?.order_number ?? '',
      date: orderRow?.created_at
        ? new Date(orderRow.created_at).toLocaleString('ar-EG')
        : new Date().toLocaleString('ar-EG'),
      partyName: warehouses.find((w) => w.id === warehouseId)?.name ?? '-',
      employeeName: profile?.full_name,
      items: cart.map((item) => ({
        name: item.product_name,
        unit: item.unit_name,
        quantity: item.quantity,
        price: item.unit_cost,
      })),
      subtotal,
      discount: discountValue,
      total,
      paid: total,
    })

    clearDraft(DRAFT_KEY)
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

  if (order) {
    return (
      <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-6 no-print">
          تم تسجيل الطلبية
        </h1>
        <InvoicePrint data={order} onNewInvoice={resetForm} />
      </div>
    )
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5 md:mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">طلبية جديدة</h1>
        {cart.length > 0 && (
          <span className="text-xs bg-accent/10 text-accent-dark px-2.5 py-1 rounded-full font-medium">
            مسودة محفوظة تلقائيًا
          </span>
        )}
      </div>

      <div className="card p-5 md:p-6 mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}{w.is_default ? ' (افتراضي)' : ''}</option>
          ))}
        </Select>
        <input
          type="text"
          placeholder="ملاحظة على الطلبية (اختياري)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="card p-5 md:p-6 mb-6">
        <p className="font-display font-bold text-navy-900 mb-3">إضافة صنف</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div className="col-span-2">
            <ProductSearchSelect
              products={products}
              value={picker.product_id}
              onChange={handleProductChange}
            />
          </div>
          <Select
            value={picker.unit_name}
            onChange={(e) => setPicker({ ...picker, unit_name: e.target.value })}
            disabled={!picker.product_id}
          >
            {availableUnits.map((u) => (
              <option key={u.unit_name} value={u.unit_name}>{u.unit_name}</option>
            ))}
          </Select>
          <input
            type="number"
            min="0"
            placeholder="الكمية"
            value={picker.quantity}
            onChange={(e) => setPicker({ ...picker, quantity: e.target.value })}
            className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="تكلفة الوحدة"
            value={picker.unit_cost}
            onChange={(e) => setPicker({ ...picker, unit_cost: e.target.value })}
            className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="سعر البيع المقترح لهذه الدفعة"
            value={picker.sale_price}
            onChange={(e) => setPicker({ ...picker, sale_price: e.target.value })}
            className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={addToCart}
            disabled={!picker.product_id}
            className="col-span-2 flex items-center justify-center gap-2 bg-navy-900 text-white rounded-xl py-2.5 font-medium hover:bg-navy-800 transition-colors disabled:opacity-50"
          >
            <Plus size={16} />
            أضف للطلبية
          </button>
        </div>
      </div>

      <div className="card overflow-hidden mb-6">
        <div className="table-scroll">
          <table className="w-full text-right">
            <thead className="bg-navy-900 text-white text-sm">
              <tr>
                <th className="p-3 whitespace-nowrap">الصنف</th>
                <th className="p-3 whitespace-nowrap">الوحدة</th>
                <th className="p-3 whitespace-nowrap">الكمية</th>
                <th className="p-3 whitespace-nowrap">التكلفة</th>
                <th className="p-3 whitespace-nowrap">سعر البيع المقترح</th>
                <th className="p-3 whitespace-nowrap">الإجمالي</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-slate-500">لم تُضف أي أصناف بعد</td></tr>
              ) : (
                cart.map((item, i) => (
                  <tr key={i} className="border-t border-border-soft">
                    <td className="p-3 whitespace-nowrap">{item.product_name}</td>
                    <td className="p-3 whitespace-nowrap">{item.unit_name}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.quantity}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.unit_cost}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.sale_price ?? '-'}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.quantity * item.unit_cost}</td>
                    <td className="p-3 text-left">
                      <button onClick={() => removeFromCart(i)} className="text-red-600 hover:text-red-700">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5 md:p-6">
        <div className="flex justify-between items-center mb-2 text-sm text-slate-500">
          <span>الإجمالي قبل الخصم</span>
          <span className="font-mono-data">{subtotal.toFixed(2)}</span>
        </div>
        <div className="flex justify-between items-center mb-4">
          <label className="text-sm text-slate-500">الخصم</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="0"
            className="w-32 border border-border-soft rounded-xl px-3 py-1.5 font-mono-data text-left focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="flex justify-between items-center mb-4 border-t border-border-soft pt-3">
          <span className="font-display font-bold text-lg text-navy-900">إجمالي تكلفة الطلبية</span>
          <span className="font-mono-data font-bold text-lg text-navy-900">{total.toFixed(2)}</span>
        </div>

        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={saving}
          className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? 'جاري الحفظ...' : 'تسجيل الطلبية'}
        </button>
      </div>
    </div>
  )
}
