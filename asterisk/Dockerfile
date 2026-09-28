FROM andrius/asterisk:20-current

# Asterisk praat met de Social Engine via ARI (REST + websocket). De configs
# worden bij het starten gevuld met de SIP-gegevens uit de omgeving, zodat er
# geen wachtwoorden in de image belanden.
COPY entrypoint.sh /entrypoint.sh
COPY conf/ /etc/asterisk-template/
RUN chmod +x /entrypoint.sh

EXPOSE 8088/tcp 5060/udp 10000-10100/udp
ENTRYPOINT ["/entrypoint.sh"]
