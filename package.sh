#!/usr/bin/env bash
# package.sh — Génère scorm-test.zip avec SDK embarqué (pas de chargement ngrok au démarrage)
# Usage : bash package.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/scorm-test"
OUT="$SCRIPT_DIR/scorm-test.zip"
TMP_DIR=$(mktemp -d)

if [ ! -d "$SRC" ]; then
  echo "❌ Dossier scorm-test/ introuvable"
  exit 1
fi

# ── Mise à jour optionnelle de BACKEND_URL via argument ──────────────────
if [ -n "$1" ]; then
  NEW_URL="${1%/}"  # enlève le slash final si présent
  echo "🔗 Mise à jour BACKEND_URL → $NEW_URL"
  node -e "
const fs = require('fs');
const f = '$SRC/index.html';
const content = fs.readFileSync(f, 'utf8');
const updated = content.replace(/BACKEND_URL = '[^']*'/, \"BACKEND_URL = '$NEW_URL'\");
fs.writeFileSync(f, updated);
"
fi

# ── Vérification BACKEND_URL ──────────────────────────────────────────────
CURRENT_URL=$(grep -o "BACKEND_URL = '[^']*'" "$SRC/index.html" | cut -d"'" -f2)
echo "ℹ️  BACKEND_URL : $CURRENT_URL"
if [ -z "$CURRENT_URL" ] || [ "$CURRENT_URL" = "http://localhost:3000" ]; then
  echo "⚠️  BACKEND_URL pointe vers localhost — le ZIP ne fonctionnera pas sur SCORM Cloud"
  echo "   → Utiliser : bash package.sh https://xxxx.ngrok-free.app"
fi

# ── Injection bundle SDK dans index.html ─────────────────────────────────
# Le bundle (socket.io + qrcode + scorm-sync-sdk) remplace %%SDK_CONTENT%%
# Les chaînes </script> dans le bundle sont échappées en <\/script>
echo "📦 Injection bundle SDK dans index.html…"
node -e "
const fs = require('fs');
const template  = fs.readFileSync('$SRC/index.html', 'utf8');
const socketIO  = fs.readFileSync('$SRC/socket.io.min.js', 'utf8');
const qrcode    = fs.readFileSync('$SCRIPT_DIR/src/sdk/qrcode.min.js', 'utf8');
const sdkLogic  = fs.readFileSync('$SCRIPT_DIR/src/sdk/scorm-sync-sdk.js', 'utf8');
const bundle    = [socketIO, qrcode, sdkLogic].join('\n\n')
                    .replace(/<\/script>/gi, '<\\/script>');
const result = template.replace('%%SDK_CONTENT%%', bundle);
if (result === template) {
  process.stderr.write('ERREUR : placeholder %%SDK_CONTENT%% absent de index.html\n');
  process.exit(1);
}
fs.writeFileSync('$TMP_DIR/index.html', result);
"
cp "$SRC/imsmanifest.xml" "$TMP_DIR/imsmanifest.xml"
echo "   ✓ index.html traité : $(du -sh $TMP_DIR/index.html | cut -f1)"

# ── ZIP ────────────────────────────────────────────────────────────────────
[ -f "$OUT" ] && rm "$OUT" && echo "🗑  Ancien scorm-test.zip supprimé"

cd "$TMP_DIR"
zip -r "$OUT" .
cd "$SCRIPT_DIR"
rm -rf "$TMP_DIR"

echo "✅ scorm-test.zip créé : $OUT"
echo "   $(du -sh "$OUT" | cut -f1)  —  prêt pour SCORM Cloud"
echo "   BACKEND_URL = $CURRENT_URL"
