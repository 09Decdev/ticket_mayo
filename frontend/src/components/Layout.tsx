import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clearAuth, decodeJwt, getJwt, getStoredUser } from '../api/storage';
import {
  IconCalendar,
  IconChart,
  IconCheckIn,
  IconList,
  IconLogout,
  IconSend,
  IconTag,
  IconTicket,
  IconUsers,
} from './icons';
import type { ReactNode } from 'react';

interface SidebarLink {
  to: string;
  label: string;
  icon: ReactNode;
  prefixMatch?: boolean;
}

const SEND_LINKS: SidebarLink[] = [
  { to: '/admin/distribute', label: 'Phát vé', icon: <IconSend />, prefixMatch: true },
];

const MANAGE_LINKS: SidebarLink[] = [
  { to: '/admin/distributions', label: 'Lịch phát vé', icon: <IconList /> },
  { to: '/admin/events', label: 'Sự kiện', icon: <IconCalendar /> },
  { to: '/admin/ticket-types', label: 'Loại vé', icon: <IconTag /> },
  { to: '/admin/merge-ticket-types', label: 'Gộp loại vé', icon: <IconTicket /> },
  { to: '/admin/split-ticket-types', label: 'Điều chuyển vé', icon: <IconTicket /> },
];

const OPERATE_LINKS: SidebarLink[] = [
  { to: '/admin/check-in', label: 'Check-in', icon: <IconCheckIn /> },
  { to: '/admin/stats', label: 'Thống kê', icon: <IconChart /> },
  { to: '/admin/attendance', label: 'Attendance', icon: <IconUsers /> },
];

function whoami(): { email: string; displayName?: string; role?: string } {
  const stored = getStoredUser();
  const token = getJwt();
  const payload = token ? decodeJwt(token) : null;
  const email = stored?.email || payload?.email || '';
  const displayName = stored?.displayName || payload?.displayName || email;
  return {
    email,
    displayName,
    role: payload?.role || stored?.role || '',
  };
}

function Brand() {
  return (
    <div className="sidebar-brand">
      <div className="brand-mark">
        <IconTicket width={18} height={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="brand-name">ticket-mayo</div>
        <div className="brand-sub">Admin portal</div>
      </div>
    </div>
  );
}

function LinkGroup({ title, links }: { title: string; links: SidebarLink[] }) {
  return (
    <>
      <div className="sidebar-section-label">{title}</div>
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={!l.prefixMatch}
          className={({ isActive }) => (isActive ? 'sidebar-link active' : 'sidebar-link')}
        >
          {l.icon}
          <span>{l.label}</span>
        </NavLink>
      ))}
    </>
  );
}

function SidebarFooter() {
  const navigate = useNavigate();
  const { email, displayName, role } = whoami();
  const initial = (displayName || email || '?').trim().charAt(0).toUpperCase();
  return (
    <div className="sidebar-footer">
      <div className="sidebar-whoami">
        <div className="sidebar-avatar">{initial}</div>
        <div className="whoami-text">
          <div className="whoami-name">{displayName || email || 'Khách'}</div>
          <div className="whoami-role">{role === 'ADMIN' ? 'Admin' : email || ''}</div>
        </div>
      </div>
      <button
        type="button"
        className="sidebar-logout"
        onClick={() => {
          clearAuth();
          navigate('/admin/login', { replace: true });
        }}
      >
        <IconLogout width={16} height={16} />
        Đăng xuất
      </button>
    </div>
  );
}

export function AdminLayout() {
  return (
    <div className="layout">
      <aside className="layout-sidebar">
        <Brand />
        <LinkGroup title="Phát vé" links={SEND_LINKS} />
        <LinkGroup title="Quản lý" links={MANAGE_LINKS} />
        <LinkGroup title="Vận hành sự kiện" links={OPERATE_LINKS} />
        <SidebarFooter />
      </aside>
      <main className="layout-main">
        <Outlet />
      </main>
    </div>
  );
}