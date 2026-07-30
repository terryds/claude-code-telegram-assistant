/**
 * Fetch a page's title and favicon for the dashboard's Bookmarks section.
 *
 * Everything is fetched server-side (browser fetches would hit CORS), and the
 * favicon is inlined as a data: URI so icons keep rendering even when the
 * bookmarked app is down. This is a single-user, self-hosted tool whose whole
 * point includes bookmarking other apps on this same host, so there is
 * deliberately no SSRF/private-address filtering here.
 */

const PAGE_TIMEOUT_MS = 6000;
const ICON_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 300 * 1024;

// Some sites reject requests without a browser-ish UA.
const UA =
  'Mozilla/5.0 (compatible; coding-agent-telegram-relay/1.0; +bookmark-preview)';

export type PageMeta = {
  /** URL after scheme resolution + redirects — what we store. */
  url: string;
  title: string | null;
  favicon: string | null; // data: URI
};

/**
 * Resolve user input into a fetchable absolute URL. Input without a scheme
 * gets https:// tried first, then http:// (local dev apps on bare ports are
 * usually plain http). Returns the meta from whichever variant responded; if
 * neither responds, still returns a normalized URL (best guess) with null
 * title/favicon so the bookmark can be created for a not-yet-running app.
 */
export async function fetchBookmarkMeta(input: string): Promise<PageMeta> {
  const raw = input.trim();
  const candidates: string[] = [];
  if (/^https?:\/\//i.test(raw)) {
    candidates.push(raw);
  } else {
    const stripped = raw.replace(/^\/+/, '');
    candidates.push(`https://${stripped}`, `http://${stripped}`);
  }

  for (const candidate of candidates) {
    const meta = await fetchMetaFromUrl(candidate);
    if (meta) return meta;
  }

  // Nothing responded — keep the bookmark anyway. Guess http for host:port
  // inputs (dev servers), https otherwise.
  const fallback = /^https?:\/\//i.test(raw)
    ? raw
    : `${/:\d+/.test(raw) ? 'http' : 'https'}://${raw.replace(/^\/+/, '')}`;
  return { url: fallback, title: null, favicon: null };
}

/** Fetch one concrete URL; null if it doesn't respond at all. */
async function fetchMetaFromUrl(url: string): Promise<PageMeta | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
    });
  } catch {
    return null;
  }

  const finalUrl = res.url || url;
  let html = '';
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (/text\/html|application\/xhtml/.test(ct) || ct === '') {
      html = await readCapped(res, MAX_HTML_BYTES);
    } else {
      await res.body?.cancel();
    }
  } catch {
    // Body read failed — the server responded, so still make the bookmark.
  }

  const title = extractTitle(html);
  const favicon = await fetchFavicon(html, finalUrl);
  return { url: finalUrl, title, favicon };
}

async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.byteLength, total - off)), off);
    off += c.byteLength;
    if (off >= total) break;
  }
  return out;
}

function extractTitle(html: string): string | null {
  if (!html) return null;
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (t) {
    const decoded = decodeEntities(t).replace(/\s+/g, ' ').trim();
    if (decoded) return decoded.slice(0, 200);
  }
  const og =
    html.match(
      /<meta[^>]+property=["']og:(?:site_name|title)["'][^>]+content=["']([^"']+)["']/i
    )?.[1] ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:(?:site_name|title)["']/i
    )?.[1];
  if (og) {
    const decoded = decodeEntities(og).replace(/\s+/g, ' ').trim();
    if (decoded) return decoded.slice(0, 200);
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Find the best favicon candidate in the HTML (or /favicon.ico) and inline it. */
async function fetchFavicon(html: string, pageUrl: string): Promise<string | null> {
  const candidates: string[] = [];

  if (html) {
    // Collect <link> tags whose rel mentions "icon", in document order.
    const links = html.match(/<link\b[^>]*>/gi) ?? [];
    const iconLinks: { href: string; rel: string }[] = [];
    for (const tag of links) {
      const rel = tag.match(/\brel=["']?([^"'>]+)["']?/i)?.[1]?.toLowerCase() ?? '';
      if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
      const href = tag.match(/\bhref=["']?([^"'\s>]+)["']?/i)?.[1];
      if (href) iconLinks.push({ href: decodeEntities(href), rel });
    }
    // Prefer plain "icon" rels over apple-touch-icon (usually smaller files).
    iconLinks.sort((a, b) => Number(b.rel.includes('apple')) - Number(a.rel.includes('apple')));
    for (const l of iconLinks) {
      try {
        candidates.push(new URL(l.href, pageUrl).href);
      } catch {
        // unresolvable href — skip
      }
    }
  }

  try {
    candidates.push(new URL('/favicon.ico', pageUrl).href);
  } catch {
    // pageUrl itself unparseable
  }

  for (const iconUrl of dedupe(candidates)) {
    const dataUri = await fetchIconAsDataUri(iconUrl);
    if (dataUri) return dataUri;
  }
  return null;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

async function fetchIconAsDataUri(iconUrl: string): Promise<string | null> {
  // data: favicons (some dev tools inline them) can be stored as-is.
  if (iconUrl.startsWith('data:image/')) {
    return iconUrl.length <= MAX_ICON_BYTES * 1.4 ? iconUrl : null;
  }
  try {
    const res = await fetch(iconUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_ICON_BYTES) return null;

    let mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mime || mime === 'application/octet-stream' || mime === 'text/plain') {
      mime = sniffImageMime(buf, iconUrl) ?? '';
    }
    // Reject non-images (e.g. an SPA returning index.html for /favicon.ico).
    if (!mime.startsWith('image/')) return null;

    return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch {
    return null;
  }
}

function sniffImageMime(buf: Uint8Array, url: string): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00)
    return 'image/x-icon';
  if (
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return 'image/webp';
  const head = new TextDecoder().decode(buf.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml';
  if (/\.ico(\?|$)/i.test(url)) return 'image/x-icon';
  return null;
}
