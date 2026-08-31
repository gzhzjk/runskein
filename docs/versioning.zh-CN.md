<!--
source: docs/versioning.md
source-sha256: 00a4587387f592bff88b70e909d42648f3e76fd886a8965bd396555a017d8323
-->

# 版本与发布

一个版本号在这里意味着什么、它带着哪些包、以及去哪里看改了什么。

## 一条版本线

发布的包有九个，一次发布是**九个包同一个版本**：

| 包                              |                                      |
| ------------------------------- | ------------------------------------ |
| `runskein`                      | 元包，捆绑五个 adapter               |
| `@runskein/core`                | `Hub`、`Session`、transcript、注册表 |
| `@runskein/fold`                | 把 transcript 变成 UI 状态           |
| `@runskein/testkit`             | 脚本化 agent，供你自己的测试使用     |
| `@runskein/adapter-claude-code` | 每个 engine 一个                     |
| `@runskein/adapter-codex`       |                                      |
| `@runskein/adapter-kimi`        |                                      |
| `@runskein/adapter-opencode`    |                                      |
| `@runskein/adapter-pi`          |                                      |

它们之间刻意没有兼容性矩阵。`@runskein/core` 0.1.0 只配 `@runskein/fold`
0.1.0，别的都不配——混用版本既没测过也不支持，而元包把它的 adapter 钉死在自己
这个版本上，就是为了让最常见的用法不可能弄错。

`packages/cli` 与 `packages/conformance` 是开发工具，不发布。想要它们就克隆仓库。

## 版本号的含义

版本号形如 `0.1.0`，其中两半各自有含义：

- **`0.x` —— 1.0 之前。** v1 这个*接口面*已经冻结，写在
  [API 规范](engine-adapter-api.md)里；而它的实现是预览版。只要版本还停在
  `0.x`，一次发布就可能改掉消费者依赖的行为。
- **最后一个数字是发布计数。** 每发布一次加一。没有并行的补丁线，也没有
  backport：**最新的发布版本是唯一受支持的版本**，修复走下一个版本。

`0.1.0` 之前的每一个版本都是预发布——`0.1.0-alpha.25`、`0.1.0-beta.1`——只能通过
它自己的 tag 拿到。那些 tag 现在仍然能解析，而它们背后的东西不再维护。

## 安装

`npm install runskein`。不需要 tag：`0.1.1` 在九个包上都发布在 `latest` 下。

Node.js 22 或更高，仅 ESM。

## 去哪里看改了什么

- **单次发布** —— 挂在该版本 tag 上的 GitHub Release。tag 就是裸版本号，不带
  `v` 前缀：`0.1.0`。
- **接口面的变更** —— [`docs/decisions/`](decisions/)。冻结的 v1 接口面每改一次
  都有一份编号记录，写明决定了什么、为什么。release note 会点名它带的那几份记录。
- **每个 engine 实测能做什么** —— [能力矩阵](capability-matrix.md)，由针对真实
  engine 的探测重新生成。它是探测那台机器的快照；你自己机器上的事实是
  `hub.engines()` 与 `hub.describe()`。

tag 可能比它的发布页早一点出现：仓库是在晋升之前打 tag 的，而发布页要等包真的上了
npmjs 才挂上去。

## 一次发布是怎么到这个仓库的

RunSkein 在一个私有仓库里开发，再导出到这里，**一次发布一个 commit**。所以这个
仓库的历史是**按发布粒度、不是按改动粒度**的：你找不到修某个 bug 的那一个
commit，而安全修复到达的方式与其他所有改动完全相同——见
[SECURITY.md](../SECURITY.md)。

实际含义是：你在某个 tag 上看到的这棵树，正是那次发布的包所构建自的东西，而这里
的 `git log` 就是一份发布清单。
