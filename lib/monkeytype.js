import { randomUUID } from "crypto";

const API_BASE = process.env.MONKEYTYPE_API_BASE || ""; // e.g., "https://api.monkeytype.com"
const API_KEY = process.env.MONKEYTYPE_API_KEY || "";

/**
 * fetchMonkeytype15s(username, accessToken?)
 * Try to fetch a user's latest 15-second test.
 * If you have a real Monkeytype API:
 *   - Implement the real endpoint call here.
 *   - Parse WPM & accuracy from the latest 15s "time" result.
 * Fallback: create a stable pseudo-random (but realistic) score per username.
 */
export async function fetchMonkeytype15s(username, accessToken = null) {
  // ======= REAL IMPLEMENTATION (fill in when available) =======
  // Example shape (replace with real endpoints if Monkeytype publishes them):
  // try {
  //   const r = await fetch(`${API_BASE}/users/${encodeURIComponent(username)}/results?mode=time&time=15`, {
  //     headers: {
  //       "Authorization": `Bearer ${accessToken || API_KEY}`
  //     }
  //   });
  //   if (r.ok) {
  //     const data = await r.json();
  //     const latest = data.results?.[0];
  //     if (latest) {
  //       return {
  //         username,
  //         wpm15: Math.round(latest.wpm),
  //         accuracy: Math.round((latest.acc || latest.accuracy) * 100) / 100, // %
  //         raw: latest
  //       };
  //     }
  //   }
  // } catch (e) {
  //   // fall through to mock
  // }

  // ======= FALLBACK (Demo Mode) =======
  // Generate a deterministic-but-fake score from username so it looks consistent.
  const seed = [...(username || "anon")].reduce((a, c) => a + c.charCodeAt(0), 0);
  const wpmBase = 60 + (seed % 80);         // 60–139
  const jitter = (seed % 7) - 3;            // -3–+3
  const wpm15 = Math.max(20, wpmBase + jitter);

  const accBase = 92 + (seed % 7);          // 92–98
  const accuracy = Math.min(100, Math.max(80, accBase + (jitter / 2)));

  return {
    username,
    wpm15,
    accuracy: Math.round(accuracy * 100) / 100,
    raw: { id: randomUUID(), simulated: true }
  };
}
