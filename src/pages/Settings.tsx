import { useEffect, useState } from 'react'
import { Loader2, Upload, Save, Info, User, Bell, Users, Power, UserPlus, Pencil, KeyRound, X, Check } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/useAuth'
import BackupPanel from '../components/settings/BackupPanel'
import { MIN_PASSWORD_LENGTH, normalizeUsername } from '../lib/authRules'
import type { Database as DB } from '../lib/database.types'

type UserRow = DB['public']['Tables']['users']['Row']

interface CompanySettings {
  company_name: string
  phone: string | null
  logo_data_url: string | null
  invoice_footer_message: string | null
  next_sales_invoice_number: number
  next_order_number: number
  notify_low_stock: boolean
  notify_debts: boolean
}

const LOGO_MAX_BYTES = 200 * 1024
const LOGO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

type SettingsTab = 'company' | 'account' | 'users' | 'notifications' | 'backup' | 'system'

const tabLabels: Record<SettingsTab, string> = {
  company: 'بيانات الشركة', account: 'الحساب', users: 'المستخدمون', notifications: 'الإشعارات',
  backup: 'النسخ الاحتياطي', system: 'معلومات النظام',
}

export default function Settings() {
  const { profile } = useAuth()
  const [tab, setTab] = useState<SettingsTab>('company')

  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [nextSalesNumber, setNextSalesNumber] = useState('')
  const [nextOrderNumber, setNextOrderNumber] = useState('')

  // حساب
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [username, setUsername] = useState('')
  const [usernameBusy, setUsernameBusy] = useState(false)

  // نسخ احتياطي

  // إدارة المستخدمين
  const [users, setUsers] = useState<UserRow[]>([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [showAddUser, setShowAddUser] = useState(false)
  const [addUserForm, setAddUserForm] = useState({ username: '', password: '', full_name: '', phone: '' })
  const [addUserBusy, setAddUserBusy] = useState(false)
  const [addUserError, setAddUserError] = useState('')
  const [editingUsernameId, setEditingUsernameId] = useState<string | null>(null)
  const [editingUsernameValue, setEditingUsernameValue] = useState('')
  const [userActionBusy, setUserActionBusy] = useState<string | null>(null)
  const [userActionError, setUserActionError] = useState('')
  const [resetPasswordFor, setResetPasswordFor] = useState<string | null>(null)
  const [resetPasswordValue, setResetPasswordValue] = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      const { data: s, error: fetchError } = await supabase
        .from('company_settings')
        .select('*')
        .eq('id', true)
        .maybeSingle()

      if (cancelled) return

      if (fetchError) {
        setError(fetchError.message)
        setLoading(false)
        return
      }

      if (!s) {
        // الصف الافتراضي مش موجود لسبب ما — ننشئه دلوقتي تلقائيًا m
        const { data: created, error: createError } = await supabase
          .from('company_settings')
          .insert({ id: true })
          .select()
          .single()

        if (cancelled) return

        if (createError) {
          setError('تعذر تحميل أو إنشاء إعدادات الشركة: ' + createError.message)
          setLoading(false)
          return
        }

        setSettings(created)
        setNextSalesNumber(String(created.next_sales_invoice_number))
        setNextOrderNumber(String(created.next_order_number))
        setLoading(false)
        return
      }

      setSettings(s)
      setNextSalesNumber(String(s.next_sales_invoice_number))
      setNextOrderNumber(String(s.next_order_number))
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (profile) {
      setFullName(profile.full_name)
    }
  }, [profile])

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(async ({ data }) => {
      if (cancelled || !data.user) return
      const { data: row } = await supabase.from('users').select('phone, username').eq('id', data.user.id).single()
      if (!cancelled && row) {
        setPhone(row.phone ?? '')
        setUsername(row.username)
      }
    })
    return () => { cancelled = true }
  }, [])

  const loadUsers = async () => {
    setUsersLoading(true)
    const { data } = await supabase.from('users').select('*').order('full_name')
    setUsers(data ?? [])
    setUsersLoading(false)
  }

  useEffect(() => {
    if (tab !== 'users') return
    loadUsers()
  }, [tab])

  const toggleUserActive = async (u: UserRow) => {
    setUserActionError('')
    // منع إيقاف حسابك انت بالغلط — كده هتقفل على نفسك من الموقع
    if (u.is_active && u.username === username) {
      setUserActionError('مينفعش توقف حسابك انت — هتتقفل برّه النظام')
      return
    }
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: !x.is_active } : x)))
    const { error } = await supabase.from('users').update({ is_active: !u.is_active }).eq('id', u.id)
    if (error) {
      // رجّع الحالة القديمة بدل ما الشاشة تفضل تعرض نجاح وهمي
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, is_active: u.is_active } : x)))
      setUserActionError(`تعذر تغيير حالة الحساب: ${error.message}`)
    }
  }

  const updateUserRole = async (
    u: UserRow,
    role: UserRow['role']
  ) => {
    setUsers((prev) =>
      prev.map((x) =>
        x.id === u.id
          ? { ...x, role }
          : x
      )
    )

    setUserActionError('')
    const { error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', u.id)
    if (error) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role: u.role } : x)))
      setUserActionError(`تعذر تغيير الدور: ${error.message}`)
    }
  }

  const handleCreateUser = async () => {
    setAddUserError('')
    if (!addUserForm.username.trim() || !addUserForm.password || !addUserForm.full_name.trim()) {
      setAddUserError('اسم المستخدم وكلمة المرور والاسم بالكامل مطلوبين')
      return
    }
    if (addUserForm.password.length < MIN_PASSWORD_LENGTH) {
      setAddUserError(`كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل`)
      return
    }
    setAddUserBusy(true)
    const { data, error } = await supabase.functions.invoke('manage-users', {
      body: {
        action: 'create',
        username: normalizeUsername(addUserForm.username),
        password: addUserForm.password,
        full_name: addUserForm.full_name.trim(),
        phone: addUserForm.phone.trim() || null,
      },
    })

    // supabase.functions.invoke بيرجّع الخطأ في error لو الاستجابة
    // status code مش 2xx، لكن رسالة الخطأ التفصيلية بتكون في data.error
    const serverError = (data as { error?: string } | null)?.error
    if (error || serverError) {
      setAddUserError(serverError || error?.message || 'تعذر إنشاء الحساب')
      setAddUserBusy(false)
      return
    }

    setAddUserForm({ username: '', password: '', full_name: '', phone: '' })
    setShowAddUser(false)
    setAddUserBusy(false)
    await loadUsers()
  }

  const startEditUsername = (u: UserRow) => {
    setEditingUsernameId(u.id)
    setEditingUsernameValue(u.username)
    setUserActionError('')
  }

  const saveEditUsername = async (userId: string) => {
    if (!editingUsernameValue.trim()) return
    setUserActionBusy(userId)
    setUserActionError('')
    const { data, error } = await supabase.functions.invoke('manage-users', {
      body: { action: 'update_username', user_id: userId, new_username: normalizeUsername(editingUsernameValue) },
    })
    const serverError = (data as { error?: string } | null)?.error
    if (error || serverError) {
      setUserActionError(serverError || error?.message || 'تعذر تغيير اسم المستخدم')
      setUserActionBusy(null)
      return
    }
    setEditingUsernameId(null)
    setUserActionBusy(null)
    await loadUsers()
  }

  const startResetPassword = (u: UserRow) => {
    setResetPasswordFor(u.id)
    setResetPasswordValue('')
    setUserActionError('')
  }

  const saveResetPassword = async (u: UserRow) => {
    if (resetPasswordValue.length < MIN_PASSWORD_LENGTH) {
      setUserActionError(`كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل`)
      return
    }
    setUserActionBusy(u.id)
    setUserActionError('')
    const { data, error } = await supabase.functions.invoke('manage-users', {
      body: { action: 'reset_password', user_id: u.id, new_password: resetPasswordValue },
    })
    const serverError = (data as { error?: string } | null)?.error
    setUserActionBusy(null)
    if (error || serverError) {
      setUserActionError(serverError || error?.message || 'تعذر تغيير كلمة المرور')
      return
    }
    setResetPasswordFor(null)
    setResetPasswordValue('')
    alert(`اتغيّرت كلمة مرور "${u.full_name}" بنجاح`)
  }

  const handleChangeOwnUsername = async () => {
    setError(''); setSuccess('')
    if (!username.trim()) return
    setUsernameBusy(true)
    const { data: userData } = await supabase.auth.getUser()
    if (!userData.user) { setUsernameBusy(false); return }

    const { data, error: fnError } = await supabase.functions.invoke('manage-users', {
      body: { action: 'update_username', user_id: userData.user.id, new_username: normalizeUsername(username) },
    })
    const serverError = (data as { error?: string } | null)?.error
    if (fnError || serverError) {
      setError(serverError || fnError?.message || 'تعذر تغيير اسم المستخدم')
      setUsernameBusy(false)
      return
    }

    setSuccess('اتغيّر اسم المستخدم — لو خرجت من حسابك، لازم تدخل تاني بالاسم الجديد')
    setUsernameBusy(false)
  }

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !settings) return
    setError('')
    // الشعار بيتخزن جوه قاعدة البيانات نفسها كنص، فلازم يكون صغير ونوعه صور عادية بس (من غير SVG)
    if (!LOGO_ALLOWED_TYPES.includes(file.type)) {
      setError('الشعار لازم يكون صورة PNG أو JPG أو WebP')
      e.target.value = ''
      return
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError(`حجم الشعار أكبر من ${LOGO_MAX_BYTES / 1024} كيلوبايت — صغّره الأول`)
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = () => setSettings({ ...settings, logo_data_url: reader.result as string })
    reader.readAsDataURL(file)
  }

  const handleSaveCompany = async () => {
    if (!settings) return
    setError(''); setSuccess(''); setSaving(true)
    const { error } = await supabase.from('company_settings').update({
      company_name: settings.company_name,
      phone: settings.phone,
      logo_data_url: settings.logo_data_url,
      invoice_footer_message: settings.invoice_footer_message,
    }).eq('id', true)
    if (error) setError(error.message)
    else setSuccess('تم حفظ بيانات الشركة')
    setSaving(false)
  }

  const handleNumberingSave = async () => {
    setError(''); setSuccess('')
    const sales = Number(nextSalesNumber)
    const orders = Number(nextOrderNumber)
    // أرقام صحيحة موجبة بس. السيرفر كمان بيرفض أي رقم أقل من آخر فاتورة موجودة
    if (!Number.isInteger(sales) || sales < 1 || !Number.isInteger(orders) || orders < 1) {
      setError('رقم الفاتورة والطلبية لازم يكونوا أرقام صحيحة من 1 فأكتر')
      return
    }
    setSaving(true)
    const { error } = await supabase.rpc('set_invoice_numbering', {
      p_next_sales_number: sales,
      p_next_order_number: orders,
    })
    if (error) setError(error.message)
    else setSuccess('تم تحديث ترقيم الفواتير')
    setSaving(false)
  }

  const handleSaveAccount = async () => {
    setError(''); setSuccess('')
    if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`كلمة المرور الجديدة لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل`)
      return
    }
    setSaving(true)
    const { data: userData } = await supabase.auth.getUser()
    if (!userData.user) { setSaving(false); return }

    const { error: profileError } = await supabase
      .from('users')
      .update({ full_name: fullName, phone: phone || null })
      .eq('id', userData.user.id)

    if (profileError) {
      setError(profileError.message)
      setSaving(false)
      return
    }

    if (newPassword) {
      const { error: pwError } = await supabase.auth.updateUser({ password: newPassword })
      if (pwError) {
        setError(pwError.message)
        setSaving(false)
        return
      }
      setNewPassword('')
    }

    setSuccess('تم حفظ بيانات الحساب')
    setSaving(false)
  }

  const handleToggle = async (key: 'notify_low_stock' | 'notify_debts') => {
    if (!settings) return
    const newValue = !settings[key]
    setSettings({ ...settings, [key]: newValue })
    const { error } = key === 'notify_low_stock'
      ? await supabase.from('company_settings').update({ notify_low_stock: newValue }).eq('id', true)
      : await supabase.from('company_settings').update({ notify_debts: newValue }).eq('id', true)
    if (error) {
      setSettings({ ...settings, [key]: !newValue })
      setError(`تعذر حفظ إعداد الإشعارات: ${error.message}`)
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-slate-500">
        <Loader2 size={16} className="animate-spin" />
        جاري التحميل...
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-8 text-red-600 text-sm">
        تعذر تحميل إعدادات الشركة. {error || 'حاول تحدّث الصفحة، ولو المشكلة استمرت تأكد من وجود صف في جدول company_settings.'}
      </div>
    )
  }

  return (
    <div className="page-enter p-4 md:p-6 max-w-2xl mx-auto">
      <h1 className="font-display text-xl md:text-2xl font-bold text-navy-900 mb-5 md:mb-6">الإعدادات</h1>

      <div className="flex flex-wrap gap-2 mb-6">
        {(Object.keys(tabLabels) as SettingsTab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setError(''); setSuccess('') }}
            className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
              tab === t ? 'bg-navy-900 text-white' : 'bg-white border border-border-soft text-slate-600'
            }`}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {success && <p className="text-emerald-600 text-sm mb-4">{success}</p>}

      {tab === 'company' && (
        <>
          <div className="card p-5 md:p-6 mb-6">
            <p className="font-display font-bold text-navy-900 mb-4">بيانات الشركة (تظهر داخل الفاتورة)</p>
            <div className="flex items-center gap-4 mb-4">
              {settings.logo_data_url ? (
                <img src={settings.logo_data_url} alt="الشعار" className="w-16 h-16 object-contain rounded-lg border border-border-soft" />
              ) : (
                <div className="w-16 h-16 rounded-lg border border-dashed border-border-soft flex items-center justify-center text-slate-400 text-xs">بدون شعار</div>
              )}
              <label className="flex items-center gap-2 text-sm text-accent-dark cursor-pointer hover:underline">
                <Upload size={16} />رفع شعار جديد
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleLogoUpload} className="hidden" />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <input value={settings.company_name} onChange={(e) => setSettings({ ...settings, company_name: e.target.value })} placeholder="اسم الشركة" className="border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent" />
              <input value={settings.phone ?? ''} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} placeholder="رقم التواصل" className="border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <textarea value={settings.invoice_footer_message ?? ''} onChange={(e) => setSettings({ ...settings, invoice_footer_message: e.target.value })} placeholder="رسالة ثابتة أسفل الفاتورة (اختياري)" rows={2} className="w-full border border-border-soft rounded-xl px-3 py-2.5 mb-4 focus:outline-none focus:ring-2 focus:ring-accent" />
            <button onClick={handleSaveCompany} disabled={saving} className="btn-primary flex items-center justify-center gap-2 text-white rounded-xl px-5 py-2.5 font-medium transition-all disabled:opacity-70">
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} حفظ بيانات الشركة
            </button>
          </div>

          <div className="card p-5 md:p-6">
            <p className="font-display font-bold text-navy-900 mb-1">ترقيم الفواتير</p>
            <p className="text-xs text-slate-500 mb-4">الرقم بتاعك هيكون رقم أول فاتورة/طلبية جاية بس.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">رقم أول فاتورة بيع جاية</label>
                <input type="number" value={nextSalesNumber} onChange={(e) => setNextSalesNumber(e.target.value)} className="w-full border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">رقم أول طلبية جاية</label>
                <input type="number" value={nextOrderNumber} onChange={(e) => setNextOrderNumber(e.target.value)} className="w-full border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent" />
              </div>
            </div>
            <button onClick={handleNumberingSave} disabled={saving} className="flex items-center justify-center gap-2 bg-navy-900 text-white rounded-xl px-5 py-2.5 font-medium hover:bg-navy-800 transition-colors disabled:opacity-70">
              {saving && <Loader2 size={16} className="animate-spin" />} تحديث الترقيم
            </button>
          </div>
        </>
      )}

      {tab === 'account' && (
        <div className="card p-5 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <User size={16} className="text-accent-dark" />
            <p className="font-display font-bold text-navy-900">بيانات الحساب</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1">الاسم بالكامل</label>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="w-full border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">رقم الهاتف</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent" />
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-xs text-slate-500 mb-1">كلمة مرور جديدة (اتركها فاضية لو مش عايز تغيّرها)</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full border border-border-soft rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          <button onClick={handleSaveAccount} disabled={saving} className="btn-primary flex items-center justify-center gap-2 text-white rounded-xl px-5 py-2.5 font-medium transition-all disabled:opacity-70">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} حفظ
          </button>

          <div className="border-t border-border-soft mt-6 pt-5">
            <p className="text-xs text-slate-500 mb-1">اسم المستخدم (بتسجّل بيه الدخول)</p>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                dir="ltr"
                className="flex-1 border border-border-soft rounded-xl px-3 py-2.5 font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={handleChangeOwnUsername}
                disabled={usernameBusy}
                className="flex items-center justify-center gap-2 bg-navy-900 text-white rounded-xl px-5 py-2.5 text-sm font-medium hover:bg-navy-800 transition-colors disabled:opacity-70"
              >
                {usernameBusy ? <Loader2 size={16} className="animate-spin" /> : <Pencil size={15} />}
                تغيير اسم المستخدم
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-2">لو غيّرته، هتحتاج تسجّل دخول تاني بالاسم الجديد المرة الجاية.</p>
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="p-5 pb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users size={16} className="text-accent-dark" />
                <p className="font-display font-bold text-navy-900">المستخدمون</p>
              </div>
              <button
                onClick={() => { setShowAddUser((v) => !v); setAddUserError('') }}
                className="flex items-center gap-2 bg-navy-900 text-white rounded-xl px-3.5 py-2 text-sm font-medium hover:bg-navy-800 transition-colors"
              >
                <UserPlus size={15} />
                مستخدم جديد
              </button>
            </div>

            {showAddUser && (
              <div className="mx-5 mb-5 p-4 rounded-xl border border-border-soft bg-surface">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <input
                    value={addUserForm.full_name}
                    onChange={(e) => setAddUserForm({ ...addUserForm, full_name: e.target.value })}
                    placeholder="الاسم بالكامل"
                    className="border border-border-soft rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <input
                    value={addUserForm.phone}
                    onChange={(e) => setAddUserForm({ ...addUserForm, phone: e.target.value })}
                    placeholder="رقم الهاتف (اختياري)"
                    className="border border-border-soft rounded-xl px-3 py-2.5 text-sm font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <input
                    value={addUserForm.username}
                    onChange={(e) => setAddUserForm({ ...addUserForm, username: e.target.value })}
                    placeholder="اسم المستخدم (بالإنجليزي، بدون مسافات)"
                    dir="ltr"
                    className="border border-border-soft rounded-xl px-3 py-2.5 text-sm font-mono-data focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <input
                    type="password"
                    value={addUserForm.password}
                    onChange={(e) => setAddUserForm({ ...addUserForm, password: e.target.value })}
                    placeholder={`كلمة المرور (${MIN_PASSWORD_LENGTH} حروف على الأقل)`}
                    className="border border-border-soft rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>
                {addUserError && <p className="text-red-600 text-xs mb-3">{addUserError}</p>}
                <button
                  onClick={handleCreateUser}
                  disabled={addUserBusy}
                  className="flex items-center justify-center gap-2 bg-emerald-600 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-emerald-700 transition-colors disabled:opacity-70"
                >
                  {addUserBusy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                  إنشاء الحساب
                </button>
              </div>
            )}

            {userActionError && <p className="text-red-600 text-xs px-5 mb-2">{userActionError}</p>}

            {usersLoading ? (
              <div className="flex items-center justify-center gap-2 p-6 text-slate-500">
                <Loader2 size={16} className="animate-spin" /> جاري التحميل...
              </div>
            ) : (
              <ul>
                {users.map((u) => (
                  <li key={u.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3 border-t border-border-soft">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${u.is_active ? 'text-navy-900' : 'text-slate-400 line-through'}`}>{u.full_name}</p>
                      {editingUsernameId === u.id ? (
                        <div className="flex items-center gap-1.5 mt-1">
                          <input
                            value={editingUsernameValue}
                            onChange={(e) => setEditingUsernameValue(e.target.value)}
                            dir="ltr"
                            autoFocus
                            className="text-xs border border-border-soft rounded-lg px-2 py-1 font-mono-data w-36 focus:outline-none focus:ring-2 focus:ring-accent"
                          />
                          <button onClick={() => saveEditUsername(u.id)} disabled={userActionBusy === u.id} className="text-emerald-600 hover:text-emerald-700">
                            {userActionBusy === u.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                          </button>
                          <button onClick={() => setEditingUsernameId(null)} className="text-slate-400 hover:text-red-600">
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEditUsername(u)}
                          className="flex items-center gap-1 text-xs text-slate-500 font-mono-data hover:text-accent-dark mt-0.5"
                        >
                          {u.username}
                          <Pencil size={11} className="text-slate-400" />
                        </button>
                      )}
                      {resetPasswordFor === u.id && (
                        <div className="flex items-center gap-1.5 mt-2">
                          <input
                            type="password"
                            value={resetPasswordValue}
                            onChange={(e) => setResetPasswordValue(e.target.value)}
                            placeholder="كلمة المرور الجديدة"
                            autoComplete="new-password"
                            autoFocus
                            className="text-xs border border-border-soft rounded-lg px-2 py-1 w-44 focus:outline-none focus:ring-2 focus:ring-accent"
                          />
                          <button onClick={() => saveResetPassword(u)} disabled={userActionBusy === u.id} className="text-emerald-600 hover:text-emerald-700">
                            {userActionBusy === u.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                          </button>
                          <button onClick={() => setResetPasswordFor(null)} className="text-slate-400 hover:text-red-600">
                            <X size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <select
                        value={u.role}
                        onChange={(e) =>
                          updateUserRole(
                            u,
                            e.target.value as UserRow['role']
                          )
                        }
                        className="text-xs border border-border-soft rounded-lg px-2 py-1.5"
                      >
                        <option value="owner">مالك</option>
                        <option value="warehouse_manager">مدير مخزن</option>
                        <option value="sales">مبيعات</option>
                        <option value="purchasing">مشتريات</option>
                        <option value="accountant">محاسب</option>
                      </select>
                      <button
                        onClick={() => startResetPassword(u)}
                        disabled={userActionBusy === u.id}
                        className="text-slate-500 hover:text-accent-dark disabled:opacity-50"
                        title="إعادة تعيين كلمة المرور"
                      >
                        <KeyRound size={16} />
                      </button>
                      <button
                        onClick={() => toggleUserActive(u)}
                        className={u.is_active ? 'text-emerald-600' : 'text-slate-400'}
                        title={u.is_active ? 'إيقاف الحساب' : 'تفعيل الحساب'}
                      >
                        <Power size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'notifications' && (
        <div className="card p-5 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <Bell size={16} className="text-accent-dark" />
            <p className="font-display font-bold text-navy-900">تشغيل / إيقاف الإشعارات</p>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-border-soft">
            <div>
              <p className="text-sm font-medium text-navy-900">إشعارات نقص المخزون</p>
              <p className="text-xs text-slate-500">تنبيه لما صنف يوصل لحد التنبيه الأدنى</p>
            </div>
            <button
              onClick={() => handleToggle('notify_low_stock')}
              className={`w-11 h-6 rounded-full transition-colors relative ${settings.notify_low_stock ? 'bg-accent' : 'bg-border-soft'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${settings.notify_low_stock ? 'translate-x-0.5' : 'translate-x-5'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm font-medium text-navy-900">إشعارات الديون</p>
              <p className="text-xs text-slate-500">تنبيه لما عميل يتحول لمديون بعد ما كان رصيده صفر</p>
            </div>
            <button
              onClick={() => handleToggle('notify_debts')}
              className={`w-11 h-6 rounded-full transition-colors relative ${settings.notify_debts ? 'bg-accent' : 'bg-border-soft'}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${settings.notify_debts ? 'translate-x-0.5' : 'translate-x-5'}`} />
            </button>
          </div>
        </div>
      )}

      {tab === 'backup' && <BackupPanel />}

      {tab === 'system' && (
        <div className="card p-5 md:p-6">
          <div className="flex items-center gap-2 mb-4">
            <Info size={16} className="text-accent-dark" />
            <p className="font-display font-bold text-navy-900">معلومات النظام</p>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">إصدار النظام</span><span className="font-mono-data">1.0.0</span></div>
            <div className="flex justify-between"><span className="text-slate-500">آخر تحديث</span><span className="font-mono-data">{new Date().toLocaleDateString('ar-EG')}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}