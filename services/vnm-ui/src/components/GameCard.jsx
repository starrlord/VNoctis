import { useState } from 'react';
import { generateGradient, formatRating, getRatingColor, truncate } from '../lib/utils';

/**
 * Individual game card for the library grid.
 * Landscape layout with a 4:1 banner image on top and info section below.
 *
 * @param {{ game: object, onClick: (game: object) => void, onHide?: (game: object) => void }} props
 */
export default function GameCard({ game, onClick, onHide }) {
  const [hovered, setHovered] = useState(false);

  const title = game.vndbTitle || game.extractedTitle || 'Unknown';
  const coverUrl = game.coverPath
    ? `/api/v1/covers/${game.id}?t=${encodeURIComponent(game.updatedAt || '')}`
    : null;
  const gradient = generateGradient(title);

  return (
    <div
      className={`relative flex flex-col rounded-lg overflow-hidden shadow-lg dark:shadow-gray-900/50 cursor-pointer card-hover-scale transition-all duration-200 group ${
        game.hidden
          ? 'opacity-50 ring-2 ring-dashed ring-orange-400/50'
          : 'ring-1 ring-gray-200 dark:ring-gray-700/50'
      }`}
      onClick={() => onClick?.(game)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Image area — 4:1 aspect ratio */}
      <div className="relative aspect-video w-full bg-gray-900">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={title}
            loading="lazy"
            className="absolute inset-0 w-full h-full object-contain rounded-t-lg"
          />
        ) : (
          <div
            className="absolute inset-0 rounded-t-lg"
            style={{ background: gradient }}
          >
            {/* Centered title initial for no-cover cards */}
            <div className="flex items-center justify-center h-full">
              <span className="text-3xl font-bold text-white/30 select-none">
                {title.charAt(0).toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Rating badge — top-right of image area */}
        {game.vndbRating != null && (
          <div
            className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-bold text-white shadow ${getRatingColor(game.vndbRating)}`}
          >
            {formatRating(game.vndbRating)}
          </div>
        )}

        {/* Status overlays — top-left of image area */}
        <div className="absolute top-2 left-2 flex flex-col gap-1">
          {game.metadataSource === 'unmatched' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-orange-600 text-white shadow">
              Unmatched
            </span>
          )}
          {game.buildStatus === 'building' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-500 text-white shadow animate-pulse">
              Building…
            </span>
          )}
          {game.buildStatus === 'queued' && (
            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-yellow-500 text-gray-900 shadow">
              Queued
            </span>
          )}
          {game.buildStatus === 'built' && (
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-600/80 text-white shadow">
              {/* Checkmark icon */}
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </span>
          )}
          {game.buildStatus === 'failed' && (
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-red-600/80 text-white shadow">
              {/* X icon */}
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          )}
        </div>

        {/* Hide/Unhide button — bottom-right of image area, visible on hover */}
        {onHide && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onHide(game);
            }}
            className={`absolute bottom-2 right-2 w-7 h-7 flex items-center justify-center rounded-full backdrop-blur-sm transition-all duration-200 ${
              game.hidden
                ? 'bg-orange-500/30 text-orange-300 hover:bg-orange-500/50 hover:text-orange-200 opacity-100'
                : 'bg-black/40 text-white/70 hover:bg-black/60 hover:text-white opacity-0 group-hover:opacity-100'
            }`}
            title={game.hidden ? 'Unhide this game' : 'Hide this game'}
          >
            {game.hidden ? (
              /* Eye icon (unhide) */
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            ) : (
              /* Eye-slash icon (hide) */
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Info section below image */}
      <div className="px-3 py-2 bg-white dark:bg-gray-800">
        {game.hidden && (
          <span className="float-right ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-400">
            Hidden
          </span>
        )}
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white leading-tight line-clamp-2">
          {title}
        </h3>
        {game.developer && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{game.developer}</p>
        )}
      </div>

      {/* Hover overlay with synopsis */}
      {hovered && game.synopsis && (
        <div className="absolute inset-0 bg-black/80 flex flex-col justify-end p-4 rounded-lg transition-opacity duration-200">
          <h3 className="text-sm font-semibold text-white mb-2 line-clamp-2">
            {title}
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed line-clamp-4">
            {truncate(game.synopsis, 200)}
          </p>
        </div>
      )}
    </div>
  );
}
