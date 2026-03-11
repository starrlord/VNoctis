/**
 * Top navigation bar for the VNoctis Manager application.
 * Shows the app title, theme toggle, import button, and user/logout controls.
 *
 * @param {{
 *   onImport?: () => void,
 *   isDark?: boolean,
 *   onToggleTheme?: () => void,
 *   username?: string,
 *   onLogout?: () => void,
 * }} props
 */
export default function Navbar({ onImport, isDark = true, onToggleTheme, username, onLogout }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-16 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6 shadow-lg transition-colors duration-200">
      {/* Left: App title */}
      <h1 className="text-xl font-bold text-gray-900 dark:text-white tracking-wide select-none">
        🎮 VNoctis Manager
      </h1>

      {/* Right: Theme toggle + Import + User controls */}
      <div className="flex items-center gap-4">
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

        {/* Import Game button */}
        {onImport && (
          <button
            onClick={onImport}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors duration-200"
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
            Import Game
          </button>
        )}

        {/* Separator + User controls */}
        {(username || onLogout) && (
          <>
            <div className="h-6 w-px bg-gray-300 dark:bg-gray-700" />

            {/* Username badge */}
            {username && (
              <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline">
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
