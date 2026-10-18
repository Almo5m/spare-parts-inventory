import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ErrorBoundary from './components/ErrorBoundary'

const root = createRoot(document.getElementById('root')!)

// لو متغيرات البيئة ناقصة (.env مش متظبط أو مش متضاف في Vercel) كان الموقع بيفتح
// شاشة بيضا من غير أي تفسير. دلوقتي بنوضّح السبب بدل كده، وبنحمّل التطبيق بعد الفحص بس.
const missingEnv = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter(
  (name) => !import.meta.env[name]
)

if (missingEnv.length > 0) {
  root.render(
    <div dir="rtl" style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: 520, margin: '4rem auto' }}>
      <h2>إعدادات الاتصال ناقصة</h2>
      <p>المتغيرات دي مش موجودة: <b dir="ltr">{missingEnv.join(' , ')}</b></p>
      <p>ضيفها في ملف <b dir="ltr">.env</b> (محليًا) أو في Environment Variables على Vercel، وبعدين اعمل إعادة نشر.</p>
    </div>
  )
} else {
  import('./App.tsx')
    .then(({ default: App }) => {
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </StrictMode>
      )
    })
    .catch(() => {
      // بيحصل لو الملف اتغيّر على السيرفر بعد تحديث (نسخة قديمة محفوظة في الكاش)
      // أو النت قطع وقت التحميل. من غير ده كانت بتظهر شاشة بيضا من غير أي تفسير.
      root.render(
        <div dir="rtl" style={{ fontFamily: 'sans-serif', padding: '2rem', maxWidth: 520, margin: '4rem auto' }}>
          <h2>تعذر تحميل التطبيق</h2>
          <p>غالبًا فيه تحديث جديد أو النت ضعيف. جرّب تحدّث الصفحة.</p>
          <button onClick={() => window.location.reload()} style={{ padding: '0.5rem 1.25rem', cursor: 'pointer' }}>
            تحديث الصفحة
          </button>
        </div>
      )
    })
}
