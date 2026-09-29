# Asterisk-belbot voor de Social Super Server

Belt uit namens IJs uit de Polder en IP Voice Group. Registreert als een gewoon
SIP-toestel op de MiVoice Business, zodat uitgaande gesprekken in de bestaande
routing, nummerweergave en CDR terechtkomen.

## Beveiliging: er staat niets open

Een SIP-poort op een publiek adres wordt binnen minuten gevonden door scanners,
en dan regent het registratiepogingen op de centrale. Dat is hier niet nodig,
want deze Asterisk **registreert uitgaand** en hoeft zelf niets te accepteren.

Daarom:

| | |
|---|---|
| SIP bindt op | het interne containeradres, niet op 0.0.0.0 |
| poorten in Coolify | **geen enkele publiceren** — ook 5060 en 8088 niet |
| wie mag zich als de centrale voordoen | alleen het adres in `SIP_HOST` (`type=identify`) |
| anonieme bellers | geen endpoint voor, dus die krijgen een 401 en komen nergens |
| ARI (poort 8088) | alleen bereikbaar binnen het Docker-netwerk |
| RTP-poorten | 10000-10100 in plaats van de standaard tienduizend |
| bij een verkeerd wachtwoord | tien minuten wachten, zodat de MiVB ons niet blokkeert |

De registratie houdt de NAT-sessie open waarover de centrale terugpraat. Er is
dus geen port mapping nodig, en die moet er ook niet komen.

Staat de MiVoice Business buiten het Docker-netwerk, zet dan `EXTERN_IP` op het
adres waarop de centrale deze server ziet — anders komt de audio niet aan.

## Aanzetten

Maak op de MiVoice Business een SIP-toestel aan (bijvoorbeeld "Bolletje
uitgaand") en zet deze waarden in Coolify:

| variabele | wat het is |
|---|---|
| `SIP_HOST` | IP of FQDN van de MiVoice Business |
| `SIP_USER` | het directory number van het toestel |
| `SIP_PASS` | het SIP-wachtwoord uit de device config |
| `SIP_CALLERID` | nummer dat naar buiten zichtbaar is, bijv. 0880405885 |
| `ARI_PASS` | wachtwoord waarmee de Social Engine Asterisk aanstuurt |
| `EXTERN_IP` | alleen nodig als de centrale buiten het Docker-netwerk staat |

MiVB heeft een vrije **SIP Device**-licentie nodig voor dit toestel.

## Hoe het werkt

1. De Social Engine zet belopdrachten in de wachtrij (collectie `Belopdrachten`).
2. Per opdracht wordt de tekst samengesteld uit actuele data en door TTS gehaald.
3. Asterisk belt, speelt het bestand af en vangt de toets op.
4. De uitkomst gaat terug naar de Social Engine, die er een taak van maakt.

Geen spraakherkenning: een medewerker zit in de auto of op een bouwplaats, en
daar werkt toetsen wel en praten niet.

## Als er tóch inkomend verkeer nodig is

Dat is er niet, maar mocht het ooit moeten: zet dan een firewallregel die alleen
het IP van de MiVoice Business toelaat op 5060, en laat de rest dicht. Nooit
5060 open naar 0.0.0.0/0, ook niet "even voor een test".
