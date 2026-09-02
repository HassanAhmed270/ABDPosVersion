import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

// Stage 14: the Audit Log screen is admin-only outright, unlike most
// screens here (e.g. Orders), which stay visible to cashiers in a
// reduced/read-only form. This wraps ProtectedRoute's job (must be
// logged in) and adds the extra role check on top — a cashier hitting
// /audit-log gets bounced to /dashboard instead of a blank/broken page.
// The backend enforces the same thing independently (requireAdmin on
// GET /api/audit-log), so this is a UX nicety, not the real boundary.
export default function AdminRoute({ children }) {
  const { isAuthenticated, isAdmin } = useAuth();
  if (!isAuthenticated) return <Navigate to="/" replace />;
  if (!isAdmin) return <Navigate to="/billing" replace />;
  return children;
}
