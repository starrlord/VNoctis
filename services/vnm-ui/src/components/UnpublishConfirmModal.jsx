import { useState } from 'react';

/**
 * Confirmation + result modal for unpublishing a game from R2.
 * Mirrors the card layout of PublishProgressModal.
 *
 * @param {{
 *   game: object,
 *   onUnpublish: (gameId: string) => Promise<void>,
 *   onClose: () => void,
 * }} props
 */
export default function UnpublishConfirmModal({ game, onUnpublish, onClose }) {
  const [phase, setPhase] = useState('confirm'); // confirm | unpublishing | done | failed
  const [error, setError] = useState(null);

  const title = game.vndbTitle || game.extractedTitle || 'Unknown';
  const coverUrl = game.coverPath ? `/api/v1/covers/${game.id}` : null;

  const handleConfirm = async () => {
    setPhase('unpublishing');
    try {
      await onUnpublish(game.id);
      setPhase('done');
    } catch (err) {
      setError(err.message || 'Unpublish failed');
      setPhase('failed');
    }
  };

  const isDismissable = phase === 'done' || phase === 'failed';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && isDismissable) onClose(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl w-full max-w-sm p-6">
        {/* Header */}
        <div className="flex items-start gap-4 mb-5">
          {coverUrl ? (
            <img src={coverUrl} alt="" className="w-14 h-14 rounded object-cover flex-shrink-0" />
          ) : (
            <div className="w-14 h-14 rounded bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
              </svg>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-white text-sm leading-tight line-clamp-2">{title}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {phase === 'confirm'     && 'Remove from public gallery?'}
              {phase === 'unpublishing' && 'Removing from Cloudflare R2…'}
              {phase === 'done'        && 'Unpublished successfully'}
              {phase === 'failed'      && 'Unpublish failed'}
            </p>
          </div>
        </div>

        {/* Spinner */}
        {phase === 'unpublishing' && (
          <div className="flex justify-center py-4">
            <svg className="animate-spin h-7 w-7 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {/* Success */}
        {phase === 'done' && (
          <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <p className="text-xs text-green-700 dark:text-green-400">
              ✓ {title} has been removed from the public gallery and all files deleted from R2.
            </p>
          </div>
        )}

        {/* Error */}
        {phase === 'failed' && error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4">
          {phase === 'confirm' && (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
              >
                Unpublish
              </button>
            </>
          )}
          {isDismissable && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
