# CLAUDE.md — scorm-sync-backend
> Ce fichier est lu automatiquement par Claude Code à chaque session.
> Il doit être maintenu à jour après chaque modification significative du projet.

---

## Contexte du projet

Backend de synchronisation temps réel pour sessions SCORM collaboratives.
Permet à plusieurs apprenants de suivre simultanément un module SCORM (Storyline)
avec des votes collectifs synchronisés, dans une approche pairagogique (Peer Instruction — Mazur).

**Principe clé** : le backend ne connaît jamais le contenu des questions.
Il gère uniquement des identifiants de sync points (`q1`, `q2`...), des compteurs
de votes anonymisés, et l'état des salles. Les questions restent dans Storyline.

---

## Stack technique

| Composant | Technologie |
|---|---|
| Runtime | Node.js 20 LTS |
| Serveur HTTP | Express 5 (installé via npm — pas de régression fonctionnelle vs v4) |
| WebSocket | Socket.io 4 |
| Cache / État | Redis (ioredis) |
| Auth | JWT (jsonwebtoken) |
| UUID | crypto.randomUUID() natif Node.js (pas de dépendance uuid) |
| Logger | Winston |
| Env | dotenv |
| Base questions | SQLite (better-sqlite3) — WAL, FK ON — `data/questions.db` |
| Import Excel | xlsx + multer memoryStorage |

---

## Infrastructure cible

- **POC local** : Ubuntu local, Redis local sur 127.0.0.1, HTTP
- **Production** : Azure App Service (P1v3) + Azure Cache for Redis + Azure Key Vault
- **Console formateur** : Azure Static Web Apps (React SPA — à développer)

---

## Arborescence actuelle

```
scorm-sync-backend/
├── src/
│   ├── server.js                  # Point d'entrée Express + Socket.io + health check
│   ├── sdk/
│   │   ├── scorm-sync-sdk.js      # SDK logique (bundlé avec socket.io par server.js)
│   │   └── qrcode.min.js          # Lib QR Code (servie à la demande)
│   ├── socket/
│   │   ├── index.js               # Init Socket.io, CORS, wsAuth, rate limit 50 cx/min/IP
│   │   └── handlers/
│   │       ├── learner.js         # learner_arrived, submit_vote, disconnect, quorum
│   │       └── trainer.js         # force_vote, close_vote, open_second_vote,
│   │                              # global_pause/resume, skip_sync, continue_all, extend_timer
│   ├── api/
│   │   └── routes/
│   │       ├── rooms.js           # POST /rooms, POST /rooms/join (+ learnerNames), DELETE /:id, GET /:id/state
│   │       ├── auth.js            # POST /trainer-token, POST /learner-token (POC only)
│   │       └── questions.js       # GET /modules, GET /questions, POST /questions/import, /random, quiz assign
│   ├── db/
│   │   ├── database.js            # SQLite init (WAL, FK), tables modules/questions/quiz_questions
│   │   └── questionRepository.js  # insertModule, getAllModules, insertQuestion, getQuestions,
│   │                              # getRandomQuestions, assignQuestionsToQuiz, getQuizQuestions
│   ├── services/
│   │   ├── redisService.js        # setJSON / getJSON / del, connexion TLS conditionnelle
│   │   ├── roomService.js         # CRUD salles, TTL Redis, code ANIMAL-XX
│   │   ├── voteService.js         # openVote+timer, submitVote (anonyme), closeVote,
│   │   │                          # saveVote1Results, extendTimer
│   │   └── questionImporter.js    # importFromRiseUp : parseFormationsExcel, parseRiseUpQuestionsExcel
│   │                              # splitFrEn (heuristique bilingue), parseVraiFaux, parseChoixMultiple
│   ├── middleware/
│   │   ├── auth.js                # httpAuthMiddleware + wsAuthMiddleware JWT
│   │   └── rateLimit.js           # 100 req/min/IP
│   └── utils/
│       ├── logger.js              # Winston — coloré dev, JSON prod
│       └── constants.js           # ROOM_STATUS, VOTE_VALUES, ROLES
├── public/
│   └── vote.html                  # Page de vote smartphone (GET /vote?room=CODE&q=syncPoint)
├── test.html                      # Page de test multi-panneaux (formateur + 2 apprenants)
├── admin.html                     # Console formateur (GET /admin)
├── package.sh                     # Génère scorm-test.zip (bash package.sh)
├── scorm-test.zip                 # Package SCORM prêt pour SCORM Cloud (2 fichiers : index.html + imsmanifest.xml)
├── scorm-test/
│   ├── imsmanifest.xml            # Manifest SCORM 1.2
│   ├── index.html                 # Module SCORM : 3 questions pairagogiques
│   ├── scorm-sync.js              # Ancien client (conservé pour référence, exclu du ZIP)
│   └── socket.io.min.js           # Client Socket.io v4.7.2 (conservé, exclu du ZIP)
├── .env                           # Variables locales (ne pas committer)
├── package.json
└── CLAUDE.md                      # Ce fichier
```

---

## Architecture SDK (Sprint 1)

### Flux de chargement

```
SCORM Cloud (index.html)
  │
  ├── Inline stub (toujours disponible, mode solo)
  │
  └── <script src="BACKEND/sdk/scorm-sync-sdk.js?ngrok-skip-browser-warning=true">
        │
        └── Server.js bundle dynamiquement :
              socket.io.min.js + scorm-sync-sdk.js
              → window.ScormSync.init(BACKEND_URL)
              → lit student_id/student_name depuis API SCORM 1.2 automatiquement
```

### Route SDK (server.js)

```javascript
GET /sdk/scorm-sync-sdk.js  → fs.readSync(socket.io.min.js) + fs.readSync(scorm-sync-sdk.js)
                              Content-Type: application/javascript
                              Access-Control-Allow-Origin: *
                              Cache-Control: public, max-age=300

GET /sdk/qrcode.min.js      → src/sdk/qrcode.min.js
                              (chargé dynamiquement par generateQRCode())
```

### API publique `window.ScormSync`

```javascript
ScormSync.init(backendUrl)                        // lit SCORM API → learnerId/Name auto
ScormSync.on(event, fn)
ScormSync.join({ code })                          // learnerId/Name auto-détectés
ScormSync.arrived(syncPoint)
ScormSync.vote(value)
ScormSync.sessionComplete({ score, correct, total })
ScormSync.generateQRCode(divId, roomCode)         // async → Promise<url>, token dans l'URL
ScormSync.registerToken(roomCode)                 // async → Promise<token> (8 chars)
ScormSync.renderQR(divId, url, size?)             // re-render QR depuis URL déjà générée
ScormSync.getIdentity()                           // → { studentId, studentName }
ScormSync.isDegraded()
ScormSync.destroy()
```

**Note** : `generateQRCode` a changé de signature entre Sprint 1 et Sprint 2 :
- Sprint 1 : `(containerId, syncPoint)` — URL sans token
- Sprint 2 : `(divId, roomCode)` — retourne `Promise<url>`, URL avec token

Sur connect, le SDK émet automatiquement `watch_room` pour que le SCORM rejoigne
la room Socket.io en observateur (sans être dans `waitingLearners`).

### Fallback dégradé inline

Si le SDK échoue à charger (backend injoignable), le stub inline de `index.html` prend le relais.
Il simule `vote_open` → vote → `vote_result` → `continue_all` avec des `setTimeout`.

---

## Architecture QR Code — Sprint 2 (identité LMS liée)

### Flux complet avec token

```
PC (SCORM) ──────────────────────────────── Smartphone
    │                                             │
    ├─ join({ code }) → JWT enrichi               │
    ├─ Socket.io connect → watch_room             │
    ├─ showSlide('slide-qr')                      │
    ├─ generateQRCode('qr-slide-container', code) │
    │   └─ registerToken(code)                    │
    │       └─ POST /api/auth/register-token      │
    │          { token, studentId, studentName,   │
    │            roomCode }  TTL = ROOM_TTL        │
    ├─ Affiche QR : /vote?room=CODE&token=TOKEN   │
    │                                             │
    │                               ├─ Scanne QR │
    │                               ├─ GET /api/auth/resolve-token?token=TOKEN
    │                               │   → { studentId, studentName, roomCode }
    │                               ├─ "Bonjour Marc Reis"
    │                               ├─ POST /api/auth/learner-token (avec studentId/Name)
    │                               ├─ POST /api/rooms/join
    │                               ├─ Socket.io connect
    │                               └─ learner_arrived {}
    │                                             │
    ├─ learner_connected ◄────────────────────────┤
    │   { learnerId: studentId, learnerName }      │
    ├─ "✓ Smartphone connecté — Marc Reis"         │
    ├─ setTimeout 1.5s → startSession() auto      │
    │                                             │
    ├─ _enterQuestion(0)                          │
    │   ├─ arrived(q.id)                          │
    │   └─ sendQuestionData(q.id, q.text,         │
    │       q.choices, q.correct)                 │
    │       └─ backend stocke currentQuestionData  │
    │          + broadcast question_data          │
    │                                             │
    ├─ vote_open { questionData } ────────────────┤
    ├─ renderQR('qr-vote-container', voteUrl)     ├─ boutons avec texte choix
    │                                             ├─ submit_vote
    ├─ vote_progress (X/N répondu)                ├─ vote_ack
    ├─ vote_result { correctAnswer } ─────────────┤ (bonne réponse en vert)
    ├─ continue_all ──────────────────────────────┤
```

### 3 états du module SCORM (`scorm-test/index.html`)

| État | Slide | Contenu |
|---|---|---|
| 1 — Code | `#slide-welcome` | Input code salle + bouton rejoindre |
| 2 — QR | `#slide-qr` | QR tokenisé + "Bonjour [name]" + spinner → "✓ Connecté" → auto-avance 1.5s |
| 3 — Questions | `#slide-question` | Questions + QR mini en coin + timer + résultats |

### Redis — clé token

```javascript
// Clé Redis : token:<8chars>
// TTL : ROOM_TTL_SECONDS (défaut 14400s)
{
  studentId:   "marc@lms.com",
  studentName: "Marc Reis",
  roomCode:    "TIGRE-42"
}
```

### Page vote.html (`public/vote.html`) — Sprint 2+

- Accessible via `GET /vote?room=CODE&token=TOKEN` (token → identité LMS)
- Fallback sans token : `localStorage` (`phone-XXXX`) — rétrocompat admin QR
- Résolution token : `GET /api/auth/resolve-token?token=TOKEN` → "Bonjour Marc Reis"
- Boutons A/B/C/D en **colonne unique pleine largeur** — lettre petite en haut à gauche, texte du choix large au centre
- Texte de la question affiché au-dessus des boutons (reçu via `vote_open.questionData`)
- Bonne réponse en vert dans les résultats (`vote_result.correctAnswer`)
- Barre timer fine en haut de l'écran pendant le vote
- Auto-reconnect Socket.io : schedule reconnect 3s après disconnect
- États : `loading` → `waiting` → `vote` → `voted` → `result` → `paused` → `error` → `disconnected`

### Admin `admin.html` — Sprint 2

- QR salle affiché à la création (URL générique sans token, pour vidéoprojecteur)
- Participant grid : dots nommés avec initiales (plus de numéros anonymes)
- Dot bleu cyan `.smartphone` quand `learner_connected` reçu pour ce learnerId
- QRCode.js chargé à la demande depuis `/sdk/qrcode.min.js`

---

## Modèle de données — Salle Redis

```javascript
// Clé Redis : room:<uuid>
{
  id:               "uuid-v4",
  code:             "TIGRE-42",        // index aussi dans room:code:<CODE>
  trainerId:        "trainer-jwt-sub",
  moduleId:         "module-identifier",
  totalLearners:    8,
  status:           "waiting",         // voir ROOM_STATUS ci-dessous
  currentSyncPoint: null,              // ex: "q1", "q2"
  waitingLearners:  [],                // learnerIds au sas
  learnerNames:     {},                // { learnerId: "Prénom Nom" } — peuplé au join
  votes:               { A:0, B:0, C:0, D:0 },
  vote1Results:        null,              // résultat 1er vote (double vote pairagogique)
  currentQuestionData: null,             // { syncPoint, question, choices, correct } — envoyé par SCORM
  createdAt:           "ISO string",
  updatedAt:           "ISO string"
}
```

**ROOM_STATUS** : `waiting` → `content` → `sync` → `vote` → `debate` → `result` → `paused` → `closed`

---

## Événements WebSocket — Référence

### Client → Serveur

| Événement | Rôle | Payload |
|---|---|---|
| `watch_room` | Apprenant (SCORM) | `{}` — rejoint la room comme observateur sans `waitingLearners` |
| `learner_arrived` | Apprenant (smartphone) | `{}` — roomId lu depuis le JWT |
| `submit_vote` | Apprenant | `{ value: 'A'\|'B'\|'C'\|'D' }` |
| `force_vote` | Formateur | `{ syncPoint: 'q1' }` |
| `close_vote` | Formateur | `{ doubleVote: true\|false }` — true → debate_open, false → vote_result |
| `open_second_vote` | Formateur | `{}` |
| `global_pause` | Formateur | `{}` |
| `global_resume` | Formateur | `{}` |
| `skip_sync` | Formateur | `{}` |
| `continue_all` | Formateur | `{}` |
| `extend_timer` | Formateur | `{ extraSeconds: 30 }` |

### Serveur → Client (broadcast salle)

| Événement | Payload |
|---|---|
| `waiting_update` | `{ syncPoint, waiting, total, learners: [{id, name}] }` |
| `vote_open` | `{ syncPoint, timerSeconds, isSecondVote }` |
| `vote_progress` | `{ total, max, learnerId, value, responseTimeMs }` — enrichi depuis Sprint 2B |
| `vote_ack` | `{ ok: true }` ou `{ ok: false, error: '...' }` — émis uniquement à l'émetteur |
| `debate_open` | `{ vote1Results: {A,B,C,D} }` — broadcast après close_vote({ doubleVote: true }) |
| `vote_result` | `{ votes, vote1Results, syncPoint }` |
| `learner_connected` | `{ learnerId, learnerName }` — broadcast quand smartphone émet `learner_arrived` |
| `global_pause` | `{}` |
| `global_resume` | `{}` |
| `skip_sync` | `{}` |
| `continue_all` | `{}` |
| `timer_extended` | `{ extraSeconds }` |
| `session_complete` | `{ learnerId, score, correct, total }` |

---

## Routes REST

| Méthode | Route | Rôle | Auth |
|---|---|---|---|
| GET | `/` | Sert `test.html` (page de test multi-panneaux) | Non |
| GET | `/admin` | Console formateur (`admin.html`) | Non |
| GET | `/health` | Health check Azure | Non |
| GET | `/vote` | Page de vote smartphone (`public/vote.html`) | Non |
| GET | `/sdk/scorm-sync-sdk.js` | Bundle SDK (socket.io + logique sync) | Non |
| GET | `/sdk/qrcode.min.js` | Lib QR Code | Non |
| POST | `/api/auth/trainer-token` | Génère JWT trainer (POC) | Non |
| POST | `/api/auth/learner-token` | Génère JWT learner (POC) | Non |
| POST | `/api/auth/register-token` | Stocke token → identité LMS (TTL = ROOM_TTL) | Non |
| GET | `/api/auth/resolve-token?token=XXX` | Résout token → `{studentId, studentName, roomCode}` | Non |
| POST | `/api/rooms` | Créer une salle | JWT trainer |
| POST | `/api/rooms/join` | Rejoindre via code + stocke learnerName | JWT learner |
| GET | `/api/rooms/:id/state` | État complet salle | JWT trainer |
| DELETE | `/api/rooms/:id` | Fermer une salle | JWT trainer |
| GET | `/api/modules` | Liste des modules avec compteur de questions | Non |
| GET | `/api/questions` | Questions paginées (filtres: moduleRef, search, type, lang) | Non |
| POST | `/api/questions/import` | Import Rise Up Excel (questions + formations) | JWT trainer |
| POST | `/api/questions/random` | Sélection aléatoire `{moduleRefs, count, language}` | Non |
| POST | `/api/rooms/:id/quiz/:quizId/questions` | Assigner questions à un quiz | JWT trainer |
| GET | `/api/rooms/:id/quiz/:quizId/questions` | Questions d'un quiz (langue résolue) | Non |

---

## Statut POC — Sprint 1 ✓ Validé à 100%

### POC de base (validé sur SCORM Cloud)
- [x] Arborescence complète créée
- [x] Serveur démarre sans erreur (`node src/server.js`)
- [x] Redis connecté sur 127.0.0.1
- [x] GET /health répond `{"status":"ok"}`
- [x] Réconciliation spec/implémentation (noms d'événements, payloads, vote_ack, debate_open)
- [x] Tests des routes REST (curl / Postman)
- [x] Page HTML de test simulant apprenant + formateur (`test.html`)
- [x] Package SCORM 1.2 de test (`scorm-test/` + `bash package.sh` → `scorm-test.zip`)
- [x] Intégration JavaScript Storyline (validé sur SCORM Cloud)

### Sprint 1
- [x] SDK auto-servi — `GET /sdk/scorm-sync-sdk.js` bundle socket.io + logique
- [x] `window.ScormSync.init(url)` lit student_id/name depuis SCORM API automatiquement
- [x] Stub solo inline dans index.html (fallback si backend injoignable)
- [x] `learnerName` stocké dans Redis à chaque join (`room.learnerNames` map)
- [x] `waiting_update` enrichi avec `learners: [{id, name}]`
- [x] Late joiner : `vote_open` envoyé directement si vote déjà ouvert
- [x] QR Code — `generateQRCode(divId, roomCode)` async + token → `Promise<url>`
- [x] Page vote smartphone — `GET /vote?room=CODE&token=TOKEN`
- [x] SCORM package réduit à 2 fichiers (index.html + imsmanifest.xml) — 12K

### Sprint 2
- [x] Token LMS — `POST /api/auth/register-token` + `GET /api/auth/resolve-token`
- [x] `watch_room` socket event — SCORM observe sans être dans `waitingLearners`
- [x] `learner_connected` broadcast — smartphone signale sa connexion avec identité LMS
- [x] `ScormSync.registerToken(roomCode)` → génère token 8 chars, stocke en Redis
- [x] `ScormSync.getIdentity()` → `{ studentId, studentName }`
- [x] `ScormSync.renderQR(divId, url, size?)` — re-render QR depuis URL existante
- [x] SCORM 3 états : welcome → slide-qr (QR + attente smartphone) → questions
- [x] Mini QR (72px) en coin de chaque slide question
- [x] vote.html redesigné : token resolution, boutons colonne, barre timer, auto-reconnect
- [x] admin.html : QR salle générique + dots nommés avec initiales + dot cyan smartphone
- [x] SDK bundle embarqué dans le ZIP (package.sh) — élimine le chargement ngrok au démarrage
- [x] `join()` sauvegarde le learnerId résolu dans `_learnerId` (fix cohérence registerToken/getIdentity)
- [x] `learner_connected` → avance auto vers Question 1 après 1.5s (pas de bouton "Commencer")
- [x] `ScormSync.sendQuestionData(sp, q, c, correct)` → émet `question_data` socket
- [x] Backend stocke `currentQuestionData` en Redis, broadcast à la salle
- [x] `vote_open` inclut `questionData` → smartphone affiche texte question + choix
- [x] `vote_result` inclut `correctAnswer` → bonne réponse en vert dans les résultats
- [x] vote.html : boutons redesignés (lettre petite haut-gauche, texte choix large centré)
- [x] `package.sh` accepte un argument URL : `bash package.sh https://xxxx.ngrok-free.app`
- [x] Fix race condition quorum : guard `syncPoint &&` dans `learner_arrived` — quorum ne se déclenche que depuis `arrived()` du SCORM (pas depuis le smartphone sans syncPoint)
- [x] Fix race condition Q2/Q3 : état `'loading'` dans SCORM — `pendingVoteOpen` consommé après ACK `sendQuestionData` seulement
- [x] Fix `syncPoint: null` dans `force_vote` : `openVote` utilise `currentSyncPoint` existant comme fallback si syncPoint null
- [x] `vote.html` : panneau debug visible `🐛 debug` (smartphone sans F12)
- [x] Fix quorum Q2/Q3 : `continue_all` reset `{ status: WAITING, waitingLearners: [], votes, vote1Results, currentSyncPoint: null }`
- [x] Écran de fin smartphone : `session_complete` → `#state-end` avec score %, nb bonnes réponses, statut pass/fail
- [x] `continue_all` payload enrichi `{ isLastQuestion: syncPoint === 'q3' }` → smartphone affiche "en attente du score final…"
- [x] Fin automatique après Q3 : `vote_result` → 4s → `_showEndSlide()` + `sendScoreToLMS()` + `sessionComplete` + `continueAllAuto`
- [x] `ScormSync.continueAllAuto(score, correct, total)` → `continue_all_auto` socket → reset salle côté serveur
- [x] `sendScoreToLMS()` → LMSSetValue score + LMSCommit **sans** LMSFinish (module reste ouvert)
- [x] `closeSCORM()` → LMSFinish — appelé uniquement au clic "Terminer la session →"
- [x] Bouton "Terminer la session →" sur slide-end → `closeSCORM()` (apprenant ferme quand il est prêt)

---

## Variables d'environnement (.env)

```
PORT=3000
NODE_ENV=development
JWT_SECRET=mon-secret-local-pour-le-poc-changer-en-prod
JWT_EXPIRES_IN=6h
REDIS_URL=127.0.0.1
REDIS_PASSWORD=
REDIS_TLS=false
ALLOWED_ORIGINS=http://localhost,http://127.0.0.1,*,https://cloud.scorm.com
ROOM_TTL_SECONDS=14400
VOTE_TIMER_SECONDS=45
GRACE_TIMER_SECONDS=60
QUORUM_PERCENT=90
```

---

## Règles de développement

1. **`currentQuestionData`** — exception à la règle "pas de contenu" : les données de question sont stockées temporairement en Redis (TTL = ROOM_TTL) pour pouvoir les inclure dans `vote_open` et `vote_result`. C'est volontaire pour le POC — le contenu vient du SCORM, pas du backend.
2. **Votes anonymisés** — les compteurs globaux restent anonymes ; les réponses individuelles sont stockées dans `room.learnerAnswers` (visible formateur uniquement, TTL = ROOM_TTL, jamais transmis au LMS)
3. **Mode dégradé** — si le backend est injoignable, le SCORM continue en solo (stub inline)
4. **crypto.randomUUID()** — ne pas utiliser le package `uuid` (ESM-only), utiliser le natif Node.js
5. **Variables d'env** — toutes les configs passent par process.env, jamais en dur
6. **TTL Redis** — toutes les clés ont un TTL (ROOM_TTL_SECONDS), pas de données orphelines
7. **Express 5** — `app.options('*', ...)` crash ; utiliser `app.options(/(.*)/,  cors(...))`
8. **SDK bundle** — server.js concatène socket.io.min.js + scorm-sync-sdk.js à la volée (pas de build step)
9. **Token LMS** — clé Redis `token:<8chars>`, TTL = ROOM_TTL_SECONDS, jamais de données persistantes (same TTL que la salle)
10. **watch_room vs learner_arrived** — le SCORM PC émet `watch_room` (observateur), le smartphone émet `learner_arrived` (participant actif dans `waitingLearners`)
11. **Quorum guard `syncPoint &&`** — le quorum ne déclenche le vote auto que si `syncPoint` est fourni dans `learner_arrived`. Le smartphone connecte sans syncPoint → pas de quorum. Le SCORM appelle `arrived('q1')` avec syncPoint → quorum possible. Cela garantit que `currentQuestionData` est en Redis avant l'ouverture du vote.
12. **État `'loading'` dans SCORM** — `_enterQuestion` passe par `'loading'` (spinner visible) pendant l'attente de l'ACK `sendQuestionData`. L'état `'waiting'` n'est atteint qu'après l'ACK. `pendingVoteOpen` est consommé directement dans le `.then()` de l'ACK, jamais dans `_setQState`. Séquence garantie : Redis écrit → ACK → (`pendingVoteOpen` || `arrived()`) → vote ouvert avec `questionData` présent.

---

## Sprint 1 — Flux de référence validé

**Séquence complète (3 questions, flux nominal)** :
1. `kill $(lsof -ti:3000) && node src/server.js`
2. `bash package.sh https://NGROK-URL` → ZIP mis à jour avec nouvelle URL
3. Uploader le ZIP sur SCORM Cloud
4. Ouvrir `http://localhost:3000/admin` → créer une salle
5. Sur PC : lancer le module SCORM → entrer code → slide QR
6. Sur smartphone : scanner → "Bonjour [nom]" → attendre
7. SCORM avance **automatiquement** après 1.5s → Question 1 (état `loading` → ACK `sendQuestionData` → `waiting`)
8. Quorum atteint via `arrived('q1')` du SCORM → vote auto OU admin "Force Vote q1"
9. Smartphone reçoit `vote_open` avec texte question + choix → voter
10. Résultats avec bonne réponse en vert → admin "Continue all"
11. SCORM passe à Q2 (état `loading`) → si admin a déjà forcé Q2, `pendingVoteOpen` appliqué après ACK
12. Répéter pour Q3 → fin de session automatique

**Séquence de logs Node.js attendue pour chaque question** :
```
[learner_arrived]  syncPoint: '(none)'     ← smartphone
[question_data] reçu  callbackType: 'function'
[question_data] ACK envoyé
[learner_arrived]  syncPoint: 'q1'         ← SCORM
Quorum reached, auto-opening vote
[openVote]  effectiveSyncPoint: 'q1'  hasQuestionData: true
[continue_all]  lastSyncPoint: 'q1'  → isLastQuestion: false
[continue_all]  lastSyncPoint: 'q3'  → isLastQuestion: true  ← fin de session
```

**Flux fin de session (entièrement automatique)** :
1. Vote Q3 → résultats affichés 4 secondes
2. SCORM : `_showEndSlide()` + `sendScoreToLMS()` → score reporté au LMS + `session_complete` broadcast + `continueAllAuto()` (reset salle)
3. Smartphone : `session_complete` reçu → `#state-end` avec score %, nb bonnes réponses, badge pass/fail
4. Apprenant clique "Terminer la session →" → `closeSCORM()` → `LMSFinish` → module fermé dans le LMS

**Aucun clic formateur requis pour la fin de session.**

---

## Sprint 2A — Console admin thème clair ✓

Refonte complète de `admin.html` :
- [x] Thème clair — fond `#F8FAFC`, cards blanches, shadows légères, typographie `#1E293B`
- [x] Layout 3 colonnes : Participants (270px) | Session en cours (flex) | Événements (300px)
- [x] Participants — cards nommées, avatar coloré (hash du nom), badges de statut colorés
- [x] Statuts participants : 🔵 Smartphone connecté / 🟢 Au sas / 🟠 A voté / ⚫ En attente
- [x] Contrôles contextuels — affichés/masqués selon la phase (pas juste grisés) :
  - `idle` → seul **▶ Lancer le vote** visible
  - `open` → **⏱ +30s**, **⏹ Fermer**, **💬 Fermer + Débat**
  - `result` → **▶ Continuer tous**, **↩ 2ème vote**
  - Toujours (en-tête colonne) : **⏸ Pause**, **▶ Reprendre**, **⏭ Passer**
- [x] Question en cours affichée (carte jaune dès `question_data`)
- [x] Texte des choix dans les barres de résultats
- [x] Bonne réponse en vert (`correctAnswer`) — barre + clé A/B/C/D
- [x] Toast "Action envoyée ✓" après chaque action (2s)
- [x] Bouton "↩ Nouvelle session" — réinitialise sans recharger
- [x] Responsive — colonne logs masquée sous 1024px

## Sprint 2A — Finitions console admin ✓

- [x] Header 2 lignes : ligne 1 logo+WS+formulaire, ligne 2 code salle 32px + QR 70x70
- [x] Participants — message "En attente" au lieu de squelettes vides
- [x] Noms non tronqués — word-break, 2 lignes si nécessaire
- [x] Pause/Passer masqués quand phase = idle (visible seulement pendant vote actif)
- [x] "Lancer le vote" et "Continuer tous" : max-width 280px, centrés
- [x] Logs : word-break sur les messages, police 11px
- [x] Question card : fond #EFF6FF, border-left bleu, choix A/B/C/D en grille 2×2
- [x] Timer : format "36s" + "secondes restantes", barre déplétive, rouge < 10s
- [x] Question cachée pendant résultats (barres affichent les choix)
- [x] Statuts participants pendant vote : 🔵 Smartphone → 🟠 A voté (vote_progress)
- [x] Bandeau session terminée : fond blanc, ombre vers le haut, bouton "↩ Nouvelle session"

## Sprint 2A — Finitions finales ✓

- [x] "Lancer le vote" uniquement quand `question_data` reçu — sinon spinner "En attente de la question…"
- [x] Toggle "Vote auto" dans le header (ON par défaut) — émet `set_auto_vote` socket, désactive le quorum auto
- [x] Logs — UUIDs tronqués à 8 chars + `…` pour la lisibilité
- [x] Question card disparaît bien pendant les résultats (confirmé — `setPhase('result')`)
- [x] **Onglet Résultats (Analytics)** — 2ème onglet dans la colonne Session :
  - Stats résumé : Participation, Score moyen, Taux Q1/Q2/Q3
  - Tableau par participant : Q1/Q2/Q3 avec ✅/❌, score %, temps moyen de réponse
  - Export CSV avec BOM Excel
  - Notice RGPD : données supprimées à la fin de la session, non transmises au LMS
- [x] Backend — `voteOpenedAt: Date.now()` dans `openVote` (base du calcul responseTimeMs)
- [x] Backend — `submit_vote` enrichi : stocke `room.learnerAnswers[id][sp]` + `room.learnerResponseTimes[id][sp]`
- [x] Backend — `vote_progress` enrichi : `{ total, max, learnerId, value, responseTimeMs }`
- [x] Backend — `set_auto_vote` handler dans `trainer.js` (quorum guard `autoVote !== false`)
- [x] Quorum guard : `&& updated.autoVote !== false` — vote auto désactivable à chaud

## Sprint 2A — Scaling Analytics (20 questions / 25 apprenants) ✓

- [x] **Tableau scrollable** — colonne Participant sticky gauche (150-180px), colonne Score sticky droite (62px), colonnes Q1…Qn scrollables horizontalement (52px chacune)
  - CSS : `border-collapse: separate; border-spacing: 0` requis pour sticky + borders correctes
  - Classes `.th-sticky-left / .td-sticky-left` et `.th-sticky-right / .td-sticky-right` avec `box-shadow` pour indiquer le détachement
- [x] **Colonnes dynamiques** — `seenSyncPoints[]` peuplé à chaque `question_data` reçu, trié par numéro (pas statique ['q1','q2','q3'])
- [x] **Cellule Qx à 2 lignes** — ligne 1 : réponse + ✅/❌ ; ligne 2 : temps en secondes (gris, 10px) ; pas de colonne "Tps moy." globale
- [x] **Ligne temps moyens sous le tableau** — "Temps moy. : Q1 Xs | Q2 Xs | …" (masquée si aucune donnée)
- [x] **Hint scroll** — indicateur "← scroll horizontal pour voir toutes les questions →" affiché si > 5 colonnes
- [x] **4 stats fixes** (ne scalent pas avec le nombre de questions) :
  - Participants : X connectés / Y total
  - Score moyen : % sur toute la session
  - Meilleure question : Qx — X% (taux de bonnes réponses le plus haut)
  - Question difficile : Qx — X% (taux le plus bas — utile pour le formateur)
- [x] **Bandeau session terminée supprimé** — remplacé par badge `#session-complete-badge` vert dans le header de la colonne Session, visible uniquement quand `session_complete` reçu
- [x] `newSession()` réinitialise `seenSyncPoints`, `analyticsData`, `correctAnswers`

## Sprint 2A — Tooltips Analytics ✓

- [x] **`#tooltip-custom`** — div fixed unique dans le body, z-index 9999, positionné intelligemment (ne déborde pas de l'écran)
- [x] **Hover header Qx** — tooltip : titre "Question N", texte de la question, liste des choix A/B/C/D avec bonne réponse en vert + "✅ correcte", taux de réussite %, temps moyen de réponse
- [x] **Hover cellule réponse** — tooltip : "Nom — Question N", liste des choix avec "← réponse choisie" et "← bonne réponse" (si différents), ligne "✅ Bonne réponse en Xs" ou "❌ Mauvaise réponse en Xs"
- [x] **`questionDataBySp`** — index `{ syncPoint → question_data }` peuplé depuis les events `question_data` et `vote_open.questionData`, vidé dans `newSession()`
- [x] **Event delegation** sur `.analytics-table-wrap` — `mouseover` (contenu), `mousemove` (position), `mouseleave` (masquer) ; clé de déduplication pour ne pas recalculer si même cellule

---

## État du projet — Sprint 2C ✅ Terminé

| Composant | Statut |
|---|---|
| Backend Node.js + Redis | ✅ Stable |
| WebSocket synchronisation (Socket.io) | ✅ Stable |
| SDK auto-servi (`/sdk/scorm-sync-sdk.js`) | ✅ Stable |
| QR Code avec identification LMS (token 8 chars) | ✅ Stable |
| Vote smartphone — question, Valider, multi, décodage HTML | ✅ Stable |
| Console admin thème clair + analytics + tooltips | ✅ Stable |
| Score LMS + SCORM Cloud validé | ✅ Validé |
| Banque de questions SQLite (1420 questions, 78 modules) | ✅ Sprint 2B |
| Import Rise Up Excel bilingue FR/EN — parser 15+ patterns | ✅ Sprint 2B |
| Questions à réponses multiples (426 questions) | ✅ Sprint 2B |
| Questions 2–6 propositions (A–F) | ✅ Sprint 2B |
| Admin onglet Banque — filtres, sélection rapide/manuelle | ✅ Sprint 2B |
| SCORM charge questions depuis banque (plus de hardcode) | ✅ Sprint 2B |
| Écran de diffusion présentateur (`/display`) | ✅ Sprint 2C |
| Intégration vrai module Storyline 360 | ⬜ Sprint 2D |
| Déploiement Azure | ⬜ Sprint 3 |

---

## Sprint 2B Partie 1 — Banque de questions ✅ Validée

### Résultats de validation (import Rise Up réel)
- **1420 questions** importées, **78 modules PxMy**
- Bilingue FR/EN à **99,9%** — parser splitFrEn opérationnel
- Import réussi via `/admin` → Banque → Importer (2 fichiers Excel : questions + formations)

### Fichiers créés
- `src/db/database.js` — init SQLite WAL + FK, tables `modules / questions / quiz_questions`
- `src/db/questionRepository.js` — CRUD : insertModule, getAllModules, insertQuestion (upsert), getQuestions (paginé + filtres), getRandomQuestions, assignQuestionsToQuiz, getQuizQuestions
- `src/services/questionImporter.js` — import Rise Up : parseFormationsExcel (pattern P\d+M\d+), parseVraiFaux, parseChoixMultiple, splitFrEn (heuristique bilingue, 15+ patterns)
- `src/api/routes/questions.js` — routes REST montées sur `/api` (voir table routes)

### Règles importantes
- **Routes prefix** : le router est monté à `/api`, donc les routes dans `questions.js` doivent être `/questions`, `/questions/import`, `/questions/random` (pas `/`, `/import`)
- **splitFrEn** — 15+ patterns de séparation FR/EN, dans cet ordre :
  0. CSS cleanup : supprime balises Word/Pages `[\w.-]+\s*\{[^}]*\}`
  1. `True or false` marker → split là
  1.5. Slash séparateur : `\s+\/\s*` — couvre `"/Clean"`, `"/ Wait"`
  2. Newlines : première ligne `looksNotFrench` = début EN
  2.3. Période + chiffre : `"lot.98%"` → FR=`"lot."`, EN=`"98%…"`
  2.5. Deux-points + majuscule (garde relaxée : `looksEnglish(EN)` suffit) — couvre `":Lyophilization"`, `"? :In"`, `"?:In"`
  2.6. Guillemet + majuscule (`"`, `"`, `"`, `«`, `»`) — couvre `"définition de \"The maximum"`
  2.7. Minuscule+Majuscule collées — couvre `"cuveYou"`, `"parData"`
  2.8. `?` + majuscule+minuscule (guard `looksEnglish` seul) — couvre `"?What"`, `"?Which"`
  3. Ponctuation + majuscule (`\s*` pas `\s+`) — couvre `"bioproduit.Performing"`, `"? In your opinion"`
  4. Scan mot-à-mot : premier mot majuscule non-initial sans diacritique, tail sans diacritique ET sans FR_STARTERS — couvre `"La température Temperature"`, `"Transport routier Road transport"`
- **`FR_STARTERS`** : utilise `\b` (pas d'espace trailing) + step 4 garde sur tail : `!FR_STARTERS.test(tail)` empêche "La biologie" d'être détecté comme EN
- **`EN_START_PATTERNS`** : `/^What\b/i` (large) — couvre "What can", "What happens" pas seulement "What is"
- **Mapping compétences** : les clés du map formations sont normalisées via `normalizeComp()` (supprime "(Pilote BLC)", la ref PxMy, les tirets → espaces, toLowerCase). Fallback : matching partiel dans les deux sens.
- **isCorrectAnswer** : `*texte*` dans les cellules Rise Up = bonne réponse QCM
- **Dependencies** : `better-sqlite3`, `multer`, `xlsx` ajoutés à `package.json`

### Console admin — Onglet Banque
- Tab `📚 Banque` dans la colonne Session (3ème onglet)
- Toolbar : filtre module, type, recherche texte, toggle FR/EN, bouton Importer
- Cards questions : badge type, ref module, texte FR + EN, pills choix (bonne réponse en vert)
- Pagination client (20/page)
- **Modal Import** : 2 inputs file (questions + formations), POST `/api/questions/import`
- **Modal Quick Select** : checkboxes modules, N questions, boutons **Tout / Aucun** pour les modules → POST `/api/questions/random` → persist via `persistQuizToBackend()`
- **Modal Manual Select** : liste scrollable avec checkboxes, filtre module + recherche → cache `manualQuestionsCache` → persist via `persistQuizToBackend()`
- **Quiz config card** (dans onglet Session) : visible après création salle, langue selector, preview de la sélection
- **`persistQuizToBackend()`** : `POST /api/rooms/${roomId}/quiz/quiz1/questions` avec JWT trainer + langue — appelé automatiquement après chaque sélection (rapide, manuelle, changement de langue)

## Sprint 2B Partie 2 — Assignation quiz ✅

### Ce qui fonctionne
- Sélection rapide (random N questions de modules sélectionnés) → persistée en SQLite
- Sélection manuelle (checkboxes scrollables) → persistée en SQLite
- Changement de langue → re-persiste le quiz avec la nouvelle langue
- `GET /api/rooms/:id/quiz/quiz1/questions` → retourne les questions dans la langue demandée (prêt pour le SCORM)
- `quizId` fixé à `quiz1` (extensible)

### Flux complet
1. Formateur crée une salle → quiz-config-card apparaît
2. Formateur clique "⚡ Sélection rapide" ou "✋ Sélection manuelle" → choisit les questions
3. Confirm → `POST /api/rooms/:id/quiz/quiz1/questions` sauvegarde en SQLite
4. SCORM charge `GET /api/rooms/:id/quiz/quiz1/questions` → reçoit les questions en FR ou EN
5. SCORM itère sur les questions → flux vote habituel (sendQuestionData, arrived, vote_open…)

---

## Sprint 2B — Intégration Storyline

**Objectif** : remplacer le module SCORM de test (`scorm-test/index.html`) par un vrai module Storyline 360 utilisant le SDK.

### Ce qui change côté Storyline

Le module SCORM de test (`index.html`) implémentait manuellement toute la logique de synchronisation en JavaScript inline. Avec Storyline, la logique doit passer par :
- Des **triggers JavaScript** dans les slides Storyline
- Le **SDK** (`window.ScormSync`) déjà auto-servi par le backend
- Les **variables Storyline** pour stocker l'état (code salle, statut connexion, etc.)

### Intégration SDK dans Storyline

```javascript
// Dans un trigger "Execute JavaScript" de Storyline :

// 1. Init (slide de démarrage)
ScormSync.init(BACKEND_URL);

// 2. Rejoindre une salle (slide code)
ScormSync.join({ code: player.GetVar('roomCode') });

// 3. Arriver à un sync point (début de chaque question)
ScormSync.arrived('q1');  // syncPoint correspond à l'ID de la slide question

// 4. Écouter les événements
ScormSync.on('vote_open', function(data) {
  player.SetVar('voteOpen', true);
  player.SetVar('timerSeconds', data.timerSeconds);
});

ScormSync.on('vote_result', function(data) {
  player.SetVar('correctAnswer', data.correctAnswer);
  player.SetVar('showResults', true);
});

ScormSync.on('continue_all', function() {
  player.SetVar('continueSignal', true);  // trigger avance slide
});

// 5. Envoyer les données de question (déclenché par une variable Storyline)
ScormSync.sendQuestionData('q1',
  player.GetVar('questionText'),
  { A: player.GetVar('choiceA'), B: player.GetVar('choiceB'),
    C: player.GetVar('choiceC'), D: player.GetVar('choiceD') },
  player.GetVar('correctLetter')
);

// 6. Fin de session
ScormSync.sessionComplete({
  score: player.GetVar('finalScore'),
  correct: player.GetVar('correctCount'),
  total: player.GetVar('totalQuestions')
});
```

### Contraintes Storyline à respecter

1. **Chargement SDK** — le script `<script src="BACKEND/sdk/scorm-sync-sdk.js">` doit être injecté dans le `<head>` de la story via le champ "Custom HTML" de Storyline (Player > HTML & CSS).
2. **`player` API** — `GetVar` / `SetVar` sont disponibles globalement dans les triggers JS Storyline.
3. **Triggers conditionnels** — Storyline peut surveiller une variable booléenne (`continueSignal`, `voteOpen`) et déclencher une transition de slide dès qu'elle passe à `true`.
4. **Stub dégradé** — le fallback inline du mode solo doit rester fonctionnel si le backend est injoignable (stub dans le JS custom head, avant l'import du SDK).
5. **`arrived()` vs `sendQuestionData()`** — `sendQuestionData` doit être appelé **avant** `arrived()` pour que `currentQuestionData` soit en Redis quand le quorum se déclenche. Dans Storyline, utiliser 2 triggers sur la même slide : le premier envoie `sendQuestionData`, le second (conditionnel sur ACK ou délai) appelle `arrived()`.

### Variables Storyline suggérées

| Variable | Type | Usage |
|---|---|---|
| `roomCode` | Text | Code saisi par l'apprenant |
| `syncStatus` | Text | `"connecting"` / `"waiting"` / `"vote"` / `"result"` |
| `voteOpen` | Boolean | Passe à true à `vote_open` → slide vote |
| `correctAnswer` | Text | Lettre correcte reçue dans `vote_result` |
| `continueSignal` | Boolean | Passe à true à `continue_all` → avance slide |
| `finalScore` | Number | Score calculé en fin de session |
| `questionDataSent` | Boolean | ACK `sendQuestionData` reçu |

---

## Sprint 2B Partie 2 — Intégration Storyline ✅

### Architecture (Sprint 2B final)

**Principe** : Storyline ne contient plus les questions. La slide quiz héberge un `div#sync-quiz-container` dans lequel `ScormSync.startQuiz()` gère tout le cycle (QR → vote → résultats → score).

### Fichiers créés

- `storyline-integration/trigger-quiz-start.js` — trigger JS Storyline : charge SDK, appelle `ScormSync.startQuiz()`
- `storyline-integration/trigger-result.js` — trigger JS Storyline : soumet score au LMS (SCORM 2004 + 1.2)
- `storyline-integration/GUIDE.md` — guide complet : variables, slides, structure HTML, checklist

### SDK — Nouveautés Sprint 2B Partie 2

- **`ScormSync.startQuiz(roomCode, quizId, onComplete)`** — méthode autonome qui gère tout le cycle quiz dans `#sync-quiz-container` (QR, vote, résultats, score). `onComplete({ score, correct, total })` appelé en fin.
- **`ScormSync.getRoomId()`** — expose `_roomId` après `join()`, utilisé par `loadQuestions()` dans `scorm-test/index.html`
- **`ScormSync.init(backendUrl, learnerId?, learnerName?)`** — détecte maintenant SCORM 1.2 (`API.LMSGetValue`) ET SCORM 2004 (`API_1484_11.GetValue`). Paramètres optionnels pour surcharge.

### `scorm-test/index.html` — Questions dynamiques

- **Suppression** des questions codées en dur (remplacées par un tableau vide + fallback mode solo)
- **`loadQuestions(roomId)`** — async, appelle `GET /api/rooms/:id/quiz/quiz1/questions`, mappe en `{id, text, choices: {A..D}, correct}`, stocke dans `QUESTIONS[]`
- **`_bootSync()`** — convertie en `async function`, appelle `loadQuestions()` après `join()`, spinner "Chargement des questions…" pendant le fetch
- **`showError(msg)`** — affiche l'erreur dans `qr-slide-card` + barre de statut

### `src/db/questionRepository.js` — Fix `getQuizQuestions`

- Ajout du champ `correct` (lettre) dérivé des choices : `choices.find(c => c.correct)?.letter`
- Nécessaire pour que `loadQuestions()` et `startQuiz()` puissent afficher la bonne réponse

### Variables Storyline (approche Sprint 2B finale)

| Variable | Type | Rôle |
|---|---|---|
| `SyncRoomCode` | Texte | Code salle saisi slide 1 |
| `SyncScore` | Nombre | Score 0–100, rempli par `onComplete` |
| `SyncCorrect` | Nombre | Nb bonnes réponses |
| `SyncTotal` | Nombre | Nb questions |
| `SyncDone` | Vrai/Faux | Passe à Vrai quand quiz terminé → avance slide |


---

## Sprint 2B Partie 3 — Corrections UX + Données multiples ✅

### vote.html — UX améliorée

- [x] Affichage texte de la question (#vote-question-text, fond #1e3a5f, border-left bleu)
- [x] Fix bug CSS : `display = ''` → `display = 'block'` (la règle CSS avait `display:none`, setting '' revenait à none)
- [x] Sélection + Valider : clic sélectionne (highlight bleu), bouton "✓ Valider ma réponse" fixé en bas, animation slideUp
- [x] Boutons dynamiques générés par `applyQuestionData()` depuis `d.choices` (supporte 2–6 choix)
- [x] `selectedValues[]` remplace `selectedValue` — supporte mode single et mode multi
- [x] Mode multi : toggle sélection, plusieurs boutons sélectionnables simultanément, hint "Plusieurs bonnes réponses possibles"
- [x] `submitVote` : envoie `value: 'A'` (single) ou `value: ['A','C']` (multi)
- [x] `vote_result` : colore boutons sélectionnés vert/rouge avant les résultats (700ms de délai)
- [x] `showResult` : génère les barres dynamiquement depuis les clés du `votes` object (A à F)
- [x] Couleurs E (#a78bfa violet) et F (#fb923c orange) ajoutées côté smartphone et admin
- [x] `decodeHtml()` dans vote.html — entités HTML (`&#39;` → `'`) décodées via textarea avant `textContent` sur le texte de la question et les choix

### admin.html — Barres dynamiques

- [x] `renderBars` : génère les rows `.bar-row` dynamiquement si les clés changent (plus de hardcode A/B/C/D)
- [x] `setChoiceTexts` : itère sur `Object.keys(choices)` au lieu de `['A','B','C','D']`
- [x] `renderBars` appelé avant `setChoiceTexts` (fix ordre — les IDs `choice-X` doivent exister avant d'être peuplés)
- [x] `correctAnswer` peut être string 'B' OU array ['A','C'] — bonne(s) réponse(s) en vert

### Backend — Réponses multiples

- [x] `src/utils/constants.js` : `VOTE_VALUES` étendu à `['A','B','C','D','E','F']`
- [x] `src/db/database.js` : colonne `multiple_correct INTEGER DEFAULT 0` dans `questions` + migration auto
- [x] `src/services/voteService.js` : `submitVote` accepte `value` string OU array, incrémente chaque lettre
- [x] `src/services/questionImporter.js` : auto-détecte `multiple_correct = 1` si > 1 bonne réponse dans le QCM
- [x] `src/db/questionRepository.js` : `insertQuestion` sauvegarde `multiple_correct`, `getQuizQuestions` retourne `correct` comme array si `multiple_correct=1`
- [x] `src/socket/handlers/learner.js` : `question_data` passe `multipleCorrect`, `submit_vote` normalise value en array pour validation
- [x] `src/sdk/scorm-sync-sdk.js` : `sendQuestionData(sp, q, c, correct, multipleCorrect)` — 5ème paramètre
- [x] `scorm-test/index.html` : `loadQuestions` mappe `multiple_correct`, `sendQuestionData` le passe en arg 5

### Règles importantes

13. **`multiple_correct`** : booléen 0/1 stocké en SQLite. Dans `getQuizQuestions` : si `multiple_correct=1`, `correct` est retourné comme array `['A','C']`; sinon string `'B'`. Le smartphone et l'admin reçoivent indifféremment les deux formes — traiter avec `Array.isArray`.
14. **Boutons dynamiques vote.html** : générés dans `.vote-col#vote-buttons-col` par `applyQuestionData()`. Les IDs `vbtn-X` et `vcol-text-X` sont créés à la volée. Ne plus supposer A/B/C/D fixes.
15. **Barres admin dynamiques** : `renderBars` regénère les rows si les clés changent. L'ordre d'appel est `renderBars` PUIS `setChoiceTexts` (les `choice-X` elements doivent exister).
16. **Migration DB** : `rm data/questions.db && node src/server.js` pour recréer avec le nouveau schéma, puis réimporter les questions.

---

## Sprint 2C — Écran de diffusion présentateur ✅ Terminé

### `public/display.html`
Accessible via `GET /display?room=CODE` — destiné au projecteur/TV du formateur.

**5 états** :
| État | Déclencheur | Contenu |
|---|---|---|
| `welcome` | Connexion initiale | QR Code 280px + compteur participants + barre progression |
| `vote` | `vote_open` | Question + grille choix A–F + timer déplétif + progression votes |
| `result` | `vote_result` | Barres animées par choix + bonne réponse en vert + % |
| `between` | `continue_all` (non-last) | Score moyen en cours + nb questions répondues |
| `end` | `continue_all` (last) ou `session_complete` | Score groupe + meilleure/pire question |

**Fichiers créés/modifiés** :
- `public/display.html` — nouveau, ~500 lignes HTML/CSS/JS
- `src/utils/constants.js` — `ROLES.DISPLAY = 'display'`
- `src/api/routes/auth.js` — `GET /api/auth/display-token?room=CODE` (JWT public, sans auth)
- `src/socket/handlers/display.js` — nouveau, rejoint `room:${roomId}` en lecture seule
- `src/socket/index.js` — route role=display vers `registerDisplayHandlers`
- `src/server.js` — route `GET /display` déplacée **avant** `express.static` (fix "Cannot GET /display")
- `admin.html` — bouton `[📺 Écran de diffusion]` + `openDisplay()` dans `#hrow2-actions`

**Architecture** :
- `GET /api/auth/display-token?room=CODE` → JWT signé `{ sub:'display', role:'display', roomId }` (aucune auth requise)
- Socket.io se connecte avec ce JWT, role=display → `registerDisplayHandlers` → `socket.join('room:${roomId}')`
- Le display reçoit tous les events broadcastés à la salle (lecture seule, aucun emit)
- Socket.io client servi depuis `/socket.io/socket.io.js`
- QR Code : lib `/sdk/qrcode.min.js` chargée en async au démarrage

**Design** :
- Thème clair #F8FAFC, textes #1E293B, primaire #2563EB
- Inter/system-ui, titres 40–64px, textes 24–32px
- Viewport fixe sans scroll
- Overlay de connexion (spinner) + overlay de pause (`global_pause`)
- Transitions `opacity .35s ease` entre états

### Correctifs Sprint 2C

- [x] Fix `waiting_update` manquant sur SCORM/display : snapshot immédiat envoyé sur `watch_room` et `registerDisplayHandlers` — SCORM et display reçoivent l'état courant des participants même s'ils se connectent après les apprenants
- [x] Fix race condition `waitingLearners` : verrou en mémoire `withArrivalLock(roomId, fn)` dans `learner.js` — sérialise les `learner_arrived` par room pour éviter que des connexions simultanées n'écrasent les entrées Redis des uns et des autres
- [x] `src/utils/simulate-voters.js` — script de test : N apprenants simulés, auth → join → vote aléatoire sur `vote_open`, prêt pour la question suivante sur `continue_all`
- [x] Fix limite participants non respectée : vérification autoritative dans `learner_arrived` sous `withArrivalLock` (HTTP seul insuffisant — race condition Redis sur `learnerNames` avec 10+ joins parallèles)
- [x] `learnerNames` écrit uniquement sous `withArrivalLock` dans `learner_arrived` (plus dans le handler HTTP `/api/rooms/join` qui ne fait qu'un pre-filter best-effort)
- [x] Fix compteur votes multi-réponses : champ `votersCount` dans Redis (1 par soumission), `vote_progress.total` utilise `votersCount` au lieu de la somme des lettres
- [x] Règle métier réponses multiples (exact match) : l'apprenant doit sélectionner exactement toutes les bonnes réponses — comparaison triée dans `vote.html` et `admin.html`
- [x] UX salle complète : `join_error { message: 'Salle complète' }` affiche `#slide-full` dans le SCORM (fond `#1e3a5f`, blanc) avec boutons **Réessayer** (countdown 5s) et **Continuer en mode solo** — plus de fallback solo silencieux
- [x] `_post` dans le SDK extrait le message d'erreur du body JSON (avant : `"403 /api/rooms/join"`, après : `"Salle complète"`)
- [x] `join_error` ajouté aux événements forwardés par `_connectSocket` (couvre aussi le rejet côté socket dans `learner_arrived`)
- [x] Auto-validation `admin.html` analytics : l'admin émet `join_room` pour rejoindre le channel Socket.io de la salle (les broadcasts ne sont reçus qu'après ce join explicite)

### Règles importantes

17. **display-token** : endpoint GET public (pas de JWT entrant), résout le code salle → JWT display signé. Côté socket, le display ne peut qu'écouter — aucun emit autorisé, aucun handler enregistré sauf la jointure de la room.
18. **Ordre middlewares server.js** : les routes explicites (`/admin`, `/vote`, `/display`) doivent être déclarées **avant** `app.use(express.static(...))` — sinon Express static intercepte les chemins sans extension et répond 404 avant que la route ne soit atteinte.
19. **Snapshot sur connexion tardive** : `watch_room` (SCORM) et `registerDisplayHandlers` (écran de diffusion) envoient immédiatement un `waiting_update` + `question_data` + `vote_open` si applicable. Cela compense l'absence d'historique des broadcasts Socket.io.
20. **Race condition `waitingLearners`** : quand plusieurs apprenants émettent `learner_arrived` simultanément, le pattern read-modify-write Redis peut causer des écrasements mutuels. Fix : `withArrivalLock(roomId, fn)` dans `learner.js` — Promise chain en mémoire par room, sérialise l'exécution des handlers. Valable uniquement en mode single-process (POC). En prod multi-instance, utiliser un lock distribué Redis.
21. **Limite participants — authorité socket** : la vérification `totalLearners` dans `POST /api/rooms/join` est un pre-filter best-effort uniquement. La vérification autoritative est dans `learner_arrived` sous `withArrivalLock` (lecture + écriture de `learnerNames` atomiques). C'est là que `socket.emit('join_error', { message: 'Salle complète' })` est émis.
22. **`learnerNames` — écriture sous lock** : ne jamais écrire `learnerNames` dans le handler HTTP `/api/rooms/join` (race condition garantie sur 10+ joins parallèles). Seul `learner_arrived` (sous `withArrivalLock`) écrit cette map de façon sérialisée.
23. **`package.sh` obligatoire** : après toute modification de `scorm-test/index.html` ou `src/sdk/scorm-sync-sdk.js`, relancer `bash package.sh [URL]` pour regénérer `scorm-test.zip`. Le SDK est embarqué dans le ZIP à la génération — sans cela, SCORM Cloud charge l'ancienne version.

---

## Sprint 2D — Intégration Storyline 360 ⬜ À venir

**Objectif** : remplacer `scorm-test/index.html` par un vrai module Storyline 360 utilisant le SDK.

Les fichiers de référence sont déjà prêts dans `storyline-integration/` :
- `trigger-quiz-start.js` — trigger JS Storyline : charge SDK, appelle `ScormSync.startQuiz()`
- `trigger-result.js` — trigger JS Storyline : soumet score au LMS (SCORM 2004 + 1.2)
- `GUIDE.md` — guide complet : variables, slides, structure HTML, checklist

Variables Storyline requises : `SyncRoomCode`, `SyncScore`, `SyncCorrect`, `SyncTotal`, `SyncDone`.
