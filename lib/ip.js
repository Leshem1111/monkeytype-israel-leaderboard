// lib/ip.js
// Hardened IP extraction + geolocation with timeout, retries, and caching.

const GEO_CACHE = new Map();              // ip -> { country, ts }
const GEO_TTL_MS_OK = 10 * 60 * 1000;     // 10 minutes for successful lookups
const GEO_TTL_MS_NULL = 60 * 1000;        // 1 minute for failed/unknown lookups

// --- small helpers ---
function normalizeIP(ip = "") {
  // Remove IPv4-mapped IPv6 prefix & trim
  return String(ip).replace(/^::ffff:/, "").trim();
}
function firstForwarded(xff) {
  return (xff || "").split(",")[0].trim();
}
function isPrivate(ip) {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}
function isValidIp(ip) {
  // very light check (IPv4 only here; IPv6 handled by normalize & pass-through)
  if (!ip) return false;
  if (ip.includes(":")) return true; // allow IPv6, let providers handle it
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// Fetch with timeout (no dependencies)
async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Prefer explicit CDN/ingress headers, then XFF, then Express ip
export function getClientIP(req) {
  // If you are behind Cloudflare or a single proxy (recommended), app.set('trust proxy', 1) in server.js makes req.ip reliable.
  const cf = req.headers["cf-connecting-ip"];      // Cloudflare
  const real = req.headers["x-real-ip"];           // Nginx/Ingress
  const xff = firstForwarded(req.headers["x-forwarded-for"]);
  const fallback =
    req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  const ip = normalizeIP(cf || real || xff || fallback);
  return ip;
}

// Providers with minimal parsing
async function geoIpapi(ip) {
  const r = await fetchWithTimeout(`https://ipapi.co/${ip}/json/`, {
    headers: { "User-Agent": "monkeytype-il" },
  }, 5000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.country === "string" ? j.country : null; // "IL"
}

async function geoIpwho(ip) {
  const r = await fetchWithTimeout(`https://ipwho.is/${ip}`, {}, 5000);
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && j.success ? j.country_code : null; // "IL"
}

export async function getIPCountry(ip, req = null) {
  ip = normalizeIP(ip);
  if (!ip || !isValidIp(ip)) return null;

  // If behind Cloudflare, prefer their header (fast & free)
  const cfCountry = req?.headers?.["cf-ipcountry"];
  if (cfCountry && /^[A-Z]{2}$/.test(cfCountry)) return cfCountry;

  // Cache
  const cached = GEO_CACHE.get(ip);
  const now = Date.now();
  if (cached) {
    const ttl = cached.country ? GEO_TTL_MS_OK : GEO_TTL_MS_NULL;
    if (now - cached.ts < ttl) return cached.country;
  }

  // Try providers with simple failover
  let country = null;
  try { country = await geoIpapi(ip); } catch {}
  if (!country) {
    try { country = await geoIpwho(ip); } catch {}
  }

  GEO_CACHE.set(ip, { country, ts: now });
  return country;
}

export async function isIsraelIP(req) {
  const ip = getClientIP(req);

  // Don’t block localhost in dev
  if (process.env.NODE_ENV !== "production" && isPrivate(ip)) return true;

  const country = await getIPCountry(ip, req);

  // Avoid leaking IPs in production logs; keep one line during dev only.
  if (process.env.NODE_ENV !== "production") {
    console.log("Geo check:", {
      ip,
      country,
      xff: req.headers["x-forwarded-for"],
      cf: req.headers["cf-connecting-ip"],
      reqip: req.ip,
    });
  }

  return country === "IL";
}
