import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acceptCompletion, languageId, TypeScriptCompletion } from "../src/completion.ts";
import { TextBuffer } from "../src/buffer.ts";
import { Project } from "../src/project.ts";
const server = fileURLToPath(new URL("./fixtures/lsp-server.mjs", import.meta.url));
async function fixture(t: { after: (f: () => Promise<void>) => void }, text = "co") {
  const root = await mkdtemp(join(tmpdir(), "workbench-lsp-")), file = join(root, "file.ts"), log = join(root, "messages.jsonl");
  await writeFile(file, text); const doc = await new Project(root).open("file.ts"); doc.buffer.move(0, text.length);
  const provider = new TypeScriptCompletion(root, process.execPath, [server, log]);
  t.after(async () => { provider.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, doc, log, provider };
}
test("plain completion replaces the typed prefix and undo restores original cursor", () => {
  const b = new TextBuffer("const x = con"); b.move(0, b.text.length); const cursor = { ...b.cursor };
  acceptCompletion(b, { label: "console" }); assert.equal(b.text, "const x = console");
  b.undo(); assert.equal(b.text, "const x = con"); assert.deepEqual(b.cursor, cursor);
  b.redo(); assert.equal(b.text, "const x = console");
});
test("completion text edits and auto-import edits are one lossless undo transaction", () => {
  const initial = "\r\nconst x = Fo", b = new TextBuffer(initial); b.move(1, b.lines[1].length);
  acceptCompletion(b, { label: "Foo", insertText: "Foo", additionalTextEdits: [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import { Foo } from './foo';\n",
  }] });
  assert.equal(b.text, "import { Foo } from './foo';\r\n\r\nconst x = Foo");
  assert.deepEqual(b.cursor, { line: 2, col: "const x = Foo".length });
  b.undo(); assert.equal(b.text, initial);
});
test("insert/replace completion edits use UTF-16 positions and reject unsafe edits", () => {
  const b = new TextBuffer("'😀'; co"); b.move(0, b.text.length);
  acceptCompletion(b, { label: "console", textEdit: {
    insert: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } },
    replace: { start: { line: 0, character: 6 }, end: { line: 0, character: 8 } }, newText: "console",
  } });
  assert.equal(b.text, "'😀'; console");
  const before = b.text;
  assert.throws(() => acceptCompletion(b, { label: "bad", insertTextFormat: 2 }), /Snippet/);
  assert.throws(() => acceptCompletion(b, { label: "bad", textEdit: { range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } }, newText: "bad" } }), /outside/);
  assert.equal(b.text, before);
  assert.throws(() => b.applyEdits([{ from: 0, to: 5, text: "x" }, { from: 1, to: 2, text: "y" }]), /overlapping/);
  assert.equal(b.text, before);
});
test("LSP framing, document sync, resolve, and server-issued edit refusal", async t => {
  const { doc, log, provider } = await fixture(t);
  let items = await provider.complete(doc); assert.deepEqual(items.map(i => i.label), ["世界", "console"]);
  assert.equal((await provider.resolve(items[0])).detail, "Resolved");
  doc.buffer.replace("n"); items = await provider.complete(doc); assert.equal(items[0].detail, "con");
  const messages = (await readFile(log, "utf8")).trim().split("\n").map(s => JSON.parse(s));
  assert(messages.some(m => m.method === "textDocument/didOpen")); assert(messages.some(m => m.method === "textDocument/didChange"));
  assert(messages.some(m => m.id === 777 && m.result?.applied === false));
  assert.equal(messages.find(m => m.method === "initialize").params.capabilities.textDocument.completion.completionItem.snippetSupport, false);
});
test("missing language server and malformed frames fail cleanly", async t => {
  const { root, doc } = await fixture(t);
  const missing = new TypeScriptCompletion(root, "__pi_workbench_missing_server__");
  t.after(async () => missing.stop());
  await assert.rejects(missing.complete(doc), /Install workbench dependencies/);
  const malformed = new TypeScriptCompletion(root, process.execPath, [server, join(root, "bad.log"), "--bad-frame"]);
  t.after(async () => malformed.stop());
  await assert.rejects(malformed.complete(doc), /Invalid language server frame/);
});
test("stopping the server cancels outstanding requests and is idempotent", async t => {
  const { doc, provider } = await fixture(t, "WAIT");
  const request = provider.complete(doc);
  const rejection = assert.rejects(request, /stopped|exited/);
  await new Promise(r => setTimeout(r, 100)); provider.stop(); provider.stop(); await rejection;
});
test("completion discovers a project-local server without a global install", async t => {
  const { root, doc, log } = await fixture(t);
  const directory = join(root, "node_modules/typescript-language-server/lib");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cli.mjs"), `process.argv[2] = ${JSON.stringify(log)}; await import(${JSON.stringify(pathToFileURL(server).href)});`);
  const local = new TypeScriptCompletion(root);
  t.after(async () => local.stop());
  const items = await local.complete(doc);
  assert(items.some(item => item.label === "console"));
  assert.match(await readFile(log, "utf8"), /textDocument\/completion/);
});
test("only TypeScript/JavaScript file types are enabled", () => {
  assert.equal(languageId("file.tsx"), "typescriptreact"); assert.equal(languageId("file.jsx"), "javascriptreact");
  assert.equal(languageId("file.py"), undefined);
});
