'use strict';
/* =====================================================================
   Aba "Gerar": atalhos para os projetos do Claude (claude.ai).
   Os flashcards, erros e simulados são criados no chat do projeto (sem custo extra,
   usa a assinatura) e o próprio Claude lança no app pelo banco de dados na nuvem.
   Nada aqui chama a IA nem gasta tokens.
   ===================================================================== */

// Cada atalho abre o projeto certo. "usa" = qual link usar se este não tiver o seu próprio.
const ATALHOS = [
  { k: 'flash', ico: '🃏', titulo: 'Criar flashcards', projeto: 'Flashcards PMPE banca OCP',
    desc: 'Mande um PDF, resumo, lei seca ou print de material. O Claude cria os cards na matéria e no assunto certos do edital.' },
  { k: 'erro', ico: '✎', titulo: 'Questão que errei', projeto: 'Flashcards PMPE banca OCP', usa: 'flash',
    desc: 'Mande o print da questão e diga o que marcou. Vira card do Caderno de Erros, com a explicação.' },
  { k: 'simulado', ico: '📝', titulo: 'Simulado e questões', projeto: 'Material de questões PMPE AOCP',
    desc: 'Mande o PDF do simulado corrigido. O Claude separa acertos por matéria e por assunto para o app.' },
  { k: 'ciclo', ico: '◷', titulo: 'Conversar sobre o ciclo', projeto: 'Ciclo de estudos de 7 dias',
    desc: 'Tire dúvidas sobre o plano, peça ajustes ou dicas. (O próximo ciclo é gerado no próprio app, sem IA.)' },
  { k: 'novo', ico: '＋', titulo: 'Nova conversa', projeto: 'projeto ESTUDOS',
    desc: 'Começa uma conversa nova no projeto ESTUDOS, já com todas as instruções da PMPE.' },
];
// Links padrão: conversas do projeto ESTUDOS no claude.ai (podem ser trocados em "Links dos projetos")
const LINKS_PADRAO = {
  flash: 'https://claude.ai/chat/f97c83a9-109c-4745-bfaa-a6d877902a15',
  simulado: 'https://claude.ai/chat/3209fc8b-2bea-436e-a403-e49b7d5ec9ae',
  ciclo: 'https://claude.ai/chat/3bf28d62-fad6-4835-9794-d45742678192',
  novo: 'https://claude.ai/project/01a1ef41-664b-7631-901f-7d22dd38b390',
};
const linksClaude = () => (P().claude = P().claude || {});
const linkDe = k => {
  const L = linksClaude(), a = ATALHOS.find(x => x.k === k);
  return L[k] || (a && a.usa && (L[a.usa] || LINKS_PADRAO[a.usa])) || LINKS_PADRAO[k] || '';
};
const validClaudeLink = u => /^https:\/\/claude\.ai\/\S+$/i.test(String(u || '').trim());

function abrirClaude(k) {
  const url = linkDe(k);
  if (!url) { toast('Configure o link deste projeto primeiro.'); return openLinksClaude(k); }
  window.open(url, '_blank', 'noopener');
}

function viewGerar() {
  const algum = ATALHOS.some(a => linkDe(a.k));
  return `
  <h1>Gerar com o Claude</h1>
  <p class="sub">Toque no que você quer fazer. O app abre o projeto certo no Claude; é só mandar o arquivo ou o print.
    O que o Claude criar aparece aqui sozinho.</p>
  ${!algum ? `<div class="alert warn" style="margin:0 0 16px"><div class="grow"><b>Falta configurar os links dos seus projetos.</b><br>
    <span class="small">É uma vez só: cole o endereço de cada projeto do claude.ai.</span></div>
    <button class="btn" data-act="cl-links">Configurar links</button></div>` : ''}
  <div class="gen-grid">${ATALHOS.map(a => {
    const ok = !!linkDe(a.k);
    return `<button class="gen-card ${ok ? '' : 'off'}" data-act="cl-open" data-k="${a.k}">
      <span class="gen-ico">${a.ico}</span>
      <span class="gen-t">${esc(a.titulo)}</span>
      <span class="gen-d">${esc(a.desc)}</span>
      <span class="gen-p">${ok ? `Abrir “${esc(a.projeto)}” ↗` : 'Link não configurado'}</span>
    </button>`;
  }).join('')}</div>
  <p class="muted small">Com a nuvem ligada, o que o Claude salvar aparece aqui sozinho (em até 1 minuto ou ao abrir o app).</p>
  <h2>Configuração</h2>
  <div class="list">
    <div class="item click" data-nav="conta"><div class="grow"><div class="title">☁ Nuvem e 🔔 lembretes</div>
      <div class="meta">Login, sincronização entre aparelhos e notificações de revisão.</div></div><span class="chev">›</span></div>
    <div class="item click" data-act="cl-links"><div class="grow"><div class="title">🔗 Links dos projetos do Claude</div>
      <div class="meta">Já configurados com as conversas do projeto ESTUDOS. Toque para trocar algum.</div></div><span class="chev">›</span></div>
  </div>
  <details class="adv"><summary>Avançado: importar manualmente e backup</summary>${viewImport()}</details>`;
}

function openLinksClaude(foco) {
  const L = linksClaude();
  const campos = ATALHOS.map(a => `<div class="field"><label>${a.ico} ${esc(a.titulo)} → projeto “${esc(a.projeto)}”${a.usa ? ' (opcional: se vazio, usa o de Flashcards)' : ''}</label>
    <input class="input" data-cl="${a.k}" placeholder="${esc(LINKS_PADRAO[a.k] || 'https://claude.ai/chat/...')}" value="${esc(L[a.k] || '')}"></div>`).join('');
  $('#modal').innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3>Links dos projetos do Claude</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <p class="muted small" style="margin-top:0">Já vêm preenchidos com as conversas do seu projeto ESTUDOS. Só preencha se quiser trocar:
        abra a conversa ou o projeto no claude.ai e copie o endereço da barra do navegador. Deixe vazio para usar o padrão.</p>
      ${campos}
    </div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" data-act="cl-save">Salvar</button></div></div>`;
  $('#modal').classList.remove('hidden');
  const el = foco && document.querySelector(`[data-cl="${foco}"]`); if (el) el.focus();
}
async function saveLinksClaude() {
  const L = linksClaude();
  for (const el of document.querySelectorAll('[data-cl]')) {
    const v = el.value.trim();
    if (v && !validClaudeLink(v)) { el.focus(); return toast('Esse link não parece do claude.ai (deve começar com https://claude.ai/).'); }
    if (v) L[el.dataset.cl] = v; else delete L[el.dataset.cl];
  }
  await savePmpe(); closeModal(); render(); toast('Links salvos!');
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'cl-open': abrirClaude(d.k); break;
    case 'cl-links': openLinksClaude(); break;
    case 'cl-save': saveLinksClaude(); break;
  }
});
