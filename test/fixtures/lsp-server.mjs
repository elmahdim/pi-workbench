import { appendFileSync } from 'node:fs';
let bytes = Buffer.alloc(0), text = '';
function log(message) { if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify(message) + '\n'); }
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  // Exercise partial headers and UTF-8 content framing.
  process.stdout.write(frame.subarray(0, 12));
  process.stdout.write(frame.subarray(12));
}
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while (true) {
    const end = bytes.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(bytes.subarray(0, end).toString().match(/Content-Length: (\d+)/i)[1]);
    if (bytes.length < end + 4 + length) return;
    const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString());
    bytes = bytes.subarray(end + 4 + length); log(message);
    if (message.method === 'initialize') {
      if (process.argv.includes('--bad-frame')) { process.stdout.write('Content-Length: 9000000\r\n\r\n'); continue; }
      send({ jsonrpc: '2.0', id: 777, method: 'workspace/applyEdit', params: { edit: { changes: {} } } });
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { positionEncoding: 'utf-16', completionProvider: { resolveProvider: true } } } });
    } else if (message.method === 'textDocument/didOpen') text = message.params.textDocument.text;
    else if (message.method === 'textDocument/didChange') text = message.params.contentChanges[0].text;
    else if (message.method === 'textDocument/completion') {
      const reply = () => send({ jsonrpc: '2.0', id: message.id, result: { items: [
        { label: '世界', insertText: '世界', filterText: 'console', sortText: '1', detail: text },
        { label: 'console', insertText: 'console', sortText: '2' },
        { label: 'snippet', insertText: '${1:value}', insertTextFormat: 2 },
      ] } });
      if (text.includes('WAIT')) setTimeout(reply, 500); else reply();
    } else if (message.method === 'completionItem/resolve') send({ jsonrpc: '2.0', id: message.id, result: { ...message.params, detail: 'Resolved' } });
  }
});
