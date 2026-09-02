import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

const links = [
  { to: '/billing', label: 'Billing' },
  { to: '/products', label: 'Products' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/orders', label: 'Orders' },
  { to: '/reports', label: 'Reports' },

];

const adminOnlyLinks = [
  { to: '/dashboard', label: 'Home' },
  { to: '/billing', label: 'Billing' },
  { to: '/products', label: 'Products' },
  { to: '/customers', label: 'Customers' },
  { to: '/suppliers', label: 'Suppliers' },
  { to: '/orders', label: 'Orders' },
  { to: '/audit-log', label: 'Audit Log' },
  { to: '/reports', label: 'Reports' },
  { to: '/workers', label: 'Workers' },
];

// Stage 16 — responsive nav, keyed off the canvas's own width via
// `@min-[768px]:` container-query variants (not the real screen width —
// see `.app-canvas { container-type: inline-size }` in index.css). Below
// 768px of *canvas* width the sidebar becomes an off-canvas drawer (fixed,
// translated out of view, toggled by a hamburger button that this
// component renders itself so every page gets it "for free" without each
// page's layout needing to change). At 768px and above it's back to the
// original always-visible, in-flow column. Since the canvas is a fixed
// 1536px wide, in practice this column stays visible at every physical
// screen size — the drawer only exists for completeness / future reference
// designs narrower than 768px, not to react to the real device width.
export default function Sidebar() {
  const { logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleLinkClick = () => setOpen(false);

  const visibleLinks = isAdmin ? [...adminOnlyLinks] : links;

  return (
    <>
      {/* Hamburger — mobile/tablet only, fixed so it's reachable regardless
          of page scroll position. Each page's own header (Topbar or an
          inline header) leaves space for this via `pl-14 @min-[768px]:pl-0`. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="@min-[768px]:hidden fixed top-3 left-3 z-30 h-9 w-9 flex items-center justify-center rounded-lg bg-brand text-white shadow"
      >
        <span className="text-xl leading-none">☰</span>
      </button>

      {/* Backdrop — mobile/tablet only, shown while the drawer is open. */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="@min-[768px]:hidden fixed inset-0 bg-black/40 z-30"
          aria-hidden="true"
        />
      )}

      <aside
        className={`w-64 shrink-0 bg-brand text-white flex flex-col fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 ease-in-out
          ${open ? 'translate-x-0' : '-translate-x-full'} @min-[768px]:translate-x-0 @min-[768px]:static @min-[768px]:z-auto`}
      >
        <div className="p-6 text-2xl font-bold border-b border-brand-dark flex items-center justify-between">
          Dashboard
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="@min-[768px]:hidden text-white/80 hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>
        <nav className="flex-1 py-4 overflow-y-auto">
          {visibleLinks.map((link) =>
            link.disabled ? (
              <span
                key={link.label}
                title="Coming soon"
                className="block px-4 py-2 border-t border-b border-white/40 text-white/50 cursor-not-allowed"
              >
                {link.label}
              </span>
            ) : (
              <NavLink
                key={link.to}
                to={link.to}
                onClick={handleLinkClick}
                className={({ isActive }) =>
                  `block px-4 py-2 border-t border-b border-white hover:bg-brand-dark ${isActive ? 'bg-brand-dark' : ''}`
                }
              >
                {link.label}
              </NavLink>
            )
          )}
        </nav>
        <div className="pt-4">
          <button
            onClick={handleLogout}
            className="w-full text-left border-t border-white block px-4 py-2 hover:bg-red-600"
          >
            🚪 Logout
          </button>
        </div>
      </aside>
    </>
  );
}
