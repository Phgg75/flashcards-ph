'use strict';
/* =====================================================================
   Nuvem (Supabase): login + sincronização entre aparelhos
   - O app continua funcionando offline (IndexedDB). Cada alteração é marcada
     como "pendente" e enviada para a nuvem quando houver internet e login.
   - Conflito: vence a alteração mais recente (por item).
   - Caixa de entrada: o Claude (projeto ESTUDOS) deixa cards/erros/simulados na
     tabela "entrada"; o app importa e marca como processado.
   Nada aqui usa IA (não gasta tokens).
   ===================================================================== */
const SUPA_URL = 'https://gjmyddmfyvxucktihrje.supabase.co';
const SUPA_KEY = 'sb_publishable_4_pd61hUuZdIZ_MgUjsVMw_DSCj07xJ'; // chave pública (segura no app com RLS)

const sb = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

const SYNC_STORES = ['folders', 'cards'];
const SYNC_META = ['stats', 'pmpe'];
let SY = null;            // estado da sincronização (salvo localmente em meta "sync", nunca vai pra nuvem)
let SYNC_USER = null;     // usuário logado
const SYNC_UI = { status: 'off', last: null, err: null, busy: false };

const emptySY = () => ({ dirty: { folders: {}, cards: {}, meta: {} }, del: { folders: {}, cards: {} }, lastPull: null, userId: null, seeded: false });

/* ---------- Marca o que mudou (envolve DB.put / DB.del / DB.clear do app) ---------- */
// Chamado pelo app.js no começo do init (este arquivo carrega antes do app.js)
let _put, _del, _clear;
function installSyncHooks() {
  if (_put) return;
  _put = DB.put.bind(DB); _del = DB.del.bind(DB); _clear = DB.clear.bind(DB);
  DB.put = async (store, items) => {
    items = [].concat(items);
    if (store === 'folders') items.forEach(f => { f.updatedAt = Date.now(); });
    await _put(store, items);
    markDirty(store, items);
  };
  DB.del = async (store, ids) => { ids = [].concat(ids); await _del(store, ids); markDel(store, ids); };
  DB.clear = async store => {
    if (SYNC_STORES.includes(store)) markDel(store, (S[store] || []).map(x => x.id));
    await _clear(store);
  };
}
function markDirty(store, items) {
  if (!SY) return;
  const now = Date.now();
  if (SYNC_STORES.includes(store)) items.forEach(it => { SY.dirty[store][it.id] = now; delete SY.del[store][it.id]; });
  else if (store === 'meta') items.forEach(it => { if (SYNC_META.includes(it.k)) SY.dirty.meta[it.k] = now; });
  else return;
  saveSY(); scheduleSync();
}
function markDel(store, ids) {
  if (!SY || !SYNC_STORES.includes(store)) return;
  const now = Date.now();
  ids.forEach(id => { SY.del[store][id] = now; delete SY.dirty[store][id]; });
  saveSY(); scheduleSync();
}
let _sySave = null;
function saveSY() { clearTimeout(_sySave); _sySave = setTimeout(() => _put('meta', { k: 'sync', v: SY }), 300); }
const pendingCount = () => !SY ? 0 : SYNC_STORES.reduce((n, s) => n + Object.keys(SY.dirty[s]).length + Object.keys(SY.del[s]).length, 0) + Object.keys(SY.dirty.meta).length;

/* ---------- Início ---------- */
async function syncStart() {
  const rows = await DB.all('meta');
  const r = rows.find(m => m.k === 'sync');
  SY = Object.assign(emptySY(), r ? r.v : {});
  if (!SY.seeded) {
    // Primeira vez com a nuvem neste aparelho: tudo o que já existe aqui fica pendente de envio.
    // Configurações (meta) vão com data 0: se a nuvem já tiver, a da nuvem vence.
    S.folders.forEach(f => { SY.dirty.folders[f.id] = f.updatedAt || f.createdAt || 1; });
    S.cards.forEach(c => { SY.dirty.cards[c.id] = c.updatedAt || 1; });
    SYNC_META.forEach(k => { SY.dirty.meta[k] = 0; });
    SY.seeded = true; saveSY();
  }
  if (!sb) { SYNC_UI.status = 'nolib'; renderNav(); return; }
  sb.auth.onAuthStateChange((ev, session) => {
    const u = session?.user || null;
    const changed = (u?.id || null) !== (SYNC_USER?.id || null);
    SYNC_USER = u;
    SYNC_UI.status = u ? 'on' : 'off';
    if (u && SY.userId && SY.userId !== u.id) {
      // Outra conta: recomeça a sincronização do zero (sem apagar dados locais)
      const keep = SY; SY = emptySY(); SY.seeded = true;
      S.folders.forEach(f => { SY.dirty.folders[f.id] = f.updatedAt || 1; });
      S.cards.forEach(c => { SY.dirty.cards[c.id] = c.updatedAt || 1; });
      SYNC_META.forEach(k => { SY.dirty.meta[k] = 0; });
      void keep;
    }
    if (u) { SY.userId = u.id; saveSY(); }
    if (changed) { refreshUI(); if (u) syncNow(); }
  });
  setInterval(() => { if (SYNC_USER && navigator.onLine) syncNow(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && SYNC_USER) syncNow(); });
  window.addEventListener('online', () => { if (SYNC_USER) syncNow(); });
}

let _syT = null;
function scheduleSync() { if (!SYNC_USER) return; clearTimeout(_syT); _syT = setTimeout(syncNow, 2500); }

let _syRunning = null, _syAgain = false;
async function syncNow({ quiet = true } = {}) {
  if (!sb || !SYNC_USER || !SY) return;
  if (_syRunning) { _syAgain = true; return _syRunning; }
  _syRunning = (async () => {
    SYNC_UI.busy = true; renderNav();
    try {
      const first = !SY.lastPull;
      if (first) await pull(true);       // aparelho novo: primeiro baixa, depois envia
      await push();
      const changed = await pull(false);
      const got = await processEntrada();
      SYNC_UI.err = null; SYNC_UI.last = Date.now();
      if (changed || got) refreshUI();
      if (!quiet) toast('Sincronizado ☁');
    } catch (err) {
      console.error('sync', err);
      SYNC_UI.err = err.message || String(err);
      if (!quiet) toast('Não deu para sincronizar: ' + SYNC_UI.err);
    } finally {
      SYNC_UI.busy = false; renderNav();
      _syRunning = null;
      if (_syAgain) { _syAgain = false; setTimeout(syncNow, 500); }
    }
  })();
  return _syRunning;
}

/* ---------- Enviar ---------- */
async function push() {
  const uidv = SYNC_USER.id;
  for (const store of SYNC_STORES) {
    const snap = { ...SY.dirty[store] }, snapDel = { ...SY.del[store] };
    const rows = [];
    for (const id of Object.keys(snap)) {
      const it = S[store].find(x => x.id === id);
      if (it) rows.push({ user_id: uidv, id, data: it, updated_at: it.updatedAt || snap[id] || Date.now(), deleted: false });
    }
    for (const id of Object.keys(snapDel)) rows.push({ user_id: uidv, id, data: null, updated_at: snapDel[id], deleted: true });
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await sb.from(store).upsert(rows.slice(i, i + 100), { onConflict: 'user_id,id' });
      if (error) throw error;
    }
    // limpa só o que não mudou de novo durante o envio
    Object.keys(snap).forEach(id => { if (SY.dirty[store][id] === snap[id]) delete SY.dirty[store][id]; });
    Object.keys(snapDel).forEach(id => { if (SY.del[store][id] === snapDel[id]) delete SY.del[store][id]; });
  }
  const snapM = { ...SY.dirty.meta };
  const mrows = Object.keys(snapM).filter(k => S.meta[k] != null).map(k => ({ user_id: uidv, k, v: S.meta[k], updated_at: Date.now() }));
  if (mrows.length) {
    const { error } = await sb.from('meta').upsert(mrows, { onConflict: 'user_id,k' });
    if (error) throw error;
  }
  Object.keys(snapM).forEach(k => { if (SY.dirty.meta[k] === snapM[k]) delete SY.dirty.meta[k]; });
  saveSY();
}

/* ---------- Baixar ---------- */
async function fetchSince(table, cols, since) {
  const out = []; let from = 0;
  for (;;) {
    let q = sb.from(table).select(cols).order('synced_at', { ascending: true }).range(from, from + 999);
    if (since) q = q.gt('synced_at', since);
    const { data, error } = await q; if (error) throw error;
    out.push(...data); if (data.length < 1000) break; from += 1000;
  }
  return out;
}
async function pull(first) {
  const since = SY.lastPull; let maxSync = since, changed = false;
  const bump = s => { if (!maxSync || s > maxSync) maxSync = s; };
  for (const store of SYNC_STORES) {
    const rows = await fetchSince(store, 'id,data,updated_at,deleted,synced_at', since);
    const puts = [], dels = [];
    for (const row of rows) {
      bump(row.synced_at);
      const i = S[store].findIndex(x => x.id === row.id), local = i >= 0 ? S[store][i] : null;
      const localTs = SY.dirty[store][row.id] != null ? (local?.updatedAt || SY.dirty[store][row.id]) : SY.del[store][row.id];
      if (localTs != null && localTs > row.updated_at) continue; // a versão daqui é mais nova: ela vai pra nuvem
      delete SY.dirty[store][row.id]; delete SY.del[store][row.id];
      if (row.deleted) { if (i >= 0) { S[store].splice(i, 1); dels.push(row.id); } }
      else if (row.data) { if (i >= 0) S[store][i] = row.data; else S[store].push(row.data); puts.push(row.data); }
      changed = true;
    }
    if (puts.length) await _put(store, puts);
    if (dels.length) await _del(store, dels);
  }
  const mrows = await fetchSince('meta', 'k,v,updated_at,synced_at', since);
  for (const row of mrows) {
    bump(row.synced_at);
    if (!SYNC_META.includes(row.k)) continue;
    const dirtyTs = SY.dirty.meta[row.k];
    if (!first && dirtyTs != null && dirtyTs > row.updated_at) continue;
    if (row.k === 'stats') {
      // estatísticas: junta os dias dos dois lados
      const remote = row.v?.days || {}, days = { ...(S.meta.stats?.days || {}) };
      Object.entries(remote).forEach(([d, n]) => { days[d] = Math.max(days[d] || 0, n); });
      S.meta.stats = { ...(row.v || {}), days };
      // só reenvia se aqui tinha dias/contagens que a nuvem ainda não tem
      const differs = Object.keys(days).some(d => days[d] !== remote[d]);
      if (differs) SY.dirty.meta.stats = Date.now(); else delete SY.dirty.meta.stats;
    } else if (row.k === 'pmpe') {
      S.meta.pmpe = Object.assign(defaultPmpe(), row.v || {});
      delete SY.dirty.meta.pmpe;
    }
    await _put('meta', { k: row.k, v: S.meta[row.k] });
    changed = true;
  }
  SY.lastPull = maxSync || SY.lastPull || new Date(0).toISOString();
  saveSY();
  return changed;
}

/* ---------- Caixa de entrada do Claude ---------- */
async function processEntrada() {
  const { data, error } = await sb.from('entrada').select('id,tipo,payload,created_at').is('processed_at', null).order('id');
  if (error) throw error;
  if (!data.length) return 0;
  let nc = 0, ne = 0, ns = 0;
  for (const row of data) {
    try {
      const tipo = String(row.tipo || '').toLowerCase();
      if (tipo === 'simulado' || (row.payload && (row.payload.questoes || row.payload.questions))) {
        await simuladoFromClaude(row.payload); ns++;
      } else {
        const r = await importData(row.payload); if (r) { nc += r.nc || 0; ne += r.ne || 0; }
      }
      await sb.from('entrada').update({ processed_at: new Date().toISOString() }).eq('id', row.id);
    } catch (err) { console.error('entrada', row.id, err); }
  }
  const parts = [nc && `${nc} flashcards`, ne && `${ne} erros`, ns && `${ns} simulado${ns > 1 ? 's' : ''}`].filter(Boolean);
  if (parts.length) toast(`✨ Chegou do Claude: ${parts.join(', ')}`);
  return nc + ne + ns;
}
async function simuladoFromClaude(payload) {
  const res = parseSimAnalysis(payload);
  const r = {}; OBJ_IDS.forEach(m => { r[m] = res.q.filter(x => x.m === m && x.ok).length; });
  const sims = P().simulados;
  sims.push({ id: uid(), nome: res.nome || 'Simulado ' + String(sims.length + 1).padStart(2, '0'),
    data: /^\d{4}-\d{2}-\d{2}$/.test(res.data || '') ? res.data : todayKey(), r, q: res.q,
    red: res.red == null ? null : Math.min(40, Math.max(0, +res.red || 0)), obs: 'Lançado pelo Claude' });
  await savePmpe();
}

function refreshUI() {
  if (S.session || (typeof ED !== 'undefined' && ED) || !$('#modal').classList.contains('hidden')) { renderNav(); return; }
  render();
}

/* ---------- Tela de conta / nuvem ---------- */
function syncFoot() {
  if (!sb) return 'Dados salvos neste aparelho (nuvem indisponível)';
  if (!SYNC_USER) return '<a class="foot-link" data-nav="conta">☁ Entrar para sincronizar</a>';
  const p = pendingCount();
  return `<a class="foot-link" data-nav="conta">${SYNC_UI.busy ? '⟳ Sincronizando...' : SYNC_UI.err ? '⚠ Erro ao sincronizar' : p ? `☁ ${p} pendentes` : '☁ Sincronizado'}</a>`;
}
function viewConta() {
  if (!sb) return `<h1>Nuvem</h1><div class="empty">Não consegui carregar a parte da nuvem. Verifique a internet e recarregue o app.</div>`;
  if (!SYNC_USER) return `
    <h1>Entrar na nuvem</h1>
    <p class="sub">Com login, seus cards, edital, ciclo e simulados ficam salvos na nuvem e iguais no computador, tablet e iPhone.
      E o Claude do projeto ESTUDOS consegue lançar os cards direto aqui.</p>
    <div class="card-box" style="max-width:440px">
      <div class="field"><label>E-mail</label><input class="input" type="email" id="au-email" autocomplete="email" inputmode="email"></div>
      <div class="field"><label>Senha (mínimo 6 caracteres)</label><input class="input" type="password" id="au-pass" autocomplete="current-password"></div>
      <div class="row"><button class="btn primary" data-act="au-login">Entrar</button><button class="btn" data-act="au-signup">Criar conta</button></div>
      <p class="muted small" style="margin-bottom:0">Primeira vez? Clique em <b>Criar conta</b>. Se pedir, confirme pelo link que chega no seu e-mail e depois clique em <b>Entrar</b>.
        Use a mesma conta em todos os aparelhos.</p>
    </div>`;
  const p = pendingCount();
  return `
    <h1>Nuvem</h1>
    <p class="sub">Conectado como <b>${esc(SYNC_USER.email || '')}</b></p>
    <div class="card-box" style="max-width:520px">
      <div class="row"><b>${SYNC_UI.err ? '⚠ Último envio falhou' : p ? `${p} alterações esperando envio` : '✔ Tudo sincronizado'}</b></div>
      <p class="muted small">${SYNC_UI.last ? 'Última sincronização: ' + new Date(SYNC_UI.last).toLocaleString('pt-BR') : 'Ainda não sincronizou nesta sessão.'}
        ${SYNC_UI.err ? `<br>Erro: ${esc(SYNC_UI.err)}` : ''}<br>O app sincroniza sozinho a cada minuto, ao abrir e logo depois de cada alteração.</p>
      <div class="row"><button class="btn primary" data-act="au-sync">Sincronizar agora</button><span class="spacer"></span><button class="btn ghost" data-act="au-logout">Sair</button></div>
    </div>`;
}
async function authAction(kind) {
  const email = ($('#au-email')?.value || '').trim(), password = $('#au-pass')?.value || '';
  if (!email || password.length < 6) return toast('Preencha o e-mail e uma senha de pelo menos 6 caracteres.');
  try {
    if (kind === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { toast('Conta criada! Confirme pelo link no seu e-mail e depois clique em Entrar.'); return; }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    toast('Conectado! Sincronizando...');
  } catch (err) {
    const m = err.message || String(err);
    toast(/invalid login/i.test(m) ? 'E-mail ou senha incorretos.' : /not confirmed/i.test(m) ? 'Confirme seu e-mail pelo link que chegou e tente de novo.' : m);
  }
}
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  switch (el.dataset.act) {
    case 'au-login': authAction('login'); break;
    case 'au-signup': authAction('signup'); break;
    case 'au-sync': syncNow({ quiet: false }); break;
    case 'au-logout':
      if (!confirm('Sair da conta? Os dados continuam neste aparelho, mas param de sincronizar.')) return;
      await sb.auth.signOut(); render(); break;
  }
});
