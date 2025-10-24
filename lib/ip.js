export function getClientIP(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) {
    const parts = xf.split(",").map(s => s.trim());
    return parts[0];
  }
  return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || "";
}

export async function getIPCountry(ip) {
  try {
    // Free, simple geolocation. In production, consider a paid, more reliable source.
    // ipapi.co handles IPv6 and private ranges reasonably (may return empty).
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { timeout: 5000 });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.country || null; // "IL", "US", etc.
  } catch {
    return null;
  }
}

export async function isIsraelIP(req) {
  const ip = getClientIP(req);
  const country = await getIPCountry(ip);
  // Treat missing as not Israel to be strict
  return country === "IL";
}
