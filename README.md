# whipflow.dev

AI workflow automation for [harness.farm](https://harness.farm).

## Setup

```bash
bun install
```

## Run a flow

```bash
bun run run flows/hello.prose
```

## Install skills into Claude Code

```bash
bun run skills
```

Then use `/whipflow` in any Claude Code session.

## Add a new flow

Create a `.prose` file in `flows/` and run it with:

```bash
open-prose validate flows/my-flow.prose
open-prose run flows/my-flow.prose
```
