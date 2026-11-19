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
   - **Volumes:** koppel een map op je computer aan `/config` en een map aan `/downloads`.
5. Klik op **Run** en open [http://localhost:8080](http://localhost:8080).

De map voor `/config` bewaart je instellingen, kanalen en metadata. In `/downloads` komen de video’s en ondertitels. Gebruik dezelfde mappen als je de container later opnieuw aanmaakt, zodat je gegevens behouden blijven.

## Image bijwerken

Voer de `docker pull`-regel hierboven opnieuw uit via **Terminal**. Stop en verwijder daarna de oude container en start de image opnieuw met dezelfde poort en mappen.
