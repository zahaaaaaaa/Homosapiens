# Homosapiens #19053

Site-ul echipei de robotică FIRST Tech Challenge Homosapiens #19053, Colegiul Național „B. P. Hasdeu” Buzău. Rulează pe Cloudflare Workers ([homosapiens.ro](https://homosapiens.ro)) și se publică singur la fiecare push pe `main`.

## Structura

- `public/`: site-ul (pagina, pozele, logo-urile) și pagina de administrare `public/update/`
- `worker/index.js`: API-ul pentru administrare; conținutul editat și pozele încărcate stau într-un Durable Object
- `wrangler.jsonc`: configurarea Worker-ului

Linkuri directe către taburi: `/#echipa`, `/#premii`, `/#despre`, `/#sponsori`, `/#contact`.

## Administrare: homosapiens.ro/update

Acolo se editează premiile (pe sezoane), echipa (cu poze) și sponsorii (cu logo). Ce se salvează apare imediat pe site; fiecare salvare intră în „Istoric” și poate fi restaurată.

Conturile **nu** sunt în acest repo. Ele stau în secretul `ADMIN_USERS` al Worker-ului (Cloudflare → Workers & Pages → homosapiens → Settings → Variables and Secrets), sub forma:

```
utilizator:parola;alt_utilizator:alta_parola
```

sau, mai sigur, cu parole criptate generate la `homosapiens.ro/update/parola/`.
