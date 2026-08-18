<h1 align="center">
  <a href="https://fold.optulus.com"><img src="src-tauri/icons/icon.png" alt="Fold" width="64" valign="middle" /></a> Fold
</h1>

<p align="center">
  <a href="https://fold.optulus.com"><img src="https://img.shields.io/badge/Website-fold.optulus.com-6cb6ff?style=flat" alt="Fold website" /></a>
  <a href="https://github.com/kwangyel/fold-desktop"><img src="https://img.shields.io/github/stars/kwangyel/fold-desktop?style=flat&amp;label=%E2%98%85&amp;color=6cb6ff" alt="GitHub stars" /></a>
  <a href="https://github.com/kwangyel/fold-desktop/releases"><img src="https://img.shields.io/github/v/release/kwangyel/fold-desktop?style=flat&amp;color=6cb6ff" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-4493F8?style=flat-square" alt="Supported platform: macOS" />
</p>

<p align="center">
  <strong>Multi-agent coding workspaces for GitHub.</strong><br/>
  Run Claude Code, Codex, Cursor, and OpenCode side-by-side — each in its own git worktree, reviewed in one place.
</p>

<h3 align="center"><a href="https://fold.optulus.com"><ins>fold.optulus.com</ins></a> · <a href="https://github.com/kwangyel/fold-desktop/releases/latest"><ins>Download Fold</ins></a></h3>

<p align="center">
  <a href="https://fold.optulus.com"><img src="src-tauri/icons/icon.png" alt="Fold by Optulus — multi-agent coding workspaces for GitHub" width="180" /></a>
</p>

## Features

<table>
<tr>
<td width="50%" valign="top">

### Parallel Worktrees

Spin up an isolated git worktree per task — city-style names, its own branch, and a dedicated chat. Copy or symlink `.env` files and folders into each workspace, then archive or delete when you're done (rescue refs keep the branch recoverable).

</td>
<td width="50%" valign="top">

### Multi-agent Harnesses

Connect **Claude Code**, **Codex**, **Cursor**, and **OpenCode** in one window. Pick the model per chat, switch harnesses without leaving the thread, and run agents in parallel across worktrees.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Plan Mode

Ask an agent to research and propose — no code edits until you approve. Plans live beside the worktree (never dirtying git), then any connected harness can implement them.

</td>
<td width="50%" valign="top">

### GitHub & Linear, Native

Sign in with GitHub. Create or clone repos, attach issues to a worktree, and let Fold open, view, and merge PRs (squash / merge / rebase). Connect Linear the same way — issues auto-complete when the PR exists.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Annotate AI Diffs

Comment on any diff line or range and ship the notes back to the agent as attachments. A review queue walks every changed file; comments persist beside the worktree so they never show up in `git status`.

</td>
<td width="50%" valign="top">

### Conflict Radar

See collisions before they land. Fold flags a worktree that conflicts with the target branch *and* sibling worktrees heading for the same files — click a path to open the diff.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Checkpoints & Rollback

Every agent turn snapshots the worktree (tracked + untracked). Restore a checkpoint to rewind the files *and* drop later chat messages — try again without leftover edits.

</td>
<td width="50%" valign="top">

### Smart Handoff

When a chat is filling up, Fold summarizes state, files, decisions, and the next step, then opens a fresh tab with that handoff attached. Claude sessions also prompt you as usage nears 90%.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Review, Commit, Ship

Stage and commit from the Changes panel, generate a commit message with the connected agent, or ask an agent to open the PR against your target branch. Linked GitHub and Linear issues close automatically once the PR is up.

</td>
<td width="50%" valign="top">

### Editor, Explorer & Terminal

A CodeMirror editor with language support across the stack, a file tree with per-type icons, unified/split diffs, and an xterm PTY with multiple tabs, pinned working directories, and scrollback that stays put.

</td>
</tr>
</table>

**Also in the box:**

- **Ask the user** — Claude's native questions plus a `fold_ask_user` MCP tool so Codex, Cursor, and OpenCode can raise the same overlay.
- **Attachments** — Drop files and images, paste text, or attach a GitHub / Linear issue. Stored beside the worktree, not inside git.
- **Chat context panel** — On a fresh chat, click to carry sibling transcripts, plans, and handoffs into the new thread.
- **Effort dial** — Minimal through Ultra (Claude `ultracode` included) plus Fast mode where the model supports it.
- **Context & rate-limit meters** — Live context-window occupancy and Claude 5-hour / weekly usage in the status bar.
- **Agent notifications** — macOS alerts and a dock badge when an agent finishes or is waiting on you; status dots on every worktree.
- **Setup scripts** — Per-project bootstrap that runs in a new worktree with `FOLD_*` environment variables.
- **Target branch picker** — Choose the merge base per project; rebase or merge onto it from the PR menu.
- **Worktree chat list** — Jump between chats for the current workspace from the tab bar.
- **Auto-updates** — Signed desktop updates from GitHub Releases.
- **Native macOS chrome** — Overlay title bar, window vibrancy, and a real app menu.

---

## Supported Agents

Connect the harnesses you already use — Fold talks to their CLIs (and Cursor Cloud Agents) rather than replacing them.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="https://www.google.com/s2/favicons?domain=claude.com&sz=64" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://cursor.com"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://opencode.ai"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a>
</p>

---

## Install

### Desktop — macOS

- **[Download from fold.optulus.com](https://fold.optulus.com)**
- Or grab a build from **[GitHub Releases](https://github.com/kwangyel/fold-desktop/releases/latest)** (`.dmg`)

Sign in with GitHub, connect a harness, then create or clone a project.

---

## Developing

```bash
npm install
npm run tauri:dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite frontend only |
| `npm run tauri:dev` | Desktop app (Tauri, no file watch) |
| `npm run build` | Typecheck + production frontend bundle |

Requires [Rust](https://rustup.rs), Node, and the CLIs for any harness you want to connect (`claude`, `codex`, `opencode`, plus a Cursor Cloud Agents API key).
