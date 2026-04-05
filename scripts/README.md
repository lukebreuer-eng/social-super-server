# Seed Scripts — Implementatie Instructies

## Vereisten

- Node.js 20+
- `.env` bestand in de root van het project met:
  ```
  DIRECTUS_URL=https://social.ipaudio.nl
  DIRECTUS_TOKEN=<jouw-directus-token>
  ```
- `npm install` moet uitgevoerd zijn (voor dependencies)

## Stap-voor-stap

### 1. Check je .env

Open je terminal en ga naar de project directory:

```bash
cd ~/Documents/Claude/Projects/social-super-server
```

Controleer dat `.env` bestaat en de juiste waarden heeft:

```bash
cat .env | grep DIRECTUS
```

Je moet zien:
```
DIRECTUS_URL=https://social.ipaudio.nl
DIRECTUS_TOKEN=<jouw-token>
```

### 2. Competitors IP Voice Group seeden

Dit script maakt 8 concurrenten aan voor IP Voice Group (of update ze als ze al bestaan):

```bash
npx tsx scripts/seed-competitors.ts
```

**Verwachte output:**
```
Directus: https://social.ipaudio.nl
IP Voice Group ID: 1

Seeding competitors...

  Esprit ICT — created (ID: 10)
  Voys — created (ID: 11)
  Hallo — created (ID: 12)
  ...

Done!
```

### 3. Competitors IJs uit de Polder seeden

Dit script maakt 5 concurrenten aan voor IJs uit de Polder:

```bash
npx tsx scripts/seed-competitors-ijs.ts
```

### 4. Competitors IP Voice Shop seeden

Dit script maakt 5 concurrenten aan voor IP Voice Shop:

```bash
npx tsx scripts/seed-competitors-shop.ts
```

### 5. Blog velden toevoegen aan Directus

Dit script voegt blog-gerelateerde velden toe aan de Posts collectie en notification_email aan Bedrijven:

```bash
npx tsx scripts/seed-blog-fields.ts
```

**Na dit script:** volg de handmatige stappen die het script print (WordPress Application Password aanmaken).

### 6. Bedrijven seeden (als dat nog niet is gebeurd)

Als de 3 bedrijven nog niet in Directus staan:

```bash
npx tsx scripts/seed-bedrijven.ts
```

**Let op:** dit script maakt nieuwe bedrijven aan. Als ze al bestaan krijg je een duplicate error — dat is normaal, het bestaande record blijft intact.

## Volgorde

De aanbevolen volgorde is:

1. `seed-bedrijven.ts` (eerst bedrijven, want competitors verwijzen ernaar)
2. `seed-blog-fields.ts` (voegt velden toe aan bestaande collecties)
3. `seed-competitors.ts` (IP Voice Group concurrenten)
4. `seed-competitors-ijs.ts` (IJs uit de Polder concurrenten)
5. `seed-competitors-shop.ts` (IP Voice Shop concurrenten)

## Alle 5 in één keer

```bash
cd ~/Documents/Claude/Projects/social-super-server
npx tsx scripts/seed-bedrijven.ts && \
npx tsx scripts/seed-blog-fields.ts && \
npx tsx scripts/seed-competitors.ts && \
npx tsx scripts/seed-competitors-ijs.ts && \
npx tsx scripts/seed-competitors-shop.ts
```

## Problemen?

- **"Missing DIRECTUS_URL or DIRECTUS_TOKEN"** → check je .env bestand
- **"not found in Bedrijven"** → run eerst seed-bedrijven.ts
- **"failed: 403"** → Directus token heeft geen schrijfrechten, check de token permissions
- **"already exists, updating..."** → normaal, het script update bestaande records
