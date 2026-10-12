import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard, Package, Tags, Users, ShoppingCart,
  ClipboardList as OrdersIcon, FileText, Warehouse as WarehouseIcon,
  ClipboardList, Undo2, Settings as SettingsIcon, BarChart3, LogOut, Wrench, Menu, X, History,
} from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { clearAllDrafts } from '../lib/draft'
import { useAuth } from '../context/useAuth'
import NotificationBell from './NotificationBell'
import GlobalSearch from './GlobalSearch'

const links = [
  { to: '/dashboard', label: 'الإحصائيات', icon: LayoutDashboard },
  { to: '/reports', label: 'التقارير', icon: BarChart3 },
  { to: '/products', label: 'الأصناف', icon: Package },
  { to: '/categories', label: 'التصنيفات', icon: Tags },
  { to: '/customers', label: 'العملاء', icon: Users },
  { to: '/sales', label: 'فاتورة بيع', icon: ShoppingCart },
  { to: '/orders', label: 'طلبية جديدة', icon: OrdersIcon },
  { to: '/invoices', label: 'الفواتير والطلبيات', icon: FileText },
  { to: '/returns', label: 'المرتجعات', icon: Undo2 },
  { to: '/warehouses', label: 'المخازن', icon: WarehouseIcon },
  { to: '/stocktake', label: 'الجرد', icon: ClipboardList },
  { to: '/activity-log', label: 'سجل العمليات', icon: History },
  { to: '/settings', label: 'الإعدادات', icon: SettingsIcon },
]

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const { profile } = useAuth()

  const handleLogout = async () => {
    clearAllDrafts()
    await supabase.auth.signOut()
  }

  const NavItems = () => (
    <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
      {links.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 border-r-2 ${
              isActive
                ? 'bg-white/10 border-accent text-white'
                : 'border-transparent text-white/70 hover:bg-white/5 hover:text-white hover:translate-x-0.5'
            }`
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  )

  const WelcomeBlock = () => (
    <div className="px-5 py-3 border-b border-white/10">
      <p className="text-xs text-white/50">أهلًا بيك 👋</p>
      <p className="text-sm font-medium text-white truncate">{profile?.full_name ?? '...'}</p>
    </div>
  )

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="hidden md:flex w-64 flex-col bg-linear-to-b from-navy-900 to-navy-950 text-white sticky top-0 h-screen">
        <div className="flex items-center gap-2 p-5 border-b border-white/10">
          <Wrench className="text-accent" size={22} />
          <span className="font-display font-extrabold text-lg">نظام المخزن</span>
        </div>
        <WelcomeBlock />
        <NavItems />
        <button
          onClick={handleLogout}
          className="m-3 flex items-center justify-center gap-2 rounded-xl border border-white/15 py-2.5 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors"
        >
          <LogOut size={16} />
          تسجيل الخروج
        </button>
      </aside>

      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/40 pop-enter"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-72 max-w-[80vw] flex flex-col bg-linear-to-b from-navy-900 to-navy-950 text-white h-full page-enter">
            <div className="flex items-center justify-between gap-2 p-5 border-b border-white/10">
              <div className="flex items-center gap-2">
                <Wrench className="text-accent" size={22} />
                <span className="font-display font-extrabold text-lg">نظام المخزن</span>
              </div>
              <button onClick={() => setMobileOpen(false)} className="text-white/70">
                <X size={20} />
              </button>
            </div>
            <WelcomeBlock />
            <NavItems />
            <button
              onClick={handleLogout}
              className="m-3 flex items-center justify-center gap-2 rounded-xl border border-white/15 py-2.5 text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors"
            >
              <LogOut size={16} />
              تسجيل الخروج
            </button>
          </aside>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="no-print glass-header flex items-center justify-between gap-2 md:gap-4 border-b border-border-soft px-4 md:px-6 py-3 sticky top-0 z-40">
          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg hover:bg-surface transition-colors text-navy-900"
          >
            <Menu size={20} />
          </button>

          <div className="flex-1 min-w-0">
            <GlobalSearch />
          </div>

          <div className="hidden md:block text-sm text-slate-500">
            أهلًا، <span className="font-medium text-navy-900">{profile?.full_name ?? ''}</span>
          </div>

          <NotificationBell />
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
