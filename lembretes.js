'use strict';
/* =====================================================================
   Aba "Lembretes": notificações de revisão no celular
   - Você define os horários (quantos quiser, ex.: 07:00, 12:30, 19:00).
   - Os horários ficam salvos na sua conta (iguais em todos os aparelhos).
   - Em cada aparelho onde quiser receber, toque em "Ativar neste aparelho".
   - A função "lembrete" no Supabase confere a cada 5 min e manda a notificação
     com os flashcards pendentes/atrasados e o dia do ciclo. Não usa IA.
   No iPhone: só funciona com o app adicionado à Tela de Início (iOS 16.4+).
   ===================================================================== */
const FN_LEMBRETE = SUPA_URL + '/functions/v1/lembrete';
const HORARIOS_SUGERIDOS = ['06:00', '07:00', '12:00', '13:00', '18:00', '19:00', '21:00', '22:00'];
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const PUSH = { sub: null, ativo: false, loaded: false, busy: false };

const b64uToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const normHora = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null; };

// Horários salvos na conta (sincronizados entre aparelhos junto com o progresso)
function getHorarios() {
  const p = S.meta.pmpe; const h = p && p.lembretes && p.lembretes.horarios;
  return Array.isArray(h) ? h.slice() : ['07:00', '19:00'];
}
async function setHorarios(list) {
  const h = [...new Set(list.map(normHora).filter(Boolean))].sort();
  S.meta.pmpe.lembretes = { ...(S.meta.pmpe.lembretes || {}), horarios: h };
  await savePmpe();
  // atualiza todos os aparelhos com lembrete ativo nesta conta
  if (sb && SYNC_USER) {
    const { error } = await sb.from('push_subs').update({ horarios: h }).eq('user_id', SYNC_USER.id);
    if (error) toast('Não salvou na nuvem: ' + error.message);
  }
  render();
}

async function loadPush() {
  if (!pushSupported() || !SYNC_USER) { PUSH.loaded = true; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    PUSH.sub = reg ? await reg.pushManager.getSubscription() : null;
    PUSH.ativo = false;
    if (PUSH.sub) {
      const { data } = await sb.from('push_subs').select('endpoint').eq('endpoint', PUSH.sub.endpoint).maybeSingle();
      PUSH.ativo = !!data;
    }
  } catch (err) { console.error('push', err); }
  PUSH.loaded = true;
  if (['lembretes', 'home'].includes(S.view)) refreshUI();
}

function deviceBox() {
  if (!SYNC_USER) return `<div class="alert warn" style="margin:0"><div class="grow"><b>Entre na nuvem primeiro.</b>
    <span class="small">Os lembretes usam a sua conta para saber o que você tem para revisar.</span></div>
    <button class="btn" data-nav="conta">Entrar</button></div>`;
  if (!pushSupported()) return `<div class="alert warn" style="margin:0"><div class="grow">${isIOS
    ? 'No iPhone, os lembretes só funcionam com o app <b>adicionado à Tela de Início</b> e aberto pelo ícone (iOS 16.4 ou mais novo).'
    : 'Este navegador não aceita notificações. Use o Chrome, o Edge ou o app instalado.'}</div></div>`;
  if (isIOS && !isStandalone()) return `<div class="alert warn" style="margin:0"><div class="grow"><b>Falta um passo no iPhone:</b>
    no Safari, toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>. Depois abra o app pelo ícone e volte nesta aba.</div></div>`;
  const negado = Notification.permission === 'denied';
  if (PUSH.ativo) return `<div class="alert good" style="margin:0"><div class="grow"><b>✔ Lembretes ativos neste aparelho.</b>
    <span class="small">As notificações chegam nos horários abaixo.</span></div>
    <button class="btn" data-act="push-teste">Mandar teste</button><button class="btn ghost" data-act="push-off">Desativar</button></div>`;
  return `<div class="alert warn" style="margin:0"><div class="grow"><b>Lembretes desligados neste aparelho.</b>
    <span class="small">${negado ? 'As notificações estão bloqueadas: libere nos Ajustes do aparelho (Notificações → Flashcards) e tente de novo.' : 'Toque em ativar e permita as notificações.'}</span></div>
    <button class="btn primary" data-act="push-on" ${negado || PUSH.busy ? 'disabled' : ''}>${PUSH.busy ? 'Ativando...' : '🔔 Ativar neste aparelho'}</button></div>`;
}

function viewLembretes() {
  const hs = getHorarios();
  const sugeridos = HORARIOS_SUGERIDOS.filter(h => !hs.includes(h));
  return `
  <h1>Lembretes</h1>
  <p class="sub">Notificações no celular para você não esquecer de revisar e seguir o ciclo.</p>
  ${deviceBox()}
  <h2 class="row">Horários dos lembretes <span class="pill">${hs.length}</span></h2>
  <div class="card-box">
    ${hs.length ? `<div class="list">${hs.map(h => `<div class="item lem-item">
        <span class="lem-hora">${h}</span>
        <div class="grow"><div class="meta">${lemDesc(h)}</div></div>
        <button class="icon-btn" data-act="lem-del" data-h="${h}" title="Remover este horário">✕</button>
      </div>`).join('')}</div>`
      : '<div class="empty" style="padding:20px">Nenhum horário. Adicione pelo menos um abaixo.</div>'}
    <div class="row" style="margin-top:14px">
      <input class="input lem-input" type="time" id="lem-nova" value="20:00" step="300">
      <button class="btn primary" data-act="lem-add">+ Adicionar horário</button>
    </div>
    ${sugeridos.length ? `<div class="row" style="margin-top:10px"><span class="muted small">Atalhos:</span>
      ${sugeridos.map(h => `<button class="btn sm" data-act="lem-quick" data-h="${h}">+ ${h}</button>`).join('')}</div>` : ''}
    <p class="muted small" style="margin-bottom:0">Os horários valem para todos os seus aparelhos com lembrete ativo. A notificação pode chegar até 5 minutos depois do horário.</p>
  </div>
  <h2>O que vem na notificação</h2>
  <div class="card-box lem-preview">
    <div class="lem-notif"><img src="icon-180.png" alt=""><div><b>🔔 Lembrete</b><br>
      <span>Você tem revisões de flashcards pendentes.</span></div></div>
    <p class="muted small" style="margin-bottom:0">Se não houver cards pendentes no dia, a mensagem vira “Lembre-se da sua revisão de flashcards.” Tocar na notificação abre o app.</p>
  </div>`;
}
function lemDesc(h) {
  const n = +h.slice(0, 2);
  return n < 12 ? 'Manhã: começar o dia com a revisão' : n < 18 ? 'Tarde: revisão rápida' : 'Noite: fechar o dia em dia';
}

async function ativarLembretes() {
  if (PUSH.busy) return;
  PUSH.busy = true; render();
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Sem permissão de notificação. Libere nos ajustes e tente de novo.'); return; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await (await fetch(FN_LEMBRETE)).json();
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // se a assinatura antiga for de outra chave, refaz
      const k = sub.options && sub.options.applicationServerKey;
      const atual = k ? btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
      if (atual && atual !== publicKey) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subs').upsert({ endpoint: j.endpoint, user_id: SYNC_USER.id, p256dh: j.keys.p256dh, auth: j.keys.auth,
      horarios: getHorarios(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Recife' }, { onConflict: 'endpoint' });
    if (error) throw error;
    PUSH.sub = sub; PUSH.ativo = true;
    await fetch(FN_LEMBRETE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'teste', endpoint: j.endpoint }) });
    toast('Lembretes ativados! 🔔 Deve chegar uma notificação de teste.');
  } catch (err) {
    console.error(err); toast('Não deu para ativar: ' + (err.message || err));
  } finally { PUSH.busy = false; render(); }
}
async function desativarLembretes() {
  if (!confirm('Desativar os lembretes neste aparelho?')) return;
  try {
    if (PUSH.sub) { await sb.from('push_subs').delete().eq('endpoint', PUSH.sub.endpoint); await PUSH.sub.unsubscribe(); }
  } catch (err) { console.error(err); }
  PUSH.sub = null; PUSH.ativo = false; render(); toast('Lembretes desativados neste aparelho.');
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'push-on': ativarLembretes(); break;
    case 'push-off': desativarLembretes(); break;
    case 'push-teste':
      if (PUSH.sub) fetch(FN_LEMBRETE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'teste', endpoint: PUSH.sub.endpoint }) })
        .then(r => r.json()).then(j => toast(j.ok ? 'Teste enviado! 🔔' : 'O teste falhou. Desative e ative de novo.'))
        .catch(() => toast('Sem internet para mandar o teste.'));
      break;
    case 'lem-add': {
      const h = normHora($('#lem-nova')?.value);
      if (!h) return toast('Escolha um horário válido.');
      if (getHorarios().includes(h)) return toast('Esse horário já está na lista.');
      setHorarios([...getHorarios(), h]).then(() => toast(`Lembrete às ${h} adicionado.`)); break;
    }
    case 'lem-quick': setHorarios([...getHorarios(), d.h]).then(() => toast(`Lembrete às ${d.h} adicionado.`)); break;
    case 'lem-del': setHorarios(getHorarios().filter(h => h !== d.h)).then(() => toast(`Lembrete das ${d.h} removido.`)); break;
  }
});
