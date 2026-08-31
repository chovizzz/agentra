# Agentra V1 已接受的风险与已知缺口

用户 2026-08-28 逐条拍板接受的项。**这些不是待办，不要在下一轮当成新发现重新提出来。**
每条都记了「为什么现在不做」和「什么条件下要重新打开」。

与之配套的两份文档：`agentra-module-checklist.md`（新模块必须走完的 11 处注册）。

---

## 1. 发布记录不再出现在活动面板

**现状**：`releaseProductVersion` 写的审计记录是一条普通 `ActivityInfoMessage`，之前在产品版本的
活动流里正常渲染。会话侧读取被关掉之后（见下），这一行对所有人消失。

**为什么接受**：这是「账本禁止非服务端读取」这个决定的直接代价，降级是优雅的 —— 少一行，不报错。
补一条专供展示的非账本消息要重新论证它自己不泄漏（它会落在完全相同的空间里），不值。

**重新打开的条件**：如果产品上需要「谁在什么时候发布了什么」对普通成员可见。届时正确做法是
**新增一条不含门禁明细的展示消息**，而不是放松账本闸口。

⚠️ **一条已更正的事实**：审计记录**不在** `core.space.Workspace`。`ensureAuditRecord` 把它写进
`version.space`，而 `ProductVersion.space` 是所属的 `Product`（那是个 Space）。所以修复前的暴露面是
「能读该产品空间的人」，不是整个工作区。（`core.space.Workspace` 那套分析对 `TraceLink` 成立，
对账本不成立 —— 两个对象的分析一度被混成了一条。）

---

## 2. 账本剩余的两条平台级通道

**现状**：账本记录的 `TxCreateDoc` 在创建时会广播给空间成员（开着实时查询的客户端能收到），
且那条事务永久留在 `DOMAIN_TX` 里可按 `objectId` 查 —— `SpaceSecurityMiddleware` 对 `DOMAIN_TX`
只按 `objectSpace` 判。

**泄漏的是什么**：记录的**存在性**、`approval`、`waiverReason`。**不含**阻塞项明细 —— 那些早已
被缩减成一个 `ReleaseGateVerdict`。

**为什么接受**：关掉要么动 `foundations/server/packages/middleware/src/spaceSecurity.ts`（影响全平台
每一个模块），要么改广播定向（同样在包外）。包内只能挡住查询那半，广播那半挡不住 —— 做一半的
价值不足以抵掉一块新活。

**对照**：追溯边的**同一个问题已经修了**（见下第 6 节），因为那一处完全落在
`server-plugins/traceability-resources` 包内。账本的没有这个便利。

**重新打开的条件**：产品要对外宣称发布记录的机密性时。

---

## 3. 追溯边分页会出现「短页」

**现状**：`limit` 在适配器层、端点可见性过滤**之前**生效。所以过滤掉若干条之后，一页可能不足
`limit` 条，却仍有更多可见数据在后面。

**为什么接受**：方向是安全的 —— 永远只会返回得更少，不会更多。这是可用性问题，不是安全问题。
修法要在过滤后循环补取，涉及补取游标、终止条件、最坏情况下的重复读，是另一个量级的改动。

**已经处理的相关部分**：`total` 必须改，且已改。适配器数的是**过滤前**的行数，原样回传等于把
「有多少条边的端点你看不见」这个数字直接发出去 —— 正是要挡的东西。现在 `adjustTotal()`：
适配器只回显页长时给过滤后长度，真服务端计数时给 `-1`（仓库已有把 `-1` 当「未知」处理的先例：
`Table.svelte:214`、`RelationshipTable.svelte:203`、`OptimizeSkills.svelte:553`）。
代价是丢过行时泄露 1 bit「有东西被挡了」，远小于泄露具体条数。

---

## 4. 关联遍历（association traversal）绕过空间安全

**现状**：Postgres 适配器的 `fetchAssociations` 返回的是**端点文档本身**，且完全绕过空间安全。

**为什么对 Agentra 不可达**：查询 SQL 带 `AND r.association = $x`，而 `buildTraceLink` 从不写
`association` 字段 —— 追溯边永远匹配不上。

**为什么接受**：修它要改 `foundations/server/packages/postgres`，影响全平台每一个用关联的模块，
而我们没有上游的回归测试。

**重新打开的条件**：🔴 **任何人给追溯边写了 `association` 字段的那一刻。** 这是本节唯一的触发器，
写进 code review 自查项。

---

## 5. 全文检索目前不构成旁路，但没有防护

`DOMAIN_RELATION` 目前不进全文索引（`models/traceability/src/types.ts:54` 明确说明），所以
`searchFulltext` 拿不到追溯边。中间件**没有**对这条路加防护。

**重新打开的条件**：索引策略变更、把 `DOMAIN_RELATION` 纳入全文索引时。

---

## 6. 已修的部分（记在这里以便对照，不要重复做）

- **追溯边的 `DOMAIN_TX` 旁路已挡**。`TxCreateDoc<TraceLink>` 的 `attributes` 里原样带着
  `docA` / `docB`，只挡 `findAll(TraceLink)` 而放着 tx 日志等于没修。`TxCreateDoc` 按 attributes
  里的端点判定；update/remove/mixin 一律丢弃 —— 理由是边的
  `_id = sha256(kind‖source‖target)[0:24]`，留着等于给出「这个三元组存不存在边」的 oracle，
  而那正是行过滤刚关掉的门。
- **追溯边 `metadata` 的三处端点状态泄漏已清除**，并加了编译期分类表（`traceLinkMetadata.ts`）
  防再犯：新增一个 key 必须在 `TRACE_LINK_METADATA_PROVENANCE` 里写明它的来源，
  分类成 `endpoint-derived` 会让每个调用点停止编译。
- **「收件箱里会出现指向已隐藏消息的空白行」经查证不成立** —— 通知生成路径
  （`server-plugins/notification-resources/src/index.ts:1052`）在拿不到 `ClassCollaborators`
  mixin 时直接返回空数组，而 `ProductVersion` 根本没注册这个 mixin。

---

## 7. 工作项模板只交付了一半

**已落地**：Issue 现在会记录它来自哪个模板（`TIssue.template` 的 `@Prop` + 创建路径写入），
`issues/edit/ControlPanel.svelte` 里那个一直是死的模板展示因此活了。

**砍掉的**：模板携带 Cycle 与 `implements` 两个维度。

**为什么砍**（三条独立的断点，任一条都足以否掉）：
1. 模板子项不是文档（`IssueTemplateChild` 无 `_id` / `_class`，`children` 是 `ArrOf` 不是
   `Collection`），维度只能挂在 `IssueTemplate` 的 mixin 上；
2. **没有任何 UI 能写那个 mixin** —— `TemplateControlPanel.svelte` 只渲染 `issue._class` 的属性、
   不渲染 mixin，`EditIssueTemplate.svelte` 的 `custom-attributes` 是它自己填的 Svelte slot、
   不是插件扩展点。做完就是一段读空数据的死代码；
3. 模板子项生成的 Issue 由 `SubIssues.svelte` 的 `save()` 直接 `client.addCollection` 创建，
   **从不调用 `docCreateManager`** —— 唯一的扩展点对子 issue 永远不触发，功能只会作用在父 issue 上。

**重新打开的条件**：先解决第 3 条那个结构性阻塞（改 `SubIssues.save()` 的调用链），否则做出来的
是个只对父 issue 生效的半截功能。

---

## 8. 上游既有 bug：模板选择有竞态

`CreateIssue.svelte` 的 `updateTemplate()` 没有取消机制，一个被取代的模板选择的迟到回调仍能覆盖
已经切换或取消过的表单。**这是上游 Huly 的既有问题，不是 Agentra 引入的。**

**为什么不修**：改上游 Issue 创建路径，验证成本远高于 bug 本身（触发条件是快速连点模板选择器）。

⚠️ **一个相关的、有诱惑力但错误的「修法」，已在代码里留了注释禁止**：把守卫收紧成
`object.template.template === templateId`。这是错的 —— `updateTemplate` 在同一次对象重建里
**同时**写字段和来源，所以来源与内容按构造一致；而 `templateId` 只是选择器最后点了什么、可以
跑在前面。用户选了 B、B 还在加载时保存，草稿里装的仍是 A 的字段，**A 才是真来源**。那个守卫会
为了避免一个不可能发生的假来源而丢掉真来源。

---

## 9. 一条未定性的 e2e 失败：chat backlinks

`tests/sanity/tests/chat/chat.spec.ts:383` 「Checking backlinks in the Chat」**稳定失败**。
干净环境（`prepare.sh` 之后第一遍）全量结果：**208 passed / 1 failed / 4 flaky / 23 skipped**，
这条是唯一的硬失败。

**症状**：输入 `@<新邀请用户>` 时 mention 弹窗显示 **"No results to show"**（有失败截图）。

**已排除的**（逐条查过，都不是原因）：
- **不是时序**：把超时从 60s 提到 **240s，仍在同一处失败**；单独跑 3/3 稳定失败。
- **不是我们的 contact 改动**：`models/contact` / `plugins/contact` 只增加了一个 Feishu 的
  `SocialIdentityProvider` 文档和对应的字符串/ref 声明。
- **不是 account 迁移**：只往 `social_id_type` 枚举加了 `feishu` 值。
- **不是 `loginSocialTypes`**：它只被设置页 UI 与「不许删最后一个登录社交 id」用到。
- **不是名字顺序**：`LAST_NAME_FIRST=true` 在 sanity 与 dev 两个栈里一致，与测试期望相符。
- **不是 mention 功能整体坏了**：`tracker/mentions.spec.ts` 的 **4 条 mention/backlink 测试全部通过**，
  含「不同空间的 backlink」。
- **不是邀请流程没通**：失败截图显示被邀请用户**确实进了工作区**（能看到 Chat 与频道列表）。
- **不是全文索引**：fulltext 服务健康、无报错，且能看到它正常索引我们的新类。
- **`Cannot find social id`（transactor 日志里大量出现）出自
  `server-plugins/contact/src/utils.ts`，该文件我们没有修改**，且是优雅降级（返回 undefined）。

**唯一的独特之处**：这是**全套里唯一一条用「新建账号 + 邀请链接加入」的用户去 @ 的**测试
（`createAccount` + `getInviteLink` + `getSecondPageByInvite`）。而 `chat.spec.ts` 最近一次
上游改动正是 `ac1553bd3 feat: Guest auto-join (#10751)`。同一批里
`teamspace.spec.ts`「Auto-join teamspace」也进了 flaky 列表 —— 两者都依赖自动加入路径。

🔴 **尚未定性：不能断言是上游既有问题，也不能断言是我们引入的。**
唯一决定性的实验是**用一棵干净的上游树重建镜像跑这条测试**（约 30–40 分钟的
`rush docker:build` + 跑测试）。未执行 —— 需要先拍板值不值。

**重新打开的条件**：做上述对照实验；或者上游报告同一条测试不稳。
