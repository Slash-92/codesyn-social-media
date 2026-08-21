# Codesyn Social Media

Repository pubblico gratuito usato esclusivamente per consegnare a Buffer gli
asset Instagram già approvati. I master privati rimangono su Dropbox.

## Configurazione una tantum

1. Abilitare GitHub Pages dalla branch `main`, cartella `/ (root)`.
2. Verificare `publicMediaBaseUrl` in `automation/batch.json`.
3. Creare una chiave API personale nelle impostazioni Buffer.
4. Per trovare l'ID del canale Instagram eseguire localmente:

   ```bash
   BUFFER_API_KEY='...' node automation/buffer-discover.mjs
   ```

5. Aggiungere nei Secrets del repository:
   - `BUFFER_API_KEY`
   - `BUFFER_CHANNEL_ID`
6. Usare `Buffer sync` solo come fallback manuale; la fonte automatica è Notion.

## Verifica dei media senza contattare Buffer

```bash
node automation/buffer-sync.mjs --check-media
```

Il workflow legacy crea le bozze e prova a riempire gli slot Buffer soltanto
quando viene avviato manualmente. Non ha una schedulazione autonoma, così non
entra in concorrenza con Notion.

Non inserire mai token o password nei file del repository.

## Notion come fonte editoriale

Il workflow `Notion Buffer sync` controlla il piano editoriale Codesyn ogni dieci minuti. Una riga entra nella pubblicazione soltanto quando:

- `Brand` è `Codesyn`;
- `Stato` è `Approvato`;
- `Pronto per pubblicazione` è selezionato;
- data, formato, caption e media sono validi.

Il campo `Buffer IDs` è la protezione principale contro i duplicati. Se contiene uno o più ID, il workflow esegue esclusivamente una riconciliazione dello stato e non crea nuovi post. Anche `automation/notion-sync-state.json` conserva gli ID dopo ogni creazione.

I file allegati alla proprietà `Media` vengono copiati in `media/notion/<chiave>/`. La prima esecuzione prepara e pubblica i file; una successiva esecuzione verifica gli URL GitHub Pages e programma il contenuto in Buffer. Sono supportati feed singoli, caroselli, Stories e Reel MP4.

Secrets richiesti:

- `NOTION_API_TOKEN` — token di una integrazione Notion con accesso al piano editoriale;
- `BUFFER_API_KEY`;
- `BUFFER_CHANNEL_ID`.

Se `NOTION_API_TOKEN` non è ancora configurato, il workflow termina senza chiamare Buffer e lascia invariata la programmazione esistente.
