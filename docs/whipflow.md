# Whipflow

AI workflow automation for [harness.farm](https://harness.farm).

---

## Install

```bash
npm i -g @harness.farm/whipflow
```

Or run without installing:

```bash
npx @harness.farm/whipflow run flows/my-flow.whip
```

---

## CLI Commands

```bash
whipflow run <file.whip>        # Execute a workflow
whipflow validate <file.whip>   # Check syntax without running
whipflow compile <file.whip>    # Show compiled output
whipflow install-skills         # Install /whipflow skill into Claude Code
whipflow install-skills --force # Overwrite existing skill
whipflow install-tools          # Create example custom tools in ~/.whipflow/tools/
whipflow list-tools             # List available custom tools
whipflow register <source>      # Register a script or GitHub repo as a global CLI
whipflow help
```

### Options

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--force` | `install-skills`, `install-tools` | Overwrite existing files |
| `--dry-run` | `install-skills`, `install-tools` | Preview without writing |
| `--name <name>` | `register` | Custom CLI name |

---

## Quick Start

Create `flows/hello.whip`:

```whip
agent worker:
  provider: "claude-code"
  model: sonnet
  tools: ["bash"]
  prompt: "You are a helpful assistant."

let result = session: worker
  prompt: "Run: echo 'whipflow is working' and tell me the output."
```

Run it:

```bash
whipflow run flows/hello.whip
```

---

## Project Config (`.whipflow.json`)

Place in the project root to configure providers and tools:

```json
{
  "toolsDir": "~/.whipflow/tools",
  "tools": ["fetch-url", "run-cmd", "read-file", "search-files"],
  "providers": {
    "claude-code": {
      "bin": "claude",
      "timeout": 600000
    },
    "fetch": {
      "bin": "curl",
      "promptMode": "arg",
      "args": ["-sL", "--max-time", "30", "-A", "Mozilla/5.0"],
      "outputFormat": "text"
    }
  }
}
```

---

## Claude Code Skill (`/whipflow`)

The `install-skills` command installs a `/whipflow` slash command into Claude Code. After installing, you can activate it in any Claude Code session by typing `/whipflow`.

### Install

```bash
whipflow install-skills
```

This writes `~/.claude/commands/whipflow.md`.

### Update

When the whipflow package is updated, reinstall the skill to get the latest version:

```bash
whipflow install-skills --force
```

This overwrites `~/.claude/commands/whipflow.md` with the content bundled in the new version of the CLI.

### What the skill contains

The skill file (`skills/whipflow/SKILL.md`) is embedded into the `whipflow` binary at build time. It contains:

- The full OpenProse language reference
- Agent definition syntax
- Session, loop, parallel, pipeline constructs
- `skill` invocation syntax
- Tips and complete examples

To preview what will be installed without writing any files:

```bash
whipflow install-skills --dry-run
```

---

## `skill` Statement

Invoke a Claude Code slash command (`/<name>`) as a workflow step. The runtime sends `/<name>` followed by any named parameters to a `claude-code` agent.

### Syntax

```whip
# Basic — just run the skill
skill <name>

# With named parameters
skill <name> param1=<expr> param2=<expr>

# Capture output into a variable
skill <name> param=<expr> -> varname

# As an expression (let / const)
let result = skill <name> param=<expr>
```

### Examples

```whip
# Run /commit
skill commit

# Run /review-pr with an argument
skill review-pr args="123"

# Capture the output
let review = skill simplify

# Pass session output as a parameter
let diff = session: researcher
  prompt: "Show me the git diff"

skill review-pr args=diff -> feedback

session: writer
  prompt: "Address this feedback:\n{feedback}"
```

### How it works

1. `skill foo` builds the prompt `"/foo"`.
2. Each `param=value` is appended as `"\n\nparam:\nvalue"`.
3. The prompt is sent to a minimal `claude-code` agent using the default model.
4. The agent's output is returned and can be captured with `-> varname` or `let result = skill ...`.

---

## Custom Tools

Custom tools extend what agents can do in sessions. They are defined as JSON files and auto-loaded into every whipflow session.

### Setup

```bash
whipflow install-tools       # create ~/.whipflow/tools/ with examples
whipflow list-tools          # list installed tools
```

### Tool definition format

```json
{
  "name": "fetch-url",
  "description": "Fetch the text content of a URL.",
  "type": "bash",
  "command": "curl -sL --max-time 30 -A 'Mozilla/5.0' '{url}'",
  "parameters": {
    "url": "The full URL to fetch (must include http:// or https://)"
  },
  "example": "curl -sL 'https://example.com'"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Tool identifier |
| `description` | yes | Shown to the agent so it knows when to use this tool |
| `type` | yes | `"bash"` — runs a shell command |
| `command` | yes | Shell command template; use `{paramName}` for substitutions |
| `parameters` | yes | Object mapping param names to descriptions |
| `example` | no | Example invocation shown to the agent |

### Built-in examples

| Tool | What it does |
|------|-------------|
| `fetch-url` | `curl` a URL and return the text |
| `run-cmd` | Run any shell command |
| `read-file` | `cat` a local file |
| `search-files` | `rg` / `grep` for patterns across files |

### Custom directory

Override the default `~/.whipflow/tools` location in `.whipflow.json`:

```json
{
  "toolsDir": "~/my-project/tools"
}
```

---

## `register` Command

Register any local script or GitHub repository as a global CLI command.

```bash
whipflow register ./requesthuntcli.py --name rh
whipflow register ./app.ts
whipflow register github:anthropics/anthropic-quickstarts
whipflow register https://github.com/user/repo
```

After registration the tool is available as a CLI command from anywhere:

```bash
rh --help
```

### How it works

`register` runs `flows/register.whip` — a whipflow workflow that uses a `claude-code` agent to:

1. Read the source and detect the type (Python / Node.js / Bun / GitHub).
2. Derive the CLI name (from `--name` or the filename).
3. Clone GitHub repos to `~/.whipflow/registry/<name>` and install dependencies.
4. Write a wrapper script at `~/.whipflow/bin/<name>` (chmod +x).
5. Record the entry in `~/.whipflow/registry.json`.

Add the bin directory to your shell if needed:

```bash
export PATH="$HOME/.whipflow/bin:$PATH"
```

---

## OpenProse Language Reference

Whipflow runs `.whip` files written in the OpenProse DSL. Full reference is below.

### File format

| Property | Value |
|----------|-------|
| Extension | `.whip` |
| Encoding | UTF-8 |
| Indentation | Spaces (Python-like) |
| Case sensitivity | Case-sensitive |

### Comments

```whip
# Standalone comment

session "Hello"  # Inline comment
```

### String literals

```whip
session "Single line"
session "Escape: \n \t \\"
session """
Multi-line
  preserves indentation
"""
let name = session "Get name"
session "Hello {name}!"   # interpolation
```

### Agent definition

```whip
agent name:
  provider: "claude-code"   # claude-code | opencode | aider | custom:bin
  model: sonnet             # opus | sonnet | haiku
  tools: ["bash", "read", "write", "edit"]
  skills: ["skill-name"]
  prompt: "System prompt."
  permissions:
    read: ["*.md"]
    bash: deny
```

### Session statement

```whip
session "Prompt"                        # inline prompt

session: agentName                      # agent reference
session analysis: agentName             # named session
session: agentName
  prompt: "Override prompt"
  model: opus
  context: priorResult
  retry: 3
  backoff: "exponential"
```

### Variables

```whip
let draft  = session "Write draft"      # mutable
const cfg  = session "Get config"       # immutable
draft      = session "Improve"          # reassign let
  context: draft
```

### Ask (user input)

```whip
ask topic: "What topic?"
ask count: "How many items?"
```

### Parallel blocks

```whip
parallel:
  security = session "Security review"
  perf     = session "Performance review"

session "Final report"
  context: { security, perf }

parallel ("first"):
  session "Try approach A"
  session "Try approach B"

parallel ("any", count: 2):
  session "Attempt 1"
  session "Attempt 2"
  session "Attempt 3"

parallel (on-fail: "continue"):
  session "Optional task A"
  session "Optional task B"
```

### Loops

```whip
repeat 3:
  session "Generate idea"

repeat 5 as i:
  session "Iteration {i}"

for item in items:
  session "Process {item}"

parallel for item in items:
  session "Process {item} concurrently"

loop until **the task is complete** (max: 10):
  session "Continue working"

loop while **there are items to process**:
  session "Process next"
```

### Pipelines

```whip
let results = items | map:
  session "Transform"
    context: item

let good = items | filter:
  session "Is this valid? Answer yes or no."
    context: item

let combined = items | reduce(summary, item):
  session "Add {item} to {summary}"

let results = items | pmap:
  session "Process concurrently"
    context: item
```

### Error handling

```whip
try:
  session "Risky operation"
catch as err:
  session "Handle error"
    context: err
finally:
  session "Cleanup"

session "Flaky API"
  retry: 3
  backoff: "exponential"
```

### Conditionals & choice

```whip
if **the code has vulnerabilities**:
  session "Fix security issues"
elif **the code has performance issues**:
  session "Optimize"
else:
  session "Proceed"

choice **which approach is best**:
  option "Quick":
    session "Fast path"
  option "Thorough":
    session "Comprehensive path"
```

### Composition blocks

```whip
do:
  session "Step 1"
  session "Step 2"

block review(topic):
  session "Research {topic}"
  session "Summarize {topic}"

do review("AI")

session "Plan" -> session "Execute" -> session "Review"
```

### Import

```whip
import "web-search" from "github:anthropics/skills"
import "custom-tool" from "./skills/custom-tool"
```

---

## Complete Example

```whip
agent researcher:
  provider: "claude-code"
  model: sonnet
  tools: ["bash", "read"]
  prompt: "You are a thorough research assistant."

agent writer:
  provider: "claude-code"
  model: opus
  tools: ["write", "edit"]
  prompt: "You write clear, concise documentation."

ask topic: "What topic should I research?"

parallel:
  market  = session: researcher  prompt: "Research market landscape for {topic}"
  tech    = session: researcher  prompt: "Research technical aspects of {topic}"
  trends  = session: researcher  prompt: "Research current trends in {topic}"

let report = session: writer
  prompt: """
  Write a comprehensive report on {topic}.

  Market: {market}
  Technical: {tech}
  Trends: {trends}
  """

loop until **the report is polished** (max: 3):
  report = session: writer
    prompt: "Review and improve:\n{report}"

if **the report meets publication standards**:
  session: writer  prompt: "Format for publication"
else:
  session: writer  prompt: "Flag issues and create improvement plan"
```
