// browser.mjs — 兜底方案：用真浏览器解一次站点的 WAF 挑战，把 cookie 交回给纯 Node 客户端。
//
// 什么时候需要它：站点换了挑战算法、或者我们的纯 Node 复现被风控盯上、导致 `lib/flac.mjs`
// 自己解不开挑战（一直 468）时。日常不需要，所以默认关闭，只有 `--browser` 才启用。
//
// 两条路径，按顺序尝试：
//   1. 本机 Chrome + CDP（零依赖，不需要 Python，最快）
//   2. Python Playwright（用户机器上装了 playwright 时）
//
// 设计上刻意**不做**反检测伪装（不伪造 navigator.webdriver、不注入 stealth 脚本）：
// 我们只是"用浏览器访问一个用户自己也能正常打开的网站"，而不是要骗过风控。
// 如果站点就是不放行自动化浏览器，那就如实报错，而不是继续对抗。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_HELPER = path.join(HERE, '..', 'browser_session.py');

const CHROME_CANDIDATES = [
  process.env.MUSIC2WY_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 CDP 返回的 cookie 数组里挑出站点域下我们关心的那几个。 */
function pickSiteCookies(cookies, hostname) {
  const out = {};
  for (const c of cookies || []) {
    const d = String(c.domain || '').replace(/^\./, '');
    if (d !== hostname && !hostname.endsWith(d)) continue;
    out[c.name] = c.value;
  }
  return out;
}

/** 判断拿到的 cookie 是否已经足够让后续 HTTP 请求通过 WAF。 */
function sessionReady(cookies) {
  // sl_jwt_session 是挑战通过后下发的长效会话（1 小时）；sl-session 是必须的前置。
  return !!cookies['sl-session'] && (!!cookies['sl_jwt_session'] || !!cookies['sl-challenge-jwt']);
}

// ------------------------------------------------------------------ 1) Chrome + CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  static async connect(wsUrl, timeoutMs = 20000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP WebSocket 失败')); }, { once: true });
    });
    return new CDP(ws);
  }
}

/**
 * 用本机 Chrome + CDP 打开站点，等它自己把挑战过掉，然后取 cookie。
 * @returns {Promise<{cookies:object, via:string, title:string|null}>}
 */
export async function solveViaChromeCDP({ url, headed = false, timeoutMs = 60000, log = () => {} } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('本机找不到 Chrome/Chromium/Edge，可设 MUSIC2WY_CHROME 指定路径');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'music2wy-chrome-'));
  const args = [
    headed ? '--new-window' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1280,900',
  ];
  // 关键：Chrome 默认会走**系统代理**（macOS 上常见是 127.0.0.1:7890 之类），
  // 而 Node 的 fetch 默认**直连**。两边出口 IP 不一致时，WAF 可能把会话和 IP 绑定，
  // 于是"浏览器解出来的 cookie 交给 Node 用"就会失效。所以默认让浏览器也直连。
  // 如果你的网络必须走代理才能访问该站，设 MUSIC2WY_CHROME_USE_PROXY=1 关掉这个行为。
  if (process.env.MUSIC2WY_CHROME_USE_PROXY !== '1') args.push('--no-proxy-server');
  args.push(url);
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');

  log(`[浏览器] 启动 ${path.basename(chrome)} ${headed ? '(有窗口)' : '(无头)'} …`);
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref?.();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 2500).unref?.();
  };

  try {
    // Chrome 会把实际端口写进 <profile>/DevToolsActivePort（第一行端口，第二行 ws 路径）
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let port = null;
    while (Date.now() < deadline) {
      try {
        const txt = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        if (txt[0]) { port = Number(txt[0]); break; }
      } catch { /* not ready */ }
      if (child.exitCode !== null) throw new Error(`Chrome 提前退出（code ${child.exitCode}）${stderr.slice(-200)}`);
      await sleep(200);
    }
    if (!port) throw new Error('等不到 Chrome 的调试端口');

    // 找到页面 target
    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* retry */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('拿不到 Chrome 的页面 target');

    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Network.enable');
    await cdp.send('Page.enable').catch(() => {});

    // 命令行传 URL 偶尔会落在空白页/错误页上，这里补一次显式导航
    const cur = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      .then((r) => r?.result?.value || '').catch(() => '');
    if (!cur.startsWith('http') || cur.startsWith('chrome-error://')) {
      log('[浏览器] 补一次显式导航 …');
      await cdp.send('Page.navigate', { url }).catch(() => {});
    }

    const hostname = new URL(url).hostname;
    let cookies = {};
    let title = null;
    let navRetried = false;
    while (Date.now() < deadline) {
      try {
        const r = await cdp.send('Network.getCookies', { urls: [url] });
        cookies = pickSiteCookies(r.cookies, hostname);
        if (sessionReady(cookies)) {
          // 确认页面真的过了挑战（而不是还停在 468 页）
          const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => null);
          title = t?.result?.value ?? null;
          if (title && !/SafeLine|验证|challenge/i.test(title)) break;
        } else {
          // 如果页面已经掉到错误页，重试一次导航
          const href = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
            .then((x) => x?.result?.value || '').catch(() => '');
          if (!navRetried && href.startsWith('chrome-error://')) {
            navRetried = true;
            log('[浏览器] 页面加载失败，重试一次导航 …');
            await cdp.send('Page.navigate', { url }).catch(() => {});
          }
        }
      } catch { /* retry */ }
      await sleep(400);
    }

    if (!sessionReady(cookies)) {
      throw new Error(`浏览器没能过挑战（拿到 cookie: ${Object.keys(cookies).join(',') || '无'}）`);
    }
    log(`[浏览器] 挑战已通过，取得 ${Object.keys(cookies).join(', ')}`);
    return { cookies, via: 'chrome-cdp', title };
  } finally {
    cleanup();
  }
}

// ------------------------------------------------------------------ 2) Python Playwright
function playwrightAvailable() {
  const r = spawnSync('python3', ['-c', 'import playwright'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0;
}

/**
 * 用 Python + Playwright 打开站点过挑战。
 * 关键点：WAF 的 cookie 是 HttpOnly，`document.cookie` 取不到，必须用 `ctx.cookies()`。
 */
export async function solveViaPlaywright({ url, headed = false, timeoutMs = 60000, log = () => {} } = {}) {
  if (!fs.existsSync(PLAYWRIGHT_HELPER)) throw new Error(`找不到 Playwright 助手脚本: ${PLAYWRIGHT_HELPER}`);
  if (!playwrightAvailable()) throw new Error('python3 里没有安装 playwright（pip install playwright && playwright install chromium）');

  log(`[浏览器] 启动 Playwright Chromium ${headed ? '(有窗口)' : '(无头)'} …`);
  const args = [PLAYWRIGHT_HELPER, '--url', url, '--timeout', String(timeoutMs), headed ? '--headed' : '--headless'];
  const timeout = timeoutMs + 30000;
  const p = spawnSync('python3', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  const out = (p.stdout || '').trim();
  const line = out.split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`Playwright 助手没有输出：${(p.stderr || '').slice(-300)}`);
  let j; try { j = JSON.parse(line); } catch { throw new Error(`Playwright 输出无法解析: ${line.slice(0, 300)}`); }
  if (!j.ok) throw new Error(`Playwright 失败: ${j.error}`);
  log(`[浏览器] 挑战已通过，取得 ${Object.keys(j.cookies).join(', ')}`);
  return { cookies: j.cookies, via: 'playwright', title: j.title ?? null };
}

// ------------------------------------------------------------------ 统一入口
/**
 * 依次尝试各条浏览器路径，返回能用的 cookie。
 * @param {'auto'|'chrome'|'playwright'} prefer
 */
export async function browserSolve({ url, headed = false, prefer = 'auto', timeoutMs = 60000, log = () => {} } = {}) {
  const attempts = prefer === 'chrome' ? ['chrome']
    : prefer === 'playwright' ? ['playwright']
      : ['chrome', 'playwright'];
  const errors = [];
  for (const which of attempts) {
    try {
      const r = which === 'chrome'
        ? await solveViaChromeCDP({ url, headed, timeoutMs, log })
        : await solveViaPlaywright({ url, headed, timeoutMs, log });
      return { ...r, errors };
    } catch (e) {
      log(`[浏览器] ${which} 路径失败：${e.message}`);
      errors.push({ via: which, error: e.message });
    }
  }
  const err = new Error(`所有浏览器兜底路径都失败了：${errors.map((e) => `${e.via}: ${e.error}`).join(' | ')}`);
  err.attempts = errors;
  throw err;
}

export function browserAvailability() {
  const chrome = findChrome();
  return {
    chrome,
    playwright: playwrightAvailable(),
    helper: fs.existsSync(PLAYWRIGHT_HELPER) ? PLAYWRIGHT_HELPER : null,
  };
}
