import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, run, type Change, type MutationQueue } from "../src/project.ts";
import { diffHunks, hunkAtLine, singleHunkPatch } from "../src/git-diff.ts";
const queue: MutationQueue = async (_path, action) => action();
const original = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`).join("\n") + "\n";
const edit = (text: string, n: number, value: string) => text.replace(`line ${n}\n`, `${value}\n`);
async function fixture(t: { after: (f: () => Promise<void>) => void }, name = "file.ts", bytes: string | Buffer = original) {
  const root = await mkdtemp(join(tmpdir(), "workbench-revert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run(root, "git", ["init", "-q"]); await run(root, "git", ["config", "user.email", "test@example.com"]);
  await run(root, "git", ["config", "user.name", "Test"]);
  await writeFile(join(root, name), bytes); await run(root, "git", ["add", "."]); await run(root, "git", ["commit", "-qm", "base"]);
  return { root, file: join(root, name), p: new Project(root), name };
}
async function plan(p: Project, change: Change, hunk?: number) { return p.prepareRevert(change, await p.diff(change), hunk); }

test("unstaged whole-file revert preserves staged changes; staged revert restores HEAD and index", async t => {
  const { root, file, p } = await fixture(t);
  const staged = edit(original, 2, "staged");
  await writeFile(file, staged); await run(root, "git", ["add", "."]);
  await writeFile(file, edit(staged, 25, "unstaged"));
  const changes = await p.changes();
  await assert.rejects(plan(p, changes.find(c => c.staged)!), /also has unstaged changes/);
  await p.revert(await plan(p, changes.find(c => !c.staged)!), queue);
  assert.equal(await readFile(file, "utf8"), staged);
  assert.equal(await run(root, "git", ["show", ":file.ts"]), staged);
  await p.revert(await plan(p, (await p.changes())[0]), queue);
  assert.equal(await readFile(file, "utf8"), original); assert.deepEqual(await p.changes(), []);
});

test("single-hunk revert preserves other hunks (first, middle, and last)", async t => {
  for (const index of [0, 1, 2]) {
    const { file, p } = await fixture(t);
    const modified = edit(edit(edit(original, 2, "first"), 20, "middle"), 38, "last");
    await writeFile(file, modified);
    const change = (await p.changes())[0], diff = await p.diff(change), hunks = diffHunks(diff);
    assert.equal(hunks.length, 3); assert.equal(hunkAtLine(diff, hunks[index].start), index);
    assert.equal(diffHunks(singleHunkPatch(diff, index)).length, 1);
    await p.revert(await p.prepareRevert(change, diff, index), queue);
    const result = await readFile(file, "utf8");
    assert(result.includes(`line ${[2, 20, 38][index]}\n`));
    assert.equal(diffHunks(await p.diff((await p.changes())[0])).length, 2);
  }
});

test("staged single-hunk revert updates both disk and index, retaining other staged hunks", async t => {
  const { root, file, p } = await fixture(t);
  await writeFile(file, edit(edit(original, 2, "first"), 38, "last")); await run(root, "git", ["add", "."]);
  await p.revert(await plan(p, (await p.changes())[0], 0), queue);
  const expected = edit(original, 38, "last");
  assert.equal(await readFile(file, "utf8"), expected); assert.equal(await run(root, "git", ["show", ":file.ts"]), expected);
});

test("reverts work in nested workspaces and with literal odd filenames", async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, "sub")); const name = "[odd]\nname.ts", file = join(root, "sub", name);
  await writeFile(file, original); await run(root, "git", ["add", "."]); await run(root, "git", ["commit", "-qm", "nested"]);
  const p = new Project(join(root, "sub")); await writeFile(file, edit(original, 20, "new"));
  await p.revert(await plan(p, (await p.changes())[0], 0), queue);
  assert.equal(await readFile(file, "utf8"), original);
});

test("stale reviewed diff, stale confirmation, and changed status are rejected", async t => {
  const { root, file, p } = await fixture(t);
  await writeFile(file, edit(original, 2, "first")); const change = (await p.changes())[0], diff = await p.diff(change);
  const prepared = await p.prepareRevert(change, diff);
  await writeFile(file, edit(original, 2, "different"));
  await assert.rejects(p.prepareRevert(change, diff), /Diff changed/);
  await assert.rejects(p.revert(prepared, queue), /Diff changed/);
  assert((await readFile(file, "utf8")).includes("different"));
  await run(root, "git", ["add", "."]); await assert.rejects(p.revert(prepared, queue), /status changed/);
});

test("untracked deletion needs a fresh plan and never deletes a modified confirmation target", async t => {
  const { root, p } = await fixture(t), file = join(root, "new.ts");
  await writeFile(file, "new\n"); const change = (await p.changes())[0];
  await assert.rejects(plan(p, change, 0), /whole-file deletion/);
  const prepared = await plan(p, change); await writeFile(file, "changed\n");
  await assert.rejects(p.revert(prepared, queue)); assert.equal(await readFile(file, "utf8"), "changed\n");
  await p.revert(await plan(p, (await p.changes())[0]), queue); await assert.rejects(stat(file));
});

test("whole-file reverts restore deletions and remove staged additions", async t => {
  const { root, file, p } = await fixture(t);
  await rm(file); let change = (await p.changes())[0];
  await assert.rejects(plan(p, change, 0), /modified text files only/);
  await p.revert(await plan(p, change), queue); assert.equal(await readFile(file, "utf8"), original);
  await writeFile(join(root, "added.ts"), "added\n"); await run(root, "git", ["add", "."]);
  change = (await p.changes())[0]; await p.revert(await plan(p, change), queue);
  await assert.rejects(stat(join(root, "added.ts"))); assert.deepEqual(await p.changes(), []);
});

test("whole-file binary and permission-only changes can be reverted", async t => {
  const bytes = Buffer.from([0, 1, 2, 3]); const { root, file, p } = await fixture(t, "binary", bytes);
  await writeFile(file, Buffer.from([0, 5, 6, 7])); let change = (await p.changes())[0];
  assert.equal(diffHunks(await p.diff(change)).length, 0);
  await p.revert(await plan(p, change), queue); assert.deepEqual(await readFile(file), bytes);
  await run(root, "git", ["config", "core.filemode", "true"]); await chmod(file, 0o755);
  change = (await p.changes())[0]; await p.revert(await plan(p, change), queue);
  assert.equal((await stat(file)).mode & 0o111, 0);
});

test("hunks preserve CRLF and missing final newlines", async t => {
  for (const baseline of ["one\r\ntwo\r\nthree\r\n", "one\ntwo\nthree"]) {
    const { file, p } = await fixture(t, "file.ts", baseline);
    await writeFile(file, baseline.replace("two", "changed"));
    await p.revert(await plan(p, (await p.changes())[0], 0), queue);
    assert.equal(await readFile(file, "utf8"), baseline);
  }
});

test("unsafe file types, conflicts and renamed entries are refused", async t => {
  const { root, file, p } = await fixture(t);
  await writeFile(file, edit(original, 2, "new")); let change = (await p.changes())[0];
  for (const status of ["R ", "C ", "UU", "AA", "DD", " T"]) await assert.rejects(p.prepareRevert({ ...change, status }, ""), /not supported/);
  await link(file, join(root, "alias")); await assert.rejects(plan(p, change), /non-hard-linked/);
  await rm(join(root, "alias")); await rm(file); await symlink("/etc/passwd", file);
  change = (await p.changes()).find(c => c.path === "file.ts")!; await assert.rejects(plan(p, change));
});
