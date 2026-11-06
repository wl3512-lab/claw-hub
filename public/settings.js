'use strict';
// Session cleanup and iMessage pings. Uses app.js helpers.
(function () {
  const dlg = $('#setDlg');
  async function open() {
    const s = await api('/api/settings');
    const i = s.imessage;
    $('#idleMinutes').value = String(s.sessions.idleMinutes);
    $('#aiSummaries').checked = s.sessions.aiSummaries;
    $('#imHandle').value = i.handle;
    $('#imOn').checked = i.enabled;
    $('#imAsk').checked = i.onAsk;
    $('#imDone').checked = i.onDone;
    $('#imAway').checked = i.onlyAway;
    setHtml($('#imRead'), s.canRead
      ? '<span class="g">✓ can read your replies</span>'
      : `<span class="r">can't read your replies yet.</span> To fix: System Settings → Privacy &amp; Security → Full Disk Access → <b>+</b> → press ⌘⇧G and paste <code>${esc(s.node)}</code> → turn it on. Then come back here. Pings still send without this.`);
    dlg.showModal();
  }
  async function save(includeSessions = true) {
    await api('/api/settings', { sessions: includeSessions ? {
      idleMinutes: Number($('#idleMinutes').value), aiSummaries: $('#aiSummaries').checked,
    } : undefined, imessage: {
      handle: $('#imHandle').value, enabled: $('#imOn').checked, onAsk: $('#imAsk').checked, onDone: $('#imDone').checked, onlyAway: $('#imAway').checked,
    } });
  }
  $('#setBtn').onclick = () => open().catch((e) => toast(e.message));
  $('#imTest').onclick = async () => {
    try {
      await save(false);
      toast('sending…');
      const r = await api('/api/imessage/test', {});
      toast(r.ok ? 'sent. check your phone' : r.error);
    } catch (e) { toast(e.message); }
  };
  $('#setForm').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if ($('#imOn').checked && !$('#imHandle').value.trim()) { toast('add your phone number or Apple ID email'); return; }
    try {
      await save();
      dlg.close();
      toast('settings saved');
    } catch (err) { toast(err.message); }
  });
})();
