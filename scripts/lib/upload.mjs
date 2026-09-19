#!/usr/bin/env node
/**
 * ne_upload.mjs — 网易云音乐「云盘上传」零依赖 Node 客户端（已验证可用）
 *
 * 关键点（旧实现错在这里）：
 *   1. upload/check 的正确路径是 /weapi/cloud/upload/check（不是 /api/cloud/upload/check，
 *      后者固定返回 {"code":400,"message":"参数错误"}）。
 *   2. NOS 上传地址不能写死 nos.netease.com / 45.127.129.8，必须先用
 *      https://wanproxy.127.net/lbs?version=1.0&bucketname=<bucket> 拿到上传节点，
 *      再 POST 到 <node>/<bucket>/<objectKey>?offset=0&complete=true&version=1.0。
 *      URL 里的 bucket 来自 token 响应（nos_product=3 → jd-musicrep-privatecloud-audio-public），
 *      不是固定的 "ymusic"。旧实现拼成 nos.netease.com/ymusic/<key> 才会 AccessDenied。
 *   3. 上传后必须 /weapi/upload/cloud/info/v2 + /weapi/cloud/pub/v2，否则云盘列表看不到。
 *   4. 文件必须是「能正常转码的真实音频」，随机字节会转码失败、pub 报 400、列表不出现。
 *
 * 用法:
 *   node ne_upload.mjs upload <file> [--title X] [--artist Y] [--album Z] [--no-pub] [--json]
 *   node ne_upload.mjs check  <file>
 *   node ne_upload.mjs cloud  [limit] [offset]
 *   node ne_upload.mjs status <songId>
 *   node ne_upload.mjs account
 *
 * 环境变量:
 *   MUSICBRIDGE_COOKIE  cookie JSON 文件路径（默认 ~/.musicbridge/cookie.json）
 *   NE_COOKIE           直接给 cookie 字符串（优先）
 *   NE_RAW=1            打印每一步的原始响应
 *
 * 退出码: 0 成功, 1 失败。stdout 始终输出单个 JSON 对象。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─────────────────────────── weapi 加密 ───────────────────────────
const IV = Buffer.from('0102030405060708');
const PRESET_KEY = Buffer.from('0CoJUm6Qyw8W8jud');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const aesCbcEncrypt = (buf, key) => {
  const c = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([c.update(buf), c.final()]);
};
const rsaEncryptNoPad = (buf) => {
  const padded = Buffer.concat([Buffer.alloc(128 - buf.length), buf]);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex');
};

/** weapi: params = base64(AES-CBC(AES-CBC(json, preset), randomKey)), encSecKey = RSA(randomKey reversed) */
export function weapi(object) {
  const text = JSON.stringify(object);
  const secretKey = crypto.randomBytes(16).map((n) => BASE62.charAt(n % 62).charCodeAt());
  const once = aesCbcEncrypt(Buffer.from(text, 'utf8'), PRESET_KEY).toString('base64');
  return {
    params: aesCbcEncrypt(Buffer.from(once, 'utf8'), Buffer.from(secretKey)).toString('base64'),
    encSecKey: rsaEncryptNoPad(Buffer.from(secretKey.reverse())),
  };
}

// ─────────────────────────── eapi 加密 ───────────────────────────
// 备选通道：AES-128-ECB + 固定 key e82ckenh8dichen8，路径写成 /api/xxx，body 为 params=<hex>。
// 当前云盘上传链路 weapi 已完全可用；eapi 保留给返回空体/风控时的兜底调试。
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');
const EAPI_SEP = '-36cd479b6b5-';

/** eapi: params = HEX(AES-128-ECB(md5digest-message))，签名摘要参与拼接 */
export function eapi(url, object) {
  const apiPath = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/(we)?api/, '/api');
  const text = JSON.stringify(object);
  const digest = crypto.createHash('md5').update(`nobody${apiPath}use${text}md5forencrypt`).digest('hex');
  const message = `${apiPath}${EAPI_SEP}${text}${EAPI_SEP}${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
  const params = Buffer.concat([cipher.update(Buffer.from(message, 'utf8')), cipher.final()]).toString('hex').toUpperCase();
  return { params };
}

// ─────────────────────────── cookie / http ───────────────────────────
// 登录态优先用 music2wy 自己的（扫码登录写出），兼容旧 musicbridge 导出的 cookie。
const COOKIE_FILE = process.env.MUSIC2WY_COOKIE
  || [path.join(os.homedir(), '.music2wy', 'cookie.json'),
      path.join(os.homedir(), '.musicbridge', 'cookie.json')].find((f) => fs.existsSync(f))
  || path.join(os.homedir(), '.music2wy', 'cookie.json');
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/2.3.17.1034';
const UA_WEB = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const RAW = !!process.env.NE_RAW;

let _cookieCache = null;
export function loadCookie() {
  if (_cookieCache) return _cookieCache;
  if (process.env.NE_COOKIE) return (_cookieCache = { header: process.env.NE_COOKIE.trim(), csrf: '' });
  if (!fs.existsSync(COOKIE_FILE)) throw new Error(`cookie 文件不存在: ${COOKIE_FILE}（设置 MUSICBRIDGE_COOKIE 或 NE_COOKIE）`);
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw);
    return (_cookieCache = {
      header: Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; '),
      csrf: j.__csrf || '',
    });
  }
  return (_cookieCache = { header: raw, csrf: '' });
}

function baseHeaders(cookieHeader) {
  return {
    'User-Agent': UA_WEB,
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
    Cookie: cookieHeader,
  };
}

async function parseJson(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (RAW) console.error(`[raw] ${res.status} ${text.slice(0, 800) || '(empty body)'}`);
  return { status: res.status, body, text };
}

/** 调用 weapi 接口。extra 会合并进明文 JSON（csrf_token 自动带上）。 */
export async function wapi(url, data = {}, cookieHeader) {
  const ck = cookieHeader || loadCookie();
  const body = new URLSearchParams(weapi({ csrf_token: ck.csrf, ...data })).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders(ck.header), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseJson(res);
}

/** 调用 eapi 接口（兜底通道）。 */
export async function eapiCall(url, data = {}, cookieHeader) {
  const ck = cookieHeader || loadCookie();
  const body = new URLSearchParams(eapi(url, { ...data, header: { osver: '26.6.2', deviceId: '', appver: '3.1.11', version: '40', buildver: '3415', resolution: '1920x1080', __csrf: ck.csrf, os: 'osx' } })).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders(ck.header), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseJson(res);
}

// ─────────────────────────── NOS 直传 ───────────────────────────
const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff',
};
const contentTypeFor = (ext) => CONTENT_TYPES[ext.toLowerCase()] || 'application/octet-stream';

/** 通过 LBS 找到该 bucket 真实的上传节点，例如 http://nosup-jd1.127.net */
export async function discoverUploadNode(bucket) {
  const url = `https://wanproxy.127.net/lbs?version=1.0&bucketname=${encodeURIComponent(bucket)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://music.163.com' } });
  const text = await res.text();
  if (RAW) console.error(`[raw] lbs ${res.status} ${text.slice(0, 400)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`LBS 响应无法解析: ${text.slice(0, 200)}`); }
  if (!Array.isArray(json.upload) || !json.upload.length) throw new Error(`LBS 未返回上传节点: ${text.slice(0, 200)}`);
  return json.upload[0];
}

/** objectKey 逐段编码，保留 "/" 分隔符 */
const encodeObjectKey = (key) => key.split('/').map(encodeURIComponent).join('/');

/**
 * 直传 NOS（>80MB 自动分片，与原客户端一致）。
 * 注意：offset/complete/context 必须以查询参数形式拼接，而非请求头。
 */
export async function nosUpload({ node, bucket, objectKey, token, data, ext, chunkSize = 80 * 1024 * 1024 }) {
  const md5 = crypto.createHash('md5').update(data).digest('hex');
  const total = data.length;
  const chunks = Math.max(1, Math.ceil(total / chunkSize));
  const url = `${node.replace(/\/$/, '')}/${bucket}/${encodeObjectKey(objectKey)}`;
  let context = '';
  let last = null;
  for (let i = 0; i < chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, total);
    const complete = i === chunks - 1;
    let q = `${url}?offset=${start}&complete=${complete}&version=1.0`;
    if (context) q += `&context=${encodeURIComponent(context)}`;
    const res = await fetch(q, {
      method: 'POST',
      headers: {
        'X-Nos-Token': token,
        'Content-MD5': md5,
        'Content-Type': contentTypeFor(ext),
        'Content-Length': String(end - start),
        Referer: 'https://music.163.com/',
        Origin: 'https://music.163.com',
      },
      body: data.subarray(start, end),
    });
    last = await parseJson(res);
    if (last.status !== 200 || (last.body && last.body.errCode)) {
      throw new Error(`NOS 上传失败 chunk ${i + 1}/${chunks}: ${last.status} ${last.text.slice(0, 300)}`);
    }
    context = (last.body && last.body.context) || '';
  }
  return { md5, size: total, chunks, response: last && last.body };
}

// ─────────────────────────── 主流程 ───────────────────────────
const md5hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** 步骤 1: 检查是否需要上传。返回 {songId, needUpload, code} */
export async function cloudUploadCheck({ md5, size, ext }) {
  const r = await wapi('https://interface.music.163.com/weapi/cloud/upload/check', {
    bitrate: '999000', ext, length: String(size), md5, songId: '0', version: '1',
  });
  return { ...r, ok: r.body?.code === 200 };
}

/** 步骤 2: 申请 NOS token。nos_product=3 → JD privatecloud bucket */
export async function cloudTokenAlloc({ md5, ext, filename }) {
  const r = await wapi('https://music.163.com/weapi/nos/token/alloc', {
    bucket: '', ext, filename, local: 'false', nos_product: '3', type: 'audio', md5,
  });
  return { ...r, ok: r.body?.code === 200 && !!r.body?.result?.objectKey };
}

/** 步骤 4: 写入云盘歌曲信息 */
export async function cloudInfo({ md5, checkSongId, filename, song, album, artist, resourceId }) {
  const r = await wapi('https://music.163.com/weapi/upload/cloud/info/v2', {
    md5, songid: checkSongId, filename: filename, song, album, artist,
    bitrate: '999000', resourceId,
  });
  return { ...r, ok: r.body?.code === 200 && !!r.body?.songId };
}

/** 查询转码状态。status: 0 完成, 9 转码中, 其他见网易文档 */
export async function cloudMusicStatus(songId) {
  const r = await wapi('https://music.163.com/weapi/v1/cloud/music/status', { songIds: `[${songId}]` });
  return { ...r, status: r.body?.statuses?.[String(songId)]?.status ?? null };
}

/** 步骤 5: 发布/关联到本人账号 —— 不做这一步云盘列表看不到歌曲 */
export async function cloudPublish(songId) {
  const r = await wapi('https://interface.music.163.com/weapi/cloud/pub/v2', { songid: String(songId) });
  return { ...r, ok: r.body?.code === 200 || r.body?.code === 201 };
}

/**
 * 完整上传一首本地音频到云盘。
 * @returns {{ok:boolean, songId?:number, md5:string, steps:Array, error?:string}}
 */
export async function uploadFile(file, opts = {}) {
  const steps = [];
  let md5 = '';
  try {
    if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
    const data = fs.readFileSync(file);
    if (!data.length) throw new Error('文件为空');
    md5 = md5hex(data);
    const size = data.length;
    const base = path.basename(file);
    const rawExt = path.extname(base).toLowerCase();
    const ext = rawExt || '.mp3';
    const nameNoExt = rawExt ? base.slice(0, -rawExt.length) : base;
    const title = opts.title || nameNoExt;
    const artist = opts.artist || '未知艺术家';
    const album = opts.album || '未知专辑';
    steps.push({ step: 'file', file, name: base, size, md5, ext, title, artist, album });

    // 1) check
    const check = await cloudUploadCheck({ md5, size, ext });
    steps.push({ step: 'upload/check', code: check.body?.code, needUpload: check.body?.needUpload, checkSongId: check.body?.songId });
    if (!check.ok) return { ok: false, md5, steps, error: `upload/check 失败: ${JSON.stringify(check.body).slice(0, 300)}` };

    // 2~4) alloc → NOS 直传 → cloud/info/v2
    //
    // 实测两个必须处理的坑：
    //   a) cloud/info/v2 会**偶发瞬时 404**（响应里 uploadStatus: 6）。必须重试；而且重试时
    //      要重新 alloc + 重新上传 NOS（objectKey 每次都变），只重试 info 是没用的。
    //   b) 如果服务端已经有同一个 md5（重装/重传），info 会返回 uploadStatus: 8 且 songId=0，
    //      这时要走"从云盘列表找回已有 songId"的路径，而不是报失败。
    let songId = null;
    let info = null;
    let lastResult = null;
    const maxInfoAttempts = Number(opts.infoRetries ?? 3);
    for (let attempt = 1; attempt <= maxInfoAttempts && !songId; attempt++) {
      // 2) alloc
      const alloc = await cloudTokenAlloc({ md5, ext, filename: base });
      const result = alloc.body?.result || {};
      lastResult = result;
      steps.push({ step: 'nos/token/alloc', attempt, code: alloc.body?.code, bucket: result.bucket, resourceId: result.resourceId });
      if (!alloc.ok) return { ok: false, md5, steps, error: `nos/token/alloc 失败: ${JSON.stringify(alloc.body).slice(0, 300)}` };

      // 3) NOS 直传
      const node = await discoverUploadNode(result.bucket);
      steps.push({ step: 'lbs', attempt, node });
      const up = await nosUpload({ node, bucket: result.bucket, objectKey: result.objectKey, token: result.token, data, ext });
      steps.push({ step: 'nos/upload', attempt, node, status: 200, chunks: up.chunks, size: up.size });

      // 4) cloud/info/v2
      info = await cloudInfo({
        md5, checkSongId: check.body.songId, filename: base,
        song: title, album, artist, resourceId: result.resourceId,
      });
      songId = info.body?.songId || null;
      const uploadStatus = /uploadStatus:\s*(\d+)/.exec(String(info.body?.msg || ''))?.[1] ?? null;
      steps.push({ step: 'upload/cloud/info/v2', attempt, code: info.body?.code, songId, exists: info.body?.exists, uploadStatus });
      if (!songId && attempt < maxInfoAttempts) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    if (!songId) {
      // 兜底：也许文件其实已经在云盘里了，只是这次 info 没给 songId。
      const existing = await findCloudSong({ fileName: base, fileSize: size });
      if (existing) {
        steps.push({ step: 'cloud/list', existingSongId: existing.songId, fileName: existing.fileName });
        const pub = await cloudPublish(existing.songId);
        steps.push({ step: 'cloud/pub/v2', code: pub.body?.code, via: 'dedup-fallback' });
        if (pub.ok) return { ok: true, deduped: true, songId: Number(existing.songId), md5, size, title, artist, album, steps };
      }
      return {
        ok: false, md5, steps, retryable: true,
        error: `cloud/info/v2 连续 ${maxInfoAttempts} 次没有返回 songId（最后一次: ${JSON.stringify(info?.body).slice(0, 240)}）`,
      };
    }

    // 5) pub —— 必须先发布，否则云盘列表看不到。
    //    实测：小文件（几十 KB 的 mp3）可以立刻 pub 成功；但大文件（例如 26MB 的无损 FLAC）
    //    需要等服务端转码，转码完成前 pub 会返回 400（status 9=转码中，0=完成）。
    //    所以这里用「退避重试 + 总超时」的策略，而不是固定次数。
    if (opts.pub !== false) {
      const deadline = Date.now() + Number(opts.pubTimeoutMs ?? 180000);
      const maxAttempts = Number(opts.pubRetries ?? 14);
      let pub = await cloudPublish(songId);
      let attempts = 1;
      let delay = 3000;
      while (!pub.ok && Date.now() < deadline && attempts < maxAttempts) {
        const st = await cloudMusicStatus(songId);
        steps.push({ step: 'cloud/music/status', attempt: attempts, status: st.status, waitTime: st.body?.statuses?.[String(songId)]?.waitTime ?? null });
        if (st.status == null) break; // 查不到状态就别空转
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(Math.round(delay * 1.5), 15000);
        pub = await cloudPublish(songId);
        attempts++;
      }
      steps.push({ step: 'cloud/pub/v2', code: pub.body?.code, attempts, privateCloudSongId: pub.body?.privateCloud?.songId });
      if (!pub.ok) {
        return {
          ok: false, md5, songId, steps,
          error: `cloud/pub/v2 失败 code=${pub.body?.code}（已等待 ${attempts} 次 / ${Math.round((Date.now() - (deadline - Number(opts.pubTimeoutMs ?? 180000))) / 1000)}s）。`
            + '大文件需要等服务端转码；可以稍后重试发布，或用 music2wy cloud 看它是否已经出现。',
          retryable: true,
        };
      }
    } else {
      steps.push({ step: 'cloud/pub/v2', skipped: '--no-pub（该歌曲不会出现在云盘列表）' });
    }

    return { ok: true, songId: Number(songId), md5, size, title, artist, album, steps };
  } catch (e) {
    return { ok: false, md5, steps, error: String((e && e.message) || e) };
  }
}

/**
 * 在云盘里按文件名（+文件大小）找一首已经存在的歌。
 * 云盘列表不返回 md5，所以用 fileName / fileSize 定位 —— 对"同一个文件重复上传"
 * 这个场景足够了。
 */
export async function findCloudSong({ fileName, fileSize } = {}) {
  const seen = [];
  for (let offset = 0; offset < 1000; offset += 500) {
    const r = await cloudList(500, offset);
    const rows = r?.data || [];
    seen.push(...rows);
    if (rows.length < 500) break;
  }
  const exact = seen.find((s) => s.fileName === fileName && (fileSize == null || Number(s.fileSize) === Number(fileSize)));
  if (exact) return exact;
  return seen.find((s) => s.fileName === fileName) || null;
}

/** 云盘列表 */
export async function cloudList(limit = 50, offset = 0) {
  const r = await wapi('https://music.163.com/weapi/v1/cloud/get', { limit: Number(limit), offset: Number(offset), sync: false });
  return r.body;
}

/** 账号信息 */
export async function account() {
  const r = await wapi('https://music.163.com/weapi/w/nuser/account/get', { os: 'pc' });
  return r.body;
}

/** 仅在需要时读取文件头做一次 check，不实际上传 */
export async function dryCheck(file) {
  const data = fs.readFileSync(file);
  const base = path.basename(file);
  const rawExt = path.extname(base).toLowerCase();
  const ext = rawExt || '.mp3';
  const r = await cloudUploadCheck({ md5: md5hex(data), size: data.length, ext });
  return { file, size: data.length, md5: md5hex(data), ext, ...r.body };
}

// ─────────────────────────── CLI ───────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-pub') { flags.pub = false; continue; }
    if (a === '--json') { flags.json = true; continue; }
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[++i]; continue; }
    positional.push(a);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  let out; let code = 0;

  switch (cmd) {
    case 'upload': {
      if (!rest[0]) { out = { ok: false, error: '用法: node ne_upload.mjs upload <file> [--title X] [--artist Y] [--album Z]' }; code = 2; break; }
      out = await uploadFile(rest[0], flags);
      if (!out.ok) code = 1;
      break;
    }
    case 'check': out = await dryCheck(rest[0]); break;
    case 'cloud': {
      const b = await cloudList(rest[0] || 50, rest[1] || 0);
      out = { code: b?.code, count: b?.count, size: b?.size, maxSize: b?.maxSize,
        songs: (b?.data || []).map((s) => ({ songId: s.songId, songName: s.songName, artist: s.artist, album: s.album, fileName: s.fileName, fileSize: s.fileSize, bitrate: s.bitrate, addTime: s.addTime })) };
      break;
    }
    case 'status': out = await cloudMusicStatus(rest[0]); break;
    case 'account': { const a = await account(); out = { code: a?.code, userId: a?.profile?.userId, nickname: a?.profile?.nickname }; break; }
    default:
      console.error('用法: node ne_upload.mjs <upload|check|cloud|status|account> [...]');
      process.exit(2);
  }
  console.log(JSON.stringify(out, flags.json ? 0 : null, flags.json ? 0 : 2));
  process.exit(code);
}

// 仅在作为 CLI 直接执行时跑 main()，被 import 时只导出函数（可复用模块）
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntry) {
  main().catch((e) => {
    console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    process.exit(1);
  });
}
