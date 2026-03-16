import { useNavigate, useLocation } from 'react-router-dom';

/**
 * Compact top-bar chrome displayed over the game iframe.
 *
 * On non-iOS devices: renders a full bar with back button, centred game
 * title, volume slider, and fullscreen toggle.  In fullscreen the bar
 * hides completely; hovering / touching near the top edge reveals it
 * temporarily (controlled by the parent via `visible` prop).
 *
 * On iOS (iPhone / iPad): renders a minimal floating pill showing only
 * "← Library" (or "← Gallery") to maximise gameplay viewport.  The pill
 * auto-fades after a few seconds and reappears via a touch-reveal zone
 * managed by the parent Player component.
 *
 * @param {{
 *   title: string,
 *   isIOS?: boolean,
 *   isFullscreen: boolean,
 *   visible: boolean,
 *   volume: number,
 *   onVolumeChange: (v: number) => void,
 *   onToggleFullscreen: () => void,
 *   showFullscreenButton?: boolean,
 * }} props
 */
export default function PlayerChrome({
  title,
  isIOS = false,
  isFullscreen,
  visible,
  volume,
  onVolumeChange,
  onToggleFullscreen,
  showFullscreenButton = true,
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isGalleryPlayer = location.pathname.startsWith('/gallery/play/');
  const backPath = isGalleryPlayer ? '/gallery' : '/';
  const backLabel = isGalleryPlayer ? 'Gallery' : 'Library';

  // ------------------------------------------------------------------
  // iOS: minimal floating pill — just "← Library" / "← Gallery"
  // Saves ~48px of vertical space that the full bar would consume.
  // Positioned with safe-area offsets to avoid the notch / Dynamic Island.
  // Uses pointer-events-none when hidden so taps fall through to the
  // game iframe (the parent provides an invisible touch-reveal zone).
  // ------------------------------------------------------------------
  if (isIOS) {
    return (
      <button
        onClick={() => navigate(backPath)}
        className={`
          fixed z-50
          top-[max(0.5rem,env(safe-area-inset-top))]
          left-[max(0.5rem,env(safe-area-inset-left))]
          flex items-center gap-1.5
          px-3.5 py-2 min-h-[44px]
          bg-gray-900/60 backdrop-blur-sm
          text-gray-200 text-sm font-medium
          rounded-full shadow-lg
          transition-opacity duration-500
          ${visible ? 'opacity-90' : 'opacity-0 pointer-events-none'}
        `}
        aria-label={`Back to ${backLabel.toLowerCase()}`}
      >
        {/* ← arrow */}
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
            d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
          />
        </svg>
        {backLabel}
      </button>
    );
  }

  // ------------------------------------------------------------------
  // Non-iOS: full chrome bar with title, volume, fullscreen toggle
  // ------------------------------------------------------------------

  // In fullscreen the bar slides in/out based on `visible`
  const barClasses = isFullscreen
    ? `fixed top-0 inset-x-0 z-50 transition-transform duration-300 ${
        visible ? 'translate-y-0' : '-translate-y-full'
      }`
    : 'relative z-40';

  return (
    <header
      className={`${barClasses} h-12 flex items-center justify-between px-3 bg-gray-900/95 backdrop-blur select-none`}
    >
      {/* ---- Left: Back to library ---- */}
      <button
        onClick={() => navigate(backPath)}
        className="flex items-center gap-1.5 text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-md px-2 py-1.5 min-h-[44px] transition-colors"
        aria-label={`Back to ${backLabel.toLowerCase()}`}
      >
        {/* ← arrow */}
        <svg
          className="w-5 h-5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
          />
        </svg>
        <span className="text-sm font-medium hidden sm:inline">{backLabel}</span>
      </button>

      {/* ---- Centre: Game title ---- */}
      <h1 className="absolute left-1/2 -translate-x-1/2 max-w-[40%] text-sm font-semibold text-white truncate pointer-events-none">
        {title}
      </h1>

      {/* ---- Right: Volume + Fullscreen ---- */}
      <div className="flex items-center gap-3">
        {/* Volume slider */}
        <label className="flex items-center gap-1.5 cursor-pointer group">
          {/* Speaker icon */}
          <svg
            className="w-4 h-4 text-gray-400 group-hover:text-white transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            {volume === 0 ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-3.72a.75.75 0 0 1 1.28.53v14.88a.75.75 0 0 1-1.28.53l-4.72-3.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-3.72a.75.75 0 0 1 1.28.53v14.88a.75.75 0 0 1-1.28.53l-4.72-3.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
              />
            )}
          </svg>
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(e) => onVolumeChange(Number(e.target.value))}
            className="w-20 h-1 accent-blue-500 bg-gray-600 rounded-full appearance-none cursor-pointer
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                       [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-400
                       [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3
                       [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-blue-400 [&::-moz-range-thumb]:border-0"
            aria-label="Volume"
          />
        </label>

        {/* Fullscreen toggle — hidden on iOS where the API is unsupported */}
        {showFullscreenButton && (
          <button
            onClick={onToggleFullscreen}
            className="text-gray-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-md p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFullscreen ? (
              /* Collapse icon */
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
                />
              </svg>
            ) : (
              /* Expand icon */
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
                />
              </svg>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
