---
source: docs/adapter-guide.md
source-sha256: 1b06536bb0324cbbc8b0d48be096550dd3fd75dc0574b3f7ba7f6ac13e04694f
---

# 编写 Engine Adapter

这是规范的任务导向配套文档。`EngineAdapter` 的形状定义在
[engine-adapter-api.md §9](engine-adapter-api.md)；发现与加载规则见下面的
[注册它](#注册它)。本文讲的是如何真正动手写一个 Adapter、按什么顺序写，
以及哪些错误最费时间。

## Adapter 是什么，不是什么

Adapter 只回答一个问题：**我如何获得一个会说该协议的进程？** 仅此而已。
Session 生命周期、事件映射、权限策略、Transcript 持久化、resume、进程监督与崩溃重启，
统统属于 core，且对每个 Engine 一视同仁。

所以 Adapter 就是数据，外加至多一个 `detect()` 探测。如果你发现自己在 Adapter 里写
Session 逻辑，那说明别处的设计出了问题——请提出来，而不是绕过去，因为在一个 Adapter 里
实现的行为，正是其他 Engine 会悄悄缺失的行为。

你同样**不**声明 Engine 能做什么。Capability 是在运行时从 Engine 自己的 `initialize` 与
`session/new` 响应中测得的。一个自称拥有某 Capability 的 Adapter 会被信任，然后在线路上失败。

## 按这个顺序构建

每一步都很廉价，且能在下一步变昂贵之前排除一类失败。

### 1. 先确认 Engine 到底会不会说该协议

在动笔之前，手工运行它的命令，检查它是否能在 stdio 上响应 `initialize`。
多数 Engine 为此提供子命令——`kimi acp`、`opencode acp`——或提供包装器——
`npx @zed-industries/claude-code-acp`。

如果它不说该协议，你需要一个 shim（`shim.mjs`）：一个独立进程，在 runskein 给它的
stdio 上说 ACP，并对它自己启动的子进程说 Engine 自身的协议。那是比 Adapter 大得多的
工程——整个 Session 生命周期、事件翻译与权限都必须用 Engine 自己的术语表达——而本指南
其余部分讲的是 Adapter，不是 shim。

内置 Engine 中只有一个需要 shim：`pi`。在开始第二个之前，请先读
`adapters/pi/`——`src/shim.mjs` 就是那份可用的范例，决策 028 解释了边界为什么
划在那里。预期同样形态的工作量。有三件最费时间的事情事先并不显然：shim 声明的是它
**实测到**的 Capability，而不是它希望具备的 Capability；shim 入口是 `packages/core/src/acp/`
之外唯一允许导入 ACP SDK 的地方（决策 028），因此应实现 `Agent` 接口而不是手写
JSON-RPC；以及，如果你的 Engine 每个进程只承载一个 Session，那么 shim 每个 Session 拥有一个
子进程，且子进程死亡必须让它自己那一轮失败，而不是被报告为 Engine 崩溃。

### 2. 创建目录

```
adapters/<engine-id>/
├── package.json      发布时命名为 runskein-adapter-<engine-id>，并带上标记
├── index.mjs         default export: the EngineAdapter
├── index.d.ts        typing for static imports by the meta-package
└── conformance.json  由下文的 probe 命令写出；提交它作为证据
```

每个以目录为载体的候选都遵循同一条身份规则：`id` 要么直接等于目录 basename
（`<engine-id>/`），要么等于从 basename 中剥去精确前缀 `runskein-adapter-`
之后的部分（`runskein-adapter-<engine-id>/`）。其他不一致都是加载错误，不是警告。
可被发现的第三方包必须使用带前缀的形式：不加 scope，或命名为
`@scope/runskein-adapter-<engine-id>`。

shim 型 Adapter 在这棵树之外还有额外的产物：`src/shim.mjs`（shim 源码）、根部的
`shim.mjs`（提交入库的 esbuild 产物），以及 Engine 自有的辅助文件（如 pi 的
`permission-gate.ts`）。与之配套的规则：`index.mjs` 必须免构建；`shim.mjs`
正相反——它是构建产物。本指南只讲 Adapter 本身；写一个 shim 是另一个量级的工程
（见决策 028）。

`package.json` 需要发现标记。一层发现机制按位置（已安装包还要按前缀）选中目录后，
manifest 门禁会检查 `runskein.adapter === true`；`specVersion` 在加载后由 schema
校验。没有标记，该目录对发现机制不可见：

```json
{
  "name": "runskein-adapter-myengine",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "types": "index.d.ts",
  "runskein": { "adapter": true, "specVersion": 1 }
}
```

自用的私有 Adapter 保留 `"private": true` 即可。要发布 Adapter，则去掉该字段并
补上 `version`，以及任何 npm 包都需要的元数据——`license`、`description`、
`files`。

RunSkein 的内置 Adapter 使用包名 `@runskein/adapter-*`，但那是第一层的约定：
meta-package 会在动态发现之前静态 import 它们。第三层不会扫描这种形式。
第三方发布者必须使用 `runskein-adapter-<id>`（可以放在自己的 scope 下），
不能照搬内置包名。`adapters/kimi/package.json` 是内置第一层形式的完整仓库内示例。

`index.mjs` 必须是可在运行时直接导入、无需构建步骤的纯 ESM。
发现机制会在裸 node 下直接导入它。

### 3. 写 launch 块

```js
export default {
  specVersion: 1,
  id: 'kimi',
  launch: { command: 'kimi', args: ['acp'], startTimeoutMs: 30_000 },
};
```

**`startTimeoutMs` 应按命令如何解析来选，而不是按 Engine 有多快来选。**
`PATH` 上的原生二进制启动远低于一秒；内置的原生二进制 Engine 使用 20–30 秒
（opencode 与 kimi 30 秒，pi 20 秒），几乎全是余量。
`npx` 包装器在首次运行时可能会下载包，因此内置的基于 npx 的 Engine 使用 120 秒。
在热缓存下实测，spawn 加 `initialize` 对原生二进制约 0.6 秒，对 npx 包装器约
1.6 秒——这份预算是为冷启动准备的，不是为常态准备的。

`launch.env` 在 core 的环境清洗**之后**应用，因此它会胜出——在一个解析变量名时不区分
大小写的宿主上，你写的 `Path` 会顶掉继承来的 `PATH`，而不是并排放着。出于同样的理由，
同一个名字不得写成两种拼写：`{ PATH_EXTRA: …, Path_Extra: … }` 在这里是两个变量，
在 Windows 上是一个，因此注册阶段会拒绝它，而不是让 Engine 的环境取决于它在哪台机器上
启动。用它设置 Engine 在启动时读取的配置，而不是每个 Session 的配置：一个进程服务多个
Session，其环境在启动时即固定。

### 3a.`supervise`—— 仅当你的 Engine 忽略 stdin EOF 时

```js
supervise: true, // default false
```

Engine 运行在自己的进程组中，以便 runskein 能向整棵树发信号，这同时也意味着宿主死亡时
没有任何东西会杀掉它们。多数 Engine 会注意到 stdin 关闭并退出；内置 Engine 中曾有一个
不会，于是每次宿主非正常终止都会泄漏一个进程。

只有在检查过你的 Engine 之后才设置 `supervise: true`：启动它，用 `SIGKILL` 杀掉宿主，
几秒后看 Engine 是否仍在运行。如果它会自行退出，就别开——它每个 Engine 要多付一个进程的代价。

这个看门狗**不是**协议 shim。你的 Engine 继承宿主的 stdio，因此其 JSON-RPC 流不受影响；
这个额外进程只是盯着一个 pipe，等待表示宿主已消失的 EOF。见 `docs/decisions/015`。

### 3b.`creationConfig`—— 仅创建时可写的设置

有些 Engine 携带永远到不了 ACP 配置面的设置：它们只在 Session 构造期间从
`session/new` 的 `_meta` 里读取一次，之后任何东西都改变不了已读取的内容。
把它们声明为数据，而不是塞进 `launch.env`（后者按进程固定，不是按 Session）：

```js
creationConfig: {
  reasoning: {
    meta: ['claudeCode', 'options', 'maxThinkingTokens'],
    values: { low: 4000, medium: 10000, high: 32000 },
    description: 'Thinking budget, applied when the session is created',
  },
},
```

（来自内置的 claude-code Adapter。）键是 **runskein 配置键**（`reasoning`、
`model`……），绝不是 Engine 原生名称；`meta` 是该值在创建请求 `_meta` 对象内的
路径；`values` 把 runskein 的档位映射到 Engine 期望的值，因为"high 是什么意思"是
你的 Adapter 的知识、不是 core 的。runskein 在创建请求上投递该值，并通过
`describe()` 将其报告为 `settable: 'creation'`，拒绝运行时写入，而不是发送
一个会被接受却被忽略的写入。

当 Engine 已经在 `configOptions` 里报告了某设置时，**不要**用 `creationConfig`
——遮蔽一个真实可写面会产生一个能通过校验却无法应用的值，与过期的
`configHints` 条目（见下方“最费时间的那些错误”一节）是同一种最坏结果。

### 3c.`errorPatterns`—— 这个 Engine 的失败意味着什么

Engine 的错误措辞属于 Engine 自己，所以对就绪之后的失败，core 只通过你声明的
模式来分类：

```js
errorPatterns: [
  { cause: 'rate-limit', match: 'reached your usage limit|quota will be refreshed' },
  { cause: 'auth', match: 'Authentication required' },
],
```

两条规则，都是用代价换来的：

- **把 `rate-limit` 声明在 `auth` 之前。** 先匹配者胜，而 Engine 完全可能把一次
  限流写成认证问题 —— kimi 无论何种原因，都会给上游的拒绝加上
  `Authentication required:` 前缀。顺序比看上去更要紧：`auth` 是一次拆除，
  不是一个标签。它会让缓存的登录状态失效直到 `hub.rescan()`，把该 Engine 上
  每一个 live Session 判为崩溃，并回收 Engine 进程（process）。额度耗尽若被判成
  `auth`，就是为一次本会自行恢复的失败拆掉整台 Engine。
- **模式要写自你实测到的负载**，而不是你以为 Engine 会怎么说。匹配点明该情形的
  那一段，并留得足够长，以排除仅仅提到某个上限或某个数字的句子。没有命中的失败
  是一个诚实的、没有 `kind` 的 `EngineOperationError`；而命中错消息的模式，是一个
  说得很有把握的错误答案。

### 4. 写 `detect()`

```js
async detect() {
  const version = await tryVersion('kimi', ['--version']);
  if (version === undefined) {
    return { installed: false, loginHint: 'install kimi, then: kimi acp --login' };
  }
  return { installed: true, version, loginHint: 'kimi acp --login' };
}
```

`detect()` 必须廉价，绝不能启动 Engine 本体，其结果供给 `hub.engines()`。三条规则：

- **报告事实，绝不猜测。**`installed: false` 意味着你检查过且它确实不存在。
  如果你无法确定是否已认证，就让 `authenticated` 保持 undefined——那被读作
  “未知”，而 `false` 会让 hub 拒绝一个本可成功的 Session。
- **让失败抛出。** 抛出的 `detect()` 会以类型化的 `EngineOperationError` 浮现，
  Engine 显示为 `health: 'invalid'`。吞掉错误并返回 `installed: false`，会把一次
  失败的探测变成一条虚假的环境事实，那要难调试得多。
- **探测真正重要的东西。** 对包装器，探测底层 Engine，而不是包装器。
  `npx` 几乎总是存在；那什么也说明不了。

`loginHint` 会在 `UnauthenticatedError` 时展示给用户，所以让它就是用户该运行的
那条确切命令。

### 5. 跑门禁

```sh
pnpm conformance <engine-id>
```

这不是走过场——它就是注册机制。**Adapter 当且仅当通过它才可注册**，而那些针对
mock agent 密封运行的用例，会同样针对你的真实 Engine 运行。

一共三道门禁，知道是哪一道在报警很有用：

| 门禁                  | 跑什么                                                                                                                                                     | 不过意味着什么                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Core 门禁**         | spawn → `initialize` → `session/new` → `prompt` → 流式更新 → 停止原因 → 清理，外加环境卫生下的 spawn、轮次中途取消、以及 `policies.rules` 下的一次权限往返 | 不可注册                                                              |
| **Capability 真实性** | 探测得到的实测矩阵 vs Adapter 声明的内容                                                                                                                   | `configHints` 与探测输出之间的漂移是**警告**；Core 行的漂移是**失败** |
| **Store 门禁**        | 任意 `TranscriptStore` 实现：追加/读取顺序、seq 单调性、摘要确定性、过滤                                                                                   | 只有你自带 store 时才相关                                             |

CI 每次推送都会对着 mock agent 跑 Core 门禁。实测探测按需运行，需要一台装好并
登录了该 Engine 的机器。

然后记录实测 Capability：

```sh
cd packages/conformance && pnpm probe <engine-id>
```

这会写出 `adapters/<id>/conformance.json` 并刷新
`docs/conformance/matrix.json` 中该 Engine 那一行。

**只提交 `conformance.json`，另外两个文件都不要提交。** `matrix.json` 带着跑
probe 那台机器的 provider 配置，所以它不在本仓库里，你那份也不该被加进来。对外
发布的 capability 表来自它的一份投影 `matrix.public.json`，由维护者按完整的五
Engine probe 刷新——拿一份只有一个 Engine 的 `matrix.json` 去投影会把另外四个
删掉，`project-conformance-matrix.mjs --write` 会直接拒绝而不是照做。

在 PR 里说明 probe 测到了什么。`conformance.json` 是后续漂移的度量基线，任何会
改动它的变更都要在同一次改动里刷新它。

## 最费时间的那些错误

**以为包装器会原样转发你给的东西。** 通过包装器抵达的 Engine 是两个进程，
由包装器决定什么能到达里面那个。在 Adapter 的 launch 上设置环境变量，
只是把它放进包装器的环境，而那与 Engine 的环境不是一回事：有一个内置包装器会为它
启动的进程重建一份干净环境，因此这样设置的变量会被静默丢弃。命令行参数也可能被
同样地吞掉。请通过读取内层进程真实的环境与 argv 来验证，或让 Engine 把该设置回报出来
——绝不要以“没有报错”来验证。

**为 Engine 实际会上报的东西添加 `configHints`。** 提示是为完全**不**上报任何配置的
Engine 准备的回退方案，而且它们是静态的，会过时。添加之前，先检查完整的
`session/new` 响应：配置位于 `configOptions`，但模型选择可能单独发布在 `models`，
模式在 `modes`。一个遮蔽了真实可写表面的提示会带来最坏的结果——一个能通过校验、
随后却无法被应用的值。

**试图通过环境实现按 Session 配置。** 一个进程服务该 Engine 上的每个 Session，其环境在 spawn
时即固定。按 Session 的设置必须走线路传递。

**把 Engine 特有的怪癖加进 core。** 如果你的 Engine 需要特殊处理，那是一个 Capability 协商的缺口。
把它修成一个协商 Capability，让每个 Engine 都受益，或者提个 issue——不要在 core 里对某个 id
做特例，那正是 Adapter 层存在所要防止的事情。

## 环境卫生

core 在启动任何 Engine 前，会清洗宿主 agent 的 Session 标记（`CLAUDE*`、`CLAUDECODE`、
`CODEX_SANDBOX*`、`OPENCODE_SESSION*`、`OPENCODE_CALLER*`）。这是承重的，不是整洁
问题：在一个编码 agent 内部运行 runskein 会把该 agent 的 Session 变量泄漏到子进程，
至少有一个 Engine 会因此以 “active session” 拒绝启动。

如果你的 Engine 有同样问题的自有标记，把它们加上：

```js
envScrubExtra: [/^MYENGINE_(SESSION|CALLER)/],
```

清洗那些标识** Session **的变量，而不是那些配置 Engine 的变量——过度清洗会剥掉用户自己的配置。

## 注册它

`createHub()` 按四层解析 Adapter。**id 冲突时后面的层胜出；同一层里两个 Adapter
认领同一个 id 是错误**——所以显式对象可以有意顶掉一个内置 Engine，而两个被扫到的
目录争抢 `kimi` 是个错误，不是优先级谜题。

|     | 层       | 需要 `discovery`                 | 位置                                                                                  |
| --- | -------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | 内置     | 否——应用已经把它们 import 进来了 | `runskein` 里的 `adapters/*` 包                                                       |
| 2   | 工作区   | 是                               | 带 `runskein.adapter` 标记的 `<cwd>/adapters/*` 与 `<cwd>/.runskein/adapters/*`       |
| 3   | 已安装包 | 是                               | `node_modules/runskein-adapter-*` 与 `node_modules/@*/runskein-adapter-*`，同样的标记 |
| 4   | 显式     | 否                               | 先 `adapterPaths`，再 `adapters`                                                      |

每个以目录为载体的候选都走同一条流水线：找到 `runskein.adapter` 标记 → 检查
`specVersion` → 动态 import 主入口 → 用 schema 校验默认导出 → 要求 id 直接匹配
目录 basename，或匹配剥去 `runskein-adapter-` 前缀后的 basename → 检查 id 冲突 →
注册。这一步不会运行 `detect()`——它是惰性的，等到第一次 `engines()` 或
`session()` 需要时才 await。

**一个坏目录绝不会拖垮 hub。** import 失败、默认导出校验不过、`specVersion`
不支持、或者 `detect()` reject，结果都一样：`await hub.engines()` 把该 Engine
报成 `{ id?, health: 'invalid', error }` 并跳过，其他 Engine 照常工作。
迭代 Adapter 时要注意：发现结果与 `detect()` 结果都按进程缓存，
`hub.rescan()` 会让两者失效并强制重新遍历。

**发现默认关闭，这是一条安全边界，不是默认值偏好。** `import()` 会以宿主进程的
完整权限执行 Adapter 的顶层代码，而 schema 是在那段代码**已经跑完之后**才校验
导出的。它是兼容性门禁，不是沙箱。只对你信任其内容的工作区开启发现；否则就把你
想要的那些 Adapter 显式传进去——用对象，或者用显式路径。

## 检查清单

- [ ] 目录 basename 是 `<id>` 或 `runskein-adapter-<id>`；已安装包使用带前缀的形式
- [ ]`package.json` 中存在 `runskein.adapter` 标记
- [ ]`index.mjs` 是可在运行时导入、无需构建步骤的 ESM
- [ ]`startTimeoutMs` 反映命令如何解析，而非 Engine 速度
- [ ] 仅创建时生效的设置用 `creationConfig` 声明，而不是塞进 `launch.env`
- [ ]`detect()` 报告事实、失败时抛出，并探测真实 Engine
- [ ]`loginHint` 就是用户该运行的那条确切命令
- [ ] 没有 Session 逻辑、事件映射或 Capability 声明
- [ ]`pnpm conformance <id>` 通过
- [ ]`conformance.json` 与矩阵那一行已提交
