---
name: agentra-testcases
description: >-
  Agentra 测试项目与测试用例的查询与读写：agentra test-project list、agentra case
  list/get/create/update。用户要查测试项目/套件、搜用例、读用例步骤、建用例、改用例
  状态/优先级/自动化 key 时用本 skill。不负责 issue（那是 agentra-issues）。
metadata:
  cliVersion: ">=0.1.0"
---

# agentra-testcases

> **前置条件：** 先阅读 [`../agentra-shared/SKILL.md`](../agentra-shared/SKILL.md)，
> 确认已 `agentra auth login`。

## 职责边界

| 做 | 不做 |
|---|---|
| 测试项目/套件列表、用例的搜索/读取/创建/更新 | issue（用 `agentra-issues`） |
| 用例步骤的读取 | 建套件、建测试项目、跑测试、回填测试结果 |
| 自动化 key 的查询与写入 | 删除用例（CLI 不提供，请到界面操作） |

## 命令

```bash
agentra test-project list            # 项目 + 套件数
agentra test-project list --json     # 带完整套件名列表

# 搜索；过滤条件都可选，按 AND 组合
agentra case list --project Plaud --suite 后台-保存发布
agentra case list --project Plaud --automation-key BE-TC-019 --json
agentra case list --project Plaud --status Draft --limit 200

# 读一条，含步骤与前置条件
agentra case get 6a94fe7a35230d667fe971f8

# 建一条（套件必须已存在），打印新 id
agentra case create --project Plaud --suite 后台-保存发布 \
  --name '验证配置保存后可回显' --priority High --automation-key BE-TC-020

# 改；未传的字段原样保留
agentra case update 6a94fe7a35230d667fe971f8 --status Approved
```

取值范围：
- `--type`：`Functional` `Performance` `Regression` `Security` `Smoke` `Usability`
- `--priority`：`Low` `Medium` `High` `Urgent`
- `--status`：`Draft` `ReadyForReview` `FixReviewComments` `Approved` `Rejected`

## 三个会咬人的地方

1. **`test-project list` 返回空不代表没有项目。** Huly 按 `members` 严格过滤空间，
   空列表同样可能是"你不是成员"。报告时要说清是哪一种，不要说成"工作区里没有测试项目"。

2. **套件名只在项目内唯一。** `section1-前台` 在多个项目里都存在。
   `--suite` 一定要配 `--project`，否则解析到的可能是另一个项目的同名套件。

3. **`create` 不会建套件。** 套件必须已存在，否则报错并列出该项目下的可选套件。
   建套件请到界面操作。

## 层级：为什么界面上看着是空的

导入进来的用例挂在**二级叶子套件**上，根节点（`plaud-测试用例` 这类）本身不挂任何用例。
界面列表按 `attachedTo` **精确匹配、不展开后代**，所以点根节点会看到空列表。

CLI 没有这个问题——`case list --project X` 不带 `--suite` 时查的是整个项目。
所以**当有人说"界面上是空的"时，先用 CLI 查一遍**：查得到就是显示层的问题，不是数据丢了。
