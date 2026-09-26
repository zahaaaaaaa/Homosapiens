# Homosapiens #19053

Site-ul echipei de robotică FIRST Tech Challenge Homosapiens #19053, Colegiul Național „B. P. Hasdeu” Buzău. Rulează pe Cloudflare Workers ([homosapiens.ro](https://homosapiens.ro)) și se publică singur la fiecare push pe `main`.

## Structura

- `public/`: site-ul (pagina, pozele, logo-urile) și pagina de administrare `public/update/`
- `worker/index.js`: API-ul pentru administrare; conținutul editat și pozele încărcate stau într-un Durable Object
- `wrangler.jsonc`: configurarea Worker-ului

Linkuri directe către taburi: `/#echipa`, `/#premii`, `/#despre`, `/#sponsori`, `/#contact`.

## Administrare: homosapiens.ro/update

Acolo se editează:

- **Premii**: sezoanele și premiile.
- **Roboți**: roboții de pe pagina Premii („Evoluția roboților”), cu poză (fundalul alb se scoate automat la încărcare).
- **Echipa**: membrii, cu poze și rol (Software, Hardware, PR), plus butonul pentru cardul „Vrei în echipă?” (pornit doar în perioada de recrutări).
- **Sponsori**: logo-urile.
- **Contact și conturi**: emailul afișat, persoanele de contact cu telefon și conturile bancare (IBAN, titular, bancă).
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

Pentru a reveni la o versiune („revert 2”): fișierele din `public/`, `worker/`, `src/` și `wrangler.jsonc` se readuc din branch-ul `versiunea-1` sau `versiunea-2` și se face push pe `main`. Conținutul salvat din /update rămâne în Durable Object.
