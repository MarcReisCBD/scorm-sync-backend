/**
 * scorm-sync.js — Bibliothèque client de synchronisation pairagogique
 *
 * ┌─ Configuration ────────────────────────────────────────────────────┐
 * │  Modifier DEFAULT_BACKEND avant de packager pour la production.    │
 * │  Ou définir window.SCORM_SYNC_BACKEND avant de charger ce fichier. │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * Usage :
 *   const sync = new ScormSync({ backendUrl: 'http://...' });
 *   sync.on('vote_open', function(d) { ... });
 *   sync.join({ code: 'TIGRE-42', learnerId: '...', learnerName: '...' })
 *     .then(function(r) { if (r.degraded) ... });
 *   sync.arrived('q1');
 *   sync.vote('B');
 */
(function (root) {
  'use strict';

  // ── Configuration par défaut ─────────────────────────────────────────
  var DEFAULT_BACKEND = root.SCORM_SYNC_BACKEND || 'http://localhost:3000';

  // ── Délais mode dégradé (ms) ─────────────────────────────────────────
  var SOLO_OPEN_DELAY     = 1500;  // délai avant ouverture auto du vote
  var SOLO_VOTE_SECONDS   = 20;    // durée du timer en solo
  var SOLO_RESULT_DELAY   = 500;   // délai avant affichage résultat
  var SOLO_CONTINUE_DELAY = 2500;  // délai avant enable du bouton Continuer

  // ════════════════════════════════════════════════════════════════════
  function ScormSync(config) {
    config = config || {};
    this._url         = config.backendUrl || DEFAULT_BACKEND;
    this._handlers    = {};
    this._socket      = null;
    this._token       = null;
    this._degraded    = false;
    this._syncPoint   = null;
    this._soloActive  = false;
    this._soloTimers  = [];
  }

  // ── Event emitter ────────────────────────────────────────────────────
  ScormSync.prototype.on = function (event, fn) {
    this._handlers[event] = fn;
    return this;
  };

  ScormSync.prototype._fire = function (event, data) {
    var fn = this._handlers[event];
    if (typeof fn === 'function') fn(data);
  };

  // ── API publique ─────────────────────────────────────────────────────

  /**
   * join({ code, learnerId, learnerName })
   * Renvoie une Promise<{ degraded: boolean }>
   * Si code est vide ou si le réseau est injoignable → mode dégradé solo.
   */
  ScormSync.prototype.join = function (opts) {
    opts = opts || {};
    var self = this;

    if (!opts.code) {
      self._enterDegraded('Aucun code salle');
      return Promise.resolve({ degraded: true });
    }

    var learnerId   = opts.learnerId   || ('learner-' + Date.now());
    var learnerName = opts.learnerName || 'Apprenant';

    // Étape 1 — JWT de base
    return self._post('/api/auth/learner-token', null,
        { learnerId: learnerId, name: learnerName })
    // Étape 2 — rejoindre la salle
    .then(function (data) {
      return self._post('/api/rooms/join', data.token, { code: opts.code });
    })
    // Étape 3 — connecter (socket.io est embarqué, déjà disponible)
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

  /**
   * arrived(syncPoint) — appelé quand l'apprenant arrive sur une slide de sync.
   *
   * IMPORTANT : join() résout sa Promise AVANT que le handshake WebSocket soit
   * terminé. On utilise socket.once('connect') pour émettre dès que la
   * connexion est réellement établie, même si arrived() est appelé dans la
   * foulée de join().
   */
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
      // Connexion en cours — émet dès que le handshake est terminé
      self._socket.once('connect', function () {
        self._socket.emit('learner_arrived', { syncPoint: syncPoint });
      });
    }
  };

  /**
   * vote(value) — 'A' | 'B' | 'C' | 'D'
   */
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

  /**
   * sessionComplete({ score, correct, total })
   * Émet l'événement vers le backend pour notification de la console formateur.
   */
  ScormSync.prototype.sessionComplete = function (data) {
    if (this._degraded || !this._socket || !this._socket.connected) return;
    this._socket.emit('session_complete', data);
  };

  /** Libère les ressources (sockets, timers). Appeler sur beforeunload. */
  ScormSync.prototype.destroy = function () {
    this._clearSoloTimers();
    if (this._socket) this._socket.disconnect();
  };

  ScormSync.prototype.isDegraded = function () { return this._degraded; };

  // ── Internals ────────────────────────────────────────────────────────

  ScormSync.prototype._post = function (path, token, body) {
    var headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(this._url + path, {
      method: 'POST', headers: headers, body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + path);
      return r.json();
    });
  };

  ScormSync.prototype._connectSocket = function () {
    var self = this;
    // socket.io.min.js est embarqué dans le package SCORM — pas de chargement dynamique.
    // io(url, opts) : le premier argument force la connexion au backend,
    // indépendamment de l'origine où la page SCORM est servie.
    var s = io(self._url, {
      auth: { token: self._token },
      extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
    });
    self._socket = s;

    s.on('connect',       function ()  { self._fire('connected'); });
    s.on('disconnect',    function ()  { self._fire('disconnected'); });
    s.on('connect_error', function (e) {
      if (!self._degraded) self._enterDegraded('socket: ' + e.message);
    });

    ['waiting_update', 'vote_open', 'vote_progress', 'vote_result',
     'debate_open',    'vote_ack',  'global_pause',  'global_resume',
     'continue_all',   'skip_sync', 'timer_extended', 'error']
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

  // ── Mode dégradé : simulation des événements ─────────────────────────

  ScormSync.prototype._soloArrived = function (syncPoint) {
    var self = this;
    self._fire('waiting_update', { syncPoint: syncPoint, waiting: 1, total: 1 });

    var t1 = setTimeout(function () {
      self._soloActive = true;
      self._fire('vote_open', {
        syncPoint: syncPoint, timerSeconds: SOLO_VOTE_SECONDS, isSecondVote: false,
      });
      // Timer expiré sans vote → résultat vide + continuer auto
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
      var t2 = setTimeout(function () {
        self._fire('continue_all');
      }, SOLO_CONTINUE_DELAY);
      self._soloTimers.push(t2);
    }, SOLO_RESULT_DELAY);
    self._soloTimers.push(t1);
  };

  // ── Export ───────────────────────────────────────────────────────────
  root.ScormSync = ScormSync;

}(window));
