# YouTube Downloader

## Gebruik met Docker Desktop

1. Installeer en start [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Klik rechtsonder op **Terminal**.
3. Plak deze regel in het terminalvenster en druk op Enter:

   ```bash
   docker pull ghcr.io/pelssersconsultancy/youtubedownloader:latest
   ```

   Je hebt hiervoor geen GitHub-account nodig. Wacht tot het downloaden klaar is en sluit het terminalvenster.

4. Open **Images → Local**, zoek op `youtubedownloader` en klik op **Run**. Open **Optional settings** en stel in:
   - **Port:** host `8080` naar container `80`.
   - **Volumes:** koppel één map op je computer aan containerpad `/app-data`.
5. Klik op **Run** en open [http://localhost:8080](http://localhost:8080).

De applicatie maakt in die map automatisch `config/` en `downloads/` aan. Instellingen, kanalen en metadata komen in `config/`; video’s en ondertitels in `downloads/`. Je hoeft deze twee submappen dus niet zelf aan te maken.

### Voorbeelden van Host path

Koppel in Docker Desktop de volledige hoofdmap aan `/app-data`:

- **macOS:** Host path `/Users/robbypelssers/Movies/youtubedownloader` → Container path `/app-data`
- **Windows:** Host path `C:\Users\<jouw-naam>\Videos\youtubedownloader` → Container path `/app-data`

Vervang op Windows `<jouw-naam>` door je Windows-gebruikersnaam. Maak of selecteer alleen de hoofdmap; de app maakt `config` en `downloads` daarin zelf aan. Als je al de mappen `config` en `downloads` naast elkaar hebt, kies dan hun bovenliggende map als Host path. Gebruik bij een volgende container steeds dezelfde hoofdmap om je gegevens te behouden.

## Image bijwerken

Voer de `docker pull`-regel hierboven opnieuw uit via **Terminal**. Stop en verwijder daarna de oude container en start de image opnieuw met dezelfde poort en mappen.
