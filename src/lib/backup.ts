// منطق النسخ الاحتياطي والاستعادة (من غير أي واجهة).
//
// اتصلح هنا من تقرير الفحص:
//  - النسخة بتجيب كل الصفوف (على دفعات) مش أول 1000 بس، ولو أي جدول فشل
//    النسخة بتتلغي بدل ما تنزل ناقصة وانت فاكرها كاملة.
//  - الاستعادة بتتحقق من شكل الملف قبل ما تلمس أي جدول.
//  - جدول inventory ملوش عمود id (مفتاحه product_id + warehouse_id)، فالاستعادة
//    القديمة كانت بتفشل عليه دايمًا. كل جدول دلوقتي له مفتاحه الصح.
//  - الاستعادة بتقف عند أول خطأ بدل ما تكمل وتسيب بيانات نصف مستعادة.
//
// حدود معروفة: الاستعادة مش Transaction واحدة (محتاجة دالة SQL على السيرفر)،
// فعشان كده التطبيق بينزّل نسخة أمان من الوضع الحالي قبل أي استعادة.

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'
import { fetchAll } from './fetchAll'

export const BACKUP_VERSION = '1.1'
const SUPPORTED_VERSIONS = ['1.0', BACKUP_VERSION]
export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024
const RESTORE_CHUNK_SIZE = 500

// الترتيب مهم: الجدول الأب قبل الابن عشان الـ foreign keys تفضل سليمة وقت الاستعادة
export const BACKUP_TABLES = [
  'company_settings', 'warehouses', 'categories', 'products', 'product_units',
  'customers', 'inventory', 'inventory_movements', 'warehouse_transfers', 'warehouse_transfer_items',
  'orders', 'order_items', 'inventory_lots',
  'sales_invoices', 'sales_invoice_items', 'sale_item_lot_usage',
  'sales_returns', 'sales_return_items',
  'order_returns', 'order_return_items', 'stocktakes', 'stocktake_items',
  'payments', 'treasury_transactions',
] as const

export type BackupTable = (typeof BACKUP_TABLES)[number]
type Row = Record<string, unknown>

// أعمدة المفتاح لكل جدول: بتستخدم في الترتيب الثابت وقت الجلب، وفي onConflict وقت الاستعادة
function keyColumns(table: BackupTable): string[] {
  return table === 'inventory' ? ['product_id', 'warehouse_id'] : ['id']
}

// جداول الدخول والأنواع المولّدة مش بتغطي اسم جدول ييجي من متغير، فبنستخدم عميل
// من غير أنواع هنا بس
const db = supabase as unknown as SupabaseClient

export interface BuiltBackup {
  file: Record<string, unknown>
  counts: Record<string, number>
  totalRows: number
}

export async function buildBackup(): Promise<BuiltBackup> {
  const file: Record<string, unknown> = {}
  const counts: Record<string, number> = {}
  let totalRows = 0

  for (const table of BACKUP_TABLES) {
    const keys = keyColumns(table)
    const { data, error } = await fetchAll<Row>((from, to) => {
      let query = db.from(table).select('*')
      for (const col of keys) query = query.order(col)
      return query.range(from, to)
    })
    if (error) throw new Error(`فشل جلب جدول ${table}: ${error}`)
    file[table] = data
    counts[table] = data.length
    totalRows += data.length
  }

  // بيانات المستخدمين للمرجعية فقط (بدون أي بيانات دخول حساسة) ومش بتتستعاد
  const users = await fetchAll<Row>((from, to) =>
    db.from('users').select('id, full_name, username, role, is_active').order('id').range(from, to)
  )
  if (users.error) throw new Error(`فشل جلب جدول users: ${users.error}`)
  file['users_reference'] = users.data

  // لقطات الفواتير والطلبيات الملغية: للمرجعية بس ومش بتتستعاد (جدولها بيتكتب من دوال الإلغاء بس)
  const cancelled = await fetchAll<Row>((from, to) =>
    db.from('cancelled_documents').select('*').order('id').range(from, to)
  )
  if (cancelled.error) throw new Error(`فشل جلب جدول cancelled_documents: ${cancelled.error}`)
  file['cancelled_documents_reference'] = cancelled.data

  const meta = { created_at: new Date().toISOString(), version: BACKUP_VERSION, counts }
  return { file: { meta, ...file }, counts, totalRows }
}

export function downloadJson(filenamePrefix: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  a.href = url
  a.download = `${filenamePrefix}-${stamp}.json`
  a.click()
  // لو اتلغى الرابط فورًا بعض المتصفحات بتلغي التنزيل نفسه، فبنأخّره شوية
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export type ParsedBackup =
  | { ok: true; tables: Partial<Record<BackupTable, Row[]>>; counts: Record<string, number>; totalRows: number; version: string; createdAt: string }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// بيفحص الملف قبل أي كتابة: النسخة، شكل كل جدول، ووجود أعمدة المفتاح في كل صف
export function parseBackup(text: string): ParsedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'الملف مش JSON سليم أو تالف' }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'شكل الملف مش شكل نسخة احتياطية' }

  const meta = parsed['meta']
  if (!isPlainObject(meta) || typeof meta['version'] !== 'string') {
    return { ok: false, error: 'الملف مفيهوش بيانات النسخة (meta) — غالبًا مش نسخة من النظام ده' }
  }
  if (!SUPPORTED_VERSIONS.includes(meta['version'])) {
    return { ok: false, error: `إصدار النسخة (${meta['version']}) مش مدعوم` }
  }

  const tables: Partial<Record<BackupTable, Row[]>> = {}
  const counts: Record<string, number> = {}
  let totalRows = 0

  for (const table of BACKUP_TABLES) {
    const rows = parsed[table]
    if (rows === undefined) continue
    if (!Array.isArray(rows)) return { ok: false, error: `جدول ${table} في الملف مش قائمة صفوف` }
    const keys = keyColumns(table)
    for (let i = 0; i < rows.length; i++) {
      const row: unknown = rows[i]
      if (!isPlainObject(row)) return { ok: false, error: `جدول ${table}: الصف رقم ${i + 1} مش سليم` }
      for (const key of keys) {
        if (row[key] === undefined || row[key] === null) {
          return { ok: false, error: `جدول ${table}: الصف رقم ${i + 1} ناقصه العمود ${key}` }
        }
      }
    }
    if (rows.length > 0) {
      tables[table] = rows as Row[]
      counts[table] = rows.length
      totalRows += rows.length
    }
  }

  if (totalRows === 0) return { ok: false, error: 'الملف مفيهوش أي بيانات تتستعاد' }
  const createdAt = typeof meta['created_at'] === 'string' ? meta['created_at'] : ''
  return { ok: true, tables, counts, totalRows, version: meta['version'], createdAt }
}

export interface RestoreResult {
  log: string[]
  failed: boolean
}

// بيرفع الجداول بالترتيب على دفعات، وبيقف عند أول خطأ
export async function restoreBackup(
  tables: Partial<Record<BackupTable, Row[]>>,
  onProgress: (line: string) => void
): Promise<RestoreResult> {
  const log: string[] = []
  const push = (line: string) => { log.push(line); onProgress(line) }

  for (const table of BACKUP_TABLES) {
    const rows = tables[table]
    if (!rows) continue
    const onConflict = keyColumns(table).join(',')
    for (let i = 0; i < rows.length; i += RESTORE_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + RESTORE_CHUNK_SIZE)
      const { error } = await db.from(table).upsert(chunk, { onConflict })
      if (error) {
        push(`❌ ${table}: ${error.message}`)
        push('⛔ الاستعادة وقفت هنا. الجداول اللي فوق اتستعادت، والباقي لا.')
        return { log, failed: true }
      }
    }
    push(`✅ ${table}: ${rows.length} صف`)
  }
  return { log, failed: false }
}
