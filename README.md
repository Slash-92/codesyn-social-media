# Codesyn Social Media

Repository pubblico gratuito usato esclusivamente per consegnare a Buffer gli
asset Instagram già approvati. I master privati rimangono su Dropbox.

## Configurazione una tantum

1. Abilitare GitHub Pages dalla branch `main`, cartella `/ (root)`.
2. Creare una chiave API personale nelle impostazioni Buffer.
3. Aggiungere nei Secrets del repository:
   - `BUFFER_API_KEY`
   - `BUFFER_CHANNEL_ID`
   - `NOTION_API_TOKEN`
   - `NOTION_DATA_SOURCE_ID`
   - `STATE_ENCRYPTION_KEY`
4. Usare esclusivamente `Notion Buffer sync` come fonte automatica.

Non inserire mai token o password nei file del repository.

## Notion come fonte editoriale

Il workflow `Notion Buffer sync` controlla il piano editoriale Codesyn alle 08:07 e alle 20:07, nel fuso `Europe/Rome`. Una riga entra nella pubblicazione soltanto quando:

- `Brand` è `Codesyn`;
- `Stato` è `Approvato`;
- `Pronto per pubblicazione` è selezionato;
- data, formato, caption e media sono validi.

Il campo `Buffer IDs` è la protezione principale contro i duplicati. Se contiene uno o più ID, il workflow esegue esclusivamente una riconciliazione dello stato e non crea nuovi post. Anche `automation/notion-sync-state.enc.json` conserva una copia cifrata degli ID dopo ogni creazione.

I media e le nuove pubblicazioni senza ID Buffer vengono preparati soltanto quando la data prevista entra nella finestra dei 5 giorni successivi. In questo modo le creatività future non restano pubbliche per settimane prima dell'uscita.

Le righe già marcate `Pubblicato` non vengono più interrogate nelle esecuzioni successive. Se Buffer restituisce il limite temporaneo `429`, il ciclo si ferma al primo rifiuto e riprova alla sincronizzazione seguente senza trasformare tutte le righe restanti in errori.

I file allegati alla proprietà `Media` vengono copiati in `media/notion/<chiave>/`. La prima esecuzione prepara e pubblica i file; una successiva esecuzione verifica gli URL GitHub Pages e programma il contenuto in Buffer. Sono supportati feed singoli, caroselli, Stories e Reel MP4.

Secrets richiesti:

- `NOTION_API_TOKEN` — token di una integrazione Notion con accesso al piano editoriale;
- `NOTION_DATA_SOURCE_ID` — identificatore della sorgente editoriale, conservato come secret;
- `BUFFER_API_KEY`;
- `BUFFER_CHANNEL_ID`;
- `STATE_ENCRYPTION_KEY` — chiave Base64 da 32 byte per cifrare lo stato operativo.

Il workflow interrompe subito l'esecuzione se uno dei Secrets richiesti non è configurato, senza stampare i valori nei log.
