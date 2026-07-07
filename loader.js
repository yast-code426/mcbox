/**
 * Yast Miniblox 加载器
 * 1. 注册 Service Worker
 * 2. 接收 SW 下载/解压进度
 * 3. 等待 bundle 解压完成 → 加载游戏
 */
(function () {
  'use strict';

  var loadingScreen = document.getElementById('yast-loading');
  var progressFill = document.querySelector('.yast-progress-fill');
  var progressText = document.querySelector('.yast-progress-text');

  function setProgress(pct, text) {
    if (progressFill) progressFill.style.width = pct + '%';
    if (progressText) progressText.textContent = text || (pct + '%');
  }

  setProgress(5, '正在初始化...');

  async function init() {
    if (!('serviceWorker' in navigator)) {
      console.warn('[Yast] 不支持 Service Worker,直接加载');
      loadGame();
      return;
    }

    try {
      setProgress(10, '正在注册 Service Worker...');
      await navigator.serviceWorker.register('./sw.js');
      console.log('[Yast] Service Worker 已注册');

      // 监听 SW 发来的进度
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'progress') {
          setProgress(e.data.progress, e.data.text);
        }
        if (e.data && e.data.type === 'bundle-ready') {
          console.log('[Yast] 资源已就绪,加载游戏');
          loadGame();
        }
      });

      setProgress(15, '正在下载资源包...');

      // 等待 SW 就绪
      await navigator.serviceWorker.ready;

      // 检查是否已就绪
      var ready = await new Promise(function (resolve) {
        var timeout = setTimeout(function () {
          console.warn('[Yast] SW 响应超时,直接加载');
          resolve(true);
        }, 120000);

        function onReady(e) {
          if (e.data && e.data.type === 'bundle-ready') {
            clearTimeout(timeout);
            navigator.serviceWorker.removeEventListener('message', onReady);
            resolve(true);
          }
        }
        navigator.serviceWorker.addEventListener('message', onReady);

        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage('check-ready');
        } else {
          setTimeout(function () {
            if (navigator.serviceWorker.controller) {
              navigator.serviceWorker.controller.postMessage('check-ready');
            } else {
              clearTimeout(timeout);
              resolve(true);
            }
          }, 1500);
        }
      });

      // 即使超时也尝试加载
      if (ready) loadGame();
    } catch (e) {
      console.error('[Yast] 加载失败:', e);
      setProgress(0, '加载失败: ' + e.message);
      // 失败后 3 秒尝试直接加载
      setTimeout(loadGame, 3000);
    }
  }

  function loadGame() {
    setProgress(95, '正在启动游戏...');

    var patchScript = document.createElement('script');
    patchScript.src = './assets/yast-patch.js';
    patchScript.onerror = function () {
      console.warn('[Yast] yast-patch.js 加载失败,可能资源未就绪');
    };
    document.head.appendChild(patchScript);

    var cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = './assets/index-CT5yzSTW.css';
    document.head.appendChild(cssLink);

    var moduleScript = document.createElement('script');
    moduleScript.type = 'module';
    moduleScript.src = './assets/index-BSNENdmO.js';
    document.head.appendChild(moduleScript);

    setProgress(100, '加载完成!');

    setTimeout(function () {
      if (loadingScreen) {
        loadingScreen.style.opacity = '0';
        loadingScreen.style.transition = 'opacity 0.5s';
        setTimeout(function () {
          loadingScreen.style.display = 'none';
        }, 500);
      }
    }, 1000);
  }

  init();
})();
