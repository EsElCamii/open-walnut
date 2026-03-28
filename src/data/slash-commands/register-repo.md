---
description: Register a repository — explore codebase and create a structured profile
---
The user wants to register a repository. Your job is to **delegate this to a Claude Code session** — do NOT investigate or write YAML yourself.

## What to do

1. **Figure out the path** — the user may provide it explicitly, or you can infer it from context (e.g. the task's CWD, a recent session's working directory, or ask if unclear).

2. **Start a session** — use `start_session` with:
   - `working_directory`: the repo path
   - `prompt`: Tell the session to use the `/walnut-register-repo` skill to explore the codebase and register it. Include any context the user provided (e.g. "this is a Python data pipeline" or "add a cloud-desktop host too").
   - Example prompt: `"Use /walnut-register-repo to explore this codebase and register it as a repository. Write the YAML to ~/.open-walnut/repositories/{slug}.yaml and validate it."`

3. **Report back** — once the session completes, confirm the repo was registered. You can verify with `files_read source='repos/{slug}'`.

## Key points
- Do NOT ask the user a bunch of questions — the Claude Code session will explore the codebase and figure things out automatically.
- Only ask the user if you genuinely don't know which path to register.
- The session has the `/walnut-register-repo` skill which knows how to read package.json, README, directory structure, etc. and generate the correct YAML format.
