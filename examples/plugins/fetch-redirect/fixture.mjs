import { createServer } from "node:http";

let targetHits = 0;
const target = createServer((_req, res) => {
  console.log(`Target requests: ${++targetHits}`);
  res.end("target reached");
});
const origin = createServer((req, res) => {
  const status = Number(req.url.slice(1));
  if (![301, 302, 303, 307, 308].includes(status)) {
    res.writeHead(400).end("Use /301, /302, /303, /307 or /308");
    return;
  }
  res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/target` });
  res.end("original redirect response");
});
await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
console.log(`Probe URL: http://127.0.0.1:${origin.address().port}/302`);
console.log("error/manual: no target requests; follow: one target request per probe.");
process.once("SIGINT", () => {
  origin.close(); origin.closeAllConnections();
  target.close(); target.closeAllConnections();
});
