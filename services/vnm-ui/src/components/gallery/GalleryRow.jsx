import { useRef, useState, useEffect, useCallback } from 'react';
import GalleryCard from './GalleryCard';

/**
 * Maximum games to display in a single row before showing "View All".
 */
const MAX_ROW_ITEMS = 12;

/**
 * Horizontal scrolling category row (Netflix-style).
 * Shows a row title (clickable) and up to 12 game cards with a
 * "View All" card at the end when there are more.
 *
 * @param {{
 *   title: string,
 *   games: Array,
 *   onCardClick: (game: object) => void,
 *   onPlay: (game: object) => void,
 *   onFavorite?: (gameId: string) => void,
 *   onViewMore?: (title: string, games: Array) => void,
 * }} props
 */
export default function GalleryRow({ title, games, onCardClick, onPlay, onFavorite, onViewMore }) {
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScrollability = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    checkScrollability();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkScrollability, { passive: true });
    window.addEventListener('resize', checkScrollability);
    return () => {
      el.removeEventListener('scroll', checkScrollability);
      window.removeEventListener('resize', checkScrollability);
    };
  }, [checkScrollability, games]);

  const scroll = useCallback((direction) => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
  }, []);

  if (!games || games.length === 0) return null;

  const displayedGames = games.slice(0, MAX_ROW_ITEMS);
  const hasMore = games.length > MAX_ROW_ITEMS;

  return (
    <div className="mb-8 group/row">
      {/* Row title — clickable when onViewMore is available */}
      <h2 className="text-lg sm:text-xl font-bold text-white mb-3 px-6 sm:px-16 flex items-center gap-2">
        {onViewMore ? (
          <button
            onClick={() => onViewMore(title, games)}
            className="hover:text-gray-300 transition-colors flex items-center gap-2 group/title"
          >
            {title}
            <svg
              className="w-4 h-4 opacity-0 group-hover/title:opacity-100 transition-opacity text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        ) : (
          title
        )}
        <span className="text-sm font-normal text-gray-500">
          {games.length}
        </span>
      </h2>

      {/* Scrollable container — left padding is outside the scroll area so it never scrolls away */}
      <div className="relative pl-6 sm:pl-16">
        {/* Left scroll arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="gallery-scroll-arrow absolute left-0 top-0 bottom-8 z-10 w-10 sm:w-20 flex items-center justify-center bg-gradient-to-r from-[#111] via-[#111]/80 to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity duration-300 cursor-pointer"
            aria-label="Scroll left"
          >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </button>
        )}

        {/* Cards row — only right padding inside the scrollable area */}
        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto gallery-row-scroll pr-6 sm:pr-16 pb-2 scroll-smooth"
          style={{ scrollSnapType: 'x proximity' }}
        >
          {displayedGames.map((game) => (
            <div key={game.id} style={{ scrollSnapAlign: 'start' }}>
              <GalleryCard
                game={game}
                onClick={onCardClick}
                onPlay={onPlay}
                onFavorite={onFavorite}
              />
            </div>
          ))}

          {/* "View All" card — shown when there are more games than displayed */}
          {hasMore && onViewMore && (
            <div style={{ scrollSnapAlign: 'start' }}>
              <button
                onClick={() => onViewMore(title, games)}
                className="flex-shrink-0 w-56 sm:w-72 aspect-[4/3] rounded-md bg-gray-800/60 hover:bg-gray-700/80 border border-gray-700/50 hover:border-gray-600 flex flex-col items-center justify-center gap-3 transition-all duration-200 cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-full bg-gray-700 group-hover:bg-gray-600 flex items-center justify-center transition-colors">
                  <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
                <span className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">
                  View All {games.length}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Right scroll arrow */}
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="gallery-scroll-arrow absolute right-0 top-0 bottom-8 z-10 w-10 sm:w-14 flex items-center justify-center bg-gradient-to-l from-[#111] via-[#111]/80 to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity duration-300 cursor-pointer"
            aria-label="Scroll right"
          >
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
