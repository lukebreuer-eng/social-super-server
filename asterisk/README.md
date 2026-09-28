# Asterisk-belbot voor de Social Super Server

Deze container belt uit namens IJs uit de Polder en IP Voice Group. Hij
registreert als een gewoon SIP-toestel op de MiVoice Business, zodat uitgaande
gesprekken in de bestaande routing, nummerweergave en CDR terechtkomen.

## Wat er nog moet gebeuren

Maak op de MiVoice Business een SIP-toestel aan (bijvoorbeeld "Bolletje
uitgaand") en zet deze vier waarden in Coolify:

| variabele | wat het is |
|---|---|
| `SIP_HOST` | IP of FQDN van de MiVoice Business |
| `SIP_USER` | het directory number van het toestel |
| `SIP_PASS` | het SIP-wachtwoord uit de device config |
| `SIP_CALLERID` | nummer dat naar buiten zichtbaar is, bijv. 0880405885 |

Let op: MiVB heeft een vrije **SIP Device**-licentie nodig voor dit toestel.

## Hoe het werkt

1. De Social Engine zet belopdrachten in de wachtrij (collectie `Belopdrachten`).
2. Per opdracht wordt de tekst samengesteld uit actuele data en door TTS gehaald.
3. Asterisk belt, speelt het bestand af en vangt de toets op.
4. De uitkomst gaat terug naar de Social Engine, die er een taak van maakt.

Geen spraakherkenning: een medewerker zit in de auto of op een bouwplaats, en
daar werkt toetsen wel en praten niet.
