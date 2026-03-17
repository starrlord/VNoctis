import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const AuthContext = createContext(null);

const TOKEN_KEY = 'vnm-token';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);        // { userId, username, role } or null
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [loading, setLoading] = useState(true);   // true while validating stored token

  // Validate stored token on mount
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    fetch('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Invalid token');
        return res.json();
      })
      .then((data) => {
        setUser(data);
      })
      .catch(() => {
        // Token expired or invalid — clear it
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []); // Only run on mount — token is read from initial state

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
      setUser(me); // { userId, username, role }
    } else {
      setUser({ username }); // Fallback
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    // Fire-and-forget server-side logout
    fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
  }, []);

  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, isAuthenticated: !!user, isAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}

export default function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
