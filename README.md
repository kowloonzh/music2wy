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

所有命令都把 JSON 打到 stdout，进度信息打到 stderr，方便脚本/agent 解析。

## 命令速查

```
login                              扫码登录网易云（终端画二维码 + 弹出 PNG）
whoami                             查看当前登录账号
search "<关键词>" [--limit 10]      搜索候选（结合网易云元数据打分排序）
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
`cookie.json`（登录态）、`session.json`（WAF 会话）、`cache/`、`downloads/`、`logs/`。

## 合规

**仅供个人自用**：把自己买不到的版本下到本地、放进自己的云盘自己听。

- 不要把下载的文件再分发、上传到公开平台或用于商业用途；
- 请遵守音源站与网易云的服务条款，控制请求频率；
- 本仓库不含任何音源内容，也不绕过任何付费内容——它只是个搬运工具。

## 第三方许可

- [qrcode-generator](https://www.npmjs.com/package/qrcode-generator)（Kazuhiko Arase, MIT）——
  见 `scripts/vendor/qrcode-LICENSE.txt`
- 本项目采用仓库根目录的 Apache-2.0 许可。
