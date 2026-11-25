import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const executable = process.argv[2];
const expectedVersion = process.env.STUDIO_EXPECTED_VERSION;
if (!executable) throw new Error("Expected installed executable");
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion || "")) throw new Error("Expected a valid product version");
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer(); socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => { const selected = socket.address().port; socket.close(() => resolve(selected)); });
});
const profile = path.join(process.env.RUNNER_TEMP, "markdown-studio-webview-smoke");
await mkdir(profile, { recursive: true });
const child = spawn(executable, [], { windowsHide: true, env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*` } });
let socket;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  let page;
  while (Date.now() < deadline && !page) {
    if (child.exitCode !== null) throw new Error(`Installed app exited: ${child.exitCode}`);
    try { page = (await (await fetch(endpoint + "/json")).json()).find(target => target.type === "page" && target.url.includes("tauri")); } catch { /* Starting. */ }
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error("Installed WebView did not start");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Installed app did not respond")), 30000);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      if (message.error || message.result.exceptionDetails) reject(new Error("Installed app failed to initialize"));
      else resolve(message.result.result.value);
    };
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { awaitPromise: true, returnByValue: true, expression: `(async () => {
      for (let n = 0; n < 100 && (!document.querySelector('header') || document.querySelector('header').inert); n++) await new Promise(r => setTimeout(r, 100));
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const version = await invoke('app_version');
      const themes = await invoke('themes');
      const output = await invoke('render_copy', { markdown: '# 首版验证\\n\\n正文内容', themeId: 'studio-international' });
      return { version, theme: themes.some(t => t.id === 'studio-international'), rendered: output.html.includes('正文内容') };
    })()` } }));
  });
  assert.deepEqual(result, { version: expectedVersion, theme: true, rendered: true });
  console.log("Installed Windows application: startup, version, theme, and rendering passed");
} finally {
  if (socket) socket.close();
  child.kill();
}
