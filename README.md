# Homosapiens #19053

Site-ul echipei de robotică FIRST Tech Challenge Homosapiens #19053, Colegiul Național „B. P. Hasdeu” Buzău. Rulează pe Cloudflare Workers ([homosapiens.ro](https://homosapiens.ro)) și se publică singur la fiecare push pe `main`.

## Structura

- `public/`: site-ul (pagina, pozele, logo-urile) și pagina de administrare `public/update/`
- `worker/index.js`: API-ul pentru administrare și pagina `/redirect`; conținutul editat și pozele încărcate stau într-un Durable Object
- `worker/redirect-page.mjs`: șablonul paginii `/redirect`
- `wrangler.jsonc`: configurarea Worker-ului

Linkuri directe către taburi: `/#echipa`, `/#premii`, `/#despre`, `/#sponsori`, `/#contact`.

## homosapiens.ro/redirect și codul QR

`/redirect` e pagina cu toate linkurile echipei (site, Instagram, TikTok, YouTube, Facebook, email, sponsorizare, recrutări), în română sau engleză, după limba telefonului (`?lang=en` / `?lang=ro`). `/links` și `/linkuri` duc tot acolo. Linkurile se schimbă din /update, tabul „Linkuri și QR”; butonul de recrutări apare doar cât timp recrutările sunt pornite.

Codul QR duce la `https://homosapiens.ro/redirect` (corecție de erori H, cu logo-ul în mijloc):

- `public/assets/img/qr-homosapiens.svg`: pentru print, la orice mărime
- `public/assets/img/qr-homosapiens.png`: 2048 × 2048
- `public/assets/img/qr-homosapiens-afis.png`: afiș cu QR, adresa și numele echipei

Codul nu se schimbă când schimbi linkurile, deci ce e deja printat merge în continuare.

## Administrare: homosapiens.ro/update

Acolo se editează:

- **Premii**: sezoanele și premiile.
- **Roboți**: roboții de pe pagina Premii („Evoluția roboților”), cu poză (fundalul alb se scoate automat la încărcare).
- **Echipa**: membrii, cu poze și rol (Software, Hardware, PR), și „Cine e cine în poza de sus”: pe fiecare față din poza mare alegi persoana; pe site, la mouse sau atingere, restul pozei se estompează și apare numele. Tot acolo se poate schimba poza și încadrarea ei pe calculator.
- **Recrutări**: butoanele pentru formularul de înscriere și pentru verificarea rezultatului, mesajul de sus al paginii, lista înscrierilor cu decizia pentru fiecare (În așteptare, Interviu, Acceptat, Respins), un mesaj pentru candidat și tabelul CSV. Fiecare candidat primește un cod `HS-XXXX-XXXX` cu care își vede rezultatul pe homosapiens.ro/#recrutari.
- **Sponsori**: logo-urile.
- **Contact și conturi**: emailul afișat, persoanele de contact cu telefon și conturile bancare (IBAN, titular, bancă).
- **Linkuri și QR**: linkurile de pe homosapiens.ro/redirect, textul de sub numele echipei și codul QR de descărcat.
- **Mesaje**: ce trimit vizitatorii prin formularul de contact.

Ce se salvează apare imediat pe site; fiecare salvare intră în „Istoric” și poate fi restaurată.

Conturile **nu** sunt în acest repo. Ele stau în `ADMIN_USERS` la Worker-ul **homosapienss** (Cloudflare → Workers & Pages → homosapienss → Settings → Variables and Secrets), de tip **Secret**, ca să nu se șteargă la deploy. Forma:

```
utilizator:parola;alt_utilizator:alta_parola
```

Merge și forma criptată `utilizator:pbkdf2$100000$<salt>$<hash>` (PBKDF2-SHA256).

## Formularul de contact

Mesajele din pagina Contact se salvează în Durable Object (le vezi la `/update`, tabul „Mesaje”) și pleacă automat pe `thehomosapiens123@gmail.com` prin legătura `MAILER` (`send_email` în `wrangler.jsonc`). Pentru ca emailul să plece, în Cloudflare trebuie:

1. Email Routing activat pentru domeniul `homosapiens.ro` (se acceptă înregistrările DNS propuse).
2. `thehomosapiens123@gmail.com` adăugată la Email Routing → Destination addresses și confirmată din emailul de verificare.

Din `/update` → „Mesaje” → „Trimite un email de test” se verifică dacă totul e în regulă.

## Versiuni

- `src/Main.dc.html` este sursa paginii (formatul Claude Design); `public/index.html` se generează din ea.
- **Versiunea 1** (înainte de redesign-ul din 26 septembrie 2026): commit `a4bfa82`. Pentru a reveni la ea, fișierele din `public/`, `worker/` și `src/` se readuc din acel commit.
- **Versiunea 2** (26 septembrie 2026): textele din propunerea de parteneriat 2026-2027, harta drumurilor, bugetul, formularul de contact cu trimitere automată pe email. Salvată în branch-ul `versiunea-2` (commit `2df90d6`).
- **Versiunea 3** (26 septembrie 2026): roboții la Premii (cu buton Pornit/Oprit), persoanele de contact cu telefon, conturile bancare, emailul team@homosapiens.ro, rolurile Software/Hardware/PR, cardul de recrutare cu buton în /update, texte din prezentarea 2026. Salvată în branch-ul `versiunea-3`.
- **Versiunea 4** (27 septembrie 2026): Versiunea 3 fără pagina /update/parola. Salvată în branch-ul `versiunea-4` („revert 4”).
- **Versiunea 5** (27 septembrie 2026): recrutările, cu formular de înscriere, cod pentru rezultat și tabul Recrutări în /update.
- **Versiunea 6** (28 septembrie 2026): ecranul de după înscriere refăcut ca un bilet cu codul. Salvată în branch-ul `versiunea-6` („revert 6”, commit `45f1ee3`).
- **Versiunea 7** (29 septembrie 2026): pagina homosapiens.ro/redirect cu linkurile echipei, codul QR și tabul „Linkuri și QR” în /update. Salvată în branch-ul `versiunea-7` („revert 7”, commit `b376d9f`).
- **Versiunea 8** (30 septembrie 2026): poza nouă sus la Echipa, cu „cine e cine” pe fețe; pe prima pagină, creierul animat („Jumătate creier. Jumătate circuit.”), desenat din logo, cu impulsuri de lumină care răspund la mouse și la atingere.

Pentru a reveni la o versiune („revert 2”, „revert 4”, „revert 6”, „revert 7”): fișierele din `public/`, `worker/`, `src/` și `wrangler.jsonc` se readuc din branch-ul `versiunea-N` și se face push pe `main`. Conținutul salvat din /update rămâne în Durable Object.
