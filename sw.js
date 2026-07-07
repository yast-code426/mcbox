/**
 * Yast Miniblox Service Worker v2
 * 修复: 用 Response blob 解压代替流式 pipeThrough (避免卡住)
 * 下载分片 → 合并 → 解压 → 解密 → 缓存 → 拦截请求
 */
var CACHE_NAME = 'yast-miniblox-v2';
var XOR_KEY = 'YastMiniblox2026';
var bundleReady = false;
var pendingClients = [];

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

async function installBundle() {
  var scope = self.registration.scope;
  if (!scope.endsWith('/')) scope += '/';
  console.log('[Yast SW] scope:', scope);

  // 1. 读取分片信息
  notifyProgress(5, '读取分片信息...');
  var infoResp = await fetch(scope + 'bundle.json', { cache: 'no-store' });
  if (!infoResp.ok) throw new Error('bundle.json 失败: ' + infoResp.status);
  var info = await infoResp.json();
  var numChunks = info.chunks;
  console.log('[Yast SW] 分片数:', numChunks);

  // 2. 下载所有分片
  var chunks = [];
  for (var i = 0; i < numChunks; i++) {
    var pct = 5 + Math.round((i / numChunks) * 45);
    notifyProgress(pct, '下载资源包 (' + (i + 1) + '/' + numChunks + ')...');
    var resp = await fetch(scope + 'bundle.' + i + '.bin', { cache: 'no-store' });
    if (!resp.ok) throw new Error('分片 ' + i + ' 失败: ' + resp.status);
    var buf = await resp.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    console.log('[Yast SW] 分片 ' + i + ': ' + (buf.byteLength / 1048576).toFixed(1) + 'MB');
  }

  // 3. 合并分片
  notifyProgress(55, '合并资源包...');
  var totalLen = 0;
  for (var j = 0; j < chunks.length; j++) totalLen += chunks[j].length;
  var compressed = new Uint8Array(totalLen);
  var offset = 0;
  for (var k = 0; k < chunks.length; k++) {
    compressed.set(chunks[k], offset);
    offset += chunks[k].length;
  }
  chunks = null; // 释放内存
  console.log('[Yast SW] 合并完成: ' + (totalLen / 1048576).toFixed(1) + 'MB');

  // 4. Gzip 解压 — 用 Response + DecompressionStream,但用 blob 方式
  notifyProgress(60, '解压资源中...');
  console.log('[Yast SW] 开始解压...');

  var decompressedData;
  try {
    // 方法1: DecompressionStream (现代浏览器)
    var blob = new Blob([compressed]);
    var ds = new DecompressionStream('gzip');
    var decompressedStream = blob.stream().pipeThrough(ds);
    var decompressedBlob = await new Response(decompressedStream).blob();
    decompressedData = new Uint8Array(await decompressedBlob.arrayBuffer());
    console.log('[Yast SW] 解压完成(DecompressionStream): ' + (decompressedData.length / 1048576).toFixed(1) + 'MB');
  } catch (e1) {
    console.warn('[Yast SW] DecompressionStream 失败:', e1.message, '尝试备用方案...');
    // 方法2: 如果 DecompressionStream 不行,改用未压缩的 bundle
    // 但我们没有未压缩的,所以这里只能报错
    throw new Error('解压失败: ' + e1.message);
  }

  compressed = null; // 释放内存

  // 5. XOR 解密
  notifyProgress(70, '解密资源...');
  var keyBytes = new TextEncoder().encode(XOR_KEY);
  for (var i2 = 0; i2 < decompressedData.length; i2++) {
    decompressedData[i2] ^= keyBytes[i2 % keyBytes.length];
  }

  // 6. 解析二进制格式
  notifyProgress(75, '解析文件列表...');
  var data = decompressedData;
  var view = new DataView(data.buffer);
  var dec = new TextDecoder();
  var pos = 0;

  var magic = dec.decode(data.slice(0, 4));
  if (magic !== 'YAST') throw new Error('格式错误: ' + magic);
  pos = 4;

  var numFiles = view.getUint32(pos, true);
  pos += 4;
  console.log('[Yast SW] 文件数:', numFiles);

  // 7. 存入 Cache API
  notifyProgress(78, '缓存游戏文件...');
  var cache = await caches.open(CACHE_NAME);

  var count = 0;
  for (var fi = 0; fi < numFiles; fi++) {
    var nameLen = view.getUint16(pos, true);
    pos += 2;
    var name = dec.decode(data.slice(pos, pos + nameLen));
    pos += nameLen;
    var contentLen = view.getUint32(pos, true);
    pos += 4;
    var content = data.slice(pos, pos + contentLen);
    pos += contentLen;

    var relPath = name.replace(/^\//, '');
    var fullUrl = scope + relPath;
    var mime = getMime(name);

    try {
      await cache.put(
        new Request(fullUrl),
        new Response(content, { headers: { 'Content-Type': mime } })
      );
    } catch (e) {
      console.warn('[Yast SW] 缓存失败:', relPath);
    }
    count++;
    if (count % 25 === 0) {
      var pct2 = 78 + Math.round((count / numFiles) * 17);
      notifyProgress(pct2, '缓存 ' + count + '/' + numFiles);
      console.log('[Yast SW] 缓存进度: ' + count + '/' + numFiles);
    }
  }

  // 8. 缓存 index.html
  try {
    var indexResp = await fetch(scope + 'index.html', { cache: 'no-store' });
    if (indexResp.ok) {
      await cache.put(new Request(scope), indexResp.clone());
      await cache.put(new Request(scope + 'index.html'), indexResp.clone());
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
  console.log('[Yast SW v2] 安装中...');
  event.waitUntil(
    installBundle()
      .then(function () {
        console.log('[Yast SW v2] 安装完成');
        return self.skipWaiting();
      })
      .catch(function (e) {
        console.error('[Yast SW v2] 安装失败:', e);
        notifyProgress(0, '加载失败: ' + e.message);
        return self.skipWaiting();
      })
  );
});

// 激活
self.addEventListener('activate', function (event) {
  console.log('[Yast SW v2] 激活...');
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE_NAME) {
          console.log('[Yast SW v2] 删旧缓存:', name);
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
      // 立即发一条当前状态
      event.source.postMessage({ type: 'progress', progress: 0, text: '正在处理资源...' });
    }
  } else if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
