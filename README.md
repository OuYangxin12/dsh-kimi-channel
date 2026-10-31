# dsh-kimi-channel

把 **Kimi Code** 变成管理者，把 **DeepSeek Harness（DSH）** 当成干活的执行者。

A loopback control channel plugin for DeepSeek Harness plus a Kimi Code skill, so Kimi Code can create/resume DSH sessions, delegate tasks, supervise turns, answer approvals, and review full trajectories as a manager instead of doing the work itself.

## 它解决什么

直接让 Kimi Code 干活有两个问题：它没有 DSH 的工具、插件、会话和模型；而你真正想要的是一个“想清楚、派清楚、盯住、验干净”的管理者，不是一个抢着写代码的助手。

这套东西把两边接起来：

```text
用户
  │  任务 + 约束
  ▼
Kimi Code（管理者）──管理章程 + skill──▶ dsh-kimi-channel 客户端
                                           │  submit / watch / steer / abort / report
                                           │  ws://127.0.0.1:8137 + token
                                           ▼
                              dsh-kimi-channel 插件（DSH 宿主内）
                                           │  ctx.agents / session events / approval waterfall
                                           ▼
                              DSH 会话：真正读写文件、跑命令、响应审批
```

- **Kimi 侧**：`kimi-skill/` 是管理者 preset，包含章程（`AGENTS.manager.md`）、技能（`dsh-channel/SKILL.md`）和零依赖客户端（`client.mjs`）。
- **DSH 侧**：`kimi-channel/` 是宿主插件，在回环地址起 WebSocket，按 `conversationKey` 建会话、投影事件、代答审批。
- **权限硬化**：`[permission] deny` 硬拒 Kimi 自己的 `Write`/`Edit`，`Bash` 走 manual 逐条批准。管理者不能自己动手，只能派活。

## 目录

```text
kimi-channel/            DSH 宿主插件
  index.js               插件入口（inject: agents）
  lib/channel.mjs        回环服务、方法分发、会话/轮次桥接、事件投影
  lib/ws.mjs             零依赖 RFC6455 服务端子集
  lib/protocol.mjs       v1 帧校验、方法表、错误码
  lib/interactions.mjs   审批/提问代答、白名单、超时拒绝
  lib/projection.mjs     DSH 事件 → text/thinking/tool_call/tool_result/turn_end/final
  lib/store.mjs          会话映射持久化 + seq 重放缓冲
  test/                  49 项单测与集成测试
kimi-skill/              Kimi Code 侧
  AGENTS.manager.md      管理者章程（装到 ~/.kimi-code/AGENTS.md）
  dsh-channel/           skill：SKILL.md + client.mjs
  README.md              安装、验证、回滚
e2e/                     一次性真实 DSH 的端到端验证（25 项断言）
docs/design/             设计说明
```

## 快速开始

前置：DSH（0.2.x）、Kimi Code、同一台机器、Node ≥ 22。

1. **装插件**（DSH 侧）：Web UI → 设置 → 插件 → 从本地目录安装 `kimi-channel/`，启用 `dsh-kimi-channel`，重启 DSH。命令行等价：`dsh plugin --profile <profile> add ./kimi-channel`。
2. **确认通道**：`curl http://127.0.0.1:8137/healthz` 返回 `{"ok":true,...}`，`~/.dsh/kimi-channel.token` 存在（0600，每次启动轮换）。
3. **装管理者 preset**（Kimi 侧）：
   ```bash
   cp kimi-skill/AGENTS.manager.md ~/.kimi-code/AGENTS.md
   mkdir -p ~/.kimi-code/skills
   cp -r kimi-skill/dsh-channel ~/.kimi-code/skills/dsh-channel
   ```
4. **权限硬化**（可选，推荐）：在 `~/.kimi-code/config.toml` 顶部加 `default_permission_mode = "manual"`，末尾加：
   ```toml
   [permission]
   deny = [
     { tool = "Write", reason = "Manager role: delegate file writes to DSH." },
     { tool = "Edit", reason = "Manager role: delegate file edits to DSH." },
   ]
   ```
5. 重启 Kimi Code，新会话生效。

详细步骤和回滚见 [kimi-skill/README.md](kimi-skill/README.md)。

## 管理者的工作方式

```bash
# L0 琐碎任务：一次跑完
node client.mjs run --conversation typo-fix --cwd ~/repo --task "把 README 第 3 行的 teh 改成 the" --allow write

# L1/L2：派活、盯进度、纠偏、验收
node client.mjs submit --conversation feature-x --cwd ~/repo --task "<八项简报>" --allow write,edit
node client.mjs watch  --conversation feature-x --report /tmp/feature-x.json
node client.mjs steer  --conversation feature-x --text "只改 X，不要动 Y"
node client.mjs report --conversation feature-x
```

任务分级（L0/L1/L2）、八项简报模板、验收清单、并行规则、故障降级都写在 [kimi-skill/AGENTS.manager.md](kimi-skill/AGENTS.manager.md) 和 [kimi-skill/dsh-channel/SKILL.md](kimi-skill/dsh-channel/SKILL.md)。

## 协议

JSON over WebSocket，三类帧：`req` / `res` / `evt`。请求带客户端 `id` 做幂等，事件带单调 `seq`，断线用 `events.resume(since)` 续订。

方法：`session.ensure`、`prompt.submit`、`prompt.steer`、`prompt.abort`、`interaction.respond`、`state.snapshot`、`events.resume`、`health`。

事件：`text`、`thinking`、`text_delta`、`thinking_delta`、`tool_call`、`tool_result`、`interaction`、`turn_end`、`final`、`status`、`error`。

## 验证

```bash
cd kimi-channel && node --test test/*.test.mjs   # 49 项
node e2e/run-e2e.mjs                             # 25 项，真实 DSH + 真实模型
```

e2e 覆盖：工具轮次、会话复用、审批放行与拒绝、submit/watch/report 管理闭环、事件重放、坏帧不断连。需要 `OPENCODE_GO_API_KEY` 或 `OPENCODE_API_KEY`（环境变量或 `~/.config/secrets.env`）。详见 [e2e/README.md](e2e/README.md)。

## 安全边界

- 只绑定 `127.0.0.1`，拒绝非回环来源；不开放公网端口。
- token 存 `~/.dsh/kimi-channel.token`，权限 0600，每次 DSH 启动轮换。
- 审批默认只读白名单自动放行，写文件/命令逐次决策，超时按拒绝处理。
- 插件只应答自己创建的 agent 的审批/提问，其他会话一律交回 DSH Web UI。
- `allowCwdRoots` 限制会话可打开的目录。

## 已知限制

- 单机单实例：同一端口只能一个 DSH 进程占用；多 profile 需各自配置端口。
- 不做跨机器；跨机接入留给 outbound 连接器。
- DSH 插件 API 处于 0.2.x 预览期，不承诺跨版本协议兼容。
- 审批白名单按工具名匹配，不细到参数。
- Kimi 的 `Bash` 无法硬禁（客户端本身是 node 命令），靠 manual 模式逐条批准；不要批准 `sed -i`、`tee` 这类写文件命令。

## License

[MIT](LICENSE)
