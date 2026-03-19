# whipflow

AI workflow automation for [harness.farm](https://harness.farm).

## Setup

```bash
bun install
```

## Run a flow

```bash
whipflow run flows/hello.whip
```

## Install skills into Claude Code

```bash
whipflow install-skills
```

Then use `/whipflow` in any Claude Code session.

## Add a new flow

Create a `.whip` file in `flows/` and run it with:

```bash
whipflow validate flows/my-flow.whip
whipflow run flows/my-flow.whip
```

## ACP mode

whipflow can act as an **MCP-compatible tool server** so other agents (Cursor, Claude Code, etc.) can call it over JSON-RPC 2.0 via stdio.

```bash
whipflow acp
```

Register it in `.cursor/mcp.json` or any MCP-compatible host:

```json
{
  "mcpServers": {
    "whipflow": {
      "command": "whipflow",
      "args": ["acp"]
    }
  }
}
```

### Exposed tools

| Tool | Description |
|------|-------------|
| `whipflow_run_file` | Execute a `.whip` workflow file |
| `whipflow_run_source` | Execute inline `.whip` source code |
| `whipflow_validate` | Validate `.whip` syntax without running |

## Configuration

Project-level config in `.whipflow.json`:

```json
{
  "providers": {
    "mymodel": {
      "bin": "opencode",
      "args": ["run"],
      "promptMode": "arg"
    }
  },
  "defaultProvider": "claude",
  "conditionProvider": "claude",
  "toolsDir": "~/.whipflow/tools"
}
```

`defaultProvider` sets the provider for all sessions when not specified on the agent (default: `claude-code`).
`conditionProvider` overrides the provider for `discretion` and `choice` evaluation only; falls back to `defaultProvider`.
