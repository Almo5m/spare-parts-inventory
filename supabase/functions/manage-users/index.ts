// Supabase Edge Function: manage-users
//
// بيستخدم Service Role Key (صلاحية أدمن كاملة) عشان يعمل عمليات لازم
// تتعمل من السيرفر ومينفعش تتعمل من المتصفح مباشرة (لأن كشف الـ
// Service Role Key في الواجهة معناه أي حد يقدر يتخطى كل صلاحيات
// الأمان في النظام):
//   - action: "create"           -> إنشاء حساب دخول جديد + صف في users
//   - action: "update_username"  -> تغيير username/email لمستخدم (نفسك أو غيرك)
//   - action: "reset_password"   -> إعادة تعيين كلمة مرور لمستخدم (نفسك أو غيرك)
//
// أي مستخدم مفعّل (is_active = true) في النظام يقدر يستخدمها — نفس
// فلسفة "كل المستخدمين المفعّلين ليهم نفس الصلاحيات" المطبّقة في باقي
// النظام. الفحص الوحيد اللي بيحصل: إن اللي طالب العملية عنده جلسة
// دخول صحيحة وحسابه مفعّل فعلًا.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// نفس القواعد الموجودة في src/lib/authRules.ts (الدالة بتشتغل على السيرفر فمش
// بتقدر تستورد منه) — لو غيّرت هناك غيّر هنا.
const MIN_PASSWORD_LENGTH = 10
const normalizeUsername = (raw: unknown) => String(raw ?? '').trim().toLowerCase()

// اسم المستخدم بيتحوّل لإيميل داخلي، فلازم يكون حروف إنجليزية صغيرة وأرقام و . _ - بس
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/
const USERNAME_ERROR = 'اسم المستخدم لازم يكون من 3 لـ 40 حرف إنجليزي صغير أو أرقام أو . _ - من غير مسافات'

// نفس قيم نوع user_role في قاعدة البيانات
const ALLOWED_ROLES = ['owner', 'warehouse_manager', 'sales', 'purchasing', 'accountant']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'مطلوب تسجيل دخول' }, 401)

    // عميل بصلاحية المستخدم الحالي بس — بنتأكد بيه إنه فعلًا مسجّل
    // دخول وحسابه مفعّل، قبل ما نستخدم صلاحيات الأدمن في أي حاجة
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: callerData, error: callerError } = await supabaseUser.auth.getUser()
    if (callerError || !callerData.user) return json({ error: 'جلسة غير صالحة' }, 401)

    const { data: callerRow } = await supabaseUser
      .from('users')
      .select('is_active, full_name')
      .eq('id', callerData.user.id)
      .single()

    if (!callerRow?.is_active) return json({ error: 'حسابك غير مفعّل' }, 403)

    // عميل بصلاحية الأدمن الكاملة (Service Role) — دي اللي بتعمل
    // العمليات الحساسة فعليًا بعد ما اتأكدنا إن الطالب مستخدم شرعي
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // عمليات إدارة الحسابات بتتسجّل في سجل العمليات (من غير أي كلمات مرور)
    const logAdminAction = async (text: string) => {
      const { error: logError } = await supabaseAdmin.from('activity_log').insert({
        user_id: callerData.user.id,
        user_name: callerRow.full_name ?? null,
        action: text,
      })
      if (logError) console.error('تعذر تسجيل العملية في سجل الأنشطة:', logError.message)
    }

    const body = await req.json()
    const action = body.action as string

    // ---------- إنشاء مستخدم جديد ----------
    if (action === 'create') {
      const username = normalizeUsername(body.username)
      const password = String(body.password ?? '')
      const full_name = String(body.full_name ?? '').trim()
      const phone = body.phone ? String(body.phone).trim() : null

      if (!username || !password || !full_name) {
        return json({ error: 'اسم المستخدم وكلمة المرور والاسم بالكامل مطلوبين' }, 400)
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return json({ error: `كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل` }, 400)
      }
      if (!USERNAME_PATTERN.test(username)) {
        return json({ error: USERNAME_ERROR }, 400)
      }

      const role = body.role ? String(body.role) : 'sales'
      if (!ALLOWED_ROLES.includes(role)) {
        return json({ error: 'الدور المحدد غير صحيح' }, 400)
      }

      const email = `${username}@warehouse.local`

      const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

      if (createError || !created.user) {
        const msg = createError?.message.includes('already been registered')
          ? 'اسم المستخدم ده مستخدم بالفعل'
          : createError?.message ?? 'تعذر إنشاء الحساب'
        return json({ error: msg }, 400)
      }

      const { error: insertError } = await supabaseAdmin.from('users').insert({
        id: created.user.id,
        username,
        full_name,
        phone,
        role,
        is_active: true,
      })

      if (insertError) {
        // نتراجع عن حساب الدخول لو فشل إدراج الصف، عشان مايفضلش حساب دخول
        // يتيم من غير صف بيانات مرتبط بيه
        await supabaseAdmin.auth.admin.deleteUser(created.user.id)
        return json({ error: insertError.message }, 400)
      }

      await logAdminAction(`إنشاء مستخدم جديد: ${username}`)
      return json({ success: true, id: created.user.id })
    }

    // ---------- تغيير اسم المستخدم (username/email) ----------
    if (action === 'update_username') {
      const user_id = String(body.user_id ?? '')
      const new_username = normalizeUsername(body.new_username)

      if (!user_id || !new_username) return json({ error: 'بيانات ناقصة' }, 400)
      if (!USERNAME_PATTERN.test(new_username)) {
        return json({ error: USERNAME_ERROR }, 400)
      }

      const { data: target } = await supabaseAdmin
        .from('users')
        .select('username')
        .eq('id', user_id)
        .maybeSingle()
      if (!target) return json({ error: 'المستخدم غير موجود' }, 404)

      // نتأكد إن الاسم مش مستخدم قبل ما نلمس حساب الدخول، عشان مايحصلش تغيير نصف مكتمل
      const { data: taken } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('username', new_username)
        .neq('id', user_id)
        .maybeSingle()
      if (taken) return json({ error: 'اسم المستخدم ده مستخدم بالفعل' }, 400)

      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        email: `${new_username}@warehouse.local`,
      })
      if (authError) {
        const msg = authError.message.includes('already been registered')
          ? 'اسم المستخدم ده مستخدم بالفعل'
          : authError.message
        return json({ error: msg }, 400)
      }

      const { error: rowError } = await supabaseAdmin
        .from('users')
        .update({ username: new_username })
        .eq('id', user_id)

      if (rowError) {
        // نرجّع إيميل الدخول القديم عشان حساب الدخول وصف المستخدم يفضلوا متطابقين
        await supabaseAdmin.auth.admin.updateUserById(user_id, {
          email: `${target.username}@warehouse.local`,
        })
        return json({ error: rowError.message }, 400)
      }

      await logAdminAction(`تغيير اسم مستخدم من ${target.username} إلى ${new_username}`)
      return json({ success: true })
    }

    // ---------- إعادة تعيين كلمة مرور ----------
    if (action === 'reset_password') {
      const user_id = String(body.user_id ?? '')
      const new_password = String(body.new_password ?? '')

      if (!user_id || new_password.length < MIN_PASSWORD_LENGTH) {
        return json({ error: `كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل` }, 400)
      }

      const { data: target } = await supabaseAdmin
        .from('users')
        .select('username')
        .eq('id', user_id)
        .maybeSingle()
      if (!target) return json({ error: 'المستخدم غير موجود' }, 404)

      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        password: new_password,
      })
      if (authError) return json({ error: authError.message }, 400)

      await logAdminAction(`إعادة تعيين كلمة مرور المستخدم: ${target.username}`)
      return json({ success: true })
    }

    return json({ error: 'عملية غير معروفة' }, 400)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'خطأ غير متوقع' }, 500)
  }
})
