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
6. Avviare manualmente il workflow `Buffer sync` la prima volta.

## Verifica dei media senza contattare Buffer

```bash
node automation/buffer-sync.mjs --check-media
```

Il workflow crea tutte le bozze, programma quelle accettate dal piano gratuito
di Buffer e riprova ogni mattina quelle rimaste fuori dalla coda.

Non inserire mai token o password nei file del repository.
