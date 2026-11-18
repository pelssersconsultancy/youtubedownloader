# YouTube Downloader

A local video library for importing YouTube channels, syncing selected videos, and searching downloaded videos by metadata and keywords.

## Project layout

- `frontend/` — Angular web application
- `backend/` — NestJS API and download/sync services
- `docs/features/app-features.md` — product requirements and feature notes
- `.claude/agents/collect-metadata.md` — metadata collection agent instructions

## Run locally

Install the dependencies in `backend/` and `frontend/`, then run `./start.sh` from the project folder. The backend uses `http://localhost:3000` and the frontend uses Angular's development server.

Optional DeepL translation can be configured with `DEEPL_AUTH_KEY` in the backend environment. Do not commit real credentials; `backend/.env.example` contains the variable names only.

Application settings and the video catalog are stored in the user's home directory, separate from this project checkout.
