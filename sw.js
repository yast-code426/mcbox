/**
 * Yast Miniblox Service Worker
 * 下载分片 → 合并 → 解压 → 解密 → 缓存所有文件 → 拦截请求
 * 关键: 所有 fetch 使用 registration.scope 作为 base
 */
var CACHE_NAME = 'yast-miniblox-v1';
var XOR_KEY = 'YastMiniblox2026';
var bundleReady = false;
var pendingClients = [];
var SW_SCOPE = ''; // 安装时设置

var MIME_MAP = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.gltf': 'model/gltf+json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function getMime(path) {
  for (var ext in MIME_MAP) {
    if (path.endsWith(ext)) return MIME_MAP[ext];
  }
  return 'application/octet-stream';
}

function notifyProgress(progress, text) {
  self.clients.matchAll().then(function (clients) {
    for (var i = 0; i < clients.length; i++) {
      try {
        clients[i].postMessage({ type: 'progress', progress: progress, text: text });
      } catch (e) {}
    }
  });
}

// 下载所有分片并合并
async function downloadAndMergeChunks() {
  var base = SW_SCOPE;
  // 确保 base 以 / 结尾
  if (!base.endsWith('/')) base += '/';

  // 1. 读取分片信息
  var infoUrl = base + 'bundle.json';
  console.log('[Yast SW] 读取分片信息:', infoUrl);
  var infoResp = await fetch(infoUrl, { cache: 'no-store' });
  if (!infoResp.ok) throw new Error('bundle.json 下载失败: ' + infoResp.status);
  var info = await infoResp.json();
  var numChunks = info.chunks;
  console.log('[Yast SW] 共 ' + numChunks + ' 个分片');

  // 2. 逐个下载分片
  var chunks = [];
  for (var i = 0; i < numChunks; i++) {
    var chunkUrl = base + 'bundle.' + i + '.bin';
    var pct = Math.round((i / numChunks) * 50);
    notifyProgress(pct, '正在下载资源包 (' + (i + 1) + '/' + numChunks + ')...');
    console.log('[Yast SW] 下载分片 ' + i + ':', chunkUrl);

    var resp = await fetch(chunkUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error('分片 ' + i + ' 失败: ' + resp.status);
    var buf = await resp.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    console.log('[Yast SW] 分片 ' + i + ': ' + (buf.byteLength / 1048576).toFixed(1) + 'MB');
  }

  // 3. 合并
  notifyProgress(60, '正在合并资源包...');
  var totalLen = 0;
  for (var j = 0; j < chunks.length; j++) totalLen += chunks[j].length;
  var compressed = new Uint8Array(totalLen);
  var offset = 0;
  for (var k = 0; k < chunks.length; k++) {
    compressed.set(chunks[k], offset);
    offset += chunks[k].length;
  }
  console.log('[Yast SW] 合并完成: ' + (totalLen / 1048576).toFixed(1) + 'MB');
  return compressed;
}

// 解压+解密+解析
async function installBundle() {
  SW_SCOPE = self.registration.scope;
  console.log('[Yast SW] scope:', SW_SCOPE);

  var compressed = await downloadAndMergeChunks();

  // Gzip 解压
  notifyProgress(70, '正在解压资源...');
  var ds = new DecompressionStream('gzip');
  var stream = new Response(compressed).body.pipeThrough(ds);
  var decompressed = await new Response(stream).arrayBuffer();
  console.log('[Yast SW] 解压后: ' + (decompressed.byteLength / 1048576).toFixed(1) + 'MB');

  // XOR 解密
  var data = new Uint8Array(decompressed);
  var keyBytes = new TextEncoder().encode(XOR_KEY);
  for (var i = 0; i < data.length; i++) {
    data[i] ^= keyBytes[i % keyBytes.length];
  }

  // 解析二进制
  var view = new DataView(data.buffer);
  var dec = new TextDecoder();
  var offset = 0;
  var magic = dec.decode(data.slice(0, 4));
  if (magic !== 'YAST') throw new Error('bundle 格式错误: ' + magic);
  offset = 4;
  var numFiles = view.getUint32(offset, true);
  offset += 4;
  console.log('[Yast SW] 解析 ' + numFiles + ' 个文件...');

  // 存入 Cache API
  notifyProgress(75, '正在缓存游戏文件...');
  var cache = await caches.open(CACHE_NAME);
  var base = SW_SCOPE;
  if (!base.endsWith('/')) base += '/';

  var count = 0;
  for (var fi = 0; fi < numFiles; fi++) {
    var nameLen = view.getUint16(offset, true);
    offset += 2;
    var name = dec.decode(data.slice(offset, offset + nameLen));
    offset += nameLen;
    var contentLen = view.getUint32(offset, true);
    offset += 4;
    var content = data.slice(offset, offset + contentLen);
    offset += contentLen;

    var relPath = name.replace(/^\//, '');
    var fullUrl = base + relPath;
    var mime = getMime(name);

    try {
      await cache.put(
        new Request(fullUrl),
        new Response(content, { headers: { 'Content-Type': mime } })
      );
    } catch (e) {
      console.warn('[Yast SW] 缓存失败:', relPath, e);
    }
    count++;
    if (count % 30 === 0) {
      var pct = 75 + Math.round((count / numFiles) * 20);
      notifyProgress(pct, '正在缓存 ' + count + '/' + numFiles);
    }
  }

  // 缓存 index.html
  try {
    var indexResp = await fetch(base + 'index.html', { cache: 'no-store' });
    if (indexResp.ok) {
      await cache.put(new Request(base), indexResp.clone());
      await cache.put(new Request(base + 'index.html'), indexResp.clone());
    }
  } catch (e) {}

  notifyProgress(100, '加载完成!');
  console.log('[Yast SW] ✓ 全部 ' + count + ' 个文件已缓存');
  bundleReady = true;

  for (var ci = 0; ci < pendingClients.length; ci++) {
    try { pendingClients[ci].postMessage({ type: 'bundle-ready' }); } catch (e) {}
  }
  pendingClients = [];
}

// 安装
self.addEventListener('install', function (event) {
  console.log('[Yast SW] 安装中...');
  event.waitUntil(
    installBundle()
      .then(function () {
        console.log('[Yast SW] 安装完成,跳过等待');
        return self.skipWaiting();
      })
      .catch(function (e) {
        console.error('[Yast SW] 安装失败:', e);
        notifyProgress(0, '加载失败: ' + e.message);
        // 即使失败也 skipWaiting,让 loader.js 的超时降级生效
        return self.skipWaiting();
      })
  );
});

// 激活
self.addEventListener('activate', function (event) {
  console.log('[Yast SW] 激活...');
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE_NAME) {
          return caches.delete(name);
        }
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// 请求拦截
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // HTML 导航: 网络优先
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (resp) {
        var clone = resp.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, clone);
        });
        return resp;
      }).catch(function () {
        return caches.match(event.request).then(function (c) {
          return c || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 其他: 缓存优先 (ignoreSearch 忽略 ?v=xxx)
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return resp;
      }).catch(function () {
        return new Response('', { status: 404 });
      });
    })
  );
});

// 消息
self.addEventListener('message', function (event) {
  if (event.data === 'check-ready') {
    if (bundleReady) {
      event.source.postMessage({ type: 'bundle-ready' });
    } else {
      pendingClients.push(event.source);
    }
  } else if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
