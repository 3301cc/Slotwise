"use strict";
/*
 * Speicher für bestätigte Einträge + Rate-Limit-Zähler.
 * Drei austauschbare Implementierungen mit derselben Schnittstelle:
 *   - Redis über REST (Upstash, oder jeder Redis hinter einem REST-Proxy wie webdis/serverless-redis-http)
 *   - JSON-Datei (lokal, oder Einzelserver mit wenig Last)
 *   - Arbeitsspeicher (Tests)
 * Für Hetzner/OVH mit klassischem Redis (TCP) genügt eine vierte Klasse mit derselben Schnittstelle.
 */
const fs = require("node:fs");
const path = require("node:path");

const KEY = "waitlist:v1";

function memoryStore(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const counters = new Map();
  return {
    kind: "memory",
    async get(email) { return entries.get(email) || null; },
    async put(email, entry) { entries.set(email, entry); },
    async remove(email) { entries.delete(email); },
    async all() { return Object.fromEntries(entries); },
    async incrWithTtl(key, ttlSec, now = Date.now()) {
      const c = counters.get(key);
      if (!c || c.expires <= now) { counters.set(key, { n: 1, expires: now + ttlSec * 1000 }); return 1; }
      c.n += 1; return c.n;
    },
  };
}

function fileStore(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { entries: {}, counters: {} }; } };
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 2)); };
  return {
    kind: "file",
    async get(email) { return read().entries[email] || null; },
    async put(email, entry) { const d = read(); d.entries[email] = entry; write(d); },
    async remove(email) { const d = read(); delete d.entries[email]; write(d); },
    async all() { return read().entries; },
    async incrWithTtl(key, ttlSec, now = Date.now()) {
      const d = read(); const c = d.counters[key];
      if (!c || c.expires <= now) d.counters[key] = { n: 1, expires: now + ttlSec * 1000 };
      else c.n += 1;
      write(d); return d.counters[key].n;
    },
  };
}

function redisRestStore({ url, token }, fetchImpl = fetch) {
  async function cmd(parts) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(parts),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(`redis: ${json.error || res.status}`);
    return json.result;
  }
  return {
    kind: "redis-rest",
    async get(email) { const v = await cmd(["HGET", KEY, email]); return v ? JSON.parse(v) : null; },
    async put(email, entry) { await cmd(["HSET", KEY, email, JSON.stringify(entry)]); },
    async remove(email) { await cmd(["HDEL", KEY, email]); },
    async all() {
      const flat = (await cmd(["HGETALL", KEY])) || [];
      const out = {};
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
      return out;
    },
    async incrWithTtl(key, ttlSec) {
      const n = await cmd(["INCR", `${KEY}:rl:${key}`]);
      if (n === 1) await cmd(["EXPIRE", `${KEY}:rl:${key}`, ttlSec]);
      return n;
    },
  };
}

function createStore(config) {
  if (config.redis) return redisRestStore(config.redis);
  return fileStore(config.dataFile || path.join(process.cwd(), ".data", "waitlist.json"));
}

module.exports = { createStore, memoryStore, fileStore, redisRestStore };
