/**
 * XSS-safe search-match highlighting (no dangerouslySetInnerHTML).
 *
 * The notes search API returns snippets with the matched span wrapped in literal
 * `<mark>…</mark>` tags (see makeSnippet in the notes-v2 route). Instead of
 * injecting that string as HTML, we split on the mark tags and render REAL React
 * <mark> elements for matched groups and plain text nodes otherwise — everything
 * else in the snippet stays inert text, so a note containing `<img onerror=…>`
 * can never execute in a result row.
 */

const MARK_SPLIT_RE = /(<mark>[\s\S]*?<\/mark>)/g;
const MARK_CAPTURE_RE = /^<mark>([\s\S]*?)<\/mark>$/;

/** Render a string containing literal <mark> spans as text + real <mark> elements. */
export function HighlightedText({ text }: { text: string }) {
  if (!text) return null;
  if (!text.includes('<mark>')) return <>{text}</>;
  return (
    <>
      {text.split(MARK_SPLIT_RE).map((part, i) => {
        const m = MARK_CAPTURE_RE.exec(part);
        if (m) return <mark key={i} className="notes-search-mark">{m[1]}</mark>;
        return part ? <span key={i}>{part}</span> : null;
      })}
    </>
  );
}

/**
 * Client-side title highlight: the server highlights snippets but NOT titles, so
 * result titles wrap the first case-insensitive occurrence of the query in a
 * <mark> here. Skipped for very short queries (< 2 chars) — single-letter
 * highlights read as noise.
 */
export function HighlightedTitle({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!text || q.length < 2) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="notes-search-mark">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}
