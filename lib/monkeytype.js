import { getApeKey } from "./keystore.js";

const API_BASE = process.env.MONKEYTYPE_API_BASE || "https://api.monkeytype.com";

/**
 * Fetch the user's latest 15-second test.
 * Uses their ApeKey (Authorization: ApeKey <key>).
 */
export async function fetchMonkeytype15s(username) {
  const apeKey = await getApeKey(username);
  if (!apeKey) throw new Error("No ApeKey on file for user");

  // Try the "last result" endpoint first
  const lastR = await fetch(`${API_BASE}/results/last`, {
    headers: { Authorization: `ApeKey ${apeKey}` }
  });

  if (lastR.ok) {
    const j = await lastR.json();
    const d = j?.data;
    if (d?.mode === "time" && Number(d?.mode2) === 15) {
      return {
        username,
        wpm15: Math.round(d.wpm),
        accuracy: Math.round(Number(d.acc) * 100) / 100,
        raw: d
      };
    }
  }

  // Otherwise scan recent results for the newest 15s run
  const resR = await fetch(`${API_BASE}/results?limit=50`, {
    headers: { Authorization: `ApeKey ${apeKey}` }
  });

  if (resR.ok) {
    const j = await resR.json();
    const list = j?.data || j?.results || [];
    const match = list.find(r => r?.mode === "time" && Number(r?.mode2) === 15);
    if (match) {
      return {
        username,
        wpm15: Math.round(match.wpm),
        accuracy: Math.round(Number(match.acc) * 100) / 100,
        raw: match
      };
    }
  }

  throw new Error("No 15s result found for this user.");
}
