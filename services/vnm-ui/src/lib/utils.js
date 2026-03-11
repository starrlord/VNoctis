/**
 * Generates a deterministic CSS gradient from a title string for placeholder covers.
 * Uses a simple hash to derive hue values so each title gets a unique gradient.
 * @param {string} title
 * @returns {string} CSS linear-gradient value
 */
export function generateGradient(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = title.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Convert to 32-bit integer
  }
  const hue1 = Math.abs(hash % 360);
  const hue2 = (hue1 + 40 + Math.abs((hash >> 8) % 60)) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 50%, 30%) 0%, hsl(${hue2}, 60%, 20%) 100%)`;
}

/**
 * Formats a numeric rating to 1 decimal place.
 * @param {number|null} rating
 * @returns {string}
 */
export function formatRating(rating) {
  if (rating == null) return '';
  return Number(rating).toFixed(1);
}

/**
 * Formats an ISO date string to a readable format (e.g., "Jan 15, 2024").
 * @param {string|null} dateString
 * @returns {string}
 */
export function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Truncates text to a maximum length, adding an ellipsis if truncated.
 * @param {string|null} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

/**
 * Returns a Tailwind color class for the given build status.
 * @param {string} status
 * @returns {string}
 */
export function getBuildStatusColor(status) {
  switch (status) {
    case 'built':
      return 'text-green-500';
    case 'building':
      return 'text-blue-400';
    case 'queued':
      return 'text-yellow-500';
    case 'failed':
      return 'text-red-500';
    case 'stale':
      return 'text-orange-400';
    default:
      return 'text-gray-400';
  }
}

/**
 * Returns a Tailwind background color class based on the rating value.
 * Green for ≥7, yellow for ≥5, red for <5.
 * @param {number} rating
 * @returns {string}
 */
export function getRatingColor(rating) {
  if (rating >= 7) return 'bg-green-600';
  if (rating >= 5) return 'bg-yellow-600';
  return 'bg-red-600';
}

/**
 * Formats a duration in minutes to a human-readable string (e.g., "~2h", "~30h").
 * @param {number|null} minutes
 * @returns {string}
 */
export function formatLength(minutes) {
  if (minutes == null || minutes <= 0) return '';
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `~${hours}h`;
}

/**
 * Returns a label and color class for build status.
 * @param {string} status
 * @returns {{ label: string, colorClass: string }}
 */
export function getBuildStatusBadge(status) {
  switch (status) {
    case 'built':
      return { label: 'Built ✅', colorClass: 'bg-green-700 text-green-100' };
    case 'building':
      return { label: 'Building 🔄', colorClass: 'bg-blue-700 text-blue-100' };
    case 'queued':
      return { label: 'Queued', colorClass: 'bg-yellow-700 text-yellow-100' };
    case 'failed':
      return { label: 'Failed ❌', colorClass: 'bg-red-700 text-red-100' };
    case 'stale':
      return { label: 'Stale', colorClass: 'bg-orange-700 text-orange-100' };
    default:
      return { label: 'Not Built', colorClass: 'bg-gray-700 text-gray-300' };
  }
}

/**
 * Returns a label for the metadata source.
 * @param {string} source
 * @returns {{ label: string, colorClass: string }}
 */
export function getMetadataSourceBadge(source) {
  switch (source) {
    case 'vndb':
      return { label: 'VNDB', colorClass: 'bg-indigo-700 text-indigo-100' };
    case 'manual':
      return { label: 'Manual', colorClass: 'bg-teal-700 text-teal-100' };
    case 'unmatched':
      return { label: 'Unmatched', colorClass: 'bg-orange-700 text-orange-100' };
    default:
      return { label: source || 'Unknown', colorClass: 'bg-gray-700 text-gray-300' };
  }
}
