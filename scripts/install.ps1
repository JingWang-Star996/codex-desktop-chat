$ErrorActionPreference = 'Stop'
$pluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverPath = Join-Path $pluginRoot 'src\server.mjs'
if (-not (Test-Path -LiteralPath $serverPath)) { throw 'Missing desktop Chat server' }
$mcp = @{ mcpServers = @{ desktop_chat = @{ command = 'node'; args = @($serverPath, '--stdio') } } }
$mcp | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $pluginRoot '.mcp.json') -Encoding utf8NoBOM
& codex plugin marketplace add $pluginRoot --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed' }
& codex plugin add 'codex-desktop-chat@local-desktop-chat' --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed' }
Write-Output 'Installed. This chat may use the documented CLI immediately. Verify plugin discovery in the Codex desktop session before sending.'
