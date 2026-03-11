/**
 * Fuzzy title matching using Dice coefficient (bigram overlap).
 *
 * No external dependencies — pure string comparison.
 */

/**
 * Normalize a title string for comparison.
 * Lowercases, strips punctuation, collapses whitespace.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation (Unicode-aware)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract character bigrams from a string.
 *
 * @param {string} str - Already-normalized string.
 * @returns {Map<string, number>} Bigram → count map.
 */
function bigrams(str) {
  const map = new Map();
  for (let i = 0; i < str.length - 1; i++) {
    const pair = str.slice(i, i + 2);
    map.set(pair, (map.get(pair) || 0) + 1);
  }
  return map;
}

/**
 * Dice coefficient between two strings.
 *
 *   dice(a, b) = 2 × |intersection of bigrams| / (|bigrams_a| + |bigrams_b|)
 *
 * @param {string} a - Normalized string.
 * @param {string} b - Normalized string.
 * @returns {number} 0–1 similarity score.
 */
function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);

  let intersection = 0;
  for (const [pair, countA] of bigramsA) {
    const countB = bigramsB.get(pair) || 0;
    intersection += Math.min(countA, countB);
  }

  const totalA = a.length - 1;
  const totalB = b.length - 1;

  return (2 * intersection) / (totalA + totalB);
}

/**
 * Compute a similarity score between two strings.
 *
 * - Exact normalized match → 1.0
 * - Substring bonus → +0.2 (capped at 1.0)
 * - Base → Dice coefficient
 *
 * @param {string} a - Raw string.
 * @param {string} b - Raw string.
 * @returns {number} 0–1 similarity score.
 */
function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);

  if (!na || !nb) return 0;
  if (na === nb) return 1;

  let score = diceCoefficient(na, nb);

  // Substring bonus
  if (na.includes(nb) || nb.includes(na)) {
    score = Math.min(1.0, score + 0.2);
  }

  return score;
}

/**
 * Find the best VNDB match for an extracted game title.
 *
 * Compares against each result's `title` and `alttitle`, picks the highest
 * scoring result above the threshold.
 *
 * @param {string} extractedTitle - Title extracted from the game directory.
 * @param {object[]} vndbResults  - Array of VNDB VN result objects.
 * @param {number}  threshold     - Minimum confidence to accept (0–1).
 * @returns {{ match: object, confidence: number } | null}
 */
export function matchTitle(extractedTitle, vndbResults, threshold = 0.7) {
  if (!extractedTitle || !vndbResults?.length) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const result of vndbResults) {
    // Score against English title
    const titleScore = similarity(extractedTitle, result.title || '');

    // Score against original/alt title
    const altScore = result.alttitle
      ? similarity(extractedTitle, result.alttitle)
      : 0;

    const score = Math.max(titleScore, altScore);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = result;
    }
  }

  if (bestScore >= threshold && bestMatch) {
    return { match: bestMatch, confidence: bestScore };
  }

  return null;
}
