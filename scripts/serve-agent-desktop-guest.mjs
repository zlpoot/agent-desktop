import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.argv[2];
const port = Number(process.argv[3] ?? 18766);
if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Usage: node scripts/serve-agent-desktop-guest.mjs <Host VM-network IPv4> [port]");
}
const guestDir = join(dirname(fileURLToPath(import.meta.url)), "..", "guest");
const files = new Map([
  ["/worker.ps1", join(guestDir, "worker.ps1")],
  ["/start-worker.ps1", join(guestDir, "start-worker.ps1")],
]);
const server = createServer(async (request, response) => {
  const file = request.method === "GET" && files.get(request.url ?? "");
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length, "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end(String(error));
  }
});
server.listen(port, host, () => {
  console.log(`Guest file transfer: http://${host}:${port}/worker.ps1`);
  console.log("This temporary server closes after 20 minutes.");
});
setTimeout(() => server.close(), 20 * 60 * 1000).unref();
