# 故障排查 / 进阶用法

## 1. 「未登录 / 登录态失效」

```bash
node $SKILL_DIR/scripts/music2wy.mjs whoami
node $SKILL_DIR/scripts/music2wy.mjs login      # 重新扫码
```

`login` 会在终端画出二维码、把二维码存成 `~/.music2wy/login-qr.png` 并用系统看图程序弹出来。
即使终端不支持彩色，也可以用弹出的图片扫。

登录成功的 cookie 存在 `~/.music2wy/cookie.json`（权限 600），有效期通常几个月。

### 复用网易云音乐桌面客户端的登录态（macOS，可选）

如果本机装了网易云音乐桌面客户端并已登录，可以省掉扫码。客户端把 cookie 存在 MMKV 里，
本仓库附带一个解析脚本（需要 python3）：

```bash
python3 $SKILL_DIR/scripts/export_cookie.py     # 写出 ~/.musicbridge/cookie.json
```

`music2wy` 会自动把 `~/.musicbridge/cookie.json` 当作后备登录态读取
（`lib/ne.mjs` 里的 `LEGACY_COOKIE`），所以跑完这个脚本就能直接用。
客户端重新登录后需要再跑一次。

## 2. 站点报「客户端异常」/ 返回空 / 连不上

`flac.music.hi.cn` 前面挂了雷池（SafeLine）WAF，风控很敏感，站点本身也有限流。

### 先分清是「限流」还是「IP 被封」

这两件事发生在不同网络层，处理方式完全不同：

| 现象 | 含义 | 处理 |
|---|---|---|
| TCP 连得上，HTTP 返回 429 / 错误页 / 空结果 | **限流** | 等几分钟，加大间隔即可 |
| **TCP 握手就超时**（连 `curl` 都连不上） | **IP 被丢包封禁** | 只能等解封（通常十几分钟到 1 小时） |

一行命令判断：

```bash
nc -z -v -w 6 flac.music.hi.cn 443     # timed out = 被封；succeeded = 没被封
```

**验证站点到底活没活**：别用那些免费的 CORS 代理——很多对任何站点都返回 522（我就被坑过一次，
误判成"站点全球挂了"）。要用可靠的服务，**并且拿 baidu 做对照**：

```bash
curl -s "https://r.jina.ai/https://flac.music.hi.cn/" | head -5
curl -s "https://r.jina.ai/https://www.baidu.com/"     | head -3   # 对照
```

外部能拿到 **468 挑战页**，就说明站点活着、被挡的是我们的 IP。

### 处理顺序

1. **停下，不要连续重试，更不要写循环轮询。** 探测请求同样计数，高频探测只会延长封禁。
2. 等（十几分钟到 1 小时），再跑 `doctor` 看是否恢复。
3. 想确认自己打了多少请求：`node $SKILL_DIR/scripts/music2wy.mjs stats`
   （每次站点请求都记账在 `~/.music2wy/logs/requests.jsonl`）。
4. 把 `~/.music2wy/config.json` 里的 `minRequestIntervalMs` 调大（例如 `30000`）后重试。
5. 清掉缓存重新来：删 `~/.music2wy/cache/` 后重试。
6. 如果你能在浏览器里正常打开 `https://flac.music.hi.cn/`，说明封的是脚本这一侧的网络出口；
   可以先用浏览器**手动**下载到本地，再用本 skill 的后半段：

   ```bash
   node $SKILL_DIR/scripts/music2wy.mjs upload "/path/to/歌曲.flac" --title "歌名" --artist "歌手" --album "专辑"
   ```

   这条路径完全不碰站点，只做「写元数据 + 上传云盘」。
7. 有别的网络出口（换代理节点 / 手机热点）时，换 IP 可以立刻绕过封禁。

## 2.1 纯 Node 解不开挑战了 → 用 `--browser` 兜底

如果报的是"解不开挑战""WAF challenge still failing"，说明站点换了挑战算法（或者开始针对纯 HTTP 客户端）。
给命令加 `--browser`：

```bash
node $SKILL_DIR/scripts/music2wy.mjs search "泸沽湖" --browser
node $SKILL_DIR/scripts/music2wy.mjs browser-session --headed     # 只看挑战这一步
node $SKILL_DIR/scripts/music2wy.mjs browser-session --browser-path playwright
```

它会按 **本机 Chrome（CDP，零依赖）→ Python Playwright** 的顺序尝试，把拿到的
`sl-session` / `sl_jwt_session` 写进 `~/.music2wy/session.json`，后续请求就复用它（1 小时）。

排查要点：

- **Playwright 路径**需要 `pip install playwright && playwright install chromium`；没有就会自动跳过。
- **Chrome 路径**找不到浏览器时，用 `MUSIC2WY_CHROME=<路径>` 指定。
- **出口 IP 不一致**：Chrome 默认走系统代理、Node 默认直连，WAF 可能把会话绑到 IP 上。
  兜底时默认给 Chrome 传了 `--no-proxy-server`；如果你的网络必须走代理，设 `MUSIC2WY_CHROME_USE_PROXY=1`。
- **浏览器也过不去**：说明站点就是在拦自动化浏览器。**不要**去做反检测对抗，
  改走「手动下载 + 只上传」那条路（见上面第 2 节第 5 条）。
- 兜底**不会**每次都触发：cookie 能用就一直用，只有再遇到挑战页时才重新解。

## 3. 直链解析失败（sign 过期）

站点的搜索结果是带 `time` + `sign` 的，会过期。`get` 检测到过期会自动重新搜索一次并重试。
如果仍然失败，说明关键词或候选已经变了，重新 `search` 再选一次。

## 4. 音质怎么选

```bash
node $SKILL_DIR/scripts/music2wy.mjs get --pick 1 --quality flac   # 默认，无损
node $SKILL_DIR/scripts/music2wy.mjs get --pick 1 --quality 320    # 320K MP3（文件小）
```

站点上有哪些音质，看 `search` 输出里每条的 `formats`。如果某首歌没有 FLAC，
`pickVariant` 会自动退到 320K，再退到该候选实际有的最好音质。

## 5. 换音源平台

站点**只有两个上游平台**（从站点前端 bundle 里确认的）：

| 值 | 说明 |
|---|---|
| `kuwo` | 默认。duration 单位是**秒** |
| `wyy` | 网易云上游。duration 单位是**毫秒**（客户端已自动归一化） |

```bash
node $SKILL_DIR/scripts/music2wy.mjs search "泸沽湖" --platform wyy
node $SKILL_DIR/scripts/music2wy.mjs search "泸沽湖" --platform kuwo
```

用错平台值站点的搜索框里也没有第三项，直接用上面两个之一即可。

## 5.1 站点上没有原唱怎么办

有些歌手（典型：周杰伦）**两个平台上都只有翻唱**，搜出来一堆 "晴天 (原唱 周杰伦) — 某某翻唱歌手"。
脚本会在 `search` 的返回里给出 `warning` 字段明确提示这种情况：

> 站点（kuwo）上没有找到「周杰伦」的版本，下面列出的都是翻唱/其他艺人。

**这时必须如实告诉用户**，不要默默把翻唱当原唱下下来。
「歌手上传同款」的正确用法是：这首歌**别处有资源**（比如别的平台/手里已有文件），
用本 skill 的 `upload` 路径把它传进云盘：

```bash
node $SKILL_DIR/scripts/music2wy.mjs upload "/path/to/晴天.flac" --title "晴天" --artist "周杰伦" --album "叶惠美"
```

## 6. 上传失败

- **`cloud/pub/v2 失败 code=400`（大文件最常见）**：文件其实已经传上去了，只是服务端还在转码
  （`status 9` = 转码中，`0` = 完成）。脚本会自动退避重试约 3 分钟；还不行就等一两分钟补一次：
  ```bash
  node $SKILL_DIR/scripts/music2wy.mjs publish <返回里的 songId>
  ```
  如果一直 400 不恢复，通常说明**文件不是真实可解码的音频**。注意：用随机字节伪装成 mp3 时，
  整条链路（NOS、cloud/info）都会"成功"并返回 songId，只有 pub 会 400、列表里永远不出现。
  用 `ffprobe <file>` 先确认文件是真音频。
- **返回 `deduped: true`**：不是错误。同一个 md5 重复上传时服务端返回 `needUpload: false`，
  脚本会从云盘里找回已有的 songId 并确保它已发布，**不会产生重复条目**。
- **`cloud/info/v2` 偶发 404**：上游瞬时错误（响应里 `uploadStatus: 6`）。脚本会自动重新
  alloc + 重传 NOS + 重试 info（最多 3 次）。重试必须重传，因为每次的 objectKey 都不同。
- **cookie 过期**：重新 `login`。
- **文件格式**：mp3 / flac 最稳；其它格式建议先用 ffmpeg 转成这两种。

上传后 `cloud` 命令可以确认是否真的进了云盘：

```bash
node $SKILL_DIR/scripts/music2wy.mjs cloud --limit 20
```

## 7. 不写元数据 / 没有 ffmpeg

`ffmpeg`、`ffprobe` 缺失时脚本会跳过写标签，并明确告诉你 `tagged: false`。
下载和上传仍然可用。想补上就装 ffmpeg：

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian/Ubuntu
```

## 8. 想把配置固化下来

`~/.music2wy/config.json`：

```json
{
  "minRequestIntervalMs": 8000,
  "searchCacheTtlMs": 1800000,
  "urlCacheTtlMs": 1200000,
  "quality": "flac",
  "publish": true,
  "neteasePlaylist": null
}
```

用命令改也行：

```bash
node $SKILL_DIR/scripts/music2wy.mjs config '{"quality":"320","minRequestIntervalMs":15000}'
```
