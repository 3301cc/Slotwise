"use strict";
/*
 * Speicher für bestätigte Einträge + Rate-Limit-Zähler.
 * Drei austauschbare Implementierungen mit derselben Schnittstelle:
 *   - Redis über REST (Upstash, oder jeder Redis hinter einem REST-Proxy wie webdis/serverless-redis-http)
 *   - JSON-Datei (lokal, oder Einzelserver mit wenig Last)
 *   - Arbeitsspeicher (Tests)
 * Für Hetzner/OVH mit klassischem Redis (TCP) genügt eine vierte Klasse mit derselben Schnittstelle.
 * Schnittstelle: get/put/remove/all/incrWithTtl (Warteliste) + getJson/setJson/delKey/listPush/listRange/listReplace (Agent).
 */
const fs = require("node:fs");
const path = require("node:path");

const KEY = "waitlist:v1";

function memoryStore(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const counters = new Map();
  const kv = new Map();
  const lists = new Map();
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
    // Generische Schlüssel (Agent: Sitzungen, Einstellungen, Kalender) und Listen (Aktivität)
    async getJson(key, now = Date.now()) { const v = kv.get(key); if (!v) return null; if (v.expires && v.expires <= now) { kv.delete(key); return null; } return structuredClone(v.value); },
    async setJson(key, value, ttlSec, now = Date.now()) { kv.set(key, { value: structuredClone(value), expires: ttlSec ? now + ttlSec * 1000 : 0 }); },
    async delKey(key) { kv.delete(key); },
    async listPush(key, value, max = 200) { const l = lists.get(key) || []; l.unshift(structuredClone(value)); if (l.length > max) l.length = max; lists.set(key, l); },
    async listRange(key, n = 50) { return structuredClone((lists.get(key) || []).slice(0, n)); },
    async listReplace(key, values) { lists.set(key, structuredClone(values)); },
  };
}

function fileStore(file) {
  const read = () => { let d; try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch { d = {}; } return { entries: {}, counters: {}, kv: {}, lists: {}, ...d }; };
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
    async getJson(key, now = Date.now()) { const v = read().kv[key]; if (!v) return null; if (v.expires && v.expires <= now) return null; return v.value; },
    async setJson(key, value, ttlSec, now = Date.now()) { const d = read(); d.kv[key] = { value, expires: ttlSec ? now + ttlSec * 1000 : 0 }; write(d); },
    async delKey(key) { const d = read(); delete d.kv[key]; write(d); },
    async listPush(key, value, max = 200) { const d = read(); const l = d.lists[key] || []; l.unshift(value); if (l.length > max) l.length = max; d.lists[key] = l; write(d); },
    async listRange(key, n = 50) { return (read().lists[key] || []).slice(0, n); },
    async listReplace(key, values) { const d = read(); d.lists[key] = values; write(d); },
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
    async getJson(key) { const v = await cmd(["GET", `sw:${key}`]); return v ? JSON.parse(v) : null; },
    async setJson(key, value, ttlSec) { await cmd(ttlSec ? ["SET", `sw:${key}`, JSON.stringify(value), "EX", ttlSec] : ["SET", `sw:${key}`, JSON.stringify(value)]); },
    async delKey(key) { await cmd(["DEL", `sw:${key}`]); },
    async listPush(key, value, max = 200) { await cmd(["LPUSH", `sw:${key}`, JSON.stringify(value)]); await cmd(["LTRIM", `sw:${key}`, 0, max - 1]); },
    async listRange(key, n = 50) { return ((await cmd(["LRANGE", `sw:${key}`, 0, n - 1])) || []).map((x) => JSON.parse(x)); },
    async listReplace(key, values) {
      await cmd(["DEL", `sw:${key}`]);
      if (values.length) await cmd(["RPUSH", `sw:${key}`, ...values.map((v) => JSON.stringify(v))]);
    },
  };
}

function createStore(config) {
  if (config.redis) return redisRestStore(config.redis);
  return fileStore(config.dataFile || path.join(process.cwd(), ".data", "waitlist.json"));
}

module.exports = { createStore, memoryStore, fileStore, redisRestStore };
