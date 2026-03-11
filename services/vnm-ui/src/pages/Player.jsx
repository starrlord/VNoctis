import { useParams } from 'react-router-dom';
import { useState, useRef, useEffect, useCallback } from 'react';
import useBuildStatus from '../hooks/useBuildStatus';
import PlayerChrome from '../components/PlayerChrome';
import BuildProgress from '../components/BuildProgress';
import SaveWarningToast from '../components/SaveWarningToast';

/**
 * Full in-browser game player page at `/play/:gameId`.
 *
 * On mount fetches the game detail and checks its buildStatus:
 *  - ready/stale → show game iframe (stale also shows a rebuild banner)
 *  - not_built   → show "Build Required" card
 *  - queued      → show queued spinner
 *  - building    → show live build log
 *  - failed      → show error with retry
 *
 * The iframe loads the game's `webBuildPath/index.html` served by nginx.
 * Fullscreen API is used for immersive play; the chrome bar hides and
 * reappears on hover/touch near the top edge.
 */
export default function Player() {
  const { gameId } = useParams();
  const {
    game,
    loading,
    buildState,
    jobId,
    triggerBuild,
    cancelBuild,
    retryBuild,
    markPlayable,
  } = useBuildStatus(gameId);

  // ---- iOS detection ----
  // iOS Safari does NOT support the Fullscreen API on non-<video> elements.
  // We detect it once so we can hide the fullscreen button and adjust UX.
  const isIOS = useRef(
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ).current;

  // ---- Fullscreen ----
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ---- Chrome bar visibility (ref-based dedup) ----
  // We keep both a ref and state: the ref prevents redundant setState
  // calls during rapid touch events (timer churn), and the state drives
  // the React render when the value actually transitions.
  const chromeVisibleRef = useRef(true);
  const [chromeVisible, setChromeVisibleRaw] = useState(true);
  const hideTimerRef = useRef(null);

  const setChromeVisible = useCallback((val) => {
    if (chromeVisibleRef.current === val) return;
    chromeVisibleRef.current = val;
    setChromeVisibleRaw(val);
  }, []);

  // ---- Volume (visual-only for now) ----
  const [volume, setVolume] = useState(80);

  // ---- Force-play for stale builds ----
  const [forcePlay, setForcePlay] = useState(false);

  // ---- Portrait overlay dismiss (persisted in sessionStorage) ----
  // When iOS Safari kills a tab from memory pressure it reloads the URL,
  // resetting all React state.  Persisting the dismissal per-game in
  // sessionStorage prevents the "Rotate your device" overlay from
  // reappearing every time the tab recovers.
  const overlayStorageKey = `vnm-overlay-dismissed-${gameId}`;
  const [overlayDismissed, setOverlayDismissedRaw] = useState(
    () => sessionStorage.getItem(overlayStorageKey) === 'true'
  );

  const dismissOverlay = useCallback(() => {
    setOverlayDismissedRaw(true);
    try {
      sessionStorage.setItem(overlayStorageKey, 'true');
    } catch {
      // sessionStorage may be unavailable in some contexts; degrade gracefully
    }
  }, [overlayStorageKey]);

  // ---- Track portrait / landscape orientation for deferred loading ----
  // On iOS especially, mounting the game iframe while the portrait overlay
  // blocks interaction causes WebGL + Emscripten to consume memory/GPU in
  // the background, exceeding Safari's ~1.4 GB limit and crashing the tab.
  // We defer the iframe until the user dismisses the overlay or rotates.
  const [isPortrait, setIsPortrait] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(orientation: portrait)').matches
      : false
  );

  useEffect(() => {
    const mql = window.matchMedia('(orientation: portrait)');
    const handler = (e) => setIsPortrait(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const title = game?.vndbTitle || game?.extractedTitle || 'Loading…';
  const showIframe =
    buildState === 'ready' || (buildState === 'stale' && forcePlay);

  // Only mount the heavy game iframe when the portrait overlay is not blocking.
  // In landscape (isPortrait=false) the overlay is hidden via CSS, so render.
  // In portrait, wait until the user explicitly taps "Continue in portrait".
  // Desktop users are virtually always landscape, so this is transparent to them.
  const iframeReady = showIframe && (overlayDismissed || !isPortrait);

  // ------------------------------------------------------------------
  // Fullscreen helpers (disabled on iOS where the API is unsupported)
  // ------------------------------------------------------------------
  const enterFullscreen = useCallback(() => {
    if (isIOS) return; // Fullscreen API unsupported on iOS Safari
    const el = containerRef.current;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }, [isIOS]);

  const exitFullscreen = useCallback(() => {
    if (isIOS) return;
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }, [isIOS]);

  const toggleFullscreen = useCallback(() => {
    if (isIOS) return;
    if (isFullscreen) exitFullscreen();
    else enterFullscreen();
  }, [isIOS, isFullscreen, enterFullscreen, exitFullscreen]);

  // Track fullscreen state changes (escape key, etc.)
  useEffect(() => {
    if (isIOS) return; // No fullscreen events on iOS
    function onChange() {
      const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      setIsFullscreen(fs);
      if (!fs) setChromeVisible(true);
    }
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [isIOS, setChromeVisible]);

  // ------------------------------------------------------------------
  // Auto-hide chrome bar in desktop fullscreen only.
  //
  // Previously this also hid the bar on iOS to maximise vertical
  // space, but iframe touch events never bubble to the parent window
  // so the reveal-on-swipe mechanism was unreachable.  Keeping the
  // bar always visible on iOS is the safer UX.
  //
  // Touch zone expanded to 44px (Apple HIG minimum) and includes
  // touchstart for tap detection (touchmove alone misses quick taps).
  //
  // All listeners use { passive: true } so iOS Safari's compositor
  // thread is never blocked waiting for a potential preventDefault().
  // ------------------------------------------------------------------
  const shouldAutoHideChrome = isFullscreen;

  useEffect(() => {
    if (!shouldAutoHideChrome) {
      setChromeVisible(true);
      return;
    }
    setChromeVisible(false);

    const TOUCH_ZONE = 44; // px — Apple HIG minimum tap target

    function onInteraction(e) {
      const y = e.touches ? e.touches[0]?.clientY ?? 999 : e.clientY;
      if (y <= TOUCH_ZONE) {
        setChromeVisible(true);
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => setChromeVisible(false), 3000);
      }
    }

    window.addEventListener('mousemove', onInteraction, { passive: true });
    window.addEventListener('touchmove', onInteraction, { passive: true });
    window.addEventListener('touchstart', onInteraction, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onInteraction);
      window.removeEventListener('touchmove', onInteraction);
      window.removeEventListener('touchstart', onInteraction);
      clearTimeout(hideTimerRef.current);
    };
  }, [shouldAutoHideChrome, setChromeVisible]);

  // ------------------------------------------------------------------
  // Loading / error states
  // ------------------------------------------------------------------
  if (loading) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center z-50">
        <div className="w-10 h-10 border-4 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!game) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center z-50 text-center px-6">
        <div className="bg-gray-800 rounded-xl p-8 max-w-sm w-full">
          <h2 className="text-xl font-bold text-red-400 mb-2">Game Not Found</h2>
          <p className="text-gray-400 mb-4">
            Could not load game details for this ID.
          </p>
          <a
            href="/"
            className="inline-block px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
          >
            ← Back to Library
          </a>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black flex flex-col z-50 pb-[env(safe-area-inset-bottom)]"
    >
      {/* Chrome top bar — auto-hides on iOS, hide fullscreen button on iOS */}
      <PlayerChrome
        title={title}
        isFullscreen={isFullscreen || (isIOS && shouldAutoHideChrome)}
        visible={chromeVisible}
        volume={volume}
        onVolumeChange={setVolume}
        onToggleFullscreen={toggleFullscreen}
        showFullscreenButton={!isIOS}
      />

      {/* Dismissible landscape orientation hint for portrait mobile.
          Shown only until the user taps "Continue anyway".
          Uses Tailwind portrait:/landscape: variants.
          The wiggle keyframe is defined in index.css.
          Dismissal is persisted in sessionStorage so it never returns
          after an iOS memory-pressure page reload. */}
      {!overlayDismissed && (
        <div className="hidden portrait:flex landscape:!hidden fixed inset-0 z-[60] bg-gray-900/95 items-center justify-center text-center px-6">
          <div className="space-y-4">
            <svg
              className="w-12 h-12 text-gray-400 mx-auto animate-[wiggle_1.5s_ease-in-out_infinite]"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3"
              />
            </svg>
            <p className="text-gray-300 font-medium">
              Rotate your device for the best experience
            </p>
            <button
              onClick={dismissOverlay}
              className="mt-2 px-5 py-2.5 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-gray-200 text-sm font-medium rounded-lg transition-colors min-h-[44px]"
            >
              Continue in portrait
            </button>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 relative overflow-hidden">
        {iframeReady ? (
          <>
            <iframe
              src={`${game.webBuildPath}/index.html`}
              title={title}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
              allow="autoplay; fullscreen"
              className="absolute inset-0 w-full h-full border-0"
            />
            <SaveWarningToast />
          </>
        ) : showIframe ? (
          /* Game is built & ready but the portrait overlay is still blocking.
             Render a lightweight placeholder instead of the heavy WebGL iframe
             to avoid iOS Safari memory-pressure crashes. The overlay hides this
             from view anyway. */
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <div className="w-10 h-10 border-4 border-gray-600 border-t-blue-400 rounded-full animate-spin" />
          </div>
        ) : (
          <BuildProgress
            buildState={buildState}
            gameTitle={title}
            jobId={jobId}
            onBuild={triggerBuild}
            onCancel={cancelBuild}
            onRetry={retryBuild}
            onPlayAnyway={() => setForcePlay(true)}
            onMarkPlayable={markPlayable}
          />
        )}
      </div>
    </div>
  );
}
