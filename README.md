# YouTube Downloader

## Gebruik met Docker Desktop

1. Installeer en start [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Open **Images** en kies **Pull**.
3. Vul deze image in en download hem:

   `ghcr.io/pelssersconsultancy/youtubedownloader:latest`

   Je hebt hiervoor geen GitHub-account nodig.

4. Kies bij de image **Run** en open **Optional settings**. Stel in:
   - **Port:** host `8080` naar container `80`.
   - **Volumes:** koppel een map op je computer aan `/config` en een map aan `/downloads`.
5. Klik op **Run** en open [http://localhost:8080](http://localhost:8080).

De map voor `/config` bewaart je instellingen, kanalen en metadata. In `/downloads` komen de video’s en ondertitels. Gebruik dezelfde mappen als je de container later opnieuw aanmaakt, zodat je gegevens behouden blijven.

## Image bijwerken

Haal in Docker Desktop de nieuwste versie van `ghcr.io/pelssersconsultancy/youtubedownloader:latest` op. Stop en verwijder daarna de oude container en start de image opnieuw met dezelfde poort en mappen.
