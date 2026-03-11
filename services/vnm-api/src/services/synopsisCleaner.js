/**
 * VNDB description / bbcode cleaner.
 *
 * VNDB descriptions use a bbcode-like markup that needs to be
 * stripped before storing as plain text.
 */

/**
 * Clean a VNDB bbcode description into plain text.
 *
 * Transformations:
 *   [url=...]text[/url]       → text
 *   [spoiler]...[/spoiler]    → "" (removed entirely)
 *   [b]...[/b]                → text (bold stripped)
 *   [i]...[/i]                → text (italic stripped)
 *   [u]...[/u]                → text (underline stripped)
 *   [s]...[/s]                → text (strikethrough stripped)
 *   [code]...[/code]          → text
 *   [raw]...[/raw]            → text
 *   [quote]...[/quote]        → text
 *   Literal \n                → newline
 *   Excess whitespace         → trimmed
 *
 * @param {string|null|undefined} vndbDescription
 * @returns {string} Cleaned plain-text synopsis.
 */
export function cleanSynopsis(vndbDescription) {
  if (!vndbDescription) return '';

  let text = vndbDescription;

  // Remove spoiler blocks entirely (non-greedy, may be nested so loop)
  // Loop until no more spoiler tags remain
  let prev;
  do {
    prev = text;
    text = text.replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, '');
  } while (text !== prev);

  // [url=...]text[/url] → text
  text = text.replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1');

  // Strip simple paired tags: [b], [i], [u], [s], [code], [raw], [quote]
  const simpleTags = ['b', 'i', 'u', 's', 'code', 'raw', 'quote'];
  for (const tag of simpleTags) {
    const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'gi');
    text = text.replace(re, '$1');
  }

  // Convert literal \n to actual newlines (VNDB sometimes sends these)
  text = text.replace(/\\n/g, '\n');

  // Collapse multiple blank lines into at most two newlines
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  text = text.trim();

  return text;
}
