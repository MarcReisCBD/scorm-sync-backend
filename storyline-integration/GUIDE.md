# Guide d'intégration Storyline 360 — ScormSync

Ce dossier contient les scripts JavaScript à coller dans des triggers Storyline
pour connecter un module Storyline 360 au backend ScormSync.

---

## Architecture

```
Storyline 360 (apprenant PC)
    │
    ├─ Slide 1 : Saisie du code salle (variable SyncRoomCode)
    ├─ Slide 2 : Quiz collectif
    │     └─ div#sync-quiz-container  ← ScormSync gère tout ici
    │           ├─ QR Code + attente smartphone
    │           ├─ Questions + timer + votes
    │           └─ Résultats par question
    └─ Slide 3 : Score final
          └─ trigger-result.js → LMSSetValue
```

Le backend gère le cycle complet de chaque question. Storyline ne contient
**aucune question** — elles viennent de la banque de questions configurée
par le formateur depuis la console admin.

---

## Variables Storyline à créer

| Nom | Type | Valeur initiale | Rôle |
|---|---|---|---|
| `SyncRoomCode` | Texte | `""` | Code de salle saisi par l'apprenant |
| `SyncScore` | Nombre | `0` | Score final 0–100 (rempli par startQuiz) |
| `SyncCorrect` | Nombre | `0` | Nombre de bonnes réponses |
| `SyncTotal` | Nombre | `0` | Nombre total de questions |
| `SyncDone` | Vrai/Faux | `Faux` | Passe à Vrai quand le quiz est terminé |

---

## Slide 1 — Saisie du code salle

1. Ajouter un champ de saisie lié à la variable `SyncRoomCode`
2. Ajouter un bouton "Rejoindre"
3. Trigger sur le bouton : **Passer à la slide suivante**

---

## Slide 2 — Quiz collectif

### Structure HTML

Créer un **Web Object** ou utiliser le champ **Enter HTML** d'un bloc texte avancé
avec ce contenu minimal :

```html
<div id="sync-quiz-container"
     style="width:100%;height:100%;box-sizing:border-box;overflow:auto;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            background:#f8fafc">
</div>
```

La div doit remplir la zone de contenu de la slide (typiquement 720×540 px).

### Trigger JavaScript au démarrage

- **Événement** : Timeline Start
- **Script** : contenu de `trigger-quiz-start.js`
- **Modifier** :
  ```javascript
  var BACKEND_URL = 'https://votre-url-backend.azurewebsites.net';
  var QUIZ_ID     = 'quiz1';
  ```

### Trigger conditionnel d'avance

- **Événement** : Variable SyncDone change
- **Condition** : SyncDone est égal à Vrai
- **Action** : Passer à la slide suivante (Slide 3)

---

## Slide 3 — Score final

### Affichage

Créer des zones de texte liées aux variables :
- `%SyncScore%%` → affiche "85" (le %)
- `%SyncCorrect% / %SyncTotal%` → affiche "5 / 6"

Ou via un trigger texte conditionnel pour afficher "Réussi ✓" / "Échoué ✗".

### Trigger JavaScript — soumission au LMS

- **Événement** : Timeline Start
- **Script** : contenu de `trigger-result.js`
- **Adapter** le seuil de réussite si nécessaire :
  ```javascript
  var passed = score >= 70;  // ← modifier selon vos critères
  ```

---

## Chargement du SDK

Le SDK est chargé automatiquement depuis le backend par `trigger-quiz-start.js`.
**Ne pas** inclure le SDK dans le projet Storyline — il serait obsolète à chaque
déploiement backend.

Si le backend est injoignable, un message d'erreur s'affiche dans le conteneur
et le quiz ne démarre pas. Il n'y a pas de mode solo dans l'intégration Storyline
(contrairement au module de test `scorm-test/index.html`).

---

## Checklist avant publication

- [ ] `BACKEND_URL` mis à jour dans `trigger-quiz-start.js`
- [ ] Variables Storyline créées avec les bons types et valeurs initiales
- [ ] `div#sync-quiz-container` présent sur la slide quiz
- [ ] Quiz configuré dans la console admin (onglet Banque → sélection + sauvegarder)
- [ ] Test avec SCORM Cloud : créer une salle, lancer le module, scanner le QR

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| "Code de salle manquant" | Variable SyncRoomCode vide | Vérifier le trigger de saisie slide 1 |
| "Salle introuvable" | Code expiré ou invalide | Créer une nouvelle salle depuis admin |
| "Aucune question configurée" | Quiz pas encore assigné | Admin → onglet Banque → configurer quiz |
| Conteneur blanc | div#sync-quiz-container absent | Vérifier l'ID HTML exact |
| Score non reporté | SCORM API non disponible hors LMS | Normal en prévisualisation Storyline |
