---
source: README.md
source-sha256: 99545dfe9023da6fb68b3a5c24ac457aad433ba76b96a26db5bf00e576208a6d
---

# runskein

**一套 API，驱动五个 coding agent。**

runskein 让一个 TypeScript 程序用同一套调用去驱动 OpenCode、Kimi Code、
Claude Code、Codex 和 pi。它负责启动和停止这些 coding agent 的进程（process），
为每个 Session 保持一段对话，并把 agent 说过的每句话都保存进你自己的 Transcript。

runskein 是一个**运行时层（runtime layer），不是编排器（orchestrator）**。它只
负责把 coding agent 跑起来。它不决定哪个 agent 接哪个任务（task），不限制它们花多
少钱，也不隔离它们的文件。这些是你的程序要做的，或者是你在它之上再搭一层要做的。

> **状态：预览版。** 当前发布版本是 `0.1.0-alpha.24`。这套 API 可以拿来开发和
> 评估，但还不保证保持兼容。每个 Engine 能做什么，也取决于机器上装的是哪个版本。
> 依赖某个特性之前，先看[实测矩阵](docs/conformance/matrix.public.json)。

不用 runskein：

```ts
if (engine === 'codex') {
  /* spawn it, handshake, its resume, its config keys */
} else if (engine === 'claude-code') {
  /* all of it again, differently */
} else if (engine === 'opencode') {
  /* and again */
}
```

用 runskein：

```ts
const session = await hub.session({ engine: 'codex', cwd });
await session.prompt('Fix the failing tests.');
```

## 为什么用 runskein？

每个 Engine 都是一个子进程。runskein 通过
[Agent Client Protocol（ACP）](https://agentclientprotocol.com)和它通信。五个
Engine 里有四个直接说 ACP，pi 则由一个小的翻译进程来驱动。

ACP 规定的是一个 client 怎么和一个 agent 对话。ACP 留给应用去做的那些事，由
runskein 来做：

- 启动和停止 agent 进程
- 面向不同 Engine 的同一套 API
- 保存下来的 Transcript 和 resume
- 权限和带类型的错误
- 补上一部分 Capability 缺口，所以不会有东西悄悄失效

你看不到 ACP。公开类型都是 runskein 自己的，所以你不用引入 ACP SDK，也不用去想
协议细节。完整对比见 [runskein 与 ACP](docs/runskein-vs-acp.md)。

## 快速开始

### 安装

```bash
npm install runskein@alpha        # 或者：pnpm add runskein@alpha
```

`runskein` 就是你要装的那个包，五个 Engine 的 Adapter 都打包在里面，多数应用只
需要这一行。

**`@alpha` 不能省。** 裸写包名时 npm 解析的是 `latest` 这个 tag，而预发布版本不会
带上它；`latest` 指向的是一个已标记废弃、占名用的空壳包，所以省掉 `@alpha` 不会
报错，只会带着一条警告装到一个没有代码的包。要单独装某个包也一样，写
`@runskein/core@alpha`。

需要 Node.js 22 或更高版本，只支持 ESM。装这个包不会装任何 Engine。runskein 只
会去找你 `PATH` 上已有的 Engine。

### 跑第一个例子

```ts
import { createHub, policies } from 'runskein';

const hub = createHub();

const session = await hub.session({
  engine: 'opencode',
  cwd: process.cwd(),
  permissionPolicy: policies.allowAll,
});

session.on('update', (event) => {
  const update = event.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text);
  }
});

const result = await session.prompt('Summarize this repository.');
console.log(`\nstop reason: ${result.stopReason}`);

await session.close();
await hub.quit();
```

Transcript 写在 `.transcripts/` 目录下。Session 的 `cwd` 同时也是 Engine 的工作
目录。

## 支持的 Engine

| Engine      | 已支持 | Resume | Fork | 图像 |
| ----------- | ------ | ------ | ---- | ---- |
| OpenCode    | ✓      | ✓      | ✓    | ✓    |
| Kimi Code   | ✓      | ✓      | ✓    | ✓    |
| Claude Code | ✓      | ✓      | ✓    | ✓    |
| Codex       | ✓      | ✓      | —    | ✓    |
| pi          | ✓      | ✓      | ✓    | —    |

Session 列表、删除、MCP 传输方式、provider 发现、token 用量，以及这些结果是在哪个
Engine 版本上测的，都在[Engine 支持](docs/engine-support.md)里。实测数据在
[`docs/conformance/matrix.public.json`](docs/conformance/matrix.public.json)。

加一个新 Engine，写一个 Adapter 就行，不用改 runskein。见
[新增 Engine](#新增-engine)。

## 核心概念

```text
你的应用
      ↓
runskein 公开 API
      ↓
core
      ↓
ACP 客户端
      ↓
coding agent 进程
```

**Hub** —— 启动时创建一次。它负责发现 Engine、启动和停止 Engine 进程、创建
Session。一个 Hub 对每个 Engine 只保留一个进程，并且会替你关掉它们。所以整个应用
用一个 Hub 就够了。

**Session** —— 和一个 Engine 的一段对话。你可以对它发 Prompt、取消、关闭，之后用
它的 id 恢复。Session 之间不共享上下文。一个 Engine 做过什么，另一个看不到，除非
你把内容传过去。

**Transcript** —— agent 产生的每个事件，边发生边存。runskein 把存下来的
Transcript 当作 Session 历史和 resume 的 source of truth（唯一可信来源）。它不指望 Engine 一直替你留着
这些数据。把 Transcript 变成能画到界面上的东西，是
[`runskein/fold`](docs/transcript-fold.md) 的事，它是可选的，也是
独立的。

**Capability** —— 每个 Engine 都不一样，所以 runskein 用三种方式处理一个特性：
必备的、看 Engine 的，或者由库自己模拟的。缺失的特性不会悄悄失效。你会拿到一个带
类型的错误，里面写清楚是哪个 Engine 缺哪项 Capability。细节见
[架构](docs/architecture.md)。

## 常见用法

**一个应用一个 Hub。** 第二个 Hub 会自己再起一套进程，而且要么把同一个 Transcript
目录切成两半，要么和它抢。

**每个任务、每个 Engine 一个 Session。** 复用 Session 会把上一个任务的历史带进下一
个任务，Transcript 也会一直变大。一个用到两个 Engine 的任务，就有两个 Session。

**并发上限自己定。** 一个 Engine 就是一个进程、一条 pipe，runskein 不会替你排队。
如果你要并发，就自己按 Engine 限流。跑在**不同** Engine 上的活各用各的进程，互不
影响。

从创建 Hub 到关停的完整流程，包括空闲间隔、配置和错误处理，见
[应用指南](docs/application-guide.md)。

## 新增 Engine

一个 Adapter 只回答一个问题：

**我怎么启动一个会说 ACP 的进程？**

一个基本的 Adapter 就是个小目录，里面放启动命令、检测逻辑和元数据：

```text
adapters/<engine-id>/
├── package.json      runskein: { "adapter": true, "specVersion": 1 }
├── index.mjs         default export: the EngineAdapter
├── index.d.ts        types for static imports
└── conformance.json  由下面那条 probe 命令写出；作为证据提交
```

剩下的事情 —— Session、事件、权限、resume、进程管理 —— 都归 core 管，每个 Engine
都一样。见 [Adapter 指南](docs/adapter-guide.md)。

## 包

| 包                  | 是什么                                                        |
| ------------------- | ------------------------------------------------------------- |
| `runskein`          | 你要装的那个，打包了五个 Engine 的 Adapter                    |
| `@runskein/core`    | Hub、Session、Transcript Store、权限、类型                    |
| `@runskein/fold`    | 把 Transcript 变成可渲染的状态，也可以用 `runskein/fold` 引入 |
| `@runskein/testkit` | 一个脚本化的 agent，让你的测试不需要真 Engine                 |
| `adapters/*`        | 各个 Engine 的启动和检测细节                                  |

`packages/cli` 和 `packages/conformance` 是开发工具，不发布。

## 限制

- **公开 API 不直接暴露 ACP。** 如果某个 ACP 特性 runskein 还没做，你可能得用
  底层的 `_meta` 出口。
- **一个 Engine，一个进程，一条 pipe。** runskein 不排队。
- **Capability 数据是一份 snapshot**，只对应测过的那些 Engine 版本，不代表以后的
  版本。
- **调度、预算、workspace 隔离都不在这里** —— 见上面说的 runtime layer 边界。
  这条线按**触及范围**划：需要进程句柄或 ACP 连接的留在这里，能用 `prompt()`
  加读取结果表达的属于上面那层。[架构](docs/architecture.md)里画了这条线。
- **不用环境变量做配置。** 所有配置都传给 `createHub()` 和 `hub.session()`。
- **没有批处理 CLI，也没有 Transcript 浏览界面。** CLI 是开发时用来交互式验证的。
- **实测表会过时。** 它记录的是某一次探测、某一个 Engine 版本；你这台机器上
  实际有什么，看 `hub.engines()` 与 `hub.describe()`。

## 文档

|                                               |                                        |
| --------------------------------------------- | -------------------------------------- |
| [应用指南](docs/application-guide.md)         | 在真实程序里怎么用 runskein            |
| [架构](docs/architecture.md)                  | 什么跑在哪，为什么                     |
| [Adapter 指南](docs/adapter-guide.md)         | 一步步加一个 Engine                    |
| [Transcript 与 fold](docs/transcript-fold.md) | 怎么把 Session 渲染出来                |
| [Engine 支持](docs/engine-support.md)         | 每个 Engine 能做什么                   |
| [能力矩阵](docs/capability-matrix.md)         | 逐层级、逐引擎（表为生成物，保持英文） |
| [CLI](docs/cli.md)                            | 从终端驱动它（英文单语）               |
| [runskein 与 ACP](docs/runskein-vs-acp.md)    | 完整对比                               |
| [API 规范](docs/engine-adapter-api.md)        | 冻结的公开接口                         |
| [版本与发布](docs/versioning.md)              | 一个版本号意味着什么                   |
| [参与贡献](CONTRIBUTING.md)                   | 门禁，以及一次改动要带上什么           |

## 参与贡献

改动请放在它所属的包或 Adapter 里，不要动冻结的 API 约定，行为有变化就加或改测试。
[CONTRIBUTING.md](CONTRIBUTING.md) 是完整的约定：门禁、哪些是冻结的、以及文档
与授权怎么跟着改动一起走。

```bash
pnpm install --frozen-lockfile     # Node 22+, pnpm 9.15.9

pnpm quality      # 仓库不变量：import 边界、许可证、生成文件
pnpm typecheck    # tsc --noEmit across packages
pnpm test         # vitest
pnpm build        # required — see below
pnpm conformance  # adapter gate, no engine needed
```

`pnpm build` 不能省，而且不只是为了产物。`tsc --noEmit` 从来不检查声明文件的生成。
构建还会把按路径加载的资源复制进 `dist`，然后检查构建出来的代码还能不能找到它们。
之前有个 watchdog 从发布的包里丢了，就是因为没人做这个检查。

如果你改了 Adapter，还要对着真实 Engine 跑一遍 conformance gate。这需要那个 Engine 已经装好并
登录：

```bash
pnpm conformance opencode
cd packages/conformance && pnpm probe opencode   # refresh measured capabilities
```

### 开发时用 CLI

不写程序就能看到真实行为，这是最快的办法：

```bash
pnpm --filter @runskein/cli dev engines                  # what is installed here
pnpm --filter @runskein/cli dev describe opencode        # what this engine can do
pnpm --filter @runskein/cli dev chat opencode --cwd .    # an interactive session
```

`chat` 支持 `--permission allow-all|deny-all|ask`、`--resume <sessionId>`，还有可以
重复写的 `-c key=value` Engine 配置。在 Session 里可以用 `:cancel`、
`:config key=value`、`:fork`、`:status` 和 `:quit`。完整列表见
[CLI 参考](docs/cli.md)。

需要跑真实 Engine 时的登录方式：`opencode auth login`、`kimi acp --login`、
`claude /login`，Codex 用 ChatGPT 登录或 API key。

[API 规范](docs/engine-adapter-api.md)是冻结的公开约定，代码跟着它走，不是反过来。
改动这个接口需要在 [`docs/decisions/`](docs/decisions/) 里加一份带编号的记录，
并和代码在同一次改动里落地。
