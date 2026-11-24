'use strict';
/* =====================================================================
   Edital verticalizado, ciclo de estudos e simulados (PMPE)
   Usa as funções e o estado (S, DB, ...) definidos em app.js.
   Tudo fica salvo em S.meta.pmpe (meta "pmpe" no IndexedDB).
   ===================================================================== */

const RODADAS = 2; // o ciclo de 7 dias é feito 2 vezes = 2 semanas
const ST = [
  { ico: '○', label: 'Falta estudar', cls: 'st-0' },
  { ico: '◐', label: 'Estudando', cls: 'st-1' },
  { ico: '●', label: 'Estudado', cls: 'st-2' },
];
const EXTRA_BLK = { rev: { nome: 'Revisão + questões', cor: '#8b93a7' }, mix: { nome: 'Simulado / questões mistas', cor: '#a855f7' }, out: { nome: 'Outro', cor: '#64748b' } };

const P = () => S.meta.pmpe;
const defaultPmpe = () => ({ seeded: false, folders: {}, topicos: {}, ciclo: null, simulados: [] });
const savePmpe = () => DB.put('meta', { k: 'pmpe', v: S.meta.pmpe });
const pct = x => Math.round((x || 0) * 100) + '%';
const bar = (x, cor) => `<div class="pbar"><div style="width:${Math.round((x || 0) * 100)}%;${cor ? `background:${cor}` : ''}"></div></div>`;
const daysToProva = () => Math.ceil((new Date(EDITAL.prova + 'T08:00:00') - Date.now()) / DAY);
const fmtDate = t => new Date(t).toLocaleDateString('pt-BR');
const blkInfo = m => EDITAL.materias[m] ? { nome: EDITAL.materias[m].nome, cor: EDITAL.materias[m].cor } : (EXTRA_BLK[m] || EXTRA_BLK.out);

/* ------------------------------ Inicialização ------------------------------ */
async function estudoInit(metaRows) {
  const pm = metaRows.find(m => m.k === 'pmpe');
  S.meta.pmpe = Object.assign(defaultPmpe(), pm ? pm.v : {});
  const p = P();
  if (!p.ciclo) {
    const v = novaVersao(CICLO_V3, 'v3', 'Ciclo inicial do edital');
    p.ciclo = { atual: v.id, versoes: [v] };
  }
  await migrateSeedIds();
  if (!p.seeded) { await criarPastasEdital(); p.seeded = true; }
  await savePmpe();
}

/* Nome de pasta a partir do tópico. "/" vira "-" para não virar subpasta na importação. */
const folderName = (n, t) => `${n}${n.includes('.') ? '' : '.'} ${t.replace(/\.$/, '').replace(/\s*\/\s*/g, ' - ')}`;

// Pastas do edital têm id fixo ("pmpe-rl-4.2"): assim são as mesmas em todos os aparelhos (sem duplicar na nuvem)
const seedId = key => 'pmpe-' + key;
async function migrateSeedIds() {
  const p = P(), map = {};
  Object.entries(p.folders).forEach(([k, id]) => { const want = seedId(k); if (id !== want && folderById(id) && !folderById(want)) map[id] = want; });
  const old = Object.keys(map); if (!old.length) return;
  S.folders.forEach(f => { if (map[f.id]) f.id = map[f.id]; if (f.parentId && map[f.parentId]) f.parentId = map[f.parentId]; });
  const cs = S.cards.filter(c => map[c.folderId]); cs.forEach(c => { c.folderId = map[c.folderId]; c.updatedAt = Date.now(); });
  Object.keys(p.folders).forEach(k => { if (map[p.folders[k]]) p.folders[k] = map[p.folders[k]]; });
  await DB.del('folders', old); await DB.put('folders', S.folders); if (cs.length) await DB.put('cards', cs);
}
async function criarPastasEdital() {
  const p = P(); let n = 0;
  for (const m of MAT_IDS) {
    const M = EDITAL.materias[m];
    let root = folderById(p.folders[m]);
    if (!root) {
      root = folderById(seedId(m)) || childrenOf(null).find(f => norm(f.name) === norm(M.nome));
      if (!root) { root = await createFolder(M.nome, null, seedId(m)); n++; }
      root.color = M.cor; await DB.put('folders', root);
      p.folders[m] = root.id;
    }
    for (const [num, txt] of M.topicos) {
      const id = topicId(m, num);
      if (folderById(p.folders[id])) continue;
      const nm = folderName(num, txt);
      let f = folderById(seedId(id)) || childrenOf(root.id).find(x => norm(x.name) === norm(nm));
      if (!f) { f = await createFolder(nm, root.id, seedId(id)); n++; }
      p.folders[id] = f.id;
    }
  }
  return n;
}

/* ------------------------------ Edital ------------------------------ */
const tState = id => P().topicos[id] || { s: 0, q: 0, a: 0, nota: '' };
const stValue = s => s === 2 ? 1 : s === 1 ? 0.5 : 0;
const allTopics = () => MAT_IDS.flatMap(m => EDITAL.materias[m].topicos.map(([n, t, p]) => ({ m, n, t, p, id: topicId(m, n) })));
function matProgress(m) {
  const ts = EDITAL.materias[m].topicos;
  return ts.reduce((s, [n]) => s + stValue(tState(topicId(m, n)).s), 0) / ts.length;
}
function editalProgress() {
  const all = allTopics();
  return all.reduce((s, x) => s + stValue(tState(x.id).s), 0) / all.length;
}
const topicCards = id => { const f = folderById(P().folders[id]); return f ? cardsIn(f.id).length : 0; };

let SIM_T = {}; // resultado por assunto do último simulado com análise
function viewEdital() {
  const all = allTopics(), f = S.edFilter || 'all';
  const lastQ = P().simulados.filter(s => s.q && s.q.length).sort((a, b) => b.data.localeCompare(a.data))[0];
  SIM_T = lastQ ? simTopics(lastQ) : {};
  const cnt = s => all.filter(x => tState(x.id).s === s).length;
  const alta = all.filter(x => x.p === 'a'), altaOk = alta.filter(x => tState(x.id).s === 2).length;
  const dias = daysToProva();
  const match = x => {
    const s = tState(x.id).s;
    return f === 'all' || (f === 'falta' && s === 0) || (f === 'andamento' && s === 1) || (f === 'estudado' && s === 2) || (f === 'alta' && x.p === 'a' && s !== 2);
  };
  return `
  <div class="page-head"><div><h1>Edital verticalizado</h1>
    <p class="sub">${esc(EDITAL.titulo)} · ${esc(EDITAL.banca)} · prova em ${fmtDate(EDITAL.prova + 'T12:00')}${dias > 0 ? ` · faltam <b>${dias} dias</b>` : ''}</p></div>
    <button class="btn" data-act="ed-folders" title="Cria as pastas de matérias/tópicos que tiverem sido apagadas">Criar pastas que faltam</button></div>
  <div class="card-box">
    <div class="row"><b class="big-pct">${pct(editalProgress())}</b><span class="muted">do edital concluído</span><span class="spacer"></span>
      <span class="pill st-2">● ${cnt(2)} estudados</span><span class="pill st-1">◐ ${cnt(1)} estudando</span><span class="pill">○ ${cnt(0)} faltam</span></div>
    ${bar(editalProgress())}
    <p class="muted small" style="margin:10px 0 0">Prioridade alta: <b>${altaOk} de ${alta.length}</b> estudados. ${esc(EDITAL.regras)}</p>
  </div>
  <div class="seg" style="margin:16px 0 4px">${[['all', 'Todos'], ['falta', 'Falta estudar'], ['andamento', 'Estudando'], ['estudado', 'Estudados'], ['alta', 'Alta prioridade pendente']]
    .map(([k, l]) => `<button data-act="ed-filter" data-v="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${EDITAL.blocos.map(b => `<h2>${esc(b.nome)} <span class="muted small">· ${b.questoes ? b.questoes + ' questões' : b.pontos + ' pontos'}</span></h2>
    <div class="list">${b.materias.map(m => materiaBox(m, match)).join('')}</div>`).join('')}
  <p class="muted small" style="margin-top:18px">Toque no círculo para mudar a situação: ○ falta → ◐ estudando → ● estudado.
    Toque no tópico para anotar questões feitas, acertos e abrir os flashcards dele.</p>`;
}
function materiaBox(m, match) {
  const M = EDITAL.materias[m];
  const filtering = S.edFilter && S.edFilter !== 'all';
  const ts = M.topicos.map(([n, t, p]) => ({ m, n, t, p, id: topicId(m, n) })).filter(match);
  if (filtering && !ts.length) return '';
  const open = filtering || (S.edOpen && S.edOpen.has(m));
  const fid = P().folders[m], nCards = folderById(fid) ? cardsIn(fid).length : 0;
  const done = M.topicos.filter(([n]) => tState(topicId(m, n)).s === 2).length;
  return `<div class="mat-box ${open ? 'open' : ''}">
    <div class="mat-head" data-act="ed-toggle" data-m="${m}">
      <span class="mat-dot" style="background:${M.cor}"></span>
      <div class="grow"><div class="title">${esc(M.nome)}</div>
        <div class="meta">${done}/${M.topicos.length} tópicos estudados · ${M.questoes ? M.questoes + ' questões' : M.pontos + ' pontos'} · ${nCards} cards</div>
        ${bar(matProgress(m), M.cor)}</div>
      <b class="mat-pct">${pct(matProgress(m))}</b><span class="chev">${open ? '▾' : '▸'}</span>
    </div>
    ${open ? `<div class="topics">${ts.map(topicRow).join('')}</div>` : ''}
  </div>`;
}
function topicRow(x) {
  const st = tState(x.id), n = topicCards(x.id);
  const sim = SIM_T[x.id];
  const meta = [st.q ? `${st.a}/${st.q} questões (${pct(st.a / st.q)})` : '',
    sim ? `<span class="${sim.a < sim.q ? 'late-txt' : 'up'}">último simulado: ${sim.a}/${sim.q}</span>` : '',
    n ? `${n} cards` : '', st.nota ? '📝 anotação' : ''].filter(Boolean).join(' · ');
  return `<div class="topic ${x.n.includes('.') ? 'sub' : ''}" data-act="topic-open" data-id="${x.id}">
    <button class="st ${ST[st.s].cls}" data-act="topic-cycle" data-id="${x.id}" title="${ST[st.s].label}">${ST[st.s].ico}</button>
    <div class="grow"><span class="tn">${esc(x.n)}</span> ${esc(x.t)}${meta ? `<div class="meta">${meta}</div>` : ''}</div>
    <span class="pill ${PRIO[x.p].cls}">${PRIO[x.p].label}</span>
  </div>`;
}

let TP = null; // tópico aberto no modal
function openTopic(id) {
  const x = allTopics().find(t => t.id === id); if (!x) return;
  const st = tState(id), M = EDITAL.materias[x.m];
  const fid = P().folders[id], f = folderById(fid), n = f ? cardsIn(fid).length : 0, due = f ? dueOf(fid).length : 0;
  TP = { id, s: st.s };
  $('#modal').innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3 style="color:${M.cor}">${esc(M.nome)}</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <p style="margin-top:0;font-size:16px"><b>${esc(x.n)}</b> ${esc(x.t)}</p>
      <p style="margin-top:-4px"><span class="pill ${PRIO[x.p].cls}">Prioridade ${PRIO[x.p].label.toLowerCase()}</span></p>
      <div class="field"><label>Situação</label><div class="seg" id="tp-seg">${ST.map((s, i) => `<button data-act="tp-st" data-v="${i}" class="${st.s === i ? 'on' : ''}">${s.ico} ${s.label}</button>`).join('')}</div></div>
      <div class="grid-2">
        <div class="field"><label>Questões feitas</label><input class="input" type="number" min="0" inputmode="numeric" id="tp-q" value="${st.q || ''}"></div>
        <div class="field"><label>Acertos</label><input class="input" type="number" min="0" inputmode="numeric" id="tp-a" value="${st.a || ''}"></div>
      </div>
      <div class="field"><label>Anotações</label><textarea class="input" id="tp-nota" rows="3" placeholder="Ex.: revisar exceções, ver lei seca...">${esc(st.nota || '')}</textarea></div>
      ${f ? `<div class="row">
        <button class="btn" data-act="tp-folder">Abrir pasta (${n} cards)</button>
        <button class="btn" data-act="tp-new-card">+ Flashcard</button>
        <button class="btn" data-act="tp-review" ${n ? '' : 'disabled'}>Revisar${due ? ` (${due})` : ''}</button></div>`
      : '<p class="muted small">A pasta deste tópico foi apagada. Use “Criar pastas que faltam”.</p>'}
    </div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" data-act="tp-save">Salvar</button></div></div>`;
  $('#modal').classList.remove('hidden');
}
async function saveTopic() {
  if (!TP) return;
  const q = Math.max(0, parseInt($('#tp-q').value) || 0);
  const a = Math.min(q, Math.max(0, parseInt($('#tp-a').value) || 0));
  P().topicos[TP.id] = { s: TP.s, q, a, nota: $('#tp-nota').value.trim() };
  await savePmpe();
}

/* ------------------------------ Ciclo ------------------------------ */
function novaVersao(dias, nome, origem) {
  return { id: uid(), nome, origem, criadoEm: Date.now(), inicio: Date.now(), feito: {},
    dias: dias.map(d => d.map(([m, l, t]) => (t && t.length ? { m, l, t } : { m, l }))) };
}
const cicloAtual = () => { const c = P().ciclo; return c.versoes.find(v => v.id === c.atual) || c.versoes[c.versoes.length - 1]; };
const blkKey = (r, d, b) => `${r}-${d}-${b}`;
function cycleProgress(v) {
  const total = RODADAS * v.dias.reduce((s, d) => s + d.length, 0);
  return Object.values(v.feito).filter(Boolean).length / total;
}
function posicao(v) {
  for (let r = 0; r < RODADAS; r++) for (let d = 0; d < v.dias.length; d++)
    if (v.dias[d].some((_, b) => !v.feito[blkKey(r, d, b)])) return { r, d };
  return null;
}

/* Calendário do ciclo: cada dia do ciclo tem uma data prevista a partir do início.
   Atraso = quantos dias a data de hoje já passou do próximo dia pendente. */
const cicloDayIdx = (r, d) => r * 7 + d;
const cicloDate = (v, r, d) => startOfDay(v.inicio) + cicloDayIdx(r, d) * DAY;
function cicloStatus(v) {
  const pos = posicao(v);
  const hoje = Math.round((startOfDay() - startOfDay(v.inicio)) / DAY);
  if (!pos) return { pos, atraso: 0, adiant: 0, hoje };
  const p = cicloDayIdx(pos.r, pos.d);
  return { pos, atraso: Math.max(0, hoje - p), adiant: Math.max(0, p - hoje), hoje };
}
const diasTxt = n => n + (n === 1 ? ' dia' : ' dias');
const fmtDia = t => new Date(t).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
function atrasoBox(v, cs) {
  if (cs.atraso) {
    const r = Math.floor(Math.min(cs.hoje, RODADAS * 7 - 1) / 7), d = Math.min(cs.hoje, RODADAS * 7 - 1) % 7;
    return `<div class="alert bad"><div class="grow"><b>⚠ ${diasTxt(cs.atraso)} de atraso no ciclo.</b><br>
      <span class="small">Pelo calendário, hoje seria ${cs.hoje >= RODADAS * 7 ? 'dia de simulado (o ciclo já devia ter terminado)' : `Semana ${r + 1} · Dia ${d + 1}`}. Você está na Semana ${cs.pos.r + 1} · Dia ${cs.pos.d + 1}.
      Recupere fazendo blocos extras, ou reorganize: o ciclo continua de onde parou e as datas (e o simulado) andam ${diasTxt(cs.atraso)} para frente.</span></div>
      <button class="btn" data-act="cic-replan">Reorganizar a partir de hoje</button></div>`;
  }
  if (cs.adiant) return `<div class="alert good">💪 Você está <b>${diasTxt(cs.adiant)} adiantado</b> no ciclo.</div>`;
  return '';
}

function viewCiclo() {
  const v = cicloAtual(), pos = posicao(v), prog = cycleProgress(v), cs = cicloStatus(v);
  const fim = startOfDay(v.inicio) + RODADAS * 7 * DAY;
  const wk = S.cicloWeek ?? (pos ? pos.r : RODADAS - 1);
  const sims = P().simulados.slice().sort((a, b) => b.data.localeCompare(a.data));
  const versoes = P().ciclo.versoes;
  return `
  <div class="page-head"><div><h1>Ciclo de estudos</h1>
    <p class="sub">${esc(v.nome)} · ciclo de 7 dias feito 2 vezes (2 semanas) · 4 blocos de 60 min por dia</p></div>
    <div class="row"><button class="btn" data-act="cl-open" data-k="ciclo" title="Abre o projeto Ciclo de estudos no Claude">💬 Claude</button>
    <button class="btn" data-act="sim-new">+ Lançar simulado</button>
    <button class="btn primary" data-act="cic-gen">Gerar novo ciclo</button></div></div>
  <div class="card-box">
    <div class="row"><b class="big-pct">${pct(prog)}</b><span class="muted">do ciclo concluído</span><span class="spacer"></span>
      <span class="muted small">Início ${fmtDate(v.inicio)} · simulado previsto ${fmtDate(fim)}</span>
      <button class="btn ghost sm" data-act="cic-start">Mudar início</button></div>
    ${bar(prog)}
  </div>
  ${atrasoBox(v, cs)}
  ${pos ? `<div class="today-box"><div class="row" style="margin-bottom:8px"><h3 style="margin:0">Próximo: Semana ${pos.r + 1} · Dia ${pos.d + 1}</h3>
      <span class="muted small">previsto para ${fmtDia(cicloDate(v, pos.r, pos.d))}</span>${cs.atraso ? `<span class="pill bad">${diasTxt(cs.atraso)} de atraso</span>` : ''}</div>
      ${v.dias[pos.d].map((blk, b) => blockRow(v, pos.r, pos.d, b, blk, true)).join('')}</div>`
    : `<div class="hero"><div><h3>Ciclo concluído! 🎉</h3><p>Faça o simulado, lance o resultado e gere o próximo ciclo ajustado ao que você mais precisa.</p></div>
       <button class="btn primary lg" data-act="sim-new">Lançar simulado</button></div>`}
  <h2 class="row">Ciclo completo <span class="spacer"></span>
    <span class="seg">${Array.from({ length: RODADAS }, (_, r) => `<button data-act="cic-week" data-v="${r}" class="${wk === r ? 'on' : ''}">Semana ${r + 1}</button>`).join('')}</span></h2>
  <div class="days">${v.dias.map((_, i) => dayCard(v, wk, i, pos)).join('')}</div>
  <h2>Blocos por matéria (por semana)</h2>
  <div class="card-box">${distrib(v, versoes[versoes.indexOf(v) - 1])}</div>
  <h2>Simulados</h2>
  ${sims.length ? `<div class="list">${sims.map(simItem).join('')}</div>`
    : `<div class="empty">Nenhum simulado lançado ainda.<br>A cada 2 semanas, faça um simulado e lance o resultado aqui.<br>O próximo ciclo é gerado com base nele.</div>`}
  ${versoes.length > 1 ? `<h2>Versões do ciclo</h2><div class="list">${versoes.slice().reverse().map(x => `<div class="item">
      <div class="grow"><div class="title">${esc(x.nome)} ${x.id === v.id ? '<span class="pill due">atual</span>' : ''}</div>
      <div class="meta">${esc(x.origem || '')} · criado em ${fmtDate(x.criadoEm)} · ${pct(cycleProgress(x))} feito</div></div>
      ${x.id !== v.id ? `<button class="btn sm" data-act="cic-activate" data-id="${x.id}">Voltar para esta</button>` : ''}</div>`).join('')}</div>` : ''}`;
}
function dayCard(v, r, i, pos) {
  const d = v.dias[i], isNow = pos && pos.r === r && pos.d === i;
  const done = d.filter((_, b) => v.feito[blkKey(r, i, b)]).length;
  const date = cicloDate(v, r, i), late = done < d.length && date < startOfDay();
  return `<div class="day ${isNow ? 'now' : ''} ${done === d.length ? 'complete' : ''} ${late ? 'late' : ''}">
    <div class="day-head"><b>Dia ${i + 1}</b><span class="muted small">${fmtDia(date)}</span>${late ? '<span class="pill bad">atrasado</span>' : isNow ? '<span class="pill due">próximo</span>' : ''}
      <span class="spacer"></span><span class="muted small">${done}/${d.length}</span></div>
    ${d.map((blk, b) => blockRow(v, r, i, b, blk)).join('')}</div>`;
}
function blockRow(v, r, i, b, blk, withCards = false) {
  const k = blkKey(r, i, b), ok = !!v.feito[k];
  const nc = withCards && OBJ_IDS.includes(blk.m) ? blockCards(blk).length : 0;
  return `<div class="blk ${ok ? 'ok' : ''}">
    <button class="chk" data-act="cic-check" data-k="${k}" title="Marcar como feito">${ok ? '✓' : ''}</button>
    <span class="blk-bar" style="background:${blkInfo(blk.m).cor}"></span>
    <div class="grow"><div class="tiny muted">Bloco ${b + 1}</div><div class="blk-l">${esc(blk.l)}</div>${blkTopics(blk.t)}
      ${nc ? `<button class="btn sm blk-cards" data-act="blk-review" data-d="${i}" data-b="${b}">🃏 Revisar ${nc} cards deste bloco</button>` : ''}</div>
    <button class="icon-btn" data-act="cic-edit" data-d="${i}" data-b="${b}" title="Editar bloco">✏️</button></div>`;
}
const blkTopics = t => t && t.length ? `<div class="blk-t">🎯 ${t.map(id => esc(topicShort(id, 42))).join('<br>🎯 ')}</div>` : '';
function countBlocks(v) {
  const c = {}; v.dias.forEach(d => d.forEach(b => { if (EDITAL.materias[b.m]) c[b.m] = (c[b.m] || 0) + 1; })); return c;
}
function distrib(v, prev) {
  const c = countBlocks(v), pc = prev ? countBlocks(prev) : null;
  const max = Math.max(1, ...Object.values(c));
  return `<div class="dist">${MAT_IDS.map(m => {
    const M = EDITAL.materias[m], n = c[m] || 0, delta = pc ? n - (pc[m] || 0) : 0;
    return `<div class="dist-row"><span class="dist-l">${esc(M.curto)}</span>
      <div class="dist-bar"><div style="width:${(n / max) * 100}%;background:${M.cor}"></div></div>
      <b>${n}</b>${pc && delta ? `<span class="small ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</span>` : '<span></span>'}</div>`;
  }).join('')}</div>${pc ? `<p class="muted small" style="margin:10px 0 0">Comparado com ${esc(prev.nome)}.</p>` : ''}`;
}

let CE = null; // bloco em edição
function openBlockEditor(d, b) {
  const v = cicloAtual(), blk = v.dias[d][b];
  CE = { d, b };
  const opts = [...MAT_IDS, 'rev', 'mix', 'out'];
  $('#modal').innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3>Dia ${d + 1} · Bloco ${b + 1}</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Matéria</label><select class="input" id="ce-m">${opts.map(m => `<option value="${m}" ${blk.m === m ? 'selected' : ''}>${esc(blkInfo(m).nome)}</option>`).join('')}</select></div>
      <div class="field"><label>O que fazer neste bloco</label><input class="input" id="ce-l" value="${esc(blk.l)}"></div>
      <p class="muted small" style="margin:0">A mudança vale para as 2 semanas deste ciclo.</p>
    </div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" data-act="ce-save">Salvar</button></div></div>`;
  $('#modal').classList.remove('hidden');
  $('#ce-m').onchange = e => { const m = e.target.value; if (EDITAL.materias[m]) $('#ce-l').value = EDITAL.materias[m].nome; };
}

/* ------------------------------ Simulados ------------------------------ */
function simCalc(s) {
  const blocos = EDITAL.blocos.filter(b => b.questoes).map(b => {
    const a = b.materias.reduce((x, m) => x + (+s.r[m] || 0), 0);
    return { nome: b.nome, a, q: b.questoes, ok: a / b.questoes >= 0.3 };
  });
  const total = blocos.reduce((x, b) => x + b.a, 0);
  const zeradas = OBJ_IDS.filter(m => (+s.r[m] || 0) === 0);
  const red = s.red == null || s.red === '' ? null : +s.red;
  const redOk = red == null ? null : red >= EDITAL.materias.red.minimo;
  const aprovado = blocos.every(b => b.ok) && total / 60 >= 0.3 && !zeradas.length && redOk !== false;
  return { blocos, total, zeradas, red, redOk, aprovado, nota: total + (red || 0) };
}
/* ---- Resultado por assunto ----
   s.q = [{ n: 1, m: 'port', t: 'port-8', ok: false }, ...]  (uma linha por questão do simulado)
   Vai ser preenchido pela IA lendo o PDF do simulado. */
function simTopics(s) {
  const out = {};
  (s.q || []).forEach(x => { if (!x.t) return; const o = out[x.t] || (out[x.t] = { a: 0, q: 0 }); o.q++; if (x.ok) o.a++; });
  return out;
}
const topicShort = (id, max = 46) => {
  const x = allTopics().find(t => t.id === id); if (!x) return id;
  const t = x.t.replace(/\.$/, ''); return `${x.n} ${t.length > max ? t.slice(0, max - 1) + '…' : t}`;
};
function weakTopics(s, m, lim = 3) {
  const st = simTopics(s);
  return Object.entries(st).filter(([id, o]) => (!m || id.startsWith(m + '-')) && o.a < o.q)
    .sort((a, b) => (b[1].q - b[1].a) - (a[1].q - a[1].a) || a[1].a / a[1].q - b[1].a / b[1].q).slice(0, lim);
}
// Acha a matéria por id ou nome ("Português", "Raciocínio Lógico"...)
function matchMateria(v) {
  const n = norm(v); if (!n) return null;
  if (EDITAL.materias[n]) return n;
  return MAT_IDS.find(m => norm(EDITAL.materias[m].nome) === n || norm(EDITAL.materias[m].curto) === n)
    || MAT_IDS.find(m => norm(EDITAL.materias[m].nome).includes(n) || n.includes(norm(EDITAL.materias[m].curto).replace(/\./g, '')));
}
// Acha o tópico por id ("rl-4.2"), por número ("4.2") ou pelo texto
function matchTopico(m, v) {
  if (v == null) return null; const s = String(v).trim();
  if (allTopics().some(t => t.id === s)) return s;
  if (!m) return null;
  const ts = EDITAL.materias[m].topicos;
  const num = s.match(/^(\d+(?:\.\d+)?)/);
  if (num && ts.some(t => t[0] === num[1])) return topicId(m, num[1]);
  const n = norm(s); const hit = ts.find(t => norm(t[1]).includes(n) || n.includes(norm(t[1]).slice(0, 25)));
  return hit ? topicId(m, hit[0]) : null;
}
function parseSimAnalysis(data) {
  const arr = Array.isArray(data) ? data : (data.questoes || data.questions || []);
  const q = arr.map((x, i) => {
    let m = matchMateria(x.materia ?? x.m ?? '');
    const t = matchTopico(m, x.topico ?? x.assunto ?? x.t);
    if (!m && t) m = t.split('-')[0];
    const ok = x.acertou ?? x.ok ?? (x.minhaResposta && x.gabarito ? norm(x.minhaResposta) === norm(x.gabarito) : false);
    return { n: x.n ?? x.numero ?? i + 1, m, t, ok: ok === true || ok === 'sim' || ok === 1 };
  }).filter(x => x.m);
  return { q, red: data.redacao ?? data.red ?? null, nome: data.simulado || data.nome || null, data: data.data || null };
}
const SIM_AI_PROMPT = () => `Analise o PDF do meu simulado da PMPE (Soldado, banca Instituto AOCP).
Para CADA questão, identifique a matéria e o assunto do edital, e se eu acertei.
Responda SOMENTE com um bloco de código JSON neste formato:

{
  "simulado": "Simulado 02",
  "data": "AAAA-MM-DD",
  "redacao": 25,
  "questoes": [
    { "n": 1, "materia": "port", "topico": "port-8", "acertou": false, "minhaResposta": "B", "gabarito": "C" }
  ]
}

"redacao" é a nota de 0 a 40 (null se não tiver). Use estes códigos de matéria e de assunto:
${MAT_IDS.filter(m => m !== 'red').map(m => `\n${m} = ${EDITAL.materias[m].nome}\n` + EDITAL.materias[m].topicos.map(([n, t]) => `  ${topicId(m, n)}: ${t}`).join('\n')).join('\n')}`;

function simItem(s) {
  const c = simCalc(s);
  const weak = s.q && s.q.length ? weakTopics(s, null, 5) : [];
  const prev = P().simulados.filter(x => x.data < s.data).sort((a, b) => b.data.localeCompare(a.data))[0];
  return `<div class="item sim">
    <div class="grow">
      <div class="row"><span class="title">${esc(s.nome)}</span><span class="muted small">${fmtDate(s.data + 'T12:00')}</span>
        <span class="pill ${c.aprovado ? 'ok' : 'bad'}">${c.aprovado ? 'Dentro do mínimo' : 'Abaixo do mínimo'}</span></div>
      <div class="meta">Objetiva ${c.total}/60${c.red != null ? ` · Redação ${c.red}/40` : ''} · <b>Nota ${c.nota}</b>
        ${c.zeradas.length ? ` · zerou: ${c.zeradas.map(m => EDITAL.materias[m].curto).join(', ')}` : ''}</div>
      <div class="sim-mats">${OBJ_IDS.map(m => {
        const M = EDITAL.materias[m], v = +s.r[m] || 0, d = prev ? v - (+prev.r[m] || 0) : 0;
        return `<span class="sim-mat" style="border-color:${M.cor}66"><span style="color:${M.cor}">${esc(M.curto)}</span> <b>${v}/${M.questoes}</b>${prev && d ? `<span class="${d > 0 ? 'up' : 'down'}"> ${d > 0 ? '+' : ''}${d}</span>` : ''}</span>`;
      }).join('')}</div>
      ${weak.length ? `<div class="meta" style="margin-top:8px">Assuntos que mais errou: ${weak.map(([id, o]) =>
        `<span class="weak-t" style="border-color:${EDITAL.materias[id.split('-')[0]].cor}">${esc(topicShort(id, 34))} <b>${o.a}/${o.q}</b></span>`).join(' ')}</div>` : ''}
    </div>
    <button class="icon-btn" data-act="sim-edit" data-id="${s.id}" title="Editar">✏️</button>
  </div>`;
}
function simQSummary(q) {
  const ok = q.filter(x => x.ok).length, semT = q.filter(x => !x.t).length;
  return `✔ ${q.length} questões analisadas · ${ok} acertos${semT ? ` · ${semT} sem assunto identificado` : ''}`;
}
function readSimAI() {
  const txt = $('#sm-ai').value; if (!txt.trim()) return toast('Cole a resposta da IA primeiro.');
  let res; try { res = parseSimAnalysis(tryParseJSON(txt)); } catch (err) { return alert('Não consegui ler essa resposta.\n\n' + err.message); }
  if (!res.q.length) return toast('Nenhuma questão encontrada na resposta.');
  SM.q = res.q;
  OBJ_IDS.forEach(m => { const el = document.querySelector(`[data-sm="${m}"]`); if (el) el.value = res.q.filter(x => x.m === m && x.ok).length; });
  if (res.red != null) $('#sm-red').value = res.red;
  if (res.nome) $('#sm-nome').value = res.nome;
  if (res.data && /^\d{4}-\d{2}-\d{2}$/.test(res.data)) $('#sm-data').value = res.data;
  $('#sm-q-sum').textContent = simQSummary(res.q);
  toast('Análise lida! Confira os acertos e salve.');
}
let SM = null;
function openSim(id) {
  const sims = P().simulados;
  const s = id ? sims.find(x => x.id === id) : { id: uid(), data: todayKey(), nome: 'Simulado ' + String(sims.length + 1).padStart(2, '0'), r: {}, red: null, obs: '' };
  SM = { id: s.id, isNew: !id, q: s.q || null };
  $('#modal').innerHTML = `<div class="modal-box">
    <div class="modal-head"><h3>${id ? 'Editar simulado' : 'Lançar simulado'}</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <div class="ai-box">
        <b>🤖 Mais fácil: mande o PDF para o Claude</b>
        <p class="muted small" style="margin:4px 0 10px">Na conversa de questões do projeto ESTUDOS, o Claude lê o PDF e separa os acertos por matéria e por <b>assunto</b>.
          O próximo ciclo usa isso para focar no que você mais errou.</p>
        <div class="row"><button class="btn sm primary" data-act="cl-open" data-k="simulado">Abrir no Claude ↗</button>
          <span id="sm-q-sum" class="small muted">${SM.q ? simQSummary(SM.q) : ''}</span></div>
        <details class="adv" style="margin-top:10px"><summary>Modo manual (colar resposta do Claude)</summary>
          <div class="row" style="margin:8px 0"><button class="btn sm" data-act="sim-ai-copy">Copiar instrução</button></div>
          <textarea class="input code" id="sm-ai" rows="4" style="min-height:90px" placeholder="Cole aqui a resposta do Claude (JSON)..."></textarea>
          <div class="row" style="margin-top:8px"><button class="btn sm" data-act="sim-ai-read">Ler análise</button></div>
        </details>
      </div>
      <p class="muted small" style="margin:0 0 10px">Ou preencha você mesmo os acertos por matéria:</p>
      <div class="grid-2"><div class="field"><label>Nome</label><input class="input" id="sm-nome" value="${esc(s.nome)}"></div>
        <div class="field"><label>Data</label><input class="input" type="date" id="sm-data" value="${s.data}"></div></div>
      <div class="sim-grid">${OBJ_IDS.map(m => { const M = EDITAL.materias[m]; return `<div class="field"><label style="color:${M.cor}">${esc(M.nome)} (de ${M.questoes})</label>
        <input class="input" type="number" min="0" max="${M.questoes}" inputmode="numeric" data-sm="${m}" value="${s.r[m] ?? ''}"></div>`; }).join('')}
        <div class="field"><label style="color:${EDITAL.materias.red.cor}">Redação (nota de 0 a 40, deixe vazio se não fez)</label>
        <input class="input" type="number" min="0" max="40" inputmode="numeric" id="sm-red" value="${s.red ?? ''}"></div></div>
      <div class="field"><label>Observações (opcional)</label><textarea class="input" id="sm-obs" rows="2">${esc(s.obs || '')}</textarea></div>
    </div>
    <div class="modal-foot">${id ? '<button class="btn danger" data-act="sim-del">Excluir</button><span class="spacer"></span>' : ''}
      <button class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" data-act="sim-save">Salvar</button></div></div>`;
  $('#modal').classList.remove('hidden');
}
async function saveSim() {
  const r = {};
  for (const el of document.querySelectorAll('[data-sm]')) {
    const m = el.dataset.sm, max = EDITAL.materias[m].questoes;
    if (el.value === '') return toast(`Preencha os acertos de ${EDITAL.materias[m].curto}.`);
    r[m] = Math.min(max, Math.max(0, parseInt(el.value) || 0));
  }
  const redV = $('#sm-red').value;
  const s = { id: SM.id, nome: $('#sm-nome').value.trim() || 'Simulado', data: $('#sm-data').value || todayKey(), r, q: SM.q || null,
    red: redV === '' ? null : Math.min(40, Math.max(0, parseInt(redV) || 0)), obs: $('#sm-obs').value.trim() };
  const sims = P().simulados, i = sims.findIndex(x => x.id === s.id);
  if (i >= 0) sims[i] = s; else sims.push(s);
  await savePmpe();
  const isNew = SM.isNew; closeModal(); render();
  toast('Simulado salvo!');
  if (isNew && confirm('Simulado salvo! Quer gerar agora o próximo ciclo com base nele?')) openGen();
}

/* ------------------------- Gerar novo ciclo ------------------------- */
// Peso de cada matéria = quanto errou no último simulado + quanto falta do edital + tópicos de prioridade alta pendentes.
function planejarCiclo() {
  const sims = P().simulados.slice().sort((a, b) => a.data.localeCompare(b.data));
  const last = sims[sims.length - 1] || null;
  const info = OBJ_IDS.map(m => {
    const M = EDITAL.materias[m];
    const acc = last && last.r[m] != null ? last.r[m] / M.questoes : null;
    const prog = matProgress(m);
    const altas = M.topicos.filter(t => t[2] === 'a');
    const altaPend = altas.filter(([n]) => tState(topicId(m, n)).s !== 2).length / Math.max(1, altas.length);
    // ao cubo: quem foi pior no simulado ganha bem mais blocos extras
    const w = Math.pow(0.15 + (acc == null ? 0.5 : 1 - acc) * 2 + (1 - prog) * 0.4 + altaPend * 0.2 + M.topicos.length / 60, 3);
    return { m, acc, prog, w };
  });
  const red = last && last.red != null ? last.red : null;
  const counts = { red: red == null ? 2 : red < 20 ? 3 : 2 };
  info.forEach(x => counts[x.m] = 2); // mínimo 2 blocos por matéria
  let rest = 20 - counts.red - 2 * OBJ_IDS.length; // 20 blocos de matéria por semana
  const totalW = info.reduce((s, x) => s + x.w, 0);
  const q = info.map(x => ({ m: x.m, q: rest * x.w / totalW }));
  q.forEach(x => { const f = Math.floor(x.q); counts[x.m] += f; x.r = x.q - f; });
  rest -= q.reduce((s, x) => s + Math.floor(x.q), 0);
  q.sort((a, b) => b.r - a.r).forEach(x => { if (rest > 0) { counts[x.m]++; rest--; } });
  // Assuntos em foco de cada matéria: os mais errados nos simulados primeiro, depois os não estudados e de prioridade alta
  const foco = {};
  OBJ_IDS.forEach(m => {
    foco[m] = EDITAL.materias[m].topicos.map(([n]) => topicId(m, n))
      .map(id => ({ id, need: topicNeed(id, sims) })).sort((a, b) => b.need - a.need);
  });
  return { info, counts, last, red, foco, dias: montarDias(counts, info, foco) };
}
// Quanto um assunto precisa de atenção (erros no último simulado pesam mais que nos anteriores)
function topicNeed(id, sims) {
  const x = allTopics().find(t => t.id === id);
  let e = 0, seen = 0;
  sims.forEach((s, i) => { const o = simTopics(s)[id]; if (!o) return; const k = i === sims.length - 1 ? 1 : 0.4; e += (o.q - o.a) * k; seen += o.q * k; });
  const st = tState(id).s;
  return e * 3 + (seen ? e / seen : 0) + (st === 0 ? 0.8 : st === 1 ? 0.4 : 0) + (x.p === 'a' ? 0.6 : x.p === 'm' ? 0.3 : 0);
}
function montarDias(counts, info, foco = {}) {
  const w = Object.fromEntries(info.map(x => [x.m, x.w])); w.red = 0;
  const rem = { ...counts };
  const days = Array.from({ length: 7 }, () => []);
  const cap = i => i === 6 ? 2 : 3; // dia 7: 2 matérias + simulado/questões
  // Matérias com mais blocos ganham bloco duplo (2 seguidos no mesmo dia)
  const byN = OBJ_IDS.slice().sort((a, b) => rem[b] - rem[a] || w[b] - w[a]);
  const pairs = [...byN.filter(m => rem[m] >= 3), ...byN.filter(m => rem[m] >= 6)];
  const order = [0, 3, 1, 4, 2, 5];
  pairs.slice(0, 6).forEach((m, k) => { days[order[k]].push(m, m); rem[m] -= 2; });
  for (let i = 0; i < 7; i++) {
    while (days[i].length < cap(i)) {
      const cands = MAT_IDS.filter(m => rem[m] > 0);
      if (!cands.length) break;
      const maxW = Math.max(1e-9, ...Object.values(w));
      const score = m => rem[m] * 10 + w[m] / maxW - (days[i].includes(m) ? 1000 : 0) - (i > 0 && days[i - 1].includes(m) ? 40 : 0) - (m === 'red' && i === 6 ? 30 : 0);
      cands.sort((a, b) => score(b) - score(a));
      days[i].push(cands[0]); rem[cands[0]]--;
    }
  }
  // Cada bloco de matéria recebe 2 assuntos em foco, seguindo a ordem de necessidade
  const ptr = {};
  const nextTopics = m => {
    const list = foco[m] || []; if (!list.length) return [];
    const out = []; for (let k = 0; k < 2; k++) { const i = (ptr[m] || 0) % list.length; out.push(list[i].id); ptr[m] = i + 1; }
    return [...new Set(out)];
  };
  return days.map((d, i) => {
    d.sort((a, b) => (a === 'red') - (b === 'red')); // redação no último bloco de matéria
    const blocks = d.map(m => [m, EDITAL.materias[m].nome, m === 'red' ? [] : nextTopics(m)]);
    if (i === 6) blocks.push(['mix', 'Simulado / Questões mistas']);
    const names = [...new Set(d.filter(m => m !== 'red'))].map(m => EDITAL.materias[m].curto);
    const rev = i === 6 ? 'Revisão da semana + Caderno de erros + Questões extras'
      : `Revisão (${names.join(' + ')}) + ${d.includes('red') ? 'Correção/reescrita da redação' : 'Questões'}`;
    blocks.push(['rev', rev]);
    return blocks;
  });
}
let GEN = null;
function openGen() {
  const plan = planejarCiclo(), cur = countBlocks(cicloAtual());
  GEN = plan;
  const rows = [...plan.info, { m: 'red' }].map(x => {
    const M = EDITAL.materias[x.m], n = plan.counts[x.m], d = n - (cur[x.m] || 0);
    const acc = x.m === 'red' ? (plan.red != null ? `${plan.red}/40` : '—') : (x.acc != null ? pct(x.acc) : '—');
    return `<tr><td><span class="mat-dot" style="background:${M.cor}"></span> ${esc(M.curto)}</td><td>${acc}</td>
      <td>${x.m === 'red' ? pct(matProgress('red')) : pct(x.prog)}</td><td><b>${n}</b> ${d ? `<span class="small ${d > 0 ? 'up' : 'down'}">(${d > 0 ? '+' : ''}${d})</span>` : ''}</td>
      <td class="foco">${x.m === 'red' ? '—' : (plan.last && plan.last.q ? weakTopics(plan.last, x.m, 2).map(([id, o]) => `${esc(topicShort(id, 30))} <span class="down">${o.a}/${o.q}</span>`).join('<br>') : '') || esc(topicShort(plan.foco[x.m][0].id, 30))}</td></tr>`;
  }).join('');
  $('#modal').innerHTML = `<div class="modal-box wide">
    <div class="modal-head"><h3>Gerar novo ciclo</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
    <div class="modal-body">
      <p class="muted small" style="margin-top:0">${plan.last ? `Baseado no <b>${esc(plan.last.nome)}</b> (${fmtDate(plan.last.data + 'T12:00')}) e no seu progresso do edital.`
        : 'Você ainda não lançou simulado, então o ciclo foi montado só pelo progresso do edital. Lance um simulado para ajustar melhor.'}
        Matérias em que você errou mais e com mais conteúdo pendente ganham mais blocos. Toda matéria tem no mínimo 2 blocos por semana.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Matéria</th><th>Acertos</th><th>Edital</th><th>Blocos/semana</th><th>Assuntos em foco</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3 style="margin:18px 0 8px;font-size:15px">Como fica a semana</h3>
      <div class="days compact">${plan.dias.map((d, i) => `<div class="day"><div class="day-head"><b>Dia ${i + 1}</b></div>
        ${d.map(([m, l, t], b) => `<div class="blk"><span class="blk-bar" style="background:${blkInfo(m).cor}"></span><div class="grow"><div class="tiny muted">Bloco ${b + 1}</div><div class="blk-l">${esc(l)}</div>${blkTopics(t)}</div></div>`).join('')}</div>`).join('')}</div>
    </div>
    <div class="modal-foot"><button class="btn" data-act="close-modal">Cancelar</button>
      <button class="btn primary" data-act="gen-use">Usar este ciclo</button></div></div>`;
  $('#modal').classList.remove('hidden');
}
async function useGen() {
  const c = P().ciclo;
  const nums = c.versoes.map(v => parseInt(String(v.nome).replace(/\D/g, '')) || 0);
  const nome = 'v' + (Math.max(0, ...nums) + 1);
  const origem = GEN.last ? `Gerado pelo ${GEN.last.nome}` : 'Gerado pelo progresso do edital';
  const v = novaVersao(GEN.dias, nome, origem);
  c.versoes.push(v); c.atual = v.id; S.cicloWeek = undefined;
  await savePmpe(); closeModal(); render(); window.scrollTo(0, 0);
  toast(`Ciclo ${nome} ativado!`);
}

/* =====================================================================
   Integração flashcards ↔ edital ↔ simulados ↔ ciclo
   Tudo calculado aqui no aparelho, sem IA (não gasta nenhum token).
   ===================================================================== */
// Descobre o assunto (tópico) e a matéria de um card pela pasta dele
function folderIndex() {
  const p = P(), byFolder = {};
  Object.entries(p.folders).forEach(([k, fid]) => { byFolder[fid] = k; });
  const cache = {};
  const lookup = fid => {
    if (!fid) return { t: null, m: null };
    if (cache[fid]) return cache[fid];
    let f = folderById(fid), t = null, m = null;
    while (f) { const k = byFolder[f.id]; if (k) { if (k.includes('-')) { t = t || k; m = m || k.split('-')[0]; } else m = m || k; } f = folderById(f.parentId); }
    return (cache[fid] = { t, m });
  };
  return lookup;
}
// Contexto de prioridade: último simulado, assuntos/matérias em foco no ciclo hoje
function prioContext() {
  const sims = P().simulados.slice().sort((a, b) => a.data.localeCompare(b.data));
  const last = sims[sims.length - 1] || null;
  const lastT = last ? simTopics(last) : {};
  const accM = {}; if (last) OBJ_IDS.forEach(m => { if (last.r[m] != null) accM[m] = last.r[m] / EDITAL.materias[m].questoes; });
  const v = cicloAtual(), pos = posicao(v);
  const focusT = new Set(), focusM = new Set();
  if (pos) v.dias[pos.d].forEach(b => { if (OBJ_IDS.includes(b.m)) { focusM.add(b.m); (b.t || []).forEach(t => focusT.add(t)); } });
  return { lookup: folderIndex(), lastT, accM, focusT, focusM };
}
// 0 a 1: quanto o assunto/matéria do card está fraco (simulado + edital)
function cardWeak(c, ctx) {
  const { t, m } = ctx.lookup(c.folderId);
  let w = 0;
  if (t && ctx.lastT[t]) { const o = ctx.lastT[t]; w = Math.max(w, (o.q - o.a) / o.q); }
  if (m && ctx.accM[m] != null) w = Math.max(w, (1 - ctx.accM[m]) * 0.8);
  if (t && tState(t).s === 0) w = Math.max(w, 0.3);
  return w;
}
// Prioridade na fila de revisão (maior = antes)
const DIFF_PRIO = { extremo: 2, dificil: 1.4, medio: 0.7, facil: 0 };
function cardPriority(c, ctx) {
  const { t, m } = ctx.lookup(c.folderId);
  const late = lateDays(c);
  return (late ? 3 + Math.min(late, 7) * 0.2 : 0)
    + (t && ctx.focusT.has(t) ? 2.5 : m && ctx.focusM.has(m) ? 1.2 : 0)
    + cardWeak(c, ctx) * 2.5
    + (c.difficulty ? DIFF_PRIO[c.difficulty] : 1)
    + Math.random() * 0.3; // mistura um pouco para não ficar sempre na mesma ordem
}
// Assuntos fracos voltam um pouco mais cedo (até 30% antes)
function cardFactor(c) {
  const ctx = prioContext();
  return 1 - 0.3 * cardWeak(c, ctx);
}
// Cards dos pontos fracos (mesmo os que ainda não venceram), para reforço
function weakCards(limit = 40) {
  const ctx = prioContext();
  return S.cards.map(c => ({ c, w: cardWeak(c, ctx) })).filter(x => x.w >= 0.35)
    .sort((a, b) => cardPriority(b.c, ctx) - cardPriority(a.c, ctx)).slice(0, limit).map(x => x.c);
}
// Cards de um bloco do ciclo: dos assuntos em foco (ou da matéria inteira)
function blockCards(blk) {
  const ids = (blk.t || []).map(t => P().folders[t]).filter(id => folderById(id));
  let list = ids.length ? ids.flatMap(id => cardsIn(id)) : [];
  if (!list.length && P().folders[blk.m] && folderById(P().folders[blk.m])) list = cardsIn(P().folders[blk.m]);
  return [...new Set(list)];
}
function focusSummary() {
  const ctx = prioContext();
  const names = [...ctx.focusM].map(m => EDITAL.materias[m].curto);
  return names.length ? names.join(', ') : '';
}

/* ------------------------------ Início ------------------------------ */
function homePmpe() {
  if (!S.meta.pmpe || !P().ciclo) return '';
  const v = cicloAtual(), cs = cicloStatus(v), pos = cs.pos, dias = daysToProva();
  return `<div class="pmpe-home">
    <div class="card-box click" data-nav="edital">
      <div class="row"><span class="muted small">Edital ${esc(EDITAL.titulo)}</span><span class="spacer"></span>${dias > 0 ? `<span class="pill due">${dias} dias para a prova</span>` : ''}</div>
      <div class="row" style="margin:6px 0"><b class="big-pct">${pct(editalProgress())}</b><span class="muted">do edital estudado</span></div>
      ${bar(editalProgress())}
    </div>
    <div class="card-box click" data-nav="ciclo">
      <div class="row"><span class="muted small">Ciclo ${esc(v.nome)} · ${pct(cycleProgress(v))} feito</span><span class="spacer"></span>
        ${cs.atraso ? `<span class="pill bad">⚠ ${diasTxt(cs.atraso)} de atraso</span>` : cs.adiant ? `<span class="pill ok">${diasTxt(cs.adiant)} adiantado</span>` : pos ? '<span class="pill ok">em dia</span>' : ''}</div>
      ${pos ? `<div style="margin:6px 0 4px"><b>Próximo: Semana ${pos.r + 1} · Dia ${pos.d + 1}</b></div>
        <div class="mini-blks">${v.dias[pos.d].map((b, i) => `<span class="${v.feito[blkKey(pos.r, pos.d, i)] ? 'ok' : ''}" style="border-color:${blkInfo(b.m).cor}">${esc(b.m === 'rev' ? 'Revisão' : b.m === 'mix' ? 'Simulado' : (EDITAL.materias[b.m]?.curto || b.l))}</span>`).join('')}</div>`
      : `<div style="margin:6px 0"><b>Ciclo concluído!</b> Lance o simulado e gere o próximo.</div>`}
    </div>
  </div>`;
}

/* ------------------------------ Eventos ------------------------------ */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'ed-filter': S.edFilter = d.v; render(); break;
    case 'ed-toggle': { S.edOpen = S.edOpen || new Set(); S.edOpen.has(d.m) ? S.edOpen.delete(d.m) : S.edOpen.add(d.m); render(); break; }
    case 'ed-folders': { const n = await criarPastasEdital(); await savePmpe(); toast(n ? `${n} pastas criadas.` : 'Todas as pastas já existem.'); render(); break; }
    case 'topic-cycle': {
      const st = { ...tState(d.id) }; st.s = (st.s + 1) % 3; P().topicos[d.id] = st;
      await savePmpe(); render(); break;
    }
    case 'topic-open': openTopic(d.id); break;
    case 'tp-st': TP.s = +d.v; document.querySelectorAll('#tp-seg button').forEach(b => b.classList.toggle('on', b === el)); break;
    case 'tp-save': await saveTopic(); TP = null; closeModal(); render(); toast('Salvo!'); break;
    case 'tp-folder': case 'tp-new-card': case 'tp-review': {
      const fid = P().folders[TP.id]; await saveTopic(); TP = null; closeModal();
      if (d.act === 'tp-folder') go('folders', fid);
      else if (d.act === 'tp-new-card') { render(); openEditor({ type: 'card', folderId: fid }); }
      else { render(); startSession({ mode: dueOf(fid).length ? 'due' : 'free', folderId: fid }); }
      break;
    }
    case 'cic-week': S.cicloWeek = +d.v; render(); break;
    case 'cic-check': {
      // guarda a hora em que marcou: a revisão do dia usa as matérias dos blocos marcados hoje
      const v = cicloAtual(); if (v.feito[d.k]) delete v.feito[d.k]; else v.feito[d.k] = Date.now();
      await savePmpe(); render();
      if (!posicao(v) && v.feito[d.k]) toast('Ciclo concluído! 🎉 Hora do simulado.');
      break;
    }
    case 'cic-edit': openBlockEditor(+d.d, +d.b); break;
    case 'blk-review': {
      const blk = cicloAtual().dias[+d.d][+d.b];
      startSession({ list: blockCards(blk), title: 'Bloco do ciclo · ' + (EDITAL.materias[blk.m]?.curto || blk.l) }); break;
    }
    case 'ce-save': {
      const v = cicloAtual(), old = v.dias[CE.d][CE.b], m = $('#ce-m').value;
      v.dias[CE.d][CE.b] = { m, l: $('#ce-l').value.trim() || blkInfo(m).nome };
      if (old.t && old.m === m) v.dias[CE.d][CE.b].t = old.t; // mantém os assuntos em foco se a matéria não mudou
      await savePmpe(); CE = null; closeModal(); render(); break;
    }
    case 'cic-replan': {
      const v = cicloAtual(), cs = cicloStatus(v); if (!cs.pos) return;
      if (!confirm(`Reorganizar o ciclo?\n\nA Semana ${cs.pos.r + 1} · Dia ${cs.pos.d + 1} passa a ser hoje, e as próximas datas (e o simulado) vão ${diasTxt(cs.atraso)} para frente.`)) return;
      v.inicio = startOfDay() - cicloDayIdx(cs.pos.r, cs.pos.d) * DAY + 12 * HOUR;
      await savePmpe(); render(); toast('Ciclo reorganizado a partir de hoje.'); break;
    }
    case 'cic-start': {
      const v = cicloAtual();
      $('#modal').innerHTML = `<div class="modal-box"><div class="modal-head"><h3>Data de início do ciclo</h3><button class="icon-btn" data-act="close-modal">✕</button></div>
        <div class="modal-body"><div class="field"><label>O Dia 1 da Semana 1 foi (ou será) em:</label>
          <input class="input" type="date" id="cs-date" value="${todayKey(new Date(v.inicio))}"></div>
          <p class="muted small" style="margin:0">As datas de cada dia, o atraso e a data do simulado são calculados a partir daqui.</p></div>
        <div class="modal-foot"><button class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" data-act="cs-save">Salvar</button></div></div>`;
      $('#modal').classList.remove('hidden'); break;
    }
    case 'cs-save': {
      const val = $('#cs-date').value; if (!val) return toast('Escolha uma data.');
      cicloAtual().inicio = new Date(val + 'T12:00').getTime(); await savePmpe(); closeModal(); render(); toast('Data de início atualizada.'); break;
    }
    case 'cic-gen': openGen(); break;
    case 'gen-use': useGen(); break;
    case 'cic-activate': {
      if (!confirm('Voltar a usar esta versão do ciclo?')) return;
      P().ciclo.atual = d.id; S.cicloWeek = undefined; await savePmpe(); render(); break;
    }
    case 'sim-new': openSim(); break;
    case 'sim-edit': openSim(d.id); break;
    case 'sim-save': saveSim(); break;
    case 'sim-ai-read': readSimAI(); break;
    case 'sim-ai-copy': navigator.clipboard.writeText(SIM_AI_PROMPT()).then(() => toast('Instrução copiada! Mande junto com o PDF no chat do Claude.'), () => toast('Não deu para copiar.')); break;
    case 'sim-del': {
      if (!confirm('Excluir este simulado?')) return;
      P().simulados = P().simulados.filter(s => s.id !== SM.id); await savePmpe(); closeModal(); render(); break;
    }
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !ED && !$('#modal').classList.contains('hidden')) closeModal();
});
