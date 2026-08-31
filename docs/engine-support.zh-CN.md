<!--
source: docs/engine-support.md
source-sha256: 443704aa661af788e619cdd7274e6ca586264c25a42a27ab04da4c5904e6673d
-->

# Engine 支持

runskein 内置了 OpenCode、Kimi Code、Claude Code、Codex 和 pi 的 Adapter。
Adapter 让一个 Engine 可被发现，但并不会让每一项 Engine 特有的协议特性都普遍可用。
在选择 Engine 或启用可选特性时，消费者应当依据下面的 Capability 层级与运行时发现规则。

## Capability 层级

| 层级               | 消费者契约                                                                                                       | 如何使用                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Core（核心）       | 在每一个可注册的 Adapter 上都能通过 runskein 使用；Core 门禁不通过则该 Adapter 无法注册。                        | 直接调用，并处理其文档化的类型化错误。                                                                             |
| Negotiated（协商） | 仅当所选 Engine 声明了该 Capability 时可用。Capability 缺失时抛出 `NotSupportedError`；runskein 绝不会静默忽略。 | 在设计依赖该 Capability 的流程前先读取 `hub.describe(id).capabilities`，并在运行时变化时处理 `NotSupportedError`。 |
| Emulated（模拟）   | 当 Engine 缺少原生协议特性时，由 runskein 补齐该行为。                                                           | 直接调用；若返回结果记录了实际走的路径（例如 `session.resumeTier`），再据此检查。                                  |

Core 描述的是 runskein 的契约，而不是断言本地已安装或已认证某个二进制。
本地事实由 `hub.engines()` 提供；`health: 'not-installed'`、
`health: 'unauthenticated'` 或 `health: 'invalid'` 的 Engine 不能用于新建 Session。

## 在运行时发现 Capability

用 inventory 判断本地可用性，用 descriptor 获取所选 Engine 的实时协议表面。
`engines()` 不会启动进程；`describe()` 会，所以当界面需要反复渲染时，
应缓存或复用该 descriptor。

```ts
import { createHub } from 'runskein';

const hub = createHub();
const engines = await hub.engines();
const codex = engines.find(
  (engine) => engine.id === 'codex' && engine.installed && engine.authenticated !== false,
);

if (!codex) throw new Error('Codex is not installed or is not authenticated.');

const descriptor = await hub.describe(codex.id);
if (!descriptor.capabilities.session.fork) {
  // Select a no-fork workflow before creating a session.
  console.log('This Codex installation does not advertise session/fork.');
}
```

Capability 发现是一次预检，不能替代错误处理。CLI 升级或 Engine 故障仍可能让一次协商调用
以 `NotSupportedError` 拒绝；请在调用点处理该错误。

`EngineDescriptor.capabilities` 是公开的归一化 Capability 映射：

| 字段          | 示例                                                     |
| ------------- | -------------------------------------------------------- |
| `loadSession` | 声明支持原生历史加载。                                   |
| `session`     | `resume`、`fork`、`list`、`delete` 及其他 Session 操作。 |
| `prompt`      | `image`、`audio`、`embeddedContext` 输入。               |
| `mcp`         | `http` 与 `sse`MCP 传输。                                |
| `providers`   | Engine 支持 provider 发现。                              |

该映射刻意保持开放：随着底层协议演进，可能出现新的归一化 Capability 键。
把缺失的键视为不支持，而不是视为错误。

## 实测的内置支持

每个内置 Engine 在其被探测的版本上究竟声明了以上哪些 Capability，是一张生成的
表：**[capability-matrix.md](capability-matrix.md)**（英文单语，因为它是生成物）。
它同时给出每项功能的层级与 API，因此"这个 Engine 能不能做 X"和"做不到时会发生
什么"在同一处就能回答。

它是某一次探测运行的 snapshot，不是对每个 CLI 版本的兼容性承诺。想知道你正在
运行的这台机器上有什么，用上面讲的 `hub.engines()` 与 `hub.describe()`——那才是
运行时事实，也是程序应当据以分支的依据。

## 保持本页最新

原始矩阵由真实 Engine 探测生成：

```sh
pnpm --filter @runskein/conformance probe
```

探测写出的是 `docs/conformance/matrix.json`，它不发布——里面记着跑探测那台机器的
provider 配置。表读的是它的一份投影，所以下一步先刷新投影，再生成表：

```sh
node scripts/project-conformance-matrix.mjs --write
node scripts/generate-capability-tables.mjs
```

每当受支持 Engine 的可观察 Capability、检测结果、支持版本或 Capability 层级发生
变化时，应在同一次改动中刷新这三者。只要原始矩阵在，`pnpm quality` 两步都查，而先
失败的是投影那一步——在过期投影之上重新生成的表，一样是过期的。矩阵不在的地方两步
都查不了：投影那一步会报「没有可比对的东西」然后干净退出，所以那里跑绿了，并不说明
这些表是新的。
不要仅凭 Adapter 元数据推断出一行新记录：协商 Capability 的来源是运行时探测输出。

完整的 API 类型、错误契约与生命周期行为，见已冻结的
[API 规范](engine-adapter-api.md)。
