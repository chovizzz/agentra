# Agentra 生产部署（Dokploy / 单机 49.51.37.69）

## 现状

11 个核心服务跑在 Dokploy 的 compose 服务 `agentra-stack` 上，镜像来自
GHCR（`ghcr.io/chovizzz/agentra-*`），tag 是 git commit `6e3227395`。

访问地址（全部经 Traefik 走 80 端口）：

| 服务 | 地址 |
|---|---|
| 前端 | <http://agentra.49.51.37.69.sslip.io> |
| account | <http://account.49.51.37.69.sslip.io> |
| transactor (ws) | <ws://transactor.49.51.37.69.sslip.io> |
| collaborator (ws) | <ws://collab.49.51.37.69.sslip.io> |
| datalake | <http://datalake.49.51.37.69.sslip.io> |
| github | <http://github.49.51.37.69.sslip.io>（未配置，见下） |

Dokploy 面板本身在 <http://49.51.37.69:3000>。

## 为什么是这套形状 —— 四个约束

### 1. 服务器是 amd64，构建机是 Apple Silicon

镜像必须显式 `--platform linux/amd64` 构建，否则部署会以
`no matching manifest for linux/amd64` 整体失败，且后续所有服务都报
`No such image`（连带，不是独立故障）。

代价很低：9 个 Dockerfile 全是纯 `COPY`（0 条 `RUN`），只把 `rush bundle`
的产物拷进上游基础镜像，跨架构构建不触发任何 QEMU 仿真。

```sh
docker buildx build --platform linux/amd64 --push \
  -t ghcr.io/chovizzz/agentra-<name>:<commit> <context>
```

⚠️ **判据是 `docker manifest inspect` 里的 architecture，不是构建脚本的退出码。**

### 2. 内存只有 7.45 GB

上游 dev 栈 30 个服务装不下，砍到 11 个。砍掉的服务在环境变量里必须留
**空字符串**而不是指向不存在的地址 —— `transactor` 的 `FULLTEXT_URL` 指向
死地址会反复重试刷日志，`front` 则依赖空值来隐藏对应入口。

代价：全文搜索、附件预览不可用。

### 3. Dokploy 面板占着 3000 端口

account 容器内仍是 3000，但宿主映射必须避开。这个冲突会让整个 compose 在
最后一步失败（前面 8 个容器都已 Started），错误是
`Bind for 0.0.0.0:3000 failed: port is already allocated`。

### 4. 云安全组只放行 22 / 80 / 443 / 3000

这是最容易误判为"部署成功"的一条：容器全部 running、Dokploy 显示 done，
但页面一个字都打不开。Huly 前端要**从浏览器直连** account、transactor(ws)、
collaborator(ws)、datalake 四个服务，端口全被挡。

解法是不开新端口，全部收到 Traefik 的 80 上按主机名分流，
主机名用 **sslip.io 通配 DNS**（`<任意>.49.51.37.69.sslip.io` 都解析到本机），
所以不需要真买域名。买了域名后只改 `SERVER_HOST` 一个变量。

⚠️ 两个坑：
- Traefik 只能路由到 `dokploy-network` 上的容器，对外服务必须显式声明；
  而一旦写了 `networks:` 就**不再隐式加入 `default`**，两个都要列，
  否则容器间调用（`http://account:3000` 那些）会断。
- `SERVER_HOST` 不能填裸 IP，否则拼出 `agentra.49.51.37.69` 这种解析不了的名字。

## 环境变量的一个陷阱

**Compose 只对 compose 文件插值，不对 env 文件的值做二次插值。**

所以 `STORAGE_BUCKETS=minio|...accessKey=${MINIO_USER}` 这种"值里套 `${}`"
的写法，变量名会**原样**进容器。datalake 的 `BUCKETS` 因此改为直接写在
compose 里。

顺带记一下 `BUCKETS` 的格式，容易和另一个搞混：

- `BUCKETS`（datalake）= `<bucket>,<location>|<url>?accessKey=&secretKey=`
  ——见 `services/datalake/pod-datalake/src/config.ts` 的 `parseBucketConfig`
- `BACKUP_STORAGE_CONFIG` = `minio|minio?accessKey=&secretKey=`

两者长得像但解析器不同，用错会以 `Invalid bucket config` 崩溃重启。

还有一个变量名陷阱：**workspace 读的是 `ACCOUNTS_DB_URL`，不是 `DB_URL`**
（同一个库，两个名字）。缺了会打印 `Please provide account db url` 后
`exit(1)`。

## 验收判据

Dokploy 报 `done` 只代表 `docker compose up -d` 返回 0，**不是**服务可用。
真正要看的：

```sh
# 1. 11 个容器都 running，且 Up 时长在增长（崩溃重启表现为反复 Up 几十秒）
# 2. 外部可达
for h in agentra account transactor collab datalake; do
  curl -so /dev/null -w "$h %{http_code}\n" http://$h.49.51.37.69.sslip.io/
done
```

预期：`agentra 200`、`datalake 200`、`account 405`（POST-only 的 RPC 端点，
GET 返回 405 是正常应答）、`transactor 404`、`collab 404`。

⚠️ **404 要分辨来源**：Traefik 无路由时返回 19 字节 `text/plain`；
应用自己返回的是带 CORS 头的 `text/html`。用 `curl -I` 看 Content-Type。

最终判据是浏览器里 `account.<host>/providers` 返回 200 —— 说明跨域直连通了。

## 待办

凭据已于 2026-09-01 填入 Dokploy（25 个环境变量，无重复、无空值）。
`github` 已从 502 变为正常应答，飞书 provider 已注册、登录页显示"Continue with 飞书"。

⚠️ **粘贴时踩到的两个点，记下来免得下次重犯**：
- 直接粘 `dev/.env.local` 会带进**本地的** `FEISHU_REDIRECT_URL`
  （`http://127.0.0.1:3000/...`），飞书回调会打到本机，登录必失败。
- 也会带进重复的 `ALLOWED_WORKSPACES`。

## 数据迁移（已完成 2026-09-01）

本地工作区 `agentra-main` 整体迁到生产，走 `dev/tool` 的 backup / backup-restore。
生产的 CockroachDB 不对公网暴露，工具必须在内网跑，而我们没有该机器的 SSH 凭据 ——
**用 GHCR 当传输通道**：把 tool 的 bundle 和备份目录打进一个镜像，在 compose 里
加一个跑完即退的一次性服务执行恢复，跑完删掉。

⚠️ 那个一次性服务**不能套用 `x-common` 锚点** —— 里面的 `restart: unless-stopped`
会让它反复重启，等于反复恢复。删除也必须赶在下次 `docker compose up -d` 之前，
否则已退出的容器会被重新拉起。

核对结果（生产 = 本地，逐项一致）：445 Issue、2958 TestCase、2958 TestStep、
336 TestSuite、12 个 tracker 项目、2 个测试專案、3957 个附件 / 11 MB。

### 两个踩过的坑

**一、`.local` 主机名让备份慢 1000 倍。** macOS 对 `.local` 后缀先走 mDNS，
即使 `/etc/hosts` 里有记录也要等约 5 秒才回落。备份每个附件都要解析一次
`agentra.local`，3957 个附件 ≈ 5.5 小时；又因为 tar 包要攒够体积才落盘，
表现为"目录 0 字节、进程 0% CPU"，**极像挂死**。
判据是 `sample <pid>`：线程停在 `getaddrinfo` / `si_addrinfo` 上。把
`STORAGE_CONFIG` / `DB_URL` / `ACCOUNTS_URL` 的主机名换成 `127.0.0.1` 后，
同一份备份 20.6 秒跑完。

**二、增量备份会跳过上次 `--skip` 掉的域。** 用 `--skip blob` 跑过一次后，
再对同一个目录跑全量，它判定无变化、什么都不做（0 条 chunk 行、快照数不变）。
要补 blob 必须**换一个全新的备份目录**。

### 恢复后必须手动补的一步

`Navigator.svelte` 的空间查询是 `members: getCurrentAccount().uuid` ——
**严格按成员过滤**，非平台管理员看不到自己不在 members 里的空间，UI 里也没有
加入入口。tracker 项目带 `autoJoin: true`（`contact-resources` 的触发器在人员
创建时把账号 push 进去）所以自动可见；测试專案没有这个标记，恢复后不可见，
需要手动把新账号加进 `members`（本次是直接 UPDATE `public.space` 后重启
transactor 清缓存）。

⚠️ 平台管理员那条绕过路对飞书登录**不成立**：`isAdminEmail` 按 email 匹配，而
`pods/authProviders/src/feishu.ts` 故意传空 email（防止上游按 email 静默合并
账号导致接管），飞书账号根本没有 email social id。

## 待办

1. **两处回调地址要在外部平台上改**（不是环境变量）：
   - GitHub App 设置页 Callback URL → `http://github.49.51.37.69.sslip.io/auth`
   - 飞书应用重定向 URI → `http://account.49.51.37.69.sslip.io/auth/feishu/callback`
     （必须与 `FEISHU_REDIRECT_URL` **逐字符**一致）
2. **GitHub App 的回调与 webhook 地址**（见 `github-integration.md`）：
   - Callback URL → **前端**的 `https://agentra.<SERVER_HOST>/github`
   - Webhook URL → `https://github.<SERVER_HOST>/api/webhook`（⚠️ 不是根路径）

   ⚠️ 早先这里写着"pod-github 缺 GET /auth 桥接"，那是误诊：处理浏览器回调的是
   前端的 `ConnectApp`，pod-github 只收 POST 是设计如此。
3. **没有 HTTPS**。sslip.io 可以配 Let's Encrypt，但更合适的是等真域名。
