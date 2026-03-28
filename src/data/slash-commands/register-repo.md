---
description: Register a repository — add name, path, tech stack, and architecture notes
---
Help me register a repository. Walk me through it step by step:

1. **Ask me** for:
   - Repository name (e.g. "Walnut", "My API")
   - Local path (e.g. /Users/me/code/project)
   - Brief description (one line)
   - Tech stack (e.g. TypeScript, React, Node.js)
   - Any additional hosts? (e.g. remote dev machine with ssh_host)

2. **Optionally ask** about:
   - Architecture notes (key directories and their purposes)
   - Common commands (build, test, dev)

3. **Create the repo** using `files_write` with `source='repos/{slug}'` where slug is the lowercase hyphenated name.

Format the YAML content like this:
```yaml
name: Project Name
description: Brief description
tech_stack: [Tech1, Tech2]
hosts:
  local:
    path: /absolute/path
architecture_notes: |
  Key architecture info
common_commands: |
  npm run build    # Build
  npm test         # Test
```

4. **Confirm** by reading it back: `files_read source='repos/{slug}'`

Don't ask all questions at once — start with name and path, then ask for details.
