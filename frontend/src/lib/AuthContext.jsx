import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, tokenStore } from './api';

const AuthContext = createContext(null);

const USER_KEY = 'pos.user'; // { username, role } — the token itself lives in tokenStore (api.js)
// Stage 12: how often to silently renew the token while the app is open.
// JWT_EXPIRES_IN defaults to 8h server-side; refreshing every 30 minutes
// stays comfortably inside that window even if it's later configured
// shorter, so a session never lapses mid-shift just from sitting idle.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (tokenStore.get() ? loadStoredUser() : null));

  const logout = useCallback(() => {
    tokenStore.clear();
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  // If any API call comes back 401 (expired/invalid token), drop the
  // session so ProtectedRoute sends the person back to the login screen.
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener('auth:unauthorized', handler);
    return () => window.removeEventListener('auth:unauthorized', handler);
  }, []);

  // Stage 12: silent re-auth. While a session is active, periodically swap
  // the current token for a fresh one before it can expire, so a cashier
  // mid-shift never hits a surprise forced logout. If the refresh call
  // itself 401s (token already expired, or the account was removed), the
  // shared 401 handler above already clears the session — nothing extra
  // to do here.
  useEffect(() => {
    if (!user) return undefined;
    const interval = setInterval(async () => {
      try {
        const data = await api.refresh();
        if (data.success) {
          tokenStore.set(data.token);
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
          setUser(data.user);
        }
      } catch {
        // Network hiccup or expired token — the 401 path (if any) already
        // handles logout; a transient failure just retries next interval.
      }
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user]);

  const login = useCallback(async (username, password) => {
    const data = await api.login(username, password);
    if (!data.success) {
      throw new Error(data.message || 'Login failed.');
    }
    tokenStore.set(data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        username: user?.username || '',
        role: user?.role || '',
        isAdmin: user?.role === 'admin',
        isAuthenticated: !!user,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}