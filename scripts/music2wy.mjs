#!/usr/bin/env node
/**
 * music2wy — 从 flac.music.hi.cn 搜索并下载歌曲，写入元数据/歌词，上传到网易云音乐云盘。
 *
 * 所有命令都往 stdout 打一个 JSON 对象（给 agent/脚本解析），人类可读的进度打 stderr。
 *
 *   login                      弹出二维码扫码登录网易云（登录态缓存到 ~/.music2wy/cookie.json）
 *   whoami                     打印当前登录的网易云账号
 *   search "<关键词>"           在站点搜索候选，结合网易云官方元数据打分排序，写入会话缓存
 *   show                       重新打印上次搜索的候选（不打站点，不消耗配额）
 *   get --pick N               下载第 N 个候选（默认用上次搜索的会话），写元数据/歌词
 *   upload <file...>           上传本地文件到网易云云盘
 *   cloud [--limit N]          列出云盘已有歌曲
 *   playlist-add --name X ...  把云盘歌曲加入（或新建）歌单
 *   doctor                     环境自检
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as ne from './lib/ne.mjs';
import * as flac from './lib/flac.mjs';
import * as up from './lib/upload.mjs';
import { rankCandidates, pickVariant } from './lib/rank.mjs';
import * as tag from './lib/tag.mjs';
import * as qr from './lib/qr.mjs';
import {
  ensureDirs, loadConfig, saveConfig, emit, fail, human, mmss, safeFilename,
  HOME, DOWNLOAD_DIR, cacheGet, cacheSet, cacheInfo,
} from './lib/util.mjs';

// 注意：~/.music2wy/session.json 归 lib/flac.mjs 存放 WAF cookie 用，这里另开一个文件，
// 否则两边会互相覆盖。
const SESSION_FILE = path.join(HOME, 'last-search.json');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// ------------------------------------------------------------------ 参数
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const bools = ['json', 'refresh', 'no-lyrics', 'no-tag', 'no-publish', 'open', 'no-cache',
        'force', 'recommend', 'browser', 'headed'];
      if (bools.includes(k)) { flags[k] = true; continue; }
      const v = argv[++i];
      flags[k] = v;
    } else positional.push(a);
  }
  return { positional, flags };
}

const need = (cond, msg) => { if (!cond) fail(msg); };

// ------------------------------------------------------------------ 会话（上次搜索）
function saveSession(s) { ensureDirs(); fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 1)); }
function loadSession() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; } }

// ------------------------------------------------------------------ login
async function cmdLogin(flags) {
  const pngPath = flags.png || path.join(HOME, 'login-qr.png');
  ensureDirs();
  const { unikey, url } = await ne.qrCreate();
  const rendered = qr.renderQr(url, { pngPath });
  log('\n请用「网易云音乐」App 扫描下面的二维码登录（我的 → 右上角扫一扫）：\n');
  log(rendered.text);
  log('');

  // 非 TTY（例如在 agent 里跑）时，颜色/半块字符可能被吞掉，所以 PNG 也要能用
  let opened = false;
  if (flags.open !== false) opened = tryOpen(rendered.pngPath);
  log(`二维码图片: ${rendered.pngPath}${opened ? '（已尝试用系统看图程序打开）' : ''}`);
  log(`也可以复制链接手动生成二维码: ${url}\n`);
  log('等待扫码…');

  const started = Date.now();
  let lastCode = null;
  while (Date.now() - started < 180000) {
    const st = await ne.qrPoll(unikey);
    if (st.code === 803) {
      const acc = await ne.account();
      log(`\n✅ 登录成功: ${acc.profile?.nickname} (uid ${acc.profile?.userId})`);
      return emit({ ok: true, nickname: acc.profile?.nickname, userId: acc.profile?.userId, cookieFile: ne.COOKIE_FILE });
    }
    if (st.code === 800) {
      log('二维码已过期，正在重新生成…');
      return cmdLogin({ ...flags, _retry: (flags._retry || 0) + 1 });
    }
    const label = { 801: '等待扫码…', 802: '已扫码，请在手机上确认…' }[st.code] || `状态 ${st.code} ${st.message || ''}`;
    if (st.code !== lastCode) { log(`  ${label}`); lastCode = st.code; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return fail('扫码超时（180 秒）。重新运行 login 再试。');
}

function tryOpen(p) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(cmd, [p], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ whoami
async function cmdWhoami() {
  const acc = await ne.account();
  if (acc.code !== 200) return fail('未登录或登录态失效，请运行: music2wy login', { code: acc.code });
  return emit({ ok: true, nickname: acc.profile?.nickname, userId: acc.profile?.userId, vipType: acc.profile?.vipType });
}

// ------------------------------------------------------------------ search
const COVER_HINT = /原唱|翻唱|cover|伴奏|dj|remix|铃声|钢琴版|吉他版|童声|合唱|串烧|纯音乐/i;

/** 去掉括号补充信息，便于比较歌名。 */
const bareTitle = (s) => String(s || '')
  .replace(/[（(【\[].*?[)）】\]]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/**
 * 在网易云里找"参照曲目"。
 *
 * **重要**：网易云对很多歌（比如周杰伦的全部作品）根本没有版权，搜索接口只会返回翻唱
 * 和同名冒牌货。无条件相信第一条就会把翻唱当成"官方"，既打错分、又写错元数据。
 *
 * 判定可信的条件（两个都要满足）：
 *   1. 有某个输入词出现在这条的**歌手**字段里；
 *   2. 有某个输入词出现在这条的**歌名**里。
 * 只给歌名（单个词）时无法确认歌手，一律不算可信，退回"用户输入 + 站点元数据"。
 *
 * @returns {object|null} 可信的参照曲目，或 null
 */
async function neteaseReference(query, neSongs = null) {
  try {
    const list = neSongs || (await ne.searchSongs(query, 10)).songs || [];
    if (!list.length) return null;
    const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    let best = null; let bestScore = -Infinity;
    for (const s of list) {
      const name = String(s.name || '').toLowerCase();
      const arts = String(s.artists || '').toLowerCase();
      const bare = bareTitle(s.name);
      const artistHit = tokens.some((t) => arts.includes(t));
      const titleHit = tokens.some((t) => name.includes(t));
      if (!artistHit || !titleHit) continue;      // 歌名/歌手任一没对上，直接不认
      let sc = 0;
      for (const t of tokens) {
        if (arts.includes(t)) sc += 30;
        else if (name.includes(t)) sc += 6;
      }
      if (bare && bare === bareTitle(query)) sc += 40;
      else if (bare && bareTitle(query).includes(bare)) sc += 15;
      if (COVER_HINT.test(s.name)) sc -= 35;
      if (s.duration > 0 && (s.duration < 60 || s.duration > 600)) sc -= 10;
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 针对**已选中的站点候选**去网易云核对：歌名和歌手都对得上才认，
 * 用来拿官方元数据（专辑/时长）和官方歌词。
 */
async function officialFor(cand) {
  try {
    const r = await ne.searchSongs(`${cand.name} ${cand.artist}`.trim(), 10);
    const wantArtist = String(cand.artist || '').toLowerCase().split(/[\/&,、]/)[0].trim();
    if (!wantArtist) return null;
    const hit = (r.songs || []).find((s) => {
      const arts = String(s.artists || '').toLowerCase();
      if (!arts.split('/').some((a) => a && (a.includes(wantArtist) || wantArtist.includes(a)))) return false;
      const bn = bareTitle(s.name); const bc = bareTitle(cand.name);
      if (!bn || !bc) return true;
      return bn === bc || bn.includes(bc) || bc.includes(bn);
    });
    return hit || null;
  } catch {
    return null;
  }
}

/**
 * 站点（flac.music.hi.cn）的搜索**只接受单一关键词**：传 "晴天 周杰伦" 会返回 0 条。
 * 所以这里排出要依次尝试的搜索词：
 *   1. 网易云参照里的规范歌名（可信时）；
 *   2. 用户输入里的各个词，**按"有多像歌名"排序** —— 用网易云返回结果的歌名里
 *      各词出现的次数来判断（"晴天 周杰伦" 里 "晴天" 在歌名里高频出现，"周杰伦" 只在歌手字段里）；
 *   3. 最后才试原始输入（有的歌名本身带空格）。
 */
function siteQueryPlan(query, ref, neSongs = []) {
  const tokens = String(query).split(/\s+/).filter(Boolean);
  const nameHits = new Map(tokens.map((t) => [t, 0]));
  for (const s of neSongs) {
    const n = String(s.name || '').toLowerCase();
    for (const t of tokens) if (n.includes(t.toLowerCase())) nameHits.set(t, nameHits.get(t) + 1);
  }
  const ordered = [...tokens].sort((a, b) => (nameHits.get(b) - nameHits.get(a)) || (b.length - a.length));

  const plan = [];
  if (ref?.name) plan.push(ref.name);
  if (tokens.length <= 1) plan.push(query);
  else plan.push(...ordered, query);
  return [...new Set(plan.map((s) => String(s).trim()).filter(Boolean))];
}

async function searchSite(query, platform, limit, { refresh = false } = {}) {
  const key = `${platform}:${query}`;
  if (!refresh) {
    const cached = cacheGet('search', key, loadConfig().searchCacheTtlMs);
    if (cached) {
      log(`[缓存] 命中 ${Math.round((Date.now() - cached.cachedAt) / 1000)}s 前的 "${query}" 搜索结果（不消耗站点配额）`);
      return { res: cached.value, fromCache: true };
    }
  }
  log(`[站点] 搜索 "${query}" (platform=${platform}) …`);
  const res = await flac.search(query, { platform, size: Math.max(20, limit * 3) });
  cacheSet('search', key, res);
  return { res, fromCache: false };
}

/**
 * 用户只给了歌名（例如"泸沽湖"）时，没法从输入判断歌手。这里用**站点自己的结果**投票：
 * 同名候选里如果某个歌手明显占多数，就认为那是原唱，用它来排序。
 *
 * 注意：这个推断**只用于排序**，不会写进元数据 —— 挑中之后还会用 officialFor() 再核对一次，
 * 所以推错了也只会是"顺序不理想"，不会给歌打上错误的标签。
 *
 * 反例（有效）：搜"晴天"时结果分别是关诗敏/刘瑞琦/何老希…，没有多数派 → 返回 null，
 * 我们就不会瞎猜一个"原唱"出来。
 */
function consensusArtist(list, title) {
  const t = bareTitle(title);
  const counts = new Map();
  for (const c of (list || []).slice(0, 15)) {
    const n = bareTitle(c.name || '');
    if (t && !(n === t || n.includes(t) || t.includes(n))) continue;
    const a = String(c.artist || '').trim();
    if (!a) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  if (!sorted.length) return null;
  const [name, n] = sorted[0];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  // 至少出现 2 次，且占同名候选的 1/4 以上，才算"多数派"。
  // 阈值定太严会漏掉真原唱（"泸沽湖"里麻园诗人只占 1/3），太松又会把某个翻唱当成原唱。
  return n >= 2 && n / total >= 0.25 ? name : null;
}

/** 组装"期望的元数据"，用于给站点候选打分。 */
function buildExpect(query, usedQuery, ref, siteList) {
  const artistHints = String(query).split(/\s+/)
    .filter((t) => t && t !== usedQuery && !usedQuery.includes(t));
  const artists = [ref?.artists, artistHints.join('/')].filter(Boolean).join('/');
  if (artists) return { name: ref?.name || usedQuery, artists, duration: ref?.duration || null, artistSource: 'query' };
  const consensus = consensusArtist(siteList, usedQuery);
  return {
    name: ref?.name || usedQuery,
    artists: consensus || '',
    duration: ref?.duration || null,
    artistSource: consensus ? 'consensus' : null,
  };
}

async function cmdSearch(args) {
  const cfg = loadConfig();
  const query = args.positional.join(' ').trim();
  need(query, '用法: music2wy search "<关键词>"');
  const limit = Number(args.flags.limit || 10);
  const platform = args.flags.platform || 'kuwo';

  // 先问网易云（不限流）拿参照，顺便推导出站点能接受的搜索词
  const neSongs = await ne.searchSongs(query, 10).then((r) => r.songs || []).catch(() => []);
  const ref = await neteaseReference(query, neSongs);
  if (ref) log(`[参照] 网易云官方: ${ref.name} — ${ref.artists} (${mmss(ref.duration)})`);

  const plan = siteQueryPlan(query, ref, neSongs);
  let res = null; let fromCache = false; let usedQuery = null;
  for (const sq of plan) {
    const r = await searchSite(sq, platform, limit, { refresh: args.flags.refresh });
    if (r.res.list?.length) { res = r.res; fromCache = r.fromCache; usedQuery = sq; break; }
    res = r.res; fromCache = r.fromCache; usedQuery = sq;
    if (plan.length > 1) log(`[站点] "${sq}" 没有结果，换个搜索词再试…`);
  }

  // 打分期望：歌名 = 站点实际命中的搜索词；歌手 = 用户输入里剩下的词（+ 已确认的网易云参照）。
  // 例："晴天 周杰伦" 站点只认 "晴天"，于是把 "周杰伦" 当作歌手提示去给候选加分。
  const expect = buildExpect(query, usedQuery, ref, res?.list);
  if (expect.artistSource === 'consensus') log(`[推断] 站点结果里「${expect.artists}」占多数，按这个歌手排序`);
  if (!ref) log(`[参照] 网易云没有可信的原唱（很可能没版权），改用输入推断：歌名="${expect.name}" 歌手="${expect.artists || '未指定'}"`);

  // 全部候选都存进会话（便于用户想往下翻），但只把前 limit 条打印出来
  const rankedAll = rankCandidates(res.list || [], expect);
  const ranked = rankedAll.slice(0, limit);
  const candidates = ranked.map((c, i) => {
    const v = pickVariant(c, cfg.quality);
    return {
      index: i + 1,
      platform: c.platform || platform,
      songid: String(c.songid ?? c.id ?? ''),
      name: c.name,
      artist: c.artist,
      album: c.album || '',
      duration: c.duration || 0,
      durationText: mmss(c.duration),
      formats: (c.minfo || []).map((m) => `${m.format}/${m.bitrate}k/${m.size || ''}`.replace(/\/$/, '')),
      willUse: v ? { format: v.format, bitrate: v.bitrate, size: v.size } : null,
      score: c._score,
      reasons: c._reasons,
      warnings: c._bad?.length ? [`命中过滤词: ${c._bad.join('/')}`] : [],
      recommended: i === 0,
      netease: ref ? { id: ref.id, name: ref.name, artists: ref.artists, album: ref.album, duration: ref.duration } : null,
    };
  });

  // 如果用户指定了歌手，但站点结果里**没有一条**歌手对得上，必须明确告诉用户，
  // 免得把一堆翻唱当成原唱下下来。
  const artistHintList = String(expect.artists || '').split('/').map((s) => s.trim()).filter(Boolean);
  const artistMatched = !artistHintList.length || rankedAll.some((c) => {
    const a = String(c.artist || '').toLowerCase();
    return artistHintList.some((h) => a.includes(h.toLowerCase()) || h.toLowerCase().includes(a));
  });
  const noArtistMatch = artistHintList.length > 0 && !artistMatched;

  saveSession({
    query, siteQuery: usedQuery, platform, at: Date.now(), ref, expect,
    candidates: rankedAll.map((c) => ({ ...c, _platform: c.platform || platform })),
  });

  return emit({
    ok: true,
    query,
    siteQuery: usedQuery,
    reference: ref,
    total: res?.total ?? null,
    fromCache,
    warning: noArtistMatch
      ? `站点（${platform}）上没有找到「${expect.artists}」的版本，下面列出的都是翻唱/其他艺人。`
        + `可以换 --platform ${platform === 'kuwo' ? 'wyy' : 'kuwo'} 再试；如果两边都没有，说明这个音源站拿不到这首原唱。`
      : null,
    candidateCount: candidates.length,
    candidates,
    next: candidates.length
      ? '把候选列表展示给用户，等用户确认（例如"第 2 个"）后运行: node music2wy.mjs get --pick <序号>'
      : `站点搜 "${usedQuery}" 没有结果。站点只认单一关键词，试试只用歌名，或加 --platform 换音源。`,
  });
}

function cmdShow() {
  const s = loadSession();
  if (!s) return fail('还没有搜索记录，先运行 search');
  const out = s.candidates.map((c, i) => ({
    index: i + 1,
    name: c.name, artist: c.artist, album: c.album || '',
    durationText: mmss(c.duration), score: c._score,
    formats: (c.minfo || []).map((m) => `${m.format}/${m.bitrate}k`),
    recommended: i === 0,
  }));
  return emit({ ok: true, query: s.query, at: new Date(s.at).toISOString(), ageMinutes: Math.round((Date.now() - s.at) / 60000), candidates: out });
}

// ------------------------------------------------------------------ get（下载）
async function cmdGet(args) {
  const cfg = loadConfig();
  const pick = Number(args.flags.pick || 0);
  need(pick >= 1, '用法: music2wy get --pick <序号>（序号来自 search 的输出）');
  const force = !!args.flags.force;

  let session = loadSession();
  if (!session || (args.flags.query && session.query !== args.flags.query) || force) {
    // 需要重新搜索：走和 cmdSearch 一样的"网易云参照 → 推导站点搜索词"逻辑
    const q = args.flags.query || session?.query;
    need(q, '没有可用的搜索会话，请先 search，或用 --query "<关键词>" 指定');
    const platform = args.flags.platform || session?.platform || 'kuwo';
    const neSongs2 = await ne.searchSongs(q, 10).then((r) => r.songs || []).catch(() => []);
    const ref = await neteaseReference(q, neSongs2);
    let res = null; let usedQuery = q;
    for (const sq of siteQueryPlan(q, ref, neSongs2)) {
      log(`[站点] 重新搜索 "${sq}" …`);
      res = await flac.search(sq, { platform, size: 30 });
      usedQuery = sq;
      if (res.list?.length) break;
    }
    const expect = buildExpect(q, usedQuery, ref, res?.list);
    const ranked = rankCandidates(res?.list || [], expect);
    session = {
      query: q, siteQuery: usedQuery, platform, at: Date.now(), ref, expect,
      candidates: ranked.map((c) => ({ ...c, _platform: c.platform || platform })),
    };
    saveSession(session);
    need(ranked.length, `站点搜 "${usedQuery}" 没有结果（站点只认单一关键词，试试只用歌名）`);
  }

  const cand = session.candidates[pick - 1];
  need(cand, `会话里只有 ${session.candidates.length} 个候选，--pick ${pick} 超出范围`);

  const quality = args.flags.quality || cfg.quality;
  const variant = pickVariant(cand, quality);
  need(variant, '该候选没有可用的音质');

  // 元数据：拿**选中的这个候选**去网易云核对。歌名和歌手都对得上才用它的官方元数据，
  // 否则（比如周杰伦这种网易云没版权的）就老实用站点自带的元数据 —— 绝不能用翻唱的信息覆盖。
  const official = await officialFor(cand);
  const meta = {
    title: official?.name || String(cand.name || '未知').replace(/-?\s*原唱.*$/, '').trim(),
    artist: official?.artists || cand.artist || '未知艺术家',
    album: official?.album || cand.album || '',
    neteaseId: official?.id || null,
    neteaseDuration: official?.duration || null,
  };

  const outdir = args.flags.outdir || DOWNLOAD_DIR;
  fs.mkdirSync(outdir, { recursive: true });
  const base = safeFilename(`${meta.title} - ${meta.artist}`);
  const ext = variant.format === 'flac' ? 'flac' : 'mp3';
  const outfile = path.join(outdir, `${base}.${ext}`);

  // 直链：优先缓存，避免重复打站点（cacheGet 返回的是 {cachedAt, meta, value} 包装，要取 .value）
  const urlKey = `${cand._platform}:${cand.songid}:${variant.format}:${variant.bitrate}`;
  const urlCached = args.flags['no-cache'] ? null : cacheGet('url', urlKey, cfg.urlCacheTtlMs);
  let info = urlCached?.value || null;
  if (info) log(`[缓存] 命中直链缓存（${Math.round((Date.now() - urlCached.cachedAt) / 1000)}s 前解析）`);
  if (!info?.url) {
    log(`[站点] 解析直链 ${cand.name} / ${variant.format} ${variant.bitrate}k …`);
    try {
      info = await flac.resolve({
        platform: cand._platform, songid: cand.songid, time: cand.time, sign: cand.sign,
        format: variant.format, bitrate: variant.bitrate,
      });
    } catch (e) {
      log(`[站点] 直链解析失败（sign 可能已过期）：${e.message}`);
      log('[站点] 重新搜索拿新的 sign …');
      const res = await flac.search(session.siteQuery || session.query, { platform: session.platform || 'kuwo', size: 30, allowCache: false });
      const ranked = rankCandidates(res.list || [], session.expect || session.ref);
      saveSession({ ...session, at: Date.now(), candidates: ranked.map((c) => ({ ...c, _platform: c.platform || session.platform || 'kuwo' })) });
      const c2 = ranked[pick - 1] || ranked[0];
      const v2 = pickVariant(c2, quality) || variant;
      info = await flac.resolve({
        platform: c2._platform || session.platform, songid: c2.songid, time: c2.time, sign: c2.sign,
        format: v2.format, bitrate: v2.bitrate,
      });
      Object.assign(cand, c2);
    }
    cacheSet('url', urlKey, info);
  }
  need(info?.url, '站点没有返回直链');

  const usedCachedUrl = !!info.url;
  let dl = null;
  try {
    log(`[下载] ${info.url.slice(0, 100)}…`);
    dl = await flac.download(info.url, outfile);
  } catch (e) {
    if (!usedCachedUrl) throw e;
    // CDN 直链自带时效，缓存里的可能已经过期 —— 重新解析一次再下
    log(`[下载] 缓存的直链失效了（${e.message}），重新解析…`);
    info = await flac.resolve({
      platform: cand._platform, songid: cand.songid, time: cand.time, sign: cand.sign,
      format: variant.format, bitrate: variant.bitrate,
    });
    need(info?.url, '缓存的直链失效后重新解析仍然失败');
    cacheSet('url', urlKey, info);
    dl = await flac.download(info.url, outfile);
  }
  log(`[下载] 完成 ${outfile} (${human(dl.bytes)})`);

  // 校验时长：优先和网易云官方时长比；网易云没版权时退化为和站点给的时长比
  const expectDuration = meta.neteaseDuration || cand.duration || null;
  let verify = { durationDownloaded: null, durationExpected: expectDuration, drift: null, ok: null, source: meta.neteaseDuration ? 'netease' : (cand.duration ? 'site' : null) };
  const probed = tag.probe(outfile);
  if (probed?.duration) {
    verify.durationDownloaded = Math.round(probed.duration);
    if (expectDuration) {
      verify.drift = Math.abs(probed.duration - expectDuration) / Math.max(expectDuration, 1);
      verify.ok = verify.drift <= 0.25;
      log(`${verify.ok ? '✅' : '⚠️'} 时长校验: 下载 ${Math.round(probed.duration)}s vs 期望 ${expectDuration}s（来源 ${verify.source}，偏差 ${(verify.drift * 100).toFixed(0)}%）`);
    }
  }

  // 歌词：优先网易云官方 LRC；网易云没版权（比如周杰伦）时退回音源站自己的 getLyric
  let lyricsFile = null; let coverFile = null;
  if (!args.flags['no-lyrics']) {
    let lrc = null; let from = null;
    if (meta.neteaseId) {
      try {
        const l = await ne.lyrics(meta.neteaseId);
        if (l.lrc) { lrc = l.lrc; from = '网易云官方'; }
      } catch (e) { log(`[歌词] 网易云获取失败: ${e.message}`); }
    }
    if (!lrc) {
      try {
        const l = await flac.lyric({ platform: cand._platform || session.platform, songid: cand.songid, time: cand.time, sign: cand.sign });
        if (l.ok) { lrc = l.lrc; from = '音源站'; }
      } catch (e) { log(`[歌词] 音源站获取失败: ${e.message}`); }
    }
    if (lrc) {
      lyricsFile = `${outfile}.lrc`;
      fs.writeFileSync(lyricsFile, lrc);
      log(`[歌词] 已取${from}歌词 ${lrc.length} 字符`);
    } else {
      log('[歌词] 两边都没取到，跳过（不影响下载和上传）');
    }
  }
  if (official?.cover) {
    coverFile = await tag.fetchCover(official.cover, `${outfile}.cover.jpg`);
  }

  let tagResult = { ok: false, skipped: true };
  if (!args.flags['no-tag']) {
    tagResult = tag.writeTags(outfile, meta, { cover: coverFile, lyricsFile });
    log(tagResult.ok ? '[元数据] 已写入标题/歌手/专辑/封面/歌词'
      : `[元数据] ${tagResult.skipped ? '跳过（未安装 ffmpeg）' : `写入失败: ${tagResult.error}`}`);
  }
  for (const f of [coverFile]) { try { if (f && fs.existsSync(f) && !args.flags['keep-sidecar']) fs.unlinkSync(f); } catch { /* ignore */ } }

  return emit({
    ok: true,
    file: outfile,
    bytes: dl.bytes,
    sizeText: human(dl.bytes),
    meta,
    quality: { format: variant.format, bitrate: variant.bitrate },
    probe: probed,
    verify,
    lyricsFile: lyricsFile && fs.existsSync(lyricsFile) ? lyricsFile : null,
    tagged: tagResult.ok,
    next: `确认无误后运行: node music2wy.mjs upload "${outfile}" --title "${meta.title}" --artist "${meta.artist}" --album "${meta.album}"`,
  });
}

// ------------------------------------------------------------------ upload
async function cmdUpload(args) {
  const cfg = loadConfig();
  const files = args.positional.filter((f) => fs.existsSync(f));
  need(files.length, '用法: music2wy upload <file> [--title T --artist A --album AL]');
  const results = [];
  for (const f of files) {
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    const [t0, a0] = stem.split(' - ');
    const opts = {
      title: args.flags.title || t0 || stem,
      artist: args.flags.artist || a0 || '未知艺术家',
      album: args.flags.album || '未知专辑',
      publish: args.flags['no-publish'] ? false : cfg.publish,
    };
    log(`[上传] ${path.basename(f)} → 云盘 (${opts.title} / ${opts.artist}) …`);
    try {
      const r = await up.uploadFile(f, opts);
      log(r.ok ? `[上传] ✅ songId=${r.songId}` : `[上传] ❌ ${r.error}`);
      results.push({ file: f, ...r, meta: opts });
    } catch (e) {
      log(`[上传] ❌ ${e.message}`);
      results.push({ file: f, ok: false, error: e.message, meta: opts });
    }
    await new Promise((r) => setTimeout(r, 1500)); // 云盘上传有频率限制
  }
  return emit({ ok: results.every((r) => r.ok), count: results.length, uploaded: results.filter((r) => r.ok).length, results });
}

/** 单独重试「发布」：上传成功但转码没跟上时用得上。 */
async function cmdPublish(args) {
  const ids = args.positional.map((s) => Number(s)).filter(Boolean);
  need(ids.length, '用法: music2wy publish <songId...>');
  const out = [];
  for (const id of ids) {
    const st = await up.cloudMusicStatus(id);
    log(`[发布] songId=${id} 转码状态=${st.status ?? '?'} …`);
    const pub = await up.cloudPublish(id);
    log(pub.ok ? `[发布] ✅ songId=${id}` : `[发布] ❌ code=${pub.body?.code}`);
    out.push({ songId: id, transcodeStatus: st.status ?? null, ok: pub.ok, code: pub.body?.code, error: pub.body?.message || null });
    await new Promise((r) => setTimeout(r, 1000));
  }
  return emit({ ok: out.every((o) => o.ok), results: out });
}

// ------------------------------------------------------------------ cloud / playlist
async function cmdCloud(args) {
  const limit = Number(args.flags.limit || 50);
  const r = await ne.cloudList(limit, Number(args.flags.offset || 0));
  const data = (r.data || []).map((s) => ({
    songId: s.songId, name: s.songName, artist: s.artist, album: s.album,
    fileName: s.fileName, fileSize: s.fileSize, addTime: s.addTime,
  }));
  return emit({ ok: r.code === 200, code: r.code, count: data.length, songs: data });
}

async function cmdPlaylistAdd(args) {
  const name = args.flags.name || args.positional[0];
  need(name, '用法: music2wy playlist-add --name "歌单名" [--song-ids 1,2,3 | --files a.flac,b.flac]');
  const acc = await ne.account();
  const uid = acc.profile?.userId;
  const pls = await ne.playlists(uid);
  let target = (pls.playlist || []).find((p) => p.name === name);
  if (!target) {
    const created = await ne.playlistCreate(name);
    need(created.id, `新建歌单失败: ${JSON.stringify(created).slice(0, 200)}`);
    target = { id: created.id, name };
    log(`[歌单] 已新建 "${name}" id=${target.id}`);
  }
  let ids = [];
  if (args.flags['song-ids']) ids = String(args.flags['song-ids']).split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (args.flags.files) {
    const cloud = await ne.cloudList(500, 0);
    const byName = new Map((cloud.data || []).map((s) => [s.fileName || s.songName, s.songId]));
    for (const f of String(args.flags.files).split(',')) {
      const stem = path.basename(f.trim()).replace(/\.[^.]+$/, '');
      for (const [cn, sid] of byName) {
        if (cn && (cn.includes(stem) || stem.includes(cn.replace(/\.[^.]+$/, '')))) { ids.push(sid); break; }
      }
    }
  }
  need(ids.length, '没有解析到可加入的云盘歌曲（先 upload，或直接给 --song-ids）');
  const r = await ne.playlistAdd(target.id, ids);
  log(`[歌单] ${name}: 加入 ${ids.length} 首, code=${r.code}`);
  return emit({ ok: r.code === 200, playlist: { id: target.id, name }, added: ids.length, code: r.code });
}

// ------------------------------------------------------------------ 浏览器兜底
/**
 * 主动用真浏览器解一次站点 WAF 挑战，把 cookie 写进 flac 的 session 文件。
 * 日常不需要（纯 Node 会自己解），只在挑战算法变了/被风控时用。
 */
async function cmdBrowserSession(args) {
  const { browserSolve, browserAvailability } = await import('./lib/browser.mjs');
  const avail = browserAvailability();
  log(`[浏览器] 找到: ${avail.chrome || '（没有本机 Chrome）'} | Playwright: ${avail.playwright ? '可用' : '不可用'}`);
  need(avail.chrome || avail.playwright, '既没有本机 Chrome 也没有 Playwright，无法使用浏览器兜底');

  const res = await browserSolve({
    url: flac.BASE + '/',
    headed: !!args.flags.headed || process.env.MUSIC2WY_BROWSER_HEADED === '1',
    prefer: args.flags.path || process.env.MUSIC2WY_BROWSER_PATH || 'auto',
    timeoutMs: Number(args.flags.timeout || 60000),
    log,
  });

  ensureDirs();
  fs.writeFileSync(flac.SESSION_FILE, JSON.stringify({
    cookies: res.cookies,
    via: res.via,
    title: res.title ?? null,
    solvedAt: new Date().toISOString(),
  }, null, 2));

  // 立刻用这个会话打一次站点，确认真的能用
  let verify = null;
  try {
    const r = await flac.search('test', { size: 1, allowCache: false });
    verify = { ok: true, total: r.total };
    log(`[浏览器] 会话验证通过（站点返回 total=${r.total}）`);
  } catch (e) {
    verify = { ok: false, error: e.message };
    log(`[浏览器] ⚠️ 会话拿到但站点请求仍失败：${e.message}`);
  }

  return emit({
    ok: !!verify?.ok,
    via: res.via,
    title: res.title ?? null,
    cookies: Object.keys(res.cookies),
    sessionFile: flac.SESSION_FILE,
    verify,
  });
}

// ------------------------------------------------------------------ clean-cloud
/**
 * 清理云盘里的**测试残留**。
 *
 * 安全设计（删东西不可逆，所以刻意保守）：
 *   - 默认**只列出、不删除**（dry-run），必须显式加 --yes 才真删；
 *   - 只匹配下面这些**完整名称**（锚定 ^...$，不做模糊包含），
 *     绝不会碰到"朋友""浮夸""大城小爱"这类正常歌曲；
 *   - 也可以直接用 --song-ids 精确指定。
 */
const TEST_ARTIFACT_PATTERNS = [
  /^music2wy smoke test$/i,
  /^MusicBridge Verify Final$/i,
  /^MusicBridge Final Verify$/i,
  /^Burst[123]$/i,
  /^(FLAC|NoPub) Probe$/i,
  /^real1$/i,
];

async function cmdCleanCloud(args) {
  const limit = Number(args.flags.limit || 500);
  const r = await ne.cloudList(limit, 0);
  const all = r.data || [];

  let targets;
  if (args.flags['song-ids']) {
    const want = new Set(String(args.flags['song-ids']).split(',').map((s) => Number(s.trim())).filter(Boolean));
    targets = all.filter((s) => want.has(Number(s.songId)));
    const missing = [...want].filter((id) => !all.some((s) => Number(s.songId) === id));
    if (missing.length) log(`⚠️ 这些 songId 不在云盘前 ${limit} 首里：${missing.join(',')}`);
  } else {
    targets = all.filter((s) => TEST_ARTIFACT_PATTERNS.some((re) => re.test(String(s.songName || '').trim())));
  }

  const list = targets.map((s) => ({ songId: Number(s.songId), name: s.songName, artist: s.artist, fileName: s.fileName }));
  log(`云盘共 ${all.length} 首，其中匹配到测试残留 ${list.length} 首：`);
  for (const t of list) log(`  - ${t.songId} | ${t.name} — ${t.artist} | ${t.fileName}`);

  if (!list.length) return emit({ ok: true, dryRun: true, cloudTotal: all.length, matched: 0, deleted: 0, targets: [] });

  if (!args.flags.yes) {
    log('\n（dry-run，没有删除任何东西。确认无误后加 --yes 执行）');
    return emit({
      ok: true, dryRun: true, cloudTotal: all.length, matched: list.length, deleted: 0, targets: list,
      next: `node music2wy.mjs clean-cloud --yes`,
    });
  }

  const res = await ne.cloudDelete(list.map((t) => t.songId));
  log(`\n删除结果: code=${res.code} 成功 ${res.succIds.length} / 失败 ${res.failIds.length}`);
  if (res.failIds.length) log(`失败: ${res.failIds.join(',')}`);

  // 复查
  await new Promise((x) => setTimeout(x, 1200));
  const after = ((await ne.cloudList(limit, 0)).data || []);
  log(`云盘数量: ${all.length} → ${after.length}`);
  return emit({
    ok: res.ok, dryRun: false, cloudTotal: all.length, cloudTotalAfter: after.length,
    matched: list.length, deleted: res.succIds.length, succIds: res.succIds, failIds: res.failIds, code: res.code,
  });
}

// ------------------------------------------------------------------ stats
/** 站点请求记账：回答"这次一共打了几个请求""是不是把配额用光了"。 */
async function cmdStats(args) {
  const all = flac.readRequestLog();
  const now = Date.now();
  const within = (ms) => all.filter((r) => now - Date.parse(r.t) < ms);
  const h1 = within(3600_000);
  const h24 = within(24 * 3600_000);

  const summarize = (rows) => {
    const byPath = {};
    let failed = 0;
    for (const r of rows) {
      const k = `${r.method || '?'} ${r.path || '?'}`;
      byPath[k] = (byPath[k] || 0) + 1;
      if (r.status == null || r.status >= 400) failed++;
    }
    return { count: rows.length, failed, byPath };
  };

  const last = all.slice(-15).map((r) => ({
    t: r.t, path: r.path, status: r.status, ms: r.ms, error: r.error || null,
  }));

  log(`站点请求记账（${flac.REQUEST_LOG_PATH}）`);
  log(`  最近 1 小时: ${h1.length} 次（失败 ${summarize(h1).failed}）`);
  log(`  最近 24 小时: ${h24.length} 次（失败 ${summarize(h24).failed}）`);
  log(`  累计: ${all.length} 次`);
  if (h24.length) {
    log('  24 小时内按接口:');
    for (const [k, v] of Object.entries(summarize(h24).byPath).sort((a, b) => b[1] - a[1])) log(`    ${k}  ×${v}`);
  }

  return emit({
    ok: true,
    logFile: flac.REQUEST_LOG_PATH,
    total: all.length,
    lastHour: summarize(h1),
    last24h: summarize(h24),
    recent: last,
    note: '站点请求之间的最小间隔由 config.minRequestIntervalMs 控制（每 5 分钟以外的探测不计入）。',
  });
}

// ------------------------------------------------------------------ doctor
async function cmdDoctor(args = {}) {
  const checks = [];
  const cfg = loadConfig();
  checks.push({ name: 'node', ok: true, detail: process.version });
  checks.push({ name: 'ffmpeg', ok: tag.has('ffmpeg'), detail: tag.has('ffmpeg') ? '可用（写元数据/封面/歌词）' : '缺失：仍可下载与上传，但不写元数据' });
  const jar = ne.loadJar();
  checks.push({ name: '登录态', ok: !!jar.MUSIC_U, detail: ne.activeCookieFile() });
  if (jar.MUSIC_U) {
    try { const acc = await ne.account(); checks.push({ name: '网易云账号', ok: acc.code === 200, detail: `${acc.profile?.nickname} (uid ${acc.profile?.userId})` }); }
    catch (e) { checks.push({ name: '网易云账号', ok: false, detail: e.message }); }
  }
  if (args?.flags?.site) {
    // 显式要求时才真去打站点 —— 每次 doctor 都打一个请求是纯浪费，站点很敏感
    try {
      const s = await flac.search('test', { size: 1 });
      checks.push({ name: 'flac.music.hi.cn', ok: true, detail: `可访问（命中 ${s.total ?? '?'}）` });
    } catch (e) {
      checks.push({ name: 'flac.music.hi.cn', ok: false, detail: e.message.slice(0, 160) });
    }
  } else {
    const last = flac.readRequestLog().slice(-1)[0];
    const block = last && last.status == null;
    checks.push({
      name: 'flac.music.hi.cn', ok: true, optional: true,
      detail: `跳过在线检查（加 --site 才打站点）。上次请求: ${last ? `${last.t} ${last.path || ''} ${last.status ?? '失败'}` : '无记录'}${block ? ' ⚠️ 上次是失败，可能正被封' : ''}`,
    });
  }
  // 浏览器兜底能力（只是信息，不影响整体通过与否）
  try {
    const { browserAvailability } = await import('./lib/browser.mjs');
    const a = browserAvailability();
    checks.push({
      name: '浏览器兜底',
      ok: true,
      detail: [a.chrome ? `Chrome: ${a.chrome}` : '没有本机 Chrome',
        a.playwright ? 'Playwright: 可用' : 'Playwright: 不可用'].join(' | '),
      optional: true,
    });
  } catch (e) {
    checks.push({ name: '浏览器兜底', ok: true, detail: `不可用（${e.message.slice(0, 80)}）`, optional: true });
  }
  const sess = cacheInfo('search', 'kuwo:test');
  for (const c of checks) log(`${c.ok ? '✅' : '❌'} ${c.name.padEnd(18)} ${c.detail || ''}`);
  log(`\n配置: ${JSON.stringify(cfg)}`);
  log(`下载目录: ${DOWNLOAD_DIR}`);
  return emit({ ok: checks.every((c) => c.ok), checks, config: cfg, downloadDir: DOWNLOAD_DIR, home: HOME });
}

// ------------------------------------------------------------------ main
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  ensureDirs();
  // 把配置里的限流间隔同步给站点客户端（它每次请求时会读这个环境变量）
  if (!process.env.FLAC_MIN_GAP_MS) process.env.FLAC_MIN_GAP_MS = String(loadConfig().minRequestIntervalMs);
  // --browser / --headed 交给站点客户端在挑战解不开时启用浏览器兜底
  if (args.flags.browser) process.env.MUSIC2WY_BROWSER_FALLBACK = '1';
  if (args.flags.headed) { process.env.MUSIC2WY_BROWSER_HEADED = '1'; process.env.MUSIC2WY_BROWSER_FALLBACK = '1'; }
  if (args.flags['browser-path']) process.env.MUSIC2WY_BROWSER_PATH = args.flags['browser-path'];
  switch (cmd) {
    case 'login': case 'qr': return cmdLogin(args.flags);
    case 'whoami': return cmdWhoami();
    case 'search': return cmdSearch(args);
    case 'show': return cmdShow();
    case 'get': return cmdGet(args);
    case 'upload': return cmdUpload(args);
    case 'publish': return cmdPublish(args);
    case 'cloud': return cmdCloud(args);
    case 'playlist-add': return cmdPlaylistAdd(args);
    case 'browser-session': return cmdBrowserSession(args);
    case 'clean-cloud': return cmdCleanCloud(args);
    case 'stats': return cmdStats(args);
    case 'doctor': return cmdDoctor(args);
    case 'config': return emit({ ok: true, config: args.positional[0] ? saveConfig(JSON.parse(args.positional[0])) : loadConfig() });
    default:
      process.stderr.write(`music2wy — 搜索下载歌曲并上传到网易云盘

  login                              扫码登录网易云（弹二维码）
  whoami                             查看当前登录账号
  search "<关键词>" [--limit 10]      搜索候选（打分排序）
  show                               重新打印上次候选（不消耗站点配额）
  get --pick N [--quality flac|320]  下载第 N 个候选并写元数据/歌词
  upload <file...> [--title/--artist/--album]
  publish <songId...>                重试发布（大文件转码没跟上时用）
  cloud [--limit 50]                 列出云盘歌曲
  playlist-add --name "歌单" --files a.flac,b.flac
  browser-session [--headed]         用真浏览器解一次站点挑战（兜底，日常不需要）
  clean-cloud [--yes]                清理云盘里的测试残留（默认只列出不删）
  stats                              查看站点请求记账（排查是否触碰限流）
  doctor [--site]                    环境自检（默认不打站点；--site 才在线检查）

所有命令都支持 --browser：站点挑战自己解不开时，自动用真浏览器兜底解一次。
  --headed        兜底时显示浏览器窗口（默认无头）
  --browser-path  指定用哪条兜底路径：auto（默认，先 Chrome 后 Playwright）| chrome | playwright

所有命令输出 JSON 到 stdout，进度信息在 stderr。
`);
      return process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => fail(String((e && e.stack) || e)));
