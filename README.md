# YouTube Downloader

A local video library for importing YouTube channels, syncing selected videos, and searching downloaded videos by metadata and keywords.

## Project layout

- `frontend/` — Angular web application
- `backend/` — NestJS API and download/sync services
- `docs/features/app-features.md` — product requirements and feature notes
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
