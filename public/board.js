'use strict';
// Job board (sticky notes), project tanks, and drag-a-note-onto-a-crab.
// Uses helpers from app.js: $, ui, api, esc, toast, setHtml, refresh, openConvo, shortPath, folderName, groupById, newGroup, whereLabel.

(function () {
  ui.tank = '';
  ui.jobs = [];
  ui.showDone = false;
  const DAY = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

  async function loadJobs() {
    try { ui.jobs = (await api('/api/jobs')).jobs; } catch { /* server restarting */ }
  }

  // ---------- tanks ----------
  function renderTanks() {
    const html = `<button class="tank ${ui.tank === '' ? 'on' : ''}" data-tank="">all</button>`
      + ui.groups.map((g) => {
        const n = liveOnes().filter((c) => c.group === g.id).length;
        return `<button class="tank ${ui.tank === g.id ? 'on' : ''}" data-tank="${g.id}">${esc(g.name)}${n ? ` <span class="n">${n}</span>` : ''}</button>`;
      }).join('')
      + '<button class="tank add" data-tank="__new" title="make a project tank">+ tank</button>';
    setHtml($('#tanks'), html);
  }
  window.inTank = (c) => !ui.tank || c.group === ui.tank;

  // ---------- board ----------
  function noteHtml(j) {
    const meta = [];
    if (j.cwd) meta.push(esc(folderName(j.cwd)));
    if (j.skill) meta.push(`/${esc(j.skill)}`);
    if (j.scheduleText) meta.push(`⏰ ${esc(j.scheduleText)}`);
    if (j.queue && j.status === 'todo') meta.push('queued');
    const g = !ui.tank && groupById(j.group);
    const crab = j.sessionId && ui.convos.find((c) => c.id === j.sessionId);
    const running = j.status === 'running';
    return `<div class="note-card st-${j.status}" draggable="${j.status !== 'running'}" data-job="${j.id}" title="${esc(j.prompt || j.title)}">
      ${g ? `<span class="note-tag">${esc(g.name)}</span>` : ''}
      <div class="note-t">${esc(j.title)}</div>
      ${meta.length ? `<div class="note-m">${meta.join(' · ')}</div>` : ''}
      ${j.error ? `<div class="note-err">${esc(j.error)}</div>` : ''}
      ${running && crab ? `<button class="note-crab" data-open="${crab.id}">→ ${esc(crab.title.slice(0, 28))}</button>` : ''}
      <div class="note-acts">
        ${running ? '<span class="note-run">crab on it…</span>' : `<button data-jrun="${j.id}" title="hire a crab for this">▶ start</button>`}
        <button data-jedit="${j.id}">edit</button>
        ${j.status === 'done' ? `<button data-jreopen="${j.id}">again</button>` : ''}
      </div>
    </div>`;
  }

  function renderBoard() {
    const mine = ui.jobs.filter((j) => !ui.tank || j.group === ui.tank);
    const open = mine.filter((j) => j.status !== 'done');
    const done = mine.filter((j) => j.status === 'done');
    let html = open.map(noteHtml).join('') || '<p class="tip-none">no notes. pin a task with + note.</p>';
    if (done.length) {
      html += `<button class="done-toggle" data-jdone>${ui.showDone ? '▾' : '▸'} done (${done.length})</button>`;
      if (ui.showDone) html += done.map(noteHtml).join('');
    }
    setHtml($('#board'), html);
  }

  window.Board = {
    async render() { renderTanks(); renderBoard(); },
    async reload() { await loadJobs(); renderTanks(); renderBoard(); },
  };

  // ---------- note editor ----------
  const dlg = $('#jobDlg');
  let editing = null;
  function openEditor(j) {
    editing = j || null;
    $('#jobDlgTitle').textContent = j ? 'edit note' : 'new note';
    $('#jTitle').value = j ? j.title : '';
    $('#jPrompt').value = j ? (j.prompt || '') : '';
    $('#jGroup').innerHTML = '<option value="">no project</option>' + ui.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    $('#jGroup').value = j ? (j.group || '') : ui.tank;
    const sameTank = ui.convos.find((c) => !c.bot && c.cwd && (!ui.tank || c.group === ui.tank));
    $('#jCwd').value = j ? shortPath(j.cwd) : shortPath(sameTank ? sameTank.cwd : '~');
    $('#jSkill').value = j && j.skill ? j.skill : '';
    $('#jQueue').checked = j ? !!j.queue : false;
    const s = j && j.schedule;
    const days = s ? s.days.join(',') : '';
    $('#jRepeat').value = !s ? 'none' : days === '0,1,2,3,4,5,6' ? 'daily' : days === '1,2,3,4,5' ? 'weekdays' : 'custom';
    $('#jTime').value = s ? s.time : '09:00';
    setHtml($('#jDays'), DAY.map((d, i) => `<label><input type="checkbox" value="${i}" ${s && s.days.includes(i) ? 'checked' : ''}>${d}</label>`).join(''));
    syncRepeat();
    $('#jDelete').classList.toggle('hidden', !j);
    if (ui.skills) $('#jSkillList').innerHTML = ui.skills.map((k) => `<option value="${esc(k.name)}">`).join('');
    else api('/api/skills').then((r) => { ui.skills = r.skills; $('#jSkillList').innerHTML = r.skills.map((k) => `<option value="${esc(k.name)}">`).join(''); }).catch(() => {});
    $('#jCwdList').innerHTML = [...new Set(ui.convos.filter((c) => !c.bot && c.cwd).map((c) => shortPath(c.cwd)))].slice(0, 30).map((p) => `<option value="${esc(p)}">`).join('');
    dlg.showModal();
    $('#jTitle').focus();
  }
  function syncRepeat() {
    const r = $('#jRepeat').value;
    $('#jWhen').classList.toggle('hidden', r === 'none');
    $('#jDays').classList.toggle('hidden', r !== 'custom');
  }
  $('#jRepeat').addEventListener('change', syncRepeat);

  $('#jobForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if (e.submitter && e.submitter.id === 'jDelete') {
      if (!confirm('delete this note?')) return;
      await api('/api/jobs/delete', { id: editing.id });
      dlg.close(); return Board.reload();
    }
    const r = $('#jRepeat').value;
    const days = r === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : r === 'weekdays' ? [1, 2, 3, 4, 5] : [...document.querySelectorAll('#jDays input:checked')].map((x) => Number(x.value));
    if (r !== 'none' && !days.length) { toast('pick at least one day'); return; }
    const title = $('#jTitle').value.trim();
    const prompt = $('#jPrompt').value.trim();
    if (!title && !prompt) { toast('give the note a task'); return; }
    const skill = $('#jSkill').value.trim().replace(/^\//, '');
    if (skill && ui.skills && !ui.skills.some((k) => k.name === skill)) { toast(`no skill called /${skill}`); return; }
    try {
      await api('/api/jobs', {
        id: editing ? editing.id : undefined,
        title: title || prompt.slice(0, 60), prompt, group: $('#jGroup').value, cwd: $('#jCwd').value.trim() || '~', skill,
        queue: $('#jQueue').checked, schedule: r === 'none' ? null : { days, time: $('#jTime').value },
      });
      dlg.close();
      Board.reload();
    } catch (err) { toast(err.message); }
  });

  // ---------- running notes ----------
  async function runNote(id, target) {
    try {
      const r = await api('/api/jobs/run', { id, target });
      if (r.how === 'copy') {
        try { await navigator.clipboard.writeText(r.prompt); } catch { /* blocked */ }
        if (r.pid) { try { await api('/api/focus', { pid: r.pid }); } catch { /* not focusable */ } }
        toast('note copied. paste it into that crab');
      } else toast(r.how === 'sent' ? 'handed to that crab' : 'a new crab hatched for it');
      await Board.reload();
      setTimeout(refresh, 1200);
    } catch (e) { toast(e.message); }
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    const tank = t.closest('[data-tank]');
    if (tank) {
      if (tank.dataset.tank === '__new') { const g = await newGroup(); if (g) ui.tank = g.id; }
      else ui.tank = tank.dataset.tank;
      renderRoom(); return;
    }
    if (t.closest('#addNote')) { openEditor(null); return; }
    const run = t.closest('[data-jrun]'); if (run) { runNote(run.dataset.jrun); return; }
    const ed = t.closest('[data-jedit]'); if (ed) { openEditor(ui.jobs.find((j) => j.id === ed.dataset.jedit)); return; }
    const again = t.closest('[data-jreopen]'); if (again) { await api('/api/jobs', { id: again.dataset.jreopen, status: 'todo' }); Board.reload(); return; }
    const op = t.closest('[data-open]'); if (op) { openConvo(op.dataset.open); return; }
    if (t.closest('[data-jdone]')) { ui.showDone = !ui.showDone; renderBoard(); }
  });

  // drag a note: onto a crab = hand it over, onto the floor = hire a new crab
  document.addEventListener('dragstart', (e) => {
    const n = e.target.closest && e.target.closest('.note-card');
    if (!n) return;
    e.dataTransfer.setData('application/x-job', n.dataset.job);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging-job');
  });
  document.addEventListener('dragend', () => { document.body.classList.remove('dragging-job'); document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover')); });
  document.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('application/x-job')) return;
    const crab = e.target.closest && e.target.closest('.crab:not(.baby)');
    const pen = e.target.closest && e.target.closest('#pen');
    if (!crab && !pen) return;
    e.preventDefault();
    document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
    (crab || pen).classList.add('drop-hover');
  });
  document.addEventListener('drop', (e) => {
    const id = e.dataTransfer && e.dataTransfer.getData('application/x-job');
    if (!id) return;
    const crab = e.target.closest && e.target.closest('.crab:not(.baby)');
    const pen = e.target.closest && e.target.closest('#pen');
    if (!crab && !pen) return;
    e.preventDefault();
    document.body.classList.remove('dragging-job');
    runNote(id, crab ? crab.dataset.id : undefined);
  });

  loadJobs().then(() => { if (ui.view === 'room') Board.render(); });
  setInterval(() => { if (ui.view === 'room' && !document.hidden && !dlg.open) Board.reload(); }, 5000);
})();
