// util.mjs — 路径、JSON 输出、限流与磁盘缓存。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const HOME = process.env.MUSIC2WY_HOME || path.join(os.homedir(), '.music2wy');
export const CACHE_DIR = path.join(HOME, 'cache');
export const DOWNLOAD_DIR = process.env.MUSIC2WY_DOWNLOAD_DIR || path.join(HOME, 'downloads');
export const LOG_DIR = path.join(HOME, 'logs');
export const CONFIG_FILE = path.join(HOME, 'config.json');

export function ensureDirs() {
  for (const d of [HOME, CACHE_DIR, DOWNLOAD_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function loadConfig() {
  const defaults = {
    // 站点请求之间的最小间隔（毫秒）。站点风控很敏感，默认 15 秒，偏保守。
    minRequestIntervalMs: 15000,
    // 搜索结果缓存时长（毫秒）。默认 30 分钟，避免"选歌"时重复打站点。
    searchCacheTtlMs: 30 * 60 * 1000,
    // 解析出的直链缓存时长（毫秒）。站点 sign/time 会过期，且 CDN 链接本身有时效。
    urlCacheTtlMs: 20 * 60 * 1000,
    // 默认音质：flac > 320
    quality: 'flac',
    // 上传到云盘后是否发布（网易云需要 publish 才能在云盘列表匹配到）
    publish: true,
    neteasePlaylist: null,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}

export function saveConfig(patch) {
  ensureDirs();
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ------------------------------------------------------------------ 输出
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function fail(message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + '\n');
  process.exit(1);
}

export function human(bytes) {
  if (!bytes && bytes !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

export function mmss(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function safeFilename(s) {
  return String(s).replace(/[/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ------------------------------------------------------------------ 限流

/**
 * 跨进程的全局节流：保证同一台机器上任何两次站点请求之间至少间隔 minIntervalMs。
 * 站点有限流，这个"闸门"用来避免脚本重试/并发把配额打光。
 */
// 说明：跨进程的站点限流闸门在 lib/flac.mjs 的 polite() 里（每台机器一个
// ~/.music2wy/ratelimit.json），因为它拦截的是真正的出网请求点。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 缓存
const keyFile = (ns, key) => path.join(CACHE_DIR, ns, crypto.createHash('sha1').update(String(key)).digest('hex') + '.json');

export function cacheGet(ns, key, ttlMs) {
  const f = keyFile(ns, key);
  try {
    const st = fs.statSync(f);
    if (ttlMs != null && Date.now() - st.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function cacheSet(ns, key, value, meta = {}) {
  const f = keyFile(ns, key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ cachedAt: Date.now(), meta, value }, null, 1));
  return value;
}

export function cacheInfo(ns, key) {
  try {
    const st = fs.statSync(keyFile(ns, key));
    return { path: keyFile(ns, key), ageMs: Date.now() - st.mtimeMs, mtime: st.mtime };
  } catch {
    return null;
  }
}

/** 记录站点请求次数，便于诊断是否触发了限流。
 *  注：站点请求的实际记账在 lib/flac.mjs（timedFetch），写入同一个文件。 */
export function recordRequest(endpoint, ok, note = '') {
  ensureDirs();
  const f = path.join(LOG_DIR, 'requests.jsonl');
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), kind: 'util', endpoint, ok, note }) + '\n');
}
