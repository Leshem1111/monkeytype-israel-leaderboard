// server.js
import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "crypto";

import { upsertUser, loadUsers, saveUsers } from "./lib/store.js";
import { isIsraelIP } from "./lib/ip.js";
import { fetchMonkeytype15s } from "./lib/monkeytype.js";
import {
  upsertKey,
  getApeKey,
  findUsernameByKeyHash,   // NEW
  setUsernameForKeyHash,   // NEW (for first bind)
} from "./lib/keystore.js";

const app = express();
const PORT = process.env.PORT || 3000;

// trust proxy BEFORE any middleware so req.ip / XFF are correct
app.set("trust proxy", true);

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

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// username exists? (case-insensitive)
async function usernameExists(siteUsername) {
  const want = siteUsername.trim().toLowerCase();
  const users = await loadUsers();
  return users.some(u => (u.username || "").trim().toLowerCase() === want);
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

// very simple in-memory rate limiter (per IP) for join
const lastJoinByIp = new Map();
function rateLimitJoin(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const last = lastJoinByIp.get(ip) || 0;
  const MIN_MS = 10 * 1000; // 10s between join attempts
  if (now - last < MIN_MS) {
    return res.status(429).send("Too many attempts. Please wait a few seconds and try again.");
  }
  lastJoinByIp.set(ip, now);
  next();
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
app.post("/join", rateLimitJoin, async (req, res) => {
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

    const keyHash = sha256(apeKey);

    // (A) If this Ape Key is already bound to some username, LOG THE USER INTO THAT ENTRY.
    const boundUser = await findUsernameByKeyHash(keyHash);
    if (boundUser) {
      // if they typed a different display name, we ignore it and log them into the bound one
      await refreshOne(boundUser, apeKey);          // immediate refresh using their key
      req.session.user = { username: boundUser };   // mark session
      return res.redirect("/");
    }

    // (B) No binding yet. If username exists, allow only if the stored key matches -> re-login.
    if (await usernameExists(siteUsername)) {
      const storedKey = await getApeKey(siteUsername);
      if (!storedKey) {
        return res.status(409).send("Username is already taken.");
      }
      if (sha256(storedKey) !== keyHash) {
        return res.status(409).send("Username is already taken.");
      }
      // Correct key for this username -> treat as login
      await refreshOne(siteUsername, apeKey);
      req.session.user = { username: siteUsername };
      return res.redirect("/");
    }

    // (C) Brand new username + new key: create binding, then proceed.
    await upsertKey({ username: siteUsername, apeKey });
    await setUsernameForKeyHash(keyHash, siteUsername); // bind keyHash -> username

    await refreshOne(siteUsername, apeKey);
    req.session.user = { username: siteUsername };

    return res.redirect("/");
  } catch (e) {
    console.error("join error:", e?.message || e);
    return res.status(500).send("Server error while joining.");
  }
});

// Optional JSON API (if you want to POST from client instead of using the HTML form)
app.post("/api/join", rateLimitJoin, async (req, res) => {
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

    const keyHash = sha256(apeKey);

    // (A) If this key is already bound, login to that username
    const boundUser = await findUsernameByKeyHash(keyHash);
    if (boundUser) {
      await refreshOne(boundUser, apeKey);
      req.session.user = { username: boundUser };
      return res.json({ ok: true, username: boundUser, relogin: true });
    }

    // (B) Username exists: allow only if same key -> relogin
    if (await usernameExists(siteUsername)) {
      const storedKey = await getApeKey(siteUsername);
      if (!storedKey || sha256(storedKey) !== keyHash) {
        return res.status(409).json({ ok: false, error: "Username is already taken." });
      }
      await refreshOne(siteUsername, apeKey);
      req.session.user = { username: siteUsername };
      return res.json({ ok: true, username: siteUsername, relogin: true });
    }

    // (C) New username + new key: bind and create
    await upsertKey({ username: siteUsername, apeKey });
    await setUsernameForKeyHash(keyHash, siteUsername);
    await refreshOne(siteUsername, apeKey);
    req.session.user = { username: siteUsername };

    return res.json({ ok: true, username: siteUsername, created: true });
  } catch (e) {
    console.error("api/join error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Session/status helpers for the front-end
app.get("/api/session", (req, res) => {
  const u = req.session?.user;
  res.json({ loggedIn: !!u, username: u?.username || null });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
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
    const toKeep = [];
    for (const u of users) {
      try {
        const apeKey = await getApeKey(u.username);
        if (!apeKey) continue;

        // Check if key still valid
        const ok = await testApeKey(apeKey);
        if (!ok) {
          console.warn(`[CLEANUP] Ape Key for ${u.username} is invalid — removing user`);
          continue; // skip (this will effectively delete them below)
        }

        // Still valid: refresh their score
        const mt = await fetchMonkeytype15s(u.username);
        u.wpm15 = mt.wpm15;
        u.accuracy = mt.accuracy;
        u.timestamp = new Date().toISOString();
        u.country = "IL";
        toKeep.push(u);
      } catch (inner) {
        console.warn(`[REFRESH ERROR] ${u.username}:`, inner.message);
      }
    }

    await saveUsers(toKeep);

    // Also remove orphaned keys (that don't belong to any user anymore)
    const allUsernames = new Set(toKeep.map((u) => u.username));
    const store = await import("./lib/keystore.js");
    const fs = (await import("fs/promises")).default;
    const dataPath = process.env.DATA_DIR || "data";
    const file = `${dataPath}/keystore.json`;

    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      for (const [name] of Object.entries(raw.byUser || {})) {
        if (!allUsernames.has(name)) {
          delete raw.byUser[name];
        }
      }
      await fs.writeFile(file, JSON.stringify(raw, null, 2));
    } catch (e) {
      console.warn("Cleanup keystore failed:", e.message);
    }

  } catch (e) {
    console.error("Auto-refresh failed:", e?.message || e);
  }
}, REFRESH_MINUTES * 60 * 1000);
