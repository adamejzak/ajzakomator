'use strict';
const $ = (id) => document.getElementById(id);

function render(state) {
  document.querySelector('.card').dataset.stage = state.stage;
  const percent = Math.round(state.percent);
  $('fill').style.width = state.percent + '%';
  $('percent').textContent = percent + '%';
  $('meter').setAttribute('aria-valuenow', String(percent));
  $('status').textContent = state.message || '';
  if (state.title) $('title').textContent = state.title;
  if (state.versions) $('versions').textContent = state.versions;
  if (state.hint) $('hint').textContent = state.hint;
  $('percent').hidden = state.stage === 'checking';

  const failed = state.stage === 'error';
  $('actions').hidden = !failed;
  // The X is there at every stage; only the app's own startup window withholds it once the installer is being started.
  $('dismiss').hidden = state.closable === false;
  if (failed && state.detail) $('hint').textContent = state.detail;
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.updateSplash.close(); });

window.updateSplash.init().then((info) => {
  $('title').textContent = info.title;
  $('hint').textContent = info.hint;
  $('versions').textContent = info.fromVersion + ' → ' + info.version;
  $('open').textContent = info.open;
  $('close').textContent = info.close;
  $('open').addEventListener('click', () => window.updateSplash.open());
  $('close').addEventListener('click', () => window.updateSplash.close());
  $('dismiss').addEventListener('click', () => window.updateSplash.close());
  $('dismiss').title = info.close;
  $('dismiss').setAttribute('aria-label', info.close);
  render(info.state || { stage: 'preparing', percent: 0, message: '' });
  window.updateSplash.onState(render);
});
