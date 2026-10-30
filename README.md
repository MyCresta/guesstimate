# 🃏 Guesstimate

Simple multiplayer planning poker for estimating developer tasks. Static site on GitHub Pages, real-time sync via Supabase.

## How to play

1. Open the site and click **Create a room**. You're the host 👑
2. Add the tasks you want to estimate in the task list, then share the invite link
3. The host clicks a task to focus it; everyone picks a card, hidden until the host clicks **Reveal cards**
4. Discuss, then the host saves the final estimate (pre-filled with the most common vote) and the next unestimated task is focused automatically, or hits **Re-vote**

Only the host can add, focus and delete tasks, reveal cards and save estimates. If the host leaves, anyone in the room can take over.

Deck: 0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ? (not sure) and ☕ (need a break).

## How it works

- `index.html`, `style.css`, `app.js`: no build step, just static files
- Supabase tables `rooms` and `players` with Realtime enabled, so changes push to every browser instantly
- Players are anonymous: a random ID and name are saved in the browser's localStorage
- Players who close the tab disappear after about a minute (heartbeat every 20s)

The Supabase publishable key in `app.js` is meant to be public; Row Level Security policies control what it can do.

## Hosting

Settings → Pages → Deploy from a branch → `main` / `(root)`.
