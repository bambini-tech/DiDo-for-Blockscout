/**
 * The token's own colours, read from its logo, for DiDo's background
 * (GET /api/token-tint?u=<logo url>).
 *
 * The logo is shrunk to 32x32 and its clearly coloured pixels (not
 * transparent, not grey, not near black or white) are binned by hue. The
 * strongest hue, and a second one if it is distinct and carries real weight,
 * come back as hex. A logo without a clear colour returns no colours, and the
 * page keeps its plain light.
 *
 * Only logos on known image hosts are fetched (the server never follows a
 * URL anywhere else), with a size cap and a timeout.
 */
import sharp from 'sharp';
import { TtlCache } from './cache.js';

const HOSTS = new Set(['cdn.dexscreener.com', 'dd.dexscreener.com', 'assets.coingecko.com', 'coin-images.coingecko.com']);
const MAX_BYTES = 3 * 1024 * 1024;
const cache = new TtlCache<string[]>(24 * 3600_000, 2_000);

export function allowedLogo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function tintOf(url: string, fetchFn: typeof fetch = fetch): Promise<{ colors: string[] } | null> {
  if (!allowedLogo(url)) return null;
  const hit = cache.get(url);
  if (hit) return { colors: hit };
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(8_000), redirect: 'error', headers: { Accept: 'image/*' } });
  } catch {
    return null;
  }
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  let raw: Buffer;
  try {
    raw = await sharp(buf, { limitInputPixels: 25_000_000 }).resize(32, 32, { fit: 'cover' }).ensureAlpha().raw().toBuffer();
  } catch {
    return null;
  }
  const colors = palette(raw);
  cache.set(url, colors);
  return { colors };
}

/** RGBA pixels -> up to two dominant, distinct hues as #rrggbb. */
export function palette(rgba: Uint8Array): string[] {
  const BINS = 12;
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let opaque = 0;
  let colourful = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue;
    opaque++;
    const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
    const [h, s, l] = hsl(r, g, b);
    if (s < 0.25 || l < 0.12 || l > 0.92) continue;
    colourful++;
    const bin = bins[Math.floor(h / (360 / BINS)) % BINS]!;
    bin.w += s;
    bin.r += r * s;
    bin.g += g * s;
    bin.b += b * s;
  }
  if (!opaque || colourful / opaque < 0.08) return [];
  const ranked = bins.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0).sort((a, b) => b.w - a.w);
  const top = ranked[0]!;
  const out = [top];
  const second = ranked.find((b) => b !== top && b.w >= top.w * 0.25 && ringDistance(b.i, top.i, BINS) >= 2);
  if (second) out.push(second);
  return out.map((b) => hex(b.r / b.w, b.g / b.w, b.b / b.w));
}

function ringDistance(a: number, b: number, n: number): number {
  const d = Math.abs(a - b) % n;
  return Math.min(d, n - d);
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? ((G - B) / d + (G < B ? 6 : 0)) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
