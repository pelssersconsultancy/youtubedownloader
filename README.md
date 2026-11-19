# YouTube Downloader

## Use with Docker Desktop

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Click **Terminal** in the bottom-right corner.
3. Paste this command into the terminal and press Enter:

   ```bash
   docker pull ghcr.io/pelssersconsultancy/youtubedownloader:latest
   ```

   You do not need a GitHub account. Wait for the download to finish, then close the terminal.

4. Open **Images → Local**, search for `youtubedownloader`, and click **Run**. Open **Optional settings** and set:
   - **Port:** host `8080` to container `80`.
   - **Volumes:** map one folder on your computer to the container path `/app-data`.
5. Click **Run**, then open [http://localhost:8080](http://localhost:8080).

The app automatically creates `config/` and `downloads/` inside that folder. The SQLite database, settings, channels, queues, and video metadata go in `config/`; videos and subtitles go in `downloads/`. You do not need to create these two subfolders yourself.

On first startup with an existing data folder, the app imports its JSON configuration into `config/library.db`. Before importing, it creates a timestamped recovery copy under `config/migration-backups/` and leaves the original files untouched. Older JSON files located directly in the mounted `app-data/` folder are also detected and imported when the new `config/` folder is empty. Startup stops with an error if the import cannot be validated; correct the source data or restore the saved copy before restarting.

### Host path examples

In Docker Desktop, map the main folder on your computer to `/app-data`:

- **macOS:** Host path `/Users/robbypelssers/Movies/youtubedownloader` → Container path `/app-data`
- **Windows:** Host path `C:\Users\<your-username>\Videos\youtubedownloader` → Container path `/app-data`

Create or select only the main folder; the app will create `config` and `downloads` inside it. If you already have `config` and `downloads` folders next to each other, choose their parent folder as the Host path. Use the same main folder whenever you recreate the container to keep your data.

## Update the image

Run the `docker pull` command above using **Terminal**, then stop and remove the old container. Run the updated image with the same port and `/app-data` host-folder mapping. The new container runs any pending database migrations automatically at startup. Each schema upgrade first creates a timestamped copy of the database under `config/migration-backups/`. Pulling the image alone does not run the migration; it runs when you start a container from that image. Keep using the same host folder so the database and downloads persist.
