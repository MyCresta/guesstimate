import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Public, client-side Supabase settings (the publishable key is safe to expose;
// access is controlled by Row Level Security in the database).
const SUPABASE_URL = 'https://qvboidhwptpiduruiyfb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_vlH6f9yVTWmnkU8-7b_q1g_Wtz4tKf1';

const DECK = ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'];
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
let myId = store.get('gp.id');
if (!myId) { myId = crypto.randomUUID(); store.set('gp.id', myId); }
let myName = store.get('gp.name') || '';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const tpl = (id) => document.getElementById(id).content.cloneNode(true);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

// ---------- routing ----------
function currentRoom() {
  const code = location.hash.replace(/^#\/?/, '').toLowerCase();
  return /^[a-z0-9]{4,12}$/.test(code) ? code : null;
}

window.addEventListener('hashchange', route);
route();

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
    const { error } = await sb.from('rooms').insert({ id: code });
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

// ---------- room ----------
let room = null;           // { id, topic, revealed }
let players = [];          // rows from players table
let channel = null;
let timers = [];

function leaveRoom() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  timers.forEach(clearInterval);
  timers = [];
  room = null;
  players = [];
}

async function enterRoom(code) {
  app.innerHTML = '<p class="muted center">Joining room…</p>';

  let { data, error } = await sb.from('rooms').select('*').eq('id', code).maybeSingle();
  if (error) return app.innerHTML = `<p class="center">Couldn’t load room: ${esc(error.message)}</p>`;
  if (!data) {
    // Room link from someone else, or an old link: create it on the fly.
    const ins = await sb.from('rooms').insert({ id: code }).select().single();
    if (ins.error) return app.innerHTML = `<p class="center">Couldn’t open room: ${esc(ins.error.message)}</p>`;
    data = ins.data;
  }
  room = data;

  const join = await sb.from('players').upsert({
    id: myId, room_id: code, name: myName, vote: null, last_seen: new Date().toISOString(),
  });
  if (join.error) return app.innerHTML = `<p class="center">Couldn’t join: ${esc(join.error.message)}</p>`;

  renderRoomShell();
  await loadPlayers();

  channel = sb.channel('room-' + code)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${code}` }, loadPlayers)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${code}` }, (p) => {
      const wasRevealed = room?.revealed;
      room = p.new;
      syncTopic();
      if (wasRevealed && !room.revealed) loadPlayers(); // new round: votes were cleared
      else renderTable();
    })
    .subscribe();

  timers.push(setInterval(heartbeat, HEARTBEAT_MS));
  timers.push(setInterval(loadPlayers, 15_000)); // fallback + hides stale players
}

async function heartbeat() {
  if (!room) return;
  await sb.from('players').update({ last_seen: new Date().toISOString(), room_id: room.id, name: myName }).eq('id', myId);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); loadPlayers(); } });

async function loadPlayers() {
  if (!room) return;
  const { data, error } = await sb.from('players').select('*').eq('room_id', room.id).order('created_at');
  if (error) return;
  const cutoff = Date.now() - STALE_MS;
  players = data.filter((p) => p.id === myId || new Date(p.last_seen).getTime() > cutoff);
  // If someone else's "new round" cleared our vote, reflect that.
  renderTable();
  renderDeck();
}

function renderRoomShell() {
  topbarRight.innerHTML = `<span>${esc(myName)}</span> · <button class="link-btn" id="rename">Change name</button>`;
  $('#rename').addEventListener('click', () => renderNameGate(room?.id));

  app.replaceChildren(tpl('tpl-room'));

  const topic = $('#topic');
  syncTopic();
  let topicTimer;
  topic.addEventListener('input', () => {
    clearTimeout(topicTimer);
    topicTimer = setTimeout(() => sb.from('rooms').update({ topic: topic.value.slice(0, 200), updated_at: new Date().toISOString() }).eq('id', room.id), 400);
  });

  $('#copy-link').addEventListener('click', async () => {
    const url = location.href;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch { prompt('Copy this link:', url); }
  });

  const deck = $('#deck');
  for (const v of DECK) {
    const b = document.createElement('button');
    b.className = 'dcard';
    b.textContent = v;
    b.dataset.value = v;
    b.setAttribute('aria-label', v === '☕' ? 'Need a break' : v === '?' ? 'Not sure' : `${v} points`);
    b.addEventListener('click', () => vote(v));
    deck.appendChild(b);
  }
}

function syncTopic() {
  const el = $('#topic');
  if (el && document.activeElement !== el) el.value = room?.topic ?? '';
}

async function vote(v) {
  if (!room || room.revealed) return;
  const me = players.find((p) => p.id === myId);
  const next = me?.vote === v ? null : v; // tap again to un-vote
  if (me) me.vote = next;
  renderTable(); renderDeck();
  await sb.from('players').update({ vote: next, last_seen: new Date().toISOString() }).eq('id', myId);
}

async function reveal() {
  room.revealed = true; renderTable(); renderDeck();
  await sb.from('rooms').update({ revealed: true, updated_at: new Date().toISOString() }).eq('id', room.id);
}

async function newRound() {
  room.revealed = false;
  players.forEach((p) => { p.vote = null; });
  renderTable(); renderDeck();
  await sb.from('players').update({ vote: null }).eq('room_id', room.id);
  await sb.from('rooms').update({ revealed: false, topic: '', updated_at: new Date().toISOString() }).eq('id', room.id);
  const t = $('#topic'); if (t) { t.value = ''; t.focus(); }
}

function renderDeck() {
  const me = players.find((p) => p.id === myId);
  document.querySelectorAll('.dcard').forEach((b) => {
    b.classList.toggle('selected', me?.vote === b.dataset.value);
    b.disabled = !!room?.revealed;
  });
  const hint = $('#deck-hint');
  if (hint) hint.textContent = room?.revealed ? 'Cards are revealed. Start a new round to vote again.' : me?.vote ? 'Tap again to take back your vote' : 'Pick a card';
}

function renderTable() {
  const wrap = $('#players');
  const center = $('#table-center');
  if (!wrap || !room) return;

  wrap.innerHTML = players.map((p) => {
    let card;
    if (room.revealed && p.vote) card = `<div class="pcard face">${esc(p.vote)}</div>`;
    else if (p.vote) card = `<div class="pcard back" title="Voted"></div>`;
    else card = `<div class="pcard empty" title="Thinking…"></div>`;
    return `<div class="player${p.id === myId ? ' me' : ''}">${card}<div class="player-name" title="${esc(p.name)}">${esc(p.name)}${p.id === myId ? ' (you)' : ''}</div></div>`;
  }).join('');

  const voted = players.filter((p) => p.vote).length;

  if (!room.revealed) {
    center.innerHTML = `
      <div class="status-line">${voted} of ${players.length} voted</div>
      <button class="btn btn-primary" id="reveal-btn" ${voted ? '' : 'disabled'}>Reveal cards</button>`;
    $('#reveal-btn').addEventListener('click', reveal);
    return;
  }

  const nums = players.map((p) => cardValue(p.vote)).filter((n) => n !== null);
  let statsHtml = '<div class="status-line">No numeric votes</div>';
  if (nums.length) {
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const min = Math.min(...nums), max = Math.max(...nums);
    const allSame = min === max && nums.length === voted && voted > 1;
    statsHtml = `
      <div class="stats">
        <div class="stat"><span class="stat-val">${fmt(avg)}</span><span class="stat-label">Average</span></div>
        <div class="stat"><span class="stat-val">${fmt(min)}</span><span class="stat-label">Low</span></div>
        <div class="stat"><span class="stat-val">${fmt(max)}</span><span class="stat-label">High</span></div>
      </div>
      ${allSame ? '<div class="consensus">🎉 Consensus!</div>' : ''}`;
  }
  center.innerHTML = `${statsHtml}<button class="btn btn-primary" id="new-round-btn">New round</button>`;
  $('#new-round-btn').addEventListener('click', newRound);
}
