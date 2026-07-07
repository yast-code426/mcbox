/**
 * Yast Miniblox 加载器 v2
 * 注册 SW → 等待解压完成 → 加载游戏
 * 如果 SW 失败,显示错误提示让用户刷新
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

  function showError(msg) {
    if (progressText) {
      progressText.innerHTML = '<span style="color:#f87171">' + msg + '</span><br><span style="color:#666;font-size:12px;margin-top:8px;display:block">请刷新页面重试,或检查浏览器控制台(F12)</span>';
    }
    if (progressFill) progressFill.style.background = '#f87171';
  }

  function loadGame() {
    if (gameLoaded) return;
    gameLoaded = true;
    console.log('[Yast] 加载游戏脚本...');

    var patchScript = document.createElement('script');
    patchScript.src = BASE + 'assets/yast-patch.js';
    patchScript.onerror = function () {
      console.error('[Yast] yast-patch.js 加载失败 — SW 缓存可能未就绪');
      gameLoaded = false;
      showError('游戏资源未就绪,请刷新页面');
    };
    document.head.appendChild(patchScript);

    var cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = BASE + 'assets/index-CT5yzSTW.css';
    document.head.appendChild(cssLink);

    var moduleScript = document.createElement('script');
    moduleScript.type = 'module';
    moduleScript.src = BASE + 'assets/index-BSNENdmO.js';
    document.head.appendChild(moduleScript);

    setProgress(100, '加载完成!');
    setTimeout(hideLoading, 1000);
  }

  setProgress(5, '正在初始化...');

  if (!('serviceWorker' in navigator)) {
    showError('浏览器不支持 Service Worker,无法运行游戏');
    return;
  }

  var swUrl = BASE + 'sw.js';
  console.log('[Yast] 注册 SW:', swUrl);

  navigator.serviceWorker.register(swUrl, { scope: BASE }).then(function (reg) {
    console.log('[Yast] SW 注册成功, state:', reg.installing ? 'installing' : reg.waiting ? 'waiting' : reg.active ? 'active' : 'unknown');

    // 监听 SW 消息
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data) return;
      if (e.data.type === 'progress') {
        setProgress(e.data.progress, e.data.text);
      }
      if (e.data.type === 'bundle-ready') {
        console.log('[Yast] ✓ 资源就绪,加载游戏');
        loadGame();
      }
    });

    setProgress(10, '正在下载资源包...');

    // 等待 SW 就绪
    navigator.serviceWorker.ready.then(function () {
      console.log('[Yast] SW ready, controller:', !!navigator.serviceWorker.controller);

      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('check-ready');
      } else {
        // controller 可能还没就绪,监听 controllerchange
        navigator.serviceWorker.addEventListener('controllerchange', function () {
          console.log('[Yast] controller 就绪');
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage('check-ready');
          }
        });
        // 也设个超时
        setTimeout(function () {
          if (!gameLoaded && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage('check-ready');
          } else if (!gameLoaded) {
            // 刷新页面让 SW 接管
            console.warn('[Yast] 无 controller,刷新页面');
            location.reload();
          }
        }, 5000);
      }
    }).catch(function (err) {
      console.error('[Yast] SW ready 失败:', err);
      showError('Service Worker 启动失败,请刷新页面');
    });

  }).catch(function (err) {
    console.error('[Yast] SW 注册失败:', err);
    showError('Service Worker 注册失败: ' + err.message);
  });

  // 全局超时: 120 秒后显示错误
  setTimeout(function () {
    if (!gameLoaded) {
      console.error('[Yast] 全局超时(120s)');
      showError('加载超时,请刷新页面重试');
    }
  }, 120000);

})();
