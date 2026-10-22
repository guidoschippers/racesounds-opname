# Racesounds opname

Webapp (PWA) om met je telefoon motorgeluiden van echte auto's op te nemen, per toerental, als
bronmateriaal voor Racesounds (synthetische motorgeluiden). Werkt offline. Alles blijft op de telefoon
(IndexedDB) tot je een motor exporteert als zip.

- Motorlijst: naam, merk/model/bouwjaar, motorcode, cilinders, opbouw, inhoud, brandstof, turbo,
  stationair, begrenzer, notities, en de lijst met toerentallen (standaard stationair, 1500 … 5500).
- Per microfoonpositie (zijkant motorkap, uitlaat, interieur, onboard) de opnames:
  stilte (motor uit, 5 s), constant toerental (min. 8 s, stopt na 12 s), gas los (~4000 →
  stationair) en rustig optrekken (stationair → ~5000 in 5 s). Status per item: nog niet /
  opgenomen / opnieuw.
- Begeleide opname: aftellen, timer, "LOS!"/"GAS!" in beeld, niveaumeter met waarschuwing bij
  oversturing en te zacht signaal, terugluisteren, opnieuw opnemen.
- Toerentalcontrole: schat live het toerental uit het geluid en toont de afwijking t.o.v. het doel.
  Bewaart zowel het afgelezen als het geschatte toerental.
- Ruwe audio: echo-onderdrukking, ruisonderdrukking en automatische versterking uit; WAV, PCM
  24-bit mono, standaard 44-byte header, native samplerate (meestal 48 kHz). Geen MP3/AAC.

## Installeren (Android, Chrome)

De microfoon werkt in de browser alleen via https. De app moet dus gehost worden, bijvoorbeeld op
GitHub Pages (dat staat nog niet online; zie "Publiceren").

1. Open de app-URL in Chrome op de telefoon.
2. Menu (⋮) → **App installeren** (of **Toevoegen aan startscherm**).
3. Open de app via het icoon op het beginscherm. Bij de eerste opname vraagt hij om de microfoon:
   **Toestaan**.

Na het eerste bezoek werkt de app ook zonder internet.

## Gebruik

1. **+ Nieuwe motor**: vul de gegevens in. Het aantal cilinders is belangrijk voor de
   toerentalschatting (ontstekingsfrequentie = cilinders/2 × rpm/60; bij een 4-cilinder rpm/30).
2. Kies de **positie** (tabbladen) en tik op **Begeleide opname starten**. De app loopt de lijst af:
   eerst 5 s stilte met de motor uit, dan elk toerental, gas los en optrekken.
3. Per opname: breng het toerental op het doel en kijk naar **Geschat uit geluid**. Groen = binnen
   5%. De schatting is betrouwbaarder dan de toerenteller: bij de vorige opnames weken de
   afgelezen waarden tot 35% af (afgelezen 1800 → echt ~2380).
4. **Start opname** → 3 s aftellen → opname. Na afloop: terugluisteren, controleren op
   waarschuwingen, het afgelezen toerental invullen en **Bewaren** (of **Opnieuw opnemen**).
5. In de motorlijst kun je opnames afspelen, als **Opnieuw** markeren of verwijderen.

Tips (staan ook in de app): telefoon vastleggen, niet vasthouden; windkapje of sok over de
microfoon; airco, blower en radio uit; warme motor; stille plek zonder laders of stroomkabels in
de buurt (50 Hz-brom).

## Exporteren naar OneDrive

Onderaan het motorscherm staat **Zip opslaan**. De zip bevat één map `<motornaam>/` met:

- de WAV's: `<positie>_<soort>_<rpm>rpm[_n].wav`, bv. `motorkap_constant_2500rpm.wav`,
  `motorkap_gaslos_4000rpm.wav`, `motorkap_stilte.wav` (een tweede opname van hetzelfde krijgt `_2`);
- `motor.json` met de motorgegevens;
- `manifest.json` met per opname: bestand, soort, positie, doel-, ingevoerd en geschat rpm
  (+ zekerheid, spreiding en het verloop per 0,25 s), duur, piek- en rms-niveau, aantal geclipte
  samples, samplerate, bitdiepte, datum/tijd, notities.

Chrome deelt via de deelknop alleen bepaalde bestandstypes (audio, beeld, pdf, tekst), en zip hoort
daar niet bij. De route is daarom:

1. **Zip opslaan** (de zip komt in Downloads);
2. open de OneDrive-app en ga naar `Racesounds/opnames/`;
3. **+ → Uploaden → Downloads** en kies de zip.

Op de pc staat hij dan in `D:\Skydrive\Racesounds\opnames\`. Als een browser het delen van een zip
wel ondersteunt, toont de app automatisch ook de knop **Zip delen**.

## Controleren met Racesounds

```bash
racesounds-cli --analyze-file motorkap_constant_2500rpm.wav --cyl 4
racesounds-cli --compare motorkap_constant_2500rpm.wav --rpm <geschat> --preset presets/I4_2000_Skoda.json --mic motorkap
```

## Ontwikkelen

Geen build-stap en geen dependencies: gewone ES-modules.

```bash
npm test             # unit- en integratietests (Node 20+)
npm run serve        # http://localhost:8080/ (localhost telt als veilig: microfoon werkt)
npm run icons        # iconen opnieuw maken
```

- `http://localhost:8080/?bron=synth&synthfactor=1.3`: testbron in plaats van de microfoon
  (synthetische motor op 1,3 × het doeltoerental), handig zonder auto.
- `node tools/estimate.mjs opname.wav [cilinders] [stationair] [begrenzer]`: toerentalschatting op een
  bestaand WAV-bestand.
- De test `tests/racesounds-cli.test.mjs` pakt een geëxporteerde zip uit en laat
  `racesounds-cli --analyze-file` de WAV lezen (pad via `RACESOUNDS_CLI`, standaard
  `C:/repos/Racesounds/build/bin/Release/racesounds-cli.exe`; anders overgeslagen).
- Na een wijziging: verhoog `VERSION` in `sw.js` (anders blijft de oude versie in de cache).

| Bestand | Inhoud |
| --- | --- |
| `js/app.js` | schermen, navigatie, opnameprotocol |
| `js/recorder.js`, `js/capture-worklet.js` | microfoon (ruw) → AudioWorklet → samples; testbron |
| `js/rpm.js` | toerentalschatting |
| `js/wav.js` | WAV schrijven/lezen, niveaus |
| `js/export.js`, `js/zip.js` | bestandsnamen, `motor.json`, `manifest.json`, zip |
| `js/model.js` | motor, soorten, posities, opnamelijst, status |
| `js/db.js` | IndexedDB |
| `js/synth.js` | synthetisch motorsignaal (tests en testbron) |

### Toerentalschatting

1. Decimeren naar ≥4 kHz (Butterworth-laagdoorlaat).
2. Spectrum per fragment (0,5 s; live 1 s), wortel-gecomprimeerd t.o.v. de mediaan (ruisvloer).
3. Harmonische kam over de ontstekingsfrequentie: score = Σ(niveau op h·f) − ½·Σ(niveau op
   (h−½)·f) voor h = 1..8. Een vast aantal harmonischen met straf ertussen voorkomt dat f/2 wint.
4. Ongelijke cilinders geven sterke halve orden, waardoor de kam op de cyclusfrequentie (rpm/120)
   kan uitkomen. Daarom wordt ook j·f gecontroleerd (j = deler van het aantal cilinders): domineren
   de harmonischen van j·f in vermogen (>11 dB), dan is j·f de ontstekingsfrequentie.
5. Opname: mediaan over de betrouwbare fragmenten. Zekerheid = (beste score − mediaan van alle
   scores) / beste score; onder 0,55 telt een fragment niet mee.

Afgestemd en gecontroleerd op de drie eerdere Skoda-opnames (790 / 2360 / 3806 tpm) en op
synthetische 3- tot 12-cilinders, ook met 50 Hz-brom.

## Publiceren (GitHub Pages)

Nog niet gedaan. Als je akkoord bent: een repository aanmaken, `main` pushen en in de
repository-instellingen Pages inschakelen (branch `main`, map `/`). De app gebruikt alleen relatieve
paden, dus hij werkt ook onder `https://<gebruiker>.github.io/racesounds-opname/`.
