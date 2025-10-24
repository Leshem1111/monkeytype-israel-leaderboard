// lib/ip.js
const GEO_CACHE = new Map();
const GEO_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeIP(ip = "") {
  return ip.replace(/^::ffff:/, "").trim();
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

// Prefer explicit CDN/ingress headers, then XFF, then Express ip
export function getClientIP(req) {
  const cf = req.headers["cf-connecting-ip"];   // Cloudflare
  const real = req.headers["x-real-ip"];        // Nginx/Ingress
  const xff = firstForwarded(req.headers["x-forwarded-for"]);
  const fallback = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  return normalizeIP(cf || real || xff || fallback);
}

async function geoIpapi(ip) {
  const r = await fetch(`https://ipapi.co/${ip}/json/`, {
    headers: { "User-Agent": "monkeytype-il" }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.country || null; // "IL"
}

async function geoIpwho(ip) {
  const r = await fetch(`https://ipwho.is/${ip}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.success ? j.country_code : null; // "IL"
}

export async function getIPCountry(ip, req = null) {
  ip = normalizeIP(ip);
  if (!ip) return null;

  // Cloudflare sends country directly
  const cfCountry = req?.headers?.["cf-ipcountry"];
  if (cfCountry && /^[A-Z]{2}$/.test(cfCountry)) return cfCountry;

  const cached = GEO_CACHE.get(ip);
  if (cached && Date.now() - cached.ts < GEO_TTL_MS) return cached.country;

  let country = null;
  try { country = await geoIpapi(ip); } catch {}
  if (!country) { try { country = await geoIpwho(ip); } catch {} }

  GEO_CACHE.set(ip, { country, ts: Date.now() });
  return country;
}

export async function isIsraelIP(req) {
  const ip = getClientIP(req);

  // Don’t block localhost in dev
  if (process.env.NODE_ENV !== "production" && isPrivate(ip)) return true;

  const country = await getIPCountry(ip, req);

  // TEMP: log to debug what you’re seeing
  console.log("Geo check:", {
    ip,
    country,
    xff: req.headers["x-forwarded-for"],
    cf: req.headers["cf-connecting-ip"],
    reqip: req.ip
  });

  return country === "IL";
}
