# Kimi Code 管理者配置

这个目录是 Kimi Code 当“中层管理者”、DSH 当执行者的配置来源。三层约束从软到硬：

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 指令层 | `AGENTS.manager.md` → `~/.kimi-code/AGENTS.md` | 角色定义、硬规则、委托简报模板、验收清单、汇报格式。全局生效，每个会话都带。 |
| 工具层 | `dsh-channel/` → `~/.kimi-code/skills/dsh-channel/` | 派活的唯一通道：`submit` / `watch` / `steer` / `abort` / `report`。 |
| 权限层 | `~/.kimi-code/config.toml` | `default_permission_mode = "manual"`，`[permission] deny` 硬拒 `Write` / `Edit`。Kimi 想自己写文件时会直接失败。 |

## 流程规则（v2）

- **任务分级**：L0 琐碎（单文件、≤5 行、无行为变化）用三项简版简报；L1 常规用全量八项；L2 高风险（删除、跨模块重构、改构建/依赖、迁移）先把简报给你确认再提交。判不准按高一级。
- **验证类命令**：构建、测试、lint、typecheck、只读 git 可以由管理者自己跑，但每条要你批准；安装、迁移、部署、commit/push 仍归 DSH 或你决定。验证命令不能用来产出交付物。
- **并行**：同文件互斥，不相交范围可并行；lockfile、构建配置、schema、迁移目录等共享资源互斥；默认 2–3 个 worker。
- **故障降级**：health 连续 3 次失败且间隔 ≥2 分钟，管理者必须报告并给两个选项；只有你明确同意才能当次破例，且要在汇报里标注。
- **交付格式**：简报固定要求 DSH 在 final 里给 `git diff --stat`、每文件一句话、验证命令与结论。

## 安装

```bash
# 指令层
cp kimi-skill/AGENTS.manager.md ~/.kimi-code/AGENTS.md

# 工具层
mkdir -p ~/.kimi-code/skills
cp -r kimi-skill/dsh-channel ~/.kimi-code/skills/dsh-channel

# 权限层：备份后加两段配置
cp ~/.kimi-code/config.toml ~/.kimi-code/config.toml.bak
# 1) 文件顶部加一行：default_permission_mode = "manual"
# 2) 文件末尾加：
#    [permission]
#    deny = [
#      { tool = "Write", reason = "Manager role: delegate file writes to DSH." },
#      { tool = "Edit", reason = "Manager role: delegate file edits to DSH." },
#    ]
```

改完重启 Kimi Code，新会话才生效。

## 验证

在 Kimi Code 新会话里依次试：

1. 让它“把 `a.txt` 的内容改成 xxx”。它应该拒绝并转交 DSH，或工具报 `Write` 被拒。
2. 让它“用 DSH 把 `a.txt` 改成 xxx”。它应该走 `client.mjs submit`，然后 `watch`、`report`，最后按四段式汇报。
3. 观察 Bash 是否逐条请求批准（manual 模式），批准后客户端命令能跑。

DSH 侧前置条件：`dsh-kimi-channel` 插件已安装并启动，`~/.dsh/kimi-channel.token` 存在，`curl http://127.0.0.1:8137/healthz` 返回 ok。

## 回滚

```bash
rm ~/.kimi-code/AGENTS.md
rm -rf ~/.kimi-code/skills/dsh-channel
cp ~/.kimi-code/config.toml.bak-<时间戳> ~/.kimi-code/config.toml
```

## 限制

- `Bash` 不能硬禁，因为客户端本身就是一条 node 命令。它处于 `manual` 模式，每条由用户批准；配合指令层禁止用 shell 写文件。
- 权限规则挡的是 Kimi 自己的 `Write` / `Edit`，挡不住用户亲手批准一条 `sed -i`。看到这类命令直接拒绝。
- 管理层判断质量取决于委托简报。简报缺验收标准，DSH 就会自由发挥。
