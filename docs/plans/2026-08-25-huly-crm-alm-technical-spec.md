# Huly CRM-ALM Technical Spec

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 目标仓库 | Huly Platform fork |
| 基线 | `upstream/develop`；生产版本固定到经过验证的 commit/tag |

## 1. 工程原则

1. 优先通过新 plugin、mixin、association、viewlet 和 server trigger 扩展，不直接改写上游核心类。
2. 旧 `lead` 模块不作为依赖，也不迁移新数据到旧模型。
3. 跨模块关系以 `traceability` 为唯一事实来源，避免 CRM、测试和 Tracker 各存一套不可对账的引用。
4. 所有外部回调、转换和自动化动作都必须幂等。
5. Migration 前向兼容、可重复执行、可审计；不可逆变更需要单独备份门禁。
6. 代码、资源、模型和服务包遵循 Huly 现有包拆分及 Rush 构建约定。

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

部署仓库单独维护 `platform` 镜像引用和环境配置，不将生产 Secret 写入此仓库。

## 3. 模块规划

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

### 3.2 Traceability

新增：

```text
plugins/traceability
plugins/traceability-resources
models/traceability
models/server-traceability
server-plugins/traceability
```

核心模型：

```ts
type TraceLinkKind =
  | 'converted-to'
  | 'implements'
  | 'blocks'
  | 'verifies'
  | 'defect-of'
  | 'fixed-by'
  | 'delivered-in'

interface TraceLink extends Doc {
  source: Ref<Doc>
  sourceClass: Ref<Class<Doc>>
  target: Ref<Doc>
  targetClass: Ref<Class<Doc>>
  kind: TraceLinkKind
  createdBy: PersonId
  createdOn: Timestamp
  metadata?: Record<string, string>
}
```

实现约束：

- 逻辑唯一键为 `(source, sourceClass, target, targetClass, kind)`；
- 建立反向查询索引；
- 删除任一端默认保留归档关系或由 cleanup trigger 处理；
- 查询结果逐端做权限过滤；
- 禁止把目标标题等敏感字段复制到 link 文档；
- 服务端校验允许的 class/kind 组合。

方向为 `source --kind--> target`，V1 固定映射如下：

```text
Lead             --converted-to--> Requirement
WorkItem         --implements----> Requirement
WorkItem         --blocks--------> WorkItem
TestCase         --verifies------> Requirement
Bug              --defect-of-----> TestResult | TestCase | Requirement
Bug              --fixed-by------> PullRequest
Requirement/WorkItem/Bug --delivered-in--> ProductVersion
```

反向导航由索引查询派生，禁止为同一语义双写反向 Link。

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

### 3.4 Tracker 扩展

尽量复用 `tracker.Project`、`tracker.Issue`、`tracker.Milestone`、Issue dependency 和 TaskType。

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

interface TestRunContext {
  productVersion?: Ref<ProductVersion>
  build?: Ref<Build>
  environment?: Ref<TestEnvironment>
  cycle?: Ref<Cycle>
  startedOn?: Timestamp
  finishedOn?: Timestamp
}
```

Test Plan Item 保存被选 Test Case 的版本号；Case 更新后旧 Run 仍读取快照，避免历史结果漂移。

需求覆盖使用 TraceLink `TestCase --verifies--> Requirement`，反向覆盖列表通过索引查询，不允许双写。

Failed Result 创建 Bug 时复制：标题、Case/Step、预期、实际、Build、Environment、执行人、时间、日志和附件链接，并建立 `Bug --defect-of--> TestResult`。

### 3.6 Products 和 Release

复用 Product/ProductVersion 的语义版本字段。新增状态 mixin 或兼容扩展，使 UI 支持 Planning、Active、ReleaseCandidate、Released、Archived；不得破坏上游 Active/Released 数据迁移。

发布门禁服务放在新增 `server-plugins/products` 中，并由现有 `models/server-products` 注册所需 server resource/mixin，避免把跨对象聚合逻辑放入 Svelte 客户端。

Release Readiness 是查询模型，聚合：

- 范围内 Requirement 和 Work Item 状态；
- 必需 Test Run/Result；
- 未关闭 P0/P1 Bug；
- PR 合并和 CI 状态；
- 审批和门禁豁免。

发布动作采用服务端 command：重新计算门禁、写入审计、更新 ProductVersion，然后触发下游状态回写。

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
```

流程：

1. `/auth/feishu` 生成 OAuth state，包含 branding/workspace 目标并签名；
2. 回调只接受一次性 code，校验 state、redirect URI 和允许租户；
3. 服务端换取用户 token 并读取最小用户资料；
4. 以 `tenant_key + open_id` 查找外部身份，`union_id` 用于受控迁移；
5. 已绑定则登录，未绑定则按配置开户或要求管理员邀请；
6. 绑定现有账号必须由已登录用户确认或管理员审批；
7. 登录完成后复用 Huly `handleProviderAuth`/token 发放流程。

需要扩展 Social Identity 类型或建立 Feishu provider-specific identity；不得伪装为 GitHub/OIDC identity。日志只能记录 request/correlation id 和脱敏错误，不记录 code、access token 或 client secret。

### 3.8 View、Form、Formula 与 Automation

V1 复用 Huly View/Viewlet，提供预设 Grid、Kanban、Gantt、Calendar 和 Saved View。V1.1 再开放管理员配置。

- 自定义字段必须注册类型和权限，核心状态不得删除；
- Lookup 从 Trace Link/明确 Ref 关系读取，结果只读；
- Formula 使用受限表达式 DSL，不执行任意 JavaScript；
- 表单只写白名单字段，匿名表单有速率限制、验证码/反滥用和来源审计；
- 自动化模型为 Trigger → Conditions → Actions；动作白名单、幂等键和执行日志必需；
- 自动化不得绕过对象权限、测试门禁或发布审批。

## 4. Command 与事件

高风险多对象操作走服务端 command，而非客户端连续创建：

| Command | 输入 | 原子结果 |
| --- | --- | --- |
| `ConvertLeadToRequirement` | lead、product、project、owner、idempotencyKey | Requirement、Trace Link、Lead 状态、Activity |
| `CreateDefectFromTestResult` | result、project、assignee、idempotencyKey | Bug、Trace Link、Result 元数据、Activity |
| `CompleteCycle` | cycle、rolloverPolicy | Cycle 状态、Issue rollover、统计快照 |
| `ReleaseProductVersion` | version、approval、idempotencyKey | 门禁检查、Version 状态、状态回写、Activity |

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

请求包含 project、plan/case mapping、build、environment 和 results。V1.1 支持通用 JSON 与 JUnit XML 转换器。未知 Case 默认进入待映射区，不能静默创建大量重复 Case。

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
- 后台 reconciliation job 对账 GitHub 状态、Trace Link 缓存和汇总计数；
- 不使用跨服务分布式事务；采用本地事务 + outbox/event + 幂等消费者。

## 8. Migration

建议 schema 阶段：

1. 注册新 plugin/model 和默认角色；
2. 创建默认 Pipeline、Lead Source、Requirement 类型、Work Item 类型和 Test Environment；
3. 为现有 Test Case 添加版本/扩展默认值；
4. 为现有 Product Version 建立兼容状态映射；
5. 构建 Trace Link 索引和缓存；
6. 后台回填，不阻塞首次 workspace 升级；
7. 完成后写 migration marker 和对账报告。

不自动迁移旧 `lead` 对象。若用户需要迁移，提供显式 dry-run 工具，输出数量、字段映射、冲突和不可迁移项，经确认后执行。

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

## 13. 开放问题（不阻断 PRD）

- 飞书组织同步使用轮询还是事件订阅，需要根据企业应用权限审批结果选择；
- Product Version 状态扩展采用 mixin 还是兼容 enum migration，在实现前用最小原型验证；
- Cycle 是否可复用未来上游对象，需要首次同步上游 roadmap 后确认；
- 自动化结果导入首个 CI 平台根据实际团队工具选择。
