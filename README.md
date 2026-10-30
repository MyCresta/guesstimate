# 🃏 Guesstimate

Simple multiplayer planning poker for estimating developer tasks. Static site on GitHub Pages, real-time sync via Supabase.

## How to play

1. Open the site and click **Create a room**
2. Share the invite link with your team
3. Everyone picks a card; votes stay hidden until someone clicks **Reveal cards**
4. Discuss, then click **New round** for the next task

Deck: 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ? (not sure) and ☕ (need a break).

## How it works

- `index.html`, `style.css`, `app.js`: no build step, just static files
- Supabase tables `rooms` and `players` with Realtime enabled, so changes push to every browser instantly
- Players are anonymous: a random ID and name are saved in the browser's localStorage
- Players who close the tab disappear after about a minute (heartbeat every 20s)

The Supabase publishable key in `app.js` is meant to be public; Row Level Security policies control what it can do.

## Hosting

Settings → Pages → Deploy from a branch → `main` / `(root)`.
