import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { rememberOfflineSession, offlineSession, forgetOfflineSession } from '../utils/offlineSession';

const AuthContext = createContext(null);

const TOKEN_KEY = 'vnm-token';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);        // { userId, username, role } or null
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);   // true while validating stored token
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const accountChanged = event => {
      if (event.key !== TOKEN_KEY && event.key !== null) return;
      setUser(null); setIsOffline(false); setLoading(true); setToken(localStorage.getItem(TOKEN_KEY));
    };
    window.addEventListener('storage', accountChanged);
    return () => window.removeEventListener('storage', accountChanged);
  }, []);

  // Validate stored token on mount
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const validate = async () => {
      try {
        const res = await fetch('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!res.ok) throw Object.assign(new Error('Session unavailable'), { denied: res.status >= 400 && res.status < 500 });
        const data = await res.json();
        if (cancelled || localStorage.getItem(TOKEN_KEY) !== token) return;
        await rememberOfflineSession(data, token).catch(() => {});
        if (!cancelled) { setUser(data); setIsOffline(false); }
      } catch (error) {
        if (cancelled) return;
        if (error.denied) {
          localStorage.removeItem(TOKEN_KEY); forgetOfflineSession(); setToken(null); setUser(null);
        } else {
          const saved = await offlineSession(token);
          if (!cancelled) { setUser(saved); setIsOffline(Boolean(saved)); }
        }
      } finally { if (!cancelled) setLoading(false); }
    };
    validate(); window.addEventListener('online', validate);
    return () => { cancelled = true; controller.abort(); window.removeEventListener('online', validate); };
  }, [token]);

  const login = useCallback(async (username, password) => {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'Login failed');
    }

    const data = await res.json();
    localStorage.setItem(TOKEN_KEY, data.token);
    setToken(data.token);

    // Fetch full user profile (userId, username, role) from the new token
    const meRes = await fetch('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      await rememberOfflineSession(me, data.token).catch(() => {});
      setIsOffline(false);
      setUser(me); // { userId, username, role }
    } else {
      setUser({ username }); // Fallback
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    forgetOfflineSession(); setIsOffline(false);
    setToken(null);
    setUser(null);
    // Fire-and-forget server-side logout
    fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
  }, []);

  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, isOffline, isAuthenticated: !!user, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export default function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
