import { useEffect, useState } from 'react'
import { Printer, FilePlus, Share2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'

export interface InvoicePrintItem {
  name: string
  unit: string
  quantity: number
  price: number
}

export interface InvoicePrintData {
  type: 'sale' | 'purchase'
  invoiceNumber: string
  date: string
  partyName: string
  employeeName?: string
  items: InvoicePrintItem[]
  subtotal?: number
  discount?: number
  total: number
  paid: number
}

// أرقام بفواصل آلاف وخانتين عشريتين: 12,450.00
const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

interface CompanySettings {
  company_name: string
  phone: string | null
  logo_data_url: string | null
  invoice_footer_message: string | null
}

export default function InvoicePrint({
  data,
  onNewInvoice,
}: {
  data: InvoicePrintData
  onNewInvoice: () => void
}) {
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const remaining = data.total - data.paid
  const subtotal = data.subtotal ?? data.total
  const discount = data.discount ?? 0
  const companyName = settings?.company_name ?? 'نظام إدارة المخزن'
  const docTitle = data.type === 'sale' ? 'فاتورة بيع' : 'طلبية شراء'
  const statusLabel =
    remaining <= 0.004 ? 'مدفوعة بالكامل' : data.paid > 0 ? 'مدفوعة جزئيًا' : 'آجلة'

  // نص جاهز للإرسال على واتساب أو أي تطبيق مراسلة (الفاتورة الكاملة بتتحفظ PDF من زر الطباعة)
  const shareText = [
    `${docTitle} رقم ${data.invoiceNumber} — ${companyName}`,
    `التاريخ: ${data.date}`,
    `${data.type === 'sale' ? 'العميل' : 'المخزن'}: ${data.partyName}`,
    `الإجمالي: ${fmt(data.total)} ج.م`,
    ...(data.type === 'sale'
      ? [`المدفوع: ${fmt(data.paid)} ج.م`, `المتبقي: ${fmt(Math.max(remaining, 0))} ج.م`]
      : []),
    ...(settings?.phone ? [`للتواصل: ${settings.phone}`] : []),
  ].join('\n')

  const handleShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `${docTitle} ${data.invoiceNumber}`, text: shareText })
        return
      } catch {
        // لو المستخدم قفل نافذة المشاركة نكمل بواتساب
      }
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener')
  }

  useEffect(() => {
    let cancelled = false
    supabase
      .from('company_settings')
      .select('company_name, phone, logo_data_url, invoice_footer_message')
      .eq('id', true)
      .single()
      .then(({ data }) => {
        if (!cancelled && data) setSettings(data)
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="card p-5 md:p-8">
      <div className="no-print flex flex-col sm:flex-row justify-end gap-3 mb-5">
        <button
          onClick={() => window.print()}
          className="flex items-center justify-center gap-2 bg-navy-900 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-navy-800 transition-colors"
        >
          <Printer size={16} />
          طباعة / حفظ PDF
        </button>
        <button
          onClick={handleShare}
          className="flex items-center justify-center gap-2 border border-border-soft text-navy-900 rounded-xl px-4 py-2 text-sm font-medium hover:bg-surface transition-colors"
        >
          <Share2 size={16} />
          إرسال ملخص (واتساب)
        </button>
        <button
          onClick={onNewInvoice}
          className="btn-primary flex items-center justify-center gap-2 text-white rounded-xl px-4 py-2 text-sm font-medium transition-all"
        >
          <FilePlus size={16} />
          {data.type === 'sale' ? 'فاتورة جديدة' : 'طلبية جديدة'}
        </button>
      </div>

      <div className="print-area max-w-3xl mx-auto">
        <div className="flex items-start justify-between gap-4 border-b-4 border-navy-900 pb-4 mb-5">
          <div className="flex items-start gap-3">
            {settings?.logo_data_url && (
              <img src={settings.logo_data_url} alt="شعار الشركة" className="w-16 h-16 object-contain" />
            )}
            <div>
              <h2 className="font-display font-extrabold text-xl md:text-2xl text-navy-900">{companyName}</h2>
              {settings?.phone && (
                <p className="text-sm text-slate-500 mt-1">
                  هاتف: <span className="font-mono-data" dir="ltr">{settings.phone}</span>
                </p>
              )}
            </div>
          </div>
          <div className="text-left shrink-0">
            <p className="font-display font-extrabold text-lg text-navy-900">{docTitle}</p>
            <p className="font-mono-data font-bold text-sm mt-1">{data.invoiceNumber}</p>
            <p className="text-xs text-slate-500 mt-1">{data.date}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-surface rounded-xl px-4 py-3 text-sm">
            <p className="text-xs text-slate-500 mb-0.5">{data.type === 'sale' ? 'العميل' : 'المخزن'}</p>
            <p className="font-bold text-navy-900">{data.partyName}</p>
          </div>
          <div className="bg-surface rounded-xl px-4 py-3 text-sm">
            <p className="text-xs text-slate-500 mb-0.5">{data.employeeName ? 'الموظف' : 'الحالة'}</p>
            <p className="font-bold text-navy-900">
              {data.employeeName ?? (data.type === 'sale' ? statusLabel : 'مدفوعة بالكامل')}
            </p>
          </div>
        </div>

        <div className="table-scroll mb-5">
          <table className="w-full text-sm border border-border-soft rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-navy-900 text-white">
                <th className="p-2.5 text-center font-normal w-10">م</th>
                <th className="p-2.5 text-right font-normal">الصنف</th>
                <th className="p-2.5 text-right font-normal whitespace-nowrap">الوحدة</th>
                <th className="p-2.5 text-right font-normal whitespace-nowrap">الكمية</th>
                <th className="p-2.5 text-right font-normal whitespace-nowrap">السعر</th>
                <th className="p-2.5 text-right font-normal whitespace-nowrap">الإجمالي (ج.م)</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item, i) => (
                <tr key={i} className="border-t border-border-soft">
                  <td className="p-2.5 text-center text-slate-500 font-mono-data">{i + 1}</td>
                  <td className="p-2.5">{item.name}</td>
                  <td className="p-2.5 whitespace-nowrap text-slate-500">{item.unit}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{item.quantity}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap">{fmt(item.price)}</td>
                  <td className="p-2.5 font-mono-data whitespace-nowrap font-medium">
                    {fmt(item.quantity * item.price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-start mb-5">
          <div className="w-full sm:w-72 text-sm border border-border-soft rounded-xl overflow-hidden">
            {discount > 0 && (
              <>
                <div className="flex justify-between px-4 py-2.5 border-b border-border-soft">
                  <span className="text-slate-500">الإجمالي قبل الخصم</span>
                  <span className="font-mono-data">{fmt(subtotal)}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5 border-b border-border-soft text-red-600">
                  <span>الخصم</span>
                  <span className="font-mono-data">-{fmt(discount)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between px-4 py-2.5 border-b border-border-soft">
              <span className="font-bold text-navy-900">الإجمالي</span>
              <span className="font-mono-data font-medium">{fmt(data.total)}</span>
            </div>
            {data.type === 'sale' ? (
              <>
                <div className="flex justify-between px-4 py-2.5 border-b border-border-soft">
                  <span className="text-slate-500">المدفوع</span>
                  <span className="font-mono-data font-medium">{fmt(data.paid)}</span>
                </div>
                <div className="flex justify-between px-4 py-2.5 bg-surface">
                  <span className="font-bold text-navy-900">المتبقي</span>
                  <span className="font-mono-data font-bold text-navy-900">{fmt(Math.max(remaining, 0))}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between px-4 py-2.5 bg-surface">
                <span className="font-bold text-navy-900">الحالة</span>
                <span className="font-mono-data font-bold text-emerald-600">مدفوعة بالكامل</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 mt-10 mb-6 text-sm text-slate-500">
          <div className="border-t border-slate-300 pt-2 text-center">{data.type === 'sale' ? 'توقيع المستلم' : 'توقيع المسؤول'}</div>
          <div className="border-t border-slate-300 pt-2 text-center">{data.type === 'sale' ? 'توقيع البائع' : 'توقيع المورّد'}</div>
        </div>

        {settings?.invoice_footer_message && (
          <p className="text-center text-xs text-slate-500 border-t border-border-soft pt-4">
            {settings.invoice_footer_message}
          </p>
        )}
      </div>
    </div>
  )
}
