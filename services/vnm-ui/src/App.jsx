import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import useAuth from './hooks/useAuth';
import ErrorBoundary from './components/ErrorBoundary';
import Navbar from './components/Navbar';
import Library from './pages/Library';
import Player from './pages/Player';
import BuildLog from './pages/BuildLog';
import Gallery from './pages/Gallery';
import Login from './pages/Login';
import UserManagement from './pages/UserManagement';
import R2Settings from './pages/R2Settings';
import ImportGameModal from './components/ImportGameModal';
import useTheme from './hooks/useTheme';

/**
 * Wrapper that redirects to /login if not authenticated.
 */
function RequireAuth({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}

/**
 * Wrapper that redirects to /login if not authenticated,
 * and to /gallery if not admin.
 */
function RequireAdmin({ children }) {
  const { isAuthenticated, loading, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading…</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!isAdmin) {
    return <Navigate to="/gallery" replace />;
  }

  return children;
}

/**
 * Inner app content — uses auth context, renders protected routes.
 * Library manages its own data via useLibrary internally.
 */
function AppContent() {
  const { theme, toggleTheme, isDark } = useTheme();
  const { user, logout, isAuthenticated, isAdmin } = useAuth();
  const [showImportModal, setShowImportModal] = useState(false);
  const [showR2Modal, setShowR2Modal] = useState(false);
  const [r2Mode, setR2Mode] = useState(false);
  const location = useLocation();

  // Fetch r2Mode from health endpoint once on mount
  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => r.json())
      .then((d) => { if (d.r2Mode) setR2Mode(true); })
      .catch(() => {});
  }, []);

  const isLoginPage = location.pathname === '/login';
  const isPlayerPage = location.pathname.startsWith('/play/') || location.pathname.startsWith('/gallery/play/');
  const isBuildLogPage = location.pathname.startsWith('/build-log/');
  const isGalleryPage = location.pathname.startsWith('/gallery');
  const isFullscreenPage = isPlayerPage || isBuildLogPage || isGalleryPage;

  return (
    <div className={`min-h-dvh bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-50 transition-colors duration-200${isFullscreenPage ? '' : ' safe-area-pad'}`}>
      {/* Hide Navbar on login page, player page, and build-log page */}
      {!isLoginPage && !isFullscreenPage && isAuthenticated && (
        <Navbar
          onImport={() => setShowImportModal(true)}
          onR2Settings={() => setShowR2Modal(true)}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          username={user?.username}
          onLogout={logout}
          isAdmin={isAdmin}
          r2Mode={r2Mode}
        />
      )}

      <main className={isLoginPage || isFullscreenPage ? '' : 'pt-16'}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Library r2Mode={r2Mode} />
              </RequireAuth>
            }
          />
          <Route
            path="/play/:gameId"
            element={
              <RequireAuth>
                <Player />
              </RequireAuth>
            }
          />
          <Route
            path="/build-log/:jobId"
            element={
              <RequireAuth>
                <BuildLog />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAdmin>
                <UserManagement />
              </RequireAdmin>
            }
          />
          <Route
            path="/gallery"
            element={
              <RequireAuth>
                <Gallery r2Mode={r2Mode} />
              </RequireAuth>
            }
          />
          <Route
            path="/gallery/play/:gameId"
            element={
              <RequireAuth>
                <Player />
              </RequireAuth>
            }
          />
        </Routes>
      </main>

      {/* Import Game modal — dispatches vnm:library-refresh event on success */}
      {!isLoginPage && (
        <ImportGameModal
          open={showImportModal}
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            window.dispatchEvent(new Event('vnm:library-refresh'));
          }}
        />
      )}

      {/* R2 Settings modal (admin only) */}
      {!isLoginPage && isAdmin && r2Mode && (
        <R2Settings
          open={showR2Modal}
          onClose={() => setShowR2Modal(false)}
        />
      )}
    </div>
  );
}

/**
 * Main application shell with auth provider, routing, and error boundary.
 */
export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
