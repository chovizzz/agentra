# Agentra 模块落地 checklist

每新增一个 Agentra 领域模块（`agentra-<domain>`），**必须**逐项走完下面 **7 处主链路注册
（第 1–7 节）+ 4 处镜像宿主注册（第 8 节）**。
只改 `rush.json` + `models/all` 会得到「TypeScript 编译通过、`rush build` 全绿、
但功能在运行时完全加载不出来」——平台不是靠包存在来加载插件的，靠的是
`addLocation` / `addStringsLoader` 这两张显式注册表。

参考实现：`agentra-core` 骨架包族（本仓库内，无业务语义，可直接照抄形状）。

```
plugins/agentra-core                    @hcengineering/agentra-core
plugins/agentra-core-resources          @hcengineering/agentra-core-resources
plugins/agentra-core-assets             @hcengineering/agentra-core-assets
models/agentra-core                     @hcengineering/model-agentra-core
server-plugins/agentra-core             @hcengineering/server-agentra-core
server-plugins/agentra-core-resources   @hcengineering/server-agentra-core-resources
models/server-agentra-core              @hcengineering/model-server-agentra-core
```

> 包名一律用 `@hcengineering/` 前缀（仓库现有约定，改前缀会同时打断 rig 解析和
> workspace 协议解析），`shouldPublish: false`。

---

## 1. `rush.json` — 注册 7 个 projectFolder

**改哪个文件**：`rush.json` 的 `projects` 数组。

**加什么**：7 个条目，每个 `{ packageName, projectFolder, shouldPublish: false }`。
按模块族成块追加（该数组是按模块族分组的，不是字母序）。

**漏了会怎样**：`rush install` / `rush update` 根本不认识这个目录，
`node_modules` 不会被链接，`workspace:^` 依赖解析失败，
`rushx` 在该目录下无法运行。这一条漏掉是**编译期**就炸，反而是最容易发现的。

---

## 2. `models/all/package.json` — 加依赖

**改哪个文件**：`models/all/package.json` 的 `dependencies`。

**加什么**：
```json
"@hcengineering/model-agentra-<domain>": "workspace:^0.7.0",
"@hcengineering/model-server-agentra-<domain>": "workspace:^0.7.0",
```

**漏了会怎样**：第 3 步的 `import` 解析不到，`rush build` 在 `models/all` 阶段失败。
同样是编译期可见。

---

## 3. `models/all/src/index.ts` — 加进 builder 列表

**改哪个文件**：`models/all/src/index.ts`。

**加什么**：
```ts
import agentraCore, { agentraCoreId, createModel as agentraCoreModel } from '@hcengineering/model-agentra-core'
```
以及 `builders: BuilderConfig[]` 里的一项：
```ts
[
  agentraCoreModel,
  agentraCoreId,
  {
    label: agentraCore.string.ConfigLabel,
    description: agentraCore.string.ConfigDescription,
    enabled: true,
    beta: true,
    icon: agentraCore.icon.AgentraCore,
    classFilter: defaultFilter
  }
],
```
server 侧模型追加到文件末尾那段 `[serverXxxModel, serverXxxId]` 列表里。

**顺序**：依赖别的模块类的模块，必须排在被依赖者之后（builder 按数组顺序产生 tx）。

**⚠️ `enabled: false` 的真实语义（务必读懂再选）**：
`pluginFilterTx`（`foundations/core/packages/core/src/utils.ts:832-870`）对一个被禁用的插件：

- **`classFilter` 存在时** → 只排除 `objectClass` **命中 `classFilter`** 的
  `TxCreateDoc/TxUpdateDoc/TxRemoveDoc`。
  ⚠️ **函数里并没有「豁免类模型」这条规则**——类定义 tx 之所以能活下来，
  纯粹是因为 `defaultFilter` 列的都是展示层类、**没有列 `core.class.Class`**。
  哪天有人往 `defaultFilter` 里加了 `core.class.Class`，类定义就会跟着被摘掉。
  所以正确表述是：**「命中就排除，类模型也不例外」**，而不是「类模型永远安全」。
- **`classFilter` 缺省时** → **该插件的每一条 tx 全部排除**，包括定义类本身的
  `TxCreateDoc`。任何引用了这些类的其它模块会拿到悬空的 class ref。

结论：**基础包（被别的模块引用其类的）要么保持 `enabled: true`，要么必须带
`classFilter`**。`agentra-core` 取 `enabled: true` + `classFilter: defaultFilter`。
只有纯应用层、没人引用其类的模块才可以 `enabled: false`。

另外注意 builder 循环里的兜底：
```ts
hidden: config !== undefined ? config.hidden : true,
enabled: (config?.enabled ?? true) && !(config?.hidden ?? false),
```
**不传 config 对象 = `hidden: true` 且 `enabled: false`**。想让模块默认可见就必须传 config。

**漏了会怎样**：类模型压根不进 model，客户端 hierarchy 里没有你的类，
所有 `client.findAll(yourPlugin.class.X)` 抛 "class not found"。

---

## 4. `models/all/src/migration.ts` — 加 MigrateOperation

**改哪个文件**：`models/all/src/migration.ts`。

**加什么**：`import { agentraCoreId, agentraCoreOperation } from '@hcengineering/model-agentra-core'`
和 `migrateOperations` 数组里的 `[agentraCoreId, agentraCoreOperation]`。

**⚠️ 顺序是语义的一部分**：该数组按顺序串行执行。
依赖 `card` / `contact` / `tracker` 数据的模块**必须排在它们之后**；
`agentra-core` 只依赖 core，所以排在 `activity` 之后的前段。
（现有反例参照：注释 `// We should call notification migration after activityServer and chunter`。）

**migration 必须自身幂等**：`tryMigrate` 的 state 表（`DOMAIN_MIGRATION`）是**性能挡板，
不是正确性挡板**——恢复备份、切 `MigrateMode`、state 丢失都会让它重跑。

🔴 **「先 `find` 再 `create`」本身不算幂等**：`_id` 用 `generateId()` 的话，
两个 migrator 并发跑会双双查空、双双插入，串行测试还测不出来（看着是幂等的）。
**创建任何单例文档都必须用确定性 `_id`**——在 plugin descriptor 里声明一个
`ids: { XxxSingleton: '' as Ref<Xxx> }`，`_id` 就固定成 `<pluginId>:ids:XxxSingleton`，
并发时撞主键而不是插出第二份。`find` 只当作省一次写的快路径。
参考 `models/agentra-core/src/migration.ts` 的 `ensureAgentraMarker`
与 `plugins/agentra-core/src/index.ts` 的 `ids.BootstrapMarker`。
（没有确定性 id 可用时，退而求其次是给该字段加唯一约束。）

**漏了会怎样**：升级时不会执行任何数据迁移。表现是「新装的 workspace 一切正常，
老 workspace 缺默认对象 / 字段没改名」——**只在存量环境炸，测试环境发现不了**。

---

## 5. `dev/prod/package.json` — 加 `-resources` 与 `-assets` 依赖

**改哪个文件**：`dev/prod/package.json` 的 `dependencies`。

**加什么**：
```json
"@hcengineering/agentra-<domain>": "workspace:^0.7.0",
"@hcengineering/agentra-<domain>-assets": "workspace:^0.7.0",
"@hcengineering/agentra-<domain>-resources": "workspace:^0.7.0",
```

**漏了会怎样**：第 6 步的 `import` / 动态 `import()` 在 webpack 打包时解析失败。

---

## 6. `dev/prod/src/platform.ts` — `addLocation` + `addStringsLoader` + assets 副作用 import

**这一步是最容易漏、且漏了最难查的一步。** 前面 5 步全做了、这一步没做，
`rush build` 依然全绿，但插件的组件永远加载不出来。

**改哪个文件**：`dev/prod/src/platform.ts`，三处：

1. **plugin id import**（文件顶部 import 区）：
   ```ts
   import { agentraCoreId } from '@hcengineering/agentra-core'
   ```

2. **assets 副作用 import**（`import '@hcengineering/*-assets'` 那一整块）：
   ```ts
   import '@hcengineering/agentra-core-assets'
   ```
   这行是**副作用 import**，触发 `*-assets/src/index.ts` 里的 `loadMetadata(plugin.icon, {...})`。

3. **`addStringsLoader`**（`configurePlatform()` 里那一大段）：
   ```ts
   addStringsLoader(
     agentraCoreId,
     async (lang: string) => await import(`@hcengineering/agentra-core-assets/lang/${lang}.json`)
   )
   ```

4. **`addLocation`**（同函数更靠后那一段）：
   ```ts
   addLocation(
     agentraCoreId,
     async () => await import(/* webpackChunkName: "agentra-core" */ '@hcengineering/agentra-core-resources')
   )
   ```
   `webpackChunkName` 必须给，且用插件 id 同名，否则会被并进公共 chunk。

**漏了会怎样**（三种不同的失败形态，都不是编译错误）：

| 漏掉 | 症状 |
|---|---|
| `addLocation` | 组件位置解析不到。UI 上该模块的面板一片空白或整块不渲染；控制台报 `Could not find location for plugin` / resource 解析 reject。**model 里的 Application 文档是存在的，所以导航栏能看到入口，点进去是空的**——这正是「编译通过但功能加载不出来」的典型形态。 |
| `addStringsLoader` | 所有 `IntlString` 退化成原始 id 文本，界面上到处是 `agentra-core:string:Xxx` 这样的字符串。 |
| assets 副作用 import | 图标全部丢失（`loadMetadata` 没跑，`plugin.icon.*` 拿不到 asset URL），组件里 `<Icon>` 渲染成空白方块。 |

---

## 7. server 端注册 — `server/server-pipeline/src/serverPlugins.ts`

**改哪个文件**：`server/server-pipeline/src/serverPlugins.ts` 的 `registerServerPlugins()`；
外加 `server/server-pipeline/package.json` 的依赖（否则 import 解析不到）。

**加什么**：
```ts
import { serverAgentraCoreId } from '@hcengineering/server-agentra-core'
// ...
addLocation(serverAgentraCoreId, () => import('@hcengineering/server-agentra-core-resources'))
```

**漏了会怎样**：server 端的 trigger / presenter / DD participant 全部解析失败。
表现是 transactor 在处理相关 tx 时报 resource 解析错误，或者 trigger 静默不执行。

**⚠️ 现成的反例**：`models/server-products` 在 `models/all/src/index.ts` 里注册了
（`[serverProductsModel, serverProductsId]`），但 `registerServerPlugins()` 里
**没有**对应的 `addLocation`。不要照抄 products 的做法。

---

## 附：包内文件清单（照 `agentra-core` 抄）

每个包都需要：`package.json`、`tsconfig.json`、`config/rig.json`、`.eslintrc.js`、`jest.config.js`。
rig profile 按包类型选，选错会静默用错编译选项：

| 包类型 | rig profile |
|---|---|
| `plugins/<x>`（descriptor）、`server-plugins/<x>`、`server-plugins/<x>-resources` | `default` |
| `plugins/<x>-resources`（Svelte UI） | `ui`（另需 `svelte.config.js`、`postcss.config.js`、`.prettierrc`） |
| `plugins/<x>-assets` | `assets`（`tsconfig` 需 `"types": ["node", "jest"]`） |
| `models/<x>`、`models/server-<x>` | `model` |

`_phase:build` / `_phase:test` / `_phase:format` / `_phase:validate` 四个 script 必须齐全，
rush 的分阶段构建靠它们；漏掉某个 phase 该包会被静默跳过那一阶段。

🔴 **`_phase:test` 是这四个里最容易漏的，因为漏了之后包内验证照样全绿。**
2026-08-28 实测：`traceability-resources` / `crm-lite-resources` / `requirements-resources` /
`cycle-resources` 四个包都有 `test` 脚本和 `jest.config.js`、**都没有 `_phase:test`**，于是
`rushx test` 在包内跑得通（子代理看到的绿就是这个），而 `rush test` 用的是 `_phase:test`，
**一直静默跳过** —— 共 10 个测试文件、187 个测试从未在 CI 里跑过一次。
日志里唯一的迹象是一行不起眼的 `"<pkg> (test)" did not define any work.`。

上游惯例是「有测试就有 `_phase:test`」（`products-resources`、`view-resources` 都有；
`lead-resources` 那些是压根没写测试）。**自查命令**（有测试文件却没有该 phase 的包会被列出）：

```sh
for pj in $(find . -name package.json -not -path '*/node_modules/*' -not -path './common/*'); do
  d=$(dirname "$pj"); [ -d "$d/src" ] || continue
  t=$(find "$d/src" \( -name '*.test.ts' -o -name '*.spec.ts' \) | wc -l | tr -d ' ')
  [ "$t" = "0" ] && continue
  node -e "process.exit((require('$PWD/$pj').scripts||{})['_phase:test']?0:1)" || echo "缺 _phase:test: $d ($t 个测试文件)"
done
```

**i18n 硬规则**：所有 UI 文案只能放在 `*-assets/lang/*.json`，走 `IntlString`，
**不得在 Svelte / TS 里硬编码字符串**。

**⚠️ `makeLocalesTest` 只比对 `['en', 'ru']`**
（`foundations/core/packages/platform/src/testUtils.ts`，语言列表是写死的）。
所以：即使产品只要 en + zh，`lang/` 下也**必须**有 `ru.json`，否则该测试 import 失败。
zh 的 key 对齐要另写断言（见 `plugins/agentra-core-assets/src/__tests__/lang.test.ts`）。

---

## 8. ⚠️ 还有 4 处「镜像」注册点（本仓库实测，容易被整体漏掉）

上面 7 处是 **web 客户端 + transactor** 这条主链路。仓库里还有**另外 4 个宿主**，
各自维护一份**独立的、必须手工同步的** `addLocation` / `addStringsLoader` 清单。
它们跟主链路没有任何共享代码，漏了不会有任何编译错误。

用 `grep -rn 'leadId' --include='*.ts' . | grep -v node_modules` 可以把它们全找出来
（`lead` 是目前注册得最完整的模块，拿它当基准最可靠）。

| # | 宿主 | 文件 | 要加什么 | 漏了会怎样 |
|---|---|---|---|---|
| 8.1 | Electron 桌面客户端 | `desktop/src/ui/platform.ts` + `desktop/package.json` | 与第 6 步**完全同构**的四件套：plugin id import、`import '@hcengineering/<x>-assets'`、`addStringsLoader`、`addLocation`（注意这里**不带** `webpackChunkName`） | **Web 端一切正常，桌面客户端里该模块空白 / 文案是裸 id / 图标丢失。**这是最隐蔽的一处：QA 只测浏览器就发现不了 |
| 8.2 | transactor 服务端 i18n | `server/server-pipeline/src/internationalization.ts` + `server/server-pipeline/package.json` | `import <x>En from '@hcengineering/<x>-assets/lang/en.json'` 与 `addStringsLoader(<x>Id, async (lang) => <x>En)`（服务端**只装 en**，是静态 import 不是动态 import） | 服务端渲染的文案（通知邮件、推送标题等）退化成 `<x>:string:Yyy` 裸 id |
| 8.3 | 运维 CLI | `dev/tool/src/__start.ts` + `dev/tool/package.json` | `addLocation(server<X>Id, () => import('@hcengineering/server-<x>-resources'))`——它**自己维护一份 server plugin 清单**，不复用 `registerServerPlugins()` | `dev/tool` 跑迁移 / 批处理时 server resource 解析失败 |
| 8.4 | GitHub 集成 pod | `services/github/pod-github/src/loaders.ts` | 同 8.2 的静态 en 装载 | 只影响 GitHub 集成路径的文案；新模块若与 GitHub 无关可以不加 |

**规则**：第 6 步与 8.1 必须**成对修改**；第 7 步与 8.3 必须**成对修改**。
提 PR 时把这两对写进自查项，review 时按 `grep -c` 数量核对。

> **`agentra-core` 的注册现状（2026-08-26 复核）**：主链路 7 处 + 镜像 8.1／8.2／8.3 **均已落地**，
> 经逐行核对无遗漏。**8.4（`services/github/pod-github/src/loaders.ts`）有意未加** —— 该清单装的是
> pod-github 进程自己会生成／渲染的 `IntlString`，本就是有选择的子集（不含 card／time／love／chat／
> mail／survey 等），取舍依据是「本进程用不用得到」。`agentra-core` 与 GitHub 同步路径无交集，加了
> 只是白白多一条依赖。**只有当某个模块的字符串会被 pod-github 实际渲染时，才需要补 8.4。**
>
> 换言之：8.4 不是「欠账」，是**按需项**；其余 10 处才是每个新模块都必须走完的。

### 关于「11 处」这个说法

标题里的「11 处」指的是**注册动作**的数量，不是文件数。按路径去重后实际涉及 **14 个文件**，
其中 `server/server-pipeline/package.json` 在第 7 步和 8.2 各出现一次（同一个文件、两个不同原因：
前者为 `serverPlugins.ts` 的 `addLocation` 提供依赖，后者为 `internationalization.ts` 的静态
`en.json` 导入提供依赖）。核对时按**动作**逐项打勾，不要按文件数对账。

## ⚠️ `rush validate` 绿 ≠ 打包能过

新增 `.svelte` 组件时，**用到的每个包都必须写进该 resources 包的 `dependencies`**。

`rush validate`（tsc）走的是 workspace 的符号链接，能解析到根 `node_modules` 里
任何已安装的包，**即使当前包并没有声明它**。webpack 不吃这一套，会在打包时报
`Module not found: Can't resolve '@hcengineering/xxx'`。

2026-09-01 实测：`McpSettings.svelte` 用了 `copyTextToClipboard`，
`rush validate` 全绿、`svelte-check` 全绿，`rushx package`（webpack）才炸，
因为 `agentra-core-resources` 没声明 `@hcengineering/presentation`。

**判据**：新组件写完后跑一次 `cd dev/prod && rushx package`，不要只跑 validate。
这与本文档已记的「`-resources` 包被二次类型检查」是同一类陷阱的另一面 ——
那条说的是"包内 tsc 干净不等于 rush validate 过"，这条说的是
"rush validate 过不等于 webpack 过"。

### 契约包拿 `AnyComponent` 要依赖 `@hcengineering/ui`

`AnyComponent` 定义在 `@hcengineering/ui`，上游契约包（如 `plugins/tracker`）
就是这么依赖的。契约包本身不含 UI 代码，但类型要从那里取。
