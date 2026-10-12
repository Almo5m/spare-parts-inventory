import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { escapeLike } from '../lib/escapeLike'

interface JumpResult {
  type: 'طلبية' | 'فاتورة' | 'صنف' | 'عميل' | 'مخزن'
  label: string
  sublabel?: string
  path: string
}

// مربع بحث سريع فوق صفحة التقارير — يدوّر في نفس اللحظة على الطلبيات
// والأصناف والعملاء والمخازن، وبمجرد ما تختار نتيجة يوديك مباشرة
// لتقريرها التفصيلي (تقرير الطلبية / تقرير الصنف / كشف حساب العميل /
// تقرير المخزن) من غير ما تدوّر عليها في جداول التقارير.
export default function ReportQuickJump() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<JumpResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const term = query.trim()
    if (term.length < 2) {
      setResults([])
      return
    }

    let cancelled = false
    setLoading(true)
    const timeout = setTimeout(async () => {
      const like = `%${escapeLike(term)}%`
      const [orders, salesInvoices, productsByName, productsByPart, customers, warehouses] = await Promise.all([
        supabase.from('orders').select('id, order_number').ilike('order_number', like).limit(5),
        supabase.from('sales_invoices').select('id, invoice_number').ilike('invoice_number', like).limit(5),
        supabase.from('products').select('id, name, part_number').ilike('name', like).limit(5),
        supabase.from('products').select('id, name, part_number').ilike('part_number', like).limit(5),
        supabase.from('customers').select('id, name').ilike('name', like).limit(5),
        supabase.from('warehouses').select('id, name').ilike('name', like).limit(5),
      ])

      if (cancelled) return

      const productMap = new Map<string, { id: string; name: string; part_number: string }>()
      for (const p of [...(productsByName.data ?? []), ...(productsByPart.data ?? [])]) {
        productMap.set(p.id, p)
      }

      setResults([
        ...(orders.data ?? []).map((o) => ({
          type: 'طلبية' as const,
          label: o.order_number,
          path: `/reports/order/${o.id}`,
        })),
        ...(salesInvoices.data ?? []).map((s) => ({
          type: 'فاتورة' as const,
          label: s.invoice_number,
          path: `/reports/sale/${s.id}`,
        })),
        ...Array.from(productMap.values()).map((p) => ({
          type: 'صنف' as const,
          label: p.name,
          sublabel: p.part_number,
          path: `/reports/product/${p.id}`,
        })),
        ...(customers.data ?? []).map((c) => ({
          type: 'عميل' as const,
          label: c.name,
          path: `/statement/${c.id}`,
        })),
        ...(warehouses.data ?? []).map((w) => ({
          type: 'مخزن' as const,
          label: w.name,
          path: `/reports/warehouse/${w.id}`,
        })),
      ])
      setLoading(false)
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [query])

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="وصول سريع لتقرير: رقم طلبية، رقم فاتورة، صنف، عميل، أو مخزن..."
          className="w-full border border-border-soft rounded-xl pr-9 pl-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
        {loading && (
          <Loader2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />
        )}
      </div>
      {open && query.trim().length >= 2 && (
        <div className="pop-enter absolute top-full mt-1 w-full bg-white rounded-xl shadow-lg border border-border-soft overflow-hidden z-50 max-h-72 overflow-y-auto">
          {results.length === 0 && !loading ? (
            <p className="p-4 text-center text-sm text-slate-500">لا توجد نتائج</p>
          ) : (
            results.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  navigate(r.path)
                  setOpen(false)
                  setQuery('')
                }}
                className="w-full text-right p-3 hover:bg-surface transition-colors border-b border-border-soft last:border-b-0 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-navy-900 truncate">{r.label}</p>
                  {r.sublabel && <p className="text-xs text-slate-400 font-mono-data truncate">{r.sublabel}</p>}
                </div>
                <span className="shrink-0 text-xs bg-surface text-slate-500 px-2 py-1 rounded-lg">{r.type}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
