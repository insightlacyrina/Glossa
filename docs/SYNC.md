# Mac 自托管同步

## 实现范围与证据

实现决策：同步服务是独立 Node.js 24 进程；客户端与服务端职责分离。服务端保存不可变操作与完整对象载荷，以 SQLite WAL、`synchronous=FULL` 提交，重复发送幂等。B、映射、页面、知识块、复习等领域内容由共享数据内核记录为操作，服务端不猜测合并语义。相同操作身份携带不同内容时拒绝写入，不覆盖历史。

`tests/sync.test.ts` 通过真实本机 HTTP 验证：完整笔迹载荷、重复发送、身份碰撞拒绝、两客户端拉取、分页、服务器关闭后恢复、SQLite 一致性快照恢复、鉴权、CORS、加密及篡改验证。测试机是 Linux，不是 Mac。**尚未验证：真实 macOS launchd 常驻、用户局域网、路由器转发、互联网 HTTPS、Mac 休眠唤醒。** 以下给出可执行部署配置，不将配置文件等同于公网验证成功。

## 启动

要求 Node.js 24.19 或兼容的 24.x（使用内置 `node:sqlite`），客户端已 `npm ci && npm run build`。

```bash
cd /path/to/quiet-paper
export QUIET_PAPER_TOKEN="$(openssl rand -hex 32)"
export QUIET_PAPER_DATA="$PWD/server-data"
npm run server
```

默认监听 `127.0.0.1:8787`，同源提供 `dist` 客户端及 `/api/sync`。令牌由用户保存在密码管理器，在客户端的同步设置中填写；启动日志不打印令牌。`GET /health` 可检测服务存活，`GET /api/status` 需要 Bearer 令牌。

需要对局域网监听时可设置 `HOST=0.0.0.0`；客户端访问 Mac 的局域网地址也必须使用 HTTPS，可通过下述 Caddy 或私网 HTTPS 入口。HTTP 仅允许本机 localhost/回环开发，不能将局域网 HTTP IP 误当成可用生产入口。跨源客户端必须将准确来源加入逗号分隔的 `QUIET_PAPER_ORIGINS`，例如 `http://localhost:5173,https://appassets.quietpaper.local`。只接受显式来源；不接受任意网站。当前 Android 容器固定使用 `https://appassets.quietpaper.local`。

## 互联网访问（两种部署方式）

1. 自有域名 + HTTPS：将 `server/Caddyfile.example` 改为真实域名，DNS 指向公网地址，路由器将 TCP 80/443 转发给 Mac，运行 Caddy；服务仍只监听 Mac 本机 8787。设置 `QUIET_PAPER_ORIGINS=https://你的域名,https://appassets.quietpaper.local`。`https://你的域名` 同时是客户端 URL 与同步服务 URL。反向代理转发后仍需准确配置 HTTPS 来源。
2. 私有互联网互联：Mac 与 Android 安装并配置用户自己的 Tailscale 网络，运行 `tailscale serve --bg http://127.0.0.1:8787`，使用其 HTTPS 地址并将该来源加入 `QUIET_PAPER_ORIGINS`。无需经营公共云，但依赖用户选用的网络协调服务。此工程不自动安装、登录或管理用户 VPN。

普通同步载荷含明文笔记，互联网和需要浏览器端加密的客户端使用 HTTPS。HTTPS 在 Caddy/Tailscale 终止；生产情况下不要将本机 HTTP 端口直接映射公网。该要求是传输实现条件，普通同步不会被误称为端到端加密。

## 常驻运行

`server/com.quietpaper.sync.plist.example` 是用户 LaunchAgent 示例。先替换 Node 路径、工程路径、数据路径、来源与随机令牌，然后保存到 `~/Library/LaunchAgents/com.quietpaper.sync.plist`。该文件含访问令牌，权限应为 `600`。

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.quietpaper.sync.plist
launchctl kickstart -k gui/$(id -u)/com.quietpaper.sync
```

此配置在用户登录后运行；Mac 睡眠或关机时，各端继续使用本地操作日志。客户端每 8 秒重试，并在 `online` 事件后尝试同步。应用被操作系统挂起时不能保证后台计时器运行，恢复前台后继续。原生系统后台任务集成仍待实现。

## 协议与故障处理

`POST /api/sync` 使用 `Authorization: Bearer <token>` 与 JSON：

```json
{
  "projectId": "project-uuid",
  "mode": "plain",
  "keyId": null,
  "cursor": 0,
  "ops": [
    { "id": "op-uuid", "mode": "plain", "payload": { "id": "op-uuid", "kind": "object.create" } }
  ]
}
```

返回 `{protocol:1,generation,ops,cursor,hasMore,accepted}`。服务端每页至多 1000 条，客户端自动拉取后续页。游标是服务端已提交操作序号，客户端必须**先持久化远程操作，再保存游标**。断电发生在两步之间只会重新收到操作，可依身份去重。

服务每次启动生成新的 `generation`，刻意不从 SQLite 备份恢复该标识。自动同步先通过经过 URL/HTTPS/令牌校验的 `/api/status` 握手，把服务器启动世代加入持久上传确认的身份键。服务器重启（包括恢复更早备份）后，旧确认不会隐藏客户端仍有的笔迹或历史：客户端自动以游标 0 重新发送本地完整不可变日志，并完整拉取归档，随后恢复日常增量传输。同一工程身份导入、游标归零而旧确认记录仍存在，也使用新服务器世代的确认空间，无需寻找手动重置 UI。

启动世代握手和同步写入之间若发生重启，服务端在写入前返回 `SERVER_GENERATION_CHANGED`；同一世代内发现超前游标则返回 `CURSOR_AHEAD`。两者为可识别的协议错误，自动客户端最多重新握手并完整补齐三次，持续失败后保留队列并稍后重试。真正的同身份不同内容仍报碰撞，不按恢复模式强制覆盖。网络丢失已提交响应时，后续重发依身份去重，未收到确认前不推进本地确认或游标。

`startAutoSync` 在成功保存远程操作和游标之后记录上传确认身份，后续仅上传未确认操作；调用方可用 `getAcknowledgedIds` / `setAcknowledgedIds` 把确认集合持久化，必须使用回调收到的完整身份键（含服务器世代）。未提供持久化钩子时，重新打开客户端会安全重传完整日志一次，由服务端去重。**普通服务器重启也会完整重校验一次**，这是此基础版本为安全恢复选择的传输成本；后续可用对象清单或 Merkle 校验减少重启后的重传。`syncOperations` 是底层一次性传输函数，调用方应传入待传队列并保存返回的 `acknowledgedIds`；需要自动恢复的应用使用 `startAutoSync`，而非自行忽略有类型的恢复错误。

上传同时按**完整 JSON 请求的 UTF-8 字节数不超过 24 MiB**和**不超过 500 个操作**分包，计入加密包裹、分隔符及游标等字段，不能用图片数或 JavaScript 字符长度估算。按批编码，避免先将全部待传图片同时转成加密包裹。服务器默认拒绝超过 32 MiB 的请求。反向代理或自定义服务器限额更低而返回 HTTP 413 时，客户端只将该未接收批次二分后依次重试，不确认被拒绝的操作。单个操作不能继续拆分时明确报错，原始载荷及待同步队列保留，绝不截断或跳过。

服务端使用 SQLite 迭代器增量读取，每页最多 1000 个操作，并按默认 24 MiB 的完整响应字节预算分页，避免一次加载 1001 条大图。已归档的单个操作若大于配置的软拉取预算，会独占一页完整发送，以保持游标前进；不以空页或缺损内容伪装成功。`createSyncServer` 的 `maxBodyBytes` / `maxPullBytes` 可用于小容量测试或部署约束。

该版本尚未实现上传确认集合的压缩索引、单操作内二进制资源分块去重及超大附件流式传输。**包含多次源文件快照的原生历史仍是一个操作，若完整包裹超过客户端 24 MiB 或服务器/代理单请求上限，会明确停止并保留队列**；基础版本不能声称已覆盖任意大小录音、PDF、Office 资源或任意长度原生历史。完整工程导出仍可用于保全本地内容，分块协议是后续必须保留的目标。

容量证据：`tests/sync.test.ts` 在真实 HTTP 中覆盖普通/加密模式遇 413 二分重试、低字节预算拉取不漏项、超过 24 MiB 的 UTF-8 内容预先分批而无 413、单操作被拒绝后游标与上传确认不变、超软拉取预算单操作完整读取。混合大小写与 Unicode 键另验证与设备 locale 无关的 UTF-16 键排序，避免同一操作跨设备重编码后产生假身份冲突。

## 端到端加密

选择 `e2ee` 模式时，客户端从口令和工程身份通过 PBKDF2-SHA256（310000 轮）派生 AES-256-GCM 加密密钥及独立 HMAC 密钥；每条操作使用随机 96 位 nonce，工程及操作身份作为认证附加数据。服务端只保存认证密文；HMAC 内容指纹用于跨重试去重。口令不发送服务器。操作身份、工程身份、大小及到达时间仍可被服务器观察，不宣称隐藏全部元数据。

工程首次同步后锁定模式及密钥标识。错误口令、尝试将加密工程降级为普通模式均被拒绝。当前更换模式/口令需导出本地完整工程，再建立新的同步工程身份；原位密钥轮换尚未实现。口令丢失时服务端不能恢复内容，必须保留本地原生工程包及自己的口令恢复手段。

**Mac 临时解密代理外部 AI 尚未实现，也没有默认授权。** `/api/status` 明确返回 `aiProxyAvailable:false`、`serverCanDecryptE2EE:false`。未来必须增加明确授权与撤销、最小必要数据范围、过期清理，并清楚说明 Mac 在授权处理期间拥有相关明文访问权限。不要将当前未提供的代理称为“服务器始终无法解密且可代理明文 AI”。

## 备份与恢复

操作归档不删除旧对象或旧版本，因此平板 A、B 等随操作提交持续备份至 Mac。服务端归档不替代客户端持久化；尚未收到服务器确认的离线笔迹仍只存在对应设备。

```bash
node server/backup.mjs /path/to/backup-directory
```

使用 SQLite online backup API 生成一致性快照，允许服务仍在运行。可由用户的 Time Machine 或本机定时任务额外保护快照。恢复时先停服务、保留原数据目录副本，把选定快照复制到新目录并命名 `quiet-paper.sqlite`，以该目录设置 `QUIET_PAPER_DATA` 后启动；不要仅复制运行中数据库的主文件而漏掉 WAL，也不支持服务运行中替换数据库。客户端通过新启动世代自动补齐手上完整日志，不需要删除本地内容或手动修改同步游标。恢复测试在普通/加密两模式覆盖：旧快照仅有部分操作、后续操作已持久确认、同工程导入游标为零、丢已提交响应、身份碰撞保护，以及最终全部 A/B/历史载荷一致；不等同于真机磁盘损坏或断电测试。
