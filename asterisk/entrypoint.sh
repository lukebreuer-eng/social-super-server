#!/bin/sh
# Vult de sjablonen met de SIP-gegevens en start Asterisk.
set -e

if [ -z "$SIP_HOST" ] || [ -z "$SIP_USER" ] || [ -z "$SIP_PASS" ]; then
  echo "SIP_HOST, SIP_USER en SIP_PASS moeten gezet zijn. Zie asterisk/README.md."
  exit 1
fi

# Het interne containeradres; hierop bindt SIP en ARI, nooit op 0.0.0.0.
BIND_ADDR=$(hostname -i | awk '{print $1}')
# Adres waarop de MiVB ons ziet. Binnen hetzelfde netwerk is dat gelijk aan het
# containeradres; staat de centrale buiten het netwerk, zet dan EXTERN_IP.
EXTERN_IP="${EXTERN_IP:-$BIND_ADDR}"
echo "Asterisk bindt op ${BIND_ADDR}, extern adres ${EXTERN_IP}"

mkdir -p /etc/asterisk /var/lib/asterisk/sounds/bot
for f in /etc/asterisk-template/*; do
  naam=$(basename "$f")
  sed -e "s|__SIP_HOST__|${SIP_HOST}|g" \
      -e "s|__SIP_USER__|${SIP_USER}|g" \
      -e "s|__SIP_PASS__|${SIP_PASS}|g" \
      -e "s|__SIP_CALLERID__|${SIP_CALLERID:-$SIP_USER}|g" \
      -e "s|__BIND_ADDR__|${BIND_ADDR}|g" \
      -e "s|__EXTERN_IP__|${EXTERN_IP}|g" \
      -e "s|__ARI_USER__|${ARI_USER:-engine}|g" \
      -e "s|__ARI_PASS__|${ARI_PASS:-wijzigmij}|g" \
      "$f" > "/etc/asterisk/${naam}"
done

echo "Asterisk start, registreert als ${SIP_USER} op ${SIP_HOST}"
exec asterisk -f -vvv
