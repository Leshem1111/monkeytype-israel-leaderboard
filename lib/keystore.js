// lib/keystore.js
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const DATA_DIR = process.env.DATA_DIR || "data";
const FILE = path.join(DATA_DIR, "keystore.json");

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

async function ensureFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, JSON.stringify({ byUser: {}, byHash: {} }, null, 2));
  }
}

async function readStore() {
  await ensureFile();
  const raw = await fs.readFile(FILE, "utf8");
  try {
    const j = JSON.parse(raw);
    return {
      byUser: j.byUser || {}, // { [username]: apeKey }
      byHash: j.byHash || {}, // { [keyHash]: username }
    };
  } catch {
    return { byUser: {}, byHash: {} };
  }
}

async function writeStore(obj) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(obj, null, 2));
}

// Save/overwrite the Ape Key for a username. Also update the hash index.
export async function upsertKey({ username, apeKey }) {
  const store = await readStore();
  const uname = String(username).trim();

  // If this username already had a different key, remove old hash index
  const prev = store.byUser[uname];
  if (prev && prev !== apeKey) {
    const oldHash = sha256(prev);
    if (store.byHash[oldHash] === uname) delete store.byHash[oldHash];
  }

  store.byUser[uname] = apeKey;
  store.byHash[sha256(apeKey)] = uname;

  await writeStore(store);
}

export async function getApeKey(username) {
  const store = await readStore();
  return store.byUser[String(username).trim()] || null;
}

// Return the username bound to a given apeKey hash (or null)
export async function findUsernameByKeyHash(keyHash) {
  const store = await readStore();
  return store.byHash[keyHash] || null;
}

// Bind a key hash to a username (used on first create path)
export async function setUsernameForKeyHash(keyHash, username) {
  const store = await readStore();
  store.byHash[keyHash] = String(username).trim();
  await writeStore(store);
}
