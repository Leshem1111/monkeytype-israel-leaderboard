import pkg from "fs-extra";
const { readJSON, writeJSON, pathExists } = pkg;
import { join } from "path";

const __dirname = new URL('.', import.meta.url).pathname;
const KEYS_PATH = join(__dirname, "..", "data", "keys.json");

export async function loadKeys() {
  if (!(await pathExists(KEYS_PATH))) await writeJSON(KEYS_PATH, []);
  return readJSON(KEYS_PATH);
}

export async function upsertKey({ username, apeKey }) {
  const keys = await loadKeys();
  const i = keys.findIndex(k => k.username.toLowerCase() === username.toLowerCase());
  if (i >= 0) keys[i].apeKey = apeKey;
  else keys.push({ username, apeKey });
  await writeJSON(KEYS_PATH, keys, { spaces: 2 });
}

export async function getApeKey(username) {
  const keys = await loadKeys();
  return keys.find(k => k.username.toLowerCase() === username.toLowerCase())?.apeKey || null;
}
