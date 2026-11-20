// Masks credential-shaped strings before text is stored. Ported from AIHistoryKit's
// SecretRedactor, but applied on write, so nothing secret reaches the database.

const TOKENS = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-[A-Za-z0-9_\-]{16,}/g];

// Keeps the scheme word so a reader still sees an auth header was there.
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=\-]+/gi;

// The digit and letter lookaheads spare long plain numbers and runs like "aaaa…".
const HEX_BLOB = /(?<![0-9A-Fa-f])(?=[0-9A-Fa-f]*[0-9])(?=[0-9A-Fa-f]*[A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g;

const BASE64_BLOB =
  /(?<![A-Za-z0-9+/=_\-])(?=[A-Za-z0-9+/=_\-]*[0-9])(?=[A-Za-z0-9+/=_\-]*[A-Za-z])[A-Za-z0-9+/=_\-]{40,}(?![A-Za-z0-9+/=_\-])/g;

// Path components are short; base64 segments between slashes are long.
const PATH_SEGMENT_LIMIT = 24;

export function redact(text: string): string {
  let result = text.replace(BEARER, "Bearer [redacted]");
  for (const pattern of TOKENS) result = result.replace(pattern, "[redacted]");
  result = result.replace(HEX_BLOB, "[redacted]");
  return result.replace(BASE64_BLOB, (candidate) => {
    const looksLikePath =
      candidate.includes("/") && candidate.split("/").every((segment) => segment.length < PATH_SEGMENT_LIMIT);
    return looksLikePath ? candidate : "[redacted]";
  });
}

/** First non-empty line, capped; the placeholder summary for a prompt. */
export function firstLine(text: string, limit = 200): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}
