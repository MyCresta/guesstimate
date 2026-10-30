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

// Suggest a final estimate: the most common numeric vote (ties go to the
// higher card), falling back to the deck card closest to the average.
function suggestEstimate(votes) {
  const nums = votes.map(cardValue).filter((n) => n !== null);
  if (!nums.length) return '?';
  const counts = new Map();
  for (const v of votes) if (cardValue(v) !== null) counts.set(v, (counts.get(v) || 0) + 1);
  const top = Math.max(...counts.values());
  const modes = [...counts].filter(([, c]) => c === top).map(([v]) => v);
  if (modes.length === 1 || top > 1) return modes.sort((a, b) => cardValue(b) - cardValue(a))[0];
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return DECK.filter((d) => cardValue(d) !== null)
    .reduce((best, d) => (Math.abs(cardValue(d) - avg) < Math.abs(cardValue(best) - avg) ? d : best));
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
let players = [];    // active players in this room
let tasks = [];      // tasks in this room, in order
let channel = null;
let timers = [];

const isHost = () => !!room && room.host_id === myId;
const currentTask = () => tasks.find((t) => t.id === room?.current_task_id) || null;
const hostPresent = () => players.some((p) => p.id === room?.host_id);

function leaveRoom() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  timers.forEach(clearInterval);
  timers = [];
  room = null;
  players = [];
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
  room = data;

  const join = await sb.from('players').upsert({ id: myId, room_id: code, name: myName, vote: null, last_seen: now() });
  if (join.error) return fail('Couldn’t join', join.error);

  renderRoomShell();
  await Promise.all([loadPlayers(), loadTasks()]);

  channel = sb.channel('room-' + code)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${code}` }, loadPlayers)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `room_id=eq.${code}` }, loadTasks)
    // Delete events can't be filtered by room, so refresh on any task delete.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, loadTasks)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${code}` }, (p) => {
      const prev = room;
      room = p.new;
      // New task focused or re-vote: votes were cleared, so re-read them.
      if (prev.current_task_id !== room.current_task_id || (prev.revealed && !room.revealed)) loadPlayers();
      renderAll();
    })
    .subscribe();

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
document.addEventListener('visibilitychange', () => { if (!document.hidden && room) { heartbeat(); loadPlayers(); } });

async function loadPlayers() {
  if (!room) return;
  const { data, error } = await sb.from('players').select('*').eq('room_id', room.id).order('created_at');
  if (error || !room) return;
  const cutoff = Date.now() - STALE_MS;
  players = data.filter((p) => p.id === myId || new Date(p.last_seen).getTime() > cutoff);
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

function renderAll() {
  if (!room || !$('#players')) return;
  renderTopbar();
  renderTitle();
  renderTable();
  renderDeck();
  renderTasks();
}

function renderTopbar() {
  topbarRight.innerHTML = `${isHost() ? '<span class="host-badge">👑 Host</span> · ' : ''}<span>${esc(myName)}</span> · <button class="link-btn" id="rename">Change name</button>`;
  $('#rename').addEventListener('click', () => renderNameGate(room?.id));
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

  wrap.innerHTML = players.map((p) => {
    let card;
    if (room.revealed && p.vote) card = `<div class="pcard face">${esc(p.vote)}</div>`;
    else if (p.vote) card = `<div class="pcard back" title="Voted"></div>`;
    else card = `<div class="pcard empty" title="Thinking…"></div>`;
    const crown = p.id === room.host_id ? '👑 ' : '';
    const you = p.id === myId ? ' (you)' : '';
    return `<div class="player${p.id === myId ? ' me' : ''}">${card}<div class="player-name" title="${esc(p.name)}">${crown}${esc(p.name)}${you}</div></div>`;
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
      const suggestion = suggestEstimate(voted.map((p) => p.vote));
      const options = DECK.filter((d) => d !== '☕')
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
  document.querySelectorAll('.dcard').forEach((b) => {
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
