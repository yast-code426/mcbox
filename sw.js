/**
 * Yast Miniblox Service Worker
 * 下载多个分片 → 合并 → 解压 → 解密 → 缓存所有文件 → 拦截请求从缓存服务
 */
var CACHE_NAME = 'yast-miniblox-v1';
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

// 通知所有客户端进度
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
  // 1. 读取分片信息
  var infoResp = await fetch('./bundle.json', { cache: 'no-store' });
  var info = await infoResp.json();
  var numChunks = info.chunks;
  console.log('[Yast SW] 共 ' + numChunks + ' 个分片需要下载');

  // 2. 逐个下载分片并合并
  var chunks = [];
  for (var i = 0; i < numChunks; i++) {
    var chunkUrl = './bundle.' + i + '.bin';
    var pct = Math.round((i / numChunks) * 60);
    notifyProgress(pct, '正在下载资源包 (' + (i + 1) + '/' + numChunks + ')...');
    console.log('[Yast SW] 下载分片 ' + i + ': ' + chunkUrl);

    var resp = await fetch(chunkUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error('分片 ' + i + ' 下载失败: ' + resp.status);
    var buf = await resp.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    console.log('[Yast SW] 分片 ' + i + ' 大小: ' + (buf.byteLength / 1048576).toFixed(1) + 'MB');
  }

  // 3. 合并所有分片
  notifyProgress(65, '正在合并资源包...');
  var totalLen = 0;
  for (var j = 0; j < chunks.length; j++) totalLen += chunks[j].length;
  var compressed = new Uint8Array(totalLen);
  var offset = 0;
  for (var k = 0; k < chunks.length; k++) {
    compressed.set(chunks[k], offset);
    offset += chunks[k].length;
  }
  console.log('[Yast SW] 合并完成,总大小: ' + (totalLen / 1048576).toFixed(1) + 'MB');
  return compressed;
}

// 解压+解密+解析 bundle
async function installBundle() {
  // 1. 下载并合并分片
  var compressed = await downloadAndMergeChunks();

  // 2. Gzip 解压
  notifyProgress(75, '正在解压资源...');
  var ds = new DecompressionStream('gzip');
  var stream = new Response(compressed).body.pipeThrough(ds);
  var decompressed = await new Response(stream).arrayBuffer();
  console.log('[Yast SW] 解压后大小: ' + (decompressed.byteLength / 1048576).toFixed(1) + 'MB');

  // 3. XOR 解密
  var data = new Uint8Array(decompressed);
  var keyBytes = new TextEncoder().encode(XOR_KEY);
  for (var i = 0; i < data.length; i++) {
    data[i] ^= keyBytes[i % keyBytes.length];
  }

  // 4. 解析二进制格式
  var view = new DataView(data.buffer);
  var dec = new TextDecoder();
  var offset = 0;

  var magic = dec.decode(data.slice(0, 4));
  if (magic !== 'YAST') throw new Error('bundle 格式错误');
  offset = 4;

  var numFiles = view.getUint32(offset, true);
  offset += 4;
  console.log('[Yast SW] 解析 ' + numFiles + ' 个文件...');

  // 5. 存入 Cache API
  notifyProgress(80, '正在缓存游戏文件...');
  var cache = await caches.open(CACHE_NAME);
  var scope = self.registration.scope;
  var baseUrl = scope.endsWith('/') ? scope : scope + '/';

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
    var fullUrl = baseUrl + relPath;
    var mime = getMime(name);

    await cache.put(
      new Request(fullUrl),
      new Response(content, { headers: { 'Content-Type': mime } })
    );
    count++;
    if (count % 50 === 0) {
      var pct = 80 + Math.round((count / numFiles) * 15);
      notifyProgress(pct, '正在缓存文件 ' + count + '/' + numFiles);
      console.log('[Yast SW] 已缓存 ' + count + '/' + numFiles);
    }
  }

  // 缓存 index.html
  try {
    var indexResp = await fetch('./index.html', { cache: 'no-store' });
    if (indexResp.ok) {
      await cache.put(new Request(baseUrl), indexResp.clone());
      await cache.put(new Request(baseUrl + 'index.html'), indexResp.clone());
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
      .then(function () { return self.skipWaiting(); })
      .catch(function (e) {
        console.error('[Yast SW] 安装失败:', e);
        notifyProgress(0, '加载失败: ' + e.message);
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
          console.log('[Yast SW] 删除旧缓存:', name);
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

// 消息通信
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
