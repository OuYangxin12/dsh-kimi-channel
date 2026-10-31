# 端到端验证

`run-e2e.mjs` 用一次性环境验证整条链路：独立 `DSH_HOME`、独立回环端口、真实模型轮次。跑完自动清理，结果写进 `last-report.json`。

## 跑

```bash
# 需要 OPENCODE_GO_API_KEY 或 OPENCODE_API_KEY（环境变量或 ~/.config/secrets.env）
node e2e/run-e2e.mjs

# 只验证协议/传输，不调模型
node e2e/run-e2e.mjs --no-model

# 保留临时 DSH home 和工作目录供排查
node e2e/run-e2e.mjs --keep
```

脚本做的事：

1. `dsh --profile e2e --from-default-profile web --dump-config` 在 `.e2e-run/dsh-home` 造一个一次性 profile；
2. 把 `kimi-channel/` 软链进该 profile 的 `node_modules`，写 `cordis.patch.yml`（模型路由 + 插件入口）和 `kimi-channel.json`（端口、token、白名单、cwd 根）；
3. 起 `dsh --profile e2e --port 0`，等 `kimi-channel.token` 出现并轮询 `/healthz`；
4. 用 `kimi-skill/dsh-channel/client.mjs` 按 Kimi Code 的用法跑场景；
5. 汇总检查项、写 `last-report.json`、杀掉 DSH、删临时目录。

## 断言清单

| 场景 | 断言 |
| --- | --- |
| 启动与鉴权 | token 文件存在且 0600；`health` 返回 ok |
| 工具轮次 | 一轮里读两个文件、写一个文件；`final.trajectory` 含 tool_call/tool_result；`usage` 有 token 数；文件内容正确 |
| 会话复用 | 同一 `conversationKey` 的第二次提交复用同一 session，turn 递增 |
| 审批放行 | `bash` 以 `danger-full-access` 触发 `interaction`，带 reason；`--allow bash` 后命令执行成功 |
| 审批拒绝 | 不放行时工具返回拒绝原因且轮次正常结束 |
| 断线续订 | `events.resume(since=0)` 返回事件，`seq` 严格递增 |

## 最近一次结果

21 项检查全过，见 `last-report.json`。单元与集成测试另跑：

```bash
cd kimi-channel && node --test test/*.test.mjs   # 49 项
```

## 注意

- 模型路由写死在脚本里（`opencode-go/deepseek-v4.1-flash`）；换路由改 `bootDsh` 里的 patch。
- 审批场景依赖模型愿意按指令带 `sandbox_permissions=danger-full-access`，换模型后该场景可能需要调整提示词。
- 脚本不改动当前正在使用的 profile；验证完环境恢复原状。
