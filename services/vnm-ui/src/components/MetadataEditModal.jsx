import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../hooks/useApi';

/** Minimum characters before triggering VNDB autocomplete search */
const AUTOCOMPLETE_MIN_CHARS = 4;

/** Debounce delay in ms for autocomplete requests */
const AUTOCOMPLETE_DEBOUNCE_MS = 400;

/**
 * Modal form for manually editing game metadata.
 * Pre-populates fields from current game data and saves via PATCH /api/v1/library/:gameId.
 *
 * @param {{ game: object, onClose: () => void, onSaved: () => void }} props
 */
export default function MetadataEditModal({ game, onClose, onSaved }) {
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  // Form state — pre-populated with current values
  const [form, setForm] = useState({
    vndbTitle: game.vndbTitle || '',
    vndbTitleOriginal: game.vndbTitleOriginal || '',
    developer: game.developer || '',
    releaseDate: game.releaseDate ? game.releaseDate.slice(0, 10) : '',
    synopsis: game.synopsis || '',
    vndbId: game.vndbId || '',
    lengthMinutes: game.lengthMinutes ?? '',
    coverUrl: '',
  });

  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState(null);
  const [linkError, setLinkError] = useState(null);
  const [linkSuccess, setLinkSuccess] = useState(false);

  // ── VNDB autocomplete state ───────────────────────────
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const debounceRef = useRef(null);
  const dropdownRef = useRef(null);
  const vndbInputRef = useRef(null);

  // Track which fields differ from original to highlight overrides
  const isOverridden = useCallback(
    (field) => {
      const original = game[field];
      const current = form[field];
      if (field === 'releaseDate') {
        const origDate = original ? original.slice(0, 10) : '';
        return current !== origDate;
      }
      if (field === 'lengthMinutes') {
        return String(current) !== String(original ?? '');
      }
      return current !== (original || '');
    },
    [form, game]
  );

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Focus trap & Escape key
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    modalRef.current?.focus();

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target) &&
        vndbInputRef.current &&
        !vndbInputRef.current.contains(e.target)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Field change handler
  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError(null);
  };

  // VNDB ID input handler — supports autocomplete when text doesn't look like a VNDB ID
  const handleVndbIdChange = (e) => {
    const value = e.target.value;
    setForm((prev) => ({ ...prev, vndbId: value }));
    setError(null);
    setLinkError(null);
    setLinkSuccess(false);

    // Clear any pending debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // If the value looks like a VNDB ID (v + digits) or is too short, hide dropdown
    if (/^v\d*$/.test(value) || value.length < AUTOCOMPLETE_MIN_CHARS) {
      setShowDropdown(false);
      setSearchResults([]);
      setHighlightIdx(-1);
      return;
    }

    // Debounced search for title-like input
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await api.get(
          `/metadata/vndb/search?q=${encodeURIComponent(value)}`
        );
        setSearchResults(results);
        setShowDropdown(results.length > 0);
        setHighlightIdx(-1);
      } catch {
        setSearchResults([]);
        setShowDropdown(false);
      } finally {
        setSearching(false);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  };

  // Select a VN from the autocomplete dropdown
  const handleSelectVn = (vn) => {
    setForm((prev) => ({ ...prev, vndbId: vn.id }));
    setShowDropdown(false);
    setSearchResults([]);
    setHighlightIdx(-1);
    setLinkError(null);
    setLinkSuccess(false);
  };

  // Keyboard navigation for autocomplete dropdown
  const handleVndbKeyDown = (e) => {
    if (!showDropdown || searchResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        prev < searchResults.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) =>
        prev > 0 ? prev - 1 : searchResults.length - 1
      );
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      handleSelectVn(searchResults[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // Don't close the modal, just the dropdown
      setShowDropdown(false);
      setHighlightIdx(-1);
    }
  };

  // Validate VNDB ID format
  const isValidVndbId = (id) => {
    if (!id) return true; // empty is OK
    return /^v\d+$/.test(id);
  };

  // Link to VNDB — calls POST /api/v1/metadata/:gameId/refresh with vndbId
  const handleLinkVndb = async () => {
    if (!form.vndbId) return;
    if (!isValidVndbId(form.vndbId)) {
      setLinkError('VNDB ID must be in format "v" + digits (e.g., v12345)');
      return;
    }

    setLinking(true);
    setLinkError(null);
    setLinkSuccess(false);

    try {
      await api.post(`/metadata/${game.id}/refresh`, { vndbId: form.vndbId });
      // Re-fetch game data to get updated fields
      const updated = await api.get(`/library/${game.id}`);
      // Update form with refreshed data
      setForm({
        vndbTitle: updated.vndbTitle || '',
        vndbTitleOriginal: updated.vndbTitleOriginal || '',
        developer: updated.developer || '',
        releaseDate: updated.releaseDate ? updated.releaseDate.slice(0, 10) : '',
        synopsis: updated.synopsis || '',
        vndbId: updated.vndbId || form.vndbId,
        lengthMinutes: updated.lengthMinutes ?? '',
        coverUrl: '',
      });
      setLinkSuccess(true);
    } catch (err) {
      setLinkError(err.message || 'Failed to link VNDB data');
    } finally {
      setLinking(false);
    }
  };

  // Save — calls PATCH /api/v1/library/:gameId
  const handleSave = async () => {
    // Validate VNDB ID if provided
    if (form.vndbId && !isValidVndbId(form.vndbId)) {
      setError('VNDB ID must be in format "v" + digits (e.g., v12345)');
      return;
    }

    setSaving(true);
    setError(null);

    // Build payload with only changed fields
    const payload = {};
    if (form.vndbTitle !== (game.vndbTitle || '')) payload.vndbTitle = form.vndbTitle || null;
    if (form.vndbTitleOriginal !== (game.vndbTitleOriginal || ''))
      payload.vndbTitleOriginal = form.vndbTitleOriginal || null;
    if (form.developer !== (game.developer || '')) payload.developer = form.developer || null;
    if (form.synopsis !== (game.synopsis || '')) payload.synopsis = form.synopsis || null;
    if (form.vndbId !== (game.vndbId || '')) payload.vndbId = form.vndbId || null;

    const origDate = game.releaseDate ? game.releaseDate.slice(0, 10) : '';
    if (form.releaseDate !== origDate) {
      payload.releaseDate = form.releaseDate ? new Date(form.releaseDate).toISOString() : null;
    }

    const origLen = game.lengthMinutes ?? '';
    if (String(form.lengthMinutes) !== String(origLen)) {
      payload.lengthMinutes = form.lengthMinutes ? parseInt(form.lengthMinutes, 10) : null;
    }

    if (form.coverUrl) {
      payload.coverPath = form.coverUrl;
    }

    try {
      await api.patch(`/library/${game.id}`, payload);
      onSaved();
    } catch (err) {
      setError(err.message || 'Failed to save metadata');
    } finally {
      setSaving(false);
    }
  };

  const labelClass = (field) =>
    `block text-sm mb-1 transition-colors ${
      isOverridden(field)
        ? 'font-bold text-blue-400 dark:text-blue-400'
        : 'font-medium text-gray-700 dark:text-gray-400'
    }`;

  const inputClass =
    'w-full px-3 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Edit Metadata"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">✏️ Edit Metadata</h2>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-800/80 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-600 dark:text-white text-lg transition-colors"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className={labelClass('vndbTitle')}>Title</label>
            <input
              type="text"
              value={form.vndbTitle}
              onChange={handleChange('vndbTitle')}
              placeholder="Game title"
              className={inputClass}
            />
          </div>

          {/* Original Title */}
          <div>
            <label className={labelClass('vndbTitleOriginal')}>Original Title</label>
            <input
              type="text"
              value={form.vndbTitleOriginal}
              onChange={handleChange('vndbTitleOriginal')}
              placeholder="原題 (original language title)"
              className={inputClass}
            />
          </div>

          {/* Developer + Release Date row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass('developer')}>Developer</label>
              <input
                type="text"
                value={form.developer}
                onChange={handleChange('developer')}
                placeholder="Studio / developer name"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass('releaseDate')}>Release Date</label>
              <input
                type="date"
                value={form.releaseDate}
                onChange={handleChange('releaseDate')}
                className={inputClass}
              />
            </div>
          </div>

          {/* Synopsis */}
          <div>
            <label className={labelClass('synopsis')}>Synopsis</label>
            <textarea
              rows={4}
              value={form.synopsis}
              onChange={handleChange('synopsis')}
              placeholder="Game description / synopsis"
              className={inputClass + ' resize-y'}
            />
          </div>

          {/* VNDB ID + Link button + autocomplete */}
          <div>
            <label className={labelClass('vndbId')}>VNDB ID</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  ref={vndbInputRef}
                  type="text"
                  value={form.vndbId}
                  onChange={handleVndbIdChange}
                  onKeyDown={handleVndbKeyDown}
                  placeholder="v12345 or type a title to search…"
                  className={inputClass}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={showDropdown}
                  aria-autocomplete="list"
                  aria-controls="vndb-autocomplete-list"
                />

                {/* Searching spinner */}
                {searching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <svg
                      className="animate-spin h-4 w-4 text-gray-400"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  </div>
                )}

                {/* Autocomplete dropdown */}
                {showDropdown && searchResults.length > 0 && (
                  <ul
                    ref={dropdownRef}
                    id="vndb-autocomplete-list"
                    role="listbox"
                    className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
                  >
                    {searchResults.map((vn, idx) => (
                      <li
                        key={vn.id}
                        role="option"
                        aria-selected={idx === highlightIdx}
                        className={`px-3 py-2 cursor-pointer text-sm transition-colors ${
                          idx === highlightIdx
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-900 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault(); // Keep focus on input
                          handleSelectVn(vn);
                        }}
                        onMouseEnter={() => setHighlightIdx(idx)}
                      >
                        <div className="font-medium">
                          {vn.title}
                          {vn.alttitle && (
                            <span className={`ml-2 text-xs ${idx === highlightIdx ? 'text-blue-200' : 'text-gray-400'}`}>
                              {vn.alttitle}
                            </span>
                          )}
                        </div>
                        <div className={`text-xs mt-0.5 ${idx === highlightIdx ? 'text-blue-200' : 'text-gray-500 dark:text-gray-400'}`}>
                          <span className="font-mono">{vn.id}</span>
                          {vn.developer && <span> · {vn.developer}</span>}
                          {vn.released && <span> · {vn.released}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                onClick={handleLinkVndb}
                disabled={linking || !form.vndbId}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:text-indigo-400 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
              >
                {linking ? '🔄 Linking…' : '🔗 Link to VNDB'}
              </button>
            </div>
            {linkError && (
              <p className="text-xs text-red-400 mt-1">{linkError}</p>
            )}
            {linkSuccess && (
              <p className="text-xs text-green-400 mt-1">✅ VNDB data imported successfully</p>
            )}
          </div>

          {/* Length in minutes */}
          <div>
            <label className={labelClass('lengthMinutes')}>Length (minutes)</label>
            <input
              type="number"
              min="0"
              value={form.lengthMinutes}
              onChange={handleChange('lengthMinutes')}
              placeholder="Estimated play time in minutes"
              className={inputClass}
            />
          </div>

          {/* Cover Image URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-400 mb-1">
              Cover Image URL
            </label>
            <input
              type="text"
              value={form.coverUrl}
              onChange={handleChange('coverUrl')}
              placeholder="https://example.com/cover.jpg"
              className={inputClass}
            />
            <p className="text-xs text-gray-500 mt-1">
              Paste a direct image URL to use as cover art
            </p>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="px-6 pb-2">
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800/30 rounded-lg px-3 py-2">
              ⚠️ {error}
            </p>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-medium rounded-lg transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-blue-400 text-white font-semibold rounded-lg transition-colors text-sm flex items-center gap-2"
          >
            {saving && (
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
