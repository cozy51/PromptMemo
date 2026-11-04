// A local server for `npm run dev`.  The app is plain static files, so this
// only serves them, with the same headers vercel.json sets in production: a
// Content-Security-Policy problem then shows up here, not after deploying.
// Built on Node's own modules, so `npm install` has nothing to download.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT) || 3000;
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const headers = vercel.headers.flatMap((rule) => rule.headers);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function resolveFile(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.resolve(root, `.${pathname}`);
  // Never serve anything outside the project folder.
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  // Like Vercel's cleanUrls: /index serves index.html.
  if (fs.existsSync(`${file}.html`)) return `${file}.html`;
  return null;
}

http.createServer((request, response) => {
  headers.forEach(({ key, value }) => response.setHeader(key, value));
  response.setHeader("Cache-Control", "no-store");
  const file = resolveFile(request.url || "/");
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}).listen(port, () => {
  console.log(`Prompt Memo: http://localhost:${port}/ で起動しました（Ctrl+C で終了）`);
});
