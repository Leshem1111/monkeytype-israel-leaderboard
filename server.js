// server.js
import "dotenv/config";
import express from "express";
import session from "express-session";

import { randomUUID } from "crypto";
//import fetch from "node-fetch"; // if Node >= 18 you can delete this line and use the global fetch

import { upsertUser, loadUsers, saveUsers } from "./lib/store.js";
import { isIsraelIP } from "./lib/ip.js";
import { fetchMonkeytype15s } from "./lib/monkeytype.js";
import { upsertKey } from "./lib/keystore.js";

const app = express();
const PORT = process.env.PORT || 3000;
// right after you create "app"
app.set('trust proxy', true);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// -------------------- Helpers --------------------
const MT_BASE = process.env.MONKEYTYPE_API_BASE || "https://api.monkeytype.com";

// quick probe to validate an ApeKey
async function testApeKey(apeKey) {
  const r = await fetch(`${MT_BASE}/results/last`, {
    headers: { Authorization: `ApeKey ${apeKey}` },
  });
  return r.ok;
}

// refresh one (siteUsername is the display name you store)
async function refreshOne(siteUsername, apeKey = null) {
  const mt = await fetchMonkeytype15s(siteUsername, apeKey); // your lib reads stored key if apeKey is null
  const now = new Date().toISOString();
  await upsertUser({
    username: siteUsername,        // display name on your leaderboard
    wpm15: mt.wpm15,
    accuracy: mt.accuracy,
    timestamp: now,
    country: "IL",
  });
}

// -------------------- Routes --------------------

// Simple join page: "Username" (for site) + "Ape Key"
app.get("/join", async (req, res) => {
  const allowed = await isIsraelIP(req);
  if (!allowed) {
    return res.status(403).send(`
      <html><body style="font-family: ui-sans-serif; padding:24px">
      <h2>Access restricted</h2>
      <p>This leaderboard is for users detected in Israel only.</p>
      <p><a href="/">Go back</a></p>
      </body></html>
    `);
  }

  res.send(`
  <html><body style="font-family: ui-sans-serif; padding:24px; max-width:700px">
    <h2>Join the Leaderboard</h2>
    <p>Enter a <b>Username for this site</b> (what we’ll show on the board) and paste your <b>Ape Key</b> from Monkeytype (Account → Ape Keys).</p>
    <form method="POST" action="/join" style="margin-top:16px">
      <label style="display:block; font-weight:600">Username (site display name)</label>
      <input name="siteUsername" required placeholder="e.g. shira_types" style="padding:8px; width:360px; margin:6px 0"/>

      <label style="display:block; font-weight:600; margin-top:8px">Ape Key</label>
      <input name="apeKey" required placeholder="ape_xxx..." style="padding:8px; width:480px; margin:6px 0"/>

      <div style="margin-top:12px">
        <button type="submit" style="padding:8px 12px; font-weight:600">Join</button>
        <a href="/" style="margin-left:12px">Cancel</a>
      </div>
    </form>
  </body></html>
  `);
});

// Handle the join form submit
app.post("/join", async (req, res) => {
  const allowed = await isIsraelIP(req);
  if (!allowed) return res.status(403).send("Israel-only access.");

  try {
    const siteUsername = (req.body?.siteUsername || "").trim();
    const apeKey = (req.body?.apeKey || "").trim();

    if (!siteUsername || !apeKey) {
      return res.status(400).send("Both Username and Ape Key are required.");
    }

    const ok = await testApeKey(apeKey);
    if (!ok) return res.status(400).send("Ape Key invalid or not authorized.");

    // store the key under the *site username*
    await upsertKey({ username: siteUsername, apeKey });

    // fetch their 15s PB and upsert using the *site username* as display
    await refreshOne(siteUsername, apeKey);

    return res.redirect("/");
  } catch (e) {
    console.error("join error:", e?.message || e);
    return res.status(500).send("Server error while joining.");
  }
});

// Optional JSON API (if you want to POST from client instead of using the HTML form)
app.post("/api/join", async (req, res) => {
  const allowed = await isIsraelIP(req);
  if (!allowed) return res.status(403).json({ ok: false, error: "Israel-only access." });

  try {
    const siteUsername = (req.body?.siteUsername || "").trim();
    const apeKey = (req.body?.apeKey || "").trim();

    if (!siteUsername || !apeKey) {
      return res.status(400).json({ ok: false, error: "Username and Ape Key required." });
    }

    const ok = await testApeKey(apeKey);
    if (!ok) return res.status(400).json({ ok: false, error: "Ape Key invalid or not authorized." });

    await upsertKey({ username: siteUsername, apeKey });
    await refreshOne(siteUsername, apeKey);

    return res.json({ ok: true, username: siteUsername });
  } catch (e) {
    console.error("api/join error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Leaderboard JSON (kept same sorting)
app.get("/api/leaderboard", async (req, res) => {
  const users = await loadUsers();

  const ilUsers = users.filter((u) => (u.country || "IL") === "IL");

  ilUsers.sort((a, b) => {
    if (b.wpm15 !== a.wpm15) return b.wpm15 - a.wpm15;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  res.json({
    users: ilUsers.map((u) => ({
      username: u.username, // this is the *site* username
      wpm15: u.wpm15,
      accuracy: u.accuracy,
      timestamp: u.timestamp,
    })),
  });
});

// Health
app.get("/healthz", (_, res) => res.json({ ok: true }));

// -------------------- background refresh --------------------
const REFRESH_MINUTES = 3;
setInterval(async () => {
  try {
    const users = await loadUsers();
    for (const u of users) {
      // fetcher will use the stored Ape Key via keystore
      const mt = await fetchMonkeytype15s(u.username);
      u.wpm15 = mt.wpm15;
      u.accuracy = mt.accuracy;
      u.timestamp = new Date().toISOString();
      u.country = "IL";
    }
    await saveUsers(users);
  } catch (e) {
    console.error("Auto-refresh failed:", e?.message || e);
  }
}, REFRESH_MINUTES * 60 * 1000);

// -------------------- start server --------------------
app.listen(PORT, () => {
  console.log(`Monkeytype Israel Leaderboard running on http://localhost:${PORT}`);
});
