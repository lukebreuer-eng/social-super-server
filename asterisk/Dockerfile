# Asterisk 20 is de LTS-versie. Vastgezet op een bestaande tag: "20-current"
# bestaat niet op Docker Hub en liet de build falen.
FROM andrius/asterisk:20.20.1_debian-trixie

# Asterisk praat met de Social Engine via ARI (REST + websocket). De configs
# worden bij het starten gevuld met de SIP-gegevens uit de omgeving, zodat er
# geen wachtwoorden in de image belanden.
COPY entrypoint.sh /entrypoint.sh
COPY conf/ /etc/asterisk-template/
RUN chmod +x /entrypoint.sh

# Bewust geen EXPOSE: deze container heeft geen inkomende poorten nodig en mag
# in Coolify geen port mapping krijgen. Zie asterisk/conf/pjsip.conf.
ENTRYPOINT ["/entrypoint.sh"]
