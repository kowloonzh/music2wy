// ne.mjs — 网易云音乐客户端：登录（扫码）、搜索、歌词、云盘、歌单。零 npm 依赖。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IV = Buffer.from('0102030405060708');
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud');
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const aesCbc = (buf, key) => { const c = crypto.createCipheriv('aes-128-cbc', key, IV); return Buffer.concat([c.update(buf), c.final()]); };
const aesEcb = (buf, key) => { const c = crypto.createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(buf), c.final()]); };

export function weapi(object) {
  const text = JSON.stringify(object);
  const sk = crypto.randomBytes(16).map((n) => BASE62.charAt(n % 62).charCodeAt());
  const first = aesCbc(Buffer.from(text), PRESET_KEY).toString('base64');
  const params = aesCbc(Buffer.from(first), Buffer.from(sk)).toString('base64');
  const rev = Buffer.from(sk.slice().reverse());
  const padded = Buffer.concat([Buffer.alloc(128 - rev.length), rev]);
  const encSecKey = crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex');
  return { params, encSecKey };
}

export function eapi(urlPath, object) {
  const text = JSON.stringify(object);
  const digest = crypto.createHash('md5').update(`nobody${urlPath}use${text}md5forencrypt`).digest('hex');
  const data = `${urlPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return aesEcb(Buffer.from(data), EAPI_KEY).toString('hex').toUpperCase();
}

// ------------------------------------------------------------------ 配置与登录态
export const HOME = process.env.MUSIC2WY_HOME || path.join(os.homedir(), '.music2wy');
export const COOKIE_FILE = path.join(HOME, 'cookie.json');
// 兼容旧项目（musicbridge）已经导出的 cookie，避免用户重复登录
const LEGACY_COOKIE = path.join(os.homedir(), '.musicbridge', 'cookie.json');

export function loadJar() {
  if (process.env.NE_COOKIE) {
    const j = {};
    for (const kv of process.env.NE_COOKIE.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) j[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    return j;
  }
  for (const f of [COOKIE_FILE, LEGACY_COOKIE]) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

/**
 * 实际正在使用的登录态文件：优先 ~/.music2wy/cookie.json，
 * 没有就回退到旧 musicbridge 导出的 ~/.musicbridge/cookie.json。
 */
export function activeCookieFile() {
  if (process.env.NE_COOKIE) return '(来自环境变量 NE_COOKIE)';
  if (fs.existsSync(COOKIE_FILE)) return COOKIE_FILE;
  if (fs.existsSync(LEGACY_COOKIE)) return `${LEGACY_COOKIE}  ← 旧 musicbridge 登录态；建议改用 login 扫码`;
  return `${COOKIE_FILE}（不存在，请先 login）`;
}

export function saveJar(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const cur = (() => { try { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch { return {}; } })();
  Object.assign(cur, patch);
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cur, null, 1));
  try { fs.chmodSync(COOKIE_FILE, 0o600); } catch { /* ignore */ }
  return cur;
}

export const cookieString = (jar = loadJar()) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
export const loggedIn = (jar = loadJar()) => !!jar.MUSIC_U;

function headers(ck, extra = {}) {
  return { 'User-Agent': UA, Referer: 'https://music.163.com/', Origin: 'https://music.163.com', Cookie: ck, ...extra };
}

function collectSetCookies(res) {
  const out = {};
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const kv = line.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

async function post(url, body, ck, form = true) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(ck, form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    body: form ? new URLSearchParams(body).toString() : body,
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text, cookies: collectSetCookies(res) };
}

export async function weapiCall(pathname, data = {}, { host = 'https://music.163.com', jar } = {}) {
  const p = weapi(data);
  const url = /^https?:/.test(pathname) ? pathname : host + pathname;
  return post(url, p, cookieString(jar ?? loadJar()));
}

export async function eapiCall(urlPath, data = {}) {
  const payload = {
    ...data,
    header: {
      osver: '', deviceId: '', appver: '9.1.0', versioncode: '140', mobilename: '',
      buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080',
      __csrf: '', os: 'pc', channel: '', requestId: `${Date.now()}_0000`,
    },
  };
  return post('https://interface.music.163.com' + urlPath, eapi(urlPath, payload), cookieString());
}

// ------------------------------------------------------------------ 登录
export async function account() {
  const r = await weapiCall('/weapi/w/nuser/account/get', { os: 'pc' });
  return r.body;
}

/** 申请一个扫码登录用的 unikey，返回 {unikey, url}。 */
export async function qrCreate() {
  const r = await weapiCall('/weapi/login/qrcode/unikey', { type: 1 });
  const b = r.body || {};
  if (b.code !== 200 || !b.unikey) throw new Error(`申请二维码失败: ${JSON.stringify(b).slice(0, 200)}`);
  return { unikey: b.unikey, url: `https://music.163.com/login?codekey=${b.unikey}` };
}

/** 查询扫码状态。800=过期 801=等待扫码 802=待确认 803=成功。 */
export async function qrPoll(unikey) {
  const r = await weapiCall('/weapi/login/qrcode/client/login', { key: unikey, type: 1 });
  const b = r.body || {};
  if (b.code === 803) {
    const jar = { ...(r.cookies || {}) };
    if (!jar.MUSIC_U) throw new Error('扫码成功但没有拿到 MUSIC_U，无法保存登录态');
    saveJar(jar);
  }
  return { code: b.code, message: b.message, jar: b.code === 803 ? r.cookies : undefined };
}

/**
 * 完整的扫码登录流程。
 * @param {(info:{url:string, pngPath?:string, terminal:string, ascii:string})=>void} onQr
 * @param {number} timeoutMs
 */
export async function qrLogin({ onQr, timeoutMs = 180000, intervalMs = 2000, pngPath } = {}) {
  const { unikey, url } = await qrCreate();
  if (onQr) onQr({ url, unikey });
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const st = await qrPoll(unikey);
    if (st.code === 803) return { ok: true, url };
    // 800 = 二维码过期，重新申请一次
    if (st.code === 800) return { ok: false, expired: true, url };
    if (st.code !== last) last = st.code;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, timeout: true, url };
}

// ------------------------------------------------------------------ 搜索 / 歌词
export async function searchSongs(keyword, limit = 10) {
  const r = await weapiCall('https://music.163.com/weapi/cloudsearch/get/web', {
    s: keyword, type: 1, limit: Number(limit), offset: 0, total: true,
  });
  const songs = (((r.body || {}).result || {}).songs) || [];
  return {
    code: (r.body || {}).code,
    songs: songs.map((s) => ({
      id: s.id,
      name: s.name,
      artists: (s.ar || []).map((a) => a.name).join('/'),
      album: (s.al || {}).name,
      duration: Math.round((s.dt || 0) / 1000),
      cover: (s.al || {}).picUrl,
      fee: s.fee,
    })),
  };
}

export async function lyrics(songId) {
  const r = await weapiCall('/weapi/song/lyric', { id: Number(songId), lv: -1, kv: -1, tv: -1 });
  const b = r.body || {};
  return { code: b.code, lrc: (b.lrc || {}).lyric || null, tlyric: (b.tlyric || {}).lyric || null };
}

// ------------------------------------------------------------------ 云盘 / 歌单
export async function cloudList(limit = 100, offset = 0) {
  const r = await weapiCall('/weapi/v1/cloud/get', { limit: Number(limit), offset: Number(offset), sync: false });
  return r.body;
}

export async function playlists(uid) {
  const r = await weapiCall('/weapi/user/playlist', { uid: Number(uid), limit: 100, offset: 0, includeVideo: true });
  return r.body;
}

export async function playlistCreate(name) {
  return (await weapiCall('/weapi/playlist/create', { name })).body;
}

export async function playlistAdd(pid, ids) {
  const r = await weapiCall('/weapi/playlist/manipulate/tracks', {
    op: 'add', pid: Number(pid), trackIds: JSON.stringify(ids.map(Number)),
  });
  return r.body;
}

/**
 * 从云盘删除歌曲。
 * 接口：`POST /weapi/cloud/del`，参数 `songIds` 是 JSON 数组字符串。
 * 返回 `{code, succIds, failIds}` —— code 200 表示全部成功，其它值看 succIds 判断实际删掉了哪些。
 */
export async function cloudDelete(songIds) {
  const ids = (Array.isArray(songIds) ? songIds : [songIds]).map(Number).filter(Boolean);
  if (!ids.length) return { code: 400, succIds: [], failIds: [], error: '没有有效的 songId' };
  const r = await weapiCall('/weapi/cloud/del', { songIds: JSON.stringify(ids) });
  const b = r.body || {};
  return {
    code: b.code,
    succIds: b.succIds || [],
    failIds: b.failIds || [],
    ok: (b.succIds || []).length === ids.length,
    raw: b,
  };
}
