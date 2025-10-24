// lib/monkeytype.js
import { getApeKey } from "./keystore.js";

const API_BASE = process.env.MONKEYTYPE_API_BASE || "https://api.monkeytype.com";

// helpers
const clampNum = (n, min, max) => {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
};
const round0 = (n) => Math.round(clampNum(n, 0, 2000));     // sane bounds
const round2 = (n) => Math.round(clampNum(n, 0, 100) * 100) / 100;

// fetch with timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// small backoff helper
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Normalize possible PB response shapes to an array of entries
function normalizePbArray(j) {
  if (!j) return [];
  const d = j.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.personalBests)) return d.personalBests;
  return [];
}

function pickBest15s(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // choose max WPM among any 15s PB entries (ignore config differences)
  let best = null;
  for (const e of entries) {
    const wpm = Number(e?.wpm);
    const mode = e?.mode;
    const mode2 = Number(e?.mode2);
    if (mode === "time" && mode2 === 15 && Number.isFinite(wpm)) {
      if (!best || wpm > Number(best.wpm)) best = e;
    }
  }
  return best;
}

/**
 * Fetch the user's best 15-second (time) result, using their Ape Key.
 *
 * @param {string} siteUsername - your *site* username (display name)
 * @param {string|null} apeKeyFromCaller
 * @returns {Promise<{ username: string, wpm15: number, accuracy: number, raw?: any }>}
 */
export async function fetchMonkeytype15s(siteUsername, apeKeyFromCaller = null) {
  const apeKey = apeKeyFromCaller || (await getApeKey(siteUsername));
  if (!apeKey) throw new Error("No ApeKey on file for user");

  const headers = { Authorization: `ApeKey ${apeKey}` };

  // 1) Personal best 15s (try with small retry/backoff for transient errors / 429)
  for (const delay of [0, 400, 900]) {
    try {
      if (delay) await sleep(delay);
      const pbR = await fetchWithTimeout(
        `${API_BASE}/users/personalBests?mode=time&mode2=15`,
        { headers },
        6000
      );
      if (pbR.ok) {
        const j = await pbR.json().catch(() => null);
        const arr = normalizePbArray(j);
        const best = pickBest15s(arr);
        if (best) {
          return {
            username: siteUsername,
            wpm15: round0(best.wpm),
            accuracy: round2(best.acc),
            raw: best,
          };
        }
      } else if (pbR.status === 401 || pbR.status === 470 || pbR.status === 471 || pbR.status === 472) {
        // invalid/inactive/malformed key variants — fail fast
        throw new Error(`ApeKey not authorized (status ${pbR.status})`);
      }
      // else continue to next strategy
      break; // if not ok and not 401-like, fall through to other endpoints without retrying PB
    } catch (e) {
      // on AbortError or network error, retry once then fall through
      // no logging of key
      continue;
    }
  }

  // 2) If last result is a 15s run, use it
  try {
    const lastR = await fetchWithTimeout(`${API_BASE}/results/last`, { headers }, 6000);
    if (lastR.ok) {
      const j = await lastR.json().catch(() => null);
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
  } catch {}

  // 3) Scan recent results for a 15s run
  try {
    const resR = await fetchWithTimeout(`${API_BASE}/results?limit=50`, { headers }, 6000);
    if (resR.ok) {
      const j = await resR.json().catch(() => null);
      const list = j?.data || j?.results || [];
      const match = Array.isArray(list)
        ? list.find((r) => r?.mode === "time" && Number(r?.mode2) === 15)
        : null;
      if (match) {
        return {
          username: siteUsername,
          wpm15: round0(match.wpm),
          accuracy: round2(match.acc),
          raw: match,
        };
      }
    }
  } catch {}

  throw new Error("No 15s result found for this user.");
}
