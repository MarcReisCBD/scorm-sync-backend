// ── ScormSync — Trigger Storyline : Démarrage du quiz ────────────────────────
// Coller dans un trigger "Exécuter JavaScript" sur la slide "Quiz Collectif".
// Déclencheur recommandé : Timeline Start de cette slide.
//
// Prérequis côté Storyline :
//   1. Un div id="sync-quiz-container" présent sur la slide (Web Object ou HTML Block)
//   2. Variables Storyline créées :
//        SyncRoomCode  (Texte)   — saisi par l'apprenant sur la slide précédente
//        SyncScore     (Nombre)  — score final 0-100
//        SyncCorrect   (Nombre)  — nombre de bonnes réponses
//        SyncTotal     (Nombre)  — nombre de questions
//        SyncDone      (Vrai/Faux, init = Faux)
//   3. Trigger conditionnel sur cette slide :
//        "Passer à la slide suivante quand SyncDone = Vrai"
// ─────────────────────────────────────────────────────────────────────────────

var BACKEND_URL = 'https://TON-URL-NGROK';   // ← Remplacer par l'URL réelle
var QUIZ_ID     = 'quiz1';                   // ← Adapter si plusieurs quiz

var player = GetPlayer();

// Guard : ne pas relancer si déjà actif (navigation arrière/avant dans SL)
if (window._sqzStarted) return;
window._sqzStarted = true;

var roomCode = (player.GetVar('SyncRoomCode') || '').trim().toUpperCase();
if (!roomCode) {
  var c = document.getElementById('sync-quiz-container');
  if (c) c.innerHTML = '<div style="padding:20px;color:#ef4444;font-size:14px;text-align:center">'
    + 'Code de salle manquant.<br>Retournez à la slide précédente et entrez un code.</div>';
  return;
}

function _startSyncQuiz() {
  // init() lit automatiquement l'identité SCORM 1.2 et SCORM 2004
  ScormSync.init(BACKEND_URL);

  ScormSync.startQuiz(roomCode, QUIZ_ID, function (result) {
    player.SetVar('SyncScore',   result.score);
    player.SetVar('SyncCorrect', result.correct);
    player.SetVar('SyncTotal',   result.total);
    player.SetVar('SyncDone',    true);
    // Le trigger conditionnel SL "SyncDone = Vrai → Aller à slide suivante" prend le relais
  });
}

if (typeof window.ScormSync !== 'undefined' && window.ScormSync._loaded) {
  _startSyncQuiz();
} else {
  var s = document.createElement('script');
  s.src = BACKEND_URL + '/sdk/scorm-sync-sdk.js';
  s.onerror = function () {
    var c = document.getElementById('sync-quiz-container');
    if (c) c.innerHTML = '<div style="padding:20px;color:#ef4444;font-size:14px;text-align:center">'
      + 'Backend indisponible.<br>Vérifiez votre connexion et rechargez.</div>';
  };
  s.onload = _startSyncQuiz;
  document.head.appendChild(s);
}
