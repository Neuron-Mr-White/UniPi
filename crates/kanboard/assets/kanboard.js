// Kanboard v3 — plain JS for the server-rendered board. No build step, no
// framework: fragments come from the server, this file only wires interactions.
(() => {
  const board = () => document.getElementById('board');
  const drawer = () => document.getElementById('drawer');
  const slug = document.body.dataset.project;

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* empty body */ }
    return { status: response.status, payload };
  }

  function toast(message, kind = 'error') {
    const host = document.getElementById('toasts');
    const node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), 6000);
  }

  async function refreshBoard() {
    const scroll = board().scrollLeft;
    const response = await fetch(`/p/${slug}/board`);
    board().innerHTML = await response.text();
    board().scrollLeft = scroll;
  }

  async function refreshDrawer(id, options = {}) {
    if (!id) { drawer().hidden = true; drawer().innerHTML = ''; return; }
    const response = await fetch(`/p/${slug}/card/${id}`);
    if (!response.ok) { toast('could not load the card'); return; }
    drawer().innerHTML = await response.text();
    drawer().hidden = false;
    if (options.focusComment) {
      const box = drawer().querySelector('textarea[name=note]');
      if (box) box.focus();
    }
  }

  // ── comment modal (used when the rule demands a comment) ──────────────────
  function askComment(prompt) {
    return new Promise(resolve => {
      const modal = document.getElementById('comment-modal');
      modal.querySelector('.prompt').textContent = prompt;
      modal.querySelector('textarea').value = '';
      modal.hidden = false;
      const area = modal.querySelector('textarea');
      area.focus();
      const done = value => {
        modal.hidden = true;
        cleanup();
        resolve(value);
      };
      const ok = () => done(area.value.trim() || '');
      const cancel = () => done(null);
      const cleanup = () => {
        modal.querySelector('.save').removeEventListener('click', ok);
        modal.querySelector('.cancel').removeEventListener('click', cancel);
        area.removeEventListener('keydown', onKey);
      };
      const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ok(); }
      };
      modal.querySelector('.save').addEventListener('click', ok);
      modal.querySelector('.cancel').addEventListener('click', cancel);
      area.addEventListener('keydown', onKey);
    });
  }

  /// Move a card, asking for a comment when the server answers 409.
  async function moveCard(id, status, comment) {
    const result = await post(`/api/tasks/${slug}/${id}/move`, { status, comment });
    if (result.status === 409 && result.payload && result.payload.needsComment) {
      const typed = await askComment(result.payload.error);
      if (typed === null) { await refreshBoard(); return false; }
      return moveCard(id, status, typed);
    }
    if (result.status >= 400) {
      toast((result.payload && result.payload.error) || 'move refused');
      return false;
    }
    return true;
  }

  async function act(id, action, body, options = {}) {
    const result = await post(`/api/tasks/${slug}/${id}/${action}`, body);
    if (result.status >= 400) {
      toast((result.payload && result.payload.error) || 'refused');
      return null;
    }
    await refreshBoard();
    if (options.keepDrawer !== false) await refreshDrawer(id);
    return result.payload;
  }

  // ── drag & drop ───────────────────────────────────────────────────────────
  let dragging = null;

  document.addEventListener('dragstart', event => {
    const card = event.target.closest('.card');
    if (!card || card.dataset.running === 'true') { event.preventDefault(); return; }
    dragging = { id: card.dataset.id, lane: card.closest('.lane').dataset.lane };
    card.classList.add('dragging');
    event.dataTransfer.setData('text/plain', card.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
  });

  document.addEventListener('dragend', () => {
    document.querySelectorAll('.card.dragging').forEach(card => card.classList.remove('dragging'));
    document.querySelectorAll('.lane.over').forEach(lane => lane.classList.remove('over'));
    dragging = null;
  });

  document.addEventListener('dragover', event => {
    const lane = event.target.closest('.lane');
    if (!lane || !dragging) return;
    event.preventDefault();
    lane.classList.add('over');
  });

  document.addEventListener('dragleave', event => {
    const lane = event.target.closest('.lane');
    if (lane) lane.classList.remove('over');
  });

  document.addEventListener('drop', async event => {
    const lane = event.target.closest('.lane');
    if (!lane || !dragging) return;
    event.preventDefault();
    lane.classList.remove('over');
    const target = event.target.closest('.card');
    const id = dragging.id;
    const targetLane = lane.dataset.lane;

    if (targetLane !== dragging.lane) {
      const moved = await moveCard(id, targetLane);
      if (!moved) { await refreshBoard(); return; }
    }
    if (target && target.dataset.id !== id) {
      await post(`/api/tasks/${slug}/${id}/order`, { before: target.dataset.id });
    } else if (!target) {
      await post(`/api/tasks/${slug}/${id}/order`, { bottom: true });
    }
    await refreshBoard();
    await refreshDrawer(document.getElementById('drawer').dataset.card);
  });

  // ── clicks (drawer, quick add, toggles, actions) ──────────────────────────
  document.addEventListener('click', async event => {
    const card = event.target.closest('.card');
    if (card) { await refreshDrawer(card.dataset.id); return; }

    const close = event.target.closest('[data-close-drawer]');
    if (close) { drawer().hidden = true; drawer().dataset.card = ''; return; }

    const dataAction = event.target.closest('[data-act]');
    if (dataAction) {
      const { act: name, id, status, dep } = dataAction.dataset;
      event.preventDefault();
      if (name === 'move') { await moveCard(id, status); await refreshBoard(); }
      if (name === 'duplicate') { await act(id, 'duplicate', {}, { keepDrawer: false }); }
      if (name === 'archive') { await act(id, 'archive', {}, { keepDrawer: false }); }
      if (name === 'unlink') { await act(id, 'unlink', { dep }, { keepDrawer: true }); }
      return;
    }

    const archive = event.target.closest('[data-toggle-archive]');
    if (archive) {
      const lane = document.querySelector('.lane[data-lane=archived]');
      lane.hidden = !lane.hidden;
      archive.textContent = lane.hidden ? 'Show archive' : 'Hide archive';
      return;
    }
  });

  document.addEventListener('keydown', async event => {
    if (event.key !== 'Enter') return;
    const input = event.target.closest('.quick-add input');
    if (!input) return;
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    const status = input.closest('.lane').dataset.lane;
    const result = await post(`/api/tasks/${slug}/create`, { title, status });
    if (result.status >= 400) { toast((result.payload && result.payload.error) || 'could not add'); return; }
    input.value = '';
    await refreshBoard();
  });

  document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    const id = form.dataset.id;
    const kind = form.dataset.form;
    const data = new FormData(form);
    if (kind === 'edit') {
      await act(id, 'edit', {
        title: data.get('title'),
        body: data.get('body'),
        priority: data.get('priority'),
      });
    }
    if (kind === 'note') {
      const text = (data.get('note') || '').toString().trim();
      if (!text) return;
      await act(id, 'note', { text });
    }
    if (kind === 'link') {
      const dep = (data.get('dep') || '').toString().trim();
      if (!dep) return;
      await act(id, 'link', { dep });
    }
  });

  // ── live updates ──────────────────────────────────────────────────────────
  const events = new EventSource(`/events?project=${slug}`);
  events.addEventListener('revision', async () => {
    await refreshBoard();
    const open = drawer().dataset.card;
    if (open) await refreshDrawer(open);
  });
  events.onerror = () => { /* the browser reconnects on its own */ };
})();
