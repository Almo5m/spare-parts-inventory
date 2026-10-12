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
type Customer = Database['public']['Tables']['customers']['Row']
type Warehouse = Database['public']['Tables']['warehouses']['Row']

interface CartItem {
  product_id: string
  product_name: string
  unit_name: string
  conversion_factor: number
  quantity: number
  unit_price: number
}

interface SalesDraft {
  warehouseId: string
  customerId: string
  paidAmount: string
  discount: string
  cart: CartItem[]
}

const DRAFT_KEY = 'sales-invoice'
const emptySalesDraft: SalesDraft = {
  warehouseId: '', customerId: '', paidAmount: '', discount: '', cart: [],
}

export default function Sales() {
  const { profile } = useAuth()
  // بنقرأ المسودة جوه الكومبوننت نفسه عشان تتحمّل من جديد في كل مرة
  // تدخل الصفحة، مش أول مرة يتحمّل فيها الملف بس في الـ SPA
  const [draft] = useState<SalesDraft>(() => loadDraft<SalesDraft>(DRAFT_KEY, emptySalesDraft))

  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [inWarehouseProductIds, setInWarehouseProductIds] = useState<Set<string>>(new Set())
  const [units, setUnits] = useState<ProductUnit[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [invoice, setInvoice] = useState<InvoicePrintData | null>(null)

  const [warehouseId, setWarehouseId] = useState(draft.warehouseId)
  const [customerId, setCustomerId] = useState(draft.customerId)
  const [paidAmount, setPaidAmount] = useState(draft.paidAmount)
  const [discount, setDiscount] = useState(draft.discount)
  const [cart, setCart] = useState<CartItem[]>(draft.cart)

  const [picker, setPicker] = useState({
    product_id: '',
    unit_name: 'قطعة',
    quantity: '1',
    unit_price: '',
  })

  useEffect(() => {
    saveDraft<SalesDraft>(DRAFT_KEY, { warehouseId, customerId, paidAmount, discount, cart })
  }, [warehouseId, customerId, paidAmount, discount, cart])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      fetchAll((from, to) => supabase.from('products').select('*').order('name').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('product_units').select('*').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('customers').select('*').order('name').order('id').range(from, to)),
      supabase.from('warehouses').select('*').order('created_at'),
    ]).then(([p, u, c, w]) => {
      if (cancelled) return
      if (p.data) setAllProducts(p.data)
      if (u.data) setUnits(u.data)
      if (c.data) setCustomers(c.data)
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

  useEffect(() => {
    if (!warehouseId) return
    let cancelled = false
    fetchAll((from, to) => supabase
      .from('inventory')
      .select('product_id')
      .eq('warehouse_id', warehouseId)
      .order('product_id')
      .range(from, to))
      .then(({ data }) => {
        if (cancelled) return
        setInWarehouseProductIds(new Set((data ?? []).map((r) => r.product_id)))
      })
    return () => { cancelled = true }
  }, [warehouseId])

  const products = allProducts.filter((p) => inWarehouseProductIds.has(p.id))

  const selectedProduct = products.find((p) => p.id === picker.product_id)
  const availableUnits = [
    { unit_name: selectedProduct?.base_unit ?? 'قطعة', conversion_factor: 1 },
    ...units
      .filter((u) => u.product_id === picker.product_id)
      .map((u) => ({ unit_name: u.unit_name, conversion_factor: u.conversion_factor })),
  ]

  const handleProductChange = async (productId: string) => {
    const product = products.find((p) => p.id === productId)

    // نجيب أقدم دفعة متاحة لسه فيها كمية (اللي هتتباع منها فعليًا أول)
    // ونقترح سعر البيع المسجّل عليها هي بالذات
    let suggestedPrice = product ? String(product.sale_price) : ''
    if (product) {
      const { data: lot } = await supabase
        .from('inventory_lots')
        .select('default_sale_price')
        .eq('product_id', productId)
        .eq('warehouse_id', warehouseId)
        .gt('quantity_remaining', 0)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (lot?.default_sale_price) {
        suggestedPrice = String(lot.default_sale_price)
      }
    }

    setPicker({
      product_id: productId,
      unit_name: product?.base_unit ?? 'قطعة',
      quantity: '1',
      unit_price: suggestedPrice,
    })
  }

  const addToCart = () => {
    if (!selectedProduct || !picker.quantity || !picker.unit_price) return
    const unit = availableUnits.find((u) => u.unit_name === picker.unit_name)
    if (!unit) return

    const quantity = Number(picker.quantity)
    const unitPrice = Number(picker.unit_price)
    if (!(quantity > 0)) {
      setError('الكمية لازم تكون رقم أكبر من صفر')
      return
    }
    if (!(unitPrice >= 0)) {
      setError('سعر الوحدة مينفعش يكون رقم سالب')
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
        unit_price: unitPrice,
      },
    ])
    setPicker({ product_id: '', unit_name: 'قطعة', quantity: '1', unit_price: '' })
  }

  const removeFromCart = (index: number) => {
    setCart(cart.filter((_, i) => i !== index))
  }

  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
  const discountValue = Number(discount) || 0
  const total = Math.max(subtotal - discountValue, 0)

  const resetForm = () => {
    setInvoice(null)
    setCart([])
    setPaidAmount('')
    setDiscount('')
    setCustomerId('')
    setError('')
    clearDraft(DRAFT_KEY)
  }

  const handleSubmit = async () => {
    setError('')

    if (cart.length === 0) {
      setError('أضف صنف واحد على الأقل للفاتورة')
      return
    }
    if (!warehouseId) {
      setError('اختر المخزن')
      return
    }
    if (Number(paidAmount) < 0) {
      setError('المبلغ المدفوع مينفعش يكون رقم سالب')
      return
    }
    if (discountValue < 0) {
      setError('الخصم مينفعش يكون رقم سالب')
      return
    }
    if (discountValue > subtotal) {
      setError(`الخصم (${discountValue.toFixed(2)}) أكبر من إجمالي الفاتورة قبل الخصم (${subtotal.toFixed(2)})`)
      return
    }
    if (Number(paidAmount) > total) {
      setError(`المبلغ المدفوع (${Number(paidAmount).toFixed(2)}) أكبر من إجمالي الفاتورة (${total.toFixed(2)})`)
      return
    }

    setSaving(true)

    const paid = Number(paidAmount) || 0

    const { data: invoiceId, error } = await supabase.rpc('create_sale_invoice', {
      p_customer_id: nullableArg(customerId || null),
      p_warehouse_id: warehouseId,
      p_items: cart.map((item) => ({
        product_id: item.product_id,
        unit_name: item.unit_name,
        conversion_factor: item.conversion_factor,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
      p_paid_amount: paid,
      p_discount_amount: discountValue,
    })

    if (error) {
      setError(error.message)
      setSaving(false)
      return
    }

    const { data: invoiceRow } = await supabase
      .from('sales_invoices')
      .select('invoice_number, created_at')
      .eq('id', invoiceId)
      .single()

    const customerName = customers.find((c) => c.id === customerId)?.name ?? 'عميل نقدي'

    setInvoice({
      type: 'sale',
      invoiceNumber: invoiceRow?.invoice_number ?? '',
      date: invoiceRow?.created_at
        ? new Date(invoiceRow.created_at).toLocaleString('ar-EG')
        : new Date().toLocaleString('ar-EG'),
      partyName: customerName,
      employeeName: profile?.full_name,
      items: cart.map((item) => ({
        name: item.product_name,
        unit: item.unit_name,
        quantity: item.quantity,
        price: item.unit_price,
      })),
      subtotal,
      discount: discountValue,
      total,
      paid,
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

  if (invoice) {
    return (
      <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-6 no-print">
          تم تسجيل الفاتورة
        </h1>
        <InvoicePrint data={invoice} onNewInvoice={resetForm} />
      </div>
    )
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-5 md:mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">فاتورة بيع جديدة</h1>
        {cart.length > 0 && (
          <span className="text-xs bg-accent/10 text-accent-dark px-2.5 py-1 rounded-full font-medium">
            مسودة محفوظة تلقائيًا
          </span>
        )}
      </div>

      <div className="card p-5 md:p-6 mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          value={warehouseId}
          onChange={(e) => {
            setWarehouseId(e.target.value)
            setCart([])
          }}
        >
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}{w.is_default ? ' (افتراضي)' : ''}</option>
          ))}
        </Select>
        <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">عميل نقدي (بدون تسجيل)</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </div>

      <div className="card p-5 md:p-6 mb-6">
        <p className="font-display font-bold text-navy-900 mb-3">إضافة صنف</p>
        {products.length === 0 && (
          <p className="text-sm text-accent-dark bg-accent/10 rounded-lg px-3 py-2 mb-3">
            مفيش أي صنف مسجّل مخزونه في المخزن ده لسه — سجّل طلبية شراء عليه الأول.
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div className="col-span-2">
            <ProductSearchSelect
              products={products}
              value={picker.product_id}
              onChange={handleProductChange}
              disabled={products.length === 0}
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
            placeholder="سعر الوحدة"
            value={picker.unit_price}
            onChange={(e) => setPicker({ ...picker, unit_price: e.target.value })}
            className="border border-border-soft rounded-xl px-3 py-2.5 col-span-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={addToCart}
            disabled={!picker.product_id}
            className="col-span-2 flex items-center justify-center gap-2 bg-navy-900 text-white rounded-xl py-2.5 font-medium hover:bg-navy-800 transition-colors disabled:opacity-50"
          >
            <Plus size={16} />
            أضف للفاتورة
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
                <th className="p-3 whitespace-nowrap">السعر</th>
                <th className="p-3 whitespace-nowrap">الإجمالي</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 ? (
                <tr><td colSpan={6} className="p-6 text-center text-slate-500">لم تُضف أي أصناف بعد</td></tr>
              ) : (
                cart.map((item, i) => (
                  <tr key={i} className="border-t border-border-soft">
                    <td className="p-3 whitespace-nowrap">{item.product_name}</td>
                    <td className="p-3 whitespace-nowrap">{item.unit_name}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.quantity}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.unit_price}</td>
                    <td className="p-3 font-mono-data whitespace-nowrap">{item.quantity * item.unit_price}</td>
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
          <span className="font-display font-bold text-lg text-navy-900">الإجمالي بعد الخصم</span>
          <span className="font-mono-data font-bold text-lg text-navy-900">{total.toFixed(2)}</span>
        </div>
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="المبلغ المدفوع الآن (اتركه فارغًا لو آجل بالكامل)"
          value={paidAmount}
          onChange={(e) => setPaidAmount(e.target.value)}
          className="w-full border border-border-soft rounded-xl px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={saving}
          className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? 'جاري الحفظ...' : 'تسجيل الفاتورة'}
        </button>
      </div>
    </div>
  )
}
