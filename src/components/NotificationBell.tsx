import { useCallback, useEffect, useState, useRef } from 'react'
import { Bell } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/useAuth'
import type { Database } from '../lib/database.types'

type Notification = Database['public']['Tables']['notifications']['Row']

const LAST_SEEN_KEY_PREFIX = 'notifications_last_seen'

// نستخدم AudioContext واحد ثابت طول عمر الصفحة بدل ما نعمل واحد جديد
// كل مرة — المتصفحات كتير بترفض تشغيل Context جديد من غير تفاعل مباشر،
// فاستخدام واحد ثابت وعمل resume() له أضمن بكتير.
let sharedAudioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  try {
    if (!sharedAudioCtx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      sharedAudioCtx = new AudioCtx()
    }
    return sharedAudioCtx
  } catch {
    return null
  }
}

// عشان أي متصفح يسمح بتشغيل صوت لاحقًا، لازم نعمل "فك قفل" أول مرة
// جوه حدث تفاعل حقيقي من المستخدم (ضغطة/لمسة). بننده على الدالة دي
// مرة واحدة بس أول ما المستخدم يضغط في أي مكان في الصفحة.
function unlockAudioOnce() {
  const ctx = getAudioContext()
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  document.removeEventListener('pointerdown', unlockAudioOnce)
  document.removeEventListener('keydown', unlockAudioOnce)
}

document.addEventListener('pointerdown', unlockAudioOnce)
document.addEventListener('keydown', unlockAudioOnce)

function playNotificationSound() {
  const ctx = getAudioContext()
  if (!ctx) return

  const start = () => {
    const playTone = (freq: number, startTime: number, duration: number) => {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = freq
      gain.gain.setValueAtTime(0.001, ctx.currentTime + startTime)
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + startTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + duration)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(ctx.currentTime + startTime)
      oscillator.stop(ctx.currentTime + startTime + duration)
    }

    playTone(880, 0, 0.12)
    playTone(1175, 0.12, 0.15)
  }

  if (ctx.state === 'suspended') {
    ctx.resume().then(start).catch(() => {})
  } else {
    start()
  }
}

export default function NotificationBell() {
  const { session } = useAuth()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const isFirstLoad = useRef(true)

  // مفتاح منفصل لكل مستخدم، عشان لو أكتر من موظف بيستخدموا نفس الجهاز
  // مايتلخبطش عداد الإشعارات بينهم
  const lastSeenKey = `${LAST_SEEN_KEY_PREFIX}_${session?.user.id ?? 'guest'}`

  const updateUnread = useCallback((list: Notification[]) => {
    const lastSeen = localStorage.getItem(lastSeenKey)
    const lastSeenDate = lastSeen ? new Date(lastSeen) : new Date(0)
    setUnreadCount(list.filter((n) => new Date(n.created_at) > lastSeenDate).length)
  }, [lastSeenKey])

  useEffect(() => {
    let cancelled = false

    supabase.rpc('cleanup_old_notifications').then(() => {})

    supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (cancelled) return
        if (data) {
          setNotifications(data)
          updateUnread(data)
        }
        // بعد ما نجيب القايمة الأولانية، أي حاجة جاية بعد كده تعتبر
        // إشعار جديد فعلي (يستاهل صوت)
        isFirstLoad.current = false
      })

    const channel = supabase
      .channel('notifications-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          if (!isFirstLoad.current) {
            playNotificationSound()
          }
          setNotifications((prev) => {
            const updated = [payload.new as Notification, ...prev].slice(0, 30)
            updateUnread(updated)
            return updated
          })
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [updateUnread])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleOpen = () => {
    setOpen((prev) => !prev)
    if (!open) {
      localStorage.setItem(lastSeenKey, new Date().toISOString())
      setUnreadCount(0)
    }
  }

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center w-9 h-9 rounded-xl hover:bg-surface transition-colors text-navy-900"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -left-1 bg-accent text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="pop-enter absolute left-0 mt-2 w-80 max-w-[85vw] bg-white rounded-xl shadow-lg border border-border-soft overflow-hidden z-50 text-slate-800">
          <div className="p-3 border-b border-border-soft font-display font-bold text-navy-900 flex items-center justify-between">
            <span>الإشعارات</span>
            <span className="text-xs font-normal text-slate-400">بتُحذف تلقائيًا بعد 3 أيام</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="p-4 text-center text-sm text-slate-500">لا توجد إشعارات بعد</p>
            ) : (
              notifications.map((n) => (
                <div key={n.id} className="p-3 border-b border-border-soft last:border-b-0 hover:bg-surface transition-colors">
                  <p className="text-sm">{n.message}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {new Date(n.created_at).toLocaleString('ar-EG')}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
