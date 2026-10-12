import { useState } from 'react'
import { Loader2, Wrench, Lock, User } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { normalizeUsername } from '../lib/authRules'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    // نفس تنظيف الاسم اللي بيتحفظ بيه وقت الإنشاء (مسافات + حروف صغيرة)
    const email = `${normalizeUsername(username)}@warehouse.local`
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError('اسم المستخدم أو كلمة المرور غير صحيحة')
      setLoading(false)
      return
    }

    // كلمة السر ممكن تكون صح لكن الحساب متوقف من الإعدادات — من غير
    // الفحص ده المستخدم كان بيشوف تطبيق فاضي تمامًا من غير أي تفسير
    const { data: profile } = await supabase
      .from('users')
      .select('is_active')
      .eq('id', data.user.id)
      .single()

    if (!profile || !profile.is_active) {
      await supabase.auth.signOut()
      setError('حسابك متوقف حاليًا. تواصل مع صاحب النظام عشان يفعّله تاني.')
      setLoading(false)
      return
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* الجزء الترحيبي — يختفي على الشاشات الصغيرة جدًا ويتحول لشريط علوي مختصر */}
      <div className="hero-gradient text-white flex-1 flex flex-col justify-between p-8 md:p-12 min-h-[220px] md:min-h-screen">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
            <Wrench className="text-accent" size={20} />
          </div>
          <span className="font-display font-extrabold text-lg">نظام المخزن</span>
        </div>

        <div className="pop-enter max-w-md mt-10 md:mt-0">
          <h1 className="font-display font-extrabold text-2xl md:text-4xl leading-tight mb-3">
            أهلًا بيك تاني 👋
          </h1>
          <p className="text-white/70 text-sm md:text-base leading-relaxed">
            تابع مخزونك وفواتيرك وطلبياتك ورصيد عملائك من مكان واحد،
            بسهولة وأمان، من أي جهاز.
          </p>
        </div>

        <p className="hidden md:block text-white/40 text-xs">
          نظام إدارة مخازن قطع غيار السيارات
        </p>
      </div>

      {/* جزء الفورم */}
      <div className="flex-1 flex items-center justify-center bg-surface p-6 md:p-12">
        <form
          onSubmit={handleLogin}
          className="page-enter card w-full max-w-sm p-7 md:p-8"
        >
          <h2 className="font-display text-xl font-bold mb-1 text-navy-900">
            تسجيل الدخول
          </h2>
          <p className="text-sm text-slate-500 mb-6">
            ادخل ببيانات حسابك للمتابعة
          </p>

          {error && (
            <p className="bg-red-50 text-red-600 text-sm rounded-lg px-3 py-2 mb-4">
              {error}
            </p>
          )}

          <label className="block text-xs font-medium text-slate-500 mb-1.5">اسم المستخدم</label>
          <div className="relative mb-4">
            <User size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border border-border-soft rounded-xl pr-9 pl-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
              required
              autoFocus
            />
          </div>

          <label className="block text-xs font-medium text-slate-500 mb-1.5">كلمة المرور</label>
          <div className="relative mb-6">
            <Lock size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-border-soft rounded-xl pr-9 pl-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent transition-shadow"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2 text-white rounded-xl py-2.5 font-medium transition-all disabled:opacity-70"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? 'جاري الدخول...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  )
}
