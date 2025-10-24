import "dotenv/config";
import express from "express";
import session from "express-session";
import passport from "passport";
import OAuth2Strategy from "passport-oauth2";
import { upsertUser, loadUsers, saveUsers } from "./lib/store.js";
import { isIsraelIP } from "./lib/ip.js";
import { fetchMonkeytype15s } from "./lib/monkeytype.js";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const OAUTH = {
  authURL: process.env.MONKEYTYPE_OAUTH_AUTHORIZE_URL || "",
  tokenURL: process.env.MONKEYTYPE_OAUTH_TOKEN_URL || "",
  clientID: process.env.MONKEYTYPE_OAUTH_CLIENT_ID || "demo-client",
  clientSecret: process.env.MONKEYTYPE_OAUTH_CLIENT_SECRET || "demo-secret",
  callbackURL: process.env.MONKEYTYPE_OAUTH_CALLBACK_URL || `http://localhost:${PORT}/auth/monkeytype/callback`
};

const DEMO_MODE = !(OAUTH.authURL && OAUTH.tokenURL && process.env.MONKEYTYPE_OAUTH_CLIENT_ID && process.env.MONKEYTYPE_OAUTH_CLIENT_SECRET);

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: false
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Passport setup (Strategy)
if (!DEMO_MODE) {
  passport.use("monkeytype", new OAuth2Strategy({
    authorizationURL: OAUTH.authURL,
    tokenURL: OAUTH.tokenURL,
    clientID: OAUTH.clientID,
    clientSecret: OAUTH.clientSecret,
    callbackURL: OAUTH.callbackURL
  }, async (accessToken, refreshToken, params, profile, done) => {
    // With a real provider, fetch profile here to get username.
    // For now, assume username might be in params or needs another API call.
    // Replace this with the correct call once available.
    try {
      const username = params?.username || `user_${randomUUID().slice(0,8)}`;
      return done(null, { username, accessToken });
    } catch (e) {
      return done(e);
    }
  }));
} else {
  // Mock strategy in Demo Mode — lets the user supply a username after "login"
  passport.use("monkeytype", new (class DemoStrategy{
    name = "monkeytype";
    authenticate(req) {
      // Simulate redirect to provider
      const state = randomUUID();
      this.success({ state, demo: true }); // immediately "logged in"
    }
  })());
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(passport.initialize());
app.use(passport.session());

// --- Routes ---

// Start OAuth
app.get("/auth/monkeytype", passport.authenticate("monkeytype"));

// OAuth callback
app.get("/auth/monkeytype/callback", passport.authenticate("monkeytype", { failureRedirect: "/" }), async (req, res) => {
  // Israel-only gate at login
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

  // In Demo Mode, ask for Monkeytype username once
  if (DEMO_MODE) {
    return res.send(`
      <html><body style="font-family: ui-sans-serif; padding:24px">
        <h2>Link your Monkeytype username</h2>
        <form method="POST" action="/auth/demo/link">
          <label>Monkeytype Username</label><br/>
          <input name="username" required placeholder="e.g. shira_types" style="padding:8px; width:260px; margin:8px 0"/><br/>
          <button type="submit" style="padding:8px 12px; font-weight:600">Continue</button>
        </form>
      </body></html>
    `);
  }

  // If real OAuth gives us a username already, proceed to store/fetch
  try {
    const username = req.user?.username;
    if (!username) {
      return res.status(400).send("Could not resolve Monkeytype username from OAuth.");
    }
    await refreshOne(username, req.user?.accessToken);
    return res.redirect("/");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Error while fetching your 15s result.");
  }
});

// Demo: link username
app.post("/auth/demo/link", async (req, res) => {
  const allowed = await isIsraelIP(req);
  if (!allowed) {
    return res.status(403).send("Israel-only access.");
  }
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const match = /username=([^&]+)/.exec(body);
    const username = match ? decodeURIComponent(match[1]).trim() : "";
    if (!username) return res.status(400).send("Username required.");

    await refreshOne(username, null);
    res.redirect("/");
  });
});

// Refresh stats for one user and upsert in DB
async function refreshOne(username, accessToken) {
  const mt = await fetchMonkeytype15s(username, accessToken);
  const now = new Date().toISOString();
  await upsertUser({
    username: mt.username,
    wpm15: mt.wpm15,
    accuracy: mt.accuracy,
    timestamp: now,
    country: "IL" // We already filtered by IP on login.
  });
}

// API: leaderboard
app.get("/api/leaderboard", async (req, res) => {
  const users = await loadUsers();

  // Only IL users (defensive)
  const ilUsers = users.filter(u => (u.country || "IL") === "IL");

  // Sort by WPM desc, tie-breaker accuracy, then recency
  ilUsers.sort((a, b) => {
    if (b.wpm15 !== a.wpm15) return b.wpm15 - a.wpm15;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  res.json({
    mode: DEMO_MODE ? "demo" : "live",
    users: ilUsers.map(u => ({
      username: u.username,
      wpm15: u.wpm15,
      accuracy: u.accuracy,
      timestamp: u.timestamp
    }))
  });
});

// Health
app.get("/healthz", (_, res) => res.json({ ok: true, demo: DEMO_MODE }));

// Static homepage is served from /public

// --- Background refresh: pull latest stats every N minutes ---
const REFRESH_MINUTES = 3; // “every few minutes”
setInterval(async () => {
  try {
    const users = await loadUsers();
    // refresh each user in-place (best-effort)
    for (const u of users) {
      const mt = await fetchMonkeytype15s(u.username, null);
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

// Start server
app.listen(PORT, () => {
  console.log(`Monkeytype Israel Leaderboard running on http://localhost:${PORT}  (mode: ${DEMO_MODE ? "DEMO" : "LIVE"})`);
});
