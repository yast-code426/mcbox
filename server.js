#!/usr/bin/env node
/**
 * Yast 高性能静态文件服务器
 * 用于本地运行 Miniblox 静态版
 * 支持: gzip压缩 / 缓存头 / SPA路由 / MIME类型 / Range请求(视频)
 * 用法: node server.js [端口号]
 * 默认端口: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = parseInt(process.argv[2]) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const COMPRESSIBLE = ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.wasm'];

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // SPA 路由: 非文件请求 → index.html
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  let filePath = path.join(ROOT, urlPath);

  // 安全: 阻止路径遍历
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA 回退: 如果不是静态文件,返回 index.html (让前端路由处理)
      if (!path.extname(urlPath) || urlPath.endsWith('.html')) {
        filePath = path.join(ROOT, 'index.html');
        fs.stat(filePath, (e2, s2) => {
          if (e2 || !s2.isFile()) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          serveFile(filePath, s2, req, res);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    serveFile(filePath, stats, req, res);
  });
});

function serveFile(filePath, stats, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // 缓存: 带哈希的文件永久缓存,其他文件缓存1小时
  const hasHash = /-[A-Za-z0-9_-]{6,}\.(js|css|webp|webm|png|wasm|otf)$/.test(filePath);
  const cacheControl = hasHash
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';

  // ETag
  const etag = `"${stats.size}-${stats.mtimeMs.toFixed(0)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'Cache-Control': cacheControl, ETag: etag });
    res.end();
    return;
  }

  // 读取文件
  let stream = fs.createReadStream(filePath);

  // Range 请求 (视频拖动)
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1]) : 0;
      const end = m[2] ? parseInt(m[2]) : stats.size - 1;
      if (start < stats.size && end < stats.size && start <= end) {
        stream = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cacheControl,
          ETag: etag,
        });
        stream.pipe(res);
        return;
      }
    }
  }

  // gzip 压缩
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const shouldCompress = COMPRESSIBLE.includes(ext) && acceptEncoding.includes('gzip') && stats.size > 1024;

  const headers = {
    'Content-Type': mime,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Accept-Ranges': 'bytes',
  };

  if (shouldCompress) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
  } else {
    headers['Content-Length'] = stats.size;
    res.writeHead(200, headers);
    stream.pipe(res);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │  Yast Miniblox 服务器已启动                  │`);
  console.log(`  │  地址: http://localhost:${PORT}              │`);
  console.log(`  │  按 Ctrl+C 停止                               │`);
  console.log(`  └──────────────────────────────────────────────┘\n`);
});
