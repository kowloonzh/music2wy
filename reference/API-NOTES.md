# API 与实现备注

这份文档记录两个外部系统的接口细节，方便以后接口变了能快速定位改哪里。

## A. flac.music.hi.cn（音源站）

站点前面挂了**雷池（SafeLine, chaitin）WAF**，直接 `curl` 会拿到 HTTP **468** 和一段
`SafeLineChallenge("<client_id>", {level:"N"})` 的挑战页。站点的真实接口是 `ajax.php`：

| act | 方法 | 表单参数 | 返回 |
|---|---|---|---|
| `search` | POST | `platform`, `keyword`, `page`, `size` | `{code, data:{total, list:[...]}}` |
| `getUrl` | POST | `platform`, `songid`, `format`, `bitrate`, `time`, `sign` | `{code, data:{url, format, bitrate, duration, songid}}` |
| `getLyric` | POST | `platform`, `songid`, `time`, `sign` | `{code, data:"<LRC 原文>"}` |

成功判定是 **`code === 0`**。

**平台只有两个值：`kuwo` 和 `wyy`**（从站点前端 bundle 的
`options:[{label:"kuwo",value:"kuwo"},{label:"wyy",value:"wyy"}]` 确认）。

`search` 每条结果的关键字段：`id`, `name`, `artist`, `album_name`, `duration`,
`pic_url`, `hasHQ`, `hasSQ`, `link`, `time`, `sign`, `minfo[]`。
`minfo[]` 每项形如 `{format:"flac"|"mp3", bitrate:"2000"|"320", size:"28.6MB"}`。

⚠️ **`duration` 的单位随平台而变**：`kuwo` 给**秒**（`"246"`），`wyy` 给**毫秒**（`"270738"`）。
客户端用 `toSeconds()` 统一归一化（>10000 视为毫秒），否则时长显示和校验全是错的。

⚠️ **关键词只能是单个词**：`keyword="晴天 周杰伦"` 会返回 `total: 0`。
所以编排层先用网易云参照推导出规范歌名（见 `music2wy.mjs` 的 `siteQueryPlan()`）。

**`time` + `sign` 是解析直链和取歌词的凭据，会过期**；过期后必须重新 `search` 拿新的。

### WAF 挑战的解法（纯 Node，无浏览器）

实现在 `scripts/lib/flac.mjs` 的 `solveChallenge()`：

1. `GET /` → 468，响应带 `Set-Cookie: sl-session=…`，页面里嵌 `SafeLineChallenge(client_id, {level})`。
   ⚠️ **`client_id` 每次刷新都会变**，必须从"刚刚拿到的那张挑战页"里解析；
   写死或用旧的 client_id 会让挑战 API 返回 `verified:true`、但站点依然 468。
2. `POST https://challenge.rivers.chaitin.cn/challenge/v2/api/issue`，body `{client_id, level}`
   → `{data:{data:[...], issue_id}}`。
3. `GET …/challenge/v2/calc.wasm` → 一个 911 字节的 wasm，导出 `reset/arg/calc/ret`
   （Node 可以直接 `WebAssembly.instantiate`）。
4. 本地跑 wasm 算出结果：`result = Array(calc()).fill(-1).map(() => ret())`。
5. `POST …/challenge/v2/api/verify`，body `{issue_id, result, serials, client}`
   → `{code:200, data:{verified:true, jwt:"…"}}`。
6. 带上 `sl-session` + `sl-challenge-jwt=<jwt>` 再请求一次 → 200。

⚠️ **`sl-challenge-jwt` 是一次性的**：那次成功响应会同时下发 `sl_jwt_session=<T>; Max-Age=3600`
并把 JWT 清掉（`Max-Age=1`）。所以必须解析 `Set-Cookie`，**用 `sl_jwt_session` 复用一小时**，
否则每个请求都要重解一次挑战。实现在 `mergeSetCookie()`。

cookie 存到 `~/.music2wy/session.json`，再次遇到 468 时自动重解。

> 这一步等价于浏览器把站点下发的挑战算一遍，只是为了在无浏览器环境里跑。
> 注：站点 CDN 缓存下的静态资源（`/static/img/*`、`/assets/*`）**不走 WAF**，
> 用它们判断"会话是否还有效"会误判，要用 `GET /`。

### 限流

站点有限流。客户端内置三层保护：

- **跨进程**的请求闸门：所有站点请求之间至少间隔 `FLAC_MIN_GAP_MS`（默认 8000ms），
  用 `~/.music2wy/ratelimit.json` 记录上次请求时间 —— 因为 CLI 每次调用都是新进程，
  只靠进程内的计时是拦不住的。
- `search` 响应按参数哈希落盘缓存（24 小时），重复搜索不打站点。
- 直链按「歌曲+音质」缓存，歌词不缓存（依赖 `time`/`sign`）。

命中限流时 `ajax()` 会抛 `RateLimited`。**不要循环重试**，等几分钟再说。
内置的 8 秒间隔是为了"永远不要试探出限流阈值"。

## B. 网易云音乐（云盘上传）

加密：`weapi` 用 AES-128-CBC（预设密钥 `0CoJUm6Qyw8W8jud` + 随机 16 字节密钥）再做 RSA
（`RSA_NO_PADDING`）加密随机密钥；`eapi` 用 AES-128-ECB（密钥 `e82ckenh8dichen8`）。

上传一首歌的完整链路（`scripts/lib/upload.mjs`）：

| 步骤 | 接口 | 说明 |
|---|---|---|
| 1 | `POST /weapi/cloud/upload/check` | 参数 `md5, length, ext, bitrate=999000, songId=0, version=1`。返回 `needUpload` / `songId`。`needUpload=false` 表示服务端已有同样 md5。**路径必须是 `/weapi/`；`/api/cloud/upload/check` 固定返回 `{"code":400,"message":"参数错误"}`。** |
| 2 | `POST /weapi/nos/token/alloc` | 参数 `bucket='', ext, filename, local=false, nos_product=3, type=audio, md5`。返回 `result.{bucket, objectKey, token, resourceId}`。 |
| 3 | **LBS 找上传节点** | `GET https://wanproxy.127.net/lbs?version=1.0&bucketname=<bucket>` → `upload[0]`，例如 `http://nosup-jd1.127.net`。 |
| 4 | `POST <node>/<bucket>/<objectKey>?offset=0&complete=true&version=1.0` | 头：`X-Nos-Token`、`Content-MD5`、`Content-Type`、`Content-Length`。>80MB 自动分片，续传用 `context` 查询参数。 |
| 5 | `POST /weapi/upload/cloud/info/v2` | 参数 `md5, songid, filename, song, album, artist, bitrate, resourceId` → 返回云盘 `songId`。 |
| 6 | `POST /weapi/v1/cloud/music/status` | 查询转码状态，`0` 已完成、`9` 转码中。 |
| 7 | `POST /weapi/cloud/pub/v2`（走 `interface.music.163.com`） | **必做**：不做这步，歌曲不会出现在云盘列表里。`200` 首次成功 / `201` 重复（幂等）/ `400` 转码未完成或文件不可解码。 |

### 关键坑

- **`error_policy_operation_not_match`**：之前把文件 POST 到 `nos.netease.com/ymusic/<key>` 会一直
  被拒。原因是**桶和区域不对** —— `nos_product:3` 现在返回的是 JD 区域的私有云桶
  `jd-musicrep-privatecloud-audio-public`，根本不是 `ymusic`。同一个 token 下的对照：
  `nos.netease.com/ymusic/<key>` → 400 `InvalidArgument`；
  `45.127.129.8/ymusic/<key>` → 400 `"BucketName or ObjectName dismatch In URL & Policy"`
  （即原来的 `error_policy_operation_not_match`）；
  必须先用 LBS 查出真实节点，再 `POST <node>/<bucket>/<objectKey>` → **200**。
- `offset` / `complete` / `context` 必须放在 **query string**，不是请求头。
- `objectKey` 要**逐段 URL 编码**，保留 `/` 分隔符（旧代码 `replace('/', '%2F')` 只替换第一个斜杠，是错的）。
- `ext` 要**带点**（`.flac` / `.mp3`）；`bitrate` 一律 `'999000'`。
- `upload/cloud/info/v2` 走 `music.163.com`，`cloud/pub/v2` 走 `interface.music.163.com`。
- **`cloud/info/v2` 会偶发瞬时 404**（响应里 `uploadStatus: 6`），必须重试；且重试要
  **重新 alloc + 重新上传 NOS**（objectKey 每次都变），只重试 info 无效。
- **`uploadStatus: 8` + `songId=0`**：文件已存在（同 md5），此时 info 拿不到 songId，需要从
  `/weapi/v1/cloud/get` 用 `fileName` + `fileSize` 找回已有 songId（云盘列表不返回 md5），
  再对它 pub 即可 —— 不会产生重复条目。
- **不要用随机字节冒充音频来测试**：NOS 和 cloud/info 都会"成功"并返回 songId，
  但 `pub` 返回 400、列表里永远不出现。只有真实可解码的音频才能验证整条链路。
- 大文件（20MB+ 无损）转码需要时间，pub 必须退避重试（实测 26MB FLAC 需要等待）。
- 实测未观察到硬性上传配额（连续上传多个文件均成功）。

### 登录

- 扫码：`POST /weapi/login/qrcode/unikey` `{type:1}` → `unikey`；
  二维码内容 `https://music.163.com/login?codekey=<unikey>`；
  轮询 `POST /weapi/login/qrcode/client/login` `{key, type:1}`：
  `800` 过期 / `801` 待扫码 / `802` 待确认 / `803` 成功（`Set-Cookie` 里带 `MUSIC_U`）。
- 登录态存 `~/.music2wy/cookie.json`。
