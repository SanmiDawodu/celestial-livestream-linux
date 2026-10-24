// Sound only (Celestial Worldwide Livestream for Linux 1.1.0): plays ?src= (HLS through hls.js, or MP3)
// and shows ?title= in the desktop's sound menu. Sets the page title to "error" if the stream fails,
// so the app can fall back to CCC Radio.
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var src = q.get('src');
  var title = q.get('title') || 'CCC Radio';
  var player = document.getElementById('player');

  function failed() { document.title = 'error'; }

  if (/\.m3u8(\?|$)/.test(src) && window.Hls && Hls.isSupported()) {
    var hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3 });
    hls.on(Hls.Events.ERROR, function (e, d) { if (d.fatal) failed(); });
    hls.loadSource(src);
    hls.attachMedia(player);
  } else {
    player.src = src;
    player.addEventListener('error', failed);
  }
  player.addEventListener('playing', function () { console.log('playing ' + title); });
  var p = player.play();
  if (p && p.catch) p.catch(function () {});

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: 'Celestial Church of Christ Worldwide',
      artwork: [{ src: 'https://cccworldwide.net/livestream-app/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    navigator.mediaSession.setActionHandler('play', function () { player.play(); });
    navigator.mediaSession.setActionHandler('pause', function () { player.pause(); });
    navigator.mediaSession.setActionHandler('stop', function () { player.pause(); });
  } catch (e) {}
})();
