import { Fragment, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, BarChart3, Pencil, Trash2, Check, X, Power } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { fetchAll } from '../lib/fetchAll'
import { loadDraft, saveDraft, clearDraft } from '../lib/draft'
import Select from '../components/Select'
import type { Database } from '../lib/database.types'
import ProductUnitsPanel from '../components/ProductUnitsPanel'

type Product = Database['public']['Tables']['products']['Row']
type Category = Database['public']['Tables']['categories']['Row']

interface ProductForm {
  part_number: string
  barcode: string
  name: string
  category_id: string
  base_unit: string
  cost_price: string
  sale_price: string
  min_stock_alert: string
}

const DRAFT_KEY = 'new-product'
const emptyForm: ProductForm = {
  part_number: '', barcode: '', name: '', category_id: '',
  base_unit: 'قطعة', cost_price: '', sale_price: '', min_stock_alert: '',
}

export default function Products() {
  const navigate = useNavigate()
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState<ProductForm>(() => loadDraft(DRAFT_KEY, emptyForm))

  // حالة التعديل
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<ProductForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')

  useEffect(() => {
    saveDraft(DRAFT_KEY, form)
  }, [form])

  const loadProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) setError(error.message)
    else setProducts(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    let cancelled = false

    Promise.all([
      fetchAll((from, to) => supabase.from('products').select('*').order('created_at', { ascending: false }).order('id').range(from, to)),
      supabase.from('categories').select('*').order('name', { ascending: true }),
    ]).then(([productsRes, categoriesRes]) => {
      if (cancelled) return
      if (productsRes.error) setError(productsRes.error)
      else setProducts(productsRes.data ?? [])
      if (categoriesRes.data) setCategories(categoriesRes.data)
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [])

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSaving(true)

    const { error } = await supabase.from('products').insert({
      part_number: form.part_number,
      barcode: form.barcode || null,
      name: form.name,
      category_id: form.category_id || null,
      base_unit: form.base_unit,
      cost_price: Number(form.cost_price) || 0,
      sale_price: Number(form.sale_price) || 0,
      min_stock_alert: Number(form.min_stock_alert) || 0,
    })

    if (error) {
      setError(
        error.code === '23505'
          ? 'رقم القطعة أو الباركود ده مسجل بالفعل'
          : error.message
      )
    } else {
      setForm(emptyForm)
      clearDraft(DRAFT_KEY)
      setLoading(true)
      await loadProducts()
    }
    setSaving(false)
  }

  const startEdit = (p: Product) => {
    setEditingId(p.id)
    setEditError('')
    setEditForm({
      part_number: p.part_number,
      barcode: p.barcode ?? '',
      name: p.name,
      category_id: p.category_id ?? '',
      base_unit: p.base_unit,
      cost_price: String(p.cost_price),
      sale_price: String(p.sale_price),
      min_stock_alert: String(p.min_stock_alert ?? 0),
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditForm(null)
    setEditError('')
  }

  const saveEdit = async () => {
    if (!editingId || !editForm) return
    setEditSaving(true)
    setEditError('')

    const { error } = await supabase
      .from('products')
      .update({
        part_number: editForm.part_number,
        barcode: editForm.barcode || null,
        name: editForm.name,
        category_id: editForm.category_id || null,
        cost_price: Number(editForm.cost_price) || 0,
        sale_price: Number(editForm.sale_price) || 0,
        min_stock_alert: Number(editForm.min_stock_alert) || 0,
      })
      .eq('id', editingId)

    if (error) {
      setEditError(
        error.code === '23505'
          ? 'رقم القطعة أو الباركود ده مستخدم في صنف تاني بالفعل'
          : error.message
      )
      setEditSaving(false)
      return
    }

    setEditingId(null)
    setEditForm(null)
    setEditSaving(false)
    await loadProducts()
  }

  const handleDelete = async (product: Product) => {
    if (!confirm(`حذف الصنف "${product.name}" نهائيًا؟`)) return

    const { error } = await supabase.from('products').delete().eq('id', product.id)

    if (error) {
      // فشل الحذف غالبًا لأن الصنف له تاريخ عمليات (فواتير/طلبيات/مخزون)
      // مربوط بيه، فبنعرض تعطيله بدل حذفه نهائيًا
      if (confirm('مينفعش يتحذف الصنف ده لأن ليه فواتير أو طلبيات أو مخزون مسجّل عليه. عايز "توقفه" بدل الحذف؟ (هيختفي من شاشات البيع والشراء الجديدة، بس تاريخه القديم يفضل زي ما هو)')) {
        await supabase.from('products').update({ is_active: false }).eq('id', product.id)
        await loadProducts()
      }
      return
    }

    await loadProducts()
  }

  const toggleActive = async (product: Product) => {
    const { error } = await supabase.from('products').update({ is_active: !product.is_active }).eq('id', product.id)
    if (error) {
      setError(`تعذر تغيير حالة الصنف: ${error.message}`)
      return
    }
    await loadProducts()
  }

  const categoryName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? '-'

  return (
    <div className="page-enter p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-5 md:mb-6">إدارة الأصناف</h1>

      <form
        onSubmit={handleSubmit}
        className="card p-5 md:p-6 mb-6 md:mb-8 grid grid-cols-1 sm:grid-cols-2 gap-4"
      >
        <input
          name="part_number"
          value={form.part_number}
          onChange={handleChange}
          placeholder="رقم القطعة"
          required
          className="border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
        <input
          name="barcode"
          value={form.barcode}
          onChange={handleChange}
          placeholder="الباركود (اختياري)"
          className="border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
        <input
          name="name"
          value={form.name}
          onChange={handleChange}
          placeholder="اسم الصنف"
          required
          className="border border-border-soft rounded-xl px-3 py-2.5 sm:col-span-2 focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
        <div className="sm:col-span-2">
          <Select name="category_id" value={form.category_id} onChange={handleChange}>
            <option value="">بدون تصنيف</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-slate-500 sm:col-span-2 bg-surface rounded-lg px-3 py-2">
          سعر التكلفة وسعر البيع بيتحددوا وقت كل طلبية وفاتورة على حدة، مش هنا.
        </p>
        <input
          name="min_stock_alert"
          value={form.min_stock_alert}
          onChange={handleChange}
          placeholder="حد التنبيه الأدنى"
          type="number"
          className="border border-border-soft rounded-xl px-3 py-2.5 sm:col-span-2 focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />

        {error && <p className="text-red-600 text-sm sm:col-span-2">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="btn-primary sm:col-span-2 flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {saving ? 'جاري الحفظ...' : 'إضافة الصنف'}
        </button>
      </form>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-right">
            <thead className="bg-navy-900 text-white text-sm">
              <tr>
                <th className="p-3 font-display font-medium whitespace-nowrap">رقم القطعة</th>
                <th className="p-3 font-display font-medium whitespace-nowrap">الاسم</th>
                <th className="p-3 font-display font-medium whitespace-nowrap">التصنيف</th>
                <th className="p-3 font-display font-medium whitespace-nowrap">سعر البيع</th>
                <th className="p-3 font-display font-medium whitespace-nowrap">التكلفة</th>
                <th className="p-3"></th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      جاري التحميل...
                    </div>
                  </td>
                </tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={7} className="p-6 text-center text-slate-500">لا توجد أصناف بعد</td></tr>
              ) : (
                products.map((p) => (
                  <Fragment key={p.id}>
                    {editingId === p.id && editForm ? (
                      <tr key={p.id} className="border-t border-border-soft bg-accent/5">
                        <td className="p-2" colSpan={7}>
                          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
                            <input
                              value={editForm.part_number}
                              onChange={(e) => setEditForm({ ...editForm, part_number: e.target.value })}
                              placeholder="رقم القطعة"
                              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <input
                              value={editForm.name}
                              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                              placeholder="الاسم"
                              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm col-span-2 focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <select
                              value={editForm.category_id}
                              onChange={(e) => setEditForm({ ...editForm, category_id: e.target.value })}
                              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                            >
                              <option value="">بدون تصنيف</option>
                              {categories.map((c) => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </select>
                            <input
                              value={editForm.sale_price}
                              onChange={(e) => setEditForm({ ...editForm, sale_price: e.target.value })}
                              type="number" step="0.01" placeholder="سعر البيع"
                              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <input
                              value={editForm.cost_price}
                              onChange={(e) => setEditForm({ ...editForm, cost_price: e.target.value })}
                              type="number" step="0.01" placeholder="التكلفة"
                              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                            <div className="flex gap-2 justify-end col-span-2 sm:col-span-6">
                              {editError && <p className="text-red-600 text-xs flex-1 self-center">{editError}</p>}
                              <button onClick={saveEdit} disabled={editSaving} className="flex items-center gap-1 text-emerald-600 text-sm">
                                {editSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={16} />} حفظ
                              </button>
                              <button onClick={cancelEdit} className="flex items-center gap-1 text-slate-400 text-sm">
                                <X size={16} /> إلغاء
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={p.id}
                        className={`border-t border-border-soft hover:bg-surface transition-colors ${!p.is_active ? 'opacity-50' : ''}`}
                      >
                        <td className="p-3 font-mono-data whitespace-nowrap">{p.part_number}</td>
                        <td className="p-3 whitespace-nowrap">
                          {p.name}
                          {!p.is_active && <span className="mr-2 text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">متوقف</span>}
                        </td>
                        <td className="p-3 whitespace-nowrap">{categoryName(p.category_id)}</td>
                        <td className="p-3 font-mono-data whitespace-nowrap">{p.sale_price}</td>
                        <td className="p-3 font-mono-data whitespace-nowrap">{p.cost_price}</td>
                        <td className="p-3 text-left whitespace-nowrap">
                          <div className="flex items-center justify-end gap-3">
                            <button onClick={() => navigate(`/reports/product/${p.id}`)} className="text-navy-700 hover:text-navy-900" title="تقرير">
                              <BarChart3 size={14} />
                            </button>
                            <button onClick={() => startEdit(p)} className="text-slate-500 hover:text-navy-900" title="تعديل">
                              <Pencil size={14} />
                            </button>
                            <button onClick={() => toggleActive(p)} className={p.is_active ? 'text-slate-400 hover:text-slate-600' : 'text-emerald-600 hover:text-emerald-700'} title={p.is_active ? 'إيقاف' : 'تفعيل'}>
                              <Power size={14} />
                            </button>
                            <button onClick={() => handleDelete(p)} className="text-red-600 hover:text-red-700" title="حذف">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                        <td className="p-3 text-left">
                          <button
                            onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                            className="flex items-center gap-1 text-sm text-accent-dark hover:text-accent transition-colors"
                          >
                            الوحدات
                            {expandedId === p.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        </td>
                      </tr>
                    )}
                    {expandedId === p.id && editingId !== p.id && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <div className="panel-enter">
                            <ProductUnitsPanel productId={p.id} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
