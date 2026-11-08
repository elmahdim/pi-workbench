import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Document } from "./project.ts";
import type { TextBuffer } from "./buffer.ts";

interface LspPosition { line: number; character: number }
interface Range { start: LspPosition; end: LspPosition }
export interface TextEdit { range: Range; newText: string }
export interface CompletionItem {
  label: string; detail?: string; sortText?: string; filterText?: string; insertText?: string; insertTextFormat?: number;
  textEdit?: TextEdit | { insert: Range; replace: Range; newText: string };
  additionalTextEdits?: TextEdit[]; data?: unknown;
}
export interface CompletionProvider {
  complete(doc: Document): Promise<CompletionItem[]>;
  resolve(item: CompletionItem): Promise<CompletionItem>;
  stop(): void;
}
export function languageId(path: string) {
  return ({ ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
    ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" } as Record<string, string>)[extname(path)];
}

/** Local LSP transport. No shell, automatic installation, or server-issued commands/edits. */
export class TypeScriptCompletion implements CompletionProvider {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private stopped = false;
  private serial = 0;
  private bytes = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private documents = new Map<string, { text: string; version: number }>();
  private resolveSupported = false;
  private stderr = "";
  private root: string;
  private command: string;
  private args: string[];
  constructor(root: string, command?: string, args?: string[]) {
    this.root = root;
    // Prefer the project's server, then the copy shipped as a workbench dependency.
    // Running its CLI with this Node avoids global installs and platform-specific bin shims.
    const cli = [join(root, "node_modules/typescript-language-server/lib/cli.mjs"),
      fileURLToPath(new URL("../node_modules/typescript-language-server/lib/cli.mjs", import.meta.url))].find(path => existsSync(path));
    this.command = command ?? (cli ? process.execPath : "typescript-language-server");
    this.args = args ?? (!command && cli ? [cli, "--stdio"] : ["--stdio"]);
  }
  private send(message: object) {
    if (!this.child || this.stopped) throw new Error("Language server is not running");
    const data = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${data.length}\r\n\r\n`); this.child.stdin.write(data);
  }
  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Language server timed out: ${method}`));
        if (!this.stopped) this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private receive(chunk: Buffer) {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > 8 * 1024 * 1024) throw new Error("Language server response exceeded 8 MiB");
    while (true) {
      const end = this.bytes.indexOf("\r\n\r\n"); if (end < 0) return;
      const length = Number(this.bytes.subarray(0, end).toString().match(/content-length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error("Invalid language server frame");
      if (this.bytes.length < end + 4 + length) return;
      const message = JSON.parse(this.bytes.subarray(end + 4, end + 4 + length).toString("utf8"));
      this.bytes = this.bytes.subarray(end + 4 + length);
      if (message.method && message.id !== undefined) {
        // Configuration/capability requests can be acknowledged; never execute server-issued code or workspace edits.
        const result = message.method === "workspace/configuration" ? (message.params?.items ?? []).map(() => ({}))
          : message.method === "workspace/applyEdit" ? { applied: false, failureReason: "Only completion edits accepted by the user are supported" } : null;
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } else if (message.id !== undefined) {
        const p = this.pending.get(message.id); if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message ?? "Language server request failed")); else p.resolve(message.result);
      }
    }
  }
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (this.stopped) throw new Error("Language server was stopped");
      this.child = spawn(this.command, this.args, { cwd: this.root, stdio: "pipe", detached: process.platform !== "win32" });
      this.child.stdin.on("error", () => {});
      this.child.on("error", error => { this.fail(new Error(`${error.message}. Install workbench dependencies with npm install in pi-workbench, or install typescript and typescript-language-server locally in your project, then retry completion.`)); this.stop(); });
      this.child.on("exit", (_code, signal) => { this.fail(new Error(`Language server exited${signal ? ` (${signal})` : ""}: ${this.stderr.slice(-1000)}`)); this.stop(); });
      this.child.stderr.on("data", data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
      this.child.stdout.on("data", data => { try { this.receive(data); } catch (error) { this.fail(error as Error); this.stop(); } });
      const uri = pathToFileURL(this.root).href;
      const result = await this.request("initialize", { processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: this.root }],
        capabilities: { general: { positionEncodings: ["utf-16"] }, textDocument: { completion: {
          completionItem: { snippetSupport: false, insertReplaceSupport: true, resolveSupport: { properties: ["additionalTextEdits", "detail"] } },
        } } } });
      if (result?.capabilities?.positionEncoding && result.capabilities.positionEncoding !== "utf-16") throw new Error("Language server must use UTF-16 positions");
      this.resolveSupported = !!result?.capabilities?.completionProvider?.resolveProvider;
      this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    })();
    return this.ready;
  }
  async complete(doc: Document): Promise<CompletionItem[]> {
    const language = languageId(doc.target); if (!language) throw new Error("Completion currently supports TypeScript and JavaScript files only");
    await this.start();
    const uri = pathToFileURL(doc.target).href, text = doc.buffer.text;
    const old = this.documents.get(uri), version = (old?.version ?? 0) + 1;
    if (!old) this.send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: language, version, text } } });
    else if (old.text !== text) this.send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
    this.documents.set(uri, { text, version });
    const result = await this.request("textDocument/completion", { textDocument: { uri }, position: { line: doc.buffer.cursor.line, character: doc.buffer.cursor.col }, context: { triggerKind: 1 } });
    const items = Array.isArray(result) ? result : result?.items ?? [];
    const prefix = doc.buffer.lines[doc.buffer.cursor.line].slice(0, doc.buffer.cursor.col).match(/[$_\p{ID_Continue}]*$/u)?.[0].toLowerCase() ?? "";
    const matches = (item: CompletionItem) => {
      const word = (item.filterText ?? item.label).toLowerCase(); let index = 0;
      for (const char of word) if (char === prefix[index]) index++;
      return index === prefix.length;
    };
    return items.filter((item: CompletionItem) => typeof item?.label === "string" && item.insertTextFormat !== 2 && matches(item))
      .sort((a: CompletionItem, b: CompletionItem) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)).slice(0, 200);
  }
  async resolve(item: CompletionItem): Promise<CompletionItem> {
    return this.resolveSupported ? await this.request("completionItem/resolve", item) : item;
  }
  stop() {
    if (this.stopped) return; this.stopped = true;
    this.fail(new Error("Language server stopped"));
    const child = this.child;
    if (child?.pid) {
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { child.kill(); }
    }
    this.documents.clear();
  }
}

/** Completion edits apply as one undoable transaction; server commands are deliberately ignored. */
export function acceptCompletion(buffer: TextBuffer, item: CompletionItem) {
  if (item.insertTextFormat === 2) throw new Error("Snippet completions are not supported yet");
  const offset = (position: LspPosition) => {
    const line = buffer.lines[position.line];
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || line === undefined || position.character < 0 || position.character > line.length) throw new Error("Completion edit is outside this document");
    return buffer.offset({ line: position.line, col: position.character });
  };
  const edit = item.textEdit;
  const range = edit ? "range" in edit ? edit.range : edit.replace : undefined;
  const prefix = buffer.lines[buffer.cursor.line].slice(0, buffer.cursor.col).match(/[$_\p{ID_Continue}]*$/u)?.[0] ?? "";
  const from = range ? offset(range.start) : buffer.offset() - prefix.length;
  const to = range ? offset(range.end) : buffer.offset();
  const text = edit?.newText ?? item.insertText ?? item.label;
  const edits = [{ from, to, text }, ...(item.additionalTextEdits ?? []).map(e => ({ from: offset(e.range.start), to: offset(e.range.end), text: e.newText }))];
  buffer.applyEdits(edits);
}
