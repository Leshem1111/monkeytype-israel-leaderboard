import pkg from "fs-extra";
const { readJSON, writeJSON, pathExists } = pkg;

import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = new URL('.', import.meta.url).pathname;
const DB_PATH = join(__dirname, "..", "data", "users.json");

export async function loadUsers() {
  if (!(await pathExists(DB_PATH))) {
    await writeJSON(DB_PATH, []);
  }
  return readJSON(DB_PATH);
}

export async function saveUsers(users) {
  return writeJSON(DB_PATH, users, { spaces: 2 });
}

export async function upsertUser(user) {
  const users = await loadUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === user.username.toLowerCase());
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...user };
  } else {
    users.push(user);
  }
  await saveUsers(users);
  return user;
}
