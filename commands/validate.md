---
description: Validate a whipflow .whip workflow without running it
argument-hint: <flow.whip>
---

Validate the workflow at: $ARGUMENTS

First, validate the argument:
- The argument must end with `.whip`. If it does not, reject with an error.
- The file must exist. If it does not, reject with an error.

Then run:
```bash
whipflow validate "$ARGUMENTS"
```

Report any syntax errors with line numbers.
