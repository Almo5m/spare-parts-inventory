import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader2, ArrowRight, Wallet, FileSpreadsheet } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { nullableArg } from '../lib/rpcArgs'
import { fetchAll } from '../lib/fetchAll'
import { exportToExcel } from '../lib/exportExcel'
import type { Database } from '../lib/database.types'

type Customer = Database['public']['Tables']['customers']['Row']

interface LedgerRow {
  date: string
  label: string
  debit: number
  credit: number
}

export default function Statement() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [party, setParty] = useState<Customer | null>(null)
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')

  const loadData = async () => {
    if (!id) return
    setLoading(true)

    const [partyRes, invoicesRes, paymentsRes, returnsRes] = await Promise.all([
      supabase.from('customers').select('*').eq('id', id).single(),
      fetchAll((from, to) => supabase.from('sales_invoices').select('*').eq('customer_id', id).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('payments').select('*').eq('party_type', 'customer').eq('party_id', id).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('sales_returns').select('*, sales_invoices(invoice_number)').eq('customer_id', id).order('id').range(from, to)),
    ])

    if (partyRes.data) setParty(partyRes.data)

    const invoiceRows: LedgerRow[] = (invoicesRes.data ?? []).map((inv) => ({
      date: inv.created_at,
      label: `فاتورة ${inv.invoice_number}`,
      debit: inv.total_amount,
      credit: inv.paid_amount,
    }))

    const paymentRows: LedgerRow[] = (paymentsRes.data ?? []).map((p) => ({
      date: p.created_at,
      label: p.notes || 'دفعة محصّلة',
      debit: 0,
      credit: p.amount,
    }))

    // مرتجع البيع بينقص من مديونية العميل، فبيظهر كحركة "دائن" لوحدها
    // في الكشف — عشان الرصيد المتراكم في الجدول يطابق رصيد العميل
    // الفعلي المعروض فوق
    const returnRows: LedgerRow[] = (returnsRes.data ?? []).map((r) => {
      const inv = r.sales_invoices as unknown as { invoice_number: string } | null
      return {
        date: r.created_at,
        label: `مرتجع ${inv ? `فاتورة ${inv.invoice_number}` : 'بيع'}${r.notes ? ` — ${r.notes}` : ''}`,
        debit: 0,
        credit: r.total_amount,
      }
    })

    const combined = [...invoiceRows, ...paymentRows, ...returnRows].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )

    setRows(combined)
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // السبب: loadData دالة بتتعرّف كل render وبنناديها هنا عند تغيير العميل (id) بس؛
    // لو دخلناها في الاعتماديات هتتكرر في حلقة لا نهائية.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!id) {
      setError('تعذر تحديد الحساب، حاول تفتح الصفحة تاني')
      return
    }

    const value = Number(amount)
    if (!value || value <= 0) {
      setError('اكتب مبلغ صحيح أكبر من صفر')
      return
    }

    setSaving(true)

    const { error } = await supabase.rpc('record_payment', {
      p_party_type: 'customer',
      p_party_id: id,
      p_direction: 'in',
      p_amount: value,
      p_notes: nullableArg(notes || null),
    })

    if (error) {
      setError(error.message)
    } else {
      setAmount('')
      setNotes('')
      await loadData()
    }
    setSaving(false)
  }

  let runningBalance = 0

  const handleExport = () => {
    if (!party) return
    let balance = 0
    const exportRows = rows.map((row) => {
      balance += row.debit - row.credit
      return {
        'التاريخ': new Date(row.date).toLocaleDateString('ar-EG'),
        'البيان': row.label,
        'مدين (عليه)': row.debit || '',
        'دائن (له)': row.credit || '',
        'الرصيد بعدها': balance,
      }
    })
    exportToExcel(`كشف-حساب-${party.name}`, 'كشف الحساب', exportRows)
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  if (!party) {
    return <div className="p-8 text-slate-500">لم يتم العثور على السجل</div>
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => navigate('/customers')}
          className="flex items-center gap-1 text-sm text-accent-dark hover:underline"
        >
          <ArrowRight size={14} />
          رجوع للعملاء
        </button>
        <button
          onClick={handleExport}
          className="flex items-center gap-2 bg-emerald-600 text-white rounded-xl px-3 py-2 text-sm font-medium hover:bg-emerald-700 transition-colors"
        >
          <FileSpreadsheet size={16} />
          <span className="hidden sm:inline">تصدير Excel</span>
        </button>
      </div>

      <div className="card p-5 md:p-6 mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">{party.name}</h1>
          <p className="text-sm text-slate-500">{party.phone ?? 'بدون رقم هاتف'}</p>
        </div>
        <div className="text-right sm:text-left">
          <p className="text-xs text-slate-500">رصيد مديون به للمحل</p>
          <p className={`font-mono-data font-bold text-2xl ${party.balance > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
            {party.balance.toFixed(2)}
          </p>
        </div>
      </div>

      <div className="card p-5 md:p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Wallet size={16} className="text-accent-dark" />
          <p className="font-display font-bold text-navy-900">تسجيل تحصيل من العميل</p>
        </div>
        <form onSubmit={handleRecordPayment} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="number"
            step="0.01"
            placeholder="المبلغ"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <input
            type="text"
            placeholder="ملاحظة (اختياري)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={saving}
            className="btn-primary flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            {saving ? 'جاري الحفظ...' : 'تسجيل الدفعة'}
          </button>
        </form>
        {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
      </div>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="w-full text-right">
            <thead className="bg-navy-900 text-white text-sm">
              <tr>
                <th className="p-3 whitespace-nowrap">التاريخ</th>
                <th className="p-3 whitespace-nowrap">البيان</th>
                <th className="p-3 whitespace-nowrap">مدين (عليه)</th>
                <th className="p-3 whitespace-nowrap">دائن (له)</th>
                <th className="p-3 whitespace-nowrap">الرصيد بعدها</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={5} className="p-6 text-center text-slate-500">لا توجد حركات بعد</td></tr>
              ) : (
                rows.map((row, i) => {
                  runningBalance += row.debit - row.credit
                  return (
                    <tr key={i} className="border-t border-border-soft hover:bg-surface transition-colors">
                      <td className="p-3 whitespace-nowrap text-slate-500">
                        {new Date(row.date).toLocaleDateString('ar-EG')}
                      </td>
                      <td className="p-3 whitespace-nowrap">{row.label}</td>
                      <td className="p-3 font-mono-data whitespace-nowrap text-red-600">
                        {row.debit > 0 ? row.debit.toFixed(2) : '-'}
                      </td>
                      <td className="p-3 font-mono-data whitespace-nowrap text-emerald-600">
                        {row.credit > 0 ? row.credit.toFixed(2) : '-'}
                      </td>
                      <td className="p-3 font-mono-data whitespace-nowrap font-bold">
                        {runningBalance.toFixed(2)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
