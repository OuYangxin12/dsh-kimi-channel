# dsh-kimi-channel

本机回环 WebSocket 控制通道，让 Kimi Code 创建或恢复 DSH 会话、下发任务、中途插话、代答审批，并拿回完整轨迹。设计见 `docs/design/kimi-code-dsh-channel-design.md`。

## 它做什么

宿主插件在 `127.0.0.1` 起一个带 token 鉴权的 WebSocket 服务。外部客户端（Kimi 侧 `client.mjs`）通过它：

1. `session.ensure`：按 `conversationKey` 找到或创建 DSH 会话；
2. `prompt.submit` / `prompt.steer` / `prompt.abort`：下发任务、插话、中止；
3. 订阅 `text`、`thinking`、`tool_call`、`tool_result`、`interaction`、`turn_end`、`final` 事件流；
4. `interaction.respond`：代答审批和提问；
5. `events.resume`：断线后按 `seq` 续订；
6. `state.snapshot`：查会话状态和待处理交互。

## 安装

推荐走 Plugin Manager：Web UI → 设置 → 插件 → 从本地目录安装，选本目录，安装后启用 `dsh-kimi-channel` bundle。Plugin Manager 会做依赖安装和 bundle 选择，不要手改 profile 的 `package.json`。

命令行等价写法：

```bash
dsh plugin --profile <profile> add /path/to/kimi-channel
```

装完重启 DSH（或在 Plugin Manager 里确认状态为 applied）。插件加载后监听 `ws://127.0.0.1:8137`，token 写在 `~/.dsh/kimi-channel.token`（0600，每次启动轮换）。

Kimi 侧把 `kimi-skill/dsh-channel/` 整个目录复制到 `~/.kimi-code/skills/dsh-channel/`（目录技能要求 `SKILL.md`，已有 `name`/`description` frontmatter）。复制后对 Kimi Code 说「用 DSH 跑这个任务」即可，`--cwd` 和审批策略由 skill 说明里的命令行控制。

## 配置

`~/.dsh/kimi-channel.json`，全部字段可选，文件配置覆盖 Loader 行配置：

```json
{
  "host": "127.0.0.1",
  "port": 8137,
  "tokenFile": "~/.dsh/kimi-channel.token",
  "rotateTokenOnStart": true,
  "sessionMapFile": "~/.dsh/kimi-channel-sessions.json",
  "eventBufferSize": 2000,
  "interactionTimeoutMs": 120000,
  "autoAllowTools": ["read", "glob", "grep", "session_search", "web_search"],
  "allowCwdRoots": ["/home/you/projects"],
  "defaultCwd": "/home/you/projects",
  "streamDeltas": false,
  "agentPreset": "standard",
  "agent": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" }
}
```

- `host` 只能是回环地址，否则插件拒绝启动；
- `autoAllowTools` 默认只读工具，支持 `tools.*` 前缀通配；
- `allowCwdRoots` 限制 `session.ensure` 能打开的目录，越界返回 `CWD_NOT_ALLOWED`；
- `agent` 留空时用 DSH 的默认模型选择；
- `agentPreset` 决定通道创建的 agent 挂哪套预设。**必须挂预设**，否则 agent 只有 root 工具（`working_directory`），拿不到 fs / bash / 搜索这些工具。留空时用注册表的默认预设（通常是 `standard`）。

## 协议

帧三类：`req` / `res` / `evt`。请求带客户端生成的 `id` 做幂等，事件带单调 `seq`。完整方法表见 `lib/protocol.mjs`，错误码是封闭集合（`BAD_FRAME`、`BAD_VERSION`、`BAD_PARAMS`、`UNKNOWN_METHOD`、`NOT_FOUND`、`CWD_NOT_ALLOWED`、`SESSION_FAILED`、`INTERNAL` 等）。

## 安全边界

- 只绑回环地址，拒绝非回环来源；
- token 0600、每次启动轮换；
- 审批超时按拒绝处理，客户端断开后审批不会挂住；
- 只对通道自己创建的 agent 应答审批/提问，其他会话一律交给下一个应答方（Web UI 行为不变）。

## 测试与验证

```bash
cd kimi-channel && node --test test/*.test.mjs   # 49 项单测与通道集成测试
node e2e/run-e2e.mjs                             # 一次性真实 DSH 端到端，见 e2e/README.md
```

单测覆盖协议校验、WebSocket 帧与握手、会话映射持久化、事件投影、审批白名单与超时、增量流、坏帧不断连。端到端验证了工具轮次、会话复用、审批放行/拒绝、事件重放；最近一次 21/21 通过，结果在 `e2e/last-report.json`。

## 已知限制

1. 只支持单个 DSH 宿主进程；多实例共享 8137 端口会冲突，用 `port` 区分。
2. 只做回环，不做跨机器；跨机留待 outbound 连接器。
3. 协议不做跨 DSH 版本兼容承诺，DSH 插件 API 变就一起改。
4. 审批白名单按工具名匹配，不细到参数；需要参数级策略时在客户端补。
