// Admin: clear the map on all TAKweb devices (after a mission) – the devices ask their users (eud.js askMapClear)
'use strict';

(() => {
  const CATS = [
    ['f', 'Markers – Friendly', true], ['h', 'Markers – Hostile', true], ['n', 'Markers – Neutral', true], ['u', 'Markers – Unknown', true],
    ['points', 'Other points', true], ['shapes', 'Drawings & routes (incl. R&B)', true], ['overlays', 'Overlays (KML/KMZ)', false],
    ['contacts', 'Contacts (users – active ones come back)', false], ['chat', 'Chat messages', false],
  ];
  const api2 = opts => api('mapclear', opts);

  $('mcCats').replaceChildren(...CATS.map(([id, label, on]) => {
    const c = el('input', { type: 'checkbox', value: id });
    c.checked = on; // a "checked" attribute would always tick it
    return el('label', { class: 'check' }, c, ' ' + label);
  }));

  function show(r) {
    const q = r.request;
    $('mcWithdraw').classList.toggle('hidden', !q);
    $('mcState').textContent = q
      ? `Active request from ${new Date(q.time).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}: ${q.cats.map(id => (CATS.find(c => c[0] === id) || [id, id])[1]).join(', ')}${q.note ? ' – "' + q.note + '"' : ''}. TAKweb devices connected right now: ${r.devices}.`
      : `No active request. TAKweb devices connected right now: ${r.devices}.`;
  }
  async function load() {
    try { show(await api2()); } catch (e) { setMsg($('mcMsg'), e.message); }
  }

  $('mcSend').addEventListener('click', async () => {
    const cats = [...$('mcCats').querySelectorAll('input:checked')].map(c => c.value);
    if (!cats.length) return setMsg($('mcMsg'), 'Choose what to clear.');
    if (!confirm('Ask all TAKweb devices to clear the map?')) return;
    try {
      const r = await api2({ method: 'POST', body: { cats, note: $('mcNoteIn').value.trim() } });
      setMsg($('mcMsg'), `Request sent – ${r.devices} device(s) online are asked now, the others when they connect.`, true);
      show(r);
    } catch (e) { setMsg($('mcMsg'), e.message); }
  });
  $('mcWithdraw').addEventListener('click', async () => {
    try { show(await api2({ method: 'DELETE' })); setMsg($('mcMsg'), 'Request withdrawn.', true); } catch (e) { setMsg($('mcMsg'), e.message); }
  });
  $('mcReload').addEventListener('click', load);
  document.addEventListener('admin-view', e => { if (e.detail === 'mapclear') load(); });
})();
