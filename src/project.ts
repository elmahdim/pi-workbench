import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextBuffer } from "./buffer.ts";
import { singleHunkPatch } from "./git-diff.ts";

const exec = promisify(execFile);
export const MAX_FILE = 1024 * 1024;
export interface Change { path: string; status: string; staged: boolean; untracked: boolean }
export interface SearchHit { path: string; line: number; text: string }
export interface Document { path: string; target: string; buffer: TextBuffer; top: number; left: number }
export type MutationQueue = <T>(path: string, action: () => Promise<T>) => Promise<T>;
export interface RevertPlan {
  change: Change; diff: string; hunk?: number; patch: string; target: string; fingerprint: string;
}

async function applyPatch(cwd: string, patch: string, staged: boolean, check: boolean, directory: string) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["apply", "--reverse", "--whitespace=nowarn", ...(staged ? ["--index"] : []), ...(check ? ["--check"] : []), ...(directory ? [`--directory=${directory}`] : []), "-"],
      { cwd, timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve());
    child.stdin?.on("error", () => { /* The callback reports a rejected/terminated Git process. */ });
    child.stdin?.end(patch);
  });
}

/** No shell, pager, external diff, textconv, or repository-configured executable hooks. */
export async function run(cwd: string, command: string, args: string[], signal?: AbortSignal) {
  try {
    const result = await exec(command, args, { cwd, signal, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C.UTF-8" } });
    return result.stdout;
  } catch (error) {
    const e = error as { code?: number; stdout?: string };
    if (command === "rg" && e.code === 1) return e.stdout ?? "";
    throw error;
  }
}
export function parseStatus(output: string): Change[] {
  const records = output.split("\0"); const changes: Change[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i]; if (!row) continue;
    const status = row.slice(0, 2), path = row.slice(3);
    if (/[RC]/.test(status)) i++; // -z puts the destination first, then original path.
    if (status === "??") changes.push({ path, status, staged: false, untracked: true });
    else {
      if (status[0] !== " ") changes.push({ path, status, staged: true, untracked: false });
      if (status[1] !== " ") changes.push({ path, status, staged: false, untracked: false });
    }
  }
  return changes;
}
export function fuzzy(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  return paths.map(path => {
    let i = 0, score = 0, last = -2;
    for (let n = 0; n < path.length && i < q.length; n++) {
      if (path[n].toLowerCase() === q[i]) { score += last === n - 1 ? 6 : 1; score += /[/_.-]/.test(path[n - 1] ?? "/") ? 4 : 0; last = n; i++; }
    }
    return { path, score: i === q.length ? score - path.length / 1000 : -Infinity };
  }).filter(p => p.score !== -Infinity).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).map(p => p.path);
}

export class Project {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async target(path: string) {
    const root = await realpath(this.root), target = await realpath(resolve(this.root, path));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("File resolves outside this workspace");
    return target;
  }
  async files(signal?: AbortSignal) {
    const output = await run(this.root, "rg", ["--files", "--hidden", "-0", "-g", "!.git", "-g", "!node_modules", "."], signal);
    const files = output.split("\0").filter(Boolean).map(p => p.replace(/^\.\//, "")).sort();
    if (files.length > 50000) throw new Error("Workspace exceeds 50,000 files; open a smaller directory");
    return files;
  }
  async changes() {
    const prefix = (await run(this.root, "git", ["rev-parse", "--show-prefix"])).trimEnd();
    return parseStatus(await run(this.root, "git", ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]))
      .filter(c => c.path.startsWith(prefix)).map(c => ({ ...c, path: c.path.slice(prefix.length) }));
  }
  async search(query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[]; limited: boolean }> {
    if (!query) return { hits: [], limited: false };
    const output = await run(this.root, "rg", ["--json", "--hidden", "--fixed-strings", "--max-columns", "1000", "-g", "!.git", "-g", "!node_modules", "--", query, "."], signal);
    const hits: SearchHit[] = [];
    for (const row of output.split("\n")) {
      if (!row) continue;
      const event = JSON.parse(row);
      if (event.type === "match" && event.data.path.text && event.data.lines.text) {
        hits.push({ path: event.data.path.text.replace(/^\.\//, ""), line: event.data.line_number, text: event.data.lines.text.trimEnd() });
        if (hits.length === 501) return { hits: hits.slice(0, 500), limited: true };
      }
    }
    return { hits, limited: false };
  }
  async open(path: string): Promise<Document> {
    const target = await this.target(path), info = await stat(target);
    if (!info.isFile()) throw new Error("Not a regular file");
    if (info.size > MAX_FILE) throw new Error("Files larger than 1 MiB are not supported yet");
    const data = await readFile(target);
    if (data.length > MAX_FILE || data.includes(0)) throw new Error("Binary or oversized file");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new Error("Only UTF-8 text files are supported"); }
    return { path, target, buffer: new TextBuffer(text), top: 0, left: 0 };
  }
  async save(doc: Document, queue: MutationQueue) {
    const text = doc.buffer.text;
    if (Buffer.byteLength(text) > MAX_FILE) throw new Error("Edited file exceeds 1 MiB");
    await queue(doc.target, async () => {
      if (await this.target(doc.path) !== doc.target) throw new Error("File target changed; reopen it before saving");
      const info = await stat(doc.target);
      if (info.nlink > 1) throw new Error("Saving hard-linked files is not supported safely");
      const old = await readFile(doc.target);
      if (!old.equals(Buffer.from(doc.buffer.saved))) throw new Error("File changed on disk. Save blocked; preserve your edits and reopen the file.");
      const temp = resolve(dirname(doc.target), `.pi-workbench-${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, "wx", info.mode & 0o777);
        try { await handle.writeFile(text, "utf8"); await handle.chmod(info.mode & 0o777); await handle.sync(); }
        finally { await handle.close(); }
        if (await this.target(doc.path) !== doc.target || !(await readFile(doc.target)).equals(old)) throw new Error("File changed during save; save blocked");
        await rename(temp, doc.target);
        doc.buffer.saved = text;
      } finally { await unlink(temp).catch(() => {}); }
    });
  }
  private async revertState(path: string) {
    const root = await realpath(this.root), target = resolve(root, path), rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) || rel.split("/").includes(".git")) throw new Error("Unsafe revert path");
    // Unlike viewing, destructive operations reject symlinks, including parent-directory aliases.
    if (await realpath(dirname(target)) !== dirname(target)) throw new Error("Reverting through a symlinked directory is not supported");
    let info;
    try { info = await lstat(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (!info) return { target, fingerprint: "missing" };
    if (!info.isFile() || info.nlink > 1) throw new Error("Revert supports regular, non-hard-linked files only (not symlinks or submodules)");
    if (info.size > MAX_FILE) throw new Error("Reverting files larger than 1 MiB is not supported yet");
    const bytes = await readFile(target);
    return { target, fingerprint: `${info.mode}:${createHash("sha256").update(bytes).digest("hex")}` };
  }
  async prepareRevert(change: Change, expectedDiff: string, hunk?: number): Promise<RevertPlan> {
    if (/[RCUT]/.test(change.status) || ["AA", "DD"].includes(change.status)) throw new Error("Reverting renames, copies, type changes, or merge conflicts is not supported yet");
    const changes = await this.changes();
    if (!changes.some(c => c.path === change.path && c.staged === change.staged && c.untracked === change.untracked && c.status === change.status)) throw new Error("Git status changed; refresh and review again before reverting");
    if (change.staged && changes.some(c => c.path === change.path && !c.staged)) throw new Error("This file also has unstaged changes. Revert/reconcile those first before reverting staged changes");
    const state = await this.revertState(change.path), diff = await this.diff(change);
    if (diff !== expectedDiff) throw new Error("Diff changed; refresh and review again before reverting");
    if (change.untracked && hunk !== undefined) throw new Error("Untracked files support whole-file deletion only");
    const patch = hunk === undefined ? diff : singleHunkPatch(diff, hunk);
    if (!change.untracked && !patch.startsWith("diff --git ")) throw new Error("No reversible Git patch for this entry");
    return { change: { ...change }, diff, hunk, patch, ...state };
  }
  async revert(plan: RevertPlan, queue: MutationQueue) {
    await queue(plan.target, async () => {
      const current = await this.prepareRevert(plan.change, plan.diff, plan.hunk);
      if (current.target !== plan.target || current.fingerprint !== plan.fingerprint || current.patch !== plan.patch) throw new Error("File changed since confirmation; revert blocked");
      if (plan.change.untracked) { await unlink(current.target); return; }
      const gitRoot = (await run(this.root, "git", ["rev-parse", "--show-toplevel"])).trimEnd();
      const directory = relative(await realpath(gitRoot), await realpath(this.root));
      if (plan.change.staged) {
        // --index requires matching index stat metadata, even after an unstaged revert restored identical bytes.
        // Exit 1 means unrelated paths need updates; apply --index still validates the target exactly.
        await run(gitRoot, "git", ["update-index", "--refresh"]).catch(e => { if (e.code !== 1) throw e; });
      }
      await applyPatch(gitRoot, current.patch, plan.change.staged, true, directory);
      const state = await this.revertState(plan.change.path);
      if (state.fingerprint !== plan.fingerprint) throw new Error("File changed during revert; operation blocked");
      await applyPatch(gitRoot, current.patch, plan.change.staged, false, directory);
    });
  }
  async diff(change: Change) {
    if (change.untracked) {
      const doc = await this.open(change.path);
      return `--- /dev/null\n+++ ${change.path}\n@@ new file @@\n` + doc.buffer.lines.map(l => `+${l}`).join("\n");
    }
    // Use workspace-relative paths even when cwd is a subdirectory of the Git root.
    return await run(this.root, "git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--binary", "--full-index", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-indent-heuristic", "--unified=3", ...(change.staged ? ["--cached"] : []), "--", change.path]) || "No textual diff (possibly a mode-only change).";
  }
}
