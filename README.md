# music2wy

把「网易云没有版权、听不了」的歌，从聚合站 [`flac.music.hi.cn`](https://flac.music.hi.cn/) 找到无损音源下载到本地，
写好人声/封面/歌词，再上传进**你自己的网易云音乐云盘**——这样就能在网易云 App 里正常听了。

全程**纯 Node，不需要浏览器**（连站点的 WAF 挑战也是在 Node 里算过去的）。
另有一条可选的浏览器兜底路径，见下文。

> 这是我个人的自用工具，打包成了一个 [DSH](https://github.com/) skill，也可以当普通 CLI 用。

---

## 它解决什么

网易云因为版权原因下架/搜不到的歌手（典型：周杰伦、部分独立音乐人），
在 App 里既听不了也下不了。这个工具把流程自动化成三步：

```
搜索音源 → 你确认版本 → 下载无损 → 写标签歌词 → 上传到你的云盘
```

## 环境要求

| 依赖 | 必需？ | 说明 |
|---|---|---|
| Node.js **≥ 18** | ✅ 必需 | 需要内置 `fetch`（推荐 20+） |
| ffmpeg / ffprobe | 可选 | 没有也能下载和上传，只是不写元数据/封面/歌词 |
| Python 3 + Playwright | 可选 | **只有**浏览器兜底路径需要 |
| Chrome / Chromium / Edge | 可选 | 同上，CDP 路径（零 Python 依赖） |

支持 macOS / Linux。零 npm 依赖——二维码生成器是 vendored 的一个 MIT 单文件库。

## 安装

### 作为 DSH / Claude 类 agent 的 skill

```bash
git clone https://github.com/kowloonzh/music2wy.git ~/workspace/music2wy
ln -s ~/workspace/music2wy ~/.agents/skills/music2wy
```

之后直接用自然语言触发即可，例如「帮我下载歌曲泸沽湖」。

### 当普通 CLI 用

```bash
git clone https://github.com/kowloonzh/music2wy.git
cd music2wy
node scripts/music2wy.mjs doctor
```

## 快速开始

```bash
M=node\ scripts/music2wy.mjs      # 下文用 $M 代指

# 0) 自检（默认不打站点）
node scripts/music2wy.mjs doctor

# 1) 登录网易云（弹出二维码，手机 App 扫码）
node scripts/music2wy.mjs login

# 2) 搜索，拿到候选列表
node scripts/music2wy.mjs search "泸沽湖 麻园诗人"

# 3) 挑第 1 个下载（默认 FLAC 无损）
node scripts/music2wy.mjs get --pick 1

# 4) 上传到云盘
node scripts/music2wy.mjs upload "$HOME/.music2wy/downloads/泸沽湖 - 麻园诗人.flac"
```

只知道歌手名、想先浏览曲目时，用歌手搜索：

```bash
node scripts/music2wy.mjs artist "麻园诗人"           # 第 1 页，最多 20 条
node scripts/music2wy.mjs artist "麻园诗人" --page 2  # 下一页
node scripts/music2wy.mjs show                    # 重看当前页，不请求站点
node scripts/music2wy.mjs get --pick 4            # 选定当前页第 4 条后下载
```

歌手搜索只保留歌手字段匹配的结果，独唱排在合作曲目前，保留不同录音版本。页码来自站点，
`total` 是搜索记录数，不等于独立歌曲数；翻页后候选编号从 1 重新开始。
下载时若搜索签名过期，脚本会刷新原页并按歌曲 ID 找回同一条，找不到就停止。先确认候选再下载。

所有命令都把 JSON 打到 stdout，进度信息打到 stderr，方便脚本/agent 解析。

## 实际效果

下面是真实跑过的两首歌（输出有删减，数字都是实测值）。

### 搜索：候选排序

```console
$ node scripts/music2wy.mjs search "晚安 麻园诗人"
[参照] 网易云官方: 晚安 — 麻园诗人 (4:26)
[站点] 搜索 "晚安" (platform=kuwo) …
```

| # | 歌名 | 歌手 | 专辑 | 时长 | 音质 | 评分 |
|---|---|---|---|---|---|---|
| **1 ⭐** | 晚安 | **麻园诗人** | 不爱说话的人 | 4:26 | flac/2000k, mp3/320k | **112** |
| 2 | 晚安 | 张艺兴 | 晚安 | 4:18 | flac/2000k, mp3/320k | 34 |
| 3 | 晚安 | 柯宇（孙泽耀） | 晚安 | 4:09 | flac/2000k, mp3/320k | 30 |
| 4 | 晚安 (颜人中) (cover: khjn) | 六分之三 | 六分之三翻唱集 | 4:44 | flac/2000k | 30 |

原版 112 分，第二名 34 分——**歌手名命中是强信号**，翻唱会被压在下面。

### 下载：自动校验

```console
$ node scripts/music2wy.mjs get --pick 1
[站点] 解析直链 晚安 / flac 2000k …
[下载] 完成 /Users/…/晚安 - 麻园诗人.flac (56.2MB)
✅ 时长校验: 下载 266s vs 期望 266s（来源 netease，偏差 0%）
[歌词] 已取网易云官方歌词 458 字符
[元数据] 已写入标题/歌手/专辑/封面/歌词
```

```jsonc
{
  "ok": true,
  "file": "~/.music2wy/downloads/晚安 - 麻园诗人.flac",
  "sizeText": "56.2MB",
  "meta": { "title": "晚安", "artist": "麻园诗人", "album": "不爱说话的人" },
  "probe": { "codec": "flac", "sampleRate": 48000, "channels": 2,
             "bitRate": 1769662, "duration": 266.36 },
  "verify": { "durationDownloaded": 266, "durationExpected": 266,
              "drift": 0.0013, "ok": true, "source": "netease" },
  "tagged": true
}
```

`probe.bitRate` 1.77 Mbps、48kHz 立体声 = 真无损，不是把 MP3 转封装成 FLAC 的假货。

### 上传：转码要等

```console
$ node scripts/music2wy.mjs upload "…/晚安 - 麻园诗人.flac"
[上传] 晚安 - 麻园诗人.flac → 云盘 (晚安 / 麻园诗人) …
[上传] ✅ songId=3438747705
```

内部步骤（`--json` 可见完整 `steps`）：

```
upload/check        → 200  needUpload=true
nos/token/alloc     → 200  bucket=jd-musicrep-privatecloud-audio-public
lbs                 → node=http://nosup-jd1.127.net      ← 关键：动态查上传节点
nos/upload          → 200  58,955,899 bytes
upload/cloud/info/v2→ 200  songId=3438747705
cloud/music/status  → 1 ×5（转码中，退避等待）
cloud/pub/v2        → 200  第 6 次成功                    ← 不做会不出现在云盘列表
```

56MB 的无损等了 5 轮才转码完。**这正是"固定重试 5 次"会假失败的地方**，所以脚本用的是退避重试。

## 工作原理

```
┌─ search ────────────────────────────────────────────────────────┐
│  1. 问网易云（不受限流）拿「参照曲目」，核对歌名+歌手是否可信      │
│  2. 推导站点能接受的搜索词（站点只认单个关键词）                  │
│  3. POST flac.music.hi.cn/ajax.php?act=search                   │
│  4. 用「参照 + 输入词 + 站点结果共识投票」给候选打分排序          │
└─────────────────────────────────────────────────────────────────┘
┌─ get ───────────────────────────────────────────────────────────┐
│  5. POST ajax.php?act=getUrl  → CDN 直链（纯 HTTP 下载，不占站点）│
│  6. ffprobe 校验时长（对比网易云官方时长，偏差 >25% 会告警）      │
│  7. 歌词：网易云官方 LRC → 音源站 getLyric（两级回退）            │
│  8. ffmpeg 写入 title/artist/album/封面/歌词（流拷贝，不重编码）  │
└─────────────────────────────────────────────────────────────────┘
┌─ upload ────────────────────────────────────────────────────────┐
│  9. upload/check → nos/token/alloc → LBS 查节点 → NOS 直传       │
│ 10. upload/cloud/info/v2 → 等转码 → cloud/pub/v2（必做）         │
└─────────────────────────────────────────────────────────────────┘
```

### 站点 WAF 挑战是怎么解掉的

站点前面挂着**雷池（SafeLine）WAF**，普通 HTTP 请求会拿到 **468** 挑战页。解法就是在 Node 里
把它下发的证明算一遍（等价于浏览器做的事，只是没有浏览器）：

```
GET  /                                → 468 + Set-Cookie: sl-session
                                       页面里嵌 SafeLineChallenge("<client_id>", {level})
                                       ⚠️ client_id 每次刷新都变，必须现取
POST challenge.rivers.chaitin.cn/challenge/v2/api/issue    {client_id, level}
GET  …/challenge/v2/calc.wasm         → 911 字节，Node 原生 WebAssembly 直接实例化
       result = Array(calc()).fill(-1).map(() => ret())
POST …/challenge/v2/api/verify        {issue_id, result, serials, client}
       → {verified:true, jwt:"…"}
GET  /                                → 带上 sl-session + sl-challenge-jwt，返回 200
       ⚠️ sl-challenge-jwt 是一次性的！响应会下发 sl_jwt_session（1 小时）并清掉 JWT
          必须接住并复用 sl_jwt_session，否则每个请求都要重解一次
```

细节见 [`reference/API-NOTES.md`](reference/API-NOTES.md)。

### 网易云盘上传为什么会 `error_policy_operation_not_match`

这是最坑的一个。老的开源实现（NeteaseCloudMusicApi，已归档）把文件 POST 到
`nos.netease.com/ymusic/<key>`，**现在会被拒**，因为 `nos_product:3` 返回的桶和区域已经变了：

| 上传地址 | 结果 |
|---|---|
| `nos.netease.com/ymusic/<key>` | 400 `InvalidArgument` |
| `45.127.129.8/ymusic/<key>` | 400 `BucketName or ObjectName dismatch In URL & Policy` |
| **`GET wanproxy.127.net/lbs?bucketname=<bucket>` 查到的节点** | ✅ **200** |

正确做法是先用 **LBS 服务查出该 bucket 真实的上传节点**（如 `http://nosup-jd1.127.net`），
再 `POST <node>/<bucket>/<objectKey>?offset=0&complete=true&version=1.0`。

另外两个坑：`offset/complete/context` 必须放在 **query string**（不是请求头）；
`objectKey` 要**逐段 URL 编码**（老代码 `replace('/', '%2F')` 只换了第一个斜杠）。

## 命令速查

```
login                              扫码登录网易云（终端画二维码 + 弹出 PNG）
whoami                             查看当前登录账号
search "<关键词>" [--limit 10]      搜索候选（结合网易云元数据打分排序）
artist "<歌手名>" [--page N]       按歌手浏览歌曲（每页最多 20 条）
show                               重新打印上次候选（零请求）
get --pick N [--quality flac|320]  下载第 N 个候选，写元数据/歌词
upload <file...> [--title/--artist/--album]
publish <songId...>                重试发布（大文件转码没跟上时用）
cloud [--limit 50]                 列出云盘歌曲
playlist-add --name "歌单" --files a.flac,b.flac
clean-cloud [--yes]                清理云盘里的测试残留（默认只列出不删）
browser-session [--headed]         用真浏览器解一次站点挑战（兜底）
stats                              查看站点请求记账
doctor [--site]                    环境自检（默认不打站点）
```

### 参数详解

**通用开关**（任何命令都能用）

| 参数 | 作用 |
|---|---|
| `--browser` | 纯 Node 解不开站点挑战时，自动用真浏览器兜底解一次 |
| `--headed` | 兜底时**显示浏览器窗口**（默认无头），方便肉眼确认 |
| `--browser-path <p>` | 指定兜底路径：`auto`（默认，先 Chrome 后 Playwright）/ `chrome` / `playwright` |

**`search`**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--limit N` | `10` | 展示多少条候选（会话里会存全量，方便往下翻） |
| `--platform <p>` | `kuwo` | 上游平台，**只有 `kuwo` 和 `wyy` 两个值** |
| `--refresh` | — | 忽略缓存，强制重新搜站点（**会消耗站点配额**） |

**`artist`**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--page N` | `1` | 查看第 N 页；每页最多 20 条，编号从 1 重新开始 |
| `--platform <p>` | `kuwo` | 上游平台，只支持 `kuwo` 和 `wyy` |
| `--refresh` | — | 忽略缓存重新请求当前页（会消耗站点配额） |

**`get`**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--pick N` | 必填 | 选第 N 个候选（序号来自最近一次 `search` 或 `artist`） |
| `--quality <q>` | `flac` | `flac` / `320` / `128`；没有 FLAC 会自动退到 320 |
| `--query "<词>"` | — | 会话失效时重新搜索用的关键词 |
| `--outdir <dir>` | `~/.music2wy/downloads` | 输出目录 |
| `--no-lyrics` | — | 不取歌词 |
| `--no-tag` | — | 不写元数据（需要用 ffmpeg） |
| `--no-cache` | — | 忽略直链缓存，重新解析 |
| `--force` | — | 强制重新按歌名搜索；歌手会话请先用 `artist --refresh` 更新列表再选编号 |

**`upload`**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--title/--artist/--album` | 从文件名 `歌名 - 歌手` 解析 | 云盘里显示的元数据 |
| `--no-publish` | — | **不发布**。注意：不发布的话歌曲不会出现在云盘列表 |

**配置文件** `~/.music2wy/config.json`

```jsonc
{
  "minRequestIntervalMs": 15000,   // 站点请求最小间隔（跨进程闸门）
  "searchCacheTtlMs": 1800000,     // 搜索结果缓存 30 分钟
  "urlCacheTtlMs": 1200000,        // 直链缓存 20 分钟
  "quality": "flac",               // 默认音质
  "publish": true                  // 上传后是否自动发布
}
```

命令行改配置：

```bash
node scripts/music2wy.mjs config '{"minRequestIntervalMs":30000}'
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `MUSIC2WY_HOME` | 状态目录，默认 `~/.music2wy` |
| `MUSIC2WY_DOWNLOAD_DIR` | 下载目录 |
| `MUSIC2WY_COOKIE` | 指定 cookie 文件 |
| `FLAC_MIN_GAP_MS` | 覆盖站点请求最小间隔 |
| `MUSIC2WY_CHROME` | 指定 Chrome 可执行文件路径 |
| `MUSIC2WY_CHROME_USE_PROXY=1` | 让兜底浏览器走系统代理（默认**不走**，见下） |
| `MUSIC2WY_BROWSER_PATH` | 兜底路径 `auto`/`chrome`/`playwright` |
| `NE_COOKIE` | 直接用一串 cookie，跳过读文件 |

> 为什么兜底浏览器默认**不走**系统代理：Node 的 `fetch` 默认直连（undici 忽略 `http_proxy`），
> 而 Chrome 默认走系统代理。两边出口 IP 不一致时，WAF 可能把会话和 IP 绑定，
> 导致「浏览器解出来的 cookie 交给 Node 用」直接失效。所以默认让浏览器也直连、保持同 IP。

## 几个设计上的关键点

- **不会下错版本。** 候选会用网易云官方元数据打分排序；如果网易云根本没有这位歌手的版权
  （搜索只会返回翻唱），脚本**不会**把翻唱当原唱——它会用站点结果做「共识投票」推断原唱，
  并在结果里给出 `warning` 明确提示。
- **元数据只信核对过的。** 选中的歌会拿去网易云核对歌名**和**歌手，两个都对得上才用它的专辑/时长；
  对不上就用音源站自带的元数据，**绝不拿翻唱的信息覆盖**。
- **歌词两级回退。** 网易云官方 LRC → 音源站自己的 `getLyric`。都没有就跳过（不影响下载上传）。
- **可选的浏览器兜底。** `--browser` 会在纯 Node 解不开挑战时，启动一次真浏览器
  （顺序：本机 Chrome/CDP → Python Playwright）把 cookie 交给后续流程。
  **刻意不做反检测伪装**——只是「用浏览器访问一个你自己也能打开的网站」。
- **请求记账。** 每一次打到站点的请求都记账在 `~/.music2wy/logs/requests.jsonl`，
  `stats` 命令可以看。下载一首歌只需要 **3 个站点请求**（冷启动 5 个）。

## ⚠️ 已知限制：站点风控很敏感

`flac.music.hi.cn` 前面挂了雷池（SafeLine）WAF，**对自动化流量的容忍度不高**。
我踩过的坑：

- 站点**只接受单个关键词**：`keyword="晴天 周杰伦"` 会返回 0 条。脚本会自动拆解。
- `wyy` 上游的 `duration` 是**毫秒**，`kuwo` 是**秒**。脚本已归一化。
- **可能被 IP 级封禁**：表现为 `ping` 通但 TCP 全端口超时（防火墙丢包）。
  这是**临时**的，通常十几分钟到 1 小时。判断方法和处理见
  [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md)。
- **不要写循环去轮询站点**。探测请求同样计数，高频探测只会延长封禁。
- 脚本内置了 15 秒的跨进程请求闸门 + 结果缓存，可用
  `node scripts/music2wy.mjs config '{"minRequestIntervalMs":30000}'` 调大。

被封期间可以走「手动下载 + 只上传」这条路（完全不碰站点）：

```bash
node scripts/music2wy.mjs upload "/path/to/歌曲.flac" --title "歌名" --artist "歌手" --album "专辑"
```

## 目录结构

```
SKILL.md                    agent 用的主文档（流程、展示模板、规则）
reference/
  API-NOTES.md              两个系统的接口细节（换算法时改这里）
  TROUBLESHOOTING.md        排查手册
scripts/
  music2wy.mjs              编排 CLI
  browser_session.py        Playwright 兜底助手
  export_cookie.py          可选：复用网易云桌面客户端登录态（macOS）
  lib/
    flac.mjs                音源站客户端（WAF 挑战、搜索、取直链、歌词）
    ne.mjs                  网易云客户端（扫码登录、搜索、歌词、云盘、歌单）
    upload.mjs              云盘上传（LBS 找节点 + NOS 直传 + 发布）
    browser.mjs             浏览器兜底（Chrome CDP / Playwright）
    rank.mjs                候选打分
    tag.mjs                 元数据/封面/歌词写入（ffmpeg）
    qr.mjs                  二维码渲染（终端 + PNG）
    util.mjs                路径、缓存、输出
  vendor/                   MIT 许可的二维码生成器
```

运行时状态一律在 **`~/.music2wy/`**（仓库之外）：

| 文件 | 内容 |
|---|---|
| `cookie.json` | 网易云登录态（权限 600） |
| `session.json` | 站点 WAF 会话 cookie（1 小时有效） |
| `last-search.json` | 上次搜索的完整候选（`show` 和 `get` 用） |
| `ratelimit.json` | 跨进程请求闸门的最后时间戳 |
| `login-qr.png` | 扫码登录的二维码图片 |
| `cache/` | 站点响应缓存 + 直链缓存 |
| `downloads/` | 下载好的音频文件 |
| `logs/requests.jsonl` | 站点请求记账 |
| `artifacts/` | 挑战用的 `calc.wasm` |

## 常见问题

**Q：会不会下错歌？下到翻唱怎么办？**

脚本会用网易云官方元数据给候选打分（歌手命中权重最高），并做两层保护：
如果网易云**没有**这位歌手的版权（搜索只会返回翻唱），它会用「站点结果的歌手共识投票」推断原唱；
如果连共识都没有，会在返回里给出 `warning` 字段明确告诉你「站点上没有找到 XXX 的版本」。
下载后还有**时长校验**（对比官方时长，偏差 >25% 会标 ⚠️）。

**Q：下载/上传完，怎么确认云盘里真的有？**

```bash
node scripts/music2wy.mjs cloud --limit 10
```

注意上传后 songId 可能会**变**——网易云会把你的云盘文件自动匹配到官方曲库条目，
这时列表里显示的是官方 songId（`matchType` 从 `unmatched` 变成 `matched`）。这是好事。

**Q：为什么 `upload` 有时候很慢？**

大文件（20MB+ 无损）需要等服务端转码，转码没完成时 `cloud/pub/v2` 会返回 400。
脚本用退避重试最多等约 3 分钟。实测 56MB 的 FLAC 需要等 5 轮。
如果最终失败会返回 `retryable: true`，过一两分钟补一次即可：

```bash
node scripts/music2wy.mjs publish <songId>
```

**Q：同一个文件传两次会不会重复？**

不会。`upload/check` 会返回 `needUpload: false`，脚本从云盘列表找回已有 songId
（返回 `deduped: true`）并确保它已发布。

**Q：报「连不上站点」/ 一直 468 怎么办？**

先分清是**限流**还是**IP 被封**——这两件事在不同网络层：

```bash
nc -z -v -w 6 flac.music.hi.cn 443
# succeeded  → 没被封（可能是限流，等几分钟）
# timed out  → TCP 被丢包，IP 级封禁，只能等（通常十几分钟到 1 小时）
```

`ping` 通但 TCP 不通，就是典型的 IP 封禁。**不要写循环去轮询**——探测也计数，
高频探测只会延长封禁。完整排查见 [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md)。

**Q：我想直接手动下载，只用它上传行不行？**

完全可以，这条路径**完全不碰站点**：

```bash
node scripts/music2wy.mjs upload "/path/to/歌曲.flac" \
     --title "歌名" --artist "歌手" --album "专辑"
```

**Q：没有 ffmpeg 能用吗？**

能。会跳过写标签，返回 `tagged: false`，下载和上传都正常。

**Q：扫码登录的二维码在哪？**

`login` 会**在终端里画出来**（半块字符 + 强制黑白配色），同时存成
`~/.music2wy/login-qr.png` 并**用系统看图程序弹出来**，还会打印二维码链接。
终端吞掉颜色时用弹出来的图片扫即可。

**Q：会不会读取我的隐私数据？**

不会。只读两处：`~/.music2wy/cookie.json`（你自己的登录态）和
（可选，macOS）网易云桌面客户端的本地存储来复用登录态。不收集、不上传任何东西。

## 开发 / 调试

```bash
# 看站点请求记账：打了几个请求、哪些失败了
node scripts/music2wy.mjs stats

# 只看挑战这一步（不搜歌），弹窗版便于肉眼确认
node scripts/music2wy.mjs browser-session --headed

# 跳过缓存强制重新搜（注意消耗配额）
node scripts/music2wy.mjs search "关键词" --refresh

# 清空站点缓存重来
rm -rf ~/.music2wy/cache/
```

调参时最有用的两个文件：
[`reference/API-NOTES.md`](reference/API-NOTES.md)（接口细节，站点换算法时改这里）、
[`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md)（排查手册）。

## 项目状态

诚实标注哪些是实测过的、哪些还没：

| 能力 | 状态 |
|---|---|
| 扫码登录网易云（终端 + PNG 二维码） | ✅ 实测 |
| 站点搜索 + 打分排序 + 原唱推断 | ✅ 实测（《泸沽湖》《晚安》） |
| 下载 FLAC/320K + 时长校验 | ✅ 实测（偏差 0%） |
| 写元数据/封面/歌词（两级回退） | ✅ 实测 |
| 云盘上传 + 转码等待 + 同 md5 去重 | ✅ 实测（含 56MB 大文件） |
| 加入歌单 / 云盘列表 / 清理 | ✅ 接口实测 |
| 请求记账 / 跨进程限流闸门 | ✅ 实测 |
| `--browser` 兜底 | 🟡 **部分**：浏览器链路本身已验证（能启动 Chrome、通过 CDP 读到含 HttpOnly 的 cookie），但**还没在目标站点上成功过一次**——每次测都撞上站点不可达 |

已知的坑（都已在代码里处理，见 [`reference/API-NOTES.md`](reference/API-NOTES.md)）：
站点只认单个关键词、`wyy` 上游时长是毫秒、网易云无版权歌手的搜索全是翻唱、
云盘上传必须走 LBS 查节点、`cloud/pub/v2` 必做且要等转码。

## 合规

**仅供个人自用**：把自己买不到的版本下到本地、放进自己的云盘自己听。

- 不要把下载的文件再分发、上传到公开平台或用于商业用途；
- 请遵守音源站与网易云的服务条款，控制请求频率；
- 本仓库不含任何音源内容，也不绕过任何付费内容——它只是个搬运工具。

## 第三方许可

- [qrcode-generator](https://www.npmjs.com/package/qrcode-generator)（Kazuhiko Arase, MIT）——
  见 `scripts/vendor/qrcode-LICENSE.txt`
- 本项目采用仓库根目录的 Apache-2.0 许可。
