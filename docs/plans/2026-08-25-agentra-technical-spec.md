# Agentra Technical Spec

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 产品品牌 | Agentra |
| 目标仓库 | Huly Platform fork |
| 基线 | `upstream/develop`；生产版本固定到经过验证的 commit/tag |

## 1. 工程原则

1. 优先通过新 plugin、mixin、association、viewlet 和 server trigger 扩展，不直接改写上游核心类。
2. 上游 `lead` 模块不作为依赖，也不迁移新数据到旧模型。事实描述：该模块在 `models/all/src/index.ts` 中**仍正常注册**，只是配置为 `enabled: false, beta: true`（默认关闭的 beta 能力），并非上游已弃用或已删除。不采用它的理由是**默认禁用 + 能力差异**：它缺少本项目所需的 Card 版本化正文、结构化转换、Trace Link 与配置化 Pipeline/Source，把它改造到位的代价高于新建 `crm-lite` 且会加大上游合并冲突面。
3. 跨模块关系以 `traceability` 为唯一事实来源，避免 CRM、测试和 Tracker 各存一套不可对账的引用。
4. 所有外部回调、转换和自动化动作都必须幂等。
5. Migration 前向兼容、可重复执行、可审计；不可逆变更需要单独备份门禁。
6. 代码、资源、模型和服务包遵循 Huly 现有包拆分及 Rush 构建约定。

> ✅ **D2 已拍板（2026-08-26）：自建 `TraceLink` 类，只承载跨模块关系。** 第 3 条的准确表述是：**TraceLink 是「跨模块」关系的唯一事实来源**，不是全部关系的唯一事实来源。边界如下：
>
> - **归 TraceLink**：`converted-to`、`implements`、`verifies`、`defect-of`、`fixed-by`、`delivered-in` 六种跨模块关系；
> - **不归 TraceLink**：Issue ↔ Issue 的依赖/阻塞关系归 Tracker 原生（`Issue.blockedBy` / `Issue.relations`），**`blocks` 已从 kind 列表中删除**；`test-management` 的 Suite/Case/Plan/Run/Result 内部父子关系、GitHub 同步的 Issue/PR 映射同样保持上游原样，不搬进 TraceLink。
> - **存储落在 `DOMAIN_RELATION`**，字段沿用该域既有的 `docA`（= source）/ `docB`（= target），白拿该域已有的两个 btree 索引，**零上游 schema 补丁**。

## 2. 仓库与分支

```text
origin    -> 用户/组织 fork
upstream  -> https://github.com/hcengineering/platform.git
```

建议长期分支：

- `develop`：跟随上游并集成已完成功能；
- `release/*`：自托管发布候选；
- `feat/*`：单一垂直切片；
- `docs/*`：PRD、Spec 和计划。

部署仓库单独维护 `platform` 镜像引用和环境配置，不将生产 Secret 写入此仓库。用户界面使用 Agentra 品牌；包名、功能开关和测试目录继续使用稳定的领域命名，不与品牌名耦合。

## 3. 模块规划

### 3.0 新领域模块的固定落地清单

每个新增领域模块（`crm-lite`、`requirements`、`traceability`、`cycle`）都必须走完下面这张清单。**任何一项漏掉，症状都是「编译通过、测试全绿，但功能在运行时加载不出来」**——这类故障包级 `rushx test` 一律测不到，只能靠人工核对这几个文件的 diff。模式取自上游 `lead` 包族（`plugins/lead`、`plugins/lead-assets`、`plugins/lead-resources`、`models/lead`、`server-plugins/lead`、`server-plugins/lead-resources`、`models/server-lead`）。

| # | 落地点 | 具体动作 | 漏掉的后果 |
| --- | --- | --- | --- |
| 1 | `rush.json` | 为**每一个**包（含 `-assets`、`-resources`、`server-*`、`model-*`）各加一条 `packageName` + `projectFolder` 条目 | 包不参与安装/构建 |
| 2 | `models/all/package.json` | 加 `@hcengineering/model-<name>` 依赖 | 模型包解析不到 |
| 3 | `models/all/src/index.ts` | 在 builder 数组里加 `[<name>Model, <name>Id, { label, description, enabled, beta, icon, classFilter }]` | 模型不入库，导航不出现 |
| 4 | `models/all/src/migration.ts` | 加 `import { <name>Operation } from '@hcengineering/model-<name>'` 并在 `migrateOperations` 数组里追加 `['<name>', <name>Operation]` | 默认数据/索引不创建，升级不执行 |
| 5 | `dev/prod/package.json` | 加 `@hcengineering/<name>`、`@hcengineering/<name>-assets`、`@hcengineering/<name>-resources` 依赖 | 前端 bundle 里根本没有这些包 |
| 6a | `dev/prod/src/platform.ts`（图标） | 顶部加一行副作用 import：`import '@hcengineering/<name>-assets'` | 图标全部缺失 |
| 6b | `dev/prod/src/platform.ts`（i18n） | `addStringsLoader(<name>Id, async (lang: string) => await import(\`@hcengineering/<name>-assets/lang/${lang}.json\`))` | 界面全是 raw i18n key |
| 7 | `dev/prod/src/platform.ts`（UI） | `addLocation(<name>Id, async () => await import(/* webpackChunkName: "<name>" */ '@hcengineering/<name>-resources'))` | 导航项能点开，但内容空白 |
| 8 | `desktop/src/ui/platform.ts` | **与第 5–7 项完全相同的三处注册要在这里再做一遍**（裸 assets import + `addStringsLoader` + `addLocation`），并在 `desktop/package.json` 加依赖 | 桌面端功能缺失（Web 端正常，容易漏检） |
| 9 | `server-plugins/<name>` + `server-plugins/<name>-resources` | server plugin 拆成**契约包**（导出 `serverXxxId`、trigger/function 的资源 id）与**实现包**（真实实现） | 没有 `-resources` 就没有地方放服务端实现 |
| 10 | `server/server-pipeline/src/serverPlugins.ts` | 在 `registerServerPlugins()` 里加 `addLocation(server<Name>Id, () => import('@hcengineering/server-<name>-resources'))` | **trigger / server function 永不执行**；模型里指向它们的 mixin 变成悬空引用 |
| 11 | `models/server-<name>` | 用 `builder.mixin(...)` 把 `server<Name>.function.*` / `server<Name>.trigger.*` 挂到具体类上（HTMLPresenter、TextPresenter、Trigger、TypeMatch 等），并加进 `models/all` | 服务端实现存在但没有任何东西调用它 |

🔴 **第 10 项与第 11 项是两回事，最容易漏的是第 10 项。** `models/server-<name>` 只是把资源 **id** 挂到类上（对照 `models/server-lead/src/index.ts`：它 `builder.mixin(lead.class.Lead, …, { presenter: serverLead.function.LeadHTMLPresenter })`，引用的是 id，不是实现）；真正把 id 解析到实现代码的是 `server/server-pipeline/src/serverPlugins.ts` 里 `registerServerPlugins()` 的那一行 `addLocation`（对照该文件里 `addLocation(serverLeadId, () => import('@hcengineering/server-lead-resources'))`）。**只做第 11 项不做第 10 项，模型能构建、类型能过，但运行时 trigger 一次都不会触发**——这正是最难排查的一类故障。

ℹ️ **另有一处按需落地点**：`dev/tool/src/__start.ts` 也有一份 `addLocation` 清单，供 CLI 工具（migration、批处理、workspace 运维）加载 server 资源。**仅当新模块的 migration 或运维命令需要经由 dev/tool 执行时**才需要同步补；不需要就不用改。

🔴 **第 8 项：客户端注册有两个站点，不是一个。** `dev/prod/src/platform.ts`（Web）与 `desktop/src/ui/platform.ts`（桌面端）各自维护一份完整的 import / `addStringsLoader` / `addLocation` 清单（对照两个文件里的 `leadId` 三处注册）。**只改 Web 那份，桌面端就少功能**，且 Web 端自测完全发现不了。此外 `services/*/pod-*/src/loaders.ts`（如 `pod-github`、`pod-ai-bot`、`pod-telegram-bot`）也各有一份 `addStringsLoader` 清单，**仅当该 pod 需要渲染本模块的通知/文案时**才需要同步补。

⚠️ **6a 与 6b 是两件不同的事，别当成一件。** `<name>-assets` 这一个包同时承载两类资源，但走**两条不同的加载路径**：

- **图标**由包的入口 `src/index.ts` 在被 import 时**以副作用方式**注册——它内部是 `loadMetadata(<name>.icon, { ... })` 把 SVG sprite 里的 symbol 挂到 plugin 的 icon id 上（对照 `plugins/lead-assets/src/index.ts`、`plugins/products-assets/src/index.ts`）。所以必须有那行看起来"没用到"的裸 import，**不能因为 lint 提示未使用就删掉**。
- **文案**走 `addStringsLoader`，它按语言**动态 import** `<name>-assets/lang/${lang}.json`，与上面的裸 import 无关。

因此 6a、6b、7 是**三个独立注册**，缺任意一个都只坏一部分（分别是：图标没了 / 文案变 raw key / 内容空白），排查时容易只修一处就以为好了。

⚠️ 第 4 项的 `migrateOperations` 是**有序数组，顺序即执行顺序**（上游已有 `// We should call notification migration after activityServer and chunter` 这类顺序约束注释）。新模块的 migration 必须排在它所依赖的模块之后（例如依赖 `card`/`contact`/`tracker` 默认数据的，必须排在这些之后）。⚠️ 该数组也是**并行开发的冲突热点**：两个 worktree 各自在末尾追加会在合并时冲突，**带 migration 的任务照旧串行**。

对应地，`plugins/<name>-assets` 是一个**独立的包**（不是 `plugins/<name>` 的子目录），必须自带 `package.json`、`src/index.ts`（`loadMetadata` 注册图标）、`assets/icons.svg`、`lang/en.json`、`lang/zh.json` 和语言 key 测试。

### 3.1 CRM Lite

新增以下包，最终名称按 `rush.json` 现有约定校验：

```text
plugins/crm-lite
plugins/crm-lite-resources
plugins/crm-lite-assets
models/crm-lite
models/server-crm-lite
server-plugins/crm-lite
server-plugins/crm-lite-resources
```

职责：Lead 类型、Pipeline/Source 配置、CRM 导航与视图、转换动作、重复提示、审计事件。

Account 和 Contact 不重复建表：分别复用 `contact.Organization` 与 `contact.Person`。

Lead 采用 Card 扩展类型，继承 Card 的版本、内容、附件、评论、关系、权限和全文索引。CRM 业务字段通过模型属性/mixin 声明，不使用无类型 JSON blob 保存核心状态。

> ✅ **D1 已关闭（2026-08-26）：Lead 与 Requirement 均定为 `card.Card` 扩展类型（MasterTag）。** 原型裁决：**Card 能挂看板，且不需要改上游 `card` 包一行代码。**
>
> **裁决依据（已逐条核实）：**
>
> 1. 看板的硬前提只有三条 —— ① 宿主类有 `rank`；② 有一个可分组的属性；③ 宿主类上挂 `task.mixin.KanbanCard`。**与「是不是 Task 子类」无关。**
> 2. **Card 已经自带 `rank`** —— `plugins/card/src/index.ts:67` 的 `Card` 接口声明 `rank: Rank`；模型层 `models/card/src/index.ts:140-142` 是 `@Prop(TypeRank(), core.string.Rank) @Hidden() rank!: Rank`。
> 3. **`packages/kanban` 与 Task 零耦合** —— 其唯一类型约束是 `DocWithRank { rank: Rank }`，`packages/kanban/package.json` 对 `@hcengineering/task` 的依赖数为 **0**（依赖只有 ui / platform / core / presentation / notification / rank / svelte / lexorank）。
> 4. **`Viewlet.attachTo` 类型是 `Ref<Class<Doc>>`**（`plugins/view/src/types.ts:455-457`），没有 Task 子类约束。
> 5. **分组机制通用** —— `groupByCategory`（`plugins/view-resources/src/utils.ts:1086-1116`）只按属性的 `attrClass` 找 mixin，没有任何 task 分支。
>
> ⚠️ **此前 §13.3「事实核查记录」第 3 条的表述（「Card 路线要自己接线 viewlet，D1 需原型验证」）已被本次原型取代**：接线确实要做，但那是**注册**工作，不是**能力缺口**；`descriptor` 可以直接复用上游 `task.viewlet.Kanban`。

#### 3.1.1 看板落地：路 A（复用上游 `task.viewlet.Kanban`）

**已定方案（2026-08-26）：路 A** —— 不自写 viewlet descriptor，直接复用上游的。落地四件事：

1. 在 `models/agentra-core/src/index.ts` 注册一个 `view.class.Viewlet`，`descriptor: task.viewlet.Kanban`，`attachTo` 指向 Lead 的 MasterTag；
2. `builder.mixin(<Lead MasterTag>, core.class.Class, task.mixin.KanbanCard, { card: ... })`；
3. 在 `plugins/agentra-core-resources` 写一个 `KanbanCard.svelte`（参照 `plugins/lead-resources/src/components/KanbanCard.svelte`）；
4. Lead 的 MasterTag 上声明一个**状态属性作为分组依据**，并给该属性类注册 `view.mixin.SortFuncs` 与 `view.mixin.AllValuesFunc`。
   > 📌 **先例证明非 Task 域可行**：`models/controlled-documents/src/index.ts:690-696` 给 `TypeDocumentState` 挂了**同一对 mixin**，而 `controlled-documents` 不是 Task 域。

`plugins/agentra-core` / `models/agentra-core` 的 `package.json` 需加 `@hcengineering/task`、`@hcengineering/task-resources` 依赖。

🔴 **两处已知退化，如实记录（都不报错、不阻断，不得在实施中"顺手修"）：**

| # | 退化 | 事实 | 后果 |
| --- | --- | --- | --- |
| 1 | 无用 lookup | `plugins/task-resources/src/components/kanban/KanbanView.svelte:89-100` **硬编码** `lookup: { space: task.class.Project, status: core.class.Status, ... }`。Card 的 space 是 `CardSpace`、且没有 `status` 字段 | Postgres 走 `LEFT JOIN`、未知字段不抛异常 → `$lookup.*` 为 `undefined`，**外加 3 次无用 JOIN 的查询开销**。功能正常，只是白花开销 |
| 2 | 完成栏渲染为空 | `plugins/task-resources/src/components/kanban/KanbanDragDone.svelte:33` 查的是 `task.class.Project`，Card 拿不到 | 「拖到赢单/丢单」的完成栏**会渲染成空条** |

✅ **用户已决定不做完成栏（2026-08-26）** —— 赢单 / 丢单作为**普通状态列**即可，路 A 天然满足；PRD 与用例中**不得出现「拖到完成区」这类交互**。

📌 **日后若要消除这两处退化**，切换到自写 viewlet 即可：**两条路的模型侧注册代码完全一样，切换只换一个 `descriptor` 常量，不返工。**

### 3.2 Traceability

新增：

```text
plugins/traceability
plugins/traceability-resources
plugins/traceability-assets
models/traceability
models/server-traceability
server-plugins/traceability
server-plugins/traceability-resources
```

包族与 §3.1、§3.3 保持同一形状（7 个包）。`traceability-assets` 承载覆盖率、关系时间线与 Trace Link kind 的显示文案；`server-plugins/traceability-resources` 承载 Trace Link command、权限过滤与 reconciliation 的实际实现（`server-plugins/traceability` 只放契约）。落地时逐项对照 §3.0 的清单。

核心模型：

```ts
// ✅ D2 已定（2026-08-26）：六种跨模块 kind。`blocks` 已删除——
// Issue ↔ Issue 依赖归 Tracker 原生（Issue.blockedBy / Issue.relations），不进 TraceLink。
type TraceLinkKind =
  | 'converted-to'
  | 'implements'
  | 'verifies'
  | 'defect-of'
  | 'fixed-by'
  | 'delivered-in'

type TraceLinkState = 'active' | 'orphaned' | 'revoked'

interface TraceLink extends Doc {
  // 存储落在 DOMAIN_RELATION，字段沿用该域既有的 docA / docB：
  //   docA = source，docB = target（白拿该域已有的两个 btree 索引，零上游 schema 补丁）
  source: Ref<Doc> // 持久化为 docA
  sourceClass: Ref<Class<Doc>>
  target: Ref<Doc> // 持久化为 docB
  targetClass: Ref<Class<Doc>>
  kind: TraceLinkKind

  // 版本化归一字段：边本身指向"具体版本"的 _id，另冗余存两端的 baseId 供查询期按需求归一
  sourceBaseId: Ref<Doc>
  targetBaseId: Ref<Doc>

  // 关系生命周期状态。Doc 基类没有 archived 字段，
  // 「删除任一端默认保留归档关系」不是平台现成语义，必须由本字段自带。
  state: TraceLinkState

  metadata?: Record<string, string>
}
```

⚠️ **不要重复声明 `createdBy` / `createdOn`** —— `Doc` 基类已有这两个字段且由平台自动填充；在 `TraceLink` 里再声明一遍会与基类重复。此前版本的 spec 写了，**已删除**。

实现约束：

- **存储域为 `DOMAIN_RELATION`**，`source → docA`、`target → docB`；不新建自有 domain，也不给上游打 schema 补丁；
- **逻辑唯一键（版本化口径，见 §3.2.1）**：`(source, sourceClass, target, targetClass, kind)` —— 其中 `source` / `target` 是**具体版本的 `_id`**。旧版 spec 把它当作「一对对象只能有一条边」的唯一键，**在版本化下必然失效**（需求改版后新版本会合法地产生第二条同语义的边），现按「一条边 = 一条具体版本间的审计事实」重写；
- 反向查询直接吃 `docB` 上的既有 btree 索引，不双写反向 Link；
- **删除任一端不物理删边**，由 cleanup trigger 把 `state` 置为 `orphaned`（人工撤销置 `revoked`），保留审计事实；
- 查询结果逐端做权限过滤；
- 禁止把目标标题等敏感字段复制到 link 文档；
- 服务端校验允许的 class/kind 组合。

方向为 `source --kind--> target`，V1 固定映射如下：

```text
Lead             --converted-to--> Requirement
WorkItem         --implements----> Requirement
TestCase         --verifies------> Requirement
Bug              --defect-of-----> TestResult | TestCase | Requirement
Bug              --fixed-by------> PullRequest
Requirement/WorkItem/Bug --delivered-in--> ProductVersion
```

反向导航由索引查询派生，禁止为同一语义双写反向 Link。

### 3.2.1 追溯语义：边记录的是「具体版本的审计事实」

（2026-08-26 拍板，条目 26–29）

🔴 **TraceLink 记录的是审计事实，不是「当前逻辑关系」。** 一条边永远指向它被创建那一刻的**具体版本 `_id`**；需求改版不会就地改写既有边。查询期需要按对象归一时，用冗余的 `sourceBaseId` / `targetBaseId`。

需求改版（Requirement 产生新版本）时的继承规则：

| kind | 是否继承到新版本 | 理由 |
| --- | --- | --- |
| `implements` | ✅ 继承 | 交付关系不因需求措辞改版而失效 |
| `converted-to` | ✅ 继承 | 来源线索关系是稳定事实 |
| `verifies` | ❌ **不继承** | 需求改版后覆盖率**归零**，逼 QA 重新确认用例是否仍然验证新版本 |
| `defect-of` | ✅ 继承 | 缺陷事实不随需求改版消失 |
| `fixed-by` | ✅ 继承 | 同上 |
| `delivered-in` | ❌ **不继承** | 发布是**时点快照**，只对当时交付的那一版成立 |

🔴 **继承产生的边不写 Activity**（2026-08-27 拍板）。一次改版会一次性继承多条边，若每条都写 Activity，活动流会被一批**谁都没做过**的条目淹没 —— 继承是改版的**机械后果**，而改版本身已有记录。要追溯某条边何时出现，看的是边自身的 `createdOn` 与它所属的版本，不是活动流。
> ⚠️ 代价：活动流里看不到「这条边是随某次改版继承来的」，只能从边的版本归属反推。

🔴 **继承失败在 V1 不提供修复入口**（2026-08-27 拍板）。继承是逐条写入的，中途失败会让新版本少几条边；V1 既不做补偿命令，也不做管理端修复工具。
> ⚠️ **同一条决定还覆盖另一个场景**：backup/restore 与 `server/tool` migration **绕过全部 middleware**，从这两条路进来的删除会留下悬空的 TraceLink。而 `orphaned` 这个状态**生产代码从不写入** —— 正常路径上 `deleteGuard` 用 `state: { $ne: 'revoked' }` 直接拒绝删除带边的文档，所以按设计悬空边不该产生。两类不一致**目前都没有任何自动修复**。
> ⚠️ 代价：只能靠追溯完整率掉下 100% 来发现，且只能手工重建。

「追溯完整率 100%」（PRD §2.2）的口径是**当前版本口径**：统计时，边必须指向该需求 `isLatest` 的那一版；指向历史版本的边计入审计历史，不计入完整率分子。

🔴 **`fixed-by` 与 `delivered-in` 落地前，PRD 的「追溯完整率 100%」无法验收** —— 这两类边目前没有任何创建路径（见 §3.2.2）。

### 3.2.2 追溯边的创建路径（四条零创建路径）

盘点发现七类边中有四类**没有任何创建入口**，模型建了也不会有数据。落地任务见 implementation-plan：

| kind | 现有创建路径 | 补齐动作 |
| --- | --- | --- |
| `converted-to` | ✅ ConvertLeadToRequirement command | 无 |
| `implements` | ❌ 只有「从 Requirement 批量拆 Work Item」一条 | **Task 12a**：Requirement 详情页 / Issue 详情页各一个手工双向关联入口 + command |
| `verifies` | ❌ 零 | **Task 15 扩充**：TestCase 详情页、Requirement 详情页、批量关联三个入口 |
| `defect-of` | ⚠️ 只覆盖 TestResult | **Task 15 扩充**：扩到 TestCase / Requirement 两端 |
| `fixed-by` | ❌ 零 | **Task 17a**：解析 GitHub PR 的 closing reference 自动建边 + 手工关联兜底（Phase 5 阻断项） |
| `delivered-in` | ❌ 零 | **Task 18 扩充**：门禁通过后批量建边，语义为发布时点快照 |

### 3.3 Requirement

新增独立模块，避免产品需求生命周期与 CRM 耦合：

```text
plugins/requirements
plugins/requirements-resources
plugins/requirements-assets
models/requirements
models/server-requirements
server-plugins/requirements
server-plugins/requirements-resources
```

Requirement 采用版本化 Card 类型，业务 mixin 至少包含：

```ts
interface RequirementData {
  status: RequirementStatus
  priority: RequirementPriority
  owner: Ref<Employee>
  product?: Ref<Product>
  targetVersion?: Ref<ProductVersion>
  acceptanceCriteria: MarkupBlobRef | null
  sourceCount: number
  workItemCount: number
  testCoverageSummary?: CoverageSummary
}
```

计数字段是可重建缓存，不是关系事实来源。来源、Work Item 和 Test Case 必须通过 TraceLink 查询。

> ✅ **D2 已定（2026-08-26）**：来源 Lead、Work Item、Test Case 这三类**跨模块**关系一律经由 TraceLink 查询（`converted-to` / `implements` / `verifies`），本段成立。
>
> ✅ **D1 已关闭（2026-08-26）**：Requirement **确定走 `card.Card` 扩展类型**（同 §3.1），Task 8 可以写死载体断言，冻结解除。

#### 3.3.1 为什么否决 `plugins/controlled-documents`（ControlledDocument）路线

🔴 **先撤销两条被证伪的理由。** 此前若写过「CD 与 Card 的标签体系 / 关系 / 全文体系割裂」，**那两条是错的**：

- CD 用的就是**标准 `TagReference`**（`plugins/controlled-documents/src/types.ts:129`，`labels?: CollectionSize<TagReference>`）；
- CD **已注册 `FullTextSearchContext`**（`models/controlled-documents/src/index.ts:698-701`，`toClass: documents.class.Document`、`fullTextSummary: true`）；
- 关系侧也无约束。

🔴 **真正且唯一决定性的否决理由：状态语义塞不进去，且塞进去必然长期冲突。**

`DocumentState`（`plugins/controlled-documents/src/types.ts:193-199`：`draft` / `effective` / `archived` / `deleted` / `obsolete`）与 `ControlledDocumentState`（`:236-243`：`inReview` / `reviewed` / `inApproval` / `approved` / `rejected` / `toReview`）**都是 TypeScript 字符串 enum**，覆盖的是**文档审批语义**。而 PRD §5.2 要求的 `InDelivery`（In Delivery）、`Validating` 属于**交付生命周期语义**，不在文档审批语义内 —— 要支持就必须**改上游 enum 及其全部使用处**，于是**每次 upstream sync 都会冲突**（违反 §12 上游同步策略与 §1 工程原则）。

**次要理由**：创建一个 ControlledDocument **强制需要 template**，且最少要落 **4 个 Doc**（`DocumentMeta` / `ProjectMeta` / `ProjectDocument` / `ControlledDocument`），对 Requirement 这种高频创建对象是不必要的复杂度。

#### 3.3.2 走 Card 之后，Requirement 侧仍需自建的四项

| # | 自建项 | V1 口径 |
| --- | --- | --- |
| 1 | 审批 / 评审工作流 | V1 交付（REQ-004） |
| 2 | 变更历史 UI | V1 **只做字段级 Activity 流**（谁在何时改了哪个字段）—— Card 现成能力，零成本 |
| 3 | 旧版本可检索性 | 🔴 **V1 明确不做**。旧版本全文检索需要改上游 `server/indexer` 的索引逻辑，属长期补丁 |
| 4 | 服务端只读强制 | V1 交付（历史版本不可改写，同 §3.2.1 审计事实不可变） |

🔴 **V1 不做跨版本正文 diff**，也不做旧版本全文检索。PRD REQ-001 的「变更历史」口径已据此软化，QA 的验收口径同步调整。

### 3.4 Tracker 扩展

尽量复用 `tracker.Project`、`tracker.Issue`、`tracker.Milestone`、Issue dependency 和 TaskType。

🔴 **更正（2026-08-26 拍板）：PM-003 的四类计划依赖与 PM-005 的 Gantt 一并降级到 V1.1，V1 不交付。**

此前 spec 与 PRD 都写成「上游已完整实现，V1 只做复用与验证」，**那是错误判断，现予更正**（本条已更正三次，以本次为准）。**核实到的事实**：

```ts
// plugins/tracker/src/index.ts —— 类型定义存在
export type DependencyKind = 'finish-to-start' | 'start-to-start' | 'finish-to-finish' | 'start-to-finish'

export interface IssueRelation extends AttachedDoc<Issue, 'relations'> {
  target: Ref<Issue> // successor
  kind: DependencyKind
  /** Lag in schedule days; can be negative (overlap). */
  lag: number
}
```

- `IssueRelation` 是上游**为尚未落地的 Gantt 预留的死 schema**：模型类本身在 `models/tracker/src/types.ts` 中**有声明**，但全仓 `addCollection(IssueRelation)` **零命中** —— 没有任何地方把它挂成集合，因此没有代码写它、也没有 UI 读它；
- 今天真正在用的是 `Issue.blockedBy` 与 `Issue.relations` 两个 **`RelatedDocument[]` 数组**（⚠️ 复核修正：不是「无类型数组」，`RelatedDocument` 是有类型的，但它**只有 `_id` + `_class`，不带依赖类型也不带 `lag`**）——只有「阻塞 / 关联」两种语义；
- `Issue.blockedBy` **没有 `@Index`**（`relations` 有 `@Index`，但见 §13.3 的 R-PG-INDEX：`@Index` 在 PG 上不产生实际索引）；
- `plugins/tracker-assets/lang/en.json` 里的 `GanttDependency` / `GanttLag` 只是**孤儿 i18n key**，没有消费方。

因此 **V1 只交付现有的阻塞/关联数组**（PRD PM-002 的范围）。四类依赖 + `lag` + Gantt 展示 + 日期级联 + 循环依赖阻断整体推到 **V1.1**，届时按「实现一个上游未落地的能力」的工作量重新估算，而不是按「复用验证」估算。

新增 Cycle：

```ts
interface Cycle extends Doc {
  space: Ref<Project>
  name: string
  goal?: MarkupBlobRef | null
  status: 'planned' | 'active' | 'completed' | 'cancelled'
  startDate: Timestamp
  endDate: Timestamp
  capacity?: number
  sequence: number
}
```

Issue 通过 mixin 增加 `cycle?: Ref<Cycle>`；速度、燃尽和滚动数据从 Activity/Issue 快照计算，不以手工字段作为事实来源。

Work Item 类型优先复用现有 TaskType；若上游能力不能满足 Requirement/Story/Task/Bug/Spike 的权限和工作流，再添加薄 mixin，不引入平行 Issue 类。

### 3.5 Test Management 扩展

复用现有 TestProject、TestSuite、TestCase、TestPlan、TestRun、TestResult。

**既有能力（不重复实现）**：`plugins/test-management/src/types.ts` 的 `TestCaseStatus` 上游已是 `Draft, ReadyForReview, FixReviewComments, Approved, Rejected`，与 PRD §5.4 的审核状态完全吻合。V1 直接复用该枚举，只补「Approved Case 被修改时自动回落评审状态」这条迁移规则，**不新增、不重命名、不平行定义**审核状态。

🔴 **必须扩展的枚举：`TestRunStatus` 缺 `Skipped`。** 上游当前只有四个值：

```ts
export enum TestRunStatus {
  Untested,
  Blocked,
  Passed,
  Failed
}
```

而 PRD QA-007 要求 **Passed / Failed / Blocked / Skipped / Untested 五种**。落地要求（2026-08-26 拍板，条目 24）：

- **只能在末尾追加 `Skipped = 4`**，不得插入或重排既有成员——这是数值枚举，重排会静默改写库中已持久化的 `TestResult.status` 数值（历史 Passed 会变成别的状态）；
- **不配空 migration**：末尾追加数值枚举**不需要任何数据迁移**（既有取值不变），写一条什么都不做的 migration 只是噪音。此前 spec 要求的「幂等兼容 migration」**已撤销**；
- 🔴 **但必须逐一改完下面 6 个消费点**——这才是本项工作的实际内容：

| # | 消费点 | 不改的后果 |
| --- | --- | --- |
| 1 | `TestRunStatus` 枚举声明本身 | — |
| 2 | 展示数组（`testRunStatuses` 之类的全量列表） | UI 的状态下拉里没有 Skipped |
| 3 | 状态图标 / 配色映射 | Skipped 显示为默认图标或空白 |
| 4 | i18n：`test-management-assets` 的 `lang/en.json` + `lang/zh.json` | 界面出现 raw key |
| 5 | 🔴 **`getTestRunStats`（四个硬编码查询）** | 见下方警告 |
| 6 | 发布门禁（§3.6 Release Readiness）的结果读取分支 | Skipped 落进 `default` 分支被当成通过 |

🔴 **第 5 项是静默数据错误，必须单独测。** `getTestRunStats` 是**四个硬编码查询**（分别数 Untested / Blocked / Passed / Failed），`total` 也由这四个相加得出。新增的 `Skipped` **既不进 total、也不进任何桶**，后果是：**一个全部标记为 Skipped 的 Test Run 会算出 `total = 0`、进度 0%，且不报任何错**。改这一处时必须同时决定 `total` 是否包含 Skipped（推荐包含，否则进度条永远不满）。
- 通过率分母是否剔除 Skipped 必须在门禁里显式定义；
- 发布门禁读取 Test Run 结果时必须显式处理 `Skipped`，不能落进 `default` 分支被当成通过。

新增/扩展模型：

```ts
interface TestStep extends AttachedDoc<TestCase, 'steps', TestProject> {
  rank: Rank
  action: MarkupBlobRef
  testData?: MarkupBlobRef | null
  expectedResult: MarkupBlobRef
}

interface TestCaseDetails {
  preconditions?: MarkupBlobRef | null
  automationKey?: string
  version: number
  steps?: CollectionSize<TestStep>
}

interface TestEnvironment extends Doc {
  space: Ref<TestProject>
  name: string
  variables?: Record<string, string> // 仅非敏感展示值
  archived: boolean
}

interface Build extends Doc {
  name: string
  productVersion?: Ref<ProductVersion>
  repository?: Ref<Doc>
  commitSha?: string
  ciUrl?: string
}

// ✅ 2026-08-26 拍板（条目 23）：TestRun 上下文用**扁平字段**，不用嵌套对象。
// 理由：Huly 的筛选、排序、索引只作用于**顶层属性**；把上下文塞进一个嵌套对象，
// 「按 Build 筛 Run」「按 environment 排序」全部失效（QA-T015 直接挂）。
// 下面这些字段一律**平铺**在 TestRun 上，不要包成 TestRunContext：
//   testPlan / productVersion / build / environment / cycle
//   executedBy / startedOn / finishedOn / externalRunId
```

⚠️ 上面写成 `interface TestRunContext { … }` 的旧形态**已作废**，仅保留字段清单作为「需要哪些上下文」的说明。

**Build 的归属**：`Build` 归**测试项目空间**（`space: Ref<TestProject>`），与 TestEnvironment 一致；不做全局对象，否则跨项目可见性与权限都没有落点。

#### TestCase 版本快照（D6 已定，2026-08-26，条目 21–22、25）

✅ **采用独立不可变 `TestCaseSnapshot`**：

- 按 **「用例 + 版本」** 去重：同一 `(testCase, version)` 全库只有一份快照；
- **惰性创建**：只有在被 Test Plan Item 或 Test Run 首次引用时才生成，不给每次编辑都建快照；
- **服务端 middleware 拒绝一切修改**（update / remove 全部拒绝），保证历史 Run 读到的内容永不漂移；
- Test Plan Item 保存的是**快照引用**，不是版本号 + 重建逻辑。

🔴 **不使用 core 的 `VersionableClass`。** `foundations/server/packages/middleware/src/versioning.ts` 的 **`VersioningMiddleware.findAll()` 只判断 mixin 是否存在，不判断 `enabled` 标志**，并强制给查询追加 `isLatest = true`——一旦在 TestCase 上声明该 mixin，**存量用例（没有 `isLatest` 字段）会从所有列表查询中消失**。（注：indexer 侧确实检查了 `enabled === true`，但那救不了查询路径。）这是静默数据可见性事故，不是可以「先声明再调」的东西。

🔴 **测试步骤字段用内联富文本，不用 blob 引用。** 上面 `TestStep` 里的 `action` / `testData` / `expectedResult` 若各自走一个 `MarkupBlobRef`，按 PRD 容量假设的 1 万用例 × 平均步骤数计算会产生约 **24 万个 blob**，而平台**没有 blob 回收机制**（快照又是不可变的，永远不会被删）。因此三者一律存**内联富文本**。

**快照与附件**：快照只存附件的**元数据 + blob id**，不复制 blob；并且**禁止删除被任何快照引用的附件**（删除动作在服务端拒绝，提示"该附件被 N 个测试快照引用"）。

需求覆盖使用 TraceLink `TestCase --verifies--> Requirement`，反向覆盖列表通过索引查询，不允许双写。

Failed Result 创建 Bug 时复制：标题、Case/Step、预期、实际、Build、Environment、执行人、时间、日志和附件链接，并建立 `Bug --defect-of--> TestResult`。

### 3.6 Products 和 Release

复用 Product/ProductVersion 的语义版本字段。

🔴 **前提：Products 模块在本仓库默认是关闭的。** `models/all/src/index.ts` 中 `products` 的注册项为 `enabled: false, beta: false`（与 `lead` 的 `enabled: false, beta: true` 同为默认关闭，只是 beta 标记不同）。Agentra 的发布闭环强依赖 Product/ProductVersion。

> ✅ **D7 已拍板（2026-08-26）：直接改 `models/all/src/index.ts` 中 products 的注册项为 `enabled: true`。**
>
> 不走 migration 按工作区开启，也不留给管理员在 Settings 里开——发布闭环是 V1 的 P0 主线，把它做成可选开关只会让 QA 的每条 REL-* 用例都背一个前置条件。改动面是**一行**，上游合并冲突面可忽略。
>
> QA 的 REL-* 用例**不再需要**「已启用 Products 模块」这条前置条件。

#### ProductVersion 状态扩展（D5 已定，2026-08-26，条目 17）

✅ **直接扩上游 enum，末尾追加，并显式写出全部数值**（不用 mixin）：

```ts
export enum ProductVersionState {
  // ── 上游既有，数值绝不可变 ──
  Active = 0,
  Released = 1,
  // ── 本项目末尾追加 ──
  Planning = 2,
  ReleaseCandidate = 3,
  Archived = 4
}
```

- 这是**数字枚举**且 `Active = 0` 起，末尾追加**零数据迁移**——既有 `Active` / `Released` 记录的持久化数值不变，语义不变；
- 🔴 **绝不可重排或删除既有值。** 重排会静默改写库中已持久化的 `ProductVersion.state` 数值（历史 Released 变成别的状态），且不报任何错；
- **显式写出每个成员的数值**（`= 0`、`= 1`…），不要依赖隐式递增——隐式递增下，后来者在中间插一个成员就会全盘错位，而 diff 看上去人畜无害；
- 状态迁移顺序（UI 与状态机）为 `Planning → Active → ReleaseCandidate → Released → Archived`，与枚举数值顺序无关，**不要用数值大小做迁移合法性判断**。

🔴 **必须同时修上游 `CreateProductVersion.svelte:106-111`。** 该处在创建**子版本**时把父版本状态置为 `Released`。这意味着任何人都能通过「建一个子版本」**绕过发布门禁直接把父版本发版**，REL-003 形同虚设。改为置为 `Archived`（或 Frozen 语义的等价状态），发版只能走 §3.6 的 `ReleaseProductVersion` command 这一条路。这是 fork 对上游文件的**必要补丁**，在上游同步时需要保留（见 §12）。

发布门禁服务放在新增的 `server-plugins/products`（契约）+ `server-plugins/products-resources`（实现）两个包中，避免把跨对象聚合逻辑放入 Svelte 客户端。注意三处注册缺一不可：

1. `server/server-pipeline/src/serverPlugins.ts` 的 `registerServerPlugins()` 加 `addLocation(serverProductsId, () => import('@hcengineering/server-products-resources'))`，并在 `server/server-pipeline/package.json` 加依赖——**这是唯一把资源 id 解析到实现的地方**；
2. 现有 `models/server-products` 用 `builder.mixin(...)` 把 `serverProducts.function.*` / `.trigger.*` 挂到 Product/ProductVersion 上（它当前只注册了一个 `SearchPresenter`）；
3. `models/all` 里保持 `serverProductsModel` 的注册。

Release Readiness 是查询模型，聚合：

- 范围内 Requirement 和 Work Item 状态；
- 必需 Test Run/Result；
- 未关闭 P0/P1 Bug；
- PR 合并和 CI 状态；
- 审批和门禁豁免。

发布动作采用服务端 command：重新计算门禁、写入审计、更新 ProductVersion，然后触发下游状态回写。

🔴 **门禁结果必须按调用者权限二次过滤（2026-08-26 拍板，条目 20）。** 判定与回显是两件事：

- **判定用全局视图**：门禁是否通过，必须基于**全部**阻断项计算，不能只看调用者有权看到的那部分——否则一个对某些项目无权的发布负责人会**漏判**，把带阻断缺陷的版本发出去；
- **回显按调用者权限过滤**：对调用者无权查看的阻断项，只显示一行「未通过：存在受限范围内的阻断项」，**不含数量、标题、严重度、负责人**。泄露数量本身就是跨空间侧信道（能数出某个受限项目里有几个 P0 Bug）。

对应 QA 的 REL-T013（一次性列出全部失败项）需要按「有权 / 无权」两种角色各跑一遍。

### 3.7 Feishu Auth Provider

Huly 当前认证 Provider 位于 `pods/authProviders`，已有 GitHub 和 OpenID 实现。新增 `pods/authProviders/src/feishu.ts` 并在 Provider 注册表中按环境变量启用。

建议配置：

```text
FEISHU_CLIENT_ID
FEISHU_CLIENT_SECRET
FEISHU_REDIRECT_URL          # 可由 ACCOUNTS_URL 推导时不重复配置
FEISHU_ALLOWED_TENANT_KEYS   # 逗号分隔或 Secret 引用
FEISHU_DISPLAY_NAME
FEISHU_AUTO_PROVISION
FEISHU_SYNC_PROFILE
FEISHU_TENANT_WORKSPACE_MAP  # D3：租户 → 工作区 → 默认角色 的映射（部署配置）
FEISHU_STATE_HMAC_SECRET     # 条目 15：飞书专用 OAuth state 签名密钥
```

> ✅ **D3 已拍板（2026-08-26）：租户 → 工作区 → 角色的映射走部署配置**（环境变量 / 配置文件，见上表的 `FEISHU_TENANT_WORKSPACE_MAP`），不做成工作区内的可视化配置界面。关闭自动开户（`FEISHU_AUTO_PROVISION=false`）时走**管理员审批兜底**：登录成功但未获授权的用户进入待审批队列，管理员批准后才被 assign 到工作区。
>
> 🔴 **AUTH-004 是全新能力，不是复用。** 上游 `loginOrSignUpWithProvider` **完全没有 `assignWorkspace` 调用**——它只负责「认证成功 + 建/找账号 + 发 token」，**不负责把人放进任何工作区**。「首次登录自动加入指定工作区」这一整段逻辑（租户 → 工作区解析、`assignWorkspace` 调用、带工作区的 token 签发、审批兜底）都要新写，按新功能估算工作量。
>
> 🔴 **不改 `server/account/src/operations.ts`。** 该文件是上游热点（近一年 27 次提交），改它必然在每次上游同步时冲突。改为：**在 `pods/authProviders` 内直接调用 `AccountDB.assignWorkspace`，并自行签发带工作区的 token**。implementation-plan Task 5 的 Files 列表里那行 `Modify: server/account/src/operations.ts` **已删除**。

**SocialId 编码（条目 11）**：飞书身份的 identity value 编码为 `<tenant_key>.<open_id>`。

🔴 **绝不能用冒号做分隔符。** `parseSocialIdString` 的实现是 `split(':')`，社交身份字符串本身已经用冒号分隔 type 与 value；value 内部再出现冒号会让 open_id 被**静默丢弃**（拿到的是截断后的前半段，不报错）。因此用 `.` 分隔，并对两段各自做可逆转义。

**`union_id` 的存放（条目 14）**：存 **fork 自有表**。**不做成第二个 SocialId**（会让同一个人出现两条社交身份，破坏「一人一身份」的绑定主键语义），**也不塞进展示字段**（那是给人看的，不是给系统做键的）。绑定主键始终是 `tenant_key + open_id`，`union_id` 只作跨应用辅助标识与受控迁移用。

流程：

1. `/auth/feishu` 生成 OAuth state，包含 branding/workspace 目标并签名；
2. 回调只接受一次性 code，校验 state、redirect URI 和允许租户；
3. 服务端换取用户 token 并读取最小用户资料；
4. 以 `tenant_key + open_id` 查找外部身份，`union_id` 用于受控迁移；
5. 已绑定则登录，未绑定则按配置开户或要求管理员邀请；
6. 绑定现有账号必须由已登录用户确认或管理员审批；
7. 登录完成后复用 Huly `handleProviderAuth`/token 发放流程。

需要扩展 Social Identity 类型或建立 Feishu provider-specific identity；不得伪装为 GitHub/OIDC identity。

**OAuth state 硬化（条目 15）**：🔴 **只硬化飞书这一条路径，不动共享 helper。** 在 `feishu.ts` 内自己做 HMAC 签名 + nonce 绑定（nonce 单次有效、与 session 绑定、带过期时间），不去改 `encodeState` / `safeParseAuthState` 这两个被 GitHub / OIDC 共用的函数——改共享 helper 会把两条已上线的登录路径一起拖进回归范围，收益与风险不成比例。

**日志泄漏治理（条目 16）**：🔴 **只治理飞书路径。** 日志只能记录 request/correlation id 和脱敏错误，不记录 code、access token 或 client secret。既有的 Google / OIDC / `server/account` 路径同样存在日志泄漏，**另立问题单记录，不在 V1 的飞书任务里顺手改**——那会把 Task 4/5 的改动面扩散到三条无关的登录链路上。

### 3.8 View、Form、Formula 与 Automation

V1 复用 Huly View/Viewlet，提供预设 Grid、Kanban、Gantt、Calendar 和 Saved View。V1.1 再开放管理员配置。

- 自定义字段必须注册类型和权限，核心状态不得删除；
- Lookup 从 Trace Link/明确 Ref 关系读取，结果只读；
- Formula 使用受限表达式 DSL，不执行任意 JavaScript；
- 表单只写白名单字段，匿名表单有速率限制、验证码/反滥用和来源审计；
- 自动化模型为 Trigger → Conditions → Actions；动作白名单、幂等键和执行日志必需；
- 自动化不得绕过对象权限、测试门禁或发布审批。

### 3.9 显示文案 ↔ 内部枚举值映射

各文档此前混用了显示文案与内部枚举值（`In Delivery` vs `InDelivery`、`Release Candidate` vs `ReleaseCandidate`、`Ready for Review` vs `ReadyForReview`）。**唯一映射规则**：

- **内部枚举值**（代码、模型、migration、API payload、Trace Link metadata、测试断言）一律用 **PascalCase 无空格**；
- **显示文案**（UI、PRD 正文、QA 用例的「预期结果」）一律走 i18n key，英文用**空格分词**，中文用下表的中文列；
- **任何文档在引用状态时，凡加代码反引号 `` ` `` 的一律是内部枚举值**；不加反引号的散文表述用显示文案。

| 领域 | 内部枚举值 | 英文显示文案 | 中文显示文案 |
| --- | --- | --- | --- |
| Lead 状态 | `New` | New | 新建 |
| Lead 状态 | `Contacted` | Contacted | 已联系 |
| Lead 状态 | `Qualifying` | Qualifying | 甄别中 |
| Lead 状态 | `Converted` | Converted | 已转换 |
| Lead 状态 | `Disqualified` | Disqualified | 已失效 |
| Requirement 状态 | `Draft` | Draft | 草稿 |
| Requirement 状态 | `Reviewing` | Reviewing | 评审中 |
| Requirement 状态 | `Approved` | Approved | 已批准 |
| Requirement 状态 | `InDelivery` | In Delivery | 交付中 |
| Requirement 状态 | `Validating` | Validating | 验证中 |
| Requirement 状态 | `Released` | Released | 已发布 |
| Requirement 状态 | `Rejected` | Rejected | 已驳回 |
| Requirement 状态 | `Cancelled` | Cancelled | 已取消 |
| ProductVersion 状态 | `Planning` | Planning | 规划中 |
| ProductVersion 状态 | `Active` | Active | 进行中 |
| ProductVersion 状态 | `ReleaseCandidate` | Release Candidate | 发布候选 |
| ProductVersion 状态 | `Released` | Released | 已发布 |
| ProductVersion 状态 | `Archived` | Archived | 已归档 |
| TestCase 审核状态（上游既有） | `Draft` | Draft | 草稿 |
| TestCase 审核状态（上游既有） | `ReadyForReview` | Ready for Review | 待评审 |
| TestCase 审核状态（上游既有） | `FixReviewComments` | Fix Review Comments | 待修改 |
| TestCase 审核状态（上游既有） | `Approved` | Approved | 已批准 |
| TestCase 审核状态（上游既有） | `Rejected` | Rejected | 已驳回 |
| TestRun 执行状态 | `Untested` | Untested | 未执行 |
| TestRun 执行状态 | `Blocked` | Blocked | 阻塞 |
| TestRun 执行状态 | `Passed` | Passed | 通过 |
| TestRun 执行状态 | `Failed` | Failed | 失败 |
| TestRun 执行状态（**本项目新增**） | `Skipped` | Skipped | 跳过 |
| Cycle 状态 | `planned` | Planned | 已规划 |
| Cycle 状态 | `active` | Active | 进行中 |
| Cycle 状态 | `completed` | Completed | 已完成 |
| Cycle 状态 | `cancelled` | Cancelled | 已取消 |
| Issue 依赖类型（上游既有） | `finish-to-start` | Finish to Start (FS) | 完成-开始 |
| Issue 依赖类型（上游既有） | `start-to-start` | Start to Start (SS) | 开始-开始 |
| Issue 依赖类型（上游既有） | `start-to-finish` | Start to Finish (SF) | 开始-完成 |
| Issue 依赖类型（上游既有） | `finish-to-finish` | Finish to Finish (FF) | 完成-完成 |
| 外部同步状态 | `Pending` | Pending | 同步中 |
| 外部同步状态 | `Synced` | Synced | 已同步 |
| 外部同步状态 | `Failed` | Failed | 同步失败 |
| 外部同步状态 | `DeadLetter` | Dead Letter | 死信 |

⚠️ Cycle 与 Issue 依赖两组是**小写连字符**而非 PascalCase：Cycle 沿用 §3.4 已定义的字面量联合类型，Issue 依赖沿用上游 `DependencyKind` 的既有取值，**均不得为了统一风格而改写**——改写会破坏上游兼容与已持久化数据。

## 4. Command 与事件

高风险多对象操作走服务端 command，而非客户端连续创建：

🔴 **平台不保证多对象原子性，本节的表格按此重写（2026-08-26 拍板，条目 3–4）。**

**核实到的事实**（2026-08-26 复核修正）：`PostgresAdapter.tx()` 按 **domain 分组**后**分别处理 add / update / mixin / remove**（`foundations/server/packages/postgres/src/storage.ts`），而 `BEGIN/COMMIT` 只包裹 `ConnectionMgr.write()` 的**单次回调**（`foundations/core/packages/postgres-base/src/index.ts`），插入与删除还走 `mgr.retry`。⚠️ 早期版本写的「固定拆成四段、每段各自 BEGIN/COMMIT」**不准确**，但结论不变：**一次 `tx()` 会落成多个互不相干的数据库事务**。也就是说，一个 command 里创建 Requirement + Trace Link + 改 Lead 状态 + 写 Activity，**不是一个数据库事务**，中途崩溃会留下部分写入。因此**「原子结果」这一列的承诺无法兑现**，改为「最终一致结果 + 可重入命令」：

| Command | 输入 | 最终一致结果 + 可重入命令 |
| --- | --- | --- |
| `ConvertLeadToRequirement` | lead、product、project、owner、idempotencyKey | Requirement、Trace Link、Lead 状态、Activity —— **每一步先查再写**，中途失败后重放同一 key 从断点续做，不产生重复对象 |
| `CreateDefectFromTestResult` | result、project、assignee、idempotencyKey | Bug、Trace Link、Result 元数据、Activity —— 同上 |
| `CompleteCycle` | cycle、rolloverPolicy | Cycle 状态、Issue rollover、统计快照 —— rollover 按 Issue 逐个判定，已滚动的不重复滚动 |
| `ReleaseProductVersion` | version、approval、idempotencyKey | 门禁检查、Version 状态、状态回写、Activity —— 重放返回同一发布结果 |

#### 4.1 幂等 Command 的落地形态（条目 3）

✅ **采用 Server Middleware + 确定性 `_id` claim。**

- **确定性 `_id`**：命令产出的每个对象，其 `_id` 由 `hash(commandName, idempotencyKey, objectRole)` 生成。🔴 **`_id` 必须是 24 位小写十六进制字符串**——注意这不是 `Ref<T>` 的类型约束（它只是 branded string），而是 `isId()` 的**运行时校验**与 `generateId()` 的既定形态（`foundations/core/packages/core/src/utils.ts`）。hash 结果必须截断/编码到该形态；
- **claim 语义**：先以确定性 `_id` 抢占（insert，冲突即说明别人已在做/已做完），拿到 claim 才继续；
- **落地包**：收敛到**已有的 `agentra-core` 包族**（2026-08-26 定，不另起 `agentra-command`）—— `server-plugins/agentra-core`（契约：claim 类型与确定性 `_id` 生成函数）+ `server-plugins/agentra-core-resources`（middleware 实现）+ `models/server-agentra-core`（模型接线）。三个包**均已存在且已完成注册**（`serverPlugins.ts` 的 `addLocation`、`models/all` 的 model 注册、`rush.json` 登记），落地时只追加文件，不新建包；
- **注册点**：`server/server-pipeline/src/pipeline.ts` 的 middleware 链，**插在事务展平之后、落库之前**。先例参照 `server-plugins/rating` 的 `RatingMiddleware`（同一条链上的自定义 middleware）。

**V1 只做三件事**（条目 10）：

1. **过期 claim 抢占**：claim 上带 `startedOn`，超过阈值的 claim 可被行锁抢占重做；
2. **命令可重入**：每一步先查再写（`findOne` 命中就跳过），任意步骤失败后重放同一 key 都能收敛到同一结果；
3. **复用平台既有 Tx 事件流**发领域事件，不自建投递通道。

🔴 **outbox / 死信 / 对账三件套推 V1.1**，V1 不实现。

领域事件：

```text
crm.lead.converted
requirement.status.changed
tracker.cycle.completed
test.result.completed
test.result.failed
github.pull_request.updated
release.readiness.changed
product.version.released
integration.sync.failed
```

事件消费者必须支持重复投递；副作用使用事件 id 作为幂等键。

## 5. API 与自动化测试导入

内部 UI 优先使用 Huly transaction/client 模型。外部自动化测试提供受限 REST endpoint：

```text
POST /api/v1/test-runs/import
Authorization: Bearer <scoped-token>
Idempotency-Key: <pipeline-run-id>
```

请求包含 project、plan/case mapping、build、environment 和 results。

✅ **QA-012 整体留在 V1，含 JUnit 导入（2026-08-26 拍板，条目 8）。** 通用 JSON 与 JUnit XML 两个转换器**都在 V1 交付**。此前 PRD §6.5 / §9、本节、implementation-plan Task 16 四处口径不一（有的写 V1、有的写 V1.1），**现统一为 V1**。JUnit 转换器实现为独立纯函数，便于单测。

未知 Case 默认进入待映射区，不能静默创建大量重复 Case。

Token scope 至少区分 `test:result:write`、`test:case:read`，支持撤销和审计。

## 6. 权限模型

### 6.1 默认角色

| 对象 | Sales | Product | PM | Developer | QA | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| Account/Contact | CRUD | Read | Read | Restricted Read | Read | CRUD |
| Lead | CRUD | Read/Convert | Read | Restricted Read | Read | CRUD |
| Requirement | Comment | CRUD | CRUD | Read/Update delivery | Read | CRUD |
| Project/Issue | Read | CRUD | CRUD | CRUD | CRUD | CRUD |
| Test assets/results | Read summary | Read | Read | Read/Create defect | CRUD | CRUD |
| Release | Read | CRUD | CRUD | Read | Approve quality | CRUD |
| Settings/Integration | None | None | Limited | None | Limited | CRUD |

具体权限通过 Huly Space/Role 配置落地。Restricted Read 只能看到被授权的客户上下文字段。

### 6.2 关系权限

读取 Trace Link 前先验证 source；展示 target 前再验证 target。没有 target 权限时只显示“存在受限关联”，不显示标题、标识、人员或状态。聚合计数默认也不包含无权对象，避免侧信道泄漏。

## 7. 幂等、同步与一致性

- Command 接收客户端生成的 idempotency key，并保存 command result；
- 转换后在 source 保存目标引用缓存，但 Trace Link 仍为关系事实来源；
- GitHub/Feishu webhook 使用 provider event id 去重；
- 外部同步状态包括 Pending、Synced、Failed、DeadLetter；
- 重试采用指数退避和抖动，达到阈值进入 DeadLetter；
- 管理员可以重放单事件，重放动作审计；
- 后台 reconciliation job 对账 GitHub 状态、Trace Link 缓存和汇总计数（**V1.1**）；
- 🔴 **不使用跨服务分布式事务，也不使用本地事务 + outbox**（2026-08-26 拍板，条目 4、10）。理由见 §4：一次 `PostgresAdapter.tx()` 会落成多个互不相干的数据库事务（按 domain 分组分别处理 add/update/mixin/remove，`BEGIN/COMMIT` 只包裹单次 `ConnectionMgr.write()` 回调），**平台不保证多对象原子性**，"本地事务"这个前提本身就不成立。V1 采用：**确定性 claim + 可重入命令 + 复用平台既有 Tx 事件流**。
- **V1 只做**：过期 claim 抢占（`startedOn` + 行锁抢占）、命令可重入（每步先查再写）、复用平台 Tx 事件流；
- **V1.1 再做**：outbox、死信队列、对账 job 三件套。上表「外部同步状态包括 Pending、Synced、Failed、DeadLetter」中的 `DeadLetter` 在 V1 只作为**状态值**存在（GitHub webhook 重试达阈值时置位并在 UI 可见），不配套独立的死信队列基础设施。

## 8. Migration

建议 schema 阶段：

1. 注册新 plugin/model 和默认角色；
2. 创建默认 Pipeline、Lead Source、Requirement 类型、Work Item 类型和 Test Environment；
3. 为现有 Test Case 添加版本/扩展默认值；
4. 为现有 Product Version 建立兼容状态映射；
5. 构建 Trace Link 索引和缓存；
6. 后台回填，不阻塞首次 workspace 升级；
7. 完成后写 migration marker 和对账报告。

不自动迁移上游 `lead` 模块的既有对象（该模块默认 `enabled: false`，多数工作区本就没有数据）。若用户需要迁移，提供显式 dry-run 工具，输出数量、字段映射、冲突和不可迁移项，经确认后执行。

## 9. 可观测性

所有 command、OAuth、Webhook、同步、自动化和 migration 使用 correlation id。

关键指标：

- OAuth success/failure/tenant rejection；
- command latency/idempotent replay/failure；
- webhook lag/retry/dead-letter；
- Trace Link integrity violation；
- Requirement coverage；
- Test Run progress/pass/fail/blocked；
- Release gate failure reason；
- migration progress/reconciliation drift。

日志不输出 token、secret、完整 OAuth code、敏感客户字段和测试附件内容。

## 10. 自托管配置

- 核心镜像从 fork 的固定 commit 构建并打不可变 tag；
- `huly-selfhost` 只引用固定镜像，不使用浮动 latest；
- Feishu/GitHub Secret 通过 `.env` 外的 Secret Manager 或平台 Secret 注入；
- CockroachDB、Redpanda、MinIO、Elasticsearch 和备份参数按生产负载复核；
- 上线前完成备份、恢复、滚动升级或维护窗口演练；
- 健康检查覆盖 account/authProviders、transactor、fulltext、对象存储和消息队列。

## 11. 测试要求

### 11.1 单元/模型

- 状态机、权限 predicate、公式/Lookup、门禁、幂等键；
- Trace Link 组合校验、反向查询和权限过滤；
- model builder 和 migration；
- Test Case version snapshot；
- Cycle 统计和 rollover。

### 11.2 集成/合同

- 使用 mock server 验证飞书 OAuth、租户拒绝、token 错误和资料缺失；
- GitHub webhook 重复、乱序、失败重试和 reconciliation；
- Command 多对象一致性和事件重复投递；
- JUnit/JSON 导入 mapping 和幂等。

### 11.3 E2E

覆盖 Lead → Requirement → Issue → Test → Bug → PR → Release 全链路、各角色权限和失败恢复。

按照仓库 `AGENTS.md`，本阶段不自动运行构建命令；实现阶段的验证命令必须先在计划中列明，并由执行者按上游指南运行。

## 12. 上游同步策略

1. 每周 fetch `upstream/develop`，先在同步分支 rebase/merge；
2. CI 运行 model migration、插件注册、核心 E2E 和部署冒烟；
3. 新增代码避免修改上游同一热点文件；必须修改注册表时保持补丁最小；
4. 对上游已经实现的等价能力，优先迁移数据并删除 fork 特有实现；
5. 每个 release 记录上游 commit、fork commit、migration version 和镜像 digest。

**fork 对上游文件的必要补丁清单**（每次上游同步时必须逐条确认仍然存在）：

| 上游文件 | 补丁内容 | 丢了会怎样 |
| --- | --- | --- |
| `plugins/products-resources/.../CreateProductVersion.svelte`（约 106-111 行） | 建子版本时把父版本置为 Frozen/Archived，而非 `Released` | 任何人可绕过发布门禁直接发版，REL-003 形同虚设 |
| `plugins/test-management/src/types.ts` | `TestRunStatus` 末尾追加 `Skipped = 4` | QA-007 / QA-T021 失效 |
| `plugins/products/src/types.ts` | `ProductVersionState` 末尾追加 `Planning`/`ReleaseCandidate`/`Archived` | REL-001 / REL-T012 失效 |
| `models/all/src/index.ts` | products 注册项 `enabled: true` | 整个发布模块在导航中消失 |
| `server/server-pipeline/src/pipeline.ts` | 注册幂等 command middleware（插在事务展平之后、落库之前） | 全部 command 失去幂等保证，且不报错 |

## 13. 开放问题

### 13.1 决策台账

**2026-08-26：全部 27 项开放决策已由决策者拍板，一律采纳推荐方案。** 起初除 D1 外全部关闭、D1 进入原型验证阶段；**当日晚些时候 D1 的原型完成并拍板，D1 亦已关闭 —— 至此 27 项全部关闭。**

| # | 待决项 | 状态 | 结论 | 影响的章节/任务 |
| --- | --- | --- | --- | --- |
| D1 | Requirement（及 Lead）建成 Card 扩展类型还是独立 Doc 类型 | ✅ **已关闭（2026-08-26）：定为 `card.Card` 扩展类型（MasterTag）** | 原型结论：**Card 能挂看板，且不需要改上游 `card` 包一行代码**。看板硬前提只有「有 `rank` + 有可分组属性 + 挂 `task.mixin.KanbanCard`」三条，与是否 Task 子类无关；Card 自带 `rank`（`models/card/src/index.ts:140-142`），`packages/kanban` 对 `@hcengineering/task` 依赖数为 0，`Viewlet.attachTo` 是 `Ref<Class<Doc>>` 无子类约束，`groupByCategory` 无 task 分支。看板走**路 A**（复用 `task.viewlet.Kanban`），两处已知退化（无用 lookup、完成栏空条）如实记录且**不做完成栏**。Requirement 否决 ControlledDocument，决定性理由是其状态 enum 为字符串 enum、装不下 `InDelivery`/`Validating`，改上游必然每次 sync 冲突。**Task 6/7/8 冻结解除。** | §3.1、§3.1.1、§3.3、§3.3.1、§3.3.2；**Task 0（已完成）**、Task 6、Task 7、Task 8 |
| D2 | TraceLink 是否为跨模块关系的唯一事实来源 | ✅ 关闭 2026-08-26 | 自建 `TraceLink` 类，**只承载跨模块关系**；`blocks` 从七条边中删除，Issue↔Issue 依赖归 Tracker 原生；存储放 `DOMAIN_RELATION`（`docA`=source / `docB`=target），白拿两个 btree 索引、零上游 schema 补丁 | §1 第 3 条、§3.2；Task 2、Task 3 |
| D3 | 飞书租户如何映射到工作区 | ✅ 关闭 2026-08-26 | 租户→工作区→角色映射走**部署配置**；关闭自动开户时走管理员审批兜底。上游 `loginOrSignUpWithProvider` 完全没有 `assignWorkspace`，**AUTH-004 是全新能力**；不改 `server/account/src/operations.ts`，改为在 `pods/authProviders` 内直接调 `AccountDB.assignWorkspace` 并签发带工作区的 token | §3.7；Task 4、Task 5 |
| D4 | V1 到底包含哪些 P1 | ✅ 关闭 2026-08-26 | V1 承诺的 P1 集合见 PRD §9（已冻结，含显式写入的 REL-006、PM-009）；非承诺 P1 标记 `Deferred`，不计入 V1 退出标准。PM-008 拆成三条需求 ID，其中重复任务推 V1.1；PM-003 + PM-005 的 Gantt 降级 V1.1；QA-012 整体留 V1 | PRD §9；QA §4.2/§5/§8；全局排期 |
| D5 | ProductVersion 状态扩展采用 mixin 还是扩上游 enum | ✅ 关闭 2026-08-26 | **末尾追加**上游 enum 并显式写出全部数值（`Active = 0` 起，追加 `Planning`/`ReleaseCandidate`/`Archived`）。数字枚举，**零数据迁移**；绝不可重排或删除既有值。同时必须改上游 `CreateProductVersion.svelte:106-111`（建子版本时把父版本置 Frozen/Archived 而非 `Released`），否则可绕过发布门禁 | §3.6；Task 18 |
| D6 | TestCase 版本快照的具体设计 | ✅ 关闭 2026-08-26 | 独立不可变 `TestCaseSnapshot`：按「用例+版本」去重、惰性创建、服务端 middleware 拒绝一切修改。**不使用 core 的 `VersionableClass`**（`VersioningMiddleware.findAll()` 不判 `enabled` 且强制追加 `isLatest = true`，一声明会让存量用例从所有列表消失）。步骤字段用**内联富文本**，不用 blob 引用 | §3.5；Task 13、Task 14 |
| D7 | Products 模块的启用策略 | ✅ 关闭 2026-08-26 | 改 `models/all/src/index.ts` 中 products 配置为 `enabled: true`。QA 的 REL-* 用例不再需要「已启用 Products」前置条件 | §3.6；Task 18 |
| D8 | Kubernetes 是否属于 V1 交付范围 | ✅ 关闭 2026-08-26 | **K8s 明确标为 V1 非目标**（方案 B）。QA 维持只演练 Docker Compose，PRD §8 已改写 | PRD §8、§2.3；QA §2/§3.1/§6 |

### 13.2 不阻断 PRD 的开放问题

- 飞书组织同步使用轮询还是事件订阅，需要根据企业应用权限审批结果选择；
- Cycle 是否可复用未来上游对象，需要首次同步上游 roadmap 后确认；
- 自动化结果导入首个 CI 平台根据实际团队工具选择。


### 13.3 工程护栏（硬约束，2026-08-26，条目 31–32）

以下两条是**全项目硬约束**，任何 Task 都不得违反；已同步写入 implementation-plan 的执行规则。

#### 护栏 1：自建 Kafka 消费者的 handler 必须自行 try/catch

🔴 上游消费者是**无限原地重试**（handler 抛错既不 commit offset 也不跳过），**一条毒消息会永久卡死整个 partition**，且表现为「消息不再前进」而不是报错退出。因此：

- 任何自建 Kafka 消费者的 handler **必须自行 try/catch**；
- catch 里必须做出**明确处置**（记录 + 落到失败表 / 置 `DeadLetter` 状态 / 显式跳过），不得直接 rethrow；
- 单测必须包含「handler 抛错后消费继续前进」这一条。

#### 护栏 2：枚举只允许末尾追加

🔴 修改或删除既有枚举值**必须配套扫描迁移**。原因不止是已持久化的数值：**已保存的筛选视图存的是 JSON 字符串**，其中固化了枚举值；改动会让这些视图**静默失效且不报任何错**（筛选出 0 条，用户以为没数据）。

适用对象：`TestRunStatus`、`ProductVersionState`、`TestCaseStatus`、Lead / Requirement 状态、`TraceLinkKind` 等全部枚举与字面量联合类型。

#### 事实核查记录（2026-08-26）

上述结论所依据的代码事实已由独立只读核查逐条复核。**复核中修正的三处**：

1. `PostgresAdapter.tx()` **不是**「固定拆成四段、每段各自 BEGIN/COMMIT」，而是按 domain 分组后分别处理 add/update/mixin/remove，`BEGIN/COMMIT` 只包裹 `ConnectionMgr.write()` 的单次回调 —— **结论不变**（一次 `tx()` 落成多个数据库事务，不保证多对象原子性）；
2. `Issue.blockedBy` / `Issue.relations` 是 **`RelatedDocument[]`**，不是「无类型数组」；`relations` 上**有** `@Index`（但 `@Index` 在 PG 上不产生索引，见下）；`IssueRelation` 的**模型类有声明**，只是全仓 `addCollection` 零命中 —— **结论不变**（四类依赖 + lag 未落地）；
3. Card 的看板问题是「继承 Task 取得资格 + 模型层显式注册 viewlet/mixin」**两步**，不是「继承就自动有看板」。⚠️ **2026-08-26 由 D1 原型取代后半句**：接线确实要做，但那是**注册**工作、不是**能力缺口** —— Card 自带 `rank`、`packages/kanban` 与 Task 零耦合、`Viewlet.attachTo` 无子类约束，因此可直接复用 `task.viewlet.Kanban` 而**不改上游 `card` 包**。详见 §3.1 / §3.1.1。

#### 独立风险项：PG 上 `@Index` 不产生索引（条目 32）

🔴 **单独立项核实，不由某个 Task 顺手承担。** 已核实：PG 适配器的 `createIndex` 是**空实现**；`test-management` 走 `defaultSchema`（只有基础列和 `attachedTo` 是真实列）。因此 **`@Index` 装饰器在 PG 上不产生任何索引**。

- **威胁面**：PRD §8 的「100 万 Test Result」容量假设、QA-T020（1 万 Result 批量执行的性能指标）、以及所有依赖 `attachedTo` 以外字段做筛选的列表查询；
- **性质**：这是**全平台问题**，不是 Agentra 引入的；
- **处置**：在 QA 计划中记为**独立风险项**（见 QA §6），并在性能压测（数据集 B）中实测确认影响面，再决定是否需要 fork 侧补索引。

#### 包族命名（条目 33）

保留 `agentra-core` 作为**公共骨架包族**的命名（跨模块共用的基础设施）。🔴 **§4.1 的幂等 command middleware 直接放进 `agentra-core`，不另起 `agentra-command` 包**（2026-08-26 定）—— 另起一个包要把 §3.0 的整套注册面再走一遍，而 middleware 本就是公共基础设施。**业务包沿用文档规划的 `crm-lite` / `requirements` / `traceability` / `cycle` 命名**，不加品牌前缀（与 §2 的「包名不与品牌名耦合」一致）。
