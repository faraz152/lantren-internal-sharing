'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

const state = { items: [], filter: 'all', search: '', oldestFirst: false, toastTimer: 0, refreshTimer: 0, queue: [], syncingHostId: '' };

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function encodeHeaderValue(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Empty file';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return (index === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 0 : 1)) + ' ' + units[index];
}

function relativeDate(value) {
  const date = new Date(value);
  const age = Math.max(0, Date.now() - date.getTime());
  if (age < 60_000) return 'Just now';
  if (age < 3_600_000) return Math.floor(age / 60_000) + ' min ago';
  if (age < 86_400_000) return Math.floor(age / 3_600_000) + ' hr ago';
  if (age < 172_800_000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let body = {};
  try { body = await response.json(); } catch { /* A network or proxy error may not be JSON. */ }
  if (!response.ok) {
    const error = new Error(body.error || 'The request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function refreshHostStatus() {
  try {
    const status = await api('/api/host/status');
    const manager = $('#host-transfer');
    const banner = $('#host-banner');
    manager.hidden = false;
    $('#host-remote-note').classList.toggle('is-hidden', status.canManage);
    $('#host-sync-controls').classList.remove('is-hidden');
    $('#host-sync-admin').classList.toggle('is-hidden', !status.canManage);
    $('#host-transfer-legacy').classList.toggle('is-hidden', !status.canManage);
    banner.classList.toggle('is-hidden', !status.frozen);
    $('#host-banner-resume').classList.toggle('is-hidden', !status.canManage);
    if (!status.canManage) {
      manager.hidden = false;
      $('#host-location').textContent = 'This room is hosted by another device.';
      $('#host-source-controls').classList.add('is-hidden');
      $('#host-target-controls').classList.add('is-hidden');
    } else {
      const locationParts = [];
      if (status.addresses.length) locationParts.push('Open on this host: ' + status.addresses.join(' · '));
      if (status.dataPath) locationParts.push('Data folder: ' + status.dataPath);
      locationParts.push(status.itemCount + ' shared items · ' + status.fileCount + ' files');
      $('#host-location').textContent = locationParts.join('\n');
      const peerCount = Array.isArray(status.syncPeers) ? status.syncPeers.length : 0;
      if (!status.syncReady) $('#host-sync-status').textContent = status.canManage ? 'This room has no paired hosts yet. Add another host below.' : 'This room has no paired hosts yet. Add one from the host computer to start using manual sync.';
      else if (peerCount === 0) $('#host-sync-status').textContent = status.canManage ? 'Room sync is ready; add another host below.' : 'Room sync is ready; add another host from a host computer.';
      else if (status.syncRunning) $('#host-sync-status').textContent = 'A manual sync is running. This device’s shelf will update when it finishes.';
      else $('#host-sync-status').textContent = peerCount + ' paired device' + (peerCount === 1 ? '' : 's') + '. Data stays as last synced until you start a sync.';
      const peerList = $('#host-sync-peers');
      peerList.replaceChildren();
      for (const peer of status.syncPeers || []) {
        const row = make('li');
        let addressLabel = peer.url;
        try { addressLabel = new URL(peer.url).hostname + ' · ' + peer.url; } catch { /* Display the saved address. */ }
        const address = make('strong', '', addressLabel);
        const syncState = make('span', '', peer.lastError ? 'Last sync failed: ' + peer.lastError : peer.lastSyncAt ? 'Last synced ' + relativeDate(peer.lastSyncAt) : 'Has not been synced yet');
        const syncButton = make('button', 'button button-outline', state.syncingHostId === peer.nodeId ? 'Syncing…' : 'Sync now');
        syncButton.type = 'button';
        syncButton.dataset.syncNodeId = peer.nodeId;
        syncButton.disabled = status.syncRunning || Boolean(state.syncingHostId);
        row.append(address, syncState, syncButton);
        peerList.append(row);
      }
      $('#host-sync-all').disabled = status.syncRunning || Boolean(state.syncingHostId) || peerCount === 0;
      $('#host-source-controls').classList.remove('is-hidden');
      $('#host-freeze').classList.toggle('is-hidden', status.frozen || status.busy);
      $('#host-resume').classList.toggle('is-hidden', !status.frozen || status.busy);
      $('#host-backup-controls').classList.toggle('is-hidden', !status.frozen || status.busy);
      $('#host-target-controls').classList.toggle('is-hidden', !status.canImport);
      if (status.busy) $('#host-transfer-message').textContent = 'A host transfer is in progress. Wait for it to finish before starting another.';
      else if (status.frozen) $('#host-transfer-message').textContent = 'This host is paused. Existing shares can be read and backed up, but uploads and deletions are blocked.';
      else if (status.fixedPin && status.empty) $('#host-transfer-message').textContent = 'Unset the SHARE_PIN environment setting on this new host before importing a room.';
      else if (!status.canImport) $('#host-transfer-message').textContent = 'To import a room here, start Lantern Share on a new host with an empty share shelf.';
      else $('#host-transfer-message').textContent = 'This new host is empty and ready to import a room.';
    }
    return status;
  } catch (error) {
    if (error.status === 401) setAuthenticated(false);
    return null;
  }
}

async function createHostSyncInvite() {
  const button = $('#host-sync-invite');
  const message = $('#host-sync-message');
  button.disabled = true;
  message.textContent = 'Creating a temporary pairing code…';
  try {
    const invite = await api('/api/sync/invite', { method: 'POST' });
    $('#host-sync-code').value = invite.code;
    $('#host-sync-source-addresses').textContent = 'Enter this host address on the new computer: ' + invite.addresses.join(' · ');
    $('#host-sync-invite-result').classList.remove('is-hidden');
    message.textContent = 'Code expires in 10 minutes. Pair the other computer while this host is on.';
    await refreshHostStatus();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
}

async function pairHostSync() {
  const button = $('#host-sync-pair');
  const message = $('#host-sync-message');
  const address = $('#host-sync-address').value.trim();
  const code = $('#host-sync-pair-code').value.trim();
  if (!address || !code) { message.textContent = 'Enter the existing host address and its temporary pairing code.'; return; }
  if (!window.confirm('Pair this empty host with the existing room? Pairing shares the room PIN but does not copy files or text. You choose when to sync later.')) return;
  button.disabled = true;
  message.textContent = 'Pairing with the existing host. No room data will be copied yet…';
  try {
    await api('/api/sync/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, code })
    });
    setAuthenticated(false);
    $('#login-error').textContent = 'Host paired. No data has been copied. Sign in with the shared room PIN, then choose when to sync.';
    $('#pin-input').focus();
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
}

async function syncPairedHost(nodeId = null) {
  const message = $('#host-sync-message');
  state.syncingHostId = nodeId || 'all';
  message.textContent = nodeId ? 'Syncing this device now. Its room data will update when the transfer finishes…' : 'Syncing all paired devices now…';
  await refreshHostStatus();
  try {
    const result = await api('/api/sync/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nodeId ? { nodeId } : {})
    });
    await refreshItems();
    message.textContent = result.synced + ' device' + (result.synced === 1 ? '' : 's') + ' synced. This shelf now shows the latest data received.';
    showToast('Room data updated');
  } catch (error) {
    message.textContent = error.message;
  } finally {
    state.syncingHostId = '';
    await refreshHostStatus();
  }
}

function setAuthenticated(authenticated) {
  $('#login-screen').classList.toggle('is-hidden', authenticated);
  $('#app-shell').classList.toggle('is-hidden', !authenticated);
  if (authenticated) {
    $('#pin-input').value = '';
    $('#login-error').textContent = '';
    refreshItems();
    refreshHostStatus();
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => { refreshItems(); refreshHostStatus(); }, 5000);
  } else {
    clearInterval(state.refreshTimer);
    state.items = [];
    $('#host-banner').classList.add('is-hidden');
  }
}

async function freezeHostForTransfer() {
  if (!window.confirm('Pause uploads and deletions on this host so the backup is consistent? You can resume this host if you cancel the move.')) return;
  const button = $('#host-freeze');
  button.disabled = true;
  $('#host-transfer-message').textContent = 'Waiting for active uploads to finish, then pausing sharing…';
  try {
    await api('/api/host/freeze', { method: 'POST' });
    await refreshHostStatus();
    showToast('Host paused. Create an encrypted backup to continue.');
  } catch (error) {
    $('#host-transfer-message').textContent = error.message;
  } finally { button.disabled = false; }
}

async function resumeHost() {
  const button = $('#host-resume');
  if (button) button.disabled = true;
  try {
    await api('/api/host/resume', { method: 'POST' });
    await refreshHostStatus();
    showToast('Sharing resumed on this host');
  } catch (error) { $('#host-transfer-message').textContent = error.message; }
  finally { if (button) button.disabled = false; }
}

async function createHostBackup() {
  const passphrase = $('#host-backup-passphrase').value;
  if (passphrase.length < 12) { $('#host-transfer-message').textContent = 'Choose a passphrase with at least 12 characters.'; return; }
  if (passphrase !== $('#host-backup-passphrase-confirm').value) { $('#host-transfer-message').textContent = 'The backup passphrases do not match.'; return; }
  const button = $('#host-backup-button');
  button.disabled = true;
  $('#host-backup-download').classList.add('is-hidden');
  $('#host-transfer-message').textContent = 'Preparing an encrypted backup. Large rooms can take a while…';
  try {
    const ticket = await api('/api/host/backup-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    $('#host-backup-passphrase').value = '';
    $('#host-backup-passphrase-confirm').value = '';
    const link = $('#host-backup-download');
    link.href = ticket.url;
    link.addEventListener('click', () => {
      window.setTimeout(() => link.classList.add('is-hidden'), 0);
    }, { once: true });
    link.classList.remove('is-hidden');
    $('#host-transfer-message').textContent = 'The backup is ready. Download it, then keep the passphrase safe; it is required to import the room.';
  } catch (error) { $('#host-transfer-message').textContent = error.message; }
  finally { button.disabled = false; }
}

function importHostBackup() {
  const file = $('#host-import-file').files[0];
  const passphrase = $('#host-import-passphrase').value;
  const message = $('#host-transfer-message');
  if (!file) { message.textContent = 'Choose the .lshare backup file first.'; return; }
  if (passphrase.length < 12) { message.textContent = 'Enter the backup passphrase (at least 12 characters).'; return; }
  if (!window.confirm('Import this room onto the new host? It will replace the new host PIN and sign out this browser.')) return;
  const button = $('#host-import-button');
  const progress = $('#host-import-progress');
  const bar = $('span', progress);
  const xhr = new XMLHttpRequest();
  button.disabled = true;
  progress.classList.remove('is-hidden');
  bar.style.width = '0%';
  message.textContent = 'Uploading and verifying the encrypted room backup…';
  xhr.open('POST', '/api/host/import');
  xhr.withCredentials = true;
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Lantern-Backup-Passphrase', encodeHeaderValue(passphrase));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) bar.style.width = Math.min(99, 100 * event.loaded / event.total) + '%';
  };
  xhr.onload = () => {
    let result = {};
    try { result = JSON.parse(xhr.responseText); } catch { /* Keep the generic error below. */ }
    button.disabled = false;
    progress.classList.add('is-hidden');
    if (xhr.status >= 200 && xhr.status < 300) {
      $('#privacy-dialog').close();
      setAuthenticated(false);
      $('#login-error').textContent = 'Room imported. Sign in with the PIN from the previous host.';
      $('#host-import-passphrase').value = '';
      $('#pin-input').focus();
      return;
    }
    message.textContent = result.error || 'The room could not be imported.';
  };
  xhr.onerror = () => {
    button.disabled = false;
    progress.classList.add('is-hidden');
    message.textContent = 'Connection interrupted. The new host was not changed.';
  };
  xhr.send(file);
}

async function refreshItems() {
  try {
    const result = await api('/api/items');
    const nextItems = Array.isArray(result.items) ? result.items : [];
    const unchanged = state.items.length === nextItems.length
      && state.items.every((item, index) => item.id === nextItems[index].id);
    state.items = nextItems;
    if (unchanged) {
      updateCardDates(nextItems);
      return;
    }
    renderItems();
  } catch (error) {
    if (error.status === 401) setAuthenticated(false);
  }
}

function filteredItems() {
  const query = state.search.trim().toLowerCase();
  let result = state.items.filter((item) => state.filter === 'all' || item.kind === state.filter);
  if (query) result = result.filter((item) => (item.name + ' ' + (item.text || '') + ' ' + (item.mime || '')).toLowerCase().includes(query));
  result = result.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!state.oldestFirst) result.reverse();
  return result;
}

function fileIcon(mime) {
  if (mime && mime.startsWith('image/')) return '▧';
  if (mime && mime.startsWith('video/')) return '▶';
  if (mime && mime.startsWith('audio/')) return '♫';
  if (mime && mime.includes('pdf')) return 'P';
  return '↧';
}

function isImageItem(item) {
  const mime = (item.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return /^image\/(?:jpeg|png|gif|webp|avif|bmp|x-icon|tiff)$/.test(mime);
  return (!mime || mime === 'application/octet-stream') && /\.(?:avif|bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(item.name || '');
}

function isAudioItem(item) {
  const mime = (item.mime || '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  return (!mime || mime === 'application/octet-stream') && /\.(?:aac|aif|aiff|amr|flac|m4a|m4b|mid|midi|mp3|oga|ogg|opus|wav|wave|weba|wma|3gp)$/i.test(item.name || '');
}

function createFilePreview(item) {
  const preview = make('div', 'card-preview');
  const lowerMime = (item.mime || '').toLowerCase();
  if (isImageItem(item)) {
    const image = make('img');
    image.src = '/api/files/' + encodeURIComponent(item.id) + '/preview';
    image.alt = item.name;
    image.loading = 'lazy';
    image.onerror = () => {
      const fallback = make('div', 'file-placeholder');
      const glyph = make('span', 'file-glyph', fileIcon(item.mime));
      const ext = make('span', 'file-ext', item.name.includes('.') ? item.name.split('.').pop() : 'Image');
      fallback.append(glyph, ext);
      image.replaceWith(fallback);
    };
    preview.append(image);
  } else if (lowerMime.startsWith('video/')) {
    const video = make('video');
    video.src = '/api/files/' + encodeURIComponent(item.id) + '/preview';
    video.controls = true;
    video.preload = 'metadata';
    preview.append(video);
  } else if (isAudioItem(item)) {
    const audio = make('audio');
    audio.src = '/api/files/' + encodeURIComponent(item.id) + '/preview';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.playsInline = true;
    preview.append(audio);
  } else {
    const fallback = make('div', 'file-placeholder');
    const glyph = make('span', 'file-glyph', fileIcon(item.mime));
    const ext = make('span', 'file-ext', item.name.includes('.') ? item.name.split('.').pop() : 'File');
    fallback.append(glyph, ext);
    preview.append(fallback);
  }
  return preview;
}

function openImageViewer(item) {
  const viewer = $('#image-viewer');
  const image = $('#image-viewer-image');
  image.src = '/api/files/' + encodeURIComponent(item.id) + '/preview';
  image.alt = item.name;
  $('#image-viewer-caption').textContent = item.name;
  viewer.showModal();
}

function createTextPreview(item) {
  const preview = make('div', 'text-preview');
  preview.append(make('span', 'quote-mark', '“'));
  const content = make('p');
  const text = item.text || '';
  const link = text.match(/https?:\/\/[^\s<>"']+/i);
  if (link) {
    const offset = link.index || 0;
    content.append(document.createTextNode(text.slice(0, offset)));
    const anchor = make('a', '', link[0]);
    anchor.href = link[0];
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    content.append(anchor, document.createTextNode(text.slice(offset + link[0].length)));
  } else content.textContent = text;
  preview.append(content);
  return preview;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const helper = make('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.append(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      if (!copied) throw new Error('Clipboard permission is unavailable.');
    }
    showToast('Copied to clipboard');
  } catch {
    showToast('Could not access this device’s clipboard');
  }
}

async function deleteItem(item) {
  if (!confirm('Delete “' + item.name + '” from this shared room?')) return;
  try {
    await api('/api/items/' + encodeURIComponent(item.id), { method: 'DELETE' });
    state.items = state.items.filter((entry) => entry.id !== item.id);
    renderItems();
    showToast('Removed from the shared shelf');
  } catch (error) { showToast(error.message); }
}

function createCard(item) {
  const card = make('article', 'share-card');
  card.dataset.itemId = item.id;
  const preview = item.kind === 'text' ? createTextPreview(item) : createFilePreview(item);
  const kind = make('div', 'card-kind');
  kind.append(make('span', '', item.kind === 'text' ? 'T' : fileIcon(item.mime)), document.createTextNode(item.kind === 'text' ? 'TEXT' : (item.mime || 'FILE').split('/')[0].toUpperCase()));
  preview.append(kind);
  const actions = make('div', 'card-actions');
  if (item.kind === 'text') {
    const copy = make('button', 'card-action', '⧉');
    copy.type = 'button';
    copy.title = 'Copy text';
    copy.setAttribute('aria-label', 'Copy shared text');
    copy.addEventListener('click', () => copyText(item.text || ''));
    actions.append(copy);
  } else {
    if (isImageItem(item)) {
      const view = make('button', 'card-action card-action-label', 'View');
      view.type = 'button';
      view.title = 'View image';
      view.setAttribute('aria-label', 'View image ' + item.name);
      view.addEventListener('click', () => openImageViewer(item));
      actions.append(view);
    }
    if (isAudioItem(item)) {
      const audio = $('audio', preview);
      const play = make('button', 'card-action card-action-label', 'Play');
      play.type = 'button';
      play.title = 'Play audio';
      play.setAttribute('aria-label', 'Play ' + item.name);
      const syncPlayButton = () => {
        const isPlaying = audio && !audio.paused && !audio.ended;
        play.textContent = isPlaying ? 'Pause' : 'Play';
        play.title = isPlaying ? 'Pause audio' : 'Play audio';
        play.setAttribute('aria-label', (isPlaying ? 'Pause ' : 'Play ') + item.name);
      };
      play.addEventListener('click', async () => {
        if (!audio) return;
        if (!audio.paused) {
          audio.pause();
          return;
        }
        $$('#share-grid audio').forEach((otherAudio) => {
          if (otherAudio !== audio) otherAudio.pause();
        });
        try { await audio.play(); }
        catch { showToast('This browser could not play this audio format.'); }
      });
      if (audio) ['play', 'pause', 'ended'].forEach((eventName) => audio.addEventListener(eventName, syncPlayButton));
      actions.append(play);
    }
    const download = make('a', 'card-action', '↓');
    download.href = '/api/files/' + encodeURIComponent(item.id) + '/download';
    download.setAttribute('aria-label', 'Download ' + item.name);
    download.title = 'Download file';
    actions.append(download);
  }
  const remove = make('button', 'card-action', '×');
  remove.type = 'button';
  remove.title = 'Delete share';
  remove.setAttribute('aria-label', 'Delete ' + item.name);
  remove.addEventListener('click', () => deleteItem(item));
  actions.append(remove);
  preview.append(actions);

  const body = make('div', 'card-body');
  const title = make('h3', 'card-title', item.kind === 'text' ? 'Shared note' : item.name);
  title.title = item.kind === 'text' ? 'Shared note' : item.name;
  const description = item.kind === 'text' ? item.text : formatBytes(item.size);
  const desc = make('p', 'card-description', description || 'Shared text');
  const meta = make('div', 'card-meta');
  const date = make('span', '', relativeDate(item.createdAt));
  const device = make('span', 'device-chip');
  device.append(make('i'), document.createTextNode('This room'));
  meta.append(date, device);
  body.append(title, desc, meta);
  card.append(preview, body);
  return card;
}

function updateCardDates(items) {
  const cards = new Map(Array.from($('#share-grid').children, (card) => [card.dataset.itemId, card]));
  items.forEach((item) => {
    const date = cards.get(item.id)?.querySelector('.card-meta > span:first-child');
    const label = relativeDate(item.createdAt);
    if (date && date.textContent !== label) date.textContent = label;
  });
}

function renderItems() {
  const countAll = state.items.length;
  const countText = state.items.filter((item) => item.kind === 'text').length;
  const countFiles = countAll - countText;
  $('#count-all').textContent = String(countAll);
  $('#count-text').textContent = String(countText);
  $('#count-files').textContent = String(countFiles);
  $('#tab-count-all').textContent = String(countAll);
  $('#tab-count-text').textContent = String(countText);
  $('#tab-count-files').textContent = String(countFiles);
  const visible = filteredItems();
  const grid = $('#share-grid');
  const existingCards = new Map(Array.from(grid.children, (card) => [card.dataset.itemId, card]));
  const nextCards = visible.map((item) => {
    const existing = existingCards.get(item.id);
    if (existing) {
      existingCards.delete(item.id);
      const date = existing.querySelector('.card-meta > span:first-child');
      const label = relativeDate(item.createdAt);
      if (date && date.textContent !== label) date.textContent = label;
      return existing;
    }
    return createCard(item);
  });
  const nextCardSet = new Set(nextCards);
  Array.from(grid.children).forEach((card) => {
    if (!nextCardSet.has(card)) card.remove();
  });
  nextCards.forEach((card, index) => {
    const current = grid.children[index];
    if (current !== card) grid.insertBefore(card, current || null);
  });
  $('#empty-state').classList.toggle('is-hidden', visible.length > 0);
  $('#library-footnote').classList.toggle('is-hidden', visible.length === 0);
  $('#empty-state h3').textContent = state.search ? 'Nothing found just yet.' : (state.items.length ? 'Nothing in this view.' : 'A little quiet in here.');
  $('#empty-state p').textContent = state.search ? 'Try another name or a bit of text.' : (state.items.length ? 'Choose another filter or share something new.' : 'Send something from one device and it’ll show up here for everyone in the room.');
  $$('.nav-item, .tab').forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle('is-active', active);
    if (button.matches('[role="tab"]')) button.setAttribute('aria-selected', String(active));
  });
  const label = state.filter === 'all' ? 'Everything' : state.filter === 'text' ? 'Text & links' : 'Files & media';
  $('#breadcrumb-current').textContent = label;
}

async function submitText(event) {
  event.preventDefault();
  const field = $('#text-input');
  const text = field.value;
  if (!text.trim()) { field.focus(); return; }
  const button = $('button[type="submit"]', $('#text-form'));
  button.disabled = true;
  try {
    await api('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    field.value = '';
    await refreshItems();
    showToast('Your note is in the room');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}

function formatQueueState(entry) {
  if (entry.status === 'done') return formatBytes(entry.file.size) + ' · Shared';
  if (entry.status === 'error') return entry.error || 'Upload failed';
  return formatBytes(entry.file.size) + ' · ' + Math.round(entry.progress) + '%';
}

function renderQueue() {
  const queue = $('#upload-queue');
  const active = state.queue.filter((entry) => entry.status === 'sending').length;
  const show = state.queue.length > 0;
  queue.classList.toggle('is-hidden', !show);
  $('#queue-count').textContent = state.queue.length + (state.queue.length === 1 ? ' file' : ' files');
  $('.queue-spinner').style.display = active ? '' : 'none';
  const list = $('#queue-list');
  list.replaceChildren(...state.queue.map((entry) => {
    const row = make('div', 'queue-item');
    row.append(make('span', 'queue-file-icon', fileIcon(entry.file.type)));
    const meta = make('div', 'queue-meta');
    meta.append(make('div', 'queue-name', entry.file.name), make('div', entry.status === 'error' ? 'queue-state queue-error' : 'queue-state', formatQueueState(entry)));
    row.append(meta);
    if (entry.status === 'sending') {
      const progress = make('div', 'queue-progress');
      const bar = make('span');
      bar.style.width = Math.max(2, entry.progress) + '%';
      progress.append(bar);
      row.append(progress);
    } else if (entry.status === 'done') row.append(make('span', 'queue-check', '✓'));
    else row.append(make('span', 'queue-error', '!'));
    return row;
  }));
}

function uploadOne(entry) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const url = '/api/files?name=' + encodeURIComponent(entry.file.name);
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', entry.file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        entry.progress = event.total ? Math.min(99, 100 * event.loaded / event.total) : 0;
        renderQueue();
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        entry.status = 'done';
        entry.progress = 100;
      } else {
        let message = 'Upload failed.';
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* Ignore a non-JSON error response. */ }
        entry.status = 'error';
        entry.error = message;
      }
      renderQueue();
      resolve();
    };
    xhr.onerror = () => { entry.status = 'error'; entry.error = 'Connection interrupted'; renderQueue(); resolve(); };
    xhr.onabort = () => { entry.status = 'error'; entry.error = 'Upload cancelled'; renderQueue(); resolve(); };
    xhr.send(entry.file);
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const batch = files.map((file) => ({ file, status: 'sending', progress: 0 }));
  state.queue.push(...batch);
  renderQueue();
  let next = 0;
  const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
    while (next < batch.length) {
      const current = next++;
      await uploadOne(batch[current]);
    }
  });
  await Promise.all(workers);
  await refreshItems();
  const errors = batch.filter((entry) => entry.status === 'error').length;
  showToast(errors ? (files.length - errors) + ' shared · ' + errors + ' failed' : (files.length === 1 ? 'File shared with the room' : files.length + ' files shared with the room'));
}

function chooseFiles() { $('#file-input').click(); }

function setTheme(theme, persist = true) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  const isDark = selected === 'dark';
  $$('[data-theme-toggle]').forEach((button) => {
    const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(isDark));
    $('.theme-icon', button).textContent = isDark ? '☀' : '☾';
  });
  const themeColor = $('meta[name="theme-color"]');
  if (themeColor) themeColor.content = isDark ? '#111a15' : '#f2f5f0';
  if (persist) {
    try { localStorage.setItem('lantern-share-theme', selected); } catch { /* The theme still applies for this session. */ }
  }
}

function attachEvents() {
  setTheme(document.documentElement.dataset.theme || 'light', false);
  $$('[data-theme-toggle]').forEach((button) => button.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }));
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const pin = $('#pin-input').value.trim();
    const errorNode = $('#login-error');
    errorNode.textContent = '';
    try {
      await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      setAuthenticated(true);
    } catch (error) { errorNode.textContent = error.message; }
  });
  $('#text-form').addEventListener('submit', submitText);
  $('#side-upload').addEventListener('click', chooseFiles);
  $('#empty-upload').addEventListener('click', chooseFiles);
  $('#choose-files').addEventListener('click', (event) => { event.stopPropagation(); chooseFiles(); });
  $('#file-input').addEventListener('change', (event) => { uploadFiles(event.target.files); event.target.value = ''; });
  const dropZone = $('#drop-zone');
  dropZone.addEventListener('click', (event) => { if (!event.target.closest('button')) chooseFiles(); });
  dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseFiles(); } });
  ['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); }));
  ['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); }));
  dropZone.addEventListener('drop', (event) => uploadFiles(event.dataTransfer.files));
  $$('.nav-item, .tab').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderItems(); $('#sidebar').classList.remove('is-open'); }));
  $('#search-input').addEventListener('input', (event) => { state.search = event.target.value; renderItems(); });
  $('#sort-button').addEventListener('click', () => {
    state.oldestFirst = !state.oldestFirst;
    const label = state.oldestFirst ? 'Oldest' : 'Newest';
    $('#sort-button').replaceChildren(document.createTextNode(label + ' '), make('span', '', '⌄'));
    renderItems();
  });
  $('#clear-queue').addEventListener('click', () => { state.queue = state.queue.filter((entry) => entry.status === 'sending'); renderQueue(); });
  $('#logout-button').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* The session may already have expired. */ }
    setAuthenticated(false);
    showToast('You left the room');
  });
  $('#help-button').addEventListener('click', () => { $('#privacy-dialog').showModal(); refreshHostStatus(); });
  $('#dialog-close').addEventListener('click', () => $('#privacy-dialog').close());
  $('#privacy-dialog').addEventListener('click', (event) => { if (event.target === $('#privacy-dialog')) $('#privacy-dialog').close(); });
  $('#host-freeze').addEventListener('click', freezeHostForTransfer);
  $('#host-resume').addEventListener('click', resumeHost);
  $('#host-banner-resume').addEventListener('click', resumeHost);
  $('#host-backup-button').addEventListener('click', createHostBackup);
  $('#host-import-button').addEventListener('click', importHostBackup);
  $('#host-sync-invite').addEventListener('click', createHostSyncInvite);
  $('#host-sync-pair').addEventListener('click', pairHostSync);
  $('#host-sync-all').addEventListener('click', () => syncPairedHost());
  $('#host-sync-peers').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sync-node-id]');
    if (button && !button.disabled) syncPairedHost(button.dataset.syncNodeId);
  });
  const imageViewer = $('#image-viewer');
  $('#image-viewer-close').addEventListener('click', () => imageViewer.close());
  imageViewer.addEventListener('click', (event) => { if (event.target === imageViewer) imageViewer.close(); });
  imageViewer.addEventListener('close', () => {
    const image = $('#image-viewer-image');
    image.removeAttribute('src');
    image.alt = '';
    $('#image-viewer-caption').textContent = '';
  });
  $('#menu-button').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('#sidebar').classList.remove('is-open'); });
}

async function start() {
  attachEvents();
  try {
    const result = await api('/api/session');
    setAuthenticated(result.authenticated);
    if (result.authenticated) {
      state.items = result.items || [];
      renderItems();
    }
  } catch { setAuthenticated(false); }
}

start();
