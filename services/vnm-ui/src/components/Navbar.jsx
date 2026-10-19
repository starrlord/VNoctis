import { Link, useLocation } from 'react-router-dom';
import { useEffect, useRef } from 'react';

/**
 * Top navigation bar for the VNoctis Manager application.
 * Shows the app title, theme toggle, gallery link, import button, and user/logout controls.
 *
 * @param {{
 *   onImport?: () => void,
 *   isDark?: boolean,
 *   onToggleTheme?: () => void,
 *   username?: string,
 *   onLogout?: () => void,
 * }} props
 */
export default function Navbar({ onImport, onOrphanedSaves, onR2Settings, isDark = true, onToggleTheme, username, onLogout, isAdmin = false, r2Mode = false }) {
  const menu = useRef(null), location = useLocation();
  useEffect(() => { menu.current?.removeAttribute('open'); }, [location.pathname]);
  useEffect(() => {
    const close = event => { if (!menu.current?.contains(event.target)) menu.current?.removeAttribute('open'); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const item = 'w-full min-h-[44px] px-4 py-2 text-left text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500';
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-3 sm:px-6 shadow-lg transition-colors duration-200">
      {/* Left: App title — clickable, navigates to admin library */}
      <Link to="/" className="text-xl font-bold text-gray-900 dark:text-white tracking-wide select-none hover:text-blue-500 dark:hover:text-blue-400 transition-colors">
        🎮 VNoctis Manager
      </Link>

      {/* Right: Theme toggle + Import + User controls */}
      <details ref={menu} className="xl:hidden relative" onKeyDown={event=>{if(event.key==='Escape'){menu.current.removeAttribute('open');menu.current.querySelector('summary').focus();}}}>
        <summary aria-label="Open navigation" className="list-none min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16"/></svg></summary>
        <div className="absolute right-0 top-14 w-64 max-w-[calc(100vw-2rem)] max-h-[80dvh] overflow-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-xl p-2" onClick={event=>{if(event.target.closest('a,button'))menu.current.removeAttribute('open');}}>
          {username&&<p className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 break-words">{username}</p>}
          <Link className={'block '+item} to="/dashboard">Your dashboard</Link><Link className={'block '+item} to="/">Library</Link><Link className={'block '+item} to="/gallery">Gallery</Link>
          {onToggleTheme&&<button className={item} onClick={onToggleTheme}>{isDark?'Light theme':'Dark theme'}</button>}
          {isAdmin&&<><Link className={'block '+item} to="/admin/users">Users</Link>{onOrphanedSaves&&<button className={item} onClick={onOrphanedSaves}>Orphaned saves</button>}{onImport&&<button className={item} onClick={onImport}>Import game</button>}{r2Mode&&onR2Settings&&<button className={item} onClick={onR2Settings}>R2 settings</button>}</>}
          {onLogout&&<button className={item+' text-red-600 dark:text-red-400'} onClick={onLogout}>Sign out</button>}
        </div>
      </details>
      <div className="hidden xl:flex items-center gap-2 2xl:gap-3">
        <Link to="/dashboard" className="min-h-[44px] px-3 py-2 inline-flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500">Dashboard</Link>
        {/* Theme toggle button */}
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors duration-200"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              /* Sun icon — shown in dark mode, click to go light */
              <svg
                className="w-5 h-5 transition-transform duration-300"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                />
              </svg>
            ) : (
              /* Moon icon — shown in light mode, click to go dark */
              <svg
                className="w-5 h-5 transition-transform duration-300"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                />
              </svg>
            )}
          </button>
        )}

        {/* View Game Gallery button */}
        <Link
          to="/gallery"
          className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium rounded-lg transition-colors duration-200"
          title="Game Gallery"
        >
          <svg
            className="h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-2.625 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5"
            />
          </svg>
          <span className="hidden sm:inline">Game Gallery</span>
        </Link>

        {/* User Management link (admin only) */}
        {isAdmin && (
          <Link
            to="/admin/users"
            className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors duration-200"
            title="User Management"
          >
            <svg className="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
            <span className="hidden sm:inline">Users</span>
          </Link>
        )}

        {/* R2 Settings button (admin + R2 mode only) */}
        {isAdmin && onOrphanedSaves && (
          <button onClick={onOrphanedSaves} title="Orphaned saves" aria-label="Orphaned saves"
            className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors duration-200">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M4 8h16v12H4zM3 4h18v4H3zm6 8h6" /></svg>
            <span className="hidden sm:inline">Saves</span>
          </button>
        )}
        {isAdmin && r2Mode && onR2Settings && (
          <button
            onClick={onR2Settings}
            className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium rounded-lg transition-colors duration-200"
            title="R2 Publishing Settings"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
            </svg>
            <span className="hidden sm:inline">R2</span>
          </button>
        )}

        {/* Import Game button (admin only) */}
        {isAdmin && onImport && (
          <button
            onClick={onImport}
            className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors duration-200"
            title="Import Game"
          >
            <svg
              className="h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
            <span className="hidden sm:inline">Import Game</span>
          </button>
        )}

        {/* Separator + User controls */}
        {(username || onLogout) && (
          <>
            <div className="h-6 w-px bg-gray-300 dark:bg-gray-700" />

            {/* Username badge */}
            {username && (
              <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline max-w-28 truncate">
                {username}
              </span>
            )}

            {/* Logout button */}
            {onLogout && (
              <button
                onClick={onLogout}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors duration-200"
                title="Sign out"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
                  />
                </svg>
                <span className="hidden sm:inline">Logout</span>
              </button>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
