import { useState } from 'react';
import { generateGradient, formatRating, getRatingColor, truncate } from '../../lib/utils';

/**
 * Netflix-style portrait poster card for the gallery.
 * Shows cover image in ~2:3 aspect ratio with hover effects.
 *
 * @param {{
 *   game: object,
 *   onClick: (game: object) => void,
 *   onPlay?: (game: object) => void,
 *   onFavorite?: (gameId: string) => void,
 *   size?: 'normal' | 'large',
 *   fluid?: boolean,
 * }} props
 */
export default function GalleryCard({ game, onClick, onPlay, onFavorite, size = 'normal', fluid = false }) {
  const [hovered, setHovered] = useState(false);
  const [imgError, setImgError] = useState(false);

  const title = game.vndbTitle || game.extractedTitle || 'Unknown';
  const coverUrl =
    game.coverPath && !imgError
      ? `/api/v1/covers/${game.id}?t=${encodeURIComponent(game.updatedAt || '')}`
      : null;
  const gradient = generateGradient(title);

  const widthClass = fluid ? 'w-full' : (size === 'large' ? 'w-72 sm:w-80' : 'w-56 sm:w-72');

  return (
    <div
      className={`gallery-card-hover relative ${fluid ? '' : 'flex-shrink-0'} ${widthClass} cursor-pointer select-none group`}
      onClick={() => onClick?.(game)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Card image — 4:3 landscape with blur-fill background */}
      <div className="relative aspect-[4/3] w-full rounded-md overflow-hidden shadow-lg shadow-black/40">
        {coverUrl ? (
          <>
            {/* Blurred background fill — prevents empty space for any aspect ratio */}
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-[0.35]"
            />
            {/* Actual uncropped image — always fully visible */}
            <img
              src={coverUrl}
              alt={title}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
              onError={() => setImgError(true)}
            />
          </>
        ) : (
          <div
            className="absolute inset-0"
            style={{ background: gradient }}
          >
            <div className="flex items-center justify-center h-full">
              <span className="text-5xl font-bold text-white/20 select-none">
                {title.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Favorite heart — top-left */}
        {onFavorite && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(game.id);
            }}
            className={`absolute top-2 left-2 z-10 w-7 h-7 flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
              game.favorite
                ? 'bg-red-500/40 text-red-400 hover:bg-red-500/60 hover:text-red-300 opacity-100'
                : 'bg-black/40 text-white/50 hover:bg-black/60 hover:text-red-400 opacity-70 group-hover:opacity-100'
            }`}
            title={game.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <svg className="w-4 h-4" fill={game.favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
            </svg>
          </button>
        )}

        {/* Rating badge — top-right */}
        {game.vndbRating != null && (
          <div
            className={`absolute top-2 right-2 px-2 py-0.5 rounded text-xs font-bold text-white shadow-md ${getRatingColor(game.vndbRating)}`}
          >
            {formatRating(game.vndbRating)}
          </div>
        )}

        {/* Hover overlay */}
        <div
          className={`absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent flex flex-col justify-end p-3 transition-opacity duration-200 ${
            hovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <h3 className="text-sm font-bold text-white leading-tight line-clamp-2 mb-1">
            {title}
          </h3>
          {game.developer && (
            <p className="text-xs text-gray-300 mb-1 truncate">{game.developer}</p>
          )}
          {game.synopsis && (
            <p className="text-xs text-gray-400 leading-relaxed line-clamp-3 mb-2">
              {truncate(game.synopsis, 120)}
            </p>
          )}
          {/* Play button on hover */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay?.(game);
            }}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-white text-black hover:bg-gray-200 transition-colors shadow-lg"
            aria-label={`Play ${title}`}
          >
            <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Title below poster (visible when not hovered) */}
      <div className={`mt-2 transition-opacity duration-200 ${hovered ? 'opacity-0' : 'opacity-100'}`}>
        <h3 className="text-xs font-medium text-gray-300 leading-tight line-clamp-2">
          {title}
        </h3>
      </div>
    </div>
  );
}
