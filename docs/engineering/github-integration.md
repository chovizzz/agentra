# GitHub 集成：连接 Agentra 项目与 GitHub 仓库

目标：让 Agentra 里的项目（如 Plaud）与 GitHub 仓库（如 `Tinsley-Chen/shopify-plaud-yidian`）
双向同步 —— GitHub 的 issue 和 PR 在 Agentra 里就是 `Issue` 的子类
（`GithubIssue extends Issue`、`GithubPullRequest extends Issue`，见
`services/github/github/src/index.ts`），和你项目里已有的任务/缺陷是**同一个体系**，
可以互相关联、出现在同一个看板和追溯链里。

同步覆盖：issue、PR、PR commit、review、review comment、仓库元数据。
PR review 还会变成 Agentra 里的待办（`GithubTodo extends ToDo`）。

---

## 🔴 必须是 GitHub App，不能用 Personal Access Token

`pod-github` 的必填配置是 `APP_ID` / `CLIENT_ID` / `CLIENT_SECRET` / `PRIVATE_KEY`
（`services/github/pod-github/src/config.ts` 的 `required` 数组），**这四项只有 App 才有**。

原因不是实现偷懒：
- **Webhook**：PR、commit、review 事件要推回 Agentra，webhook 属于 App，PAT 没有。
- **Installation token**：App 用私钥签出按仓库授权的短期 token，权限边界比 PAT 清晰得多，
  且不绑定某个人的账号 —— 那个人离职、改密码、轮换 PAT 都不会让集成挂掉。

---

## 一、创建 GitHub App

<https://github.com/settings/apps> → **New GitHub App**（组织的 App 走
`https://github.com/organizations/<org>/settings/apps`）。

| 字段 | 填什么 |
|---|---|
| GitHub App name | 任意，例如 `agentra-sync`。**这个名字的 slug 就是 `BOT_NAME`** |
| Homepage URL | `http://agentra.local:8087`（本地阶段随便填，不校验） |
| Callback URL | **前端**的 `/github` 路由，如 `https://agentra.49.51.37.69.sslip.io/github` |
| Webhook | **本地阶段先取消勾选 Active**，见下方「关于 webhook」 |
| Webhook secret | 若启用，自填一个随机串，与 `WEBHOOK_SECRET` 一致 |

> 🔴 **回调要指向前端，不是 pod-github。** 处理回调的是
> `github-resources/src/components/ConnectApp.svelte`：它从 URL 里读
> `code` / `state` / `installation_id` / `setup_action`，再 POST 给
> pod-github 的 `/api/v1/auth` 或 `/api/v1/installation`。
> 该组件注册在 `dev/prod/src/platform.ts` 的路由表里（`githubId` → `ConnectApp`），
> 所以 URL 就是前端域名加 `/github`。
>
> ⚠️ 曾经把回调填成 `<host>:3500/auth` 并据此断言"开源仓库缺 GET /auth 桥接"，
> 那是误诊 —— pod-github 只有 `POST /api/v1/*` 是**设计如此**，
> 它本来就不该直接接收浏览器回调。

**Repository permissions**（至少）：

| 权限 | 级别 |
|---|---|
| Contents | Read-only（要读分支/commit） |
| Issues | **Read and write** |
| Pull requests | **Read and write** |
| Metadata | Read-only（强制项） |

**Subscribe to events**（启用 webhook 时才需要）：
Issues、Issue comment、Pull request、Pull request review、Pull request review comment、Push。

创建后在 App 设置页：

1. 记下 **App ID**（纯数字）→ `APP_ID`
2. 记下 **Client ID**（`Iv1.` 或 `Iv23` 开头）→ `CLIENT_ID` 和 `GITHUB_CLIENTID`
3. **Generate a new client secret** → `CLIENT_SECRET`
4. **Generate a private key** → 下载 `.pem` 文件 → `PRIVATE_KEY`（见下方转换）
5. 左侧 **Install App** → 装到 `Tinsley-Chen/shopify-plaud-yidian`（可选 Only select repositories）

---

## 二、填配置

凭据写进 `dev/.env.local`（**不要写 `dev/.env`，那个文件被 git 跟踪**），
键名见 `dev/.env.local.example`。

### 私钥要转成单行

`config.ts` 会做 `.replace(/\\n/g, '\n')` 还原换行，所以 `PRIVATE_KEY` 必须是**单行、
换行写成字面量 `\n`**。直接贴多行 PEM 会让 YAML 和 dotenv 双双解析失败。

```sh
awk 'BEGIN{ORS="\\n"}1' ~/Downloads/agentra-sync.2026-08-31.private-key.pem
```

把输出整行贴到 `PRIVATE_KEY=` 后面（建议用引号包起来）。

---

## 三、启动

```sh
cd dev
docker compose --env-file .env --env-file .env.local \
  -f docker-compose.yaml -f docker-compose.min.yaml up -d github front
```

⚠️ `front` 要一起重起 —— `GITHUB_APP` / `GITHUB_CLIENTID` 是它生成 `config.json` 时读的
（`pods/front/src/__start.ts:30-31`）。不重起的话界面上的「连接 GitHub」会指向上游示例
App（`uberflow-dev`），授权会跳到别人的 App 上。

**验证**：

```sh
docker logs dev-github-1 --tail 20
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://localhost:3500/
```

缺配置时容器会直接退出，日志第一行就是 `Missing env variables: APP_ID, ...` —— 它不降级运行。

然后在 Agentra 界面里：设置 → 集成 → GitHub → 授权并选择仓库，绑定到 Plaud 项目。

---

## 四、关于 webhook：本地跑不通的那一半

**能在本地跑通的**：Agentra → GitHub 的**主动调用**（读 issue/PR、创建、评论、改状态）。
这条路只需要出网。

**本地跑不通的**：GitHub → Agentra 的**事件回流**。GitHub 的服务器打不到你本机的
`agentra.local` / `127.0.0.1`，所以 PR 合并、新 commit、review 这些事件不会自动同步进来。

部署到公网后这条限制就没有了。Webhook URL 填：

    https://github.<SERVER_HOST>/api/webhook

⚠️ **是 `/api/webhook`，不是根路径** —— `server.ts:51` 把
`createNodeMiddleware` 挂在这个固定路径上，根路径会 404。
判据：无签名地 POST 到正确路径应返回 **400**
（`Required headers missing: x-hub-signature-256, x-github-delivery`），
返回 404 说明路径写错了。

webhook 与上面的浏览器回调是两条不同的路径：前者是 GitHub 服务器发来的 POST
（pod-github 自己处理并校验 `WEBHOOK_SECRET` 签名），后者是用户浏览器的跳转
（由前端的 `ConnectApp` 处理）。

## 五、一处已知的欠账

`services/github/pod-github/src/loaders.ts` 是模块注册 checklist 的 **8.4 镜像点**
（见 `agentra-module-checklist.md`）。当初**有意没给 Agentra 的新模块加** —— 理由是那份清单
装的是 pod-github 自己会渲染的 `IntlString`，Agentra 模块与 GitHub 同步路径无交集。

**如果 GitHub 集成上线后需要渲染我们新模块的文案**（例如把 crm-lite / requirements 的字符串
带进 GitHub 侧的通知或 issue 正文），那处必须补，否则会出现 `agentra-core:string:Xxx`
这样的裸 id。目前不需要。
