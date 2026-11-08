import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, stat, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, parseStatus, fuzzy, run, type MutationQueue } from "../src/project.ts";
const queue: MutationQueue = async (_path, action) => action();
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "workbench-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function repo(root: string) {
  await run(root, "git", ["init", "-q"]);
  await run(root, "git", ["config", "user.email", "test@example.com"]);
  await run(root, "git", ["config", "user.name", "Test"]);
}
test("parses staged/unstaged independently and handles rename records and odd names", () => {
  assert.deepEqual(parseStatus("MM a.ts\0R  new name.ts\0old name.ts\0?? odd\nname\0"), [
    { path: "a.ts", status: "MM", staged: true, untracked: false },
    { path: "a.ts", status: "MM", staged: false, untracked: false },
    { path: "new name.ts", status: "R ", staged: true, untracked: false },
    { path: "odd\nname", status: "??", staged: false, untracked: true },
  ]);
});
test("fuzzy file matching is subsequence-based and deterministic", () => {
  assert.deepEqual(fuzzy(["src/server.ts", "README.md", "src/session.ts"], "ssv"), ["src/server.ts"]);
  assert.equal(fuzzy(["src/server.ts", "server.ts"], "server")[0], "server.ts");
});
test("file listing and literal search respect ignore rules and filenames with newlines", async t => {
  const root = await fixture(t); await repo(root);
  await writeFile(join(root, ".gitignore"), "ignored/\n"); await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "secret"), "needle");
  await writeFile(join(root, "odd\nname.ts"), "zero\nneedle [x]\n");
  await writeFile(join(root, ".hidden"), "needle");
  const p = new Project(root), files = await p.files();
  assert(files.includes("odd\nname.ts")); assert(files.includes(".hidden")); assert(!files.some(f => f.startsWith("ignored/")));
  assert.deepEqual((await p.search("[x]")).hits, [{ path: "odd\nname.ts", line: 2, text: "needle [x]" }]);
  assert.equal((await p.search("missing")).hits.length, 0);
});
test("atomic save preserves bytes and mode and blocks external edits", async t => {
  const root = await fixture(t), file = join(root, "file.ts"), text = "\ufeff\tconst x = 1;\r\nlast";
  await writeFile(file, text); await chmod(file, 0o751);
  const p = new Project(root), d = await p.open("file.ts");
  await p.save(d, queue); assert.equal(await readFile(file, "utf8"), text);
  d.buffer.move(1, 4); d.buffer.replace("!"); await p.save(d, queue);
  assert.equal(await readFile(file, "utf8"), `${text}!`); assert.equal((await stat(file)).mode & 0o777, 0o751);
  d.buffer.replace("?"); await writeFile(file, "agent changed it");
  await assert.rejects(p.save(d, queue), /changed on disk/);
  assert.equal(await readFile(file, "utf8"), "agent changed it"); assert(d.buffer.dirty);
  assert(!(await readdir(root)).some(p => p.endsWith(".tmp")));
});
test("rejects binary, invalid UTF-8, oversize, outside symlink, and hard-linked save", async t => {
  const root = await fixture(t), outside = await fixture(t), p = new Project(root);
  await writeFile(join(root, "binary"), Buffer.from([0, 1])); await assert.rejects(p.open("binary"), /Binary/);
  await writeFile(join(root, "invalid"), Buffer.from([255])); await assert.rejects(p.open("invalid"), /UTF-8/);
  await writeFile(join(root, "large"), "x".repeat(1024 * 1024 + 1)); await assert.rejects(p.open("large"), /1 MiB/);
  await writeFile(join(outside, "file"), "outside"); await symlink(join(outside, "file"), join(root, "link"));
  await assert.rejects(p.open("link"), /outside/);
  await writeFile(join(root, "one"), "text"); await link(join(root, "one"), join(root, "two"));
  const d = await p.open("one"); d.buffer.replace("new"); await assert.rejects(p.save(d, queue), /hard-linked/);
});
test("real Git staged and unstaged diffs, literal pathspecs, untracked and nested workspace", async t => {
  const root = await fixture(t); await repo(root); await mkdir(join(root, "sub"));
  const name = "sub/[file].ts";
  await writeFile(join(root, name), "original\n"); await run(root, "git", ["add", "."]); await run(root, "git", ["commit", "-qm", "initial"]);
  await writeFile(join(root, name), "staged\n"); await run(root, "git", ["add", "."]);
  await writeFile(join(root, name), "working\n"); await writeFile(join(root, "sub", "new.ts"), "new\n");
  await writeFile(join(root, "elsewhere.ts"), "not in workspace\n");
  const p = new Project(join(root, "sub")), changes = await p.changes();
  assert.equal(changes.length, 3); assert(changes.every(c => !c.path.startsWith("sub/")));
  const staged = changes.find(c => c.staged)!, working = changes.find(c => !c.staged && !c.untracked)!;
  assert.match(await p.diff(staged), /\+staged/); assert.match(await p.diff(working), /\+working/);
  assert.match(await p.diff(changes.find(c => c.untracked)!), /\+new/);
});
test("symlink replacement and removal block save without recreating files", async t => {
  const root = await fixture(t); await writeFile(join(root, "a"), "a"); await writeFile(join(root, "b"), "b");
  await symlink("a", join(root, "alias")); const p = new Project(root), d = await p.open("alias");
  await rm(join(root, "alias")); await symlink("b", join(root, "alias"));
  await assert.rejects(p.save(d, queue), /target changed/);
  const a = await p.open("a"); await rm(join(root, "a")); await assert.rejects(p.save(a, queue));
});
