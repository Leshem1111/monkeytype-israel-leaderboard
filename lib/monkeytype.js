// lib/monkeytype.js
import { getApeKey } from "./keystore.js";

const API_BASE = process.env.MONKEYTYPE_API_BASE || "https://api.monkeytype.com";

// helpers
const round0 = (n) => Math.round(Number(n) || 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Fetch the user's best 15-second (time) result, using their Ape Key.
 * The `username` here is your *site* username (display name). We don't need the MT username.
 *
 * @param {string} siteUsername
 * @param {string|null} apeKeyFromCaller
 * @returns {Promise<{ username: string, wpm15: number, accuracy: number, raw?: any }>}
 */
export async function fetchMonkeytype15s(siteUsername, apeKeyFromCaller = null) {
  const apeKey = apeKeyFromCaller || (await getApeKey(siteUsername));
  if (!apeKey) throw new Error("No ApeKey on file for user");

  const headers = { Authorization: `ApeKey ${apeKey}` };

  // 1) Prefer personal best for 15s
// 1) Prefer personal best for 15s (pick the highest WPM across all configs)
try {
  const pbR = await fetch(`${API_BASE}/users/personalBests?mode=time&mode2=15`, { headers });
  if (pbR.ok) {
    const j = await pbR.json();
    // Normalize: API may return { data: [...] } or { data: { personalBests: [...] } } on some versions
    const arr =
      (Array.isArray(j?.data) ? j.data :
       Array.isArray(j?.data?.personalBests) ? j.data.personalBests :
       []) || [];

    if (arr.length) {
      // If you want “overall best 15s regardless of config”, take the max WPM:
      const best = arr.reduce((a, b) => (Number(b.wpm) > Number(a?.wpm || 0) ? b : a), null);

      return {
        username: siteUsername,
        wpm15: round0(best?.wpm),
        accuracy: round2(best?.acc),
        raw: best,
      };
    }
  }
} catch (_) {}


  // 2) If last result is a 15s run, use it
  try {
    const lastR = await fetch(`${API_BASE}/results/last`, { headers });
    if (lastR.ok) {
      const j = await lastR.json();
      const d = j?.data;
      if (d?.mode === "time" && Number(d?.mode2) === 15) {
        return {
          username: siteUsername,
          wpm15: round0(d.wpm),
          accuracy: round2(d.acc),
          raw: d,
        };
      }
    }
  } catch (_) {}

  // 3) Scan recent results for a 15s run
  try {
    const resR = await fetch(`${API_BASE}/results?limit=50`, { headers });
    if (resR.ok) {
      const j = await resR.json();
      const list = j?.data || j?.results || [];
      const match = list.find((r) => r?.mode === "time" && Number(r?.mode2) === 15);
      if (match) {
        return {
          username: siteUsername,
          wpm15: round0(match.wpm),
          accuracy: round2(match.acc),
          raw: match,
        };
      }
    }
  } catch (_) {}

  throw new Error("No 15s result found for this user.");
}
