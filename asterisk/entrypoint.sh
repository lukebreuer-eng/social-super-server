#!/bin/sh
# Vult de sjablonen met de SIP-gegevens en start Asterisk.
set -e

if [ -z "$SIP_HOST" ] || [ -z "$SIP_USER" ] || [ -z "$SIP_PASS" ]; then
  echo "SIP_HOST, SIP_USER en SIP_PASS moeten gezet zijn. Zie asterisk/README.md."
  exit 1
fi

# Het interne containeradres; hierop bindt SIP en ARI, nooit op 0.0.0.0.
# Let op: "hostname -i" geeft hier eerst het IPv6-adres en dan pas IPv4. Het
# eerste veld pakken levert dan een bind als "fd6d:7779:708::f:5060" op, en
# daar struikelt PJSIP over: de transport laadt niet en de registratie faalt.
# Daarom expliciet het IPv4-adres uitfilteren.
BIND_ADDR=$(hostname -i | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1)
if [ -z "$BIND_ADDR" ]; then
  echo "Geen IPv4-adres gevonden voor deze container; SIP kan niet binden."
  exit 1
fi
# Adres waarop de MiVB ons ziet. Binnen hetzelfde netwerk is dat gelijk aan het
# containeradres; staat de centrale buiten het netwerk, zet dan EXTERN_IP.
EXTERN_IP="${EXTERN_IP:-$BIND_ADDR}"
echo "Asterisk bindt op ${BIND_ADDR}, extern adres ${EXTERN_IP}"

mkdir -p /etc/asterisk /var/lib/asterisk/sounds/bot
# De geluidsmap wordt gedeeld met de Social Engine, die in een eigen container
# draait als een gebruiker zonder root. Zonder deze rechten kan die er zijn
# gesproken berichten niet in wegschrijven en komt er geen gesprek tot stand.
chmod 0777 /var/lib/asterisk/sounds/bot
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
