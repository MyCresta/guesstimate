import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Public, client-side Supabase settings (the publishable key is safe to expose;
// access is controlled by Row Level Security in the database).
const SUPABASE_URL = 'https://qvboidhwptpiduruiyfb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vlH6f9yVTWmnkU8-7b_q1g_Wtz4tKf1';

const DEFAULT_DECK = ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'];
const MAX_CARD_LEN = 6;
const HEARTBEAT_MS = 20_000;   // how often we tell others we're still here
const STALE_MS = 70_000;       // players not seen for this long are hidden

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');
const topbarRight = document.getElementById('topbar-right');

// ---------- identity (per browser) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
let myId = store.get('gp.id');
if (!myId) { myId = uuid(); store.set('gp.id', myId); }
let myName = store.get('gp.name') || '';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const tpl = (id) => document.getElementById(id).content.cloneNode(true);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date().toISOString();

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

function newRoomCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function cardValue(v) {
  if (v === '½') return 0.5;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// Cards that mean "no estimate" and are skipped when suggesting one.
const isNonVote = (v) => v === '?' || v === '☕';

// Suggest a final estimate: the most common vote (ties go to the higher card),
// or, if everyone voted differently, the numeric card closest to the average.
function suggestEstimate(votes, deck) {
  const real = votes.filter((v) => !isNonVote(v));
  if (!real.length) return deck.find((d) => !isNonVote(d)) ?? deck[0];
  const counts = new Map();
  for (const v of real) counts.set(v, (counts.get(v) || 0) + 1);
  const top = Math.max(...counts.values());
  const byValueDesc = (a, b) => (cardValue(b) ?? deck.indexOf(b)) - (cardValue(a) ?? deck.indexOf(a));
  const modes = [...counts].filter(([, c]) => c === top).map(([v]) => v).sort(byValueDesc);
  const numericDeck = deck.filter((d) => cardValue(d) !== null);
  const nums = real.map(cardValue).filter((n) => n !== null);
  if ((modes.length === 1 || top > 1) || !nums.length || !numericDeck.length) return modes[0];
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return numericDeck.reduce((best, d) => (Math.abs(cardValue(d) - avg) < Math.abs(cardValue(best) - avg) ? d : best));
}

// "1, 2, 4, XL, ☕" -> ['1','2','4','XL','☕']
function parseDeck(text) {
  const cards = [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))];
  if (cards.length < 2) return { error: 'Add at least two cards' };
  if (cards.length > 30) return { error: 'Max 30 cards' };
  const tooLong = cards.find((c) => [...c].length > MAX_CARD_LEN);
  if (tooLong) return { error: `“${tooLong}” is too long (max ${MAX_CARD_LEN} characters)` };
  return { cards };
}

// Each player's deck is consistently red- or blue-backed, like two decks at a real table.
function backColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h & 1 ? 'back-blue' : 'back-red';
}

// Markup for a face-up playing card.
function cardFace(v, extra = '') {
  const len = [...v].length;
  return `<div class="pcard face ${extra}" data-len="${len}"><span class="idx tl">${esc(v)}</span><span class="val">${esc(v)}</span><span class="idx br">${esc(v)}</span></div>`;
}

// ---------- routing ----------
function currentRoom() {
  const code = location.hash.replace(/^#\/?/, '').toLowerCase();
  return /^[a-z0-9]{4,12}$/.test(code) ? code : null;
}


function route() {
  leaveRoom();
  const code = currentRoom();
  if (!code) return renderHome();
  if (!myName) return renderNameGate(code);
  enterRoom(code);
}

// ---------- home ----------
function renderHome() {
  topbarRight.innerHTML = '';
  app.replaceChildren(tpl('tpl-home'));

  $('#create-room').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const code = newRoomCode();
    const { error } = await sb.from('rooms').insert({ id: code, host_id: myId });
    if (error) { e.target.disabled = false; return toast('Could not create room: ' + error.message); }
    location.hash = code;
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toLowerCase().replace(/.*#/, '');
    if (!/^[a-z0-9]{4,12}$/.test(code)) return toast('That code doesn’t look right');
    location.hash = code;
  });
}

// ---------- name gate ----------
function renderNameGate(code) {
  topbarRight.innerHTML = '';
  app.replaceChildren(tpl('tpl-name'));
  const input = $('#name-input');
  input.value = myName;
  input.focus();
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    myName = name;
    store.set('gp.name', name);
    if (code) { leaveRoom(); enterRoom(code); } else route();
  });
}

// ---------- room state ----------
let room = null;     // { id, host_id, current_task_id, revealed }
let players = [];    // players shown at the table
let allPlayers = []; // every player row in this room, including ones who left
let presence = null; // Map of player id -> { away } from live presence; null until first sync
let tasks = [];      // tasks in this room, in order
let channel = null;
let timers = [];

const isHost = () => !!room && room.host_id === myId;
const currentTask = () => tasks.find((t) => t.id === room?.current_task_id) || null;
const hostPresent = () => players.some((p) => p.id === room?.host_id);
const deck = () => (room?.deck?.length ? room.deck : DEFAULT_DECK);

function leaveRoom() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  timers.forEach(clearInterval);
  timers = [];
  room = null;
  players = [];
  allPlayers = [];
  presence = null;
  tasks = [];
}

async function enterRoom(code) {
  app.innerHTML = '<p class="muted center">Joining room…</p>';

  let { data, error } = await sb.from('rooms').select('*').eq('id', code).maybeSingle();
  if (error) return fail('Couldn’t load room', error);
  if (!data) {
    // Opened a link to a room that doesn't exist yet: create it, and you're the host.
    const ins = await sb.from('rooms').insert({ id: code, host_id: myId }).select().single();
    if (ins.error) return fail('Couldn’t open room', ins.error);
    data = ins.data;
  } else if (!data.host_id) {
    const upd = await sb.from('rooms').update({ host_id: myId }).eq('id', code).is('host_id', null).select().maybeSingle();
    if (upd.data) data = upd.data;
  }
  // The host closed this room and opened a new one: follow everyone there.
  if (data.moved_to) { location.hash = data.moved_to; return; }
  room = data;

  const join = await sb.from('players').upsert({ id: myId, room_id: code, name: myName, vote: null, last_seen: now() });
  if (join.error) return fail('Couldn’t join', join.error);

  renderRoomShell();
  await Promise.all([loadPlayers(), loadTasks()]);

  channel = sb.channel('room-' + code, { config: { broadcast: { self: false }, presence: { key: myId } } })
    .on('broadcast', { event: 'throw' }, ({ payload }) => throwCard(payload))
    // Live presence: someone closing their tab disappears within seconds.
    .on('presence', { event: 'sync' }, onPresenceSync)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${code}` }, loadPlayers)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `room_id=eq.${code}` }, loadTasks)
    // Delete events can't be filtered by room, so refresh on any task delete.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, loadTasks)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${code}` }, (p) => {
      const prev = room;
      room = p.new;
      if (room.moved_to) {
        toast('The host started a new room');
        location.hash = room.moved_to;
        return;
      }
      // New task focused, re-vote or new deck: votes were cleared, so re-read them.
      const deckChanged = String(prev.deck) !== String(room.deck);
      if (prev.current_task_id !== room.current_task_id || (prev.revealed && !room.revealed) || deckChanged) loadPlayers();
      renderAll();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') trackMe(); });

  timers.push(setInterval(heartbeat, HEARTBEAT_MS));
  timers.push(setInterval(loadPlayers, 15_000)); // fallback + hides players who left
}

function fail(msg, error) {
  app.innerHTML = `<p class="center">${esc(msg)}: ${esc(error.message)}</p>`;
}

async function heartbeat() {
  if (!room) return;
  await sb.from('players').update({ last_seen: now(), room_id: room.id, name: myName }).eq('id', myId);
}
// Tell the room whether we're here or away (tab in the background).
function trackMe() {
  channel?.track({ id: myId, away: document.hidden }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (!room) return;
  trackMe();
  if (!document.hidden) { heartbeat(); loadPlayers(); }
});
// Leave right away when the tab closes, instead of waiting for a timeout.
addEventListener('pagehide', () => { channel?.untrack().catch(() => {}); });

function onPresenceSync() {
  if (!channel) return;
  const state = channel.presenceState();
  presence = new Map();
  for (const [id, metas] of Object.entries(state)) {
    // Same person in several tabs counts as away only if every tab is.
    presence.set(id, { away: metas.every((m) => m.away) });
  }
  // Someone new showed up before their row reached us: fetch it.
  if ([...presence.keys()].some((id) => !allPlayers.some((p) => p.id === id))) loadPlayers();
  else { computePlayers(); renderAll(); }
}

function computePlayers() {
  if (presence) {
    players = allPlayers.filter((p) => p.id === myId || presence.has(p.id));
    players.forEach((p) => { p.away = p.id === myId ? document.hidden : !!presence.get(p.id)?.away; });
  } else {
    // Before presence has synced, fall back to "seen recently".
    const cutoff = Date.now() - STALE_MS;
    players = allPlayers.filter((p) => p.id === myId || new Date(p.last_seen).getTime() > cutoff);
  }
}

async function loadPlayers() {
  if (!room) return;
  const { data, error } = await sb.from('players').select('*').eq('room_id', room.id).order('created_at');
  if (error || !room) return;
  allPlayers = data;
  computePlayers();
  renderAll();
}

async function loadTasks() {
  if (!room) return;
  const { data, error } = await sb.from('tasks').select('*').eq('room_id', room.id).order('position').order('created_at');
  if (error || !room) return;
  tasks = data;
  renderAll();
}

// ---------- actions ----------
async function vote(v) {
  if (!room || room.revealed) return;
  const me = players.find((p) => p.id === myId);
  const next = me?.vote === v ? null : v; // tap again to take it back
  if (me) me.vote = next;
  renderAll();
  await sb.from('players').update({ vote: next, last_seen: now() }).eq('id', myId);
}

async function clearVotes() {
  players.forEach((p) => { p.vote = null; });
  await sb.from('players').update({ vote: null }).eq('room_id', room.id);
}

// Host only
async function reveal() {
  if (!isHost()) return;
  room.revealed = true; renderAll();
  await sb.from('rooms').update({ revealed: true, updated_at: now() }).eq('id', room.id);
}

async function revote() {
  if (!isHost()) return;
  room.revealed = false;
  await clearVotes();
  renderAll();
  await sb.from('rooms').update({ revealed: false, updated_at: now() }).eq('id', room.id);
}

async function focusTask(taskId) {
  if (!isHost()) return;
  room.current_task_id = taskId;
  room.revealed = false;
  await clearVotes();
  renderAll();
  await sb.from('rooms').update({ current_task_id: taskId, revealed: false, updated_at: now() }).eq('id', room.id);
}

async function addTask(title) {
  if (!isHost()) return;
  const { data, error } = await sb.from('tasks')
    .insert({ room_id: room.id, title, position: Date.now() / 1000 }).select().single();
  if (error) return toast('Couldn’t add task: ' + error.message);
  tasks.push(data);
  renderAll();
  if (!room.current_task_id) focusTask(data.id);
}

async function deleteTask(taskId) {
  if (!isHost()) return;
  const t = tasks.find((x) => x.id === taskId);
  if (!t || !confirm(`Delete “${t.title}”?`)) return;
  tasks = tasks.filter((x) => x.id !== taskId);
  if (room.current_task_id === taskId) room.current_task_id = null;
  renderAll();
  await sb.from('tasks').delete().eq('id', taskId);
}

async function saveEstimate(value) {
  if (!isHost()) return;
  const cur = currentTask();
  if (!cur) return;
  cur.estimate = value;
  await sb.from('tasks').update({ estimate: value }).eq('id', cur.id);
  // Move on to the next task without an estimate (after this one, then from the top).
  const idx = tasks.indexOf(cur);
  const next = [...tasks.slice(idx + 1), ...tasks.slice(0, idx)].find((t) => !t.estimate);
  if (next) { await focusTask(next.id); toast(`Saved ${value} · next up: ${next.title}`); }
  else { await focusTask(null); toast('All tasks estimated 🎉'); }
}

async function takeOverHost() {
  room.host_id = myId; renderAll();
  await sb.from('rooms').update({ host_id: myId, updated_at: now() }).eq('id', room.id);
  toast('You’re now the host');
}

// Host: close this room and move everyone to a fresh one (same cards, no tasks).
async function startNewRoom() {
  if (!isHost()) return;
  if (!confirm('Close this room and move everyone to a new one?')) return;
  const code = newRoomCode();
  const { error } = await sb.from('rooms').insert({ id: code, host_id: myId, deck: room.deck });
  if (error) return toast('Couldn’t create room: ' + error.message);
  await sb.from('rooms').update({ moved_to: code, updated_at: now() }).eq('id', room.id);
  location.hash = code;
}

async function saveDeck(text) {
  if (!isHost()) return;
  const { cards, error } = parseDeck(text);
  if (error) return toast(error);
  if (String(cards) === String(deck())) return;
  room.deck = cards;
  room.revealed = false;
  await clearVotes();
  renderAll();
  const { error: err } = await sb.from('rooms').update({ deck: cards, revealed: false, updated_at: now() }).eq('id', room.id);
  toast(err ? 'Couldn’t save cards: ' + err.message : 'Cards updated');
}

// ---------- card throwing ----------
const SUITS = [['♠', '#1b1a2e'], ['♥', '#e8432f'], ['♦', '#e8432f'], ['♣', '#1b1a2e']];
let lastThrow = 0;

function sendThrow(targetId) {
  if (!channel || targetId === myId) return;
  const t = performance.now();
  if (t - lastThrow < 180) return; // a little rate limit
  lastThrow = t;
  const payload = { from: myId, to: targetId, suit: Math.floor(Math.random() * SUITS.length) };
  throwCard(payload);
  channel.send({ type: 'broadcast', event: 'throw', payload });
}

function aceSvg(suitIdx) {
  const [s, c] = SUITS[suitIdx % SUITS.length] || SUITS[0];
  return `<svg viewBox="0 0 50 70" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="1.5" y="1.5" width="47" height="67" rx="6" fill="#fff8e8" stroke="#1b1a2e" stroke-width="3"/>
    <text x="7" y="17" font-family="Fraunces, Georgia, serif" font-weight="900" font-size="14" fill="${c}">A</text>
    <text x="25" y="46" text-anchor="middle" font-size="28" fill="${c}">${s}</text>
    <text x="43" y="53" font-family="Fraunces, Georgia, serif" font-weight="900" font-size="14" fill="${c}" transform="rotate(180 43 53)" text-anchor="middle">A</text>
  </svg>`;
}

function seatCenter(playerId) {
  const el = document.querySelector(`.player[data-id="${CSS.escape(playerId)}"] .pcard`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// A random point just outside one of the screen edges, far enough from the target.
function offscreenStart(end, rand) {
  const m = 70; // how far outside the viewport the card starts
  let best = null;
  for (let i = 0; i < 6; i++) {
    const side = Math.floor(Math.random() * 4);
    const p = side === 0 ? { x: rand(0, innerWidth), y: -m }                // top
      : side === 1 ? { x: innerWidth + m, y: rand(0, innerHeight) }          // right
      : side === 2 ? { x: rand(0, innerWidth), y: innerHeight + m }          // bottom
      : { x: -m, y: rand(0, innerHeight) };                                  // left
    const d = Math.hypot(p.x - end.x, p.y - end.y);
    if (!best || d > best.d) best = { ...p, d };
    if (d > 320) break;
  }
  return best;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Animate an ace flung in from a random screen edge. It flies like a real
// thrown card: a fast-spinning plate whose plane is tilted toward the camera
// and slowly precesses, wobbling more as it loses speed, sometimes tumbling
// end over end, then settling flat and crooked on the target.
function throwCard({ to, suit }) {
  const end = seatCenter(to);
  if (!end) return;
  const rand = (a, b) => a + Math.random() * (b - a);
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  const start = offscreenStart(end, rand);

  end.x += rand(-14, 14);
  end.y += rand(-12, 12);

  // Path: a curve bending sideways, with a little lift like it was arced in.
  const dx = end.x - start.x, dy = end.y - start.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bend = rand(0.08, 0.25) * dist * sign();
  const ctrl = { x: start.x + dx / 2 - (dy / dist) * bend, y: start.y + dy / 2 + (dx / dist) * bend - rand(20, 90) };

  // Spin and attitude.
  const spinDir = sign();
  const startRot = rand(0, 360);
  const totalSpin = spinDir * rand(1440, 2520);      // 4–7 full turns
  const landRot = rand(-35, 35);                      // crooked final angle
  const tiltX0 = rand(48, 70) * sign();               // plane tilted toward/away from camera
  const tiltY0 = rand(-35, 35);
  const precess = rand(1.2, 2.4) * sign();            // how much the tilt swings around
  const wobbleFreq = rand(5, 8);
  const tumble = Math.random() < 0.4 ? sign() * 360 : 0; // sometimes it flips over once
  const duration = Math.min(1300, Math.max(650, dist * 0.8));

  const el = document.createElement('div');
  el.className = 'flying-card';
  el.innerHTML = `<div class="fc-face">${aceSvg(suit)}</div><div class="fc-face fc-back ${Math.random() < 0.5 ? 'back-red' : 'back-blue'}"></div>`;
  document.body.appendChild(el);

  const W = 34, H = 48;
  const frames = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const lin = i / steps;
    const t = 1 - Math.pow(1 - lin, 2.4);             // fast release, soft landing
    const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * end.x;
    const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * end.y;

    const settle = smoothstep(0.72, 1, lin);          // lies down flat at the end
    const air = 1 - settle;
    const spin = startRot + totalSpin * t + landRot * settle;
    const wobble = Math.sin(lin * Math.PI * wobbleFreq) * (6 + 18 * lin) * air; // grows as it slows
    const rx = tiltX0 * Math.cos(lin * Math.PI * precess) * air + wobble + tumble * smoothstep(0.15, 0.65, lin);
    const ry = tiltY0 * Math.sin(lin * Math.PI * precess + 1) * air + wobble * 0.6;
    const scale = 1.9 - 0.9 * t + Math.sin(lin * Math.PI) * 0.2; // big near the camera, shrinks onto the table

    frames.push({
      transform: `translate(${x - W / 2}px, ${y - H / 2}px) perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${spin}deg) scale(${scale})`,
      offset: lin,
    });
  }

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fly = el.animate(frames, { duration: reduce ? 1 : duration, easing: 'linear', fill: 'forwards' });
  fly.onfinish = () => {
    const seat = document.querySelector(`.player[data-id="${CSS.escape(to)}"]`);
    if (seat) {
      seat.classList.remove('hit');
      void seat.offsetWidth; // restart the shake animation
      seat.classList.add('hit');
      setTimeout(() => seat.classList.remove('hit'), 500);
    }
    const last = frames[frames.length - 1].transform;
    el.animate(
      [{ transform: last, opacity: 1 }, { transform: last, opacity: 1, offset: 0.7 }, { transform: `translateY(14px) ${last}`, opacity: 0 }],
      { duration: 1400, easing: 'ease-in', fill: 'forwards' },
    ).onfinish = () => el.remove();
  };
}

// ---------- rendering ----------
function renderRoomShell() {
  app.replaceChildren(tpl('tpl-room'));

  $('#copy-link').addEventListener('click', async () => {
    const url = location.href;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch { prompt('Copy this link:', url); }
  });

  $('#add-task').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#task-input');
    const title = input.value.trim().slice(0, 200);
    if (!title) return;
    input.value = '';
    addTask(title);
  });

  $('#deck').addEventListener('click', (e) => {
    const b = e.target.closest('.dcard');
    if (b && !b.disabled) vote(b.dataset.value);
  });

  $('#players').addEventListener('click', (e) => {
    const seat = e.target.closest('.player');
    if (seat && seat.dataset.id !== myId) sendThrow(seat.dataset.id);
  });

  $('#deck-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveDeck($('#deck-input').value);
  });
}

function renderAll() {
  if (!room || !$('#players')) return;
  renderTopbar();
  renderTitle();
  renderTable();
  renderDeck();
  renderTasks();
}

function renderTopbar() {
  topbarRight.innerHTML = `${isHost() ? '<span class="host-badge">👑 Host</span> · ' : ''}<span>${esc(myName)}</span> · <button class="link-btn" id="rename">Change name</button>${isHost() ? ' · <button class="link-btn" id="new-room">New room</button>' : ''}`;
  $('#rename').addEventListener('click', () => renderNameGate(room?.id));
  $('#new-room')?.addEventListener('click', startNewRoom);
}

function renderTitle() {
  const h = $('#current-title');
  const t = currentTask();
  if (t) { h.textContent = t.title; h.classList.remove('placeholder'); }
  else {
    h.textContent = tasks.length
      ? (isHost() ? 'Pick a task from the list' : 'Waiting for the host to pick a task')
      : (isHost() ? 'Add a task to get started' : 'Free vote');
    h.classList.add('placeholder');
  }
}

function renderTable() {
  const wrap = $('#players');
  const center = $('#table-center');

  // Flip animation only the first time we draw the revealed cards.
  const flipNow = room.revealed && !renderTable.shownRevealed;
  renderTable.shownRevealed = room.revealed;

  wrap.innerHTML = players.map((p) => {
    let card;
    if (room.revealed && p.vote) card = cardFace(p.vote, flipNow ? 'reveal' : '');
    else if (p.vote) card = `<div class="pcard back ${backColor(p.id)}" title="Voted"></div>`;
    else card = `<div class="pcard empty" title="Thinking…"></div>`;
    const crown = p.id === room.host_id ? '👑 ' : '';
    const away = p.away && p.id !== myId;
    const me = p.id === myId;
    const label = me ? '' : ` title="Throw a card at ${esc(p.name)}" aria-label="Throw a card at ${esc(p.name)}"`;
    return `<button type="button" class="player${me ? ' me' : ' throwable'}${away ? ' away' : ''}" data-id="${esc(p.id)}"${label}>${card}<span class="player-name">${crown}${esc(p.name)}${me ? ' (you)' : ''}</span>${away ? '<span class="away-tag">💤 away</span>' : ''}</button>`;
  }).join('');

  const voted = players.filter((p) => p.vote);
  const host = players.find((p) => p.id === room.host_id);
  const takeOver = !isHost() && !hostPresent()
    ? '<button class="btn btn-ghost" id="takeover-btn">Host is away · take over</button>' : '';

  if (!room.revealed) {
    const action = isHost()
      ? `<button class="btn btn-primary" id="reveal-btn" ${voted.length ? '' : 'disabled'}>Reveal cards</button>`
      : `<div class="status-line">Waiting for ${host ? esc(host.name) : 'the host'} to reveal</div>`;
    center.innerHTML = `<div class="status-line">${voted.length} of ${players.length} voted</div>${action}${takeOver}`;
  } else {
    const nums = voted.map((p) => cardValue(p.vote)).filter((n) => n !== null);
    let html = '<div class="status-line">No numeric votes</div>';
    if (nums.length) {
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      const min = Math.min(...nums), max = Math.max(...nums);
      const consensus = min === max && nums.length === voted.length && voted.length > 1;
      html = `
        <div class="stats">
          <div class="stat"><span class="stat-val">${fmt(avg)}</span><span class="stat-label">Average</span></div>
          <div class="stat"><span class="stat-val">${fmt(min)}</span><span class="stat-label">Low</span></div>
          <div class="stat"><span class="stat-val">${fmt(max)}</span><span class="stat-label">High</span></div>
        </div>
        ${consensus ? '<div class="consensus">🎉 Consensus!</div>' : ''}`;
    }

    if (isHost()) {
      const suggestion = suggestEstimate(voted.map((p) => p.vote), deck());
      const options = deck().filter((d) => d !== '☕')
        .map((d) => `<option ${d === suggestion ? 'selected' : ''}>${esc(d)}</option>`).join('');
      html += currentTask()
        ? `<form class="estimate-form" id="estimate-form">
             <select id="estimate-select" aria-label="Final estimate">${options}</select>
             <button class="btn btn-primary" type="submit">Save estimate &amp; next</button>
             <button class="btn btn-ghost" type="button" id="revote-btn">Re-vote</button>
           </form>`
        : `<button class="btn btn-primary" id="revote-btn">New round</button>`;
    } else {
      html += `<div class="status-line">${host ? esc(host.name) : 'The host'} is picking the final estimate</div>${takeOver}`;
    }
    center.innerHTML = html;
  }

  $('#reveal-btn')?.addEventListener('click', reveal);
  $('#revote-btn')?.addEventListener('click', revote);
  $('#takeover-btn')?.addEventListener('click', takeOverHost);
  $('#estimate-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEstimate($('#estimate-select').value);
  });
}

function renderDeck() {
  const me = players.find((p) => p.id === myId);
  const cards = deck();
  const deckEl = $('#deck');
  const key = cards.join('\u0001');
  if (deckEl.dataset.key !== key) {
    deckEl.dataset.key = key;
    // Each card gets a small fixed tilt so your hand looks hand-held, not gridded.
    deckEl.innerHTML = cards.map((v, i) => {
      const tilt = ((i * 37) % 9) - 4;
      const label = v === '☕' ? 'Need a break' : v === '?' ? 'Not sure' : v;
      return `<button type="button" class="dcard" data-value="${esc(v)}" style="--tilt:${tilt}deg" aria-label="${esc(label)}">${cardFace(v)}</button>`;
    }).join('');
  }
  deckEl.querySelectorAll('.dcard').forEach((b) => {
    b.classList.toggle('selected', me?.vote === b.dataset.value);
    b.disabled = !!room.revealed;
  });
  $('#deck-hint').textContent = room.revealed
    ? 'Cards are revealed'
    : me?.vote ? 'Tap again to take back your vote' : 'Pick a card';
}

function renderTasks() {
  const host = isHost();
  $('#add-task').hidden = !host;
  $('#deck-editor').hidden = !host;
  const deckInput = $('#deck-input');
  if (host && document.activeElement !== deckInput) deckInput.value = deck().join(', ');
  const done = tasks.filter((t) => t.estimate).length;
  $('#tasks-count').textContent = tasks.length ? `${done}/${tasks.length} estimated` : '';

  const list = $('#tasks');
  if (!tasks.length) {
    list.innerHTML = `<li class="tasks-empty">${host ? 'No tasks yet. Add the ones you want to estimate.' : 'The host hasn’t added any tasks yet.'}</li>`;
    return;
  }
  list.innerHTML = tasks.map((t) => {
    const cls = ['task', t.id === room.current_task_id && 'current', t.estimate && 'done', host && 'focusable'].filter(Boolean).join(' ');
    return `<li class="${cls}" data-id="${t.id}" ${host ? 'title="Click to estimate this task"' : ''}>
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-est${t.estimate ? '' : ' empty'}">${t.estimate ? esc(t.estimate) : '–'}</span>
      ${host ? `<button class="task-del" data-del="${t.id}" aria-label="Delete task">×</button>` : ''}
    </li>`;
  }).join('');

  if (host) {
    list.querySelectorAll('.task').forEach((li) => li.addEventListener('click', (e) => {
      if (e.target.dataset.del) return deleteTask(e.target.dataset.del);
      if (li.dataset.id !== room.current_task_id) focusTask(li.dataset.id);
    }));
  }
}

// ---------- start ----------
window.addEventListener('hashchange', route);
route();
