'use strict';
const $ = id => document.getElementById(id);
const formatSlot = n => String(n).padStart(2, '0');
const state = {slots: [], me: '', maxUsers: 10, maxFileMB: 20, used: 0, online: 0, users: []};
let selectedSlot = null;
let activeUpload = false;
let eventSource = null;
let toastTimer = null;

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3300);
}
function prettySize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
async function api(url, {method='GET', body}={}) {
  const response = await fetch(url, {method, credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}
function e(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value !== undefined) el.textContent = value;
  return el;
}
function actionButton(label, action, id, className='') {
  const btn = e('button', className, label);
  btn.type = 'button';
  btn.dataset.action = action;
  btn.dataset.id = String(id);
  btn.disabled = activeUpload;
  btn.setAttribute('aria-label', `${label === 'EDIT' || label === '✎' ? 'Edit names in' : label === 'GET' ? 'Download file from' : label === 'ADD' ? 'Upload file to' : 'Replace file in'} slot ${formatSlot(id)}`);
  return btn;
}
function applyState(next) {
  Object.assign(state, next);
  $('usedCount').innerHTML = ''; // Static markup is cleared; values below are inserted as text.
  $('usedCount').append(document.createTextNode(String(state.used)));
  $('usedCount').append(e('span', '', '/50'));
  $('usedProgress').style.width = (state.used / 50 * 100) + '%';
  $('onlineLabel').textContent = `${state.online} / ${state.maxUsers} online`;
  $('liveDot').classList.toggle('offline', eventSource?.readyState === EventSource.CLOSED);
  if (state.me) $('userLabel').textContent = state.me;
  if (state.maxFileMB) $('maxFileLabel')?.replaceChildren(document.createTextNode(`${state.maxFileMB} MB`));
  renderSlots();
}
function renderSlots() {
  const query = $('search').value.trim().toLowerCase();
  const list = $('slots');
  const fragment = document.createDocumentFragment();
  let visible = 0;
  for (const s of state.slots) {
    const title = s.label || `Slot ${formatSlot(s.id)}`;
    if (query && !`${formatSlot(s.id)} ${title} ${s.file?.name || ''} ${s.file?.by || ''}`.toLowerCase().includes(query)) continue;
    visible++;
    const row = e('article', 'slot' + (s.file ? ' occupied' : ''));
    row.dataset.id = String(s.id);
    row.append(e('div', 'slot-id', formatSlot(s.id)));
    const info = e('div', 'slot-info');
    const displayTitle = e('div', 'slot-title', title);
    displayTitle.title = title;
    const subtitle = e('div', 'slot-file', s.file ? `${s.file.name} · ${prettySize(s.file.size)}` : 'Empty · one file');
    if (s.file) subtitle.title = `${s.file.name} · uploaded by ${s.file.by}`;
    info.append(displayTitle, subtitle);
    row.append(info);
    const actions = e('div', 'slot-actions');
    if (s.file) {
      actions.append(actionButton('GET', 'download', s.id));
      actions.append(actionButton('SWAP', 'upload', s.id));
    } else {
      actions.append(actionButton('+ ADD', 'upload', s.id, 'add-button'));
    }
    actions.append(actionButton('✎', 'edit', s.id, 'edit-button'));
    row.append(actions);
    row.addEventListener('dragover', evt => { evt.preventDefault(); if (!activeUpload) row.classList.add('dragover'); });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', evt => {
      evt.preventDefault(); row.classList.remove('dragover');
      if (!activeUpload && evt.dataTransfer?.files?.[0]) startUpload(s.id, evt.dataTransfer.files[0]);
    });
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  $('visibleCount').textContent = `${visible} ${visible === 1 ? 'SLOT' : 'SLOTS'}`;
  $('emptySearch').hidden = visible !== 0;
}
function findSlot(id) { return state.slots.find(s => s.id === Number(id)); }
function showRoom(name) {
  state.me = name;
  $('joinOverlay').hidden = true;
  $('room').hidden = false;
  $('userLabel').textContent = name;
}
function showJoin() {
  $('joinOverlay').hidden = false;
  $('room').hidden = true;
  if (eventSource) { eventSource.close(); eventSource = null; }
}
function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', event => {
    try { applyState(JSON.parse(event.data)); } catch (err) { console.warn('State update unavailable', err); }
  });
  eventSource.addEventListener('activity', event => {
    try {
      const value = JSON.parse(event.data);
      if (value.name !== state.me) toast(`${value.name} ${value.message}`);
    } catch (_) { /* ignore malformed event */ }
  });
  eventSource.onopen = () => $('liveDot').classList.remove('offline');
  eventSource.onerror = () => $('liveDot').classList.add('offline');
}
async function initialize() {
  try {
    const config = await api('/api/config');
    $('passcodeWrap').hidden = !config.hasPasscode;
    state.maxFileMB = config.maxFileMB;
    document.querySelector('.toolbar-right span:last-child').textContent = `MAX ${config.maxFileMB} MB PER FILE`;
  } catch (_) { /* Show the join page even if the server is temporarily down. */ }
  try {
    const initial = await api('/api/state');
    showRoom(initial.me);
    applyState(initial);
    connectEvents();
  } catch (_) { showJoin(); }
}
$('joinForm').addEventListener('submit', async evt => {
  evt.preventDefault();
  const btn = $('joinBtn');
  btn.disabled = true;
  $('joinError').textContent = '';
  try {
    const joined = await api('/api/join', {method:'POST', body:{name:$('joinName').value.trim(), passcode:$('passcode').value}});
    const initial = await api('/api/state');
    showRoom(joined.name);
    applyState(initial);
    connectEvents();
  } catch (err) { $('joinError').textContent = err.message; }
  finally { btn.disabled = false; }
});
$('leaveBtn').addEventListener('click', async () => {
  if (activeUpload) return toast('Finish the upload before leaving.');
  try { await api('/api/leave', {method:'POST'}); } catch (_) { /* Show join again even if disconnected. */ }
  showJoin();
});
$('search').addEventListener('input', renderSlots);
$('slots').addEventListener('click', evt => {
  const button = evt.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === 'upload') chooseFile(id);
  if (button.dataset.action === 'download') window.location.assign(`/api/slots/${id}/file`);
  if (button.dataset.action === 'edit') openEdit(id);
});
function chooseFile(id) {
  selectedSlot = id;
  const picker = $('filePicker');
  picker.value = '';
  picker.click();
}
$('filePicker').addEventListener('change', evt => {
  const file = evt.target.files?.[0];
  if (selectedSlot && file) startUpload(selectedSlot, file);
});
function startUpload(id, file) {
  if (activeUpload) return;
  if (!file || file.size === 0) return toast('Choose a non-empty file.');
  if (file.size > state.maxFileMB * 1024 * 1024) return toast(`File is too large. Maximum: ${state.maxFileMB} MB.`);
  const target = findSlot(id);
  if (!target) return;
  if (target.file && !window.confirm(`Replace the current file in ${target.label || `Slot ${formatSlot(id)}`}?`)) return;
  activeUpload = true;
  renderSlots();
  $('uploadProgress').hidden = false;
  $('uploadText').textContent = `Uploading to slot ${formatSlot(id)}`;
  $('uploadPercent').textContent = '0%';
  $('uploadBar').style.width = '0%';
  const request = new XMLHttpRequest();
  request.open('PUT', `/api/slots/${id}/file`, true);
  request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.setRequestHeader('X-File-Name', encodeURIComponent(file.name.slice(0, 180)));
  request.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    const percent = Math.min(100, Math.round(event.loaded / event.total * 100));
    $('uploadPercent').textContent = `${percent}%`;
    $('uploadBar').style.width = `${percent}%`;
  };
  request.onload = () => {
    activeUpload = false;
    $('uploadProgress').hidden = true;
    renderSlots();
    if (request.status >= 200 && request.status < 300) toast(`File saved in slot ${formatSlot(id)}.`);
    else {
      let message = 'Upload failed.';
      try { message = JSON.parse(request.responseText).error || message; } catch (_) {}
      toast(message);
    }
  };
  request.onerror = () => {
    activeUpload = false;
    $('uploadProgress').hidden = true;
    renderSlots();
    toast('Upload failed. Check your connection.');
  };
  request.send(file);
}
function openEdit(id) {
  const slot = findSlot(id);
  if (!slot) return;
  selectedSlot = id;
  $('editNumber').textContent = 'SLOT ' + formatSlot(id);
  $('slotName').value = slot.label || '';
  $('fileNameFields').hidden = !slot.file;
  $('fileName').value = slot.file?.name || '';
  $('deleteFileBtn').hidden = !slot.file;
  $('editError').textContent = '';
  $('editDialog').showModal();
  $('slotName').focus();
}
function closeEdit() { $('editDialog').close(); }
$('closeEdit').addEventListener('click', closeEdit);
$('cancelEdit').addEventListener('click', closeEdit);
$('editDialog').addEventListener('click', evt => { if (evt.target === $('editDialog')) closeEdit(); });
$('editForm').addEventListener('submit', async evt => {
  evt.preventDefault();
  const id = selectedSlot;
  const current = findSlot(id);
  if (!current) return;
  const save = $('saveEdit');
  save.disabled = true;
  $('editError').textContent = '';
  try {
    if (current.label !== $('slotName').value.trim())
      await api(`/api/slots/${id}/name`, {method:'POST', body:{name:$('slotName').value.trim()}});
    if (current.file && current.file.name !== $('fileName').value.trim())
      await api(`/api/slots/${id}/file-name`, {method:'POST', body:{name:$('fileName').value.trim()}});
    closeEdit();
    toast(`Slot ${formatSlot(id)} updated.`);
  } catch (err) { $('editError').textContent = err.message; }
  finally { save.disabled = false; }
});
$('deleteFileBtn').addEventListener('click', async () => {
  const id = selectedSlot;
  if (!window.confirm(`Remove this file from slot ${formatSlot(id)} for everyone?`)) return;
  const button = $('deleteFileBtn');
  button.disabled = true;
  try {
    await api(`/api/slots/${id}/file`, {method:'DELETE'});
    closeEdit();
    toast(`Slot ${formatSlot(id)} is now empty.`);
  } catch (err) { $('editError').textContent = err.message; }
  finally { button.disabled = false; }
});
initialize();
