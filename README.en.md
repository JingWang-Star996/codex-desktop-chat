# ChatGPT Desktop Bridge

[中文](README.md) | [English](README.en.md)

Codex can send tasks directly to a ChatGPT conversation you choose. DSH, WorkBuddy, and other assistants can also hand off tasks to a Windows Codex Desktop session with the native tools to send messages, retrieve replies, and verify the results.

## One-step deployment

Copy the prompt below into Codex Desktop, DSH, WorkBuddy, or another assistant.

```text
Help me set up the ChatGPT Desktop Bridge at https://github.com/JingWang-Star996/codex-desktop-chat. If you are running in a Windows Codex Desktop session with the native tools to send and read messages, download the repository to a permanent local folder, run scripts/install.ps1 as described in README.en.md, and follow the plugin skill to bind the dedicated Chat I specify. I will select Pro myself in ChatGPT. I authorize one connectivity test with no business data, sent only to the conversation I confirm. Retrieve the full reply and verify its SHA-256 hash. When I say “Ask ChatPro” in the future, use that bound desktop Chat by default. If you are DSH, WorkBuddy, or another assistant, first check whether you have an authorized way to hand this setup task to a Codex Desktop session with those tools and read back its result. If you lack that access, give me this setup prompt to paste into Codex Desktop.
```

## Choose an access path

| Caller | Route | Verification |
| --- | --- | --- |
| Codex Desktop | `Codex → bound ChatGPT conversation`. Use the native desktop tools to send and read messages. | Codex matches the reply to the task, retrieves the full text, and verifies its SHA-256 hash. |
| DSH, WorkBuddy, or another assistant | `External assistant → Codex Desktop → bound ChatGPT conversation`. Use an authorized way to reach the Codex Desktop session. If one is unavailable, the user pastes the task packet into Codex Desktop. | Codex sends and verifies the reply. For an automated handoff, confirm that the original caller receives the matching result. |

Run the preflight in the **Codex session that will actually handle the task**. Launching `codex exec`, running a wrapper, or reading the plugin ledger only confirms access to that particular interface. For an automated handoff, verify that the session can use `send_message_to_thread` and `read_thread` and that the caller can retrieve the Codex result. Test each integration with a separate round trip that contains no business data.

### Handoff template for external assistants

Give this task packet to a Codex session with the native desktop tools. In `authorization`, provide a verifiable reference to the user's permission for the purpose, destination, and material to be sent. If Codex cannot verify it, the user confirms it in Codex.

```text
Follow the call-desktop-chat skill and return the result.
work_unit_id: <stable task ID to reuse when resuming>
goal: <specific question for ChatGPT>
context: <minimum material approved for sending>
acceptance: <reply format and acceptance criteria>
authorization: <verifiable reference to the user's authorization>
```

Codex returns the `work_unit_id`, current status, the result or an accessible location, the SHA-256 hash, and any open items. If the send outcome is unclear, check the same conversation under the original task ID to avoid duplicate sends.

## Installation

You need Node.js 22 or later, PowerShell 7, a Codex CLI that supports plugin commands, and a Codex Desktop session with access to `send_message_to_thread` and `read_thread`.

Clone or extract the repository to a permanent local folder, then run the following command from that folder.

    pwsh -NoProfile -File .\scripts\install.ps1

The installer writes the local MCP configuration using the current folder. If the session has yet to load the ledger tools, run `node .\src\server.mjs status` from the installation folder to check the ledger. Sending and reading messages still require the native desktop tools.

## First-time binding and everyday use

1. In ChatGPT Desktop, create or select a dedicated conversation. To use Pro, choose an available Pro model in that conversation yourself.
2. Tell Codex which conversation to bind. Follow the [desktop Chat skill](skills/call-desktop-chat/SKILL.md) to locate and bind it. The bridge uses the model you chose and records the actual model as `unknown`.
3. With your explicit authorization, Codex can send one connectivity test with no business data. It checks that the task matches exactly once, the end marker is present, and the full reply is retrieved and verified with SHA-256.
4. In a Codex session with the native desktop tools, you can then say “Ask Chat to review this proposal.”

The ledger lives in your local user directory. The bound conversation retains its history. The bridge asks Chat to reply in Chinese by default. The native readback limit is 20,000 characters per message. If the send outcome is unclear, read back the same task ID to avoid sending again.

## Local tests

    npm test

The local tests cover idempotency, recovery from an unclear send outcome, task matching, reply truncation, and hash verification. Run a separate end-to-end test in the user's desktop session to verify a real round trip.
