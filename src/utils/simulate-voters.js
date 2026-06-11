#!/usr/bin/env node
'use strict';

/**
 * Simulateur d'apprenants pour tester l'écran de diffusion.
 * Usage : node src/utils/simulate-voters.js <ROOM_CODE> <N_VOTERS> [BASE_URL]
 * Ex :    node src/utils/simulate-voters.js TIGRE-42 10
 *         node src/utils/simulate-voters.js TIGRE-42 10 http://localhost:3000
 */

require('dotenv').config();

const fetch  = require('node:http');  // utilise l'API http native — pas de dépendance
const io     = require('socket.io-client');

const ROOM_CODE = process.argv[2];
const N_VOTERS  = parseInt(process.argv[3] || '5', 10);
const BASE_URL  = (process.argv[4] || 'http://localhost:3000').replace(/\/$/, '');

if (!ROOM_CODE) {
  console.error('Usage: node src/utils/simulate-voters.js ROOM_CODE N_VOTERS [BASE_URL]');
  process.exit(1);
}

const VOTE_MIN_MS = 2000;
const VOTE_MAX_MS = 15000;

// ── Utilitaire HTTP minimal (évite une dépendance node-fetch) ─────────────

function httpRequest(method, path, body, token) {
  return new Promise(function (resolve, reject) {
    const url  = new URL(BASE_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const http = url.protocol === 'https:' ? require('node:https') : require('node:http');
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token            ? { 'Authorization': 'Bearer ' + token } : {}),
        ...(data             ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end',  function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Bootstrapper ──────────────────────────────────────────────────────────

async function bootstrap() {
  console.log('[sim] Connexion à ' + BASE_URL + ' — salle ' + ROOM_CODE + ' — ' + N_VOTERS + ' apprenants');

  // Crée N learners en parallèle
  const learners = [];
  for (let i = 1; i <= N_VOTERS; i++) {
    learners.push({ id: 'sim-user-' + i, name: 'Apprenant ' + i });
  }

  // Authentification + join en parallèle
  const sessions = await Promise.all(learners.map(function (l) {
    return authenticate(l.id, l.name);
  }));

  // Connexion socket en parallèle
  sessions.forEach(function (s) {
    if (s) connectLearner(s);
  });
}

async function authenticate(learnerId, learnerName) {
  // 1. Obtenir un JWT learner
  const tokRes = await httpRequest('POST', '/api/auth/learner-token', {
    learnerId,
    name: learnerName,
  });
  if (tokRes.status !== 200 || !tokRes.body.token) {
    console.error('[sim] Impossible d\'obtenir le token pour', learnerName, tokRes.body);
    return null;
  }
  const learnerToken = tokRes.body.token;

  // 2. Rejoindre la salle → JWT enrichi avec roomId
  const joinRes = await httpRequest('POST', '/api/rooms/join', { code: ROOM_CODE }, learnerToken);
  if (joinRes.status !== 200 || !joinRes.body.token) {
    console.error('[sim] Impossible de rejoindre la salle pour', learnerName, joinRes.body);
    return null;
  }

  return { learnerId, learnerName, token: joinRes.body.token, roomId: joinRes.body.roomId };
}

// ── Connexion et comportement d'un apprenant simulé ───────────────────────

function connectLearner(session) {
  const { learnerId, learnerName, token } = session;
  let voteOpenAt = null;

  const socket = io(BASE_URL, {
    auth:         { token },
    reconnection: true,
    transports:   ['websocket'],
  });

  socket.on('connect', function () {
    // Rejoindre la salle comme apprenant actif (sans syncPoint — pas de déclenchement de quorum)
    socket.emit('learner_arrived', {});
    log(learnerName, 'connecté et dans la salle');
  });

  socket.on('connect_error', function (err) {
    console.error('[sim] ' + learnerName + ' erreur connexion :', err.message);
  });

  // Réception d'un vote ouvert
  socket.on('vote_open', function (d) {
    voteOpenAt = Date.now();

    // Choisir une lettre aléatoire parmi les choix disponibles
    const choices = d.questionData && d.questionData.choices
      ? Object.keys(d.questionData.choices)
      : ['A', 'B', 'C', 'D'];

    const letter = choices[Math.floor(Math.random() * choices.length)];
    const delay  = VOTE_MIN_MS + Math.random() * (VOTE_MAX_MS - VOTE_MIN_MS);

    setTimeout(function () {
      const elapsed = ((Date.now() - voteOpenAt) / 1000).toFixed(1);
      socket.emit('submit_vote', { value: letter });
      log(learnerName, 'a voté ' + letter + ' (' + elapsed + 's)');
    }, delay);
  });

  // Réception d'un ACK vote
  socket.on('vote_ack', function (d) {
    if (!d.ok) log(learnerName, 'vote refusé : ' + d.error);
  });

  // Fin de question → se replacer en salle d'attente pour la suivante
  socket.on('continue_all', function () {
    socket.emit('learner_arrived', {});
    log(learnerName, 'prêt pour la prochaine question');
  });

  socket.on('disconnect', function () {
    log(learnerName, 'déconnecté');
  });
}

function log(name, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log('[sim ' + ts + '] ' + name + ' ' + msg);
}

// ── Lancement ─────────────────────────────────────────────────────────────

bootstrap().catch(function (err) {
  console.error('[sim] Erreur fatale :', err.message);
  process.exit(1);
});
