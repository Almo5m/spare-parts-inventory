import { useState, useRef, useEffect } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { escapeLike } from '../lib/escapeLike'

interface SearchResult {
  type: 'صنف' | 'عميل' | 'فاتورة بيع' | 'طلبية'
  label: string
  sublabel?: string
  path: string
}

export default function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }

    const timeout = setTimeout(async () => {
      setLoading(true)
      const term = `%${escapeLike(query.trim())}%`

      const [productsByName, productsByPart, productsByBarcode, customers, sales, orders] = await Promise.all([
        supabase.from('products').select('id, name, part_number').ilike('name', term).limit(5),
        supabase.from('products').select('id, name, part_number').ilike('part_number', term).limit(5),
        supabase.from('products').select('id, name, part_number').ilike('barcode', term).limit(5),
        supabase.from('customers').select('id, name, phone').ilike('name', term).limit(5),
        supabase.from('sales_invoices').select('id, invoice_number').ilike('invoice_number', term).limit(5),
        supabase.from('orders').select('id, order_number').ilike('order_number', term).limit(5),
      ])

      // دمج نتائج الأصناف الثلاثة وإزالة أي تكرار (نفس الصنف ممكن يطابق أكتر من عمود)
      const productMap = new Map<string, { id: string; name: string; part_number: string }>()
      for (const p of [...(productsByName.data ?? []), ...(productsByPart.data ?? []), ...(productsByBarcode.data ?? [])]) {
        productMap.set(p.id, p)
      }

      const combined: SearchResult[] = [
        ...Array.from(productMap.values()).slice(0, 5).map((p) => ({
          type: 'صنف' as const, label: p.name, sublabel: p.part_number, path: '/products',
        })),
        ...(customers.data ?? []).map((c) => ({
          type: 'عميل' as const, label: c.name, sublabel: c.phone ?? undefined, path: '/customers',
        })),
        ...(sales.data ?? []).map((s) => ({
          type: 'فاتورة بيع' as const, label: s.invoice_number, path: '/invoices',
        })),
        ...(orders.data ?? []).map((o) => ({
          type: 'طلبية' as const, label: o.order_number, path: '/invoices',
        })),
      ]

      setResults(combined)
      setLoading(false)
    }, 300)

    return () => clearTimeout(timeout)
  }, [query])

  return (
    <div className="relative w-full max-w-md" ref={boxRef}>
      <div className="relative">
        <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="ابحث برقم فاتورة، طلبية، عميل، صنف..."
          className="w-full border border-border-soft rounded-xl pr-9 pl-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
        />
        {loading && (
          <Loader2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="pop-enter absolute top-full mt-1 w-full max-w-[90vw] bg-white rounded-xl shadow-lg border border-border-soft overflow-hidden z-50">
          {results.length === 0 && !loading ? (
            <p className="p-4 text-center text-sm text-slate-500">لا توجد نتائج</p>
          ) : (
            results.map((r, i) => (
              <button
                key={i}
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
