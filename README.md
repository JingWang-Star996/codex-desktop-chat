# ChatGPT 桌面直连

从 Windows 上的 Codex 桌面会话向用户指定的普通 Chat 发送一个有界任务，再收回完整文字结果。桌面原生工具负责发送和读回，插件负责保存任务状态、拦截重复发送和校验回复。

## 一键部署

复制下面这段提示词，粘贴到 Windows 上的 Codex 桌面会话。

```text
请帮我部署 ChatGPT 桌面直连插件。把 https://github.com/JingWang-Star996/codex-desktop-chat 下载到长期保留的本地目录，按 README 运行 scripts/install.ps1，确认当前会话具备桌面发送和读回工具，再按插件技能绑定我指定的专用 Chat。我会在 ChatGPT 里自己选择 Pro，并授权你只向我确认的聊天发送一条不含业务数据的连通测试。请收回完整回复并校验 SHA-256。以后我说“问下 ChatPro”，就默认用这个已绑定的桌面 Chat。
```

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

台账保存在本机用户目录。绑定会话沿用既有历史。原生接口单条回复读回上限为 20,000 字符。发送结果不明确时，用原任务 ID 只读核对，避免重复发送。

## 本地测试

    npm test

本地测试覆盖幂等、未知发送恢复、任务匹配、回复截断和哈希校验。真实桌面往返需在使用者的会话中单独验收。
