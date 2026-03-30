---
description: Register a repository — explore codebase and create a structured profile
---
The user wants to register a repository. Delegate to a Claude Code session.

1. **Figure out the path** — from user input, task context, or ask if unclear.
2. **Find the skill file** — look in `<available_skills>` for `walnut-register-repo` and note its `<location>` path. Or read the skill from the built-in skills directory.
3. **Start a session** with:
   - `working_directory`: the target repo path
   - `prompt`: "Read the skill at {location} and follow its instructions to explore this codebase and register it as a repository." Include any extra context the user provided.
4. **After session completes** — verify with `files_read source='repos/{slug}'`.

Do NOT investigate the codebase yourself. Do NOT ask the user a bunch of questions. The session + skill handles everything.
