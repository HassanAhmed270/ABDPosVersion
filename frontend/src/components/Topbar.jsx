import { useAuth } from '../lib/AuthContext';
import { FaUser } from 'react-icons/fa';
import LowStockBell from './LowStockBell';

export default function Topbar({ title }) {
  const { username, isAdmin } = useAuth();

  return (
    <header className="flex flex-wrap gap-3 justify-between items-center pl-14 pr-4 py-3 @min-[768px]:px-6 bg-white shadow">
      <h1 className="text-xl @min-[640px]:text-2xl @min-[768px]:text-3xl font-bold text-brand">
        {title}
      </h1>

      <div className="flex items-center gap-3 @min-[640px]:gap-4">
        {/* Stage 15 — low-stock notifications are admin-visible only,
            same convention as the Audit Log link (Stage 14). */}
        {isAdmin && <LowStockBell />}

        <div className="flex items-center gap-2">
          <span className="h-8 w-8 rounded-full ring-2 ring-brand bg-brand/10 text-brand flex items-center justify-center shrink-0">
            <FaUser className="text-sm" />
          </span>

          <span className="hidden @min-[640px]:inline text-base font-medium text-brand">
            {username}
          </span>
        </div>
      </div>
    </header>
  );
}

