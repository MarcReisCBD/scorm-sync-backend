# SCORMSync Backend

Backend de synchronisation temps réel pour sessions SCORM collaboratives, basé sur l'approche pairagogique **Peer Instruction** (Mazur).

Permet à plusieurs apprenants de suivre simultanément un module SCORM (Storyline 360) avec des votes collectifs synchronisés en temps réel.

> **Principe clé** : le backend ne connaît jamais le contenu des questions. Il gère uniquement des identifiants de sync points (`q1`, `q2`…), des compteurs de votes anonymisés, et l'état des salles. Les questions restent dans Storyline.

---

## Fonctionnalités

- **Salles collaboratives** — création à la volée avec code mémorisable (ex: `TIGRE-73`), jusqu'à N apprenants
- **Votes synchronisés** — QCM simple ou multi-réponses (A–F), timer configurable
- **Écran de diffusion** — page projecteur temps réel (`/display?room=CODE`) avec QR code, progression des votes et résultats animés
- **Console formateur** — interface admin avec tableau de résultats, KPIs, export CSV
- **Page de vote smartphone** — interface apprenant optimisée mobile (`/vote?room=CODE`)
- **SDK Storyline** — `window.ScormSync` intégrable dans n'importe quel module SCORM 1.2 / 2004
- **Import de questions** — depuis Excel (format RiseUp), stockage SQLite

---

## Stack technique

| Composant | Technologie |
|---|---|
| Runtime | Node.js 20 LTS |
| Serveur HTTP | Express 5 |
| WebSocket | Socket.io 4 |
| Cache / État | Redis (ioredis) |
| Auth | JWT (jsonwebtoken) |
| Base questions | SQLite (better-sqlite3) |
| Import Excel | xlsx + multer |
| Logger | Winston |

---

## Installation

### Prérequis

- Node.js 20 LTS
- Redis (local ou Azure Cache for Redis)

### Démarrage

```bash
git clone https://github.com/MarcReisCBD/scorm-sync-backend.git
cd scorm-sync-backend
npm install
cp .env.example .env   # configurer les variables
node src/server.js
```

### Variables d'environnement

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
JWT_SECRET=votre_secret
BACKEND_URL=http://192.168.1.50:3000
```

---

## Architecture

```
SCORM Cloud (Storyline)
  └── <script src="BACKEND/sdk/scorm-sync-sdk.js">
        └── window.ScormSync.init(BACKEND_URL)
              ├── .join({ code })          — rejoindre la salle
              ├── .arrived(syncPoint)      — déclencher le vote
              ├── .vote(value)             — soumettre une réponse
              └── .sessionComplete(...)    — soumettre le score LMS
```

### Flux d'une session

1. Le formateur crée une salle → code `ANIMAL-XX` généré
2. Les apprenants scannent le QR code ou saisissent le code dans Storyline
3. Quand le quorum est atteint, le SCORM déclenche `arrived(syncPoint)`
4. Le vote s'ouvre → les apprenants votent sur leur smartphone ou dans Storyline
5. Résultats affichés en temps réel sur l'écran de diffusion et dans Storyline
6. Score transmis au LMS en fin de session

---

## Pages disponibles

| URL | Description |
|---|---|
| `/admin` | Console formateur |
| `/display?room=CODE` | Écran de diffusion (projecteur) |
| `/vote?room=CODE` | Page de vote smartphone |
| `/sdk/scorm-sync-sdk.js` | SDK JavaScript pour Storyline |

---

## API Socket.io — Événements principaux

| Événement | Direction | Description |
|---|---|---|
| `learner_arrived` | Client → Serveur | Apprenant prêt sur un sync point |
| `submit_vote` | Client → Serveur | Soumission d'un vote (string ou array) |
| `vote_open` | Serveur → Client | Ouverture d'un vote |
| `vote_result` | Serveur → Client | Résultats avec répartition par lettre |
| `waiting_update` | Serveur → Client | Mise à jour compteur participants |
| `continue_all` | Serveur → Client | Passage à la question suivante |

---

## Test avec le simulateur

```bash
# Simuler N apprenants sur une salle
node src/utils/simulate-voters.js TIGRE-73 10
```

Le script crée N connexions Socket.io fictives qui rejoignent la salle et votent automatiquement sur `vote_open`.

---

## Intégration Storyline 360

Les fichiers d'intégration sont dans `storyline-integration/` :

- `trigger-quiz-start.js` — trigger JS à coller dans Storyline
- `trigger-result.js` — soumission du score au LMS
- `GUIDE.md` — guide complet avec variables, structure des slides, checklist

Variables Storyline requises :

| Variable | Type | Rôle |
|---|---|---|
| `SyncRoomCode` | Texte | Code salle saisi slide 1 |
| `SyncScore` | Nombre | Score 0–100 |
| `SyncCorrect` | Nombre | Nombre de bonnes réponses |
| `SyncTotal` | Nombre | Nombre de questions |
| `SyncDone` | Vrai/Faux | Passe à Vrai en fin de quiz → avance la slide |

---

## Infrastructure cible

- **POC local** : Ubuntu local, Redis local, HTTP
- **Production** : Azure App Service (P1v3) + Azure Cache for Redis + Azure Key Vault
- **Console formateur** : Azure Static Web Apps (React SPA — à venir)

---

## Statut du projet

| Sprint | Description | Statut |
|---|---|---|
| Sprint 1 | SDK + salles + votes + authentification | ✅ Terminé |
| Sprint 2A | Import questions Excel + banque SQLite | ✅ Terminé |
| Sprint 2B | Questions dynamiques + réponses multiples + vote.html UX | ✅ Terminé |
| Sprint 2C | Écran de diffusion (`display.html`) + simulateur | ✅ Terminé |
| Sprint 2D | Intégration Storyline 360 | ⬜ À venir |
