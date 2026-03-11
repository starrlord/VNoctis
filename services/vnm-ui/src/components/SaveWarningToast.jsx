import { useState, useEffect } from 'react';

const STORAGE_KEY = 'vnm-save-warning-dismissed';

/**
 * One-time dismissable toast warning about browser-save persistence.
 *
 * Positioned at the bottom-centre of its parent (the iframe area).
 * Only renders when the user has not previously dismissed it.
 * Auto-dismisses after 10 seconds.
 *
 * Entrance animation: slide-up + fade-in via CSS classes.
 */
export default function SaveWarningToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Don't show if already dismissed
    if (localStorage.getItem(STORAGE_KEY) === 'true') return;
    // Small delay so the toast appears after the iframe loads
    const showTimer = setTimeout(() => setVisible(true), 500);
    // Auto-dismiss after 10 seconds
    const hideTimer = setTimeout(() => dismiss(), 10500);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  }

  // Already dismissed or localStorage flag set
  if (!visible) return null;

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
                 bg-gray-900/90 backdrop-blur text-gray-200 text-sm
                 rounded-lg shadow-lg px-5 py-3 flex items-center gap-3
                 max-w-md w-[calc(100%-2rem)]
                 animate-[toastIn_0.4s_ease-out_forwards]"
      role="alert"
    >
      <span className="shrink-0 text-lg">⚠️</span>
      <p className="flex-1 leading-snug">
        Browser saves are stored in localStorage and may be lost if you clear
        browser data.
      </p>
      <button
        onClick={dismiss}
        className="shrink-0 px-3 py-1 text-xs font-semibold bg-gray-700 hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-white rounded-md transition-colors"
      >
        Got it
      </button>

      {/* Inline keyframes for the entrance animation */}
      <style>{`
        @keyframes toastIn {
          from {
            opacity: 0;
            transform: translate(-50%, 1rem);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }
      `}</style>
    </div>
  );
}
