import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { hasError: boolean }

// بيمسك أي خطأ غير متوقع في الواجهة بدل ما الشاشة تبقى بيضا فجأة.
// (الأخطاء الداخلية في الأكواد الغير متزامنة بتتعالج في كل صفحة لوحدها.)
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // بنسجّل في الـ console بس عشان تقدر تبعتلي التفاصيل لو حصلت مشكلة
    console.error('UI error:', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-surface">
        <div className="card max-w-md p-6 text-center">
          <p className="font-display font-bold text-navy-900 text-lg mb-2">حصلت مشكلة غير متوقعة</p>
          <p className="text-sm text-slate-500 mb-4">
            بياناتك المحفوظة في قاعدة البيانات في أمان. جرّب تعمل تحديث للصفحة، ولو المشكلة
            اتكررت ابعتلي اللي كان بيحصل قبلها.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn-primary text-white rounded-xl px-5 py-2.5 font-medium"
          >
            تحديث الصفحة
          </button>
        </div>
      </div>
    )
  }
}
