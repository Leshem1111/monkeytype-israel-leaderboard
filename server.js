// server.js
import "dotenv/config";
import express from "express";
import session from "express-session";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import csurf from "csurf";
import path from "path";

// local libs
import { upsertUser, loadUsers, saveUsers } from "./lib/store.js";
import { isIsraelIP } from "./lib/ip.js";
import { fetchMonkeytype15s } from "./lib/monkeytype.js";
import {
  upsertKey,
  getApeKey,
  findUsernameByKeyHash,
  setUsernameForKeyHash,
  deleteUserAndKey,
} from "./lib/keystore.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === "production";
const MT_BASE = process.env.MONKEYTYPE_API_BASE || "https://api.monkeytype.com";

// ───────────────────────────────────────────────────────────────────────────────
// Security & infra
// ───────────────────────────────────────────────────────────────────────────────
// If you sit behind exactly one proxy (Render/CF), prefer numeric 1 (prevents spoofing deeper XFF chains)
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"], // drop 'unsafe-inline' if you move inline styles to CSS
        "form-action": ["'self'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'self'"],
      },
    },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false }, // 180 days-ish
    referrerPolicy: { policy: "no-referrer" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false,
  })
);

// Force HTTPS in prod
app.use((req, res, next) => {
  if (PROD && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  return next();
});

// ───────────────────────────────────────────────────────────────────────────────
// Sessions (Redis if available; MemoryStore fallback w/ warning)
// ───────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (process.env.REDIS_URL) {
      const { default: connectRedis } = await import("connect-redis");
      const { Redis } = await import("ioredis");
      const RedisStore = connectRedis(session);

      const redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });

      app.use(
        session({
          store: new RedisStore({ client: redis, prefix: "sess:" }),
          name: "sid",
          secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString("base64"),
          resave: false,
          saveUninitialized: false,
          cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: PROD,
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
          },
        })
      );
    } else {
      console.warn("[SECURITY] REDIS_URL not set. Using MemoryStore (NOT for production).");
      app.use(
        session({
          name: "sid",
          secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString("base64"),
          resave: false,
          saveUninitialized: false,
          cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: PROD,
            maxAge: 1000 * 60 * 60 * 24 * 7,
          },
        })
      );
    }
  } catch (e) {
    console.error("[SESSION ERROR] Falling back to MemoryStore:", e?.message || e);
    app.use(
      session({
        name: "sid",
        secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString("base64"),
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          sameSite: "lax",
          secure: PROD,
          maxAge: 1000 * 60 * 60 * 24 * 7,
        },
      })
    );
  }
})();

// ───────────────────────────────────────────────────────────────────────────────
// Body parsing, static assets, and no-store for sensitive responses
// ───────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb" }));
app.use(
  express.static("public", {
    index: "index.html",
    etag: true,
    lastModified: true,
    maxAge: PROD ? "1h" : 0,
    immutable: PROD,
    setHeaders: (res, filePath) => {
      if (path.extname(filePath) === ".html") {
        // don’t cache HTML
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  })
);

// Standard helper to mark responses as non-cacheable
function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

// ───────────────────────────────────────────────────────────────────────────────
/** Fetch with timeout helper + tiny backoff */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ───────────────────────────────────────────────────────────────────────────────
// Rate limiting (global + join-specific) + per-ApeKey throttle
// ───────────────────────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Extra lightweight per-IP cooldown (10s) for join
const lastJoinByIp = new Map();
function softJoinCooldown(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const last = lastJoinByIp.get(ip) || 0;
  const MIN_MS = 10 * 1000;
  if (now - last < MIN_MS) {
    return res.status(429).send("Too many attempts. Please wait a few seconds and try again.");
  }
  lastJoinByIp.set(ip, now);
  next();
}

// Per-key attempt throttle (prevents rapid brute attempts on same key)
const lastByKeyHash = new Map();
function throttleKeyHash(keyHash) {
  const now = Date.now();
  const last = lastByKeyHash.get(keyHash) || 0;
  const MIN_MS = 8 * 1000;
  if (now - last < MIN_MS) return false;
  lastByKeyHash.set(keyHash, now);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// CSRF (form + API) and Origin/Referer checks on state-changing routes
// ───────────────────────────────────────────────────────────────────────────────
const csrfProtection = csurf({ cookie: false });

function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  // Allow no Origin for same-site form posts; otherwise enforce same origin
  if (origin && !origin.startsWith(`https://${req.headers.host}`) && !origin.startsWith(`http://${req.headers.host}`)) {
    return res.status(403).send("Bad origin");
  }
  if (referer && !referer.startsWith(`https://${req.headers.host}`) && !referer.startsWith(`http://${req.headers.host}`)) {
    return res.status(403).send("Bad referer");
  }
  next();
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// Put near your helpers in server.js
async function testApeKey(apeKey) {
  const headers = {
    Authorization: `ApeKey ${apeKey}`,
    Accept: "application/json",
    "User-Agent": "mt-il/1.0",
  };

  // Prefer an endpoint that does NOT require having a recent run
  // /users/personalBests is good for pure auth verification
  try {
    const r = await fetchWithTimeout(`${MT_BASE}/users/personalBests?limit=1`, { headers }, 6000);

    // Explicit “bad key” statuses → definitely invalid
    if (r.status === 401 || r.status === 470 || r.status === 471 || r.status === 472) {
      return { ok: false, reason: "unauthorized", status: r.status };
    }

    // 200/204/404 (some variants) still prove the key is *accepted*;
    // empty data is fine — the user might not have PBs for that filter.
    if (r.ok) return { ok: true, status: r.status };

    // Rate-limit / transient errors: treat as “unknown” and let join proceed
    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
      return { ok: null, reason: "temporary", status: r.status };
    }

    // Other weird statuses: still don’t block decisively
    return { ok: null, reason: "unexpected", status: r.status };
  } catch (e) {
    // Timeout / network error → “unknown”
    return { ok: null, reason: "network", error: e?.message };
  }
}


async function usernameExists(siteUsername) {
  const want = siteUsername.trim().toLowerCase();
  const users = await loadUsers();
  return users.some((u) => (u.username || "").trim().toLowerCase() === want);
}

function normalizeUsername(u) {
  // Normalize Unicode to avoid confusable spoofs; trim; limit length
  return String(u || "").normalize("NFKC").trim().slice(0, 20);
}

function validUsername(u) {
  return /^[a-zA-Z0-9_-]{3,20}$/.test(u);
}

async function refreshOne(siteUsername, apeKey = null) {
  // retry PB fetch a couple of times in case of transient errors
  let lastErr;
  for (const backoff of [0, 400, 900]) {
    try {
      if (backoff) await sleep(backoff);
      const mt = await fetchMonkeytype15s(siteUsername, apeKey);
      const now = new Date().toISOString();
      await upsertUser({
        username: siteUsername,
        wpm15: mt.wpm15,
        accuracy: mt.accuracy,
        timestamp: now,
        country: "IL",
      });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("refresh failed");
}

function loginWithRegen(req, username, redirect = "/") {
  return new Promise((resolve) => {
    req.session.regenerate(() => {
      req.session.user = { username };
      resolve(redirect);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────

// Join page (server-rendered form, includes CSRF token)
app.get("/join", csrfProtection, async (req, res) => {
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

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  res.send(`
  <html><body style="font-family: ui-sans-serif; padding:24px; max-width:700px">
    <h2>Join the Leaderboard</h2>
    <p>Enter a <b>Username for this site</b> and paste your <b>Ape Key</b> from Monkeytype (Account → Ape Keys).</p>
    <form method="POST" action="/join" style="margin-top:16px">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}"/>

      <label style="display:block; font-weight:600">Username (site display name)</label>
      <input name="siteUsername" required maxlength="20" placeholder="e.g. shira_types" style="padding:8px; width:360px; margin:6px 0"/>

      <label style="display:block; font-weight:600; margin-top:8px">Ape Key</label>
      <input name="apeKey" required maxlength="200" placeholder="ape_xxx..." style="padding:8px; width:480px; margin:6px 0"/>

      <div style="margin-top:12px">
        <button type="submit" style="padding:8px 12px; font-weight:600">Join</button>
        <a href="/" style="margin-left:12px">Cancel</a>
      </div>
    </form>
  </body></html>
  `);
});

// Handle the join form submit
app.post(
  "/join",
  joinLimiter,
  softJoinCooldown,
  requireSameOrigin,
  csrfProtection,
  async (req, res) => {
    const allowed = await isIsraelIP(req);
    if (!allowed) return res.status(403).send("Israel-only access.");

    try {
      let siteUsername = normalizeUsername(req.body?.siteUsername);
      const apeKey = String(req.body?.apeKey || "").trim();

      if (!validUsername(siteUsername)) {
        return res.status(400).send("Username must be 3–20 chars: letters, numbers, _ or -");
      }
      if (!apeKey || apeKey.length > 180) {
        return res.status(400).send("Ape Key missing or too long.");
      }

      const keyHash = sha256(apeKey);
      if (!throttleKeyHash(keyHash)) {
        return res.status(429).send("Please slow down.");
      }

      const ok = await testApeKey(apeKey);
      if (!ok) return res.status(400).send("Ape Key invalid or not authorized.");

      // (A) If this key is already bound, log into that username
      const boundUser = await findUsernameByKeyHash(keyHash);
      if (boundUser) {
        await refreshOne(boundUser, apeKey);
        await loginWithRegen(req, boundUser);
        return res.redirect("/");
      }

      // (B) If username exists, allow only if same key → relogin
      if (await usernameExists(siteUsername)) {
        const storedKey = await getApeKey(siteUsername);
        if (!storedKey || sha256(storedKey) !== keyHash) {
          return res.status(409).send("Username is already taken.");
        }
        await refreshOne(siteUsername, apeKey);
        await loginWithRegen(req, siteUsername);
        return res.redirect("/");
      }

      // (C) Brand new username + new key: create binding
      await upsertKey({ username: siteUsername, apeKey });
      await setUsernameForKeyHash(keyHash, siteUsername);
      await refreshOne(siteUsername, apeKey);
      await loginWithRegen(req, siteUsername);

      return res.redirect("/");
    } catch (e) {
      console.error("join error:", e?.message || e);
      return res.status(500).send("Server error while joining.");
    }
  }
);

// JSON API join (expects x-csrf-token; Origin/Referer enforced)
app.post(
  "/api/join",
  joinLimiter,
  softJoinCooldown,
  requireSameOrigin,
  csrfProtection,
  async (req, res) => {
    noStore(res);
    const allowed = await isIsraelIP(req);
    if (!allowed) return res.status(403).json({ ok: false, error: "Israel-only access." });

    try {
      let siteUsername = normalizeUsername(req.body?.siteUsername);
      const apeKey = String(req.body?.apeKey || "").trim();

      if (!validUsername(siteUsername)) {
        return res.status(400).json({ ok: false, error: "Bad username format" });
      }
      if (!apeKey || apeKey.length > 180) {
        return res.status(400).json({ ok: false, error: "Bad Ape Key" });
      }

      const keyHash = sha256(apeKey);
      if (!throttleKeyHash(keyHash)) {
        return res.status(429).json({ ok: false, error: "Please slow down" });
      }

      const ok = await testApeKey(apeKey);
      if (!ok) return res.status(400).json({ ok: false, error: "Ape Key invalid or not authorized." });

      const boundUser = await findUsernameByKeyHash(keyHash);
      if (boundUser) {
        await refreshOne(boundUser, apeKey);
        await loginWithRegen(req, boundUser);
        return res.json({ ok: true, username: boundUser, relogin: true });
      }

      if (await usernameExists(siteUsername)) {
        const storedKey = await getApeKey(siteUsername);
        if (!storedKey || sha256(storedKey) !== keyHash) {
          return res.status(409).json({ ok: false, error: "Username is already taken." });
        }
        await refreshOne(siteUsername, apeKey);
        await loginWithRegen(req, siteUsername);
        return res.json({ ok: true, username: siteUsername, relogin: true });
      }

      await upsertKey({ username: siteUsername, apeKey });
      await setUsernameForKeyHash(keyHash, siteUsername);
      await refreshOne(siteUsername, apeKey);
      await loginWithRegen(req, siteUsername);

      return res.json({ ok: true, username: siteUsername, created: true });
    } catch (e) {
      console.error("api/join error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  }
);

// Session/status helpers
app.get("/api/session", csrfProtection, (req, res) => {
  noStore(res);
  const u = req.session?.user;
  // expose a CSRF token here for clients that POST to /api/join
  res.json({ loggedIn: !!u, username: u?.username || null, csrf: req.csrfToken() });
});

app.post("/logout", requireSameOrigin, csrfProtection, (req, res) => {
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
      username: u.username,
      wpm15: u.wpm15,
      accuracy: u.accuracy,
      timestamp: u.timestamp,
    })),
  });
});

// Health
app.get("/healthz", (_, res) => res.json({ ok: true }));

// ───────────────────────────────────────────────────────────────────────────────
// Background refresh + invalid key cleanup
// ───────────────────────────────────────────────────────────────────────────────
const REFRESH_MINUTES = 3;
setInterval(async () => {
  try {
    const users = await loadUsers();
    const keep = [];

    for (const u of users) {
      try {
        const key = await getApeKey(u.username);
        if (!key) continue;

        // Validate key with timeout; skip if invalid
        const valid = await testApeKey(key);
        if (!valid) {
          console.warn(`[CLEANUP] Ape Key for ${u.username} is invalid — removing user/key`);
          await deleteUserAndKey(u.username);
          continue;
        }

        // Backoff a bit to avoid API bursts
        await sleep(120);

        const mt = await fetchMonkeytype15s(u.username);
        u.wpm15 = mt.wpm15;
        u.accuracy = mt.accuracy;
        u.timestamp = new Date().toISOString();
        u.country = "IL";
        keep.push(u);
      } catch (inner) {
        console.warn(`[REFRESH ERROR] ${u.username}:`, inner?.message || inner);
      }
    }

    await saveUsers(keep);
  } catch (e) {
    console.error("Auto-refresh failed:", e?.message || e);
  }
}, REFRESH_MINUTES * 60 * 1000);

// 404 and centralized error handler
app.use((req, res) => res.status(404).send("Not found"));
app.use((err, req, res, next) => {
  console.error("[UNCAUGHT]", err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).send("Server error");
});

// Start
app.listen(PORT, () => {
  console.log(`Monkeytype Israel Leaderboard running on http://localhost:${PORT}`);
});
