# Backlog

Open work for this repo, one task per Markdown file. Committed and shared.

## Layout

- `<NNN>-<slug>.md`: one task. The number sets the order; steps of 10 leave room to insert. Numbers are never reused, even after a task is deleted.
- `<group>/`: a folder of related tasks. Overall order is by full path.
- A task file is deleted in the commit that completes it. This folder holds open work only; git history holds the rest.

## Task format

```markdown
---
depends-on: [<[group/]NNN-slug>]     # optional
blocked: <why it can't proceed>      # optional
---

# <Imperative title>

## Goal

<What should change and why, 1-3 lines.>

## Context

<Relevant files, constraints, decisions already made. Only what CLAUDE.md doesn't already say.>

## Done when

- <Verifiable criterion: a command that passes, a test, an observable behavior.>
```

- Omit the frontmatter when there's nothing to put in it.
- `depends-on`: task paths relative to this folder, without `.md`. A task can start once all of them are gone (done).
- `blocked`: remove it once the problem is solved.
- "Done when" is mandatory and must be checkable. It decides whether a task is finished.
- Extra sections (e.g. `## Instructions`) are fine when a task needs them.

## Running tasks

With Claude Code and the `/backlog` skill:

- `/backlog`: next runnable task
- `/backlog <task>`: one task
- `/backlog <group>/`: one group
- `/backlog --all`: everything
- `/backlog add <description>`: create a task

Without the skill: take the first runnable file in path order, do it, check "Done when", and delete the file in the same commit.
