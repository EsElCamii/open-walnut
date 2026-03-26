import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../../src/agent/tools/files/markdown-parser.js';

describe('parseMarkdown', () => {
  it('extracts YAML frontmatter', () => {
    const md = `---
name: Test
description: A test document
---
# Hello`;
    const result = parseMarkdown(md);
    expect(result.frontmatter).toEqual({ name: 'Test', description: 'A test document' });
  });

  it('extracts headers with levels and line numbers', () => {
    const md = `# Title
Some text
## Section 1
### Subsection
#### Deep`;
    const result = parseMarkdown(md);
    expect(result.headers).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Section 1', line: 3 },
      { level: 3, text: 'Subsection', line: 4 },
      { level: 4, text: 'Deep', line: 5 },
    ]);
  });

  it('extracts todo items', () => {
    const md = `- [ ] Buy milk
- [x] Write tests
* [ ] Review PR
* [X] Deploy`;
    const result = parseMarkdown(md);
    expect(result.todos).toEqual([
      { text: 'Buy milk', checked: false, line: 1 },
      { text: 'Write tests', checked: true, line: 2 },
      { text: 'Review PR', checked: false, line: 3 },
      { text: 'Deploy', checked: true, line: 4 },
    ]);
  });

  it('extracts task-ref elements', () => {
    const md = `See <task-ref id="abc123" label="Fix bug"/> and <task-ref id="def456"/>`;
    const result = parseMarkdown(md);
    expect(result.task_refs).toEqual([
      { id: 'abc123', label: 'Fix bug', line: 1 },
      { id: 'def456', label: undefined, line: 1 },
    ]);
  });

  it('extracts session-ref elements', () => {
    const md = `Check <session-ref id="sess-1" label="Planning"/>`;
    const result = parseMarkdown(md);
    expect(result.session_refs).toEqual([
      { id: 'sess-1', label: 'Planning', line: 1 },
    ]);
  });

  it('extracts markdown links', () => {
    const md = `Visit [Google](https://google.com) or [Docs](/docs/api)`;
    const result = parseMarkdown(md);
    expect(result.links).toEqual([
      { text: 'Google', url: 'https://google.com', line: 1 },
      { text: 'Docs', url: '/docs/api', line: 1 },
    ]);
  });

  it('extracts code blocks with language', () => {
    const md = `Some text
\`\`\`typescript
const x = 1;
const y = 2;
\`\`\`
More text
\`\`\`
plain code
\`\`\``;
    const result = parseMarkdown(md);
    expect(result.code_blocks).toEqual([
      { language: 'typescript', line: 2, length: 4 },
      { language: '', line: 7, length: 3 },
    ]);
  });

  it('does not extract headings/links inside code blocks', () => {
    const md = `# Real heading
\`\`\`
# Not a heading
[Not a link](http://example.com)
\`\`\`
## Another real heading`;
    const result = parseMarkdown(md);
    expect(result.headers).toHaveLength(2);
    expect(result.headers[0].text).toBe('Real heading');
    expect(result.headers[1].text).toBe('Another real heading');
    expect(result.links).toHaveLength(0);
  });

  it('counts words and lines', () => {
    const md = `Hello world
This is a test
Three lines here`;
    const result = parseMarkdown(md);
    expect(result.line_count).toBe(3);
    expect(result.word_count).toBeGreaterThan(0);
  });

  it('handles empty content', () => {
    const result = parseMarkdown('');
    expect(result.headers).toEqual([]);
    expect(result.todos).toEqual([]);
    expect(result.line_count).toBe(1); // empty string splits to ['']
    expect(result.word_count).toBe(0);
  });

  it('handles unclosed code block', () => {
    const md = `\`\`\`python
print("hello")
# never closed`;
    const result = parseMarkdown(md);
    expect(result.code_blocks).toHaveLength(1);
    expect(result.code_blocks[0].language).toBe('python');
  });
});
