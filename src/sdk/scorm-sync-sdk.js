/* scorm-sync-sdk.js — SCORM Sync SDK v2
 * Servi bundlé avec socket.io.min.js par le backend via GET /sdk/scorm-sync-sdk.js
 * Le bundle = socket.io.min.js + ce fichier (concaténés à la volée par server.js)
 *
 * Point d'entrée unique : window.ScormSync
 *   ScormSync.init(backendUrl) — lit student_id/name depuis l'API SCORM 1.2
 *   ScormSync.on(event, fn)
 *   ScormSync.join({ code })   — learnerId/Name auto-détectés, pas besoin de les passer
 *   ScormSync.arrived(syncPoint)
 *   ScormSync.vote(value)
 *   ScormSync.sessionComplete({ score, correct, total })
 *   ScormSync.generateQRCode(containerId, syncPoint)
 *   ScormSync.isDegraded()
 *   ScormSync.destroy()
 */
(function (root) {
  'use strict';

  // ── SCORM 1.2 API detection ──────────────────────────────────────────────
  function getAPI() {
    var win = window;
    for (var i = 0; i < 10; i++) {
      if (win.API) return win.API;
      if (!win.parent || win.parent === win) break;
      win = win.parent;
    }
    try { if (window.top && window.top.API) return window.top.API; } catch (e) {}
    try {
      if (window.opener) {
        win = window.opener;
        for (var j = 0; j < 10; j++) {
          if (win.API) return win.API;
          if (!win.parent || win.parent === win) break;
          win = win.parent;
        }
      }
    } catch (e) {}
    return null;
  }

  // ── Délais mode dégradé (ms) ─────────────────────────────────────────────
  var SOLO_OPEN_DELAY     = 1500;
  var SOLO_VOTE_SECONDS   = 20;
  var SOLO_RESULT_DELAY   = 500;
  var SOLO_CONTINUE_DELAY = 2500;

  // ════════════════════════════════════════════════════════════════════════════
  function ScormSync(config) {
    config = config || {};
    this._url         = config.backendUrl || 'http://localhost:3000';
    this._handlers    = {};
    this._socket      = null;
    this._token       = null;
    this._degraded    = false;
    this._syncPoint   = null;
    this._soloActive  = false;
    this._soloTimers  = [];
    this._learnerId   = config.learnerId   || null;
    this._learnerName = config.learnerName || null;
    this._roomCode    = null;
    this._roomId      = null;
  }

  // ── Event emitter ────────────────────────────────────────────────────────
  ScormSync.prototype.on = function (event, fn) {
    this._handlers[event] = fn;
    return this;
  };

  ScormSync.prototype._fire = function (event, data) {
    var fn = this._handlers[event];
    if (typeof fn === 'function') fn(data);
  };

  // ── join({ code }) ───────────────────────────────────────────────────────
  ScormSync.prototype.join = function (opts) {
    opts = opts || {};
    var self = this;

    var learnerId   = self._learnerId   || opts.learnerId   || ('learner-' + Date.now());
    var learnerName = self._learnerName || opts.learnerName || 'Apprenant';
    // Save resolved IDs so registerToken() and getIdentity() use the same values
    self._learnerId   = learnerId;
    self._learnerName = learnerName;

    if (!opts.code) {
      self._enterDegraded('Aucun code salle');
      return Promise.resolve({ degraded: true });
    }

    self._roomCode = opts.code;

    return self._post('/api/auth/learner-token', null, { learnerId: learnerId, name: learnerName })
      .then(function (data) {
        return self._post('/api/rooms/join', data.token, { code: opts.code });
      })
      .then(function (data) {
        if (!data.token) throw new Error('Salle introuvable');
        self._token  = data.token;
        self._roomId = data.roomId;
        self._connectSocket();
        return { degraded: false };
      })
      .catch(function (err) {
        console.warn('[ScormSync] mode dégradé :', err.message);
        self._enterDegraded(err.message);
        return { degraded: true };
      });
  };

  // ── arrived(syncPoint) ──────────────────────────────────────────────────
  ScormSync.prototype.arrived = function (syncPoint) {
    this._syncPoint = syncPoint;
    if (this._degraded) {
      this._soloArrived(syncPoint);
      return;
    }
    var self = this;
    if (!self._socket) return;
    if (self._socket.connected) {
      self._socket.emit('learner_arrived', { syncPoint: syncPoint });
    } else {
      self._socket.once('connect', function () {
        self._socket.emit('learner_arrived', { syncPoint: syncPoint });
      });
    }
  };

  // ── vote(value) ─────────────────────────────────────────────────────────
  ScormSync.prototype.vote = function (value) {
    if (this._degraded) {
      this._fire('vote_ack', { ok: true });
      if (this._soloActive) {
        this._soloActive = false;
        this._clearSoloTimers();
        this._soloResult(this._syncPoint, value);
      }
      return;
    }
    if (this._socket && this._socket.connected) {
      this._socket.emit('submit_vote', { value: value });
    }
  };

  // ── sessionComplete({ score, correct, total }) ───────────────────────────
  ScormSync.prototype.sessionComplete = function (data) {
    if (this._degraded || !this._socket || !this._socket.connected) return;
    this._socket.emit('session_complete', data);
  };

  // ── registerToken(roomCode) → Promise<token> ────────────────────────────
  ScormSync.prototype.registerToken = function (roomCode) {
    var self = this;
    var chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789';
    var token = '';
    for (var i = 0; i < 8; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
    var payload = {
      token:       token,
      studentId:   self._learnerId   || 'anonymous',
      studentName: self._learnerName || 'Apprenant',
      roomCode:    roomCode,
    };
    console.log('[SDK] registerToken →', JSON.stringify(payload));
    return self._post('/api/auth/register-token', null, payload).then(function () { return token; });
  };

  // ── generateQRCode(divId, roomCode) → Promise<url> ──────────────────────
  ScormSync.prototype.generateQRCode = function (divId, roomCode) {
    var self = this;
    self._roomCode = roomCode || self._roomCode;
    return self.registerToken(self._roomCode).then(function (token) {
      var url = self._url
        + '/vote?room=' + encodeURIComponent(self._roomCode)
        + '&token='     + encodeURIComponent(token);
      self._voteUrl = url;
      self._renderFromUrl(divId, url, 192);
      return url;
    }).catch(function (err) {
      console.warn('[ScormSync] generateQRCode:', err.message);
      return null;
    });
  };

  // ── _renderFromUrl(containerId, url, size) ───────────────────────────────
  ScormSync.prototype._renderFromUrl = function (containerId, url, size) {
    var self = this;
    var container = document.getElementById(containerId);
    if (!container || !url) return;
    size = size || 192;

    function doRender() {
      container.innerHTML = '';
      var qrDiv = document.createElement('div');
      try {
        new QRCode(qrDiv, { text: url, width: size, height: size, colorDark: '#000', colorLight: '#fff' });
      } catch (e) { qrDiv.textContent = 'QR indisponible'; }
      container.appendChild(qrDiv);
      var el = document.createElement('div');
      el.style.cssText = 'font-size:10px;color:#64748b;margin-top:4px;text-align:center;word-break:break-all;max-width:220px';
      el.textContent = url;
      container.appendChild(el);
    }

    if (typeof QRCode !== 'undefined') {
      doRender();
    } else {
      var s = document.createElement('script');
      s.src = self._url + '/sdk/qrcode.min.js?ngrok-skip-browser-warning=true';
      s.onload = doRender;
      s.onerror = function () { if (container) container.textContent = url; };
      document.head.appendChild(s);
    }
  };

  // ── getIdentity() ────────────────────────────────────────────────────────
  ScormSync.prototype.getIdentity = function () {
    return { studentId: this._learnerId, studentName: this._learnerName };
  };

  // ── sendQuestionData(syncPoint, question, choices, correct, multipleCorrect) ──
  ScormSync.prototype.sendQuestionData = function (syncPoint, question, choices, correct, multipleCorrect) {
    var self = this;
    console.log('[SDK] sendQuestionData arg5 multipleCorrect:', multipleCorrect, '| sp:', syncPoint);
    if (self._degraded || !self._socket || !self._socket.connected) return Promise.resolve();
    return new Promise(function (resolve) {
      var payload = { syncPoint: syncPoint, question: question, choices: choices, correct: correct || null, multipleCorrect: multipleCorrect || 0 };
      console.log('[SDK] question_data payload multipleCorrect:', payload.multipleCorrect);
      self._socket.emit('question_data', payload, function (ack) { resolve(ack); });
    });
  };

  // ── continueAllAuto(score, correct, total) ──────────────────────────────
  ScormSync.prototype.continueAllAuto = function (score, correct, total) {
    if (this._degraded || !this._socket || !this._socket.connected) return;
    this._socket.emit('continue_all_auto', { score: score, correct: correct, total: total });
  };

  // ── destroy() ───────────────────────────────────────────────────────────
  ScormSync.prototype.destroy = function () {
    this._clearSoloTimers();
    if (this._socket) this._socket.disconnect();
  };

  ScormSync.prototype.isDegraded = function () { return this._degraded; };

  ScormSync.prototype.getRoomId = function () { return this._roomId; };

  // ── startQuiz(roomCode, quizId, onComplete) ──────────────────────────────
  ScormSync.prototype.startQuiz = function (roomCode, quizId, onComplete) {
    var self    = this;
    quizId      = quizId || 'quiz1';
    var _q      = [];
    var _qi     = 0;
    var _ans    = [];
    var _state  = null;
    var _timer  = null;
    var _adv    = null;
    var _pend   = null;

    // CSS (injected once)
    if (!document.getElementById('_sqzCSS')) {
      var s = document.createElement('style');
      s.id = '_sqzCSS';
      s.textContent = '@keyframes _sqzSpin{to{transform:rotate(360deg)}}'
        + '._sqzSp{width:32px;height:32px;border:3px solid #e2e8f0;border-top-color:#3b82f6;'
        + 'border-radius:50%;animation:_sqzSpin 1s linear infinite;margin:0 auto 10px}'
        + '._sqzBtn{display:block;width:100%;padding:11px 12px;border:none;border-radius:8px;'
        + 'font-size:14px;font-weight:700;color:#fff;cursor:pointer;text-align:left;line-height:1.3}'
        + '._sqzRR{display:grid;grid-template-columns:22px 1fr 58px 34px;gap:5px;'
        + 'align-items:center;padding:5px 8px;border-radius:6px;border:1.5px solid transparent}'
        + '._sqzRR.ok{border-color:#22c55e;background:#f0fdf4}';
      document.head.appendChild(s);
    }

    function $c() { return document.getElementById('sync-quiz-container'); }
    function setHtml(h) { var c = $c(); if (c) c.innerHTML = h; }
    function spin(msg) {
      return '<div style="text-align:center;padding:32px 16px">'
        + '<div class="_sqzSp"></div>'
        + '<p style="color:#64748b;font-size:14px;margin:0">' + msg + '</p></div>';
    }

    // ── Event handlers (set before socket connects) ──────────────────────
    self.on('learner_connected', function (d) {
      if (_state !== 'qr') return;
      var el = document.getElementById('_sqzPhSt');
      if (el) el.innerHTML = '<span style="color:#15803d;font-weight:700">✓ '
        + (d.learnerName || 'Smartphone') + ' connecté</span>';
      setTimeout(function () { enterQ(0); }, 1500);
    });

    self.on('vote_open', function (d) {
      if (_state === 'waiting') {
        openVote(d);
      } else if (_state === 'loading' || _state === 'qr') {
        _pend = d;
        if (_state === 'qr') enterQ(0);
      }
    });

    self.on('vote_result', function (d) { onResult(d); });

    self.on('continue_all', function () {
      if (_state === 'qr')     { enterQ(0); return; }
      if (_state === 'result') { clearTimeout(_adv); advance(); }
    });

    self.on('skip_sync', function () {
      if (_state === 'result') { clearTimeout(_adv); advance(); }
    });

    // ── Phases ────────────────────────────────────────────────────────────
    function showQR(url) {
      _state = 'qr';
      setHtml('<div style="text-align:center;padding:20px 16px">'
        + '<p style="font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;'
        + 'letter-spacing:.06em;margin:0 0 8px">Scannez avec votre smartphone</p>'
        + '<div id="_sqzQR" style="display:inline-block;padding:10px;background:#fff;'
        + 'border-radius:10px;border:1px solid #e2e8f0"></div>'
        + '<p id="_sqzPhSt" style="color:#94a3b8;font-size:13px;margin:10px 0 0">'
        + '⏳ En attente du smartphone…</p></div>');
      self._renderFromUrl('_sqzQR', url, 160);
    }

    function enterQ(index) {
      _qi    = index;
      _state = 'loading';
      clearInterval(_timer);
      var q = _q[index];
      var cho = {};
      (q.choices || []).forEach(function (c) { cho[c.letter] = c.text; });
      q._cho = cho;
      var qid = q.id || ('q' + (index + 1));

      setHtml('<div style="padding:8px 14px;font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.06em">'
        + 'Question ' + (index + 1) + ' / ' + _q.length + '</div>'
        + '<div style="padding:4px 14px 12px;font-size:17px;font-weight:700;line-height:1.4">' + q.text + '</div>'
        + '<div style="text-align:center;padding:12px 14px"><div class="_sqzSp" style="width:24px;height:24px;border-width:2px"></div>'
        + '<p style="color:#94a3b8;font-size:12px;margin:4px 0 0">En attente du vote…</p></div>');

      if (!self._degraded) {
        self.sendQuestionData(qid, q.text, q._cho, q.correct, q.multiple_correct || 0).then(function () {
          _state = 'waiting';
          if (_pend) { var pv = _pend; _pend = null; openVote(pv); }
          else self.arrived(qid);
        });
      } else {
        _state = 'waiting';
        self.arrived(qid);
      }
    }

    function openVote(d) {
      _state = 'vote';
      var q    = _q[_qi];
      var secs = d.timerSeconds || 45;
      var rem  = secs;
      var BG   = { A: '#3b82f6', B: '#22c55e', C: '#f97316', D: '#8b5cf6' };
      var btns = Object.keys(q._cho).map(function (k) {
        return '<button class="_sqzBtn" id="_sqzB' + k + '" onclick="window._sqzV(\'' + k + '\')"'
          + ' style="background:' + (BG[k] || '#3b82f6') + '">'
          + '<span style="font-size:11px;opacity:.65">' + k + '</span>  ' + q._cho[k] + '</button>';
      }).join('');

      setHtml('<div style="padding:8px 14px;font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.06em">'
        + 'Question ' + (_qi + 1) + ' / ' + _q.length + '</div>'
        + '<div style="padding:4px 14px 10px;font-size:17px;font-weight:700;line-height:1.4">' + q.text + '</div>'
        + '<div style="padding:0 14px 6px">'
        + '<div style="height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden">'
        + '<div id="_sqzTF" style="height:100%;width:100%;background:#3b82f6;border-radius:4px;transition:width 1s linear"></div></div>'
        + '<p id="_sqzTT" style="font-size:11px;color:#94a3b8;text-align:right;margin:2px 0 0">' + secs + 's</p></div>'
        + '<div style="padding:0 14px 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px">' + btns + '</div>');

      _timer = setInterval(function () {
        rem--;
        var f = document.getElementById('_sqzTF');
        var t = document.getElementById('_sqzTT');
        if (f) f.style.width = Math.max(0, rem / secs * 100) + '%';
        if (t) t.textContent = Math.max(0, rem) + 's';
        if (rem <= 0) {
          clearInterval(_timer);
          if (self._degraded && _state === 'vote') onResult({ votes: { A:0,B:0,C:0,D:0 } });
        }
      }, 1000);
    }

    function onResult(d) {
      if (_state !== 'vote' && _state !== 'voted' && _state !== 'waiting') return;
      clearInterval(_timer);
      var q     = _q[_qi];
      var votes = d.votes || { A:0,B:0,C:0,D:0 };
      var tot   = Object.values(votes).reduce(function (a, b) { return a + b; }, 0);
      var best  = tot > 0 ? Object.entries(votes).sort(function (a, b) { return b[1]-a[1]; })[0][0] : null;
      _ans.push({ correct: best === q.correct });

      var rows = Object.keys(q._cho).map(function (k) {
        var v   = votes[k] || 0;
        var pct = tot > 0 ? Math.round(v / tot * 100) : 0;
        var ok  = k === q.correct;
        return '<div class="_sqzRR' + (ok ? ' ok' : '') + '">'
          + '<span style="font-size:12px;font-weight:800;color:#94a3b8">' + k + '</span>'
          + '<span style="font-size:12px">' + q._cho[k] + '</span>'
          + '<div style="background:#e2e8f0;height:10px;border-radius:4px;overflow:hidden">'
          + '<div style="height:100%;width:' + pct + '%;background:' + (ok ? '#22c55e' : '#3b82f6')
          + ';border-radius:4px"></div></div>'
          + '<span style="font-size:11px;font-weight:700;text-align:right">' + pct + '%</span></div>';
      }).join('');

      _state = 'result';
      setHtml('<div style="padding:8px 14px;font-size:11px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.06em">'
        + 'Résultats — Q' + (_qi + 1) + ' / ' + _q.length + '</div>'
        + '<div style="padding:2px 14px 10px">' + rows + '</div>'
        + '<div style="padding:0 14px 12px;font-size:13px;font-weight:700;text-align:center;'
        + 'color:' + (best === q.correct ? '#15803d' : '#c2410c') + '">'
        + (best === q.correct ? '✓' : '✗') + ' Bonne réponse : ' + q.correct + ' — ' + q._cho[q.correct] + '</div>');

      _adv = setTimeout(function () { if (_state === 'result') advance(); }, 3000);
    }

    function advance() {
      _state = 'advancing';
      var next = _qi + 1;
      if (next < _q.length) enterQ(next); else finish();
    }

    function finish() {
      _state = 'done';
      clearInterval(_timer);
      var total   = _q.length;
      var correct = _ans.filter(function (a) { return a.correct; }).length;
      var score   = Math.round(correct / total * 100);
      self.sessionComplete({ score: score, correct: correct, total: total });
      if (!self._degraded) self.continueAllAuto(score, correct, total);
      setHtml('<div style="text-align:center;padding:32px 16px">'
        + '<div style="font-size:52px;font-weight:900;color:#1e293b">' + score + '%</div>'
        + '<p style="color:#64748b;font-size:14px;margin:8px 0 0">'
        + correct + ' / ' + total + ' bonnes réponses</p></div>');
      if (typeof onComplete === 'function') onComplete({ score: score, correct: correct, total: total });
    }

    window._sqzV = function (value) {
      if (_state !== 'vote') return;
      _state = 'voted';
      ['A','B','C','D'].forEach(function (k) {
        var b = document.getElementById('_sqzB' + k); if (b) b.disabled = true;
      });
      self.vote(value);
    };

    // ── Main flow ─────────────────────────────────────────────────────────
    setHtml(spin('Connexion en cours…'));

    self._post('/api/auth/learner-token', null, {
      learnerId: self._learnerId || 'anonymous',
      name:      self._learnerName || 'Apprenant',
    }).then(function (auth) {
      return self._post('/api/rooms/join', auth.token, { code: roomCode });
    }).then(function (join) {
      if (!join.token) throw new Error('Salle introuvable');
      self._token    = join.token;
      self._roomId   = join.roomId;
      self._roomCode = roomCode;
      setHtml(spin('Chargement des questions…'));
      return fetch(self._url + '/api/rooms/' + join.roomId + '/quiz/' + quizId + '/questions', {
        headers: { 'ngrok-skip-browser-warning': 'true' },
      }).then(function (r) { return r.json(); });
    }).then(function (data) {
      if (!Array.isArray(data) || data.length === 0) {
        setHtml('<div style="color:#ef4444;padding:20px;text-align:center;font-size:14px">'
          + 'Aucune question configurée.<br>Contactez votre formateur.</div>');
        return;
      }
      _q = data;
      self._connectSocket();
      setHtml(spin('Génération du QR…'));
      return self.registerToken(roomCode).then(function (token) {
        var url = self._url + '/vote?room=' + encodeURIComponent(roomCode)
                + '&token=' + encodeURIComponent(token);
        self._voteUrl = url;
        showQR(url);
      });
    }).catch(function (err) {
      setHtml('<div style="color:#ef4444;padding:20px;text-align:center;font-size:14px">'
        + 'Erreur : ' + err.message + '</div>');
    });
  };

  // ── Internals ────────────────────────────────────────────────────────────

  ScormSync.prototype._post = function (path, token, body) {
    var headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(this._url + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + path);
      return r.json();
    });
  };

  ScormSync.prototype._connectSocket = function () {
    var self = this;
    var s = io(self._url, {
      auth: { token: self._token },
      extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
    });
    self._socket = s;

    s.on('connect', function () {
      self._fire('connected');
      s.emit('watch_room');
    });
    s.on('disconnect',    function ()  { self._fire('disconnected'); });
    s.on('connect_error', function (e) {
      if (!self._degraded) self._enterDegraded('socket: ' + e.message);
    });

    ['waiting_update',  'vote_open',      'vote_progress', 'vote_result',
     'debate_open',     'vote_ack',       'global_pause',  'global_resume',
     'continue_all',    'skip_sync',      'timer_extended','learner_connected',
     'question_data',   'session_complete','error']
    .forEach(function (ev) {
      s.on(ev, function (d) { self._fire(ev, d); });
    });
  };

  ScormSync.prototype._enterDegraded = function (reason) {
    this._degraded = true;
    this._fire('degraded', { reason: reason });
  };

  ScormSync.prototype._clearSoloTimers = function () {
    this._soloTimers.forEach(clearTimeout);
    this._soloTimers = [];
  };

  // ── Mode dégradé : simulation des événements ─────────────────────────────

  ScormSync.prototype._soloArrived = function (syncPoint) {
    var self = this;
    self._fire('waiting_update', { syncPoint: syncPoint, waiting: 1, total: 1 });
    var t1 = setTimeout(function () {
      self._soloActive = true;
      self._fire('vote_open', {
        syncPoint: syncPoint, timerSeconds: SOLO_VOTE_SECONDS, isSecondVote: false,
      });
      var t2 = setTimeout(function () {
        if (!self._soloActive) return;
        self._soloActive = false;
        self._soloResult(syncPoint, null);
      }, SOLO_VOTE_SECONDS * 1000);
      self._soloTimers.push(t2);
    }, SOLO_OPEN_DELAY);
    self._soloTimers.push(t1);
  };

  ScormSync.prototype._soloResult = function (syncPoint, chosenValue) {
    var self = this;
    var votes = { A: 0, B: 0, C: 0, D: 0 };
    if (chosenValue) votes[chosenValue] = 1;
    var t1 = setTimeout(function () {
      self._fire('vote_result', { votes: votes, vote1Results: null, syncPoint: syncPoint });
      var t2 = setTimeout(function () { self._fire('continue_all'); }, SOLO_CONTINUE_DELAY);
      self._soloTimers.push(t2);
    }, SOLO_RESULT_DELAY);
    self._soloTimers.push(t1);
  };

  // ── Singleton facade ─────────────────────────────────────────────────────
  var _instance = null;

  root.ScormSync = {
    _loaded: true,
    init: function (backendUrl, learnerId, learnerName) {
      var _id   = learnerId   || null;
      var _name = learnerName || null;
      if (!_id) {
        try {
          var API12 = getAPI();
          if (API12) {
            _id   = API12.LMSGetValue('cmi.core.student_id')   || null;
            _name = API12.LMSGetValue('cmi.core.student_name') || null;
          }
          if (!_id) {
            var API2004 = window.API_1484_11;
            if (API2004) {
              _id   = API2004.GetValue('cmi.learner_id')   || null;
              _name = API2004.GetValue('cmi.learner_name') || null;
            }
          }
        } catch (e) {}
      }
      _instance = new ScormSync({ backendUrl: backendUrl, learnerId: _id, learnerName: _name });
      return root.ScormSync;
    },
    on: function (ev, fn) {
      if (_instance) _instance.on(ev, fn);
      return root.ScormSync;
    },
    join:            function (opts)          { return _instance ? _instance.join(opts) : Promise.resolve({ degraded: true }); },
    arrived:         function (sp)            { _instance && _instance.arrived(sp); },
    vote:            function (v)             { _instance && _instance.vote(v); },
    sessionComplete: function (d)             { _instance && _instance.sessionComplete(d); },
    isDegraded:      function ()              { return !_instance || _instance.isDegraded(); },
    destroy:         function ()              { _instance && _instance.destroy(); },
    getRoomId:       function ()              { return _instance ? _instance.getRoomId() : null; },
    generateQRCode:  function (cid, rc)       { return _instance ? _instance.generateQRCode(cid, rc)       : Promise.resolve(null); },
    registerToken:   function (rc)            { return _instance ? _instance.registerToken(rc)             : Promise.resolve(null); },
    renderQR:        function (cid, url, sz)  { _instance && _instance._renderFromUrl(cid, url, sz); },
    getIdentity:     function ()              { return _instance ? _instance.getIdentity() : { studentId: null, studentName: null }; },
    sendQuestionData: function (sp, q, c, co, mc) { return _instance ? _instance.sendQuestionData(sp, q, c, co, mc) : Promise.resolve(); },
    continueAllAuto:  function (sc, co, to)   { _instance && _instance.continueAllAuto(sc, co, to); },
    startQuiz:        function (rc, qi, cb)   { _instance && _instance.startQuiz(rc, qi, cb); },
  };

}(window));
