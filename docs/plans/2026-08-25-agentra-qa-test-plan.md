# Agentra QA Test Plan & Test Cases

| 项目 | 内容 |
| --- | --- |
| 状态 | Final |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 被测产品 | Agentra |
| 范围 | 产品测试管理能力 + fork 自身工程验证 |

## 1. 目标

验证系统在完全自托管环境中能够安全、稳定地完成：

```text
飞书登录 → 线索 → 需求 → 项目/任务 → 测试 → 缺陷 → GitHub PR → 发布 → 回写
```

测试不仅验证成功路径，也覆盖权限隔离、重复请求、外部失败、重试、迁移、备份恢复和上游升级。

## 2. 测试层级

| 层级 | 目标 | 建议自动化 |
| --- | --- | --- |
| Unit | 状态机、权限、计算、门禁、幂等 | Vitest/Jest，随包约定 |
| Model/Migration | Model builder、默认数据、升级和回填 | 现有 model test 工具 |
| Integration | Command、OAuth、Webhook、事件、导入 API | 服务测试 + mock provider |
| E2E | 多角色核心闭环和 UI | 沿用仓库 Playwright sanity 结构 |
| Security | OAuth、越权、注入、Secret、Webhook 签名 | 自动扫描 + 定向测试 |
| Performance | 列表、搜索、关系图、测试结果写入 | 固定数据集压测 |
| Operations | 部署、备份、恢复、升级、回滚 | 隔离自托管环境演练 |

## 3. 测试环境和基准数据

### 3.1 环境

至少准备：

- 一个与生产结构一致的 Docker Compose 环境；
- 一个允许登录的飞书测试租户和一个不允许租户；
- 一个 GitHub 测试组织、仓库和 App/Webhook；
- 6 个角色账号：Sales、Product、PM、Developer、QA、Admin，另加 Guest。

> ✅ **D8 已关闭（2026-08-26）：Kubernetes 为 V1 非目标**（PRD §2.3 已改写）。本计划**不准备 K8s 环境、不补 K8s 用例**，Operations 层（§2、§6 的 NFR-T006/T007/T008）继续只演练 Docker Compose。

### 3.2 两套基准数据集（用途不同，不得混用）

此前本节的数据规模与 PRD §8 的容量假设不一致（本节 5,000 Lead / 20,000 Work Item / 100,000 Test Result，PRD 为 5 万 Lead / 10 万 Work Item / 100 万 Test Result）。二者**不是矛盾，而是两套用途不同的数据集**，现明确区分如下：

| | **A. 功能测试基准数据集** | **B. 性能压测数据集** |
| --- | --- | --- |
| **用途** | §5 全部功能用例、§7 的 E2E 与角色矩阵；让用例可重复、可断言、跑得快 | §6 的 NFR-T001/T002/T003 性能指标验证；证明 PRD §8 容量假设下仍达标 |
| **规模依据** | 覆盖分支与边界即可，**不追求真实容量** | **必须等于或超过 PRD §8 的容量假设**，低于该规模的性能结论无效 |
| **Account / Contact / Lead** | 100 / 500 / 5,000 | ≥ 1,000 / 5,000 / **50,000** |
| **Product / Project / Cycle+Milestone / Work Item** | 10 / 50 / 100 / 20,000 | 20 / 200 / 500 / **100,000** |
| **Test Case / Plan / Run / Result** | 10,000 / 200 / 500 / 100,000 | 20,000 / 500 / 2,000 / **1,000,000** |
| **PR-Build 映射 / Product Version** | 2,000 / 100 | 10,000 / 300 |
| **活跃用户** | 7 个角色账号 | **500 活跃用户**（NFR-T003 的 100 并发在此基数上取样） |
| **运行环境** | 与生产结构一致的 Docker Compose 环境 | 独立的性能环境，资源配置按生产负载配置，**不与功能环境共用** |
| **重建方式** | 可重复的 seed 脚本，每轮功能回归前重置 | 一次性生成并固定，跨轮次复用以保证结果可比 |

规则：

- §5 与 §7 的用例**一律在数据集 A 上执行**；除 QA-T020（大型 Run 批量执行 10,000 Result）外，功能用例不得依赖 B 的规模；
- §6 的 NFR-T001/T002/T003 **一律在数据集 B 上执行**，在 A 上跑出的 p95 不作为性能验收证据；
- PRD §8 容量假设若变更，**必须同步更新 B 列**，A 列不随之变动；
- 退出标准中的「性能达到 PRD 指标」特指在 B 上取得的结果。

## 4. 进入和退出标准

### 4.1 进入标准

- PRD/Spec 对应需求 ID 已冻结；
- migration、feature flag 和回滚说明可用；
- 测试环境健康检查通过；
- 飞书/GitHub 使用测试凭据，未混用生产 Secret；
- P0 用例具备可重复测试数据。

### 4.2 退出标准

🔴 **2026-08-26 拍板：退出标准拆三档，`Deferred` 用例不计入 V1。**

| 档 | 范围 | 门槛 |
| --- | --- | --- |
| ① | **全部 P0 用例** | **100% 通过**，无例外 |
| ② | **V1 承诺的 P1**（PRD §9 已冻结清单，含被 §7 核心页面验收隐式拉入的 **REL-006、PM-009**，以及 2026-08-26 因「实施计划里已排 Task」而**拉回**的 **AUTH-006、CRM-008、REQ-006、REQ-007、DEV-006、SYS-004**） | **通过率 100%** |
| ③ | **非 V1 承诺的 P1**（**实施计划里没有对应 Task**、延期到 V1.1 / V1.2 的能力，如 PM-003 四类依赖 + Gantt、PM-008c 重复任务） | 标记 **`Deferred`**，**不计入 V1 退出标准**，在 §8 报告中**单列**，不与 ② 混算 |

⚠️ 此前的「P1 通过率不低于 98%」**已作废** —— 那个口径把 Deferred 能力和 V1 承诺能力混在同一个分母里，98% 既可能是「承诺项全过、延期项全挂」，也可能是「承诺项挂了两条」，无法作为放行依据。

其余退出条件不变：

- 无未处理 Critical/High 安全问题；
- 无数据丢失、重复转换或权限泄露；
- 性能达到 PRD 指标（在数据集 B 上取得）；
- 备份恢复和一次上游升级演练通过；
- 发布门禁和豁免审计验证通过（含**按调用者权限二次过滤**的两种角色回归，见 REL-T013）。

### 4.3 用例的 `Phase` 标记规则

§5 的每张用例表新增 **`Phase` 列**，取值 `V1` / `V1.1` / `V1.2`：

- `V1`：全部 P0 + **PRD §9 冻结清单（含 2026-08-26 拉回的 6 条）**里的 P1 → 计入退出标准 ① / ②；
- `V1.1` / `V1.2`：对应能力已延期 → 标记 `Deferred`，**本轮不执行、不计入通过率**，在 §8 报告中单列。

未标注 `Phase` 的用例默认按 `V1` 处理。

🔴 **判定规则（2026-08-26 修订，取代此前的机械推论）：**

> **一条 P1 只要在 implementation-plan 里有对应 Task 实现其核心交付物，就必须是 `V1` 并纳入退出标准 ②；反之标 `Deferred`。**

判定的唯一依据是 **PRD §9 的冻结清单**，而该清单本身已按「是否有对应 Task」逐条核对过。**本节不再由「非 V1 承诺 P1 一律 Deferred」自行推论** —— 那个推论曾把 `AUTH-006`（Task 5 Step 4 已实现）、`CRM-008`（Task 20 已实现）等 6 条标成 `Deferred`，形成「计划内做了、退出标准里不验」的矛盾。

✅ **2026-08-26 由 `Deferred` 拉回 `V1` 的 6 条**（依据见 PRD §9 冻结表的「本次拉回」标注）：

| 需求 ID | 对应 Task | 受影响用例 |
| --- | --- | --- |
| `AUTH-006` 资料同步（**V1 范围＝仅姓名**，2026-08-28 收窄） | Task 5 Step 3 + Step 4 | **AUTH-T009**（V1，姓名）；AUTH-T009b 头像、AUTH-T010 离职禁用均 **Deferred**，见 §5.1 表下说明 |
| `CRM-008` Intake 表单 | Task 20 | CRM-T011、CRM-T012、FLEX-T005 |
| `REQ-006` 需求 Roadmap / 分组视图 | Task 20、Task 8 Step 4 | —（无独立 Deferred 用例） |
| `REQ-007` 变更标记用例待复核 | Task 18a、Task 15 | —（REQ-T002 已是 P0/V1） |
| `DEV-006` CI 关联 Build/Test Run | Task 17 Step 3、Task 19 Step 2 | DEV-T007 |
| `SYS-004` 关系预览二次权限检查 | Task 3 Step 3、Task 19 Step 2 | —（SYS-T002 已是 P0/V1） |

⚠️ **维持 `Deferred` 的需求 ID**（implementation-plan 中**找不到**实现其核心交付物的 Task）：`AUTH-007`、`AUTH-008`、`CRM-007`、`CRM-009`、`REQ-008`、`PM-003`（四类依赖 + Gantt，P0 降级）、`PM-008c`（重复任务）、`PM-010`、`QA-011`、`DEV-005`、`FLEX-003`、`FLEX-004`、`FLEX-006`。

📌 **`REL-005` 与 `SYS-005` 已于 2026-08-26 由产品侧拍板拉回 `V1`**（分别由 Task 18b、Task 19a 实现），已从本清单剔除并写入 PRD §9 冻结表。

📌 **本清单由「是否有对应 Task」逐条判定，不再是机械推论。** 增删任何一条，都必须同时给出「哪个 Task 的哪一步实现它」或「确认无 Task」的依据，并同步 PRD §9 的冻结表。

✅ **已裁决 1（2026-08-26 产品侧拍板）：`REL-005` 与 `SYS-005` 拉回 `V1`。** 两者都已有 Task，留在 `Deferred` 清单里与本节自定的「有 Task 就 V1」规则冲突。

| 需求 ID | 新补的 Task | 为什么本来就该在 V1 |
| --- | --- | --- |
| `REL-005` Release Notes | **Task 18b**（implementation-plan Phase 5） | **PRD §7.5 的 Release 页面验收明确要求显示 Release Notes** —— 与 `REL-006`、`PM-009` 被 §7 核心页面验收隐式拉入 V1 是同一模式 |
| `SYS-005` 归档与恢复 | **Task 19a**（implementation-plan Phase 6） | **本计划自己有两条 P0 / V1 用例在验它**：`SYS-T004`（管理员恢复归档对象）、`CRM-T013`（有引用的 Lead 尝试物理删除应被阻止或归档）。「P0 用例在验、需求却标 Deferred」本身就是矛盾 |

按本节的判定规则，两条都从 `Deferred` 拉回 `V1` 并写入 PRD §9 冻结表。**2026-08-26 产品侧已拍板执行**，上面的 `Deferred` 清单与 PRD §9 冻结表两处已同步。

✅ **已裁决 2（2026-08-26 产品侧拍板）：`QA-T015` 改挂 `QA-006`，`QA-011` 维持 `Deferred`。**

`QA-T015`（同一用例在多环境 / Build 下执行、按环境筛选）**被标为 `V1`** —— 依据是 implementation-plan **Task 14** 明确要求它通过（Run 上下文 `build` / `environment` 等**平铺**在 TestRun 上，Task 14 原文写着「若塞进嵌套对象则本用例直接挂」）。但它在 §5.4 里**挂在 `QA-011` 需求下，而 `QA-011` 仍标 `Deferred`**（见上面的维持清单）。

于是出现「用例 `V1` / 其归属需求 `Deferred`」的矛盾。拍板结论：**归属标错了，`QA-T015` 验的是 `QA-006` 而非 `QA-011`。**

判定依据 —— `QA-006`（**P0**）的原文是「Test Run 记录 Build、Environment、执行人、起止时间和执行状态」，与 `QA-T015` 验的内容逐字对应，也正是 **Task 14** 落地的那组扁平字段（`build` / `environment` / `executedBy` / `startedOn` / `finishedOn`）。而 `QA-011` 的真实交付物是**重复用例、批量选择、参数化数据、环境模板**四项，其中没有一项由任何 Task 实现。

因此：`QA-T015` 归属改为 `QA-006`（P0 / V1），`QA-011` **维持 `Deferred`** 且清单不变。此改动**不产生任何范围变动**，只修正一处标注错误。

## 5. 功能测试用例

步骤中的“创建/打开/提交”均需验证 UI 反馈、持久化结果、Activity/Audit 和刷新后状态。

### 5.1 飞书认证与账号

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| AUTH-T001 | P0 | V1 | 合法租户、未绑定成员、允许自动开户 | 点击飞书登录并授权 | 创建唯一 Huly 账号，绑定 tenant/open_id，进入指定工作区 |
| AUTH-T002 | P0 | V1 | 已绑定成员 | 再次飞书登录 | 进入原账号，不创建重复账号 |
| AUTH-T003 | P0 | V1 | 非允许租户 | 完成飞书授权 | 拒绝登录，显示租户不允许，审计记录不含 token |
| AUTH-T004 | P0 | V1 | OAuth state 被修改 | 调用回调 | 拒绝请求，不发放 Huly token |
| AUTH-T005 | P0 | V1 | 同一 code 已使用 | 重放回调 | 第二次失败，不产生额外 session/账号 |
| AUTH-T006 | P0 | V1 | 自动开户关闭、成员未邀请 | 登录 | 给出联系管理员提示，不自动加入工作区 |
| AUTH-T007 | P0 | V1 | 已有同邮箱本地账号但未绑定 | 飞书首次登录 | 不静默合并；进入确认/管理员审批流程 |
| AUTH-T008 | P0 | V1 | 飞书服务不可用 | 登录 | 显示可恢复错误；本地管理员仍能登录 |
| AUTH-T009 | P1 | V1 | 资料同步开启（`FEISHU_SYNC_PROFILE=true`） | 飞书更改**姓名**后登录 | 更新展示姓名，写审计事件，不改变对象所有权；飞书未返回姓名时**保留原姓名而不清空**；同步失败**不阻断登录** |
| AUTH-T009b | P1 | **Deferred** | 资料同步开启 | 飞书更改**头像**后登录 | 头像同步 —— **V1 不实现**，见下方说明 |
| AUTH-T010 | P1 | **Deferred** | 成员离职事件或同步结果 | 执行同步 | 按策略禁用登录，历史 Activity 保留 —— **V1 不实现**，见下方说明 |
| AUTH-T011 | P0 | V1 | 普通用户 | 尝试修改飞书 Provider 配置 | 拒绝并记录安全审计 |
| AUTH-T012 | P0 | V1 | 日志采集开启 | 执行成功和失败登录 | 日志无 client secret、code、access/refresh token |
| AUTH-T013 | P0 | V1 | 已绑定成员，其 `union_id` 由空变为有值（或飞书侧发生变更） | 执行受控 `union_id` 迁移 | 绑定主键仍为 `tenant_key + open_id`，`union_id` 仅作辅助标识被更新；不新建账号、不改变对象所有权；迁移前后可回滚；迁移动作写入审计 |
| AUTH-T014 | P0 | V1 | 已绑定成员 | 管理员执行身份解绑 | 解绑成功且账号与历史 Activity 保留；审计记录操作人、时间、被解绑身份、前后绑定状态和 correlation id；解绑后该飞书身份再次登录按未绑定流程处理，不静默重绑 |
| AUTH-T015 | P0 | V1 | 已有角色的成员 | 管理员变更其角色（含降权与撤销） | 权限即时生效；审计记录操作人、时间、对象、变更前后角色；被降权用户对原可见对象的访问立即被拒绝，不依赖重新登录 |
| AUTH-T016 | P0 | V1 | 飞书 Provider 配置损坏或全部管理员的飞书身份不可用 | 执行本地管理员恢复流程 | 按文档化步骤可通过本地超级管理员入口登录并恢复配置；恢复入口不可被飞书配置关闭；整个恢复过程写入审计且不打印 Secret |

> 🔴 **AUTH-T009 / T010 的范围更正（2026-08-28，实现后核对）。**
> 原来的 `AUTH-T009`（姓名/头像）与 `AUTH-T010`（离职禁用）**按当前实现无法通过**，
> 而它们是 `V1` 档、退出标准要求**通过率 100%** —— 也就是说不改就会直接卡住 V1 验收。
>
> - **头像（拆出为 `AUTH-T009b`，Deferred）**：account DB 的 `Person` 只有
>   `{uuid, firstName, lastName}`，没有头像字段；头像挂在各 workspace 的 `contact:class:Person`
>   上，写它需要 transactor client，不在 account 服务能力范围内。头像 URL 已被解析并记入审计事件，
>   V1.1 做写入通道时可直接消费。
> - **在职状态（`AUTH-T010`，Deferred）**：飞书 `/authen/v1/user_info` **不返回**在职状态，
>   要改用 `/open-apis/contact/v3/users/:id` + `tenant_access_token`（第二套凭证流程），
>   且 account DB 同样无处存放。**整条用例在 V1 无法执行，不是「跑了没过」而是「跑不了」。**
>
> ⚠️ **一个尚未核实的兜底论据，不要当成已验证**：有观点认为「离职/冻结的成员过不了飞书自己的
> 授权，所以登录路径天然被挡」。**这条没有对飞书侧行为做过核实**，不足以替代 `AUTH-T010`。
> 若要靠它，必须先在真实租户上验证「冻结成员发起授权会被拒」，验证通过后才可把
> `AUTH-T010` 改写成对该行为的断言。
>
> 📌 **这改变了 V1 退出标准的范围，属产品决策**：`AUTH-006` 的验收从「四个字段」收窄为
> 「姓名 + 失败不阻断登录」。PRD §9 的 AUTH-006 行与 implementation-plan Task 5 Step 4 已同步更正。

### 5.2 CRM 与线索转换

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| CRM-T001 | P0 | V1 | Sales 登录 | 创建含必填字段的 Lead | Lead 创建成功并出现在表格/看板 |
| CRM-T002 | P0 | V1 | Sales 登录 | 缺少 Account/Contact 或下一步动作提交 | 阻止提交并定位必填字段 |
| CRM-T003 | P0 | V1 | 已有 Lead（载体为 `card.Card`，看板复用上游 `task.viewlet.Kanban`，D1 已关闭） | 拖动 Kanban 状态（含拖入赢单 / 丢单列） | 状态和 Activity 更新，刷新后保持。🔴 **不验「完成栏 / 拖到完成区」交互** —— V1 明确不做完成栏，赢单/丢单是普通状态列；看板上出现空的完成条视为**已知退化**（`KanbanDragDone.svelte:33` 查 `task.class.Project`），不判失败 |
| CRM-T004 | P0 | V1 | Lead 处于 Qualifying | 转换并选择产品、项目和负责人 | 创建 Requirement、Trace Link，Lead 变 Converted |
| CRM-T005 | P0 | V1 | CRM-T004 完成 | 重复点击或重放相同 idempotency key | 返回同一 Requirement，无重复对象/关系/通知 |
| CRM-T006 | P0 | V1 | 并发客户端 | 同时转换同一 Lead | 只产生一个 Requirement，另一请求返回既有结果 |
| CRM-T007 | P0 | V1 | Lead 已转换 | 打开 Lead | 显示唯一 Requirement 和下游状态 |
| CRM-T008 | P0 | V1 | Lead 有评论/附件 | 转需求 | 来源保留；按规则链接附件，不静默丢失 |
| CRM-T009 | P1 | **V1.1** `Deferred` | 相似客户已存在 | 新建 Account/Lead | 给出重复提示但不错误合并 |
| CRM-T010 | P0 | V1 | Developer 权限受限 | 打开含敏感字段的 Lead 关系 | 只显示允许字段，不泄露敏感信息 |
| CRM-T011 | P1 | V1 | Intake 表单启用 | 外部提交有效表单 | 创建待分流 Lead，记录来源和反滥用结果 |
| CRM-T012 | P1 | V1 | Intake 表单 | 重复/恶意高频提交 | 触发限流或反滥用，不污染主列表 |
| CRM-T013 | P0 | V1 | Lead 关联 Requirement | 尝试物理删除 Lead | 默认归档或阻止；关系仍可追溯 |
| CRM-T014 | P1 | **V1.1** `Deferred` | 多个 Lead 关联客户 | 打开 Account | 汇总线索、需求、Bug、版本且遵循权限 |

### 5.3 需求与项目管理

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| REQ-T001 | P0 | V1 | Product 登录 | 创建 Requirement 并填写验收标准 | 保存版本化正文和初始版本。🔴 **变更历史只验字段级 Activity 流**（谁在何时改了哪个字段）；**不验跨版本正文 diff、不验旧版本全文检索** —— 两者 V1 明确不做（PRD REQ-001、Technical Spec §3.3.2） |
| REQ-T002 | P0 | V1 | Requirement Approved | 修改验收标准 | 产生新版本并标记关联 Test Case 待复核 |
| REQ-T003 | P0 | V1 | Requirement Approved | 拆分 Story/Task/Bug | 创建 Work Item 和 implements 关系 |
| REQ-T004 | P0 | V1 | 多个来源 Lead | 关联同一 Requirement | 所有来源可查询，计数与关系一致 |
| REQ-T005 | P0 | V1 | 未评审 Requirement | 尝试进入 `InDelivery`（显示文案 In Delivery） | 按工作流拒绝或要求审批 |
| PM-T001 | P0 | V1 | PM 登录 | 创建 Project、Component、Milestone | 对象在项目导航和筛选中可见 |
| PM-T002 | P0 | V1 | 已有父任务 | 创建多级子任务 | 父子层级、汇总和导航正确 |
| PM-T003 | P0 | **V1.1** `Deferred` | 两个 Issue。🔴 **更正：这不是复用验证。** `IssueRelation` 是上游为尚未落地的 Gantt 预留的**死 schema**（模型类有声明，但全仓 `addCollection(IssueRelation)` 零命中，从未被挂成集合），四类依赖 + `lag` 属于从零实现，**PM-003 已随 PM-005 的 Gantt 一并降级 V1.1** | 逐一配置 `finish-to-start`、`start-to-start`、`finish-to-finish`、`start-to-finish` 四类依赖，并分别设置 `lag` 为正值、0 和负值（overlap） | 四类依赖均可在 UI 配置；Gantt 正确展示依赖类型、`lag` 与日期级联（cascade scheduling）影响；负 lag 表现为重叠；依赖类型与 lag 持久化后刷新不丢失 |
| PM-T003a | P0 | V1 | 两个 Issue（V1 只有 `Issue.blockedBy` / `Issue.relations` 两个 `RelatedDocument[]` 数组，无依赖类型、无 lag） | 建立阻塞与关联关系，双向查看并解除 | 阻塞/关联关系双向可见、可解除、刷新后保持；不出现依赖类型或 lag 输入项（V1 不承诺） |
| PM-T004 | P0 | V1 | 依赖图 | 创建循环依赖 | 阻止并说明冲突链路 |
| PM-T005 | P0 | V1 | Project 有 Issue | 创建 Cycle 并加入 Issue | Cycle 范围、容量和 Issue 反向关系正确 |
| PM-T006 | P0 | V1 | Active Cycle | 完成 Cycle 并选择 rollover | 完成项保留；未完成项按策略滚动且有 Activity |
| PM-T007 | P1 | V1 | Cycle 有历史数据 | 查看燃尽和速度 | 使用快照计算，结果与 Issue 历史一致 |
| PM-T008 | P0 | V1 | Issue 有估时 | 填报工时 | reported/remaining 正确，权限和日期规则生效 |
| PM-T009 | P0 | V1 | 同一项目数据 | 切换 List/Kanban/Calendar（**Gantt 已推 V1.1**，不在本轮范围） | 视图展示同一对象，不复制或丢失更新 |
| PM-T010 | P1 | V1 | 已保存筛选 | 创建 Saved View 并共享 | 个人/共享权限正确，字段和排序保持 |
| PM-T011 | P0 | V1 | Guest 仅获一个项目 | 全局搜索和关系跳转 | 只返回授权项目对象 |
| PM-T012 | P1 | V1 | 项目存在阻塞/延迟/失败测试 | 打开项目概览 | 风险和质量摘要与明细一致 |

### 5.4 测试资产和执行

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| QA-T001 | P0 | V1 | QA 登录 | 创建 Test Suite 和子 Suite | 层级、排序和 Test Case 计数正确 |
| QA-T002 | P0 | V1 | Suite 已存在 | 创建含前置条件和 3 个步骤的 Case | 步骤顺序、数据和预期结果持久化 |
| QA-T003 | P0 | V1 | Test Case `Draft`（审核状态枚举 `TestCaseStatus` 为**上游既有能力**，本用例验证复用而非新实现） | 依次提交审核（`ReadyForReview`）、打回（`FixReviewComments`）、批准（`Approved`）、驳回（`Rejected`） | 状态按规则推进，非法迁移被拒绝；审核人和时间写入审计 |
| QA-T004 | P0 | V1 | Test Case Approved | 修改步骤 | 新增版本；历史 Test Run 仍显示旧快照 |
| QA-T005 | P0 | V1 | Requirement、Case 已存在 | 建立 verifies 关系 | 双向可见，覆盖率重新计算 |
| QA-T006 | P0 | V1 | Requirement 无 Case | 查看覆盖率 | 显示未覆盖且可快速创建/关联 Case |
| QA-T007 | P0 | V1 | 多版本 Case | 创建 Test Plan | Plan Item 固定所选版本 |
| QA-T008 | P0 | V1 | Plan、Build、Environment 已存在 | 创建并开始 Test Run | Run 保存完整上下文和执行人 |
| QA-T009 | P0 | V1 | Run 中 Case | 标记 Passed 并填写实际结果 | Result 保存，进度和统计更新 |
| QA-T010 | P0 | V1 | Run 中 Case | 标记 Failed、上传日志/截图 | Result 保存失败上下文，通知负责人 |
| QA-T011 | P0 | V1 | Failed Result | 一键创建 Bug | Bug 自动含复现/预期/实际/Build/Environment/附件和 Trace Link |
| QA-T012 | P0 | V1 | QA-T011 完成 | 重复创建 Bug | 打开已有 Bug 或明确允许另建；默认不重复 |
| QA-T013 | P0 | V1 | Bug 已修复 | 创建回归 Run 并执行 Passed | 历史失败保留，新结果关联 Bug 和修复版本 |
| QA-T014 | P0 | V1 | Result Blocked | 填写阻塞原因 | 原因必填，统计归入 Blocked，不误算 Failed |
| QA-T015 | P1 | V1 | 多环境/Build | 对同一 Case 多次执行 | 各 Result 隔离且可按环境/Build 筛选。📌 **本用例按「有 Task 就 V1」判定为 V1**：Task 14 已把 Run 上下文（`build` / `environment` 等）**平铺**在 TestRun 上，并明确「若塞进嵌套对象则本用例直接挂」，即该能力在 V1 交付。归属需求为 `QA-006`（P0，Test Run 记录 Build/Environment/执行人/起止时间/执行状态）—— ✅ **归属已于 2026-08-26 拍板修正**（原误挂 `QA-011`），见 §4.3「已裁决 2」 |
| QA-T016 | P1 | V1 | 结果导入 token | 导入有效 JSON/JUnit | 匹配 Case、Build、Run，状态和日志正确 |
| QA-T017 | P1 | V1 | 相同 pipeline id | 重复导入 | 幂等，无重复 Result |
| QA-T018 | P1 | V1 | 未知 Case key | 导入 | 进入待映射，不批量静默创建 Case |
| QA-T019 | P0 | V1 | Developer 只读测试资产 | 尝试改 Approved Case | 拒绝；允许按权限查看和从失败创建缺陷 |
| QA-T021 | P0 | V1 | Run 中 Case（`TestRunStatus` 末尾已追加 `Skipped = 4`） | 标记 Skipped 并填写跳过原因 | Result 状态为 `Skipped`；统计中既不计入 Passed 也不计入 Failed，通过率分母按既定口径处理；发布门禁把 Skipped 当作「未通过」而非「通过」；升级前已存在的 `Untested/Blocked/Passed/Failed` Result 取值不变（**零迁移**，不配空 migration） |
| QA-T021a | P0 | V1 | 一个 Test Run 内**全部** Result 标记为 `Skipped` | 打开 Run 进度与统计 | 🔴 **必须断言 `total ≠ 0`、进度不为 0%。** `getTestRunStats` 是四个硬编码查询（Untested/Blocked/Passed/Failed），Skipped 既不进 total 也不进任何桶，**不改就会静默算出 `total = 0`、进度 0% 且不报错**。本用例专治该静默数据错误 |
| QA-T022 | P0 | V1 | 已被 Test Plan / Test Run 引用的 Test Case | 尝试通过任意路径修改其 `TestCaseSnapshot` | 服务端 middleware **拒绝一切修改**（update / remove）；历史 Run 读到的步骤/预期内容与创建时完全一致；同一 `(用例, 版本)` 全库只有一份快照 |
| QA-T023 | P0 | V1 | 某附件被至少一个 `TestCaseSnapshot` 引用 | 尝试删除该附件 | 删除被拒绝，提示该附件被 N 个测试快照引用；快照只存元数据 + blob id，不复制 blob |
| QA-T020 | P1 | V1 | 大型 Run | 批量执行/筛选 10,000 Result | 进度准确，页面和写入达到性能指标 |

### 5.5 GitHub、CI 与发布

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| DEV-T001 | P0 | V1 | GitHub 已连接 | 将 PR 关联 Work Item | Work Item 显示 PR、分支、Review、Checks |
| DEV-T002 | P0 | V1 | 相同 webhook event | 重复投递 | 只处理一次，无重复 Activity/关系 |
| DEV-T003 | P0 | V1 | Webhook 乱序 | 先投递 merged 再投递 opened | 最终状态保持 merged，不回退 |
| DEV-T004 | P0 | V1 | GitHub 暂时失败 | 触发同步 | 进入重试并显示 Pending/Failed，不静默成功 |
| DEV-T005 | P0 | V1 | 达到重试阈值 | 查看管理页并人工重放 | DeadLetter 可见，重放成功且审计 |
| DEV-T006 | P0 | V1 | PR 合并但必需测试失败 | 接收 merged 事件 | 可推进开发状态，但不得越过发布门禁 |
| DEV-T007 | P1 | V1 | CI 失败 | 接收 check run | 关联 Build/Test Run 并通知负责人 |
| REL-T001 | P0 | V1 | Product Version 有完整范围 | 打开 Release Readiness | 汇总需求、任务、测试、缺陷、PR 和审批 |
| REL-T002 | P0 | V1 | 存在必需测试失败 | 尝试 Release | 阻止并列出准确失败项 |
| REL-T003 | P0 | V1 | 存在未关闭 P0 Bug | 尝试 Release | 阻止并提供 Bug 链接 |
| REL-T004 | P0 | V1 | 所有门禁通过 | 发布 Product Version | 状态 Released，需求/Lead/Account 回写 |
| REL-T005 | P0 | V1 | 重复发布 command | 使用相同 idempotency key 重放 | 返回同一发布结果，无重复通知/版本 |
| REL-T006 | P1 | V1 | Admin 有豁免权限 | 带原因和审批执行门禁豁免 | 发布可继续，豁免完整审计并出现在报告 |
| REL-T007 | P1 | **V1.1** `Deferred` | Version 已发布 | 生成 Release Notes | 按需求/改进/Bug 分类且可编辑 |
| REL-T009 | P0 | V1 | 范围内存在未合并 PR | 尝试 Release | 阻止并逐条列出未合并 PR 及其关联 Work Item；PR 全部合并后重新计算门禁即可放行 |
| REL-T010 | P0 | V1 | 范围内存在失败或未完成的 CI check | 尝试 Release | 阻止并列出失败 check 及其 Build/Test Run 关联；不得因 UI 缓存显示为通过 |
| REL-T011 | P0 | V1 | 门禁要求的审批尚未完成 | 尝试 Release | 阻止并显示缺失的审批角色与人；补齐审批后放行，审批人/时间进入审计 |
| REL-T012 | P0 | V1 | Product Version 处于 `Planning` | 依次推进 `Planning → Active → ReleaseCandidate → Released → Archived` | 每步迁移合法且写入 Activity；非法跳转（如 `Planning` 直接到 `Released`、`Archived` 回退到 `Active`）被拒绝并说明原因；`Released` 之前必须通过全部门禁；上游既有 `Active/Released` 数据在扩展状态后语义不变 |
| REL-T013 | P0 | V1 | 同时存在多类门禁失败（失败测试 + 未关闭 P0 Bug + 未合并 PR + 失败 CI + 缺审批） | 打开 Release Readiness 并尝试 Release | **一次性列出全部失败项**，不是只报第一项；每项可点击跳转到对应对象；修复任意一项后其余项状态不被误清空 |
| REL-T014 | P0 | V1 | 阻断项分布在调用者**无权访问**的项目/空间中 | 以有权与无权两种角色分别打开 Release Readiness 并尝试 Release | **判定一致**：两种角色都被阻止发布（判定用全局视图，无权角色不得漏判）；**回显不同**：无权角色只看到「未通过：存在受限范围内的阻断项」，**不含数量、标题、严重度、负责人**（跨空间侧信道泄露） |
| REL-T015 | P0 | V1 | 存在一个 `Active` 的父版本 | 在其下创建子版本 | 🔴 父版本被置为 Frozen/`Archived`，**绝不能被置为 `Released`** —— 上游 `CreateProductVersion.svelte:106-111` 的原行为可绕过发布门禁直接发版，REL-003 形同虚设。发版路径只有 `ReleaseProductVersion` command 一条 |
| REL-T008 | P0 | V1 | 普通 Developer | 尝试豁免门禁 | 拒绝并记录安全事件 |

### 5.6 灵活视图、自动化和审计

| ID | P | Phase | 前置条件 | 步骤 | 预期结果 |
| --- | --- | --- | --- | --- | --- |
| FLEX-T001 | P1 | V1 | Admin 登录 | 为 Lead 创建合法自定义字段 | 字段出现在允许视图和表单，已有数据不丢失 |
| FLEX-T002 | P1 | V1 | 核心状态字段 | 尝试删除或改为不兼容类型 | 阻止并说明影响 |
| FLEX-T003 | P1 | **V1.1** `Deferred` | 有关系字段 | 创建 Lookup | 结果只读，关系变化后正确更新 |
| FLEX-T004 | P1 | **V1.1** `Deferred` | Formula DSL | 输入任意 JS/危险表达式 | 拒绝，不在服务端执行任意代码 |
| FLEX-T005 | P1 | V1 | Intake Form | 提交只读/隐藏字段 | 服务端忽略或拒绝，不能越权写入 |
| FLEX-T006 | P1 | **V1.1** `Deferred` | 自动化已配置 | 触发条件两次投递 | 动作幂等，执行日志可查 |
| FLEX-T007 | P1 | **V1.1** `Deferred` | 自动化动作会越过门禁 | 触发 | 拒绝高风险动作并记录原因 |
| SYS-T001 | P0 | V1 | 多模块对象 | 全局搜索关键词 | 返回授权的 CRM/需求/Issue/Test/Release 结果 |
| SYS-T002 | P0 | V1 | 受限对象存在关系 | 无权用户查看关系 | 不显示标题、标识、人员、状态或敏感计数 |
| SYS-T003 | P0 | V1 | 执行状态/权限/发布操作 | 查看 Audit | 操作人、时间、对象、前后状态和 correlation id 完整 |
| SYS-T004 | P0 | V1 | 对象已归档 | Admin 恢复 | 对象及关系恢复，不生成重复对象 |
| SYS-T005 | P0 | V1 | 用户 A 被指派 Work Item / Requirement / Test Case | 执行指派 | 被指派人 Inbox 收到条目，含对象类型、标题、指派人与跳转链接；本人自指派按配置不重复打扰；无权用户不收到 |
| SYS-T006 | P0 | V1 | 评论中 @提及用户 A | 提交评论 | A 的 Inbox 出现提及条目并可跳转到该评论位置；对 A 无权限的对象**不产生条目、也不泄露标题** |
| SYS-T007 | P0 | V1 | Requirement 进入评审、Test Case 提交审核 | 触发评审请求 | 指定评审人 Inbox 收到评审待办；评审完成后条目自动置为已处理，不留悬空待办 |
| SYS-T008 | P0 | V1 | Test Run 中出现 Failed Result | 标记失败 | 用例负责人与 Run 执行人 Inbox 收到测试失败条目，含 Run/Case/Build/Environment 上下文与跳转链接 |
| SYS-T009 | P0 | V1 | Release 门禁失败（任一类：失败测试 / 未关闭 P0 Bug / 未合并 PR / 失败 CI / 缺审批） | 尝试 Release | 版本负责人 Inbox 收到门禁失败条目并列明失败原因；同一次失败重复计算不产生重复条目 |
| SYS-T010 | P0 | V1 | GitHub / 飞书同步失败并进入重试或 DeadLetter | 触发同步失败 | 管理员（及对象负责人）Inbox 收到同步失败条目，含失败原因与人工重试入口；重试成功后条目关闭；重复投递同一失败事件不产生重复条目 |
| SYS-T011 | P0 | V1 | 上述各类 Inbox 条目已产生 | 检查 Inbox 汇总与权限 | Inbox 只显示用户有权查看的对象；无权对象既不出现条目也不计入未读数（避免侧信道泄漏）；已读/已处理状态刷新后保持 |

## 6. 非功能与运维用例

| ID | P | 场景 | 验证 |
| --- | --- | --- | --- |
| NFR-T001 | P0 | 常用列表/详情基准负载 | p95 < 2 秒 |
| NFR-T002 | P0 | 全局搜索基准负载 | p95 < 3 秒，权限结果正确 |
| NFR-T003 | P0 | 100 并发用户执行常见读写 | 无数据损坏，错误率达到发布阈值 |
| NFR-T004 | P0 | Redpanda/外部 API 短暂中断 | 业务写入可恢复，事件最终处理或进入可见 DeadLetter |
| NFR-T005 | P0 | MinIO/附件暂时不可用 | 主对象不错误标记附件成功，恢复后可重试 |
| NFR-T006 | P0 | 全量备份后灾难恢复 | 工作区、关系、附件、搜索重建和账号登录恢复 |
| NFR-T007 | P0 | 从指定上游基线升级 | migration 可重复，数据量和关键关系对账一致 |
| NFR-T008 | P0 | migration 中断后重启 | 从安全点继续，不重复创建默认数据 |
| NFR-T009 | P0 | Secret 扫描和日志检查 | 仓库、镜像层和日志无飞书/GitHub/数据库 Secret |
| NFR-T010 | P0 | Webhook 伪造/签名错误 | 拒绝，无业务副作用 |
| NFR-T011 | P1 | 中文/英文切换 | 新增核心页面无硬编码、缺失 key 或布局破坏 |
| NFR-T012 | P1 | 键盘操作核心表单/看板 | 可完成主要操作，错误有文本提示 |
| NFR-T013 | P0 | 自建 Kafka 消费者收到一条**毒消息**（handler 必然抛错） | 消费**继续前进**，不在该消息上原地无限重试。🔴 上游消费者是无限原地重试（不 commit offset 也不跳过），一条毒消息会**永久卡死整个 partition**，且表现为「消息不再前进」而非报错退出。handler 必须自行 try/catch 并做出明确处置 |
| NFR-T014 | P0 | 存在已保存的筛选视图（其 JSON 中固化了枚举值） | 执行含枚举变更的升级后，视图筛选结果仍然正确。🔴 枚举**只允许末尾追加**；修改或删除既有值会让已保存视图**静默失效且不报错**（筛出 0 条，用户以为没数据），必须配套扫描迁移 |

### 6.1 独立风险项（不属于任何单个 Task，单独立项跟踪）

**R-PG-INDEX：PG 上 `@Index` 不产生索引。**

- **事实**：PG 适配器的 `createIndex` 是**空实现**；`test-management` 走 `defaultSchema`（只有基础列和 `attachedTo` 是真实列）。因此 `@Index` 装饰器在 PG 上**不产生任何索引**。
- **威胁**：PRD §8 的「100 万 Test Result」容量假设、**QA-T020**（1 万 Result 批量执行的性能指标）、以及所有依赖 `attachedTo` 以外字段做筛选/排序的列表查询。
- **性质**：**全平台问题**，不是 Agentra 引入的，也不由某个 Task 顺手承担。
- **处置**：在数据集 B 上实测确认影响面（NFR-T001/T002 + QA-T020），据实测结果决定是否需要 fork 侧补索引；结论写进 §8 发布报告的风险节。
- **未闭环前**：PRD §8 的容量假设与 QA-T020 的性能结论均标注「索引前提未验证」。

## 7. 自动化覆盖映射

| 测试集合 | 必须自动化的用例 |
| --- | --- |
| Unit | 状态机（含 `TestRunStatus` 含 `Skipped` 的统计口径、**`getTestRunStats` 的 total 必须包含 Skipped**、ProductVersion 状态迁移合法性且**不得用枚举数值大小判断**）、Trace Link 校验（**六种 kind，`blocks` 已删除**）、**TraceLink 版本继承规则（`verifies`/`delivered-in` 不继承）**、门禁、权限、Cycle 统计、公式 DSL、**确定性 `_id` claim 的幂等键（24 位小写 hex）** |
| Model/Migration | 新模型注册、`dev/prod` **与 `desktop`** 注册项存在性检查、默认配置、Case 版本快照、`TestRunStatus` **末尾追加后既有取值不变**、`ProductVersionState` **末尾追加后既有取值不变**、products `enabled: true` 生效、重复 migration |
| Integration | AUTH-T001–T008、**AUTH-T011–T016**、CRM-T004–T006、QA-T011–T018、**QA-T021、QA-T021a、QA-T022、QA-T023**、DEV-T002–T005、REL-T002–T006、**REL-T009–T015（发布 Readiness 全量门禁矩阵 + 权限二次过滤 + 子版本不得置父版本为 Released）**、**SYS-T005–T011（Inbox 全量）**、**NFR-T013（Kafka 毒消息）** |
| E2E smoke | AUTH-T001、CRM-T004、REQ-T003、PM-T005、**PM-T003a**、QA-T011、DEV-T001、REL-T004、**SYS-T001** |
| E2E role matrix | CRM-T010、PM-T011、QA-T019、REL-T008、SYS-T002、**SYS-T003**、**SYS-T011** |
| Operations | NFR-T004–T010 |

> 补充说明：此前本表遗漏了若干 P0，现已补入（加粗项）——AUTH-T011/T012（Provider 配置越权、日志脱敏）、AUTH-T013–T016（`union_id` 迁移、解绑审计、角色变动审计、本地管理员恢复）、SYS-T001（全局搜索）、SYS-T003（审计完整性）、SYS-T005–T011（Inbox）、REL-T009–T015（发布 Readiness 全量 + 权限二次过滤 + 子版本门禁绕过）、QA-T021/T021a/T022/T023（`Skipped` 统计口径与快照不可变）、PM-T003a（V1 的阻塞/关联数组）、NFR-T013/T014（Kafka 毒消息、枚举变更让已保存视图静默失效）。
>
> **规则：§5 中标记为 P0 且 `Phase = V1` 的用例必须在本表中至少出现一次**；新增此类用例时同步更新本表，否则视为覆盖缺口。标记为 `Deferred` 的用例（如 PM-T003）本轮不执行，**从本表的必跑集合中移出**，待对应版本再纳入。

## 8. 发布测试报告模板

每个 Release Candidate 必须记录：

- 上游 commit、fork commit、镜像 digest 和 migration version；
- 测试环境、数据规模、浏览器和部署拓扑；
- 🔴 **按 `Phase × 优先级` 二维统计**通过、失败、阻塞、跳过数量（不再只按优先级一维汇总）。🔴 **`Phase` 的判定口径（2026-08-26 修订）**：`V1` = 全部 P0 + **PRD §9 冻结清单**里的 P1；该清单以「implementation-plan 里是否有对应 Task 实现其核心交付物」逐条判定，**不再由「非 V1 承诺 P1 一律 Deferred」机械推论**（详见 §4.3）。因此 **AUTH-006、CRM-008、REQ-006、REQ-007、DEV-006、SYS-004** 及其用例计入 V1 行，不再落进 `Deferred` 行：

  | | P0 | P1 | P2 |
  | --- | --- | --- | --- |
  | **V1**（计入退出标准 ①②） | 通过/失败/阻塞/跳过 | 通过/失败/阻塞/跳过 | — |
  | **V1.1** `Deferred`（不计入退出标准） | — | 单列 | 单列 |
  | **V1.2** `Deferred`（不计入退出标准） | — | 单列 | 单列 |

  `Deferred` 行**绝不能与 V1 行合并计算通过率**；报告必须能一眼看出「V1 承诺范围内是否 100% 通过」。
  📌 报告中还须列出**当轮 `Deferred` 的需求 ID 全集**（§4.3 的维持清单）及各自「无对应 Task」的确认，避免下一轮又把它们当成漏测。
- 追溯完整率的计算口径（**当前版本口径**）与 `fixed-by` / `delivered-in` 两类边的落地状态——**这两类边未落地时该指标标注「无法验收」，不得填写百分比**；
- **独立风险项 R-PG-INDEX**（§6.1）的实测结论；
- 未关闭缺陷及风险接受人；
- 性能结果、备份恢复结果和安全检查结果；
- GitHub/飞书合同测试时间；
- 最终 Go/No-Go 决策和审批人。
