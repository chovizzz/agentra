# Agentra 一体化平台设计

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 产品定位 | AI 原生业务与研发操作系统 |
| 英文定位 | The Agentic Work OS |
| Slogan | From signal to shipped. |
| 上游 | `hcengineering/platform`，默认分支 `develop` |
| 部署 | 完全自托管；核心代码与部署配置分仓管理 |

## 1. 决策摘要

Agentra 直接 fork [Huly Platform](https://github.com/hcengineering/platform)，在保持上游可合并的前提下，将客户线索、产品需求、项目执行、测试验证、代码交付和版本发布连接成一个对象图。

`Agentra` 是面向用户的产品品牌；`Huly Platform` 是上游技术基座；`crm-alm` 继续作为内部部署、测试和功能分组命名。品牌名不进入底层插件标识，避免未来品牌调整扩大迁移范围。

核心代码以 `platform` fork 为主；Docker Compose、域名、密钥、备份及镜像编排由 [huly-selfhost](https://github.com/hcengineering/huly-selfhost) 的独立 fork 或部署覆盖层维护。

不启用上游既有的 `lead` 模块。事实描述：该模块在 `models/all/src/index.ts` 中**仍正常注册**，只是配置为 `enabled: false, beta: true`（默认关闭的 beta 能力），**并非上游已弃用或已删除**。不采用它的理由是**默认禁用 + 能力差异**——它缺少本项目所需的版本化正文、结构化转换、跨模块 Trace Link 与配置化 Pipeline/Source，把它改造到位的代价高于新建模块，且会加大上游合并冲突面。因此新建 `crm-lite` 模块，复用 Contact、Card、Tracker、Products、Test Management、Activity、Notification、Process 和 GitHub 等现有模块。

## 2. 产品边界

首期必须形成以下闭环：

```text
客户/联系人 → 线索 → 需求 → 项目/周期/里程碑 → Issue/Bug
    → 测试用例/计划/执行/结果 → 缺陷 → Branch/Commit/PR/CI
    → 产品版本/发布 → 状态回写到客户、线索和需求
```

“一套系统”定义为：

- 同一域名、工作区、用户、权限和导航；
- 同一搜索、通知、活动记录和审计体系；
- 业务对象之间存在可查询、可授权、可回溯的正式关系；
- 一个对象页面能够查看所有上游来源和下游交付物；
- 不依赖外部 CRM 或测试管理数据库完成主流程。

首期不包含报价、合同、回款、销售预测、客服工单、客户门户和邮件收件箱。

## 3. 竞品研究形成的设计原则

研究结论以 2026-08-25 可见的官方文档、开源仓库和 Huly 上游源码为准。

| 参考产品 | 采用的设计原则 |
| --- | --- |
| [飞书多维表格](https://www.feishu.cn/product/base) | 自定义字段、关联记录、Lookup/公式、表单、多视图、自动化、仪表盘和角色权限 |
| [Linear](https://linear.app/docs/projects) | 快速创建、Triage、项目/周期、里程碑、Issue 关系、客户请求与 GitHub 状态自动化 |
| [Plane](https://docs.plane.so/core-concepts/issues/overview) | Intake、Work Item、Module、Cycle、Saved View、Initiative 和发布管理 |
| [OpenProject](https://github.com/opf/openproject) | 组合管理、WBS、Gantt、依赖、工时、计划与实际进度 |
| [Twenty](https://github.com/twentyhq/twenty) / [Frappe CRM](https://github.com/frappe/crm) | 客户/联系人、线索看板、活动时间线、下一步动作和自定义视图 |
| Huly Test Management / [Kiwi TCMS](https://github.com/kiwitcms/Kiwi) | Suite、Case、Plan、Run、Result、缺陷关联、权限和测试报告 |

不复制竞品页面；只提取已验证的领域模型、交互模式和闭环能力。

## 4. 总体架构

```mermaid
flowchart LR
  Feishu[飞书 OAuth/组织目录] --> Auth[Huly Auth Providers]
  Auth --> Workspace[Huly Workspace]

  CRM[CRM Lite] --> Trace[Traceability]
  Product[Product & Requirement] --> Trace
  Tracker[Project & Tracker] --> Trace
  Test[Test Management] --> Trace
  Git[GitHub Integration] --> Trace
  Release[Product Version & Release] --> Trace

  Trace --> Activity[Activity & Audit]
  Trace --> Search[Full-text Search]
  Trace --> Automation[Process & Automation]
  Trace --> Reports[Views & Dashboards]
```

### 4.1 复用上游

- `contact`：Organization、Person、Employee；
- `card`：版本化内容、类型、关系和扩展字段基础；
- `tracker`：Project、Issue、父子任务、组件、里程碑、估时和工时，以及 `Issue.blockedBy` / `Issue.relations` 两个 `RelatedDocument[]` 数组表达的阻塞/关联关系。🔴 **更正**：FS/SS/FF/SF 四类依赖 + `lag` **上游并未落地**（`IssueRelation` 是为尚未实现的 Gantt 预留的死 schema，全仓 `addCollection(IssueRelation)` 零命中），已随 Gantt 一并降级 V1.1（PRD PM-003 / PM-005）；
- `products`：Product、Product Version 和发布状态（✅ D7 已关闭 2026-08-26：把 `models/all/src/index.ts` 中 products 配置改为 `enabled: true`）；
- `test-management`：Test Project、Suite、Case、Plan、Run、Result；
- `github`：Issue/PR 等代码仓库对象同步；
- `activity`、`notification`、`view`、`process`、`fulltext`：横向能力。

### 4.2 新增或扩展

- 新增 `crm-lite`：Lead、Pipeline、Source、下一步动作和转换；
- 新增 `requirements`：版本化 Requirement、验收标准、评审和交付摘要；
- 新增 `traceability`：跨模块关系、覆盖率查询和闭环时间线；
- 新增 Feishu OAuth Provider：飞书登录、租户限制、身份绑定；
- 扩展 Tracker：Cycle、Work Item 类型、需求交付视图；
- 扩展 Test Management：结构化步骤、环境/构建、需求覆盖、失败转缺陷和报告；
- 扩展 Products：发布清单和闭环状态汇总；
- 新增基础表单、Saved View、自动化模板和仪表盘。

## 5. 核心数据模型

| 业务概念 | Huly 表达 | 说明 |
| --- | --- | --- |
| Account | `contact.Organization` | UI 显示为“客户” |
| Contact | `contact.Person` | 可关联一个或多个客户 |
| Lead | `card.Card` 的 CRM 类型 | 版本化、可扩展、可建立关系 |
| Requirement | `card.Card` 的需求类型 | 需求正文、验收标准、版本历史 |
| Project | `tracker.Project` | 项目执行空间 |
| Cycle | Tracker 扩展对象 | 固定周期、容量和速度 |
| Milestone | `tracker.Milestone` | 关键交付节点 |
| Work Item | `tracker.Issue` | Requirement/Story/Task/Bug 等类型 |
| Test Suite/Case/Plan/Run/Result | `test-management` 现有对象 | 通过 mixin/新 AttachedDoc 扩展 |
| Repository/PR | `github` 现有对象 | 复用官方同步 |
| Product Version | `products.ProductVersion` | 语义化版本和发布状态 |
| Trace Link | 新增 `traceability.TraceLink` | **跨模块**有向关系及关系类型；存储落在 `DOMAIN_RELATION`（`docA` = source / `docB` = target），白拿两个 btree 索引 |

Trace Link 的方向固定为 `source --kind--> target`：

| kind | 固定方向 | 改版时是否继承 | V1 创建路径 |
| --- | --- | --- | --- |
| `converted-to` | Lead → Requirement | ✅ 继承 | ✅ 已有（转换 command） |
| `implements` | Work Item → Requirement | ✅ 继承 | ⚠️ 需补手工双向关联（Task 12a） |
| `verifies` | Test Case → Requirement | ❌ **不继承**（覆盖率归零，逼 QA 重新确认） | ❌ 零 → Task 15 扩充 |
| `defect-of` | Bug → Test Result/Test Case/Requirement | ✅ 继承 | ⚠️ 仅覆盖 TestResult → Task 15 扩充 |
| `fixed-by` | Bug → Pull Request | ✅ 继承 | ❌ 零 → Task 17a |
| `delivered-in` | Requirement/Work Item/Bug → Product Version | ❌ **不继承**（发布是时点快照） | ❌ 零 → Task 18 扩充 |

🔴 **`blocks` 已从 kind 列表中删除**（2026-08-26，D2 关闭）：Issue ↔ Issue 依赖归 Tracker 原生，不进 TraceLink。

反向关系由查询派生，不创建第二条反向 Link。

**追溯边记录的是「具体版本的审计事实」**，不是「当前逻辑关系」：边存具体版本的 `_id`，另冗余存两端的 baseId 供查询期归一。「追溯完整率 100%」按**当前版本口径**（边必须指向该需求 `isLatest` 的那一版）。详见 Technical Spec §3.2.1。

> ✅ **D2 已关闭（2026-08-26）**：自建 `TraceLink` 类，只承载**跨模块**关系（六种 kind），存储放 `DOMAIN_RELATION`。
>
> ✅ **D1 已关闭（2026-08-26）：Lead 与 Requirement 均定为 `card.Card` 扩展类型（MasterTag）**，本节上表的两行即**已定结论**。原型证明 **Card 能挂看板且不改上游 `card` 包一行代码** —— 看板的硬前提是「宿主类有 `rank` + 有可分组属性 + 挂 `task.mixin.KanbanCard`」，**与是否 Task 子类无关**；Card 自带 `rank`，`packages/kanban` 对 `@hcengineering/task` 依赖数为 0，`Viewlet.attachTo` 是 `Ref<Class<Doc>>`。看板走**路 A**（复用上游 `task.viewlet.Kanban`），**不做完成栏**（赢单/丢单是普通状态列）。Requirement 否决 `controlled-documents`，决定性理由是其状态为字符串 enum、装不下 `InDelivery`/`Validating`。详见 Technical Spec §3.1 / §3.1.1 / §3.3.1。

## 6. 关键流程

### 6.1 飞书登录

浏览器进入 `/auth/feishu`，Provider 生成带防重放状态的授权请求。回调校验状态、租户和身份后，以 `tenant_key + open_id` 为主键绑定 Huly 账号，同时保存 `union_id` 作为跨应用辅助标识。已验证邮箱只用于展示和受控合并，不能单独作为自动绑定依据。

失败时回到登录页并显示可操作错误；系统保留本地超级管理员入口。

### 6.2 线索转需求

销售补齐客户、联系人、问题描述、负责人和下一步动作。产品人员执行“转需求”，选择产品、项目和负责人。服务端使用幂等键创建 Requirement、Trace Link 和 Activity；重复请求返回同一 Requirement。

### 6.3 需求到交付

Requirement 拆分为 Work Item，进入 Cycle/Milestone。Issue 关联 Branch/Commit/PR；PR 合并后按配置推进 Issue，但不得跳过必须通过的测试或发布门禁。

### 6.4 测试和缺陷

Test Case 与 Requirement 建立 `Test Case --verifies--> Requirement` 关系。Test Plan 固定用例版本并绑定 Product Version、Build 和 Environment。失败结果可一键创建 Bug，自动复制复现步骤、实际结果、日志和附件，并建立 `Bug --defect-of--> Test Result`。Bug 修复后进入回归 Run。

### 6.5 发布回写

Product Version 达到发布门禁后变为 Released。系统汇总关联需求、Issue、测试结果、缺陷和 PR，并将发布状态回写到 Requirement、Lead 和 Account 时间线。

## 7. 权限与安全

- 销售：管理客户、联系人和线索；默认不管理项目配置；
- 产品：管理需求、优先级、产品版本和转换；
- 项目经理：管理项目、周期、里程碑、资源和报告；
- 研发：管理 Work Item 和代码关系，按权限查看客户上下文；
- QA：管理测试资产、执行和缺陷；
- 管理员：配置 OAuth、角色、流程、字段和集成；
- Guest：只访问显式授权对象。

敏感字段可以按角色隐藏。所有身份绑定、权限变更、转换、测试结论、发布和外部同步写入审计事件。OAuth 密钥仅从环境变量或 Secret 注入，不存储在工作区文档、日志或 Git 中。

## 8. 一致性与错误处理

- 转换、Webhook 和外部同步必须幂等。🔴 **平台不保证多对象原子性**（一次 `PostgresAdapter.tx()` 会落成多个互不相干的数据库事务），因此幂等靠 **确定性 `_id` claim + 可重入命令**（每步先查再写），不靠「本地事务 + outbox」；
- 外部 API 失败采用指数退避、死信状态和人工重试（**V1 的 `DeadLetter` 只是一个可见状态值；outbox / 死信队列 / 对账 job 三件套推 V1.1**）；
- UI 显示 `pending/synced/failed`，不得静默吞错；
- 删除有引用对象时默认归档；物理删除需要管理员权限和二次确认；
- Trace Link 两端权限独立计算，禁止通过关系泄露无权对象标题或内容；
- Migration 可重复执行，并记录 schema version；
- 上游升级失败时不得部分应用不可逆数据迁移。

## 9. 测试设计

本项目同时覆盖两个维度：

1. 产品内的测试管理能力：Suite、Case、Plan、Run、Result、Coverage、Defect；
2. fork 自身的工程质量：单元、模型迁移、服务集成、OAuth 合同、GitHub 合同、E2E、权限、安全、性能、备份恢复和上游升级冒烟。

详细测试策略和可执行用例见 [QA Test Plan](./2026-08-25-agentra-qa-test-plan.md)。

## 10. 交付分期

- V1：飞书登录、轻量 CRM、需求、项目/周期/里程碑、Issue/Bug、测试闭环（**含 JUnit 结果导入**）、GitHub、版本发布和基础报表；
- V1.1：自定义字段、多视图、表单、Lookup/公式和自动化规则；**四类计划依赖 + Gantt**、**重复任务**、**outbox / 死信队列 / 对账 job**；
- V1.2：仪表盘设计器、高级行级权限、项目组合、资源容量、自动化测试结果接入；**Kubernetes 编排（V1 非目标）**。

详细范围见 [PRD](./2026-08-25-agentra-prd.md)，工程约束见 [Technical Spec](./2026-08-25-agentra-technical-spec.md)。
