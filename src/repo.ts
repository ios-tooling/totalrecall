// A repository's identity, derived from nothing but its URL, so one repo reached
// by HTTPS on one machine and SSH on another lands in a single project.
// Ported from AIHistoryKit's RepoIdentity.

const LOCAL_PREFIXES = ["local://", "local:", "file://"];

function localFolderName(raw: string): string | null {
  const prefix = LOCAL_PREFIXES.find((p) => raw.startsWith(p));
  const path = prefix ? raw.slice(prefix.length) : raw;
  if (!prefix && !path.startsWith("/") && !path.startsWith("~")) return null;
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return name ? name : null;
}

/** `https://host/owner/repo` for a remote; `local:Name` for a checkout with no remote. Idempotent. */
export function canonicalURL(raw: string): string {
  const trimmed = raw.trim();
  const folder = localFolderName(trimmed);
  if (folder) return `local:${folder}`;

  let cleaned = trimmed;
  const scheme = cleaned.indexOf("://");
  if (scheme >= 0) cleaned = cleaned.slice(scheme + 3);
  const at = cleaned.indexOf("@");
  if (at >= 0 && !cleaned.slice(0, at).includes("/")) cleaned = cleaned.slice(at + 1);
  cleaned = cleaned.replaceAll(":", "/").replace(/\/+$/, "");
  if (cleaned.toLowerCase().endsWith(".git")) cleaned = cleaned.slice(0, -4);

  const host = cleaned.split("/")[0] ?? "";
  return host.includes(".") ? `https://${cleaned}` : cleaned;
}

function withoutScheme(url: string): string {
  const scheme = url.indexOf("://");
  return scheme >= 0 ? url.slice(scheme + 3) : url;
}

function sanitized(value: string): string {
  return value.replaceAll("/", "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
}

/** The key to group and compare repos by, e.g. `bengottlieb_devcenter`. Case-insensitive. */
export function identityKey(raw: string): string {
  const canonical = canonicalURL(raw);
  if (canonical.startsWith("local:")) return sanitized("local_" + canonical.slice(6)).toLowerCase();
  let name = withoutScheme(canonical);
  if (name.toLowerCase().startsWith("github.com/")) name = name.slice("github.com/".length);
  return sanitized(name).toLowerCase();
}

/** Human-facing repository name, without its host or owner. */
export function displayName(raw: string): string {
  const canonical = canonicalURL(raw);
  if (canonical.startsWith("local:")) return canonical.slice(6);
  const segments = withoutScheme(canonical).split("/").filter(Boolean);
  return segments.pop() ?? canonical;
}

/** `owner/name` for a hosted repo; null for a local checkout or an unusual path. */
export function repoSlug(raw: string): string | null {
  const canonical = canonicalURL(raw);
  if (canonical.startsWith("local:")) return null;
  const segments = withoutScheme(canonical).split("/").slice(1);
  return segments.length === 2 && segments.every(Boolean) ? segments.join("/") : null;
}
