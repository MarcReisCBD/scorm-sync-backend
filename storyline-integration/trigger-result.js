// ── ScormSync — Trigger Storyline : Soumission du score au LMS ───────────────
// Coller dans un trigger "Exécuter JavaScript" sur la slide de résultats finaux.
// Déclencheur recommandé : Timeline Start de la slide résultats
//   (ou condition "Quand SyncDone passe à Vrai" sur une diapositive master)
//
// Fonctionne avec SCORM 2004 (API_1484_11) et SCORM 1.2 (API) — détection auto.
// ─────────────────────────────────────────────────────────────────────────────

var player = GetPlayer();

var score   = player.GetVar('SyncScore')   || 0;   // 0–100
var correct = player.GetVar('SyncCorrect') || 0;
var total   = player.GetVar('SyncTotal')   || 1;

var passed  = score >= 70;   // ← Adapter le seuil si nécessaire

// ── SCORM 2004 ────────────────────────────────────────────────────────────────
var api2004 = window.API_1484_11;
if (api2004) {
  api2004.SetValue('cmi.score.raw',     String(score));
  api2004.SetValue('cmi.score.scaled',  String((score / 100).toFixed(2)));
  api2004.SetValue('cmi.score.min',     '0');
  api2004.SetValue('cmi.score.max',     '100');
  api2004.SetValue('cmi.success_status',    passed ? 'passed' : 'failed');
  api2004.SetValue('cmi.completion_status', 'completed');
  api2004.Commit('');
  return;
}

// ── SCORM 1.2 ─────────────────────────────────────────────────────────────────
function findAPI12() {
  var win = window;
  for (var i = 0; i < 10; i++) {
    if (win.API) return win.API;
    if (!win.parent || win.parent === win) break;
    win = win.parent;
  }
  try { if (window.top && window.top.API) return window.top.API; } catch (e) {}
  return null;
}

var api12 = findAPI12();
if (api12) {
  api12.LMSSetValue('cmi.core.score.raw',   String(score));
  api12.LMSSetValue('cmi.core.lesson_status', passed ? 'passed' : 'failed');
  api12.LMSCommit('');
}
