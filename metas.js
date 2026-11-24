'use strict';
/* =====================================================================
   Revisão do dia + Metas (diária e semanal)
   - Revisão do dia: flashcards de TODO o conteúdo das matérias estudadas hoje
     (blocos do ciclo marcados hoje; se nada foi marcado, as do dia atual do ciclo).
     Dá para trocar as matérias do dia manualmente.
   - Ordem: pendentes dessas matérias → os outros cards delas (novos, fracos,
     revisados há mais tempo) → se faltar, atrasados de outras matérias.
   - Meta diária = quantidade mínima de cards por dia. Depois dela, "Revisar mais".
   - Meta semanal (segunda a domingo).
   - Conta cada card uma vez por dia (repetir o mesmo card não conta de novo).
   Tudo fica em S.meta.pmpe.metas (sincroniza entre aparelhos). Sem IA.
   ===================================================================== */
const METAS_PADRAO = { diaria: 30, semanal: 180 };
const MAIS_LOTE = 10;
const metas = () => ({ ...METAS_PADRAO, ...(P().metas || {}) });
async function setMetas(ch) {
  P().metas = { ...metas(), ...ch };
  await savePmpe(); render();
}
const feitosHoje = () => S.meta.stats.days[todayKey()] || 0;

// Semana de segunda a domingo
function semanaKeys() {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return { k: todayKey(x), dt: x }; });
}
const feitosSemana = () => semanaKeys().reduce((s, x) => s + (S.meta.stats.days[x.k] || 0), 0);
// Dias seguidos batendo a meta diária
function streakMeta() {
  const days = S.meta.stats.days, m = metas().diaria; let n = 0; const d = new Date();
  if ((days[todayKey(d)] || 0) < m) d.setDate(d.getDate() - 1);
  while ((days[todayKey(d)] || 0) >= m) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ------------------------- Matérias do dia ------------------------- */
const matComPasta = m => EDITAL.materias[m] && folderById(P().folders[m]);
function materiasHoje() {
  const p = P(), k = todayKey();
  if (p.hoje && p.hoje.data === k && Array.isArray(p.hoje.mats)) return { mats: p.hoje.mats.filter(matComPasta), manual: true };
  const v = cicloAtual(), s0 = startOfDay(), set = new Set();
  const hojeFeito = key => typeof v.feito[key] === 'number' && v.feito[key] >= s0;
  Object.keys(v.feito).forEach(key => {
    if (!hojeFeito(key)) return;
    const [, d, b] = key.split('-').map(Number), blk = v.dias[d] && v.dias[d][b];
    if (blk && matComPasta(blk.m)) set.add(blk.m);
  });
  const pos = posicao(v);
  if (pos && (!set.size || v.dias[pos.d].some((_, b) => hojeFeito(blkKey(pos.r, pos.d, b)))))
    v.dias[pos.d].forEach(b => { if (matComPasta(b.m)) set.add(b.m); });
  return { mats: [...set], manual: false };
}
async function setMateriasHoje(mats) {
  P().hoje = mats ? { data: todayKey(), mats } : null;
  await savePmpe(); render();
}

/* ------------------------- Fila da revisão do dia ------------------------- */
function poolHoje() {
  const ids = new Set(); const out = [];
  materiasHoje().mats.forEach(m => cardsIn(P().folders[m]).forEach(c => { if (!ids.has(c.id)) { ids.add(c.id); out.push(c); } }));
  return out;
}
function filaDoDia(qtd) {
  const s0 = startOfDay(), ctx = prioContext();
  const naoHoje = c => !(c.lastReview >= s0);
  const pool = poolHoje(), inPool = new Set(pool.map(c => c.id));
  const livres = pool.filter(naoHoje);
  const ord = (l, extra = () => 0) => l.map(c => [c, cardPriority(c, ctx) + extra(c)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  // pendentes primeiro; depois os não pendentes: novos e revisados há mais tempo sobem
  const fila = [...ord(livres.filter(isDue)),
    ...ord(livres.filter(c => !isDue(c)), c => c.lastReview ? Math.min(30, (Date.now() - c.lastReview) / DAY) / 10 : 1.5)];
  if (fila.length < qtd) fila.push(...ord(S.cards.filter(c => naoHoje(c) && isDue(c) && !inPool.has(c.id))));
  return fila.slice(0, qtd);
}
function iniciarDoDia(mais = false) {
  const falta = Math.max(0, metas().diaria - feitosHoje());
  const qtd = mais || !falta ? MAIS_LOTE : falta;
  const list = filaDoDia(qtd);
  if (!list.length) return toast(poolHoje().length ? 'Você já revisou todos os cards das matérias de hoje! 🎉' : 'As matérias de hoje ainda não têm flashcards.');
  const nomes = materiasHoje().mats.map(m => EDITAL.materias[m].curto).join(', ');
  startSession({ list, title: (falta && !mais ? 'Revisão do dia' : 'Revisão extra') + (nomes ? ' · ' + nomes : ''), keepOrder: true });
  S.session.daily = true;
}

/* ------------------------- Blocos de tela ------------------------- */
function metaBar(v, max, cor) {
  const x = Math.min(1, v / Math.max(1, max));
  return `<div class="pbar"><div style="width:${Math.round(x * 100)}%;${cor ? `background:${cor}` : x >= 1 ? 'background:var(--facil)' : ''}"></div></div>`;
}
function chipsMaterias(sel) {
  return MAT_IDS.filter(matComPasta).map(m => { const M = EDITAL.materias[m], on = sel.includes(m);
    return `<button class="mchip ${on ? 'on' : ''}" data-act="dia-mat" data-m="${m}" style="--c:${M.cor}">${esc(M.curto)}</button>`; }).join('');
}
// Caixa principal (Início e Revisar)
function dailyBox() {
  if (!S.meta.pmpe || !P().ciclo) return '';
  const mt = metas(), hoje = feitosHoje(), sem = feitosSemana();
  const { mats, manual } = materiasHoje(), pool = poolHoje();
  const bateu = hoje >= mt.diaria, falta = Math.max(0, mt.diaria - hoje);
  const dueGeral = dueOf(null).length;
  return `<div class="hero daily">
    <div>
      <div class="row" style="margin-bottom:4px"><h3 style="margin:0">${bateu ? 'Meta do dia batida! 🎉' : '🃏 Revisão do dia'}</h3><span class="spacer"></span>
        <button class="btn ghost sm" data-nav="metas">🎯 Metas</button></div>
      <p class="small">${mats.length ? `Matérias de hoje${manual ? ' (escolhidas por você)' : ' (pelo ciclo)'}: <b>${mats.map(m => esc(EDITAL.materias[m].curto)).join(', ')}</b> · ${pool.length} cards no total`
        : 'Nenhuma matéria definida para hoje. Escolha abaixo ou marque os blocos do ciclo.'}</p>
      <div class="row daily-num"><b>${hoje}</b><span class="muted">de ${mt.diaria} cards hoje</span><span class="spacer"></span><span class="muted small">Semana: ${sem}/${mt.semanal}</span></div>
      ${metaBar(hoje, mt.diaria)}
      <details class="dia-pick" ${mats.length ? '' : 'open'}><summary class="small">Trocar matérias de hoje</summary>
        <div class="mchips">${chipsMaterias(mats)}</div>
        ${manual ? '<button class="btn ghost sm" data-act="dia-auto">↺ Voltar para as matérias do ciclo</button>' : ''}</details>
    </div>
    <div class="daily-acts">
      ${!bateu ? `<button class="btn primary lg" data-act="dia-start" ${mats.length ? '' : 'disabled'}>Começar (${filaDoDia(falta).length} cards)</button>`
        : `<button class="btn primary lg" data-act="dia-mais">+ Revisar mais ${MAIS_LOTE}</button>`}
      ${dueGeral ? `<button class="btn" data-act="start" data-mode="due">Revisão geral · ${dueGeral} pendentes</button>` : ''}
    </div>
  </div>`;
}
// Gráfico da semana
function semanaChart() {
  const mt = metas(), ks = semanaKeys(), hk = todayKey();
  const max = Math.max(mt.diaria, ...ks.map(x => S.meta.stats.days[x.k] || 0));
  return `<div class="forecast week">${ks.map(x => { const n = S.meta.stats.days[x.k] || 0, ok = n >= mt.diaria;
    return `<div class="col ${x.k === hk ? 'today' : ''}"><div class="n">${n}</div><div class="bar ${ok ? 'ok' : ''}" style="height:${(n / max) * 80}%"></div>
      <div class="d">${x.k === hk ? 'Hoje' : x.dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</div></div>`; }).join('')}</div>
    <p class="muted small" style="margin:8px 0 0"><span class="lg-dot ok"></span> bateu a meta de ${mt.diaria} · <span class="lg-dot"></span> abaixo da meta</p>`;
}

/* ------------------------- Aba Metas ------------------------- */
function viewMetas() {
  const mt = metas(), hoje = feitosHoje(), sem = feitosSemana();
  const ks = semanaKeys(), hk = todayKey(), idx = ks.findIndex(x => x.k === hk);
  const diasRest = 7 - idx; // inclui hoje
  const faltaSem = Math.max(0, mt.semanal - sem);
  const ritmo = Math.ceil(faltaSem / Math.max(1, diasRest));
  const { mats, manual } = materiasHoje();
  return `
  <h1>Metas</h1>
  <p class="sub">Uma quantidade mínima de flashcards por dia e por semana. Bateu a meta? Dá para revisar mais quando quiser.</p>
  <div class="grid-2">
    <div class="card-box"><div class="muted small">Hoje</div>
      <div class="row" style="margin:4px 0 8px"><b class="big-pct">${hoje}</b><span class="muted">de ${mt.diaria} cards</span><span class="spacer"></span>
        ${hoje >= mt.diaria ? '<span class="pill ok">✔ meta batida</span>' : `<span class="pill due">faltam ${mt.diaria - hoje}</span>`}</div>
      ${metaBar(hoje, mt.diaria)}</div>
    <div class="card-box"><div class="muted small">Esta semana (seg a dom)</div>
      <div class="row" style="margin:4px 0 8px"><b class="big-pct">${sem}</b><span class="muted">de ${mt.semanal} cards</span><span class="spacer"></span>
        ${sem >= mt.semanal ? '<span class="pill ok">✔ meta batida</span>' : `<span class="pill due">faltam ${faltaSem}</span>`}</div>
      ${metaBar(sem, mt.semanal)}
      <p class="muted small" style="margin:8px 0 0">${sem >= mt.semanal ? 'Semana garantida! 💪' : `Para bater a semana: <b>${ritmo} cards por dia</b> até domingo.`}</p></div>
  </div>
  <div class="row" style="margin:14px 0 0">
    <button class="btn primary" data-act="${hoje >= mt.diaria ? 'dia-mais' : 'dia-start'}" ${mats.length ? '' : 'disabled'}>${hoje >= mt.diaria ? `+ Revisar mais ${MAIS_LOTE}` : 'Começar revisão do dia'}</button>
    <span class="muted small">🔥 ${streakMeta()} ${streakMeta() === 1 ? 'dia seguido' : 'dias seguidos'} batendo a meta</span></div>

  <h2>Sua semana</h2>
  <div class="card-box">${semanaChart()}</div>

  <h2>Ajustar metas</h2>
  <div class="grid-2">
    <div class="card-box"><b>Meta diária</b><p class="muted small" style="margin:2px 0 12px">Mínimo de cards por dia.</p>
      <div class="stepper">
        <button class="btn" data-act="meta-step" data-k="diaria" data-v="-5">−5</button>
        <input class="input" type="number" inputmode="numeric" min="5" max="500" id="meta-diaria" value="${mt.diaria}">
        <button class="btn" data-act="meta-step" data-k="diaria" data-v="5">+5</button></div>
      <div class="row" style="margin-top:10px">${[15, 20, 30, 40, 50].map(n => `<button class="btn sm ${n === mt.diaria ? 'on' : ''}" data-act="meta-set" data-k="diaria" data-v="${n}">${n}</button>`).join('')}</div></div>
    <div class="card-box"><b>Meta semanal</b><p class="muted small" style="margin:2px 0 12px">Total de cards de segunda a domingo.</p>
      <div class="stepper">
        <button class="btn" data-act="meta-step" data-k="semanal" data-v="-10">−10</button>
        <input class="input" type="number" inputmode="numeric" min="10" max="3500" id="meta-semanal" value="${mt.semanal}">
        <button class="btn" data-act="meta-step" data-k="semanal" data-v="10">+10</button></div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" data-act="meta-set" data-k="semanal" data-v="${mt.diaria * 6}">Diária × 6 = ${mt.diaria * 6} (1 dia de folga)</button>
        <button class="btn sm" data-act="meta-set" data-k="semanal" data-v="${mt.diaria * 7}">Diária × 7 = ${mt.diaria * 7}</button></div></div>
  </div>

  <h2>Matérias de hoje</h2>
  <div class="card-box">
    <p class="muted small" style="margin:0 0 10px">${manual ? 'Você escolheu as matérias de hoje.' : 'Automático: as matérias dos blocos do ciclo que você marcou hoje (ou do dia atual do ciclo).'}
      A revisão do dia usa os flashcards de <b>todo o conteúdo</b> dessas matérias.</p>
    <div class="mchips">${chipsMaterias(mats)}</div>
    ${manual ? '<button class="btn ghost sm" style="margin-top:10px" data-act="dia-auto">↺ Voltar para as matérias do ciclo</button>' : ''}
  </div>
  <p class="muted small" style="margin-top:14px"><b>Como funciona:</b> a revisão do dia pega primeiro os cards pendentes das matérias de hoje, depois os outros cards delas
    (os novos, os dos assuntos fracos e os revisados há mais tempo). Se faltar card, completa com atrasados de outras matérias.
    Cada card conta 1 vez por dia. Revisar antes da hora e marcar Médio/Fácil não bagunça o agendamento: o card mantém a data que já tinha.</p>`;
}

/* ------------------------- Eventos ------------------------- */
const clampMeta = (k, n) => k === 'diaria' ? Math.min(500, Math.max(5, n)) : Math.min(3500, Math.max(10, n));
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'dia-start': iniciarDoDia(false); break;
    case 'dia-mais': iniciarDoDia(true); break;
    case 'dia-again': endSession(); iniciarDoDia(feitosHoje() >= metas().diaria); break;
    case 'dia-auto': setMateriasHoje(null); break;
    case 'dia-mat': {
      const cur = materiasHoje().mats, m = d.m;
      setMateriasHoje(cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]); break;
    }
    case 'meta-step': setMetas({ [d.k]: clampMeta(d.k, metas()[d.k] + +d.v) }); break;
    case 'meta-set': setMetas({ [d.k]: clampMeta(d.k, +d.v) }); toast('Meta atualizada.'); break;
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'meta-diaria' || e.target.id === 'meta-semanal') {
    const k = e.target.id.slice(5), n = parseInt(e.target.value);
    if (n > 0) { setMetas({ [k]: clampMeta(k, n) }); toast('Meta atualizada.'); }
  }
});
