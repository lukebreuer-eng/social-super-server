#!/bin/bash
# ============================================
# Social Super Server — SQLite → PostgreSQL Migratie
# ============================================
#
# STAP 1: Data is al geëxporteerd (JSON bestanden in deze map)
#
# STAP 2: Pas in Coolify de Directus environment variables aan:
#   DB_CLIENT=pg
#   DB_HOST=<postgres-container-naam>   (bijv. postgres of de Coolify service naam)
#   DB_PORT=5432
#   DB_DATABASE=directus
#   DB_USER=directus
#   DB_PASSWORD=<jouw-wachtwoord>
#
#   VERWIJDER eventueel: DB_FILENAME (dat was de SQLite config)
#
# STAP 3: Herstart Directus in Coolify
#   → Directus maakt automatisch zijn system tables aan in PostgreSQL
#
# STAP 4: Pas het schema toe (custom collections)
#   Dit script doet dat via de Directus API
#
# STAP 5: Importeer alle data
#   Dit script doet dat ook
#
# ============================================

set -e

DIRECTUS_URL="${DIRECTUS_URL:-https://social.ipaudio.nl}"
DIRECTUS_TOKEN="${DIRECTUS_TOKEN:-_mJgSPX29_mvLg98sXRctqzlsSWADYld}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTH="Authorization: Bearer $DIRECTUS_TOKEN"

echo "============================================"
echo "Social Super Server — PostgreSQL Migratie"
echo "============================================"
echo "Directus URL: $DIRECTUS_URL"
echo ""

# ============================================
# STAP 4: Schema toepassen
# ============================================
echo ">>> Stap 4: Schema toepassen..."

# Apply the schema snapshot via diff/apply
CURRENT=$(curl --silent "$DIRECTUS_URL/schema/snapshot" -H "$AUTH")
DIFF=$(curl --silent -X POST "$DIRECTUS_URL/schema/diff" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d @"$SCRIPT_DIR/schema-snapshot.json")

# Check if there's a diff to apply
HAS_DIFF=$(echo "$DIFF" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'data' in d and d['data']:
    print('yes')
else:
    print('no')
" 2>/dev/null || echo "error")

if [ "$HAS_DIFF" = "yes" ]; then
  echo "Schema verschil gevonden, toepassen..."
  APPLY_RESULT=$(curl --silent -X POST "$DIRECTUS_URL/schema/apply" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$DIFF")
  echo "Schema toegepast: $APPLY_RESULT"
else
  echo "Geen schema verschil of schema is al up-to-date"
fi

echo ""

# ============================================
# STAP 5: Data importeren
# ============================================
echo ">>> Stap 5: Data importeren..."

# Import order matters due to foreign keys
COLLECTIONS=(
  "Bedrijven"
  "Campaigns"
  "Social_Accounts"
  "Posts"
  "Posts_Social_Accounts"
  "Leads"
  "Content_Templates"
  "Competitors"
  "AI_Knowledge_Base"
  "AI_Suggestions"
  "Ad_Campaigns"
  "Ad_Creatives"
  "Insights"
  "Post_Log"
)

for collection in "${COLLECTIONS[@]}"; do
  FILE="$SCRIPT_DIR/data-$collection.json"
  if [ ! -f "$FILE" ]; then
    echo "  SKIP $collection (geen bestand)"
    continue
  fi

  COUNT=$(python3 -c "
import json
with open('$FILE') as f:
    d = json.load(f)
    items = d.get('data', [])
    print(len(items))
" 2>/dev/null || echo "0")

  if [ "$COUNT" = "0" ] || [ "$COUNT" = "" ]; then
    echo "  SKIP $collection (0 records)"
    continue
  fi

  echo -n "  $collection ($COUNT records)... "

  # Extract just the data array and POST it
  ITEMS=$(python3 -c "
import json
with open('$FILE') as f:
    d = json.load(f)
    print(json.dumps(d['data']))
")

  RESULT=$(curl --silent -X POST "$DIRECTUS_URL/items/$collection" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$ITEMS" \
    -o /dev/null -w "%{http_code}")

  if [ "$RESULT" = "200" ] || [ "$RESULT" = "204" ]; then
    echo "OK ($RESULT)"
  else
    echo "FOUT ($RESULT) — probeer 1 voor 1..."
    # Fallback: insert one by one
    OK=0
    FAIL=0
    for item in $(python3 -c "
import json
with open('$FILE') as f:
    d = json.load(f)
    for i, item in enumerate(d['data']):
        print(json.dumps(item))
"); do
      R=$(curl --silent -X POST "$DIRECTUS_URL/items/$collection" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "$item" \
        -o /dev/null -w "%{http_code}")
      if [ "$R" = "200" ] || [ "$R" = "204" ]; then
        OK=$((OK+1))
      else
        FAIL=$((FAIL+1))
      fi
    done
    echo "    → $OK OK, $FAIL mislukt"
  fi
done

echo ""
echo "============================================"
echo "Migratie voltooid!"
echo "============================================"
echo ""
echo "Volgende stap: SQL views aanmaken"
echo "Voer uit op de PostgreSQL database:"
echo "  psql -U directus -d directus -f $SCRIPT_DIR/../create-sql-views-postgres.sql"
