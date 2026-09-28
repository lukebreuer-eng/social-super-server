#!/bin/sh
# Vult de sjablonen met de SIP-gegevens en start Asterisk.
set -e

if [ -z "$SIP_HOST" ] || [ -z "$SIP_USER" ] || [ -z "$SIP_PASS" ]; then
  echo "SIP_HOST, SIP_USER en SIP_PASS moeten gezet zijn. Zie asterisk/README.md."
  exit 1
fi

mkdir -p /etc/asterisk /var/lib/asterisk/sounds/bot
for f in /etc/asterisk-template/*; do
  naam=$(basename "$f")
  sed -e "s|__SIP_HOST__|${SIP_HOST}|g" \
      -e "s|__SIP_USER__|${SIP_USER}|g" \
      -e "s|__SIP_PASS__|${SIP_PASS}|g" \
      -e "s|__SIP_CALLERID__|${SIP_CALLERID:-$SIP_USER}|g" \
      -e "s|__ARI_USER__|${ARI_USER:-engine}|g" \
      -e "s|__ARI_PASS__|${ARI_PASS:-wijzigmij}|g" \
      "$f" > "/etc/asterisk/${naam}"
done

echo "Asterisk start, registreert als ${SIP_USER} op ${SIP_HOST}"
exec asterisk -f -vvv
