# Pi Workbench

Browse, search, edit files, and review current Git changes **inside pi**, without Vim modes or a separate IDE.

An initial working prototype for **pi 1.5.0**. Uses pi's renderer, theme, keyboard parser, and fullscreen mouse events; it does not launch another terminal application or replace pi's conversation editor permanently.

## Try it

From a project directory, load the extension for one invocation:

```sh
pi -e /absolute/path/to/pi-workbench/src/index.ts
```

Then run:

```text
/workbench
```

To install the local package persistently:

```sh
pi install /absolute/path/to/pi-workbench
```

Run `/reload` in an existing session after installation or source changes. **Save your workbench edits before reloading.** Paths above are paths on the machine running pi, not sandbox-only paths.

Requirements:
- pi 1.5.0 (the version used to develop and check this prototype).
- `rg` (ripgrep) on pi's `PATH`, for file discovery and content search.
- `git` for change review. Browsing/editing works outside a Git repository.

Basic browsing, editing, and review need no build step or runtime `npm install`; pi supplies the two peer packages. IntelliSense uses workbench's local dependencies—**no global installation is required**. For a source checkout loaded with `pi -e`, run `npm install` inside `pi-workbench/` once. Normal managed package installation installs runtime dependencies.

## Workflow

The left pane is a file tree, search results, changes, or open editors. The right pane is an editable file or a read-only unified diff. **No function keys are needed.**

**Cmd/Ctrl+K** opens the searchable **command palette**. Every workspace action is listed there with its shortcut, including actions without direct bindings. Type to filter, use arrows to choose, and press Enter to run. Escape dismisses the palette without leaving the workspace.

**Cmd/Ctrl+P** opens **Quick Open**: fuzzy-search filenames as you type, navigate results with arrows, and press Enter once to open the selected file. It preserves your sidebar visibility and unsaved edits. Typing while the sidebar is focused also opens Quick Open, using what you type as the filename query.

| Key | Action |
| --- | --- |
| Cmd/Ctrl+K or Cmd/Ctrl+Shift+P | Command palette |
| Cmd/Ctrl+P | Quick Open files |
| Cmd/Ctrl+B | Hide/show sidebar; hiding gives the editor the full width |
| Cmd/Ctrl+Shift+E | Browse files in Explorer |
| Cmd+Shift+F / Ctrl+Alt+F | Literal project text search |
| Cmd/Ctrl+Shift+G | Current Git changes: `idx` staged, `wrk` unstaged, `new` untracked |
| Cmd/Ctrl+E | List open editors |
| Cmd/Ctrl+R | Refresh files, Git changes, and the active clean buffer/diff |
| Ctrl+L | Switch focus between sidebar and editor |
| Cmd/Ctrl+1 / Cmd/Ctrl+0 | Focus editor / sidebar |
| Alt+1 … Alt+5 | Select file tab 1–5 |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous file tab |
| Alt+] / Alt+[ | Terminal alternatives for next / previous editor |
| Cmd/Ctrl+W | Close current editor; dirty editors offer save/discard/cancel |
| Cmd/Ctrl+Enter | Return selection, reference, or diff to pi's **draft**, without submitting |
| Arrows / Enter | Navigate and open files/directories/results |
| Page Up / Down | Move through a list, file, diff, or palette |
| Alt+Up / Down | Select previous/next diff hunk |
| Alt+Left / Escape (in a diff) | Back to the previously open editor |
| Alt+E (in a diff) | Open the reviewed file for editing at the current hunk |
| Ctrl+Space | Manually request/retry TypeScript/JavaScript completion |
| Escape | Dismiss a prompt/palette/completion popup; otherwise return from diff or focus editor |
| Cmd/Ctrl+Q | Return to pi; unsaved edits prompt for `keep` or `discard` |

To edit a file from a diff, press **Alt+E** or choose **Git: Open Editable File from Diff** in the palette. **Git: Back to Editor** (Alt+Left / Escape) returns to the previously open editor without losing its unsaved edits or cursor position, and restores the file tree in the sidebar. Sidebar visibility is retained when closing/reopening the workbench in the same session. Explorer, search, and change-list actions reveal it when needed.

### File tabs

Open up to **five files** at once. The editor header shows numbered file tabs; the active tab is highlighted and `●` marks unsaved edits. Click a tab in fullscreen mode, press **Alt+1–5**, or cycle with **Ctrl+Tab / Ctrl+Shift+Tab** (terminal alternatives: **Alt+] / Alt+[**). The palette also has **View: Focus Tab 1–5** commands. Switching tabs preserves each file's edits, selection, cursor, and scroll position, and returns from a diff to the selected editable buffer.

Opening a sixth distinct file is blocked with a message; no tab is silently evicted. Close one with **Cmd/Ctrl+W** first. Dirty tabs still require save/discard confirmation. Reopening an already-open file selects its existing tab rather than consuming another slot. Tab numbers follow the current left-to-right order and shift when a tab closes.

### Terminal shortcut support

`Cmd` is recognized as the `super` modifier when the terminal forwards it (typically via the Kitty keyboard protocol). macOS/terminal shortcuts can intercept Command combinations before pi receives them; Ctrl alternatives and the palette remain available. Ctrl+Shift and Ctrl+number/Tab/Enter combinations also need a terminal that reports those combinations distinctly. Use the palette or the listed alternatives if your terminal cannot send a binding.

Pi reserves **Ctrl+Shift+F** for transcript search even while an extension overlay is open, so workbench project search deliberately uses **Ctrl+Alt+F** as its Ctrl fallback. These shortcuts belong to the workbench only; they do not change pi's conversation-editor shortcuts.

### Editing

Typing in the editor edits immediately, without entering a mode. Syntax highlighting updates as you type and stays visible on the active line and beneath selections. Its cursor blinks while idle and becomes visible again on keyboard input. A `●` beside the filename marks unsaved changes. The footer shows **N changes** only when Git reports changed files (each path counted once, even if both staged and unstaged); it is hidden for a clean workspace. This count describes saved Git changes, not unsaved buffers, and updates on refresh, save, and revert.

| Key | Action |
| --- | --- |
| Cmd/Ctrl+S | Save active file |
| Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo |
| Shift+arrows, Shift+Home/End | Select text |
| Cmd/Ctrl+A | Select all |
| Cmd/Ctrl+C / Cmd/Ctrl+X | Copy / cut selection |
| Ctrl+V | Paste the workbench's most recent internal copy |
| Terminal paste shortcut | Paste system clipboard text, including multiline text |
| Cmd/Ctrl+F | Find literal text and select a match |
| Cmd/Ctrl+G | Jump to line or line:column |
| Ctrl+H | Replace all literal occurrences (undoable as one edit) |
| Home / End (or Cmd+Left / Right) | Start / end of line |
| Ctrl+Home / End | Start / end of file |
| Tab | Accept highlighted completion when suggestions are open; otherwise insert a literal tab |
| Enter | New line with existing leading indentation |

Copy also attempts to update the system clipboard using pi's clipboard helper. If that fails, the internal clipboard remains available. System clipboard **reading** isn't part of this prototype; use your terminal's paste shortcut.

Find is case-sensitive and wraps. Repeating Cmd/Ctrl+F with the same query advances to the next occurrence. Search results open at the matching line. Git diffs describe saved disk/index content, not unsaved editor buffers.

### Git reverts

Open a change's diff first, then use the command palette:

- **Git: Revert File Changes** reverts the entire reviewed file entry.
- **Git: Revert Current Hunk** reverts one contiguous diff hunk, not an individual line. Select a hunk with **Alt+Up/Down**, by scrolling to it, or by clicking it. The diff title shows the selected hunk number and its header is highlighted.

Every revert requires typing **`revert`** to confirm; Escape cancels. Untracked entries instead require **`delete`** and permanently delete that file. There is no bulk project-wide discard action or single-keystroke destructive shortcut.

Scope matters:
- **Unstaged (`wrk`)**: revert disk content to the index, preserving staged changes.
- **Staged (`idx`)**: revert both index and disk toward HEAD. If the file also has unstaged changes, the operation is blocked; reconcile those first. This is a discard, not merely an unstage.
- **Untracked (`new`)**: whole-file deletion only.

Dirty workbench buffers block reverts. The reviewed diff, Git status, file contents/mode, and target are checked again after confirmation; stale reviews are rejected. The per-file mutation queue is used, and Git checks the reverse patch before applying it. As with saving, unrelated external processes are not locked out and can still race the final checks.

Single-hunk reverts support ordinary modified text files; additions, deletions, binary changes, and mode-only changes require whole-file revert. Renames, copies, conflicts, type changes, symlinks, hard links, submodules, and missing/symlinked parent directories are refused rather than guessed at. Reverts refresh matching clean buffers and the change list. **Discarded Git changes are not recoverable through editor Undo; there is no recovery backup.**

### IntelliSense / completion (TypeScript and JavaScript)

Completion is backed by a real local language server and understands the project's TypeScript/JavaScript types. It starts automatically when typing a completion trigger in a supported file; no server starts during extension loading or ordinary browsing.

The language server and TypeScript are runtime dependencies of workbench, not global packages. For a source checkout, install them locally on the **machine running pi**:

```sh
cd /path/to/pi-workbench
npm install
```

Alternatively, use the project's own versions:

```sh
cd /path/to/your-project
npm install --save-dev typescript typescript-language-server
```

Workbench prefers `your-project/node_modules/typescript-language-server`, then its own bundled dependency. A server already on `PATH` remains a fallback. No packages are downloaded or installed automatically while typing.

In an editable `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, or `.cjs` file, type `.` or at least two identifier characters to get suggestions automatically. You can also press **Ctrl+Space**, or choose **Code: Trigger TypeScript/JavaScript Completion** in the palette. This lazily starts the locally resolved language server with `--stdio`. If your operating system captures Ctrl+Space, use the palette. A missing or failing server reports an error and pauses automatic requests; after fixing the installation, use Ctrl+Space to retry.

Completion behavior:
- Suggestions appear automatically after `.` or a typed identifier prefix (150 ms debounce).
- **Up/Down** selects a suggestion; **Tab** accepts it; **Escape** dismisses it. Enter still inserts a newline.
- Mouse selection and scrolling work in fullscreen mode.
- Unsaved buffer contents are synchronized to the server. Completion edits, including same-file auto-import edits, form one undoable transaction.
- Responses are ignored if you have edited, moved, switched files, or cancelled while waiting.
- **Code: Disable IntelliSense** stops the server and automatic suggestions for this workbench; Ctrl+Space re-enables them. Closing the workbench stops its server/process group too. Automatic suggestions are enabled again on reopening.

The server runs with your permissions and can inspect the workspace. Server-issued commands and workspace edits are not automatically executed. Only completion edits explicitly accepted by you are applied. This first integration supports plain-text completions and UTF-16 positions; snippet placeholders, diagnostics UI, hover, definitions, arbitrary language-server configuration, and other languages are not implemented yet.

### Mouse

In pi's **fullscreen mode**, click file/directory/search/change entries, click palette/Quick Open/completion results, scroll either pane or popup, and click/drag in the editor to position the cursor/select text. Regular mode intentionally leaves the mouse to your terminal; every interaction has a keyboard route. Use pi's `/settings` to select fullscreen mode if needed.

## Save safety and limits

- Preserves existing UTF-8 text byte-for-byte outside your edits: tabs, BOM, mixed line endings, and final-newline presence. New lines use the first existing line-ending style.
- Checks the on-disk contents and target before saving. If pi or another editor changed the file, saving is blocked rather than silently overwriting it. Copy your edits out before reopening/reloading; a three-way reconciliation UI is not implemented yet.
- Uses pi's per-file mutation queue, a same-directory temporary file, sync, and atomic rename. Preserves permission bits. Like most check-then-rename approaches, this is not a cross-process filesystem lock: another program can still race the final check. Ownership, extended attributes, and ACL preservation are not guaranteed.
- Refuses saves through a symlink that changed target. Files resolving outside the workspace cannot be opened. Hard-linked files cannot be saved because atomic replacement would break link semantics.
- Refuses binary/non-UTF-8 files and files over 1 MiB. Highlighting is disabled above 200,000 characters. Undo history is bounded to 200 snapshots / approximately 16 MiB.
- File discovery respects ripgrep ignore rules, includes dotfiles, and excludes `.git` and `node_modules`. At most 50,000 files; search results are limited to 500. Commands have a 10-second timeout and 8 MiB output cap; exceeding a cap reports an error instead of showing incomplete output as complete.
- Unsaved buffers remain **in memory** when closing with `keep` or sending a draft with Cmd/Ctrl+Enter, and can be reopened with `/workbench` in the same session. They **do not survive `/reload`, session replacement, pi exit, or a crash**. Save before those actions. There is no recovery journal yet.
- Refresh is explicit with Cmd/Ctrl+R or the palette's refresh action. Clean buffers are refreshed; dirty buffers are retained and an external change is reported. There is no background file watcher.
- No staging/unstaging UI, branch comparisons, merge-conflict resolution, general-purpose language-server configuration, or debugger in this release. Revert and TypeScript/JavaScript completion limitations are described above.

## Development

```sh
npm install
npm run check
npm test
```

Node 22.6+ is needed for the test runner's TypeScript-stripping flag. Development installation resolves the host packages as peers; managed pi package installation uses pi's own copies instead.

Layout:

```text
src/index.ts       pi command, session state, conversation-draft handoff
src/workbench.ts   workspace component, keyboard/mouse, panes, rendering
src/buffer.ts      lossless text model, selection, Unicode movement, undo/redo
src/project.ts     file boundaries, atomic saves, ripgrep, Git and guarded reverts
src/git-diff.ts    unified-diff hunk selection and single-hunk patches
src/completion.ts  local LSP transport, TypeScript completion, accepted edit validation
test/              buffer, real filesystem/Git, and component tests
```

Automated component tests cover keyboard flows, resizing, visible-width limits, cursor markers, and normalized mouse events. They are **not** a substitute for a hands-on terminal check in pi; actual terminal protocols, shortcut interception, and clipboard behavior vary.
