#!/usr/bin/env node
/**
 * flac_client.mjs — zero-dependency Node client for https://flac.music.hi.cn/
 *
 * Solves the chaitin SafeLine (雷池) JS challenge in pure Node (no browser), then
 * exposes the site's own ajax.php API:
 *
 *   node flac_client.mjs search "<keyword>" [--limit 10] [--platform kuwo] [--size 20] [--no-cache]
 *   node flac_client.mjs resolve --platform kuwo --songid <id> --time <t> --sign <s> \
 *                               [--format flac] [--bitrate 2000] [--dry-run]
 *   node flac_client.mjs download --url <url> --out <path> [--referer <url>]
 *   node flac_client.mjs session [--refresh]        # show / re-solve the WAF session
 *   node flac_client.mjs fetch <url> [--out file]   # authenticated GET (for recon)
 *
 * Everything is cached under ~/.music2wy/ so repeat calls do not re-hit the site.
 *
 * Exit code 0 = ok, 1 = error.  All output is a single JSON object on stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ config */

const BASE = 'https://flac.music.hi.cn';
const CHALLENGE_HOST = 'https://challenge.rivers.chaitin.cn';
const HOME = path.join(os.homedir(), '.music2wy');
const CACHE_DIR = path.join(HOME, 'cache');
const SESSION_FILE = path.join(HOME, 'session.json');
const ARTIFACT_DIR = path.join(HOME, 'artifacts');

const UA =
  process.env.FLAC_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const HTML_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const AJAX_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: BASE,
  Referer: BASE + '/',
};

/* Rate limiting / politeness. The site is behind a WAF with 限流.
 * Keep a *global* minimum gap between requests to the same host.
 *
 * 注意：CLI 每次调用都是新进程，只靠内存里的 Map 不够 —— 跨进程必须落盘，
 * 否则 `search` 和 `get` 连续两次调用之间不会有任何间隔。这里用一个闸门文件
 * （~/.music2wy/ratelimit.json）保证同一台机器上任意两次站点请求都满足最小间隔。 */
const MIN_GAP_DEFAULT = 8000;
// 每次调用时读环境变量，这样编排层可以在启动时按配置覆盖它
const minGap = () => Number(process.env.FLAC_MIN_GAP_MS || MIN_GAP_DEFAULT);
const _lastHit = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_FILE = path.join(HOME, 'ratelimit.json');

function readGate() {
  try { return JSON.parse(fs.readFileSync(RATE_FILE, 'utf8')); } catch { return {}; }
}
function writeGate(state) {
  try { mkdirs(); fs.writeFileSync(RATE_FILE, JSON.stringify(state)); } catch { /* ignore */ }
}

async function polite(host) {
  mkdirs();
  const gap = minGap();
  // 进程内 + 跨进程，取较晚的那个时间点
  const state = readGate();
  const last = Math.max(_lastHit.get(host) || 0, state[host] || 0);
  const wait = last + gap - Date.now();
  if (wait > 0) {
    log(`限流闸门：再等 ${Math.ceil(wait / 1000)}s（最小间隔 ${gap}ms）`);
    await sleep(wait);
  }
  const now = Date.now();
  _lastHit.set(host, now);
  writeGate({ ...readGate(), [host]: now });
}

/* --------------------------------------------------------------- utilities */

function mkdirs() {
  for (const d of [HOME, CACHE_DIR, ARTIFACT_DIR]) fs.mkdirSync(d, { recursive: true });
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/* --------------------------------------------------- 请求记账
 * 站点很敏感，所以每一次真正打到站点的请求都落一条记录（~/.music2wy/logs/requests.jsonl）。
 * 用途：事后能回答"这次跑一共打了几个请求"，以及判断是不是把配额用光了。
 * 注意只记站点域名，不记 CDN 下载。 */
const REQ_LOG = path.join(HOME, 'logs', 'requests.jsonl');
export const REQUEST_LOG_PATH = REQ_LOG;

export function recordRequest(entry) {
  try {
    fs.mkdirSync(path.dirname(REQ_LOG), { recursive: true });
    fs.appendFileSync(REQ_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* 记账失败绝不影响主流程 */ }
}

/** 包一层 fetch：记录耗时和结果，再把响应原样返回。 */
async function timedFetch(url, opts) {
  const t0 = Date.now();
  const path_ = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  try {
    const r = await fetch(url, opts);
    recordRequest({ kind: 'site', path: path_, method: (opts && opts.method) || 'GET', status: r.status, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    recordRequest({ kind: 'site', path: path_, method: (opts && opts.method) || 'GET', status: null, ms: Date.now() - t0, error: String(e && e.message || e) });
    throw e;
  }
}

/** 读回请求记录，用于 `music2wy stats`。 */
export function readRequestLog() {
  try {
    return fs.readFileSync(REQ_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  mkdirs();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** Write a cache entry: <key>.meta.json + <key>.body */
function cachePut(key, { url, method, status, headers, body }) {
  mkdirs();
  const k = key.slice(0, 120);
  fs.writeFileSync(path.join(CACHE_DIR, k + '.body'), body);
  fs.writeFileSync(
    path.join(CACHE_DIR, k + '.meta.json'),
    JSON.stringify({ url, method, status, headers, at: new Date().toISOString(), bytes: body.length }, null, 2)
  );
}

function cacheGet(key) {
  const k = key.slice(0, 120);
  const metaFile = path.join(CACHE_DIR, k + '.meta.json');
  const bodyFile = path.join(CACHE_DIR, k + '.body');
  if (!fs.existsSync(metaFile) || !fs.existsSync(bodyFile)) return null;
  const meta = readJSON(metaFile, {});
  return { ...meta, body: fs.readFileSync(bodyFile, 'utf8') };
}

function log(...a) {
  if (process.env.FLAC_VERBOSE) console.error('[flac]', ...a);
}

/* --------------------------------------------------- SafeLine WAF challenge */

/**
 * The observed flow (see FINDINGS.md):
 *   1. GET /            -> 468 challenge page + Set-Cookie sl-session=...
 *                          The page embeds SafeLineChallenge("<client_id>", {level:"N"})
 *                          client_id is DYNAMIC (changes on every page load!).
 *   2. POST <challenge>/challenge/v2/api/issue   {client_id, level} -> {data:{data:[...], issue_id}}
 *   3. GET  <challenge>/challenge/v2/calc.wasm   -> tiny wasm with reset/arg/calc/ret
 *   4. compute result = Array(calc()).fill(-1).map(() => ret())
 *   5. POST <challenge>/challenge/v2/api/verify  {issue_id, result, serials, client}
 *        -> {code:200, data:{verified:true, jwt:"<ES256 JWT>"}}
 *   6. cookie sl-challenge-jwt=<jwt>; path=/  (set on the *site* domain)
 *   Then the site returns 200 when both sl-session and sl-challenge-jwt are sent.
 */

function parseChallenge(html) {
  const m = /SafeLineChallenge\(\s*"([^"]+)"\s*,\s*\{([^}]*)\}/.exec(html);
  if (!m) return null;
  const client_id = m[1];
  const levelM = /level\s*:\s*"?(\d+)"?/.exec(m[2]);
  return { client_id, level: levelM ? parseInt(levelM[1], 10) : 1 };
}

/** Pure-JS replica of calc.wasm (verified byte-identical on live issues). */
function calcJS(arr) {
  let t = 1;
  const sum = arr.reduce((a, b) => a + b, 0);
  for (let r = ((6 + arr.length + sum) % 6) + 6; r--; ) t *= 6;
  if (t < 6666) t *= arr.length;
  if (t > 0x3f940aa) t = Math.floor(t / arr.length);
  for (let o = 0; o < arr.length; o++) {
    t += Math.pow(arr[o], 3);
    t ^= o;
    t ^= arr[o] + o;
  }
  const out = [];
  while (t > 0) {
    out.unshift(t & 63);
    t >>>= 6;
  }
  return out;
}

let _wasmModule = null;

async function getWasm() {
  if (_wasmModule) return _wasmModule;
  const cached = path.join(ARTIFACT_DIR, 'calc.wasm');
  let buf;
  if (fs.existsSync(cached)) {
    buf = fs.readFileSync(cached);
    log('calc.wasm from cache', buf.length, 'bytes');
  } else {
    await polite('challenge.rivers.chaitin.cn');
    const r = await fetch(`${CHALLENGE_HOST}/challenge/v2/calc.wasm`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`calc.wasm HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    mkdirs();
    fs.writeFileSync(cached, buf);
    log('calc.wasm downloaded', buf.length, 'bytes');
  }
  try {
    const mod = await WebAssembly.instantiate(buf);
    _wasmModule = mod.instance.exports;
    return _wasmModule;
  } catch (e) {
    log('wasm instantiate failed, using pure-JS calc:', e.message);
    _wasmModule = null;
    return null;
  }
}

async function postJSON(url, obj) {
  await polite(new URL(url).host);
  recordRequest({ kind: 'challenge', path: new URL(url).pathname, method: 'POST' });
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(obj),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Solve the challenge. Returns { cookies, client_id, level, result } */
async function solveChallenge(html, slSession) {
  recordRequest({ kind: 'challenge-solve', path: 'solve', note: '开始解挑战' });
  const ch = parseChallenge(html);
  if (!ch) throw new Error('challenge page has no SafeLineChallenge(...) call');
  log('challenge client_id=', ch.client_id, 'level=', ch.level);

  const issue = await postJSON(`${CHALLENGE_HOST}/challenge/v2/api/issue`, {
    client_id: ch.client_id,
    level: ch.level,
  });
  if (issue.code !== 200 || !issue.data) throw new Error('issue failed: ' + JSON.stringify(issue).slice(0, 200));

  const ex = await getWasm();
  let result;
  if (ex) {
    ex.reset();
    issue.data.data.forEach((x) => ex.arg(x));
    result = Array(ex.calc()).fill(-1).map(() => ex.ret());
  } else {
    result = calcJS(issue.data.data);
  }
  log('calc result=', JSON.stringify(result));

  const client = {
    userAgent: UA,
    platform: 'MacIntel',
    language: 'zh-CN,zh,en',
    vendor: 'Google Inc.',
    screen: [1470, 956],
    visitorId: sha256(UA + os.hostname()).slice(0, 32),
    score: 0,
    target: [],
  };

  const verify = await postJSON(`${CHALLENGE_HOST}/challenge/v2/api/verify`, {
    issue_id: issue.data.issue_id,
    result,
    serials: [],
    client,
  });
  if (verify.code !== 200 || !verify.data || !verify.data.verified) {
    throw new Error('verify failed: ' + JSON.stringify(verify).slice(0, 300));
  }
  log('verified, jwt=', String(verify.data.jwt).slice(0, 32) + '...');

  return {
    cookies: { 'sl-session': slSession, 'sl-challenge-jwt': verify.data.jwt },
    client_id: ch.client_id,
    level: ch.level,
    result,
  };
}

/* -------------------------------------------------------------- cookie jar */

function loadSession() {
  return readJSON(SESSION_FILE, null);
}

function saveSession(s) {
  writeJSON(SESSION_FILE, { ...s, savedAt: new Date().toISOString() });
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Merge a response's Set-Cookie header(s) into the jar.
 *
 * This is the heart of the WAF session mechanism: the *successful* exchange
 * response returns
 *   sl_jwt_session=<T>; Path=/; Max-Age=3600; HttpOnly
 *   sl_jwt_sign=;      Path=/; Max-Age=3600; HttpOnly
 *   sl-challenge-jwt=; Path=/; Max-Age=1            <-- one-shot token is consumed
 * so `sl-challenge-jwt` must be dropped and `sl_jwt_session` kept for the next
 * hour. Returns true when the jar changed.
 */
function mergeSetCookie(jar, headers) {
  let list = [];
  if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
  else {
    const raw = headers.get('set-cookie');
    if (raw) list = [raw];
  }
  let changed = false;
  for (const c of list) {
    const m = /^\s*([A-Za-z0-9_\-.[\]]+)=([^;]*)/.exec(c);
    if (!m) continue;
    const name = m[1];
    const value = m[2];
    const maxAge = /Max-Age=(-?\d+)/i.exec(c);
    const expired = value === '' || (maxAge && Number(maxAge[1]) <= 1);
    if (expired) {
      if (name in jar) {
        delete jar[name];
        changed = true;
      }
    } else if (jar[name] !== value) {
      jar[name] = value;
      changed = true;
    }
  }
  return changed;
}

/* ------------------------------------------------------- HTTP with the WAF */

class RateLimited extends Error {}

function looksLikeChallenge(status, body) {
  return status === 468 || /SafeLineChallenge\s*\(/.test(body || '');
}

/**
 * Fetch a URL on the site, transparently solving/refreshing the WAF session.
 * `opts.cacheKey` enables the on-disk response cache.
 */
async function siteFetch(url, opts = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    cacheKey = null,
    ttlMs = 24 * 3600 * 1000,
    allowCache = true,
  } = opts;

  if (allowCache && cacheKey && method === 'GET') {
    const hit = cacheGet(cacheKey);
    if (hit && Date.now() - Date.parse(hit.at) < ttlMs) {
      log('cache hit', cacheKey);
      return { status: hit.status, body: hit.body, headers: hit.headers || {}, cached: true };
    }
  }

  let session = loadSession();
  const jar = { ...((session && session.cookies) || {}) };

  await polite(new URL(url).host);
  let r = await timedFetch(url, {
    method,
    redirect: 'manual',
    headers: { ...(method === 'GET' ? HTML_HEADERS : AJAX_HEADERS), ...headers, ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) },
    body,
  });
  let text = await r.text();

  if (looksLikeChallenge(r.status, text)) {
    log('WAF challenge hit -> solving');
    const before = cookieHeader(jar);
    mergeSetCookie(jar, r.headers);
    const slSession = jar['sl-session'] || null;
    if (!slSession) throw new Error('WAF challenge page did not Set-Cookie sl-session');

    // 先走纯 Node 复现（快、零依赖）。失败、或解完仍然 468 时，
    // 如果开了 --browser，就用真浏览器兜底再试一次。
    let solved = null;
    let pureError = null;
    try {
      solved = await solveChallenge(text, slSession);
      Object.assign(jar, solved.cookies);
      saveSession({ cookies: jar, client_id: solved.client_id, level: solved.level });
    } catch (e) {
      pureError = e;
      log('pure-Node challenge solve failed ->', e.message);
    }

    if (solved) {
      await polite(new URL(url).host);
      r = await timedFetch(url, {
        method,
        redirect: 'manual',
        headers: {
          ...(method === 'GET' ? HTML_HEADERS : AJAX_HEADERS),
          ...headers,
          Cookie: cookieHeader(jar),
        },
        body,
      });
      text = await r.text();

      // The exchange response hands us the long-lived sl_jwt_session cookie and
      // consumes sl-challenge-jwt. Persist it so later runs skip the challenge.
      if (mergeSetCookie(jar, r.headers) || cookieHeader(jar) !== before) {
        saveSession({ cookies: jar, client_id: solved.client_id, level: solved.level });
        log('session exchanged ->', Object.keys(jar).join(','));
      }
    }

    if (!solved || looksLikeChallenge(r.status, text)) {
      if (process.env.MUSIC2WY_BROWSER_FALLBACK !== '1') {
        if (pureError) throw pureError;
        throw new Error(`WAF challenge still failing after solve (HTTP ${r.status})；`
          + '可以加 --browser 让脚本启动真浏览器兜底解一次');
      }
      // ------------------- 真浏览器兜底 -------------------
      log('改用真浏览器兜底解挑战 …');
      const { browserSolve } = await import('./browser.mjs');
      const res = await browserSolve({
        url: BASE + '/',
        headed: process.env.MUSIC2WY_BROWSER_HEADED === '1',
        prefer: process.env.MUSIC2WY_BROWSER_PATH || 'auto',
        log: (m) => log(m),
      });
      Object.assign(jar, res.cookies);
      saveSession({ cookies: jar, via: res.via, solvedAt: new Date().toISOString() });

      await polite(new URL(url).host);
      r = await timedFetch(url, {
        method,
        redirect: 'manual',
        headers: {
          ...(method === 'GET' ? HTML_HEADERS : AJAX_HEADERS),
          ...headers,
          Cookie: cookieHeader(jar),
        },
        body,
      });
      text = await r.text();
      mergeSetCookie(jar, r.headers);
      saveSession({ cookies: jar, via: res.via, solvedAt: new Date().toISOString() });

      if (looksLikeChallenge(r.status, text)) {
        throw new Error(`浏览器兜底之后站点仍然返回挑战页（HTTP ${r.status}）。可能是浏览器出口 IP 和 `
          + 'Node 直连 IP 不一致（可试 MUSIC2WY_CHROME_USE_PROXY=1），或者站点就是在拦自动化浏览器。');
      }
      log('browser fallback session OK ->', Object.keys(jar).join(','));
    }
  } else if (mergeSetCookie(jar, r.headers)) {
    // Ordinary cookie rotation (e.g. a refreshed sl_jwt_session).
    saveSession({ cookies: jar, client_id: session?.client_id ?? null, level: session?.level ?? null });
    log('cookies updated ->', Object.keys(jar).join(','));
  }

  if (r.status === 429) throw new RateLimited(`HTTP 429 from ${url}`);

  if (allowCache && cacheKey) {
    cachePut(cacheKey, { url, method, status: r.status, headers: Object.fromEntries(r.headers), body: text });
  }
  return { status: r.status, body: text, headers: Object.fromEntries(r.headers), cached: false };
}

/* ------------------------------------------------------------------- APIs */

function form(obj) {
  return new URLSearchParams(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
}

/** POST ajax.php?act=... and parse JSON. */
async function ajax(act, params, { cacheKey = null, allowCache = true } = {}) {
  const url = `${BASE}/ajax.php?act=${act}`;
  const res = await siteFetch(url, {
    method: 'POST',
    body: form(params),
    cacheKey,
    allowCache,
  });

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    const snippet = res.body.replace(/\s+/g, ' ').slice(0, 400);
    if (/SafeLineChallenge/.test(res.body)) throw new Error(`WAF challenge page returned for ${act}`);
    if (/限流|频繁|too many|请求过快/.test(res.body)) throw new RateLimited(`site says rate limited: ${snippet}`);
    throw new Error(`ajax.php?act=${act} returned non-JSON (HTTP ${res.status}): ${snippet}`);
  }
  return { json, res };
}

/**
 * 不同上游平台的 duration 单位不一样：`kuwo` 给的是**秒**（"246"），
 * `wyy` 给的是**毫秒**（"270738"）。统一归一化成秒，否则显示和时长校验全是错的。
 */
function toSeconds(v) {
  const n = Number(v || 0);
  if (!n || !Number.isFinite(n)) return 0;
  return n > 10000 ? Math.round(n / 1000) : Math.round(n);
}

/** Search a platform for a keyword. */
export async function search(keyword, { platform = 'kuwo', page = 1, size = 20, allowCache = true } = {}) {
  const params = { platform, keyword, page, size };
  const key = 'search-' + sha256(JSON.stringify(params));
  const { json, res } = await ajax('search', params, { cacheKey: key, allowCache });

  if (json && json.code !== 0 && json.code !== 200) {
    throw new Error(`search failed: code=${json.code} msg=${json.msg || ''}`);
  }
  const data = json?.data ?? {};
  const rows = Array.isArray(data.list) ? data.list : [];
  const list = rows.map((it) => ({
    platform,
    songid: it.id ?? it.songid ?? null,
    name: it.name ?? null,
    artist: it.artist ?? null,
    album: it.album_name ?? it.album ?? null,
    duration: toSeconds(it.duration),
    hasHQ: it.hasHQ ?? null,
    hasSQ: it.hasSQ ?? null,
    cover: it.pic_url ?? it.pic ?? null,
    link: it.link ?? null,
    time: it.time ?? null,
    sign: it.sign ?? null,
    minfo: it.minfo ?? [],
  }));

  return {
    ok: true,
    cached: !!res.cached,
    platform,
    keyword,
    total: data.total ?? list.length,
    list,
  };
}

/** Resolve a CDN direct link. `time` + `sign` come from a search result. */
export async function resolve({ platform, songid, time, sign, format = 'flac', bitrate = 2000 }) {
  const params = { platform, songid, format, bitrate, time, sign };
  const { json } = await ajax('getUrl', params, { allowCache: false });
  if (json && json.code !== 0 && json.code !== 200) {
    return { ok: false, code: json.code, msg: json.msg || null, raw: json, url: null };
  }
  const data = json?.data ?? {};
  return { ok: !!data.url, code: json?.code, raw: json, url: data.url ?? null, ...data };
}

/**
 * 取歌词。同样是 `time` + `sign`（来自搜索结果），返回 LRC 文本。
 *
 * 这个接口很有用：网易云没有版权的歌（例如周杰伦的作品）拿不到官方歌词，
 * 但音源站这边通常能直接给到 .lrc。
 *
 * @returns {Promise<{ok:boolean, lrc:string|null, code?:number, msg?:string|null}>}
 */
export async function lyric({ platform, songid, time, sign }) {
  const { json } = await ajax('getLyric', { platform, songid, time, sign }, { allowCache: false });
  if (!json || (json.code !== 0 && json.code !== 200)) {
    return { ok: false, lrc: null, code: json?.code, msg: json?.msg || null };
  }
  const text = typeof json.data === 'string' ? json.data : json.data?.lyric || null;
  return { ok: !!text && text.trim().length > 0, lrc: text, code: json.code };
}

/**
 * Choose a matching entry from a search result's `minfo[]`.
 * Each entry looks like { format: "flac"|"mp3", bitrate: "2000"|"320", size: "28.6MB" }.
 */
export function pickQuality(minfo, { format = 'flac', bitrate = null } = {}) {
  const list = Array.isArray(minfo) ? minfo : [];
  if (!list.length) return null;
  let cands = list.filter((m) => String(m.format).toLowerCase() === String(format).toLowerCase());
  if (!cands.length) return null;
  if (bitrate != null) {
    const exact = cands.find((m) => String(m.bitrate) === String(bitrate));
    if (exact) return exact;
  }
  // highest bitrate wins (lossless formats commonly report 1000/2000)
  return cands.slice().sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
}

/** Download a CDN link with the headers the CDN expects. */
export async function download(url, out, { referer = BASE + '/' } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!r.ok) throw new Error(`download HTTP ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, buf);
  return {
    ok: true,
    bytes: buf.length,
    out: path.resolve(out),
    contentType: r.headers.get('content-type') || null,
    contentLength: r.headers.get('content-length') || null,
  };
}

/* ------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  mkdirs();

  if (!cmd || cmd === 'help' || cmd === '--help') {
    print({
      ok: true,
      usage: [
        'flac_client.mjs search "<keyword>" [--limit 10] [--platform kuwo] [--size 20] [--no-cache]',
        'flac_client.mjs resolve --platform kuwo --songid <id> --time <t> --sign <s> [--format flac] [--bitrate 2000]',
        'flac_client.mjs download --url <url> --out <path>',
        'flac_client.mjs get "<keyword>" [--pick 1] [--format flac] [--bitrate 2000] [--out dir]',
        'flac_client.mjs session [--refresh]',
        'flac_client.mjs fetch <url> [--out file]',
      ],
      note: 'Session + response cache live in ~/.music2wy/',
    });
    return;
  }

  if (cmd === 'session') {
    if (a.refresh) {
      try {
        fs.rmSync(SESSION_FILE, { force: true });
      } catch {}
    }
    const res = await siteFetch(BASE + '/', { headers: HTML_HEADERS });
    const s = loadSession();
    const jar = s?.cookies || {};
    const mask = (v) => (v ? String(v).slice(0, 10) + '…(' + String(v).length + ')' : v);
    print({
      ok: res.status === 200,
      status: res.status,
      session_file: SESSION_FILE,
      has_long_lived_session: !!jar['sl_jwt_session'],
      cookies: Object.fromEntries(Object.entries(jar).map(([k, v]) => [k, mask(v)])),
      client_id: s?.client_id ?? null,
      savedAt: s?.savedAt ?? null,
      note: 'sl_jwt_session is a 1h HttpOnly session; sl-challenge-jwt is one-shot and gets consumed.',
    });
    return;
  }

  if (cmd === 'fetch') {
    const url = a._[0];
    if (!url) throw new Error('fetch requires a URL');
    const res = await siteFetch(url, { cacheKey: a.cache ? 'fetch-' + sha256(url) : null });
    if (a.out) {
      fs.writeFileSync(a.out, res.body);
      print({ ok: true, status: res.status, bytes: Buffer.byteLength(res.body), out: path.resolve(a.out) });
    } else {
      process.stdout.write(res.body);
    }
    return;
  }

  if (cmd === 'search') {
    const kw = a._[0];
    if (!kw) throw new Error('search requires a keyword');
    const limit = a.limit ? parseInt(a.limit, 10) : 10;
    const r = await search(kw, {
      platform: a.platform || 'kuwo',
      page: a.page ? parseInt(a.page, 10) : 1,
      size: a.size ? parseInt(a.size, 10) : 20,
      allowCache: !a['no-cache'],
    });
    r.list = r.list.slice(0, limit);
    r.shown = r.list.length;
    print(r);
    return;
  }

  if (cmd === 'resolve') {
    for (const k of ['platform', 'songid', 'time', 'sign']) {
      if (a[k] === undefined) throw new Error(`resolve requires --${k}`);
    }
    const r = await resolve({
      platform: a.platform,
      songid: a.songid,
      time: a.time,
      sign: a.sign,
      format: a.format || 'flac',
      bitrate: a.bitrate || 2000,
    });
    print(r);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'get') {
    // search -> pick -> resolve -> download, in one shot
    const kw = a._[0];
    if (!kw) throw new Error('get requires a keyword');
    const platform = a.platform || 'kuwo';
    const pick = a.pick ? parseInt(a.pick, 10) : 1;
    const s = await search(kw, {
      platform,
      size: a.size ? parseInt(a.size, 10) : 20,
      allowCache: !a['no-cache'],
    });
    const song = s.list[pick - 1];
    if (!song) throw new Error(`only ${s.list.length} results, cannot pick #${pick}`);
    const wantFormat = a.format || 'flac';
    let q = pickQuality(song.minfo, { format: wantFormat, bitrate: a.bitrate ?? null });
    if (!q) {
      q = pickQuality(song.minfo, { format: 'mp3', bitrate: a.bitrate ?? null });
      if (!q) throw new Error(`no usable quality for ${song.name}: ${JSON.stringify(song.minfo)}`);
    }
    const r = await resolve({
      platform,
      songid: song.songid,
      time: song.time,
      sign: song.sign,
      format: q.format,
      bitrate: q.bitrate,
    });
    if (!r.ok) {
      print({ ok: false, stage: 'resolve', chosen: song, quality: q, response: r });
      process.exitCode = 1;
      return;
    }
    const outDir = a.out || path.join(HOME, 'downloads');
    const safe = `${song.name} - ${song.artist}`.replace(/[/\\:*?"<>|]/g, '_');
    const out = path.join(outDir, `${safe}.${String(q.format).toLowerCase()}`);
    const dl = await download(r.url, out);
    print({ ok: true, chosen: song, quality: q, url: r.url, ...dl });
    return;
  }

  if (cmd === 'download') {
    if (!a.url) throw new Error('download requires --url');
    if (!a.out) throw new Error('download requires --out');
    const r = await download(a.url, a.out, { referer: a.referer || BASE + '/' });
    print(r);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    print({ ok: false, error: String(e && e.message ? e.message : e), kind: e instanceof RateLimited ? 'rate_limited' : 'error' });
    process.exit(1);
  });
}

export { siteFetch, BASE, UA, SESSION_FILE, CACHE_DIR, parseChallenge, calcJS, solveChallenge };
