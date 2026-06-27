# Knowledge Base Schema — Voice AI Vertical (Ijssalons)

**Doel:** één Directus knowledge base voedt drie kanalen (email agent, voice agent, website widget) voor één of meerdere klanten. Klant-eigenaar bewerkt content via Directus admin UI.

**Status:** ontwerp 2026-05-15. Eerste implementatie pilot bij IJs uit de Polder (bedrijf_id 2 of vergelijkbaar in bestaande `Bedrijven` collectie).

## Filosofie

- **Eén bron van waarheid** per bedrijf, alle kanalen lezen ervan
- **Eigenaar kan zelf bijwerken** — geen developer nodig voor menu-wijzigingen, openingstijden, FAQ
- **Multi-tenant vanaf dag 1** — elke collectie heeft `bedrijf` relatie, zodat klant #2-N zonder nieuwe collecties kunnen
- **Hergebruik bestaande `Bedrijven` collectie** — niet duplicate maken

## Collecties — overzicht

| Collectie | Doel | Relatie naar Bedrijf |
|---|---|---|
| `kb_smaken` | Menu / ijssmaken / producten | many-to-one |
| `kb_openingstijden` | Reguliere openingstijden per dag | many-to-one |
| `kb_bijzondere_periodes` | Vakantie, feestdagen, evenementen | many-to-one |
| `kb_locaties` | Vestigingen (1 of meer per bedrijf) | many-to-one |
| `kb_faq` | Veelgestelde vragen + antwoorden | many-to-one |
| `kb_event_types` | Boekbare event-types (kinderfeest, etc.) | many-to-one |
| `kb_brand_voice` | Bot-persoonlijkheid en stijl | one-to-one |
| `agent_logs` | Telemetrie van alle agent-interacties | many-to-one |
| `email_templates` | Standaard antwoord-templates | many-to-one |

Plus uitbreiding op `Bedrijven`:
- `voice_agent_id` (Retell agent ID)
- `email_imap_config` (encrypted JSON)
- `phone_number` (Twilio nummer)
- `cal_com_workspace` (event slug prefix)
- `escalatie_mobiel` (eigenaar mobiel voor urgentie)

## Schema's per collectie

### `kb_smaken`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| naam | string | "Vanille", "Stracciatella" |
| beschrijving | text | korte beschrijving voor klant |
| prijs_per_bolletje | decimal | optioneel, prijs in € |
| categorie | string | "klassiek", "fruit", "speciaal", "vegan" |
| allergenen | csv | "melk,noten,gluten" — multi-select |
| dieet | csv | "vegan,lactose-vrij,suikervrij,glutenvrij" |
| foto | file | optioneel |
| beschikbaar | boolean | of huidig op voorraad / seizoens |
| seizoen_van | date | optioneel |
| seizoen_tot | date | optioneel |
| volgorde | int | display order |

### `kb_openingstijden`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| locatie | m2o → kb_locaties | optioneel (null = alle locaties) |
| dag_van_week | int 0-6 | 0=maandag, 6=zondag |
| open_tijd | time | "12:00" |
| sluit_tijd | time | "21:00" |
| gesloten | boolean | true = die dag dicht |
| opmerking | string | "alleen op afspraak" etc. |

### `kb_bijzondere_periodes`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| start_datum | date | |
| eind_datum | date | |
| type | enum | `gesloten`, `aangepaste_tijden`, `evenement` |
| reden | string | "vakantie", "Koningsdag", "renovatie" |
| open_tijd | time | bij aangepaste_tijden |
| sluit_tijd | time | bij aangepaste_tijden |
| bericht | text | wat agent moet zeggen ("Wij zijn dicht t/m...") |

### `kb_locaties`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| naam | string | "Zeewolde hoofdvestiging" |
| adres | string | "Grootzeil 1" |
| postcode | string | "3891 KH" |
| plaats | string | "Zeewolde" |
| telefoon | string | |
| email | string | |
| parking | string | "gratis parkeren naast deur" |
| rolstoel_toegankelijk | boolean | |
| hond_welkom | boolean | |
| terras | boolean | |
| lat | decimal | optioneel voor maps |
| lng | decimal | optioneel voor maps |

### `kb_faq`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| vraag | text | de vraag zoals klant 'm stelt |
| antwoord | text | letterlijke antwoord (Claude breidt uit indien nodig) |
| categorie | enum | `allergenen`, `openingstijden`, `bestellen`, `events`, `betalen`, `levering`, `overig` |
| kanaal | csv | `email,voice,chat` — welke kanalen tonen dit |
| prioriteit | int 1-10 | sortering in prompt |
| vergelijkbare_vragen | text | trefwoorden voor semantic match |
| laatst_bijgewerkt | datetime | |

### `kb_event_types`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| naam | string | "Kinderfeestje", "Bruiloft", "Bedrijfsuitje" |
| omschrijving | text | wat krijgt klant |
| duur_minuten | int | typische duur |
| min_personen | int | |
| max_personen | int | |
| prijs_basis | decimal | startbedrag |
| prijs_per_persoon | decimal | bovenop basis |
| benodigde_info | text | "naam, datum, aantal personen, dieet-wensen" |
| cal_com_event_slug | string | bv. "kinderfeestje-ijs-polder" |
| beschikbaar | boolean | of nog boekbaar dit seizoen |

### `kb_brand_voice`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | o2o → Bedrijven | unique |
| bot_naam | string | "Sophie", "Lisa", "Eva" |
| tone | enum | `vriendelijk_casual`, `formeel`, `speels`, `professioneel` |
| bedrijf_pitch | text | 200-300 woorden, brand story |
| signature_openingszin | string | "Hallo, je spreekt met Sophie van IJs uit de Polder" |
| signature_afsluiting | string | "Fijne dag verder!" |
| signature_phrases | text | herkenbare uitdrukkingen die bot mag gebruiken |
| taboe_onderwerpen | text | wat NIET te bespreken |
| escalatie_naar_mobiel | string | "+316..." voor urgentie |
| escalatie_triggers | text | "klacht, dringend, brand, ongeluk" |
| taal_voorkeur | enum | `nl`, `nl_en`, `en` |

### `agent_logs`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| kanaal | enum | `email`, `voice`, `chat` |
| timestamp | datetime | |
| klant_identifier | string | email of telefoonnummer (gehashed na 30 dagen) |
| vraag_categorie | string | gematcht uit kb_faq.categorie |
| resolved_by_ai | boolean | of agent zelf afhandelde |
| escalated_to_owner | boolean | of doorgezet naar Luke/Levi |
| sentiment | enum | `positief`, `neutraal`, `negatief`, `gemengd` |
| samenvatting | text | door Claude na afloop |
| duration_seconds | int | voor voice |
| kosten_estimate_cents | int | inkoop-schatting (Retell + LLM + Twilio) |
| metadata | json | platform-specifieke details |

### `email_templates`
| Veld | Type | Notitie |
|---|---|---|
| id | int auto | |
| bedrijf | m2o → Bedrijven | required |
| categorie | enum | `auto_reply_info`, `booking_received`, `booking_confirmed`, `escalated_to_owner`, `fallback` |
| onderwerp | string | template met `{{variabelen}}` |
| body | text | markdown met `{{variabelen}}` |
| taal | enum | `nl`, `en` |
| actief | boolean | |

## Velden toevoegen aan bestaande `Bedrijven`

| Veld | Type | Notitie |
|---|---|---|
| voice_agent_id | string | Retell agent ID |
| voice_phone_number | string | Twilio nummer (E.164) |
| email_address | string | bv. info@ijsuitdepolder.nl |
| email_imap_host | string | "imap.transip.email" |
| email_imap_port | int | 993 |
| email_imap_username | string | |
| email_imap_password | string (encrypted!) | Directus envelope encryption |
| email_smtp_host | string | "smtp.transip.email" |
| email_smtp_port | int | 587 |
| cal_com_workspace_slug | string | "ijs-uit-de-polder" |
| website_domain | string | "ijsuitdepolder.nl" |
| voice_ai_actief | boolean | feature flag |
| email_ai_actief | boolean | feature flag |
| chat_ai_actief | boolean | feature flag |

## Implementatie-stappen (seed-script in `scripts/`)

Volg bestaand patroon van `seed-competitors.ts`, `seed-blog-fields.ts`:

1. `seed-kb-collections.ts` — maakt alle `kb_*` collecties aan in Directus
2. `seed-agent-logs.ts` — agent_logs en email_templates
3. `seed-bedrijven-fields.ts` — voegt nieuwe velden toe aan bestaande Bedrijven collectie
4. `seed-ijs-content.ts` — vult IJs uit de Polder concreet met smaken, openingstijden, FAQ, brand_voice

Tip: gebruik Directus REST API met `DIRECTUS_TOKEN` zoals al in bestaande seed-scripts. Migratie idempotent maken (checks of collectie al bestaat).

## Open ontwerp-vragen voor Luke

1. **Multi-tenant per Directus instance**, of aparte Directus instances per klant? Voorstel: één instance, multi-tenant via `bedrijf` relatie. Veel goedkoper bij schaal.
2. **Email-credentials versleuteling**: Directus heeft envelope encryption. Akkoord met opslaan in DB versleuteld? Alternatief: secret manager (1Password, HashiCorp Vault).
3. **Telemetrie-retention**: agent_logs hoe lang bewaren? AVG → 90 dagen voor klant-identifier, daarna anonimiseren.
4. **Voice agent ID koppeling**: één Retell agent per Bedrijf, of één template-agent met dynamic context-loading? Voorstel: één per Bedrijf (eenvoudiger Retell-side, duurder licentie indien Retell per-agent factureert — checken).

## Volgende sessie — concrete bouwstappen

1. Luke approveert/wijzigt dit schema → ik update doc
2. Ik schrijf `seed-kb-collections.ts` script (volgt patroon `seed-blog-fields.ts`)
3. Luke draait script tegen productie Directus
4. Ik schrijf `seed-ijs-content.ts` met initiële IJs uit de Polder content (Luke vult details aan)
5. Luke vult content via Directus UI
6. Klaar voor email-agent module (volgende fase)
