# ChatGPT 桌面直连

[中文](README.md) | [English](README.en.md)

Codex 可以直接调用用户指定的 ChatGPT 聊天。DSH、WorkBuddy 或其他助手也可以把任务交给 Windows 上具备原生工具的 Codex 桌面会话，由它完成发送、读回和校验。

## 一键部署

复制下面这段提示词，粘贴给 Codex 桌面、DSH、WorkBuddy 或你正在用的其他助手。

```text
请帮我接入 ChatGPT 桌面直连插件 https://github.com/JingWang-Star996/codex-desktop-chat 。如果你当前是具备桌面发送和读回工具的 Windows Codex 桌面会话，请把仓库下载到长期保留的本地目录，按 README 运行 scripts/install.ps1，再按插件技能绑定我指定的专用 Chat。我会在 ChatGPT 里自己选择 Pro，并授权仅向我确认的聊天发送一条不含业务数据的连通测试。请收回完整回复并校验 SHA-256。以后我说“问下 ChatPro”，就默认用这个已绑定的桌面 Chat。如果你是 DSH、WorkBuddy 或其他助手，请先检查能否通过已授权的入口把这次部署任务交给具备上述工具的 Codex 桌面会话，并读回结果。缺少入口时，请把这段部署要求交还给我，我会粘贴到 Codex 桌面会话继续。
```

## 选择接入路径

| 发起方 | 调用方式 | 验收 |
| --- | --- | --- |
| Codex 桌面 | `Codex → 已绑定的 ChatGPT`。直接用桌面发送和读回工具。 | Codex 验证任务匹配，取回全文并核对 SHA-256。 |
| DSH、WorkBuddy 或其他助手 | `外部助手 → Codex 桌面 → 已绑定的 ChatGPT`。有经授权的 Codex 桌面接入时可接力。缺少入口时，由用户把任务包粘贴到 Codex 桌面。 | Codex 完成发送与验收。自动接力还要确认原发起方收到了对应回执。 |

预检以**实际承接任务的 Codex 会话**为准。能启动 `codex exec`、调用封装命令或读取插件台账，只证明这些入口可用。自动接力仍需确认该会话能调用 `send_message_to_thread` 和 `read_thread`，且发起方能读回 Codex 的结果。每种接入方式需要独立做一次无业务数据的往返测试。

### 外部助手交接模板

把下面的任务包交给具备桌面原生工具的 Codex 会话。`authorization` 填可核验的用户授权出处，包含本次目的、发送目标和获准发送的材料范围。授权无法核验时，由用户在 Codex 中确认。

```text
请按 call-desktop-chat 技能执行并回传结果。
work_unit_id: <本次任务的固定 ID，恢复时沿用>
goal: <交给 ChatGPT 的具体问题>
context: <获准发送的最少材料>
acceptance: <回复格式和验收条件>
authorization: <可核验的用户授权出处>
```

Codex 回传 `work_unit_id`、当前状态、结果或可访问的结果位置、SHA-256 和待处理项。发送结果不明确时，用原任务 ID 读回同一会话，避免重复发送。

## 安装

需要 Node.js 22 或更新版本、PowerShell 7、支持插件命令的 Codex CLI，以及能访问 `send_message_to_thread` 和 `read_thread` 的 Codex 桌面会话。

克隆或解压到一个长期保留的本地目录，在该目录运行：

    pwsh -NoProfile -File .\scripts\install.ps1

安装脚本按当前目录生成本机 MCP 配置。若当前会话尚未加载台账工具，可在安装目录运行 `node .\src\server.mjs status` 检查台账。发送和读回仍需桌面原生工具。

## 首次绑定与日常调用

1. 用户在 ChatGPT 桌面创建或选定一个专用普通 Chat。需要 Pro 时，在该 Chat 中自行选择可用的 Pro 模型。
2. 在 Codex 里指定该 Chat，按 [桌面 Chat 调用技能](skills/call-desktop-chat/SKILL.md) 执行只读定位和绑定。沿用用户所选模型，实际模型记为 `unknown`。
3. 明确授权后，可发送一条不含业务数据的连通测试，验证唯一任务匹配、结束标记、全文回收和 SHA-256。
4. 以后在具备桌面原生工具的 Codex 会话中直接说“让 Chat 帮我复核这份方案”。

台账保存在本机用户目录。绑定会话沿用既有历史。插件默认请求 Chat 用中文回复。原生接口单条回复读回上限为 20,000 字符。发送结果不明确时，用原任务 ID 只读核对，避免重复发送。

## 本地测试

    npm test

本地测试覆盖幂等、未知发送恢复、任务匹配、回复截断和哈希校验。真实桌面往返需在使用者的会话中单独验收。
