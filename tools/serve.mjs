/**
 * 极简静态服务器（零依赖）
 *
 * 为什么必须用服务器而不是直接双击 index.html：
 *   原型用原生 ES Module（<script type="module">），浏览器在 file:// 协议下
 *   会因为同源策略拒绝加载模块，页面会白屏且控制台只报一个含糊的 CORS 错误。
 *   这是「第一次跑原型」最常踩的坑，所以把服务器直接做进工程里。
 *
 * 运行：node tools/serve.mjs [端口]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] ?? 5173);

/** 必须显式声明 MIME：.js 如果不是 text/javascript，浏览器会拒绝执行模块 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 把 URL 路径解析成磁盘路径，并阻止 ../ 越权访问工程目录之外 */
function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = resolve(join(ROOT, normalize(clean)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0].split('#')[0]);

  // 根路径重定向到 /prototype/ 而不是直接吐出 index.html。
  // 原因：index.html 里的资源路径是相对的（./styles.css、./src/main.js），
  // 若 URL 停在 "/"，浏览器会把它们解析成 /styles.css —— 全部 404。
  // 这种失败在浏览器里只表现为「白屏 + 三个 404」，非常费时间，所以在这里一次性解决。
  if (urlPath === '/' || urlPath === '/prototype') {
    res.writeHead(302, { Location: '/prototype/' }).end();
    return;
  }

  let filePath = resolveSafe(urlPath);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      // 目录必须带结尾斜杠，否则相对路径同样会解析错
      if (!urlPath.endsWith('/')) {
        res.writeHead(302, { Location: urlPath + '/' }).end();
        return;
      }
      filePath = join(filePath, 'index.html');
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // 开发期禁用缓存，改一行代码刷新就能看到，不用强刷
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`原型已启动：http://127.0.0.1:${PORT}/prototype/`);
  console.log(`工程根目录：${ROOT}`);
  console.log('提示：改数值请编辑 design/numbers/cards.json，然后运行 npm run gen');
});
