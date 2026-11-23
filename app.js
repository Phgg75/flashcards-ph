'use strict';
/* =====================================================================
   Flashcards PH — app pessoal de flashcards com repetição espaçada
   Tudo roda no navegador; os dados ficam salvos no IndexedDB do aparelho.
   ===================================================================== */

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const DIFFS = [
  { k: 'extremo', label: 'Extremamente difícil', short: 'Extremo', key: '1' },
  { k: 'dificil', label: 'Difícil', short: 'Difícil', key: '2' },
  { k: 'medio',   label: 'Médio',   short: 'Médio',   key: '3' },
  { k: 'facil',   label: 'Fácil',   short: 'Fácil',   key: '4' },
];
const DIFF_LABEL = Object.fromEntries(DIFFS.map(d => [d.k, d.label]));
const DIFF_WEIGHT = { extremo: 0, dificil: 1, medio: 2, facil: 3 };
const COLORS = ['#7c5cff', '#22c55e', '#f97316', '#06b6d4', '#ec4899', '#eab308', '#3b82f6', '#ef4444', '#14b8a6', '#a855f7'];

/* ---------------------------- Banco de dados ---------------------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('flashcards-ph', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['folders', 'cards'].forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all(store) {
    return new Promise((res, rej) => {
      const q = this.db.transaction(store).objectStore(store).getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  write(store, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, 'readwrite');
      fn(t.objectStore(store));
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  },
  put(store, items) { items = [].concat(items); return this.write(store, s => items.forEach(i => s.put(i))); },
  del(store, ids) { ids = [].concat(ids); return this.write(store, s => ids.forEach(i => s.delete(i))); },
  clear(store) { return this.write(store, s => s.clear()); },
};

/* ------------------------------- Estado -------------------------------- */
const S = {
  folders: [], cards: [], meta: { stats: { days: {} } },
  view: 'home', folderId: null, search: '', errFolder: '', session: null,
};

/* ------------------------------ Utilidades ----------------------------- */
const $ = sel => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/__(.+?)__/g, '<u>$1</u>')
  .replace(/`(.+?)`/g, '<code>$1</code>')
  .replace(/\n/g, '<br>');
const plain = s => String(s ?? '').replace(/\*\*|__|`/g, '');
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const todayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfToday = () => startOfDay() + DAY - 1;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function spanLabel(ms) {
  if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + ' min';
  if (ms < DAY) return Math.round(ms / HOUR) + ' h';
  const d = Math.round(ms / DAY);
  if (d < 31) return d + (d === 1 ? ' dia' : ' dias');
  if (d < 365) { const m = Math.round(d / 30); return m + (m === 1 ? ' mês' : ' meses'); }
  const y = (d / 365).toFixed(1).replace('.0', ''); return y + (y === '1' ? ' ano' : ' anos');
}
// Atraso: card que deveria ter sido revisado num dia anterior e não foi
const lateDays = c => c.due < startOfDay() ? Math.max(1, Math.round((startOfDay() - startOfDay(c.due)) / DAY)) : 0;
function dueLabel(c) {
  const diff = c.due - Date.now();
  const late = lateDays(c);
  if (late) return `<span class="late-txt">atrasado há ${late} ${late === 1 ? 'dia' : 'dias'}</span>`;
  if (diff <= 0) return 'pendente';
  if (c.due <= endOfToday()) return 'hoje';
  return 'em ' + spanLabel(diff);
}

/* ---------------------- Algoritmo de repetição espaçada ---------------------- */
// Cada card guarda: ease (facilidade), interval (dias), due (quando volta).
// Extremamente difícil → volta em 10 min (e de novo na mesma sessão).
// Difícil → intervalo cresce devagar. Médio → normal. Fácil → cresce rápido.
function schedule(c, r, now = Date.now()) {
  let ease = c.ease || 2.5, iv = c.interval || 0, reps = c.reps || 0, lapses = c.lapses || 0, due;
  if (r === 'extremo') {
    ease = Math.max(1.3, ease - 0.2); lapses++; iv = 0; reps = 0; due = now + 10 * MIN;
  } else {
    const hard = iv < 1 ? 1 : Math.max(iv + 1, Math.round(iv * 1.2));
    const med = iv < 1 ? 3 : Math.max(hard + 1, Math.round(iv * ease));
    const easy = iv < 1 ? 7 : Math.max(med + 1, Math.round(iv * ease * 1.4));
    if (r === 'dificil') { ease = Math.max(1.3, ease - 0.15); iv = hard; }
    else if (r === 'medio') { iv = med; }
    else { ease = Math.min(3.5, ease + 0.15); iv = easy; }
    iv = Math.min(iv, 365); reps++;
    due = startOfDay(now) + iv * DAY + 4 * HOUR; // volta de madrugada no dia certo
  }
  return { ease, interval: iv, reps, lapses, due, difficulty: r, lastReview: now };
}

function newCard(data) {
  return Object.assign({
    id: uid(), folderId: null, type: 'card', front: '', back: '', image: null,
    extra: {}, tags: [], difficulty: null, ease: 2.5, interval: 0, reps: 0, lapses: 0,
    due: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), lastReview: null,
  }, data);
}
// Dificuldade informada na criação já ajusta a "facilidade" inicial
function applyInitialDifficulty(c) {
  const e = { extremo: 1.7, dificil: 2.1, medio: 2.5, facil: 2.8 }[c.difficulty];
  if (e) c.ease = e;
  return c;
}

/* ------------------------------ Pastas ------------------------------- */
const folderById = id => S.folders.find(f => f.id === id);
const childrenOf = id => S.folders.filter(f => (f.parentId || null) === (id || null)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
function descendantIds(id) {
  const out = [id]; childrenOf(id).forEach(ch => out.push(...descendantIds(ch.id))); return out;
}
function folderPath(id) {
  const parts = []; let f = folderById(id);
  while (f) { parts.unshift(f.name); f = folderById(f.parentId); }
  return parts.join(' / ');
}
function rootOf(id) { let f = folderById(id); while (f && f.parentId) f = folderById(f.parentId); return f; }
function cardsIn(folderId, type) {
  let list = S.cards;
  if (folderId) { const ids = new Set(descendantIds(folderId)); list = list.filter(c => ids.has(c.folderId)); }
  if (type && type !== 'all') list = list.filter(c => c.type === type);
  return list;
}
const isDue = c => c.due <= endOfToday();
const dueOf = (folderId, type) => cardsIn(folderId, type).filter(isDue);
const lateOf = (folderId, type) => cardsIn(folderId, type).filter(c => lateDays(c) > 0);
const folderColor = f => f?.color || COLORS[0];
function allFolderOptions(selected, { allowNone = false } = {}) {
  const out = []; const walk = (pid, depth) => childrenOf(pid).forEach(f => {
    out.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'   '.repeat(depth)}${esc(f.name)}</option>`);
    walk(f.id, depth + 1);
  });
  walk(null, 0);
  return (allowNone ? `<option value="">— Sem matéria —</option>` : '') + out.join('');
}

async function createFolder(name, parentId = null, id = null) {
  const f = { id: id || uid(), name: name.trim(), parentId, createdAt: Date.now(),
    color: parentId ? folderColor(rootOf(parentId)) : COLORS[S.folders.filter(x => !x.parentId).length % COLORS.length] };
  S.folders.push(f); await DB.put('folders', f); return f;
}
async function findOrCreatePath(path) {
  const parts = String(path || '').split(/\s*[\/>]\s*/).map(p => p.trim()).filter(Boolean);
  let parent = null;
  for (const p of parts) {
    let f = childrenOf(parent).find(x => norm(x.name) === norm(p));
    if (!f) f = await createFolder(p, parent);
    parent = f.id;
  }
  return parent;
}

/* ------------------------------ Estatísticas ------------------------------ */
async function logReview() {
  const k = todayKey(); const days = S.meta.stats.days;
  days[k] = (days[k] || 0) + 1;
  await DB.put('meta', { k: 'stats', v: S.meta.stats });
}
function streak() {
  const days = S.meta.stats.days; let n = 0; const d = new Date();
  if (!days[todayKey(d)]) d.setDate(d.getDate() - 1);
  while (days[todayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ================================ Navegação ================================ */
// main: aparece direto no menu flutuante do celular; os outros ficam no botão "Mais"
const NAV = [
  { v: 'home', ico: '◈', label: 'Início', main: true },
  { v: 'review', ico: '↻', label: 'Revisar', main: true, count: () => dueOf(null).length },
  { v: 'ciclo', ico: '◷', label: 'Ciclo', main: true },
  { v: 'folders', ico: '▤', label: 'Matérias', main: true },
  { v: 'errors', ico: '✎', label: 'Caderno de erros', short: 'Erros', count: () => dueOf(null, 'erro').length },
  { v: 'edital', ico: '☑', label: 'Edital' },
  { v: 'lembretes', ico: '🔔', label: 'Lembretes' },
  { v: 'gerar', ico: '✨', label: 'Gerar com o Claude', short: 'Gerar' },
  { v: 'conta', ico: '☁', label: 'Nuvem / conta', short: 'Nuvem', sideHidden: true },
];
let NAV_MORE_OPEN = false;
function navBtn(n, short) {
  const c = n.count ? n.count() : 0;
  return `<button data-nav="${n.v}" class="${S.view === n.v ? 'active' : ''}"><span class="ico">${n.ico}</span><span class="lbl">${short && n.short ? n.short : n.label}</span>${c ? `<span class="count">${c}</span>` : ''}</button>`;
}
function renderNav() {
  $('#nav-side').innerHTML = NAV.filter(n => !n.sideHidden).map(n => navBtn(n, false)).join('');
  // Celular: menu flutuante com os principais + "Mais" (abre um painel com o resto)
  const extra = NAV.filter(n => !n.main);
  const extraActive = extra.some(n => n.v === S.view);
  const extraCount = extra.reduce((s, n) => s + (n.count ? n.count() : 0), 0);
  $('#nav-bottom').innerHTML = NAV.filter(n => n.main).map(n => navBtn(n, true)).join('')
    + `<button data-act="nav-more" class="${extraActive || NAV_MORE_OPEN ? 'active' : ''}"><span class="ico">${NAV_MORE_OPEN ? '✕' : '☰'}</span><span class="lbl">Mais</span>${extraCount ? '<span class="dot"></span>' : ''}</button>`;
  $('#nav-more').innerHTML = `<div class="nav-more-grid">${extra.map(n => navBtn(n, true)).join('')}</div>`;
  $('#nav-more').classList.toggle('open', NAV_MORE_OPEN);
  $('#side-foot').innerHTML = `${S.cards.length} cards · ${S.folders.filter(f => !f.parentId).length} matérias<br>${typeof syncFoot === 'function' ? syncFoot() : 'Dados salvos neste aparelho'}`;
}
// Navegação com histórico: o botão "Voltar" do app, o voltar do navegador e o gesto/botão do celular funcionam igual.
let NAV_DEPTH = 0;
function go(view, folderId) {
  const fid = folderId !== undefined ? folderId : S.folderId;
  if (view === S.view && (fid || null) === (S.folderId || null)) { render(); return; }
  S.view = view; S.folderId = fid; S.search = '';
  NAV_DEPTH++;
  const st = { view, folderId: fid || null, depth: NAV_DEPTH };
  // se uma janela acabou de fechar, troca a entrada dela em vez de empilhar
  if (history.state?.overlay) history.replaceState(st, ''); else history.pushState(st, '');
  render(); window.scrollTo(0, 0);
}
function goBack() {
  if (NAV_DEPTH > 0) history.back();
  else if (S.view === 'folders' && S.folderId) { const f = folderById(S.folderId); go('folders', f?.parentId || null); }
  else go('home');
}
window.addEventListener('popstate', e => {
  // Se tiver revisão, editor ou janela aberta, o voltar fecha ela primeiro
  const wasOpen = !!S.session || !$('#modal').classList.contains('hidden');
  if (S.session) { endSession(); }
  if (!$('#modal').classList.contains('hidden')) closeModal();
  const st = e.state || { view: 'home', folderId: null, depth: 0 };
  if (st.overlay && !wasOpen) { history.back(); return; } // entrada de janela que já foi fechada
  S.view = st.view; S.folderId = st.folderId; S.search = ''; NAV_DEPTH = st.depth || 0;
  render(); window.scrollTo(0, 0);
});
// Revisão e janelas (modal) também entram no histórico: o "voltar" do celular fecha elas em vez de sair da tela.
function syncOverlayHistory() {
  const open = !$('#modal').classList.contains('hidden') || !$('#session').classList.contains('hidden');
  if (open && !history.state?.overlay) history.pushState({ ...(history.state || {}), overlay: true }, '');
  else if (!open && history.state?.overlay) history.back();
}
function backBar() {
  if (S.view === 'home') return '';
  let label = 'Voltar';
  if (S.view === 'folders' && S.folderId && NAV_DEPTH === 0) {
    const f = folderById(S.folderId); label = f?.parentId ? 'Voltar para ' + folderById(f.parentId)?.name : 'Voltar para Matérias';
  }
  return `<div class="back-bar"><button class="btn ghost back-btn" data-act="go-back">‹ ${esc(label)}</button>
    <span class="spacer"></span><button class="btn ghost sm" data-nav="home">⌂ Início</button></div>`;
}
function render() {
  renderNav();
  const v = { home: viewHome, review: viewReview, folders: viewFolders, errors: viewErrors, edital: viewEdital, ciclo: viewCiclo, gerar: viewGerar, import: viewGerar, conta: viewConta, lembretes: viewLembretes }[S.view] || viewHome;
  $('#view').innerHTML = backBar() + v();
  if (S.view === 'folders') bindSearch();
}

/* ================================ Telas ================================ */
function viewHome() {
  const due = dueOf(null).length;
  const late = lateOf(null), maxLate = Math.max(0, ...late.map(lateDays));
  const today = S.meta.stats.days[todayKey()] || 0;
  const roots = childrenOf(null);
  return `
  <h1>Bons estudos 👋</h1>
  <p class="sub">${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
  ${typeof SYNC_USER !== 'undefined' && !SYNC_USER && typeof sb !== 'undefined' && sb ? `<div class="alert warn" style="margin:0 0 14px"><div class="grow"><b>☁ Entre na nuvem</b>
    <span class="small">para ter tudo igual no computador e no iPhone, e para o Claude lançar os cards aqui sozinho.</span></div>
    <button class="btn" data-nav="conta">Entrar</button></div>` : ''}
  ${late.length ? `<div class="alert bad" style="margin:0 0 14px"><div class="grow"><b>⚠ ${late.length} ${late.length === 1 ? 'flashcard atrasado' : 'flashcards atrasados'}</b>
    <span class="small">(o mais antigo há ${maxLate} ${maxLate === 1 ? 'dia' : 'dias'}). Eles entram primeiro na revisão.</span></div>
    <button class="btn" data-act="start" data-mode="due">Revisar agora</button></div>` : ''}
  <div class="stats">
    <div class="stat"><div class="v">${due}</div><div class="l">Pendentes hoje${late.length ? ` · <span class="late-txt">${late.length} atrasados</span>` : ''}</div></div>
    <div class="stat"><div class="v">${today}</div><div class="l">Revisados hoje</div></div>
    <div class="stat"><div class="v">${streak()}🔥</div><div class="l">Dias seguidos</div></div>
    <div class="stat"><div class="v">${S.cards.filter(c => c.type === 'erro').length}</div><div class="l">No caderno de erros</div></div>
  </div>
  ${homePmpe()}
  <div class="hero">
    <div><h3>${due ? `Você tem ${due} ${due === 1 ? 'card' : 'cards'} para revisar` : 'Tudo em dia! ✨'}</h3>
    <p>${due ? `Revisão geral priorizando atrasados, o foco do ciclo de hoje${focusSummary() ? ` (${esc(focusSummary())})` : ''} e o que você errou no simulado.` : 'Quer reforçar? Faça uma revisão livre dos mais difíceis.'}</p></div>
    ${due ? `<button class="btn primary lg" data-act="start" data-mode="due">Começar revisão geral</button>`
          : `<button class="btn lg" data-act="start" data-mode="free" ${S.cards.length ? '' : 'disabled'}>Revisão livre</button>`}
  </div>
  <h2>Matérias</h2>
  ${roots.length ? `<div class="list">${roots.map(folderItem).join('')}</div>`
    : `<div class="empty"><div class="big">📚</div>Nenhuma matéria ainda.<br><br>
       <button class="btn primary" data-act="new-folder">+ Criar primeira matéria</button>
       <button class="btn" data-nav="gerar">✨ Gerar com o Claude</button></div>`}
  ${S.cards.length ? `<h2>Próximos 7 dias</h2><div class="card-box">${forecast()}</div>` : ''}
  ${S.cards.length ? `<h2>Por dificuldade</h2><div class="card-box">${diffBreakdown(S.cards)}</div>` : ''}`;
}

function forecast() {
  const base = startOfDay(); const cols = [];
  for (let i = 0; i < 7; i++) {
    const a = base + i * DAY, b = a + DAY;
    const n = S.cards.filter(c => i === 0 ? c.due < b : c.due >= a && c.due < b).length;
    const d = new Date(a);
    cols.push({ n, d: i === 0 ? 'Hoje' : d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') });
  }
  const max = Math.max(1, ...cols.map(c => c.n));
  return `<div class="forecast">${cols.map(c => `<div class="col"><div class="n">${c.n}</div><div class="bar" style="height:${(c.n / max) * 80}%"></div><div class="d">${c.d}</div></div>`).join('')}</div>`;
}
function diffBreakdown(list) {
  const counts = { extremo: 0, dificil: 0, medio: 0, facil: 0, novo: 0 };
  list.forEach(c => counts[c.difficulty || 'novo']++);
  return `<div class="row">${DIFFS.map(d => `<span class="pill d-${d.k}">${d.label}: ${counts[d.k]}</span>`).join('')}<span class="pill">Sem avaliação: ${counts.novo}</span></div>`;
}

function folderItem(f) {
  const all = cardsIn(f.id), due = all.filter(isDue).length, subs = childrenOf(f.id).length;
  return `<div class="item click" data-open-folder="${f.id}">
    <div class="folder-dot" style="background:${folderColor(f)}22;color:${folderColor(f)}">▤</div>
    <div class="grow"><div class="title">${esc(f.name)}</div>
      <div class="meta">${all.length} cards${subs ? ` · ${subs} ${subs === 1 ? 'subpasta' : 'subpastas'}` : ''}</div></div>
    ${due ? `<span class="pill due">${due} pendentes</span>` : ''}
    ${all.some(c => lateDays(c)) ? `<span class="pill bad">${all.filter(c => lateDays(c)).length} atrasados</span>` : ''}
    <button class="btn sm" data-act="start" data-mode="${due ? 'due' : 'free'}" data-folder="${f.id}" ${all.length ? '' : 'disabled'}>${due ? 'Revisar' : 'Livre'}</button>
  </div>`;
}

function viewReview() {
  const due = dueOf(null).length, dueCards = dueOf(null, 'card').length, dueErr = dueOf(null, 'erro').length;
  const roots = childrenOf(null);
  return `
  <h1>Revisar</h1>
  <p class="sub">Escolha como quer estudar agora.</p>
  <div class="grid-2">
    <div class="card-box"><h3 style="margin:0 0 4px">↻ Revisão geral</h3>
      <p class="muted small" style="margin:0 0 14px">Todos os cards pendentes de todas as matérias, com os mais difíceis primeiro.</p>
      <div class="row"><button class="btn primary" data-act="start" data-mode="due" ${due ? '' : 'disabled'}>Pendentes (${due})</button>
      <button class="btn" data-act="start" data-mode="free" ${S.cards.length ? '' : 'disabled'}>Revisão livre</button></div></div>
    <div class="card-box"><h3 style="margin:0 0 4px">✎ Caderno de erros</h3>
      <p class="muted small" style="margin:0 0 14px">Só as questões que você errou.</p>
      <div class="row"><button class="btn primary" data-act="start" data-mode="due" data-type="erro" ${dueErr ? '' : 'disabled'}>Pendentes (${dueErr})</button>
      <button class="btn" data-act="start" data-mode="free" data-type="erro" ${S.cards.some(c => c.type === 'erro') ? '' : 'disabled'}>Todos os erros</button></div></div>
  </div>
  ${(() => { const wk = weakCards(); return `<div class="card-box" style="margin-top:14px"><h3 style="margin:0 0 4px">🎯 Reforço dos pontos fracos</h3>
    <p class="muted small" style="margin:0 0 14px">Cards dos assuntos que você errou no último simulado, das matérias com acerto baixo e dos tópicos que ainda não estudou, mesmo que não estejam pendentes hoje.</p>
    <button class="btn primary" data-act="start-weak" ${wk.length ? '' : 'disabled'}>Reforçar (${wk.length})</button></div>`; })()}
  <p class="muted small" style="margin-top:12px"><b>A ordem da revisão é inteligente:</b> primeiro os atrasados, depois os dos assuntos em foco no seu ciclo de hoje${focusSummary() ? ` (${esc(focusSummary())})` : ''},
    os dos assuntos que você errou no simulado e os mais difíceis. Esses assuntos fracos também voltam um pouco mais cedo.<br><b>Revisão livre</b> mostra todos os cards (não só os do dia), ordenados do mais difícil para o mais fácil. Pendentes de flashcards comuns: ${dueCards}.</p>
  <h2>Por matéria</h2>
  ${roots.length ? `<div class="list">${roots.map(folderItem).join('')}</div>` : `<div class="empty">Crie uma matéria em <b>Matérias</b> ou importe flashcards.</div>`}`;
}

function viewFolders() {
  const f = folderById(S.folderId);
  if (!f) {
    const roots = childrenOf(null);
    return `<div class="page-head"><div><h1>Matérias</h1><p class="sub">Organize por matéria e subpastas (assuntos).</p></div>
      <button class="btn primary" data-act="new-folder">+ Nova matéria</button></div>
      ${roots.length ? `<div class="list">${roots.map(folderItem).join('')}</div>` : `<div class="empty"><div class="big">📚</div>Nenhuma matéria ainda.</div>`}`;
  }
  const crumbs = []; let p = f; while (p) { crumbs.unshift(p); p = folderById(p.parentId); }
  const subs = childrenOf(f.id);
  const direct = S.cards.filter(c => c.folderId === f.id);
  const all = cardsIn(f.id), due = all.filter(isDue).length;
  return `
  <div class="crumbs"><a data-open-folder="">Matérias</a>${crumbs.map(c => ` › <a data-open-folder="${c.id}">${esc(c.name)}</a>`).join('')}</div>
  <div class="page-head"><div><h1 style="color:${folderColor(f)}">${esc(f.name)}</h1>
    <p class="sub">${all.length} cards no total · ${due} pendentes</p></div>
    <div class="row">
      <button class="btn primary" data-act="start" data-mode="due" data-folder="${f.id}" ${due ? '' : 'disabled'}>Revisar pendentes (${due})</button>
      <button class="btn" data-act="start" data-mode="free" data-folder="${f.id}" ${all.length ? '' : 'disabled'}>Revisão livre</button>
    </div></div>
  <div class="row" style="margin-bottom:6px">
    <button class="btn" data-act="cl-open" data-k="flash">✨ Gerar no Claude ↗</button>
    <button class="btn" data-act="new-card" data-folder="${f.id}">+ Flashcard</button>
    <button class="btn" data-act="new-error" data-folder="${f.id}">+ Erro (print)</button>
    <button class="btn" data-act="new-folder" data-parent="${f.id}">+ Subpasta</button>
    <span class="spacer"></span>
    <button class="icon-btn" title="Renomear" data-act="rename-folder" data-id="${f.id}">✏️</button>
    <button class="icon-btn" title="Excluir" data-act="delete-folder" data-id="${f.id}">🗑️</button>
  </div>
  ${all.length ? `<div style="margin:12px 0">${diffBreakdown(all)}</div>` : ''}
  ${subs.length ? `<h2>Subpastas</h2><div class="list">${subs.map(folderItem).join('')}</div>` : ''}
  <h2 class="row">Cards desta pasta <span class="pill">${direct.length}</span><span class="spacer"></span>
    <input class="input search" id="search" placeholder="Buscar..." value="${esc(S.search)}"></h2>
  <div class="list" id="card-list">${cardList(direct)}</div>`;
}
function cardList(list) {
  const q = norm(S.search);
  if (q) list = list.filter(c => norm(c.front + ' ' + c.back + ' ' + (c.tags || []).join(' ')).includes(q));
  if (!list.length) return `<div class="empty">${q ? 'Nada encontrado.' : 'Nenhum card aqui ainda.'}</div>`;
  return list.sort((a, b) => a.due - b.due).map(cardItem).join('');
}
function cardItem(c) {
  return `<div class="item click" data-act="edit-card" data-id="${c.id}">
    ${c.image ? `<img class="thumb" src="${c.image}" alt="">` : ''}
    <div class="grow"><div class="snippet">${c.type === 'erro' ? '<span class="pill d-extremo" style="margin-right:6px">erro</span>' : ''}${esc(plain(c.front)) || '<span class="muted">(só imagem)</span>'}</div>
    <div class="meta">${S.view !== 'folders' ? esc(folderPath(c.folderId) || 'Sem matéria') + ' · ' : ''}${dueLabel(c)}${c.reps ? ` · ${c.reps}x revisado` : ''}</div></div>
    ${c.difficulty ? `<span class="pill d-${c.difficulty}">${DIFF_LABEL[c.difficulty]}</span>` : `<span class="pill">novo</span>`}
  </div>`;
}
function bindSearch() {
  const el = $('#search'); if (!el) return;
  el.oninput = () => { S.search = el.value; $('#card-list').innerHTML = cardList(S.cards.filter(c => c.folderId === S.folderId)); };
}

function viewErrors() {
  let list = S.cards.filter(c => c.type === 'erro');
  if (S.errFolder) { const ids = new Set(descendantIds(S.errFolder)); list = list.filter(c => ids.has(c.folderId)); }
  const due = list.filter(isDue).length;
  return `
  <div class="page-head"><div><h1>Caderno de erros</h1>
    <p class="sub">Guarde o print da questão que você errou. Ela entra na revisão como um flashcard.</p></div>
    <div class="row"><button class="btn primary" data-act="cl-open" data-k="erro">✎ Mandar print pro Claude ↗</button>
    <button class="btn" data-act="new-error">+ Adicionar manualmente</button></div></div>
  <div class="row" style="margin-bottom:16px">
    <select class="input" id="err-filter" style="max-width:300px">
      <option value="">Todas as matérias</option>${allFolderOptions(S.errFolder)}
    </select>
    <span class="spacer"></span>
    <button class="btn" data-act="start" data-mode="due" data-type="erro" data-folder="${S.errFolder}" ${due ? '' : 'disabled'}>Revisar pendentes (${due})</button>
    <button class="btn" data-act="start" data-mode="free" data-type="erro" data-folder="${S.errFolder}" ${list.length ? '' : 'disabled'}>Revisar todos</button>
  </div>
  <div class="list">${list.length ? list.sort((a, b) => b.createdAt - a.createdAt).map(cardItem).join('')
    : `<div class="empty"><div class="big">✎</div>Nenhum erro registrado.<br>Clique em <b>+ Adicionar erro</b> e envie o print da questão<br>(dá para colar com Ctrl+V).</div>`}</div>`;
}

/* --------------------------- Importar / exportar --------------------------- */
const CLAUDE_PROMPT = `Crie flashcards para importar no meu "Programa Flashcard".
Responda SOMENTE com um bloco de código JSON neste formato:

{
  "materia": "Nome da Matéria / Assunto",
  "cards": [
    { "frente": "Pergunta", "verso": "Resposta", "dificuldade": "medio", "tags": ["opcional"] }
  ],
  "erros": [
    {
      "enunciado": "Texto da questão que errei",
      "alternativas": "A) ...\\nB) ...\\nC) ...\\nD) ...\\nE) ...",
      "minhaResposta": "B",
      "respostaCorreta": "D",
      "explicacao": "Por que a D está certa e a B errada",
      "fonte": "Banca / ano / plataforma"
    }
  ]
}

Regras:
- "materia" pode ter subpastas separadas por " / " (ex.: "Direito Constitucional / Direitos Fundamentais").
- "dificuldade": facil, medio, dificil ou extremo.
- Use **negrito** para destacar palavras-chave. Use \\n para quebra de linha.
- "erros" é para o caderno de erros: quando eu mandar print de questão que errei, transcreva o enunciado e as alternativas, identifique minha resposta e a correta e explique.
- Se não houver cards ou erros, deixe a lista vazia.`;

function viewImport() {
  return `
  <div class="card-box">
    <h3 style="margin:0 0 10px">Importar flashcards</h3>
    <div class="field"><textarea class="input code" id="imp-text" placeholder='Cole o JSON aqui... ex.: { "materia": "Biologia / Citologia", "cards": [ { "frente": "...", "verso": "..." } ] }'></textarea></div>
    <div class="row">
      <button class="btn primary" data-act="do-import">Importar</button>
      <label class="btn">Abrir arquivo .json<input type="file" accept=".json,application/json,text/plain" id="imp-file" hidden></label>
      <span class="muted small">Pastas que não existirem serão criadas automaticamente.</span>
    </div>
  </div>
  <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="copy-prompt">Copiar instrução de formato (modo manual)</button></div>
  <h2>Backup</h2>
  <div class="card-box">
    <p class="muted small" style="margin-top:0">Os dados ficam salvos <b>neste aparelho</b>. Para passar para outro (celular, tablet), exporte o backup aqui e restaure lá. Faça backup de vez em quando!</p>
    <div class="row">
      <button class="btn primary" data-act="export">Exportar backup completo</button>
      <label class="btn">Restaurar backup<input type="file" accept=".json,application/json" id="restore-file" hidden></label>
      <span class="spacer"></span>
      <button class="btn danger" data-act="wipe">Apagar tudo</button>
    </div>
  </div>`;
}

function parseDiff(v) {
  const n = norm(v);
  if (!n) return null;
  if (n.startsWith('ext') || n.includes('muito')) return 'extremo';
  if (n.startsWith('dif')) return 'dificil';
  if (n.startsWith('med')) return 'medio';
  if (n.startsWith('fac')) return 'facil';
  return null;
}
function tryParseJSON(text) {
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(text); } catch (e) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    const a2 = text.indexOf('['), b2 = text.lastIndexOf(']');
    const s = (a2 !== -1 && (a === -1 || a2 < a)) ? text.slice(a2, b2 + 1) : text.slice(a, b + 1);
    return JSON.parse(s);
  }
}
async function importData(data) {
  if (data && data.app === 'flashcards-ph') return restoreBackup(data, true);
  const packets = Array.isArray(data) ? data : [data];
  let nc = 0, ne = 0; const created = [];
  for (const pk of packets) {
    if (!pk || typeof pk !== 'object') continue;
    // Um card solto dentro de uma lista
    if (pk.frente || pk.front || pk.pergunta || pk.enunciado) {
      const isErr = !!pk.enunciado || pk.tipo === 'erro';
      const tf = pk.topico && S.meta.pmpe?.folders?.[String(pk.topico).trim()];
      const fid = (tf && folderById(tf)) ? tf : await findOrCreatePath(pk.materia || pk.pasta || 'Importados');
      const c = isErr ? errFromJSON(pk, fid) : cardFromJSON(pk, fid);
      created.push(c); isErr ? ne++ : nc++; continue;
    }
    // Pasta: pelo código do assunto do edital ("topico": "rl-4.2"), senão pelo caminho "Matéria / Assunto"
    const topicFolder = code => { const id = code && S.meta.pmpe?.folders?.[String(code).trim()]; return id && folderById(id) ? id : null; };
    // pasta padrão do pacote só é criada se algum item precisar dela
    let base = null;
    const baseFolder = async () => base || (base = topicFolder(pk.topico) || await findOrCreatePath(pk.materia || pk.pasta || pk.folder || 'Importados'));
    for (const it of pk.cards || pk.flashcards || []) {
      const fid = topicFolder(it.topico) || (it.materia ? await findOrCreatePath(it.materia) : await baseFolder());
      created.push(cardFromJSON(it, fid)); nc++;
    }
    for (const it of pk.erros || pk.errors || []) {
      const fid = topicFolder(it.topico) || (it.materia ? await findOrCreatePath(it.materia) : await baseFolder());
      created.push(errFromJSON(it, fid)); ne++;
    }
  }
  S.cards.push(...created); await DB.put('cards', created);
  return { nc, ne };
}
function cardFromJSON(it, fid) {
  return applyInitialDifficulty(newCard({
    folderId: fid, type: 'card',
    front: it.frente ?? it.front ?? it.pergunta ?? '', back: it.verso ?? it.back ?? it.resposta ?? '',
    difficulty: parseDiff(it.dificuldade ?? it.difficulty), tags: it.tags || [], image: it.imagem || null,
  }));
}
function errFromJSON(it, fid) {
  const front = [it.enunciado ?? it.questao ?? it.frente ?? '', it.alternativas ?? ''].filter(Boolean).join('\n\n');
  return applyInitialDifficulty(newCard({
    folderId: fid, type: 'erro', front, back: it.explicacao ?? it.comentario ?? it.verso ?? '',
    difficulty: parseDiff(it.dificuldade) || 'dificil', image: it.imagem || null, tags: it.tags || [],
    extra: { minha: it.minhaResposta ?? '', correta: it.respostaCorreta ?? it.gabarito ?? '', fonte: it.fonte ?? '' },
  }));
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportBackup() {
  const data = { app: 'flashcards-ph', version: 1, exportedAt: new Date().toISOString(), folders: S.folders, cards: S.cards, meta: S.meta };
  download(`flashcards-backup-${todayKey()}.json`, JSON.stringify(data));
  toast('Backup exportado!');
}
async function restoreBackup(data, ask = false) {
  if (!confirm(`Restaurar backup de ${data.exportedAt ? new Date(data.exportedAt).toLocaleString('pt-BR') : 'arquivo'}?\n\n${data.cards.length} cards e ${data.folders.length} pastas.\nIsso SUBSTITUI os dados atuais deste aparelho.`)) return null;
  await DB.clear('folders'); await DB.clear('cards');
  S.folders = data.folders || []; S.cards = data.cards || [];
  const pmpe = S.meta.pmpe;
  S.meta = data.meta && data.meta.stats ? data.meta : { stats: { days: {} } };
  S.meta.pmpe = Object.assign(defaultPmpe(), data.meta?.pmpe || pmpe);
  await DB.put('folders', S.folders); await DB.put('cards', S.cards); await DB.put('meta', { k: 'stats', v: S.meta.stats });
  await savePmpe();
  toast('Backup restaurado!'); go('home');
  return { restored: true };
}

/* ================================ Editor ================================ */
let ED = null; // estado do editor aberto
function openEditor({ card, type = 'card', folderId = null }) {
  const c = card ? { ...card, extra: { ...(card.extra || {}) } } : newCard({ type, folderId: folderId || S.folderId || S.errFolder || childrenOf(null)[0]?.id || null });
  ED = c;
  renderEditor(!card);
}
function renderEditor(isNew) {
  const c = ED, isErr = c.type === 'erro';
  $('#modal').innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3>${isNew ? (isErr ? 'Novo erro' : 'Novo flashcard') : (isErr ? 'Editar erro' : 'Editar flashcard')}</h3>
      <button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Tipo</label><div class="seg">
        <button data-act="ed-type" data-v="card" class="${!isErr ? 'on' : ''}">Flashcard</button>
        <button data-act="ed-type" data-v="erro" class="${isErr ? 'on' : ''}">Erro de questão</button></div></div>
      <div class="field"><label>Matéria / pasta</label>
        <div class="row"><select class="input" id="ed-folder" style="flex:1">${S.folders.length ? allFolderOptions(c.folderId) : '<option value="">Crie uma matéria primeiro</option>'}</select>
        <button class="btn sm" data-act="ed-new-folder">+ Nova</button></div></div>
      <div class="field"><label>${isErr ? 'Print da questão (clique, arraste ou cole com Ctrl+V)' : 'Imagem (opcional — clique, arraste ou cole)'}</label>
        <div class="dropzone" id="ed-drop">${c.image ? `<img src="${c.image}" alt="">Clique para trocar` : (isErr ? '📷 Enviar print da questão' : '＋ Adicionar imagem')}</div>
        ${c.image ? `<button class="btn sm ghost" data-act="ed-rm-img" style="margin-top:6px">Remover imagem</button>` : ''}
        <input type="file" accept="image/*" id="ed-file" hidden></div>
      <div class="field"><label>${isErr ? 'Enunciado / observação (opcional se tiver o print)' : 'Frente (pergunta)'}</label>
        <textarea class="input" id="ed-front" rows="3">${esc(c.front)}</textarea></div>
      ${isErr ? `<div class="grid-2">
        <div class="field"><label>Minha resposta</label><input class="input" id="ed-minha" value="${esc(c.extra.minha)}" placeholder="ex.: B"></div>
        <div class="field"><label>Resposta correta</label><input class="input" id="ed-correta" value="${esc(c.extra.correta)}" placeholder="ex.: D"></div></div>` : ''}
      <div class="field"><label>${isErr ? 'Explicação / por que errei' : 'Verso (resposta)'}</label>
        <textarea class="input" id="ed-back" rows="4">${esc(c.back)}</textarea></div>
      ${isErr ? `<div class="field"><label>Fonte (banca, ano, plataforma)</label><input class="input" id="ed-fonte" value="${esc(c.extra.fonte)}"></div>` : ''}
      <div class="field"><label>Minha dificuldade neste card</label><div class="seg">
        ${DIFFS.map(d => `<button data-act="ed-diff" data-v="${d.k}" class="d-${d.k} ${c.difficulty === d.k ? 'on' : ''}">${d.label}</button>`).join('')}</div></div>
      <div class="field"><label>Tags (separadas por vírgula)</label><input class="input" id="ed-tags" value="${esc((c.tags || []).join(', '))}"></div>
      <p class="muted small" style="margin:0">Dica: use **negrito** para destacar.</p>
    </div>
    <div class="modal-foot">
      ${!isNew ? `<button class="btn danger" data-act="ed-delete">Excluir</button><span class="spacer"></span>` : ''}
      ${!isNew ? `<button class="btn ghost" data-act="ed-reset" title="Volta a ser um card novo">Reiniciar progresso</button>` : ''}
      <button class="btn" data-act="close-modal">Cancelar</button>
      ${isNew ? `<button class="btn" data-act="ed-save" data-again="1">Salvar e criar outro</button>` : ''}
      <button class="btn primary" data-act="ed-save">Salvar</button>
    </div></div>`;
  $('#modal').classList.remove('hidden');
  const drop = $('#ed-drop'), file = $('#ed-file');
  drop.onclick = () => file.click();
  file.onchange = () => file.files[0] && setEdImage(file.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; f && setEdImage(f); };
  ED._isNew = isNew;
}
function readEditorFields() {
  const v = id => $(id) ? $(id).value : undefined;
  ED.folderId = v('#ed-folder') || null;
  ED.front = v('#ed-front') ?? ED.front; ED.back = v('#ed-back') ?? ED.back;
  ED.tags = (v('#ed-tags') || '').split(',').map(t => t.trim()).filter(Boolean);
  if (ED.type === 'erro') ED.extra = { minha: v('#ed-minha') || '', correta: v('#ed-correta') || '', fonte: v('#ed-fonte') || '' };
}
async function setEdImage(file) {
  if (!file.type.startsWith('image/')) return toast('Isso não é uma imagem.');
  readEditorFields();
  ED.image = await compressImage(file);
  renderEditor(ED._isNew);
}
function compressImage(file, max = 1600) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = rej; img.src = r.result;
    };
    r.onerror = rej; r.readAsDataURL(file);
  });
}
async function saveEditor(again) {
  readEditorFields();
  if (!ED.folderId) return toast('Escolha ou crie uma matéria.');
  if (!ED.front.trim() && !ED.image) return toast(ED.type === 'erro' ? 'Envie o print ou escreva o enunciado.' : 'Preencha a frente do card.');
  if (ED.type === 'card' && !ED.back.trim()) return toast('Preencha o verso do card.');
  const isNew = ED._isNew; const c = { ...ED }; delete c._isNew;
  c.updatedAt = Date.now();
  if (isNew) applyInitialDifficulty(c);
  const i = S.cards.findIndex(x => x.id === c.id);
  if (i >= 0) S.cards[i] = c; else S.cards.push(c);
  await DB.put('cards', c);
  toast(isNew ? 'Salvo!' : 'Atualizado!');
  if (S.session) { const si = S.session.cards.findIndex(x => x.id === c.id); if (si >= 0) S.session.cards[si] = c; }
  if (again) { openEditor({ type: c.type, folderId: c.folderId }); }
  else closeModal();
  refresh();
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; ED = null; }
function refresh() { if (S.session) renderSession(); else render(); }

/* ============================ Sessão de revisão ============================ */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function startSession({ mode = 'due', folderId = null, type = 'all', list: given = null, title = null }) {
  let list = given ? given.slice() : mode === 'due' ? dueOf(folderId, type) : cardsIn(folderId, type).slice();
  if (!list.length) return toast(given ? 'Nenhum card aqui ainda.' : mode === 'due' ? 'Nada pendente aqui! 🎉' : 'Nenhum card aqui ainda.');
  // Ordem inteligente (estudo.js): atrasados, assuntos em foco no ciclo de hoje,
  // assuntos que você errou no simulado e dificuldade do card. Tudo local, sem IA.
  const ctx = prioContext(); const pr = new Map(list.map(c => [c.id, cardPriority(c, ctx)]));
  list = shuffle(list).sort((a, b) => pr.get(b.id) - pr.get(a.id));
  const f = folderById(folderId);
  S.session = {
    title: title || (mode === 'due' ? 'Revisão' : 'Revisão livre') + (type === 'erro' ? ' · Caderno de erros' : '') + ' · ' + (f ? f.name : 'Geral'),
    cards: list, queue: list.map(c => c.id), pos: 0, flipped: false, total: list.length,
    results: { extremo: 0, dificil: 0, medio: 0, facil: 0 }, again: {}, done: 0,
  };
  $('#session').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  renderSession();
}
function endSession() {
  S.session = null; $('#session').classList.add('hidden'); $('#session').innerHTML = ''; document.body.style.overflow = '';
  render();
}
function currentCard() { const s = S.session; return s && S.cards.find(c => c.id === s.queue[s.pos]); }
function renderSession() {
  const s = S.session; const el = $('#session');
  const c = currentCard();
  const pct = Math.round((s.pos / Math.max(1, s.queue.length)) * 100);
  if (!c) {
    const r = s.results;
    el.innerHTML = `<div class="s-top"><div class="t">${esc(s.title)}</div><button class="icon-btn" data-act="end-session">✕</button></div>
      <div class="progress"><div style="width:100%"></div></div>
      <div class="s-body"><div class="s-card done"><div class="big">🎉</div><h1>Sessão concluída!</h1>
      <p class="sub">${s.done} revisões em ${s.total} cards.</p>
      <div class="row" style="justify-content:center;margin-bottom:24px">${DIFFS.map(d => `<span class="pill d-${d.k}">${d.short}: ${r[d.k]}</span>`).join('')}</div>
      <button class="btn primary lg" data-act="end-session">Voltar</button></div></div>`;
    return;
  }
  const isErr = c.type === 'erro';
  const fct = cardFactor(c);
  const preview = DIFFS.map(d => { const iv = schedule(c, d.k).interval; return { ...d, span: (iv > 1 ? Math.max(1, Math.round(iv * fct)) : iv) * DAY }; });
  el.innerHTML = `
    <div class="s-top"><button class="icon-btn" data-act="end-session" title="Sair">✕</button>
      <div class="t">${esc(s.title)}</div>
      <span class="muted small">${s.pos + 1} / ${s.queue.length}</span>
      <button class="icon-btn" data-act="edit-card" data-id="${c.id}" title="Editar">✏️</button></div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="s-body"><div class="s-card fmt">
      <div class="face">
        <div class="lbl"><span>${isErr ? '✎ Questão que você errou' : 'Pergunta'}</span><span>·</span><span>${esc(folderPath(c.folderId))}</span>
          ${c.difficulty ? `<span class="pill d-${c.difficulty}">${DIFF_LABEL[c.difficulty]}</span>` : '<span class="pill">novo</span>'}</div>
        ${c.image ? `<img class="qimg" src="${c.image}" data-zoom alt="">` : ''}
        <div>${fmt(c.front)}</div>
      </div>
      ${s.flipped ? `<div class="face back">
        <div class="lbl">${isErr ? 'Gabarito e explicação' : 'Resposta'}</div>
        ${isErr && (c.extra?.minha || c.extra?.correta) ? `<div class="answers" style="margin:0 0 14px">
          <div class="wrong">Você marcou: <b>${esc(c.extra.minha || '—')}</b></div>
          <div class="right">Correta: <b>${esc(c.extra.correta || '—')}</b></div></div>` : ''}
        <div>${fmt(c.back) || '<span class="muted">Sem explicação.</span>'}</div>
        ${isErr && c.extra?.fonte ? `<p class="muted small" style="margin-bottom:0">Fonte: ${esc(c.extra.fonte)}</p>` : ''}
      </div>` : ''}
    </div></div>
    <div class="s-bottom"><div class="inner">
      ${s.flipped
        ? `<p class="muted small" style="margin:0 0 8px;text-align:center">Qual foi sua dificuldade?</p>
           <div class="rate">${preview.map(d => `<button class="${d.k}" data-act="rate" data-v="${d.k}"><b>${d.short}<span class="kbd">${d.key}</span></b><span>${d.k === 'extremo' ? 'repetir agora' : spanLabel(d.span)}</span></button>`).join('')}</div>`
        : `<button class="btn primary lg" style="width:100%" data-act="flip">Mostrar resposta <span class="kbd" style="color:#ddd;border-color:#ffffff55">espaço</span></button>`}
    </div></div>`;
}
async function rate(r) {
  const s = S.session, c = currentCard(); if (!c) return;
  const next = schedule(c, r);
  // Assunto fraco (errado no simulado / matéria com baixo acerto) volta até 30% mais cedo
  if (r !== 'extremo' && next.interval > 1) {
    next.interval = Math.max(1, Math.round(next.interval * cardFactor(c)));
    next.due = startOfDay() + next.interval * DAY + 4 * HOUR;
  }
  Object.assign(c, next); c.updatedAt = Date.now();
  await DB.put('cards', c); logReview();
  s.results[r]++; s.done++;
  // Extremamente difícil volta no fim da sessão (até 3 vezes)
  if (r === 'extremo' && (s.again[c.id] || 0) < 3) { s.again[c.id] = (s.again[c.id] || 0) + 1; s.queue.push(c.id); }
  s.pos++; s.flipped = false;
  renderSession(); $('.s-body') && ($('.s-body').scrollTop = 0);
}

/* ============================ Eventos globais ============================ */
document.addEventListener('click', async e => {
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) { $('#lightbox').innerHTML = `<img src="${zoom.src}">`; $('#lightbox').classList.remove('hidden'); return; }
  if (e.target.closest('#lightbox')) { $('#lightbox').classList.add('hidden'); return; }
  if (e.target.id === 'modal') { closeModal(); return; }

  if (e.target.closest('[data-act="nav-more"]')) { NAV_MORE_OPEN = !NAV_MORE_OPEN; renderNav(); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) { NAV_MORE_OPEN = false; go(nav.dataset.nav, nav.dataset.nav === 'folders' ? null : undefined); return; }
  if (NAV_MORE_OPEN && !e.target.closest('#nav-more')) { NAV_MORE_OPEN = false; renderNav(); }

  const el = e.target.closest('[data-act]');
  const of = e.target.closest('[data-open-folder]');
  if (of && !el) { go('folders', of.dataset.openFolder || null); return; }
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'go-back': goBack(); break;
    case 'start-weak': startSession({ list: weakCards(), title: 'Reforço dos pontos fracos' }); break;
    case 'start': e.stopPropagation(); startSession({ mode: d.mode, folderId: d.folder || null, type: d.type || 'all' }); break;
    case 'new-folder': {
      const name = prompt(d.parent ? 'Nome da subpasta (assunto):' : 'Nome da matéria:');
      if (!name || !name.trim()) return;
      const f = await createFolder(name, d.parent || null); toast('Pasta criada!'); go('folders', f.id); break;
    }
    case 'rename-folder': {
      const f = folderById(d.id); const name = prompt('Novo nome:', f.name);
      if (!name || !name.trim()) return; f.name = name.trim(); await DB.put('folders', f); render(); break;
    }
    case 'delete-folder': {
      const f = folderById(d.id); const ids = descendantIds(f.id); const cs = S.cards.filter(c => ids.includes(c.folderId));
      if (!confirm(`Excluir "${f.name}"${ids.length > 1 ? `, ${ids.length - 1} subpasta(s)` : ''} e ${cs.length} card(s)?\nNão dá para desfazer.`)) return;
      S.folders = S.folders.filter(x => !ids.includes(x.id)); S.cards = S.cards.filter(c => !ids.includes(c.folderId));
      await DB.del('folders', ids); await DB.del('cards', cs.map(c => c.id));
      toast('Pasta excluída.'); go('folders', f.parentId || null); break;
    }
    case 'new-card': openEditor({ type: 'card', folderId: d.folder }); break;
    case 'new-error': openEditor({ type: 'erro', folderId: d.folder }); break;
    case 'edit-card': openEditor({ card: S.cards.find(c => c.id === d.id) }); break;
    case 'close-modal': closeModal(); break;
    case 'ed-type': readEditorFields(); ED.type = d.v; renderEditor(ED._isNew); break;
    case 'ed-diff': readEditorFields(); ED.difficulty = ED.difficulty === d.v ? null : d.v; renderEditor(ED._isNew); break;
    case 'ed-rm-img': readEditorFields(); ED.image = null; renderEditor(ED._isNew); break;
    case 'ed-new-folder': {
      const name = prompt('Nome da nova matéria/pasta (use " / " para subpasta, ex.: Biologia / Genética):');
      if (!name || !name.trim()) return; readEditorFields(); ED.folderId = await findOrCreatePath(name); renderEditor(ED._isNew); break;
    }
    case 'ed-save': saveEditor(!!d.again); break;
    case 'ed-reset':
      if (!confirm('Reiniciar o progresso deste card? Ele volta a ser novo.')) return;
      Object.assign(ED, { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now(), lastReview: null }); saveEditor(); break;
    case 'ed-delete': {
      if (!confirm('Excluir este card?')) return;
      const id = ED.id; S.cards = S.cards.filter(c => c.id !== id); await DB.del('cards', id); closeModal();
      if (S.session) { const s = S.session; s.queue = s.queue.filter((x, i) => i < s.pos || x !== id); }
      toast('Card excluído.'); refresh(); break;
    }
    case 'flip': S.session.flipped = true; renderSession(); break;
    case 'rate': rate(d.v); break;
    case 'end-session': endSession(); break;
    case 'do-import': {
      const txt = $('#imp-text').value; if (!txt.trim()) return toast('Cole o JSON primeiro.');
      try {
        const r = await importData(tryParseJSON(txt));
        if (r && !r.restored) { toast(`Importado: ${r.nc} flashcards e ${r.ne} erros ✔`); $('#imp-text').value = ''; renderNav(); }
      } catch (err) { console.error(err); alert('Não consegui ler esse JSON.\n\n' + err.message); }
      break;
    }
    case 'copy-prompt': navigator.clipboard.writeText(CLAUDE_PROMPT).then(() => toast('Prompt copiado!'), () => toast('Não deu para copiar — selecione o texto manualmente.')); break;
    case 'export': exportBackup(); break;
    case 'wipe':
      if (!confirm('Apagar TODOS os cards e matérias deste aparelho?')) return;
      if (prompt('Digite APAGAR para confirmar:') !== 'APAGAR') return;
      await DB.clear('folders'); await DB.clear('cards'); S.folders = []; S.cards = []; toast('Tudo apagado.'); go('home'); break;
  }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'err-filter') { S.errFolder = e.target.value; render(); }
  if (e.target.id === 'imp-file' || e.target.id === 'restore-file') {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = tryParseJSON(await f.text());
      if (e.target.id === 'restore-file') {
        if (data.app !== 'flashcards-ph') return alert('Esse arquivo não é um backup do Flashcards PH.');
        await restoreBackup(data);
      } else {
        const r = await importData(data);
        if (r && !r.restored) { toast(`Importado: ${r.nc} flashcards e ${r.ne} erros ✔`); renderNav(); }
      }
    } catch (err) { alert('Não consegui ler o arquivo.\n\n' + err.message); }
    e.target.value = '';
  }
});

// Colar print (Ctrl+V) no editor
document.addEventListener('paste', e => {
  if (!ED) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); setEdImage(item.getAsFile()); }
});

// Atalhos de teclado na revisão
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#lightbox').classList.contains('hidden')) return $('#lightbox').classList.add('hidden');
    if (ED) return closeModal();
  }
  if (!S.session || ED || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const s = S.session; if (!currentCard()) return;
  if (!s.flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); s.flipped = true; renderSession(); return; }
  if (s.flipped) { const d = DIFFS.find(x => x.key === e.key); if (d) { e.preventDefault(); rate(d.k); } else if (e.key === ' ') { e.preventDefault(); rate('medio'); } }
});

/* ================================ Início ================================ */
(async function init() {
  try {
    if (typeof installSyncHooks === 'function') installSyncHooks(); // nuvem (sync.js)
    await DB.open();
    const [folders, cards, meta] = await Promise.all([DB.all('folders'), DB.all('cards'), DB.all('meta')]);
    S.folders = folders; S.cards = cards;
    const st = meta.find(m => m.k === 'stats'); if (st) S.meta.stats = st.v;
    await estudoInit(meta); // edital PMPE, ciclo e simulados (estudo.js)
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<div class="empty">Erro ao abrir o banco de dados do navegador.<br>${esc(err.message)}</div>`;
    return;
  }
  history.replaceState({ view: 'home', folderId: null, depth: 0 }, '');
  render();
  const mo = new MutationObserver(syncOverlayHistory);
  mo.observe($('#modal'), { attributes: true, attributeFilter: ['class'] });
  mo.observe($('#session'), { attributes: true, attributeFilter: ['class'] });
  if (typeof syncStart === 'function') syncStart().catch(err => console.error('sync start', err)); // nuvem (sync.js)
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Atualiza contadores a cada minuto (cards "extremo" voltam em 10 min)
  setInterval(() => { if (!S.session && !ED) renderNav(); }, 60000);
})();
