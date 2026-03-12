import { useState, useEffect, useRef, useCallback } from 'react';
import { generateGradient, formatRating, getRatingColor, truncate } from '../../lib/utils';

/**
 * Auto-rotation interval in ms.
 */
const ROTATE_INTERVAL = 15000;

/**
 * Full-width hero banner that auto-rotates through featured games.
 * Uses crossfade transitions and does NOT reset scroll position.
 *
 * @param {{
 *   games: Array,
 *   onMoreInfo: (game: object) => void,
 *   onPlay: (game: object) => void,
 * }} props
 */
export default function GalleryHero({ games, onMoreInfo, onPlay }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [fadeState, setFadeState] = useState('visible'); // 'visible' | 'fading-out' | 'fading-in'
  const timerRef = useRef(null);
  const pendingIndexRef = useRef(null);

  const startTimer = useCallback(() => {
    clearInterval(timerRef.current);
    if (!games || games.length <= 1) return;
    timerRef.current = setInterval(() => {
      // Start fade out
      setFadeState('fading-out');
      pendingIndexRef.current = null;
    }, ROTATE_INTERVAL);
  }, [games]);

  // Start rotation timer on mount / games change
  useEffect(() => {
    startTimer();
    return () => clearInterval(timerRef.current);
  }, [startTimer]);

  // Handle fade-out completion → switch game → fade in
  useEffect(() => {
    if (fadeState === 'fading-out') {
      const timeout = setTimeout(() => {
        setActiveIndex((prev) => {
          const next = pendingIndexRef.current ?? (prev + 1) % games.length;
          pendingIndexRef.current = null;
          return next;
        });
        setFadeState('fading-in');
      }, 500); // match CSS transition duration
      return () => clearTimeout(timeout);
    }
    if (fadeState === 'fading-in') {
      // Small delay to ensure the DOM has the new content before fading in
      const raf = requestAnimationFrame(() => {
        setFadeState('visible');
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [fadeState, games]);

  if (!games || games.length === 0) return null;

  const game = games[activeIndex] || games[0];
  const title = game.vndbTitle || game.extractedTitle || 'Unknown';
  const coverUrl = game.coverPath
    ? `/api/v1/covers/${game.id}?t=${encodeURIComponent(game.updatedAt || '')}`
    : null;
  const gradient = generateGradient(title);

  const opacityClass =
    fadeState === 'fading-out'
      ? 'opacity-0'
      : fadeState === 'fading-in'
        ? 'opacity-0'
        : 'opacity-100';

  const handleDotClick = (index) => {
    if (index === activeIndex) return;
    pendingIndexRef.current = index;
    setFadeState('fading-out');
    startTimer(); // Reset timer on manual interaction
  };

  return (
    <div className="relative w-full h-[70vh] min-h-[400px] max-h-[700px] mb-4 overflow-hidden">
      {/* Background image — crossfade via opacity */}
      <div className={`absolute inset-0 transition-opacity duration-500 ease-in-out ${opacityClass}`}>
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover object-top"
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{ background: gradient }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Gradient overlays (always visible) */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#111]/90 via-[#111]/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#111] via-transparent to-[#111]/30" />

      {/* Content — crossfade with image */}
      <div
        className={`absolute inset-0 flex flex-col justify-end px-4 sm:px-12 pb-16 sm:pb-20 max-w-3xl transition-opacity duration-500 ease-in-out ${opacityClass}`}
      >
        {/* Rating badge */}
        {game.vndbRating != null && (
          <div className="mb-3">
            <span
              className={`inline-block px-3 py-1 rounded text-sm font-bold text-white ${getRatingColor(game.vndbRating)}`}
            >
              ★ {formatRating(game.vndbRating)}
            </span>
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-5xl font-extrabold text-white leading-tight mb-3 drop-shadow-lg">
          {title}
        </h1>

        {/* Developer + meta */}
        <div className="flex items-center gap-3 mb-3 text-sm text-gray-300">
          {game.developer && (
            <span className="font-medium">{game.developer}</span>
          )}
          {game.developer && game.releaseDate && (
            <span className="text-gray-500">•</span>
          )}
          {game.releaseDate && (
            <span>{new Date(game.releaseDate).getFullYear()}</span>
          )}
        </div>

        {/* Synopsis */}
        {game.synopsis && (
          <p className="text-sm sm:text-base text-gray-300 leading-relaxed mb-6 line-clamp-3 drop-shadow">
            {truncate(game.synopsis, 300)}
          </p>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onPlay?.(game)}
            className="flex items-center gap-2 px-6 py-3 bg-white hover:bg-gray-200 text-black font-bold rounded-md text-sm sm:text-base transition-colors shadow-lg"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play
          </button>
          <button
            onClick={() => onMoreInfo?.(game)}
            className="flex items-center gap-2 px-6 py-3 bg-gray-600/70 hover:bg-gray-600 text-white font-semibold rounded-md text-sm sm:text-base transition-colors backdrop-blur-sm"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
            </svg>
            More Info
          </button>
        </div>
      </div>

      {/* Rotation indicator dots */}
      {games.length > 1 && (
        <div className="absolute bottom-6 right-4 sm:right-12 flex items-center gap-2">
          {games.map((_, i) => (
            <button
              key={i}
              onClick={() => handleDotClick(i)}
              className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                i === activeIndex
                  ? 'bg-white scale-125'
                  : 'bg-white/40 hover:bg-white/70'
              }`}
              aria-label={`Show featured game ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
