// تبويب النسخ الاحتياطي والاستعادة في الإعدادات.
// المنطق كله في lib/backup.ts، والملف ده واجهة بس.
import { useState } from 'react'
import { Loader2, Download, Database } from 'lucide-react'
import {
  buildBackup, parseBackup, restoreBackup, downloadJson, MAX_BACKUP_FILE_BYTES,
} from '../../lib/backup'

export default function BackupPanel() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [backupLog, setBackupLog] = useState<string[]>([])
  const [restoreLog, setRestoreLog] = useState<string[]>([])
  const [restoreResult, setRestoreResult] = useState<'ok' | 'failed' | null>(null)

  const handleBackup = async () => {
    setBusy(true)
    setError('')
    setBackupLog([])
    try {
      const { file, counts, totalRows } = await buildBackup()
      downloadJson('نسخة-احتياطية', file)
      setBackupLog([
        ...Object.entries(counts).map(([table, n]) => `${table}: ${n} صف`),
        `الإجمالي: ${totalRows} صف — اتأكد من الأرقام دي بعد التنزيل`,
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'فشل إنشاء النسخة الاحتياطية')
    }
    setBusy(false)
  }

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    setError('')
    setRestoreLog([])
    setRestoreResult(null)

    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        setError('الملف أكبر من الحد المسموح (100 ميجا)')
        return
      }
      const parsed = parseBackup(await file.text())
      if (!parsed.ok) {
        setError(parsed.error)
        return
      }

      const when = parsed.createdAt ? new Date(parsed.createdAt).toLocaleString('ar-EG') : 'تاريخ غير معروف'
      const tableCount = Object.keys(parsed.counts).length
      const ok = confirm(
        `نسخة بتاريخ ${when}: ${parsed.totalRows} صف في ${tableCount} جدول.\n\n` +
        'الاستعادة بتضيف/تحدّث البيانات فوق الموجود حاليًا ومفيش تراجع بعدها.\n' +
        'هنزّل الأول نسخة أمان من الوضع الحالي على جهازك (اتأكد إن المتصفح نزّلها قبل ما تكمّل).\n' +
        'لو بتستعيد على قاعدة فاضية هتظهر إشعارات كتير في سجل العمليات، وده طبيعي.\n\nمتأكد؟'
      )
      if (!ok) return

      setBusy(true)
      // نسخة أمان قبل أي كتابة — لو فشلت، منكمّلش
      try {
        const safety = await buildBackup()
        downloadJson('نسخة-أمان-قبل-الاستعادة', safety.file)
      } catch (err) {
        setError(`اتلغت الاستعادة: تعذر عمل نسخة الأمان (${err instanceof Error ? err.message : 'خطأ'})`)
        return
      }

      const result = await restoreBackup(parsed.tables, (line) => setRestoreLog((prev) => [...prev, line]))
      setRestoreResult(result.failed ? 'failed' : 'ok')
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  return (
    <div className="space-y-6">
      <div className="card p-5 md:p-6">
        <div className="flex items-center gap-2 mb-3">
          <Database size={16} className="text-accent-dark" />
          <p className="font-display font-bold text-navy-900">إنشاء نسخة احتياطية</p>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          بيجمّع كل بيانات النظام (المخازن، الأصناف، العملاء، الفواتير، الطلبيات،
          المرتجعات، الجرد...) في ملف JSON واحد وينزّله على جهازك. لو أي جدول
          فشل جلبه، النسخة بتتلغي ومبتنزلش ناقصة.
        </p>
        <button onClick={handleBackup} disabled={busy} className="btn-primary flex items-center justify-center gap-2 text-white rounded-xl px-5 py-2.5 font-medium transition-all disabled:opacity-70">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} إنشاء نسخة احتياطية
        </button>
        {backupLog.length > 0 && (
          <div className="mt-4 text-xs space-y-1 font-mono-data bg-surface rounded-lg p-3 max-h-60 overflow-y-auto">
            {backupLog.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        )}
      </div>

      <div className="card p-5 md:p-6">
        <p className="font-display font-bold text-navy-900 mb-3">استعادة نسخة احتياطية</p>
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">
          تحذير: الاستعادة بتضيف/تحدّث البيانات فوق الموجود حاليًا ومفيش تراجع بعدها.
          الملف بيتفحص الأول، وبينزل لك نسخة أمان من الوضع الحالي قبل ما أي حاجة تتغيّر.
          جرّبها على مشروع تجريبي الأول لو مش متأكد.
        </p>
        <label className="inline-flex items-center gap-2 bg-navy-900 text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-navy-800 transition-colors cursor-pointer">
          {busy && <Loader2 size={16} className="animate-spin" />}
          اختيار ملف واستعادة
          <input type="file" accept="application/json" onChange={handleRestore} disabled={busy} className="hidden" />
        </label>
        {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
        {restoreResult === 'ok' && (
          <p className="text-emerald-600 text-sm mt-3">تمت الاستعادة بنجاح. اعمل تحديث للصفحة عشان تشوف البيانات الجديدة.</p>
        )}
        {restoreResult === 'failed' && (
          <p className="text-red-600 text-sm mt-3">الاستعادة فشلت ووقفت في النص. راجع السجل تحت، ونسخة الأمان اللي نزلت قبلها فيها الوضع الأصلي.</p>
        )}
        {restoreLog.length > 0 && (
          <div className="mt-4 text-xs space-y-1 font-mono-data bg-surface rounded-lg p-3 max-h-60 overflow-y-auto">
            {restoreLog.map((l, i) => <p key={i}>{l}</p>)}
          </div>
        )}
      </div>
    </div>
  )
}
