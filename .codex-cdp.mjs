import { writeFile } from 'node:fs/promises';

const port = Number(process.env.CODEX_CDP_PORT || 9235);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find((entry) => entry.type === 'page' && entry.url?.startsWith('http://127.0.0.1:5173'));
if (!page) throw new Error('SeedThree preview page not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await command('Runtime.enable');
await command('Page.enable');
await command('Page.bringToFront');

const [action = 'eval', ...args] = process.argv.slice(2);
if (action === 'eval') {
  const result = await command('Runtime.evaluate', {
    expression: args.join(' '),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  console.log(JSON.stringify(result.result.value, null, 2));
} else if (action === 'shot') {
  const path = args[0] || 'C:/tmp/seedthree.png';
  const result = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(result.data, 'base64'));
  console.log(path);
} else {
  throw new Error(`Unknown action: ${action}`);
}

socket.close();
