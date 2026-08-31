<!--
source: docs/application-guide.md
source-sha256: 6f53bcb498ce364162cf07f03095c7edf6f88e9eb6b45f2df225867137592894
-->

# 在应用中使用 runskein

README 的 Quickstart 创建一个 Hub，运行一个轮次，然后退出。长时间运行的程序还必须决定
Hub 与 Session 如何映射到自己的工作。简短答案是：

> **每个应用一个 `Hub`。每个任务、每个 Engine 一个 `Session`。**

本页其余部分解释其中的原因，以及不这样做会出什么问题。

## 1. 启动时创建一个 Hub

Hub 按 Engine id 索引 Engine 进程，因此**一个 Hub 意味着每个 Engine 一个进程**，
由它创建的每个 Session 共享，并在最后一个 Session 释放引用后通过引用计数关闭。

第二个 Hub 不会共享这些进程。它会启动自己的一套进程，使冷启动次数和内存占用翻倍，
还会拆分或争用 `hub.sessions()`、`attach()` 与 resume 所读取的 transcript 目录。
只创建一次 Hub，也只退出一次。只有真正不同的设置——另一套 transcript store、
另一组 Adapter——才值得使用第二个 Hub。权限策略不是理由：它是逐 Session 的选项。

```ts
import { createHub, jsonlStore, policies } from 'runskein';

const hub = createHub({
  store: jsonlStore('.transcripts'),
  defaults: { permissionPolicy: policies.denyAll, idleTimeoutMs: 30_000 },
});
```

## 2. 每个任务、每个 Engine 一个 Session

一个 Session 就是一段对话。如果把一个 Session 复用于互不相关的任务，每个任务的历史
都会泄漏到下一个任务，transcript 会无限增长，而你在每一轮都要为这段历史支付 token，
直到上下文窗口——模型一次能容纳的内容——耗尽。Session 也是 transcript、resume 与
`cancel()` 的单位：取消一个任务不能停止另一个任务。

一个 Session 绑定到一个 Engine，因此使用两个 Engine 的任务会有两个 Session：

```ts
const planner = await hub.session({ engine: 'codex', cwd });
const worker = await hub.session({ engine: 'opencode', cwd });
```

runskein 不知道什么是「任务」，所以要维护你自己的映射。稍后 resume 需要 runskein
生成的那个确切 `sessionId`：

```ts
const task = { id: 'task-42', sessions: { codex: planner.id, opencode: worker.id } };
```

两个 Session 不共享任何东西。一个 Engine 做过的事对另一个不可见，除非你把它传过去；
`hub.transcripts.digest(sessionId)` 会把一份 transcript 压缩成新 Session 可以读取的文本。
（`session.fork()` 在这里没有帮助——fork 仍留在同一个 Engine 上。）

## 3. 运行轮次，并处理返回结果

```ts
const result = await session.prompt('Refactor src/parser.ts');
result.stopReason; // 'end_turn' | 'cancelled' | …
result.usage; // tokens for this turn, where the engine reports them
```

取消不是错误。`session.cancel()` 会让正在运行的轮次以 `stopReason: 'cancelled'`
_结束_；只有从未开始的 prompt 才会以 `CancelledError` 拒绝。这就是
[决策 001](decisions/001-cancel-semantics.md)，它的存在是为了让已取消的轮次仍有一个
可以读取和记录的结果。

真实故障会以类型化错误到达，并携带你采取行动所需的信息：

| 错误                   | 携带内容                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `UnauthenticatedError` | 该 Engine 的确切登录命令                                                                       |
| `EngineCrashError`     | 已写入磁盘的最后一个 transcript 序号                                                           |
| `ConfigError`          | 本来有效的值                                                                                   |
| `NotSupportedError`    | Engine id 与缺失的 Capability                                                                  |
| `EngineOperationError` | Adapter 能识别失败时的 `kind`：`'rate-limit'`、`'context-exceeded'`、`'timeout'`、`'internal'` |

`kind: 'rate-limit'` 是应当据以分支的那一种：它意味着等待后重试，而且被刻意设计成
**不是** `UnauthenticatedError`——Engine 可以连通，登录也没有问题。若某个 Engine
限流时的措辞尚未经过测量，它就不会猜测，而是报告一个完全没有 `kind` 的错误。

## 4. 配置，以及设置何时可写

模型、模式，以及模型应当投入多少思考，在每个 Engine 上都以同一种方式写入。
runskein 会把每个键发送给 Engine 实际使用的名称：

```ts
const session = await hub.session({
  engine: 'claude-code',
  cwd: process.cwd(),
  config: { model: 'sonnet', reasoning: 'high' },
});
```

Engine 之间不同的不是调用方式，而是一个键在**何时**可以写入；`describe()` 会为每个
选项说明这一点：

```ts
const { configOptions } = await hub.describe(engineId);
configOptions.find((o) => o.id === 'effort')?.settable; // undefined | 'creation'
```

`settable: 'creation'` 意味着该 Engine 只在构建 Session 时接受这个设置。
`hub.session({ config })` 会把它放在创建请求上，之后调用 `setConfig()` 则会以
`NotSupportedError` 拒绝，而不会发送一个 Engine 会忽略的写入。没有 `settable`
字段就是通常情形：创建时以及创建后的任何时候均可写入。

**目前没有任何内置 Engine 报告 `settable: 'creation'`。** claude-code 曾经会——
那是 Adapter 声明出来的——直到它的包装器开始自己发布思考深度选项：一个可写的选项，
而那条声明正遮蔽着它。但仍然要读 `settable`：第三方 Adapter 用它，而任何 Engine
都可能在下一个版本开始报告它。这也是上面那些选项 id 用 Engine 自己叫法的原因：
claude-code 的思考深度现在叫 `effort`，而 Adapter 声明当初把它叫作 `reasoning`。
你**写入**时用的键没有变——`config: { reasoning: 'high' }` 仍然会送到 Engine
自己的叫法上——但凡是拿 `describe()` 返回的 id 去匹配的代码，匹配的是 Engine
的词汇表，不是 runskein 的。

由此得出两点。如果你完全不想针对不同 Engine 分支，请在创建时完成所有配置——
这条路径在每个 Engine 上的工作方式都相同。如果想在 UI 中提供实时控件，请读取
`settable`，据此决定哪些应绘制为控件、哪些应绘制为一次性选择，而不是等写入失败
才发现差异。

## 5. 在运行时选择 Engine

一台机器上有三件事可能为真或假，而且它们不是一回事：Engine 已安装、用户已登录，
以及 Engine 支持你想要的功能。应分别检查它们。

```ts
const inventory = await hub.engines(); // cheap; starts no process
const usable = inventory.filter((e) => e.health !== 'invalid' && e.installed && e.authenticated !== false);

const descriptor = await hub.describe('codex'); // starts the engine and asks it
if (!descriptor.capabilities.session.fork) {
  // Pick another flow, or handle NotSupportedError from session.fork().
}
```

`describe()` 会启动一个进程，所以当 UI 反复渲染它时应缓存 descriptor。
Capability 发现是一次预检，不能替代错误处理：Engine 更新后仍可能使调用失败，
所以也要在调用点处理 `NotSupportedError`。

## 6. 两次调用之间的长时间间隔

打开的 Session 会固定占用其 Engine 进程。只有当没有 Session 持有该 Engine 时，
`idleTimeoutMs` 才开始计时；因此，一个跨越长暂停仍保持打开的 Session，会在整个暂停期间
让它接触过的每个 Engine 保持存活，而空闲清理永远不会运行。

对于突发型工作——短时间工作、长时间等待——在一轮突发结束时关闭 Session，
下一轮再按 id resume：

```ts
await session.close();
// ... long gap; engine processes can now be cleaned up ...
const resumed = await hub.session({ engine: 'codex', cwd, resume: task.sessions.codex });
```

目前所有内置 Engine 都原生支持 resume，因此这是一次快速往返，而不是重放全部历史。
`session.resumeTier` 会告诉你实际使用了哪条路径。

根据你自己的间隔模式设置 `idleTimeoutMs`：远低于间隔，让进程真正被回收；
或高于间隔，让进程保持温热以供复用。

## 7. 并发以 Engine 为单位，而且没有任何排队

同一个 Engine 上的每个 Session 共享该 Engine 的单个进程和单条 stdio pipe，
而一个 Hub 不能为同一 Engine 持有两个进程。setup 类请求——创建、resume、fork、
关闭 Session、写入配置——会在 30 秒后超时，繁重的并行负载确实可能超过这个时间：
多个 Engine 同时启动时，live test suite 就会遇到这种情况。轮次不受这个时限约束，
也不受任何其他时限约束，除非你设置 `defaults.turnTimeoutMs`；一个正常的轮次可能运行
数分钟，所以 runskein 不会为它凭空设定上限。

runskein 不会替你排队，因此如果要 fan out，请自行限制每个 Engine 的并发数。
分散到_不同_ Engine 的工作运行在不同进程上，不会相互竞争。

pi 是模型侧唯一的例外：它的 shim 为每个 Session 运行一个 `pi` 子进程，因为一个 pi
进程恰好只容纳一个 Session。ACP pipe 仍然只有一条。

## 8. 关闭

```ts
await hub.quit();
```

`quit()` 会按 Engine 走过一条有界链路——关闭 stdin、`SIGTERM`、等待、
`SIGKILL`——并向整个进程组发送信号，所以包装脚本及其子进程也会一并退出。
在每条退出路径上都要调用它。

被 `SIGKILL` 杀死的宿主根本无法运行它。pipe 关闭后仍不退出的 Engine 会被遗留，
而 runskein 会自行回收它们：下一次运行首次获取 Engine 时，会扫描 ownership registry，
回收它自己的宿主所遗留的进程，之后还会进行周期性扫描。扫描被刻意绑定到获取而不是启动，
所以仅执行检查（`engines()`、`describe()`）的程序永远不会回收任何进程。目前没有任何
内置 Engine 能活过宿主的 `SIGKILL`；claude-code 曾经可以，直到它的包装器被替换，
而 watchdog 正是因此存在。别把这当成承诺——Engine 的下一个版本就可能改变它，
所以那道扫描无论如何都会跑。

## 把 runskein 打包进单个产物

runskein 附带的两个文件是被**作为进程启动**的，不是被 import 的：pi 的 shim，
以及声明了 `supervise` 的 Adapter 用来运行 Engine 的那个「父进程死亡看门狗」。
两者都是相对于需要它们的模块定位的，所以把多个包压平成一个文件的打包器
会搬走代码、把文件留在原地。

这件事不会静默发生。打包后的 Hub 会报出来：

```text
pi  health: 'invalid'
    shim entry point not found: /app/shim.mjs — this path is resolved from the
    module's own location, so a bundler that flattens the package will move it…
```

而声明了 `supervise` 的 Adapter 会在第一次创建 Session 时以 `EngineStartError`
失败，对看门狗说同样的话。补救办法二选一：

- **把运行时资产拷到产物旁边**，保持消息里点明的那个布局；或者
- **把 `runskein` 排除在 bundle 之外**，让它像未打包安装那样在 `node_modules`
  里解析这些文件。

其余一切都能扛过打包。五个内置 Engine 里有四个是靠 `PATH` 上的命令启动的，
自身不带任何文件，所以丢了 pi 的 bundle 仍然保有其余四个 —— 这也正是 Hub 报告
一个 Adapter 无效、而不是拒绝启动的原因。

## 不使用 Engine 测试你的应用

依赖 runskein 不应意味着 CI 需要 Engine 二进制、登录状态和付费模型 token。
`@runskein/testkit` 提供一个会说该协议的脚本化 agent，并按测试要求回复，
因此被测代码走的是真实路径。

```ts
import { createHub, jsonlStore } from 'runskein';
import { scriptedAdapter } from '@runskein/testkit';

const hub = createHub({
  // 五个内置 adapter 仍然是注册着的——`adapters` 是加在它们之上，不是替换它们，
  // 而 `discovery: false`（默认值）只管动态扫描。让这段保持封闭的，是下面那句
  // 选择 `engine: 'scripted'`。
  discovery: false,
  adapters: [scriptedAdapter({ env: { RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' } })],
  store: jsonlStore('.transcripts'),
});

const session = await hub.session({ engine: 'scripted', cwd: process.cwd() });
await session.prompt('hello'); // asks for permission, then ends the turn
```

`RUNSKEIN_TESTKIT_*` 开关记录在
[该包的 README](../packages/testkit/README.md) 中，其中也说明了它_不_承诺什么——
不同版本间，回复字符串与 id 可能变化。只把真实 Engine 留给确实需要它们的测试。

## 另请参阅

- [架构](architecture.md)——什么在哪里运行，以及为什么
- [Engine 支持](engine-support.md)——每个 Engine 能做什么
- [Transcript folding](transcript-fold.md)——把 transcript 转换成 UI 状态
- [API 规范](engine-adapter-api.md)——已冻结的表面
