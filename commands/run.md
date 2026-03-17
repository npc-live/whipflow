---
description: Run a whipflow .whip workflow
argument-hint: <flow.whip>
---

Run the whipflow workflow at: $ARGUMENTS

First, validate the argument:
- If no argument is given, list available flows:
  ```bash
  ls flows/*.whip
  ```
  Then ask which one to run.
- The argument must end with `.whip`. If it does not, reject with an error.
- The file must exist. If it does not, reject with an error.

Then run:
```bash
whipflow run "$ARGUMENTS"
```
