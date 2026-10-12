import { useEffect, useState } from 'react'
import { Loader2, Check, Trash2, CheckCheck } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import type { Database } from '../lib/database.types'

type ActivityLog = Database['public']['Tables']['activity_log']['Row']

export default function ActivityLogPage() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    supabase
      .from('activity_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (cancelled) return
        setLogs(data ?? [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // التحديث بيظهر فورًا على الشاشة، ولو فشل في قاعدة البيانات بنرجّع القائمة
  // زي ما كانت ونوضّح السبب (بدل ما الشاشة تفضل تعرض نجاح وهمي)
  const runOptimistic = async (
    next: (prev: ActivityLog[]) => ActivityLog[],
    action: () => PromiseLike<{ error: { message: string } | null }>
  ) => {
    setError('')
    const snapshot = logs
    setLogs(next)
    const { error } = await action()
    if (error) {
      setLogs(snapshot)
      setError(`تعذر تنفيذ العملية: ${error.message}`)
    }
  }

  const markRead = (id: string) =>
    runOptimistic(
      (prev) => prev.map((l) => (l.id === id ? { ...l, is_read: true } : l)),
      () => supabase.from('activity_log').update({ is_read: true }).eq('id', id)
    )

  const markAllRead = () =>
    runOptimistic(
      (prev) => prev.map((l) => ({ ...l, is_read: true })),
      () => supabase.from('activity_log').update({ is_read: true }).eq('is_read', false)
    )

  const handleDelete = (id: string) =>
    runOptimistic(
      (prev) => prev.filter((l) => l.id !== id),
      () => supabase.from('activity_log').delete().eq('id', id)
    )

  const unreadCount = logs.filter((l) => !l.is_read).length

  return (
    <div className="page-enter p-4 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-5 md:mb-6">
        <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900">سجل العمليات</h1>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="flex items-center gap-1.5 text-sm text-accent-dark hover:underline"
          >
            <CheckCheck size={15} />
            تعليم الكل كمقروء ({unreadCount})
          </button>
        )}
      </div>

      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-slate-500">
            <Loader2 size={16} className="animate-spin" />
            جاري التحميل...
          </div>
        ) : logs.length === 0 ? (
          <p className="p-6 text-center text-slate-500">لا توجد عمليات مسجّلة بعد</p>
        ) : (
          <ul>
            {logs.map((log) => (
              <li
                key={log.id}
                className={`flex items-start justify-between gap-3 px-4 py-3 border-t border-border-soft first:border-t-0 transition-colors ${
                  log.is_read ? '' : 'bg-accent/5'
                }`}
              >
                <div className="min-w-0">
                  <p className={`text-sm ${log.is_read ? 'text-slate-600' : 'text-navy-900 font-medium'}`}>{log.action}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {log.user_name ?? 'النظام'} — {new Date(log.created_at).toLocaleString('ar-EG')}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {!log.is_read && (
                    <button onClick={() => markRead(log.id)} className="text-accent-dark hover:text-accent" title="تعليم كمقروء">
                      <Check size={16} />
                    </button>
                  )}
                  <button onClick={() => handleDelete(log.id)} className="text-red-600 hover:text-red-700" title="حذف">
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
