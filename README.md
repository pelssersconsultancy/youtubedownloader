# YouTube Downloader

A local video library for importing YouTube channels, syncing selected videos, and searching downloaded videos by metadata and keywords. Available English and Dutch subtitles are fetched in a separate queue and selected automatically to match the app language.

## Project layout

- `frontend/` — Angular web application
- `backend/` — NestJS API and download/sync services
- `docs/features/app-features.md` — product requirements and feature notes
- `docs/skills/survival-skills.md` and `docs/skills/suggestions.json` — self-reliance skills guide and verified channel suggestions
- `.claude/agents/collect-metadata.md` — metadata collection agent instructions

## Prerequisites

Install these tools before building or running the application:

- **Git** to clone the repository.
- **Node.js 24 LTS**, which includes npm. Angular 21 supports Node 24; this project uses Angular 21 in the frontend and Node 24 type definitions in the backend. Install it from [nodejs.org](https://nodejs.org/en/download/).
- **pnpm** for the backend dependencies. Install it with `npm install --global pnpm`.
- **yt-dlp**, available on your `PATH`, for scanning channels and downloading videos. Follow the [official installation instructions](https://github.com/yt-dlp/yt-dlp/wiki/Installation).
- **FFmpeg and ffprobe**, available on your `PATH`, to merge the separate video and audio streams into MP4 files. See [ffmpeg.org](https://ffmpeg.org/download.html).
- **A supported browser** (Chrome, Chromium, Firefox, Safari, Edge, Brave, Opera, Vivaldi or Whale). The app reads YouTube cookies from the browser selected in Settings. Sign in to YouTube there if you want to use your account cookies.

An internet connection is needed to scan YouTube and download videos. The first time you open the app, choose a folder for the video library in Settings.

## Install dependencies

Clone the repository, then install each app's dependencies using the package manager for that folder:

```bash
git clone https://github.com/pelssersconsultancy/youtubedownloader.git
cd youtubedownloader

cd backend
pnpm install --frozen-lockfile

cd ../frontend
npm ci

cd ..
```

## Build

```bash
cd backend
pnpm run build

cd ../frontend
npm run build
```

## Start the apps

On macOS or Linux, start both development servers from the project folder:

```bash
./start.sh
```

Open the frontend at [http://localhost:4200](http://localhost:4200). The backend API is at [http://localhost:3000/api](http://localhost:3000/api).

On Windows, run these commands in separate terminals (or run `start.sh` from WSL or Git Bash):

```powershell
# Terminal 1
cd backend
pnpm run start:dev
```

```powershell
# Terminal 2
cd frontend
npm start
```

Optional DeepL translation can be configured with `DEEPL_AUTH_KEY` in the backend environment. Do not commit real credentials; `backend/.env.example` contains the variable names only.

Application settings and the video catalog are stored in the user's home directory, separate from this project checkout.

## Run with Docker

Install Docker Desktop, then run these commands from the project folder:

```bash
docker compose up --build -d
```

Open [http://localhost:8080](http://localhost:8080). The first build may take a few minutes. To stop the app, run `docker compose down` from the same folder.

Docker stores persistent data in two folders beside `docker-compose.yml`:

- `docker-data/` contains app settings, channel bookmarks, video metadata, queues and logs.
- `downloads/` contains downloaded videos and subtitles by default. To reuse a video folder from the old setup, set `VIDEO_LIBRARY_DIR` in the root `.env` file to its full host path (for example, `/Users/your-name/Movies/youtube`).

Both folders are excluded from Git. Keep them to preserve the library across updates; back them up to preserve your data. Set `APP_PORT` in a root `.env` file to change the web address port. In the app's storage setting, use `/downloads` or a subfolder of it so the files stay on the host computer; `VIDEO_LIBRARY_DIR` controls which host folder is mounted there.

### YouTube account cookies in Docker

Containers cannot read cookies from a browser installed on the host computer. The Docker setup therefore does not try to read browser cookies. If a download requires your signed-in YouTube session, export cookies in Netscape format to `cookies.txt` in the project folder, then start the app with the additional Compose file:

```bash
docker compose -f docker-compose.yml -f docker-compose.cookies.yml up --build -d
```

The cookie file is mounted read-only and ignored by Git. Treat it like a password: do not share it, and remove it when you no longer need it. Without this optional file, public videos can still be scanned and downloaded. In Docker, the browser selector in Settings is not used; the cookie file is the supported way to authenticate.

To rebuild after updating the project, run `docker compose up --build -d` again. The persistent folders remain in place.
