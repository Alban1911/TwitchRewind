// Twitch Rewind — Sub-only VOD Unlock
// Patches the Worker constructor to intercept fetch inside Twitch's Amazon IVS worker.
// When a usher VOD request returns 403 (sub-only), constructs a synthetic m3u8
// from direct CDN URLs. Injected into MAIN world via <script> tag at document_start.

(function () {
  'use strict';

  function log() {
    var args = ['%c[TwitchRewind]', 'color: #9147ff; font-weight: bold'].concat(
      Array.prototype.slice.call(arguments),
    );
    console.log.apply(console, args);
  }

  // ─── Worker fetch patch (string injected into each worker) ────────────────

  var WORKER_PATCH = '(' + function () {
    var CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    var QUALITIES = ['chunked', '1080p60', '720p60', '480p30', '360p30', '160p30'];
    var QUALITY_INFO = {
      chunked:  { res: '1920x1080', fps: 60, bw: 8534030 },
      '1080p60': { res: '1920x1080', fps: 60, bw: 6000000 },
      '720p60':  { res: '1280x720',  fps: 60, bw: 3500000 },
      '480p30':  { res: '854x480',   fps: 30, bw: 1500000 },
      '360p30':  { res: '640x360',   fps: 30, bw: 750000 },
      '160p30':  { res: '284x160',   fps: 30, bw: 300000 },
    };

    var _origFetch = self.fetch;

    function _log() {
      var a = ['%c[TwitchRewind]', 'color:#9147ff;font-weight:bold'].concat(
        Array.prototype.slice.call(arguments),
      );
      console.log.apply(console, a);
    }

    function _gqlMeta(vodId) {
      return _origFetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query{video(id:"' + vodId + '"){broadcastType createdAt seekPreviewsURL owner{login}}}',
        }),
      }).then(function (r) { return r.json(); })
        .then(function (d) { return d && d.data && d.data.video; });
    }

    function _checkQuality(url) {
      return _origFetch(url, { cache: 'force-cache' })
        .then(function (r) {
          if (!r.ok) return null;
          return r.text().then(function (txt) {
            if (txt.indexOf('.ts') !== -1) return 'avc1.4D001E';
            if (txt.indexOf('.mp4') !== -1) return 'avc1.4D001E';
            return null;
          });
        })
        .catch(function () { return null; });
    }

    function _buildVodUrl(domain, vodSpecialId, vodId, login, type, createdAt, quality) {
      if (type === 'highlight') {
        return 'https://' + domain + '/' + vodSpecialId + '/' + quality + '/highlight-' + vodId + '.m3u8';
      }
      if (type === 'upload') {
        var created = new Date(createdAt);
        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        if (created < cutoff) {
          return 'https://' + domain + '/' + login + '/' + vodId + '/' + vodSpecialId + '/' + quality + '/index-dvr.m3u8';
        }
      }
      return 'https://' + domain + '/' + vodSpecialId + '/' + quality + '/index-dvr.m3u8';
    }

    function _buildPlaylist(vodId, isV2) {
      return _gqlMeta(vodId).then(function (video) {
        if (!video || !video.seekPreviewsURL) return null;

        var parsed = new URL(video.seekPreviewsURL);
        var domain = parsed.host;
        var parts = parsed.pathname.split('/');
        var sbIdx = -1;
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].indexOf('storyboards') !== -1) { sbIdx = i; break; }
        }
        if (sbIdx < 1) return null;

        var vodSpecialId = parts[sbIdx - 1];
        var type = (video.broadcastType || '').toLowerCase();
        var login = video.owner ? video.owner.login : '';
        var createdAt = video.createdAt || '';

        // Check each quality sequentially
        var playlist = '#EXTM3U\n';
        playlist += '#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="EU",USER-IP="0.0.0.0",SERVING-ID="na",CLUSTER="cloudfront_vod",USER-COUNTRY="US",MANIFEST-CLUSTER="cloudfront_vod"\n';
        var bw = 8534030;
        var idx = 0;

        function next() {
          if (idx >= QUALITIES.length) {
            return playlist.indexOf('EXT-X-STREAM-INF') !== -1 ? playlist : null;
          }
          var q = QUALITIES[idx++];
          var m3u8 = _buildVodUrl(domain, vodSpecialId, vodId, login, type, createdAt, q);
          return _checkQuality(m3u8).then(function (codec) {
            if (codec) {
              var info = QUALITY_INFO[q];
              if (isV2) {
                playlist += '#EXT-X-STREAM-INF:BANDWIDTH=' + bw + ',CODECS="' + codec + ',mp4a.40.2",RESOLUTION=' + info.res + ',FRAME-RATE=' + info.fps + ',STABLE-VARIANT-ID="' + q + '",IVS-NAME="' + q + '",IVS-VARIANT-SOURCE="transcode"\n';
              } else {
                playlist += '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="' + q + '",NAME="' + q + '",AUTOSELECT=YES,DEFAULT=YES\n';
                playlist += '#EXT-X-STREAM-INF:BANDWIDTH=' + bw + ',CODECS="' + codec + ',mp4a.40.2",RESOLUTION=' + info.res + ',VIDEO="' + q + '",FRAME-RATE=' + info.fps + '\n';
              }
              playlist += m3u8 + '\n';
              bw -= 100;
            }
            return next();
          });
        }

        return next();
      });
    }

    self.fetch = function (input, init) {
      var url = (input instanceof Request) ? input.url : String(input);

      return _origFetch.apply(self, arguments).then(function (response) {
        // Replace unmuted with muted for DMCA segments
        if (url.indexOf('cloudfront') !== -1 && url.indexOf('.m3u8') !== -1) {
          return response.text().then(function (body) {
            return new Response(body.replace(/-unmuted/g, '-muted'), {
              status: response.status,
              headers: response.headers,
            });
          });
        }

        // Sub-only VOD unlock
        if (url.indexOf('usher.ttvnw.net/vod/') !== -1 && response.status !== 200) {
          var vodId = url.split('.m3u8')[0].split('/').pop();
          var isV2 = url.indexOf('/v2/') !== -1;
          _log('VOD blocked (' + response.status + '), trying CDN bypass for', vodId);

          return _buildPlaylist(vodId, isV2).then(function (playlist) {
            if (playlist) {
              _log('VOD unlocked via CDN');
              return new Response(playlist, {
                status: 200,
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
              });
            }
            return response;
          }).catch(function (e) {
            console.error('[TwitchRewind] VOD unlock error:', e);
            return response;
          });
        }

        return response;
      });
    };
  } + ')();';

  // ─── Patch Worker constructor ─────────────────────────────────────────────

  function readWorkerSource(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.overrideMimeType('text/javascript');
    xhr.send();
    return xhr.responseText;
  }

  var oldWorker = window.Worker;

  window.Worker = class Worker extends oldWorker {
    constructor(twitchBlobUrl) {
      var workerString = readWorkerSource(
        ('' + twitchBlobUrl).replaceAll("'", '%27'),
      );

      var blobUrl = URL.createObjectURL(
        new Blob([WORKER_PATCH + '\n' + workerString], {
          type: 'application/javascript',
        }),
      );

      super(blobUrl);
    }
  };

  log('VOD unlock ready');
})();
