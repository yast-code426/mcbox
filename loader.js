/**
 * Yast Miniblox 加载器
 * 1. 注册 Service Worker (用绝对路径,不受 base 影响)
 * 2. 接收 SW 进度 / 等待解压完成
 * 3. 超时自动降级: 直接从网络加载游戏文件
 */
(function () {
  'use strict';

  var BASE = window.__YAST_BASE || '/';
  var loadingScreen = document.getElementById('yast-loading');
  var progressFill = document.querySelector('.yast-progress-fill');
  var progressText = document.querySelector('.yast-progress-text');
  var gameLoaded = false;

  function setProgress(pct, text) {
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressText) progressText.textContent = text || (pct + '%');
  }

  function hideLoading() {
    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      loadingScreen.style.transition = 'opacity 0.5s';
      setTimeout(function () { loadingScreen.style.display = 'none'; }, 500);
    }
  }

  function loadGame() {
    if (gameLoaded) return;
    gameLoaded = true;
    console.log('[Yast] 加载游戏脚本...');

    var base = BASE;
    var patchScript = document.createElement('script');
    patchScript.src = base + 'assets/yast-patch.js';
    document.head.appendChild(patchScript);

    var cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = base + 'assets/index-CT5yzSTW.css';
    document.head.appendChild(cssLink);

    var moduleScript = document.createElement('script');
    moduleScript.type = 'module';
    moduleScript.src = base + 'assets/index-BSNENdmO.js';
    document.head.appendChild(moduleScript);

    setProgress(100, '加载完成!');
    setTimeout(hideLoading, 1000);
  }

  setProgress(5, '正在初始化...');

  // 不支持 SW → 直接加载
  if (!('serviceWorker' in navigator)) {
    console.warn('[Yast] 不支持 Service Worker,直接加载');
    loadGame();
    return;
  }

  // 用绝对路径注册 SW,不受 <base> 影响
  var swUrl = BASE + 'sw.js';
  console.log('[Yast] 注册 SW:', swUrl);

  navigator.serviceWorker.register(swUrl, { scope: BASE }).then(function (reg) {
    console.log('[Yast] SW 注册成功');

    // 监听 SW 消息
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data) return;
      if (e.data.type === 'progress') {
        setProgress(e.data.progress, e.data.text);
      }
      if (e.data.type === 'bundle-ready') {
        console.log('[Yast] 资源已就绪');
        loadGame();
      }
    });

    setProgress(10, '正在下载资源包...');

    // 等待 SW 就绪,但加 15 秒超时
    var swReady = navigator.serviceWorker.ready;
    var timeout = setTimeout(function () {
      console.warn('[Yast] SW 就绪超时(15s),降级直接加载');
      loadGame();
    }, 15000);

    swReady.then(function () {
      clearTimeout(timeout);
      console.log('[Yast] SW 已就绪,检查资源...');

      // 询问 SW 是否已就绪
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('check-ready');
      } else {
        // controller 还没就绪,等一下再问
        setTimeout(function () {
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage('check-ready');
          } else {
            console.warn('[Yast] 无 controller,降级直接加载');
            loadGame();
          }
        }, 1000);
      }

      // 再加 60 秒超时:如果 SW 一直没说 ready,直接加载
      setTimeout(function () {
        if (!gameLoaded) {
          console.warn('[Yast] SW 解压超时(60s),降级直接加载');
          loadGame();
        }
      }, 60000);
    }).catch(function (err) {
      clearTimeout(timeout);
      console.error('[Yast] SW ready 失败:', err);
      loadGame();
    });

  }).catch(function (err) {
    console.error('[Yast] SW 注册失败:', err);
    loadGame();
  });

  // 全局超时: 90 秒后无论如何都加载游戏
  setTimeout(function () {
    if (!gameLoaded) {
      console.warn('[Yast] 全局超时(90s),强制加载');
      loadGame();
    }
  }, 90000);

})();
