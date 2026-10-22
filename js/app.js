// Racesounds opname: schermen, navigatie (hash) en het begeleide opnameprotocol.

import * as db from './db.js';
import { AudioInput } from './recorder.js';
import { encodeWav, levels, toDb } from './wav.js';
import { analyzeTake, estimateLive, MIN_CONFIDENCE, searchRange } from './rpm.js';
import { exportZip, safeName } from './export.js';
import {
  byDate, DEFAULT_RPM_TARGETS, fillRpm, itemStatus, KINDS, newId, newMotor, POSITIONS,
  recordingItems, takeMatches, takeWarnings,
} from './model.js';

export const APP_VERSION = '1.0.0';
const BIT_DEPTH = 24;
const COUNTDOWN_SECONDS = 3;

const params = new URLSearchParams(location.search);
// Testbron in plaats van de microfoon: ?bron=synth[&synthfactor=1.3] (toerental = doel x factor).
const SYNTH = params.get('bron') === 'synth';
const SYNTH_FACTOR = Number(params.get('synthfactor')) || 1;

const main = document.getElementById('main');

// --- Hulpjes -----------------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtRpm = (r) => (r == null || !Number.isFinite(r) ? '–' : `${Math.round(r)}`);
const fmtDb = (d) => `${d.toFixed(1).replace('.', ',')} dBFS`;
const fmtS = (s) => `${s.toFixed(1).replace('.', ',')} s`;
const pct = (est, target) => {
  const p = Math.round(100 * (est / target - 1));
  return `${p > 0 ? '+' : ''}${p}%`;
};

/** Vervangt de inhoud van het scherm (arrays worden platgeslagen, null overgeslagen). */
function setMain(...children) {
  main.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function toast(text, ms = 3500) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

function statusBadge(status) {
  const cls = { 'nog niet': 'st-none', opgenomen: 'st-ok', opnieuw: 'st-redo' }[status];
  return h('span', { class: `badge ${cls}` }, status);
}

// --- Navigatie ---------------------------------------------------------------------------------

let cleanup = null; // opruimen van het vorige scherm (timers, microfoon)

async function render() {
  const [route, ...args] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const next = route === 'opnemen';
  if (cleanup) {
    const c = cleanup;
    cleanup = null;
    await c(next);
  }
  window.scrollTo(0, 0);
  try {
    if (!route) await homeScreen();
    else if (route === 'nieuw') await motorForm(null);
    else if (route === 'bewerk') await motorForm(args[0]);
    else if (route === 'motor') await motorScreen(args[0], args[1]);
    else if (route === 'opnemen') await recordScreen(args[0], args[1], args[2], args[3] === 'begeleid');
    else if (route === 'tips') tipsScreen();
    else await homeScreen();
  } catch (err) {
    console.error(err);
    setMain(h('div', { class: 'card error' }, h('h2', {}, 'Er ging iets mis'), h('p', {}, String(err.message || err)),
      h('button', { class: 'btn', onclick: () => go('#/') }, 'Naar de motorlijst')));
  }
}

window.addEventListener('hashchange', render);

// --- Motorlijst --------------------------------------------------------------------------------

async function homeScreen() {
  const motors = (await db.listMotors()).sort((a, b) => a.name.localeCompare(b.name));
  const rows = [];
  for (const m of motors) {
    const takes = await db.listTakeMeta(m.id);
    const positions = [...new Set(takes.map((t) => t.position))];
    rows.push(h('button', { class: 'card motor-card', onclick: () => go(`#/motor/${m.id}`) },
      h('div', { class: 'motor-name' }, m.name || '(naamloos)'),
      h('div', { class: 'muted' }, motorSummary(m)),
      h('div', { class: 'muted' }, `${takes.length} opname${takes.length === 1 ? '' : 's'}`,
        positions.length ? ` · ${positions.join(', ')}` : '')));
  }
  const est = await db.storageEstimate();
  setMain(
    h('header', { class: 'topbar' }, h('h1', {}, 'Racesounds opname')),
    SYNTH ? h('div', { class: 'card warn' }, 'Testbron actief (synthetisch geluid, geen microfoon).') : null,
    rows.length ? rows : h('div', { class: 'card muted' }, 'Nog geen motoren. Maak er een aan om te beginnen.'),
    h('button', { class: 'btn primary big', onclick: () => go('#/nieuw') }, '+ Nieuwe motor'),
    h('button', { class: 'btn', onclick: () => go('#/tips') }, 'Opnametips'),
    h('p', { class: 'muted small' }, `Versie ${APP_VERSION}`,
      est?.usage != null ? ` · opslag ${(est.usage / 1e6).toFixed(0)} MB van ${(est.quota / 1e9).toFixed(1)} GB` : ''),
  );
}

function motorSummary(m) {
  const parts = [`${m.cylinders} cil. ${m.layout}`];
  if (m.displacementCc) parts.push(`${m.displacementCc} cc`);
  parts.push(m.fuel);
  if (m.turbo) parts.push('turbo');
  parts.push(`${m.idleRpm}–${m.limiterRpm} tpm`);
  return parts.join(' · ');
}

// --- Motor aanmaken/bewerken -------------------------------------------------------------------

async function motorForm(id) {
  const existing = id ? await db.getMotor(id) : null;
  if (id && !existing) return go('#/');
  const m = existing ? structuredClone(existing) : newMotor();
  let targets = [...(m.rpmTargets || DEFAULT_RPM_TARGETS)];

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  const text = (key, attrs = {}) => h('input', { type: 'text', value: m[key] ?? '', oninput: (e) => { m[key] = e.target.value; }, ...attrs });
  const num = (key, attrs = {}) => h('input', { type: 'number', inputmode: 'numeric', value: m[key] ?? '', oninput: (e) => { m[key] = e.target.value === '' ? '' : Number(e.target.value); }, ...attrs });
  const select = (key, options) => h('select', { onchange: (e) => { m[key] = isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value); } },
    options.map(([v, l]) => h('option', { value: v, selected: String(m[key]) === String(v) }, l)));

  const chips = h('div', { class: 'chips' });
  const drawChips = () => {
    chips.replaceChildren(...targets.map((t, i) => h('span', { class: 'chip' }, t === 'idle' ? 'stationair' : `${t}`,
      h('button', { class: 'chip-x', 'aria-label': 'verwijderen', onclick: (e) => { e.preventDefault(); targets.splice(i, 1); drawChips(); } }, '×'))));
  };
  drawChips();
  const addInput = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'bv. 3000' });
  const addTarget = (e) => {
    e.preventDefault();
    const v = Math.round(Number(addInput.value));
    if (v > 0 && !targets.includes(v)) targets.push(v);
    targets.sort((a, b) => (a === 'idle' ? -1 : b === 'idle' ? 1 : a - b));
    addInput.value = '';
    drawChips();
  };

  const save = async (e) => {
    e.preventDefault();
    if (!String(m.name).trim()) {
      m.name = [m.make, m.model, m.engineCode].filter(Boolean).join(' ').trim();
      if (!m.name) return toast('Geef de motor een naam.');
    }
    if (!(m.cylinders >= 1 && m.cylinders <= 16)) return toast('Aantal cilinders klopt niet.');
    m.rpmTargets = targets.length ? targets : [...DEFAULT_RPM_TARGETS];
    m.updatedAt = new Date().toISOString();
    await db.putMotor(m);
    db.requestPersistence();
    go(`#/motor/${m.id}`);
  };

  const remove = async (e) => {
    e.preventDefault();
    if (!confirm(`Motor "${m.name}" en alle opnames verwijderen?`)) return;
    await db.deleteMotor(m.id);
    go('#/');
  };

  setMain(
    h('header', { class: 'topbar' },
      h('button', { class: 'back', onclick: () => history.back(), 'aria-label': 'terug' }, '‹'),
      h('h1', {}, existing ? 'Motor bewerken' : 'Nieuwe motor')),
    h('form', { class: 'card form', onsubmit: save },
      field('Naam', text('name', { placeholder: 'bv. Skoda Octavia 2.0 TSI', required: true })),
      h('div', { class: 'row3' },
        field('Merk', text('make')),
        field('Model', text('model')),
        field('Bouwjaar', num('year', { min: 1900, max: 2100 }))),
      field('Motorcode', text('engineCode', { placeholder: 'bv. CHHB' })),
      h('div', { class: 'row3' },
        field('Cilinders', num('cylinders', { min: 1, max: 16, required: true })),
        field('Opbouw', select('layout', [['lijn', 'lijn'], ['V', 'V'], ['boxer', 'boxer']])),
        field('Inhoud (cc)', num('displacementCc', { min: 50, max: 10000 }))),
      h('div', { class: 'row3' },
        field('Brandstof', select('fuel', [['benzine', 'benzine'], ['diesel', 'diesel']])),
        field('Turbo', h('select', { onchange: (e) => { m.turbo = e.target.value === 'ja'; } },
          h('option', { value: 'nee', selected: !m.turbo }, 'nee'), h('option', { value: 'ja', selected: !!m.turbo }, 'ja'))),
        h('span')),
      h('div', { class: 'row3' },
        field('Stationair (tpm)', num('idleRpm', { min: 300, max: 3000 })),
        field('Begrenzer (tpm)', num('limiterRpm', { min: 1000, max: 20000 })),
        h('span')),
      field('Toerentallen voor constante opnames', chips),
      h('div', { class: 'inline' }, addInput,
        h('button', { class: 'btn', onclick: addTarget }, 'Toevoegen'),
        h('button', { class: 'btn', onclick: (e) => { e.preventDefault(); targets = [...DEFAULT_RPM_TARGETS]; drawChips(); } }, 'Standaard')),
      field('Notities', h('textarea', { rows: 3, oninput: (e) => { m.notes = e.target.value; } }, m.notes || '')),
      h('button', { class: 'btn primary big', type: 'submit' }, 'Opslaan'),
      existing ? h('button', { class: 'btn danger', onclick: remove }, 'Motor verwijderen') : null,
    ),
  );
}

// --- Motor: opnames per positie ----------------------------------------------------------------

let currentAudio = null;
function playBlob(blob) {
  stopPlayback();
  const url = URL.createObjectURL(blob);
  currentAudio = new Audio(url);
  currentAudio.onended = () => URL.revokeObjectURL(url);
  currentAudio.play();
}
function stopPlayback() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

async function motorScreen(id, position) {
  const m = await db.getMotor(id);
  if (!m) return go('#/');
  const pos = POSITIONS.some((p) => p.id === position) ? position : (sessionStorage.getItem('pos') || 'motorkap');
  sessionStorage.setItem('pos', pos);
  const takes = await db.listTakeMeta(id);
  const items = recordingItems(m);

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, POSITIONS.map((p) => {
    const n = takes.filter((t) => t.position === p.id).length;
    return h('button', { class: `tab ${p.id === pos ? 'active' : ''}`, role: 'tab', onclick: () => go(`#/motor/${id}/${p.id}`) },
      p.label, n ? h('span', { class: 'tab-count' }, n) : null);
  }));

  const list = items.map((item) => {
    const mine = takes.filter((t) => takeMatches(t, item, pos)).sort(byDate);
    const status = itemStatus(item, pos, takes);
    const last = mine[mine.length - 1];
    const estText = last && item.kind === 'constant' && last.rpmEstimated
      ? `geschat ${fmtRpm(last.rpmEstimated)} (${pct(last.rpmEstimated, item.rpm)})` : '';
    return h('div', { class: 'card item' },
      h('div', { class: 'item-head' },
        h('div', {},
          h('div', { class: 'item-label' }, item.label),
          h('div', { class: 'muted small' }, statusBadge(status), ' ', estText)),
        h('button', { class: 'btn rec', onclick: () => go(`#/opnemen/${id}/${pos}/${item.key}`) }, '● Opnemen')),
      mine.length ? h('div', { class: 'takes' }, mine.map((t, i) => takeRow(t, i, m))) : null);
  });

  const recorded = items.filter((it) => itemStatus(it, pos, takes) === 'opgenomen').length;
  const nextItem = items.find((it) => itemStatus(it, pos, takes) !== 'opgenomen');

  setMain(
    h('header', { class: 'topbar' },
      h('button', { class: 'back', onclick: () => go('#/'), 'aria-label': 'terug' }, '‹'),
      h('h1', {}, m.name),
      h('button', { class: 'btn small', onclick: () => go(`#/bewerk/${id}`) }, 'Bewerk')),
    h('p', { class: 'muted' }, motorSummary(m)),
    tabs,
    h('div', { class: 'card' },
      h('div', {}, `${recorded} van ${items.length} opgenomen bij ${POSITIONS.find((p) => p.id === pos).label.toLowerCase()}`),
      nextItem
        ? h('button', { class: 'btn primary big', onclick: () => go(`#/opnemen/${id}/${pos}/${nextItem.key}/begeleid`) },
          recorded ? `Verder: ${nextItem.label}` : 'Begeleide opname starten')
        : h('div', { class: 'ok-text' }, 'Alles opgenomen voor deze positie.')),
    list,
    exportCard(m, takes),
  );
}

function takeRow(t, i, m) {
  const warn = takeWarnings(t);
  const row = h('div', { class: 'take' },
    h('div', { class: 'take-info' },
      h('div', {}, `#${i + 1} · ${new Date(t.createdAt).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })} · ${fmtS(t.durationSeconds)}`),
      h('div', { class: 'muted small' },
        t.kind === 'stilte' ? `rms ${fmtDb(t.rmsDbfs)}` : `ingevoerd ${fmtRpm(t.rpmEntered)} · geschat ${fmtRpm(t.rpmEstimated)}`,
        ` · piek ${fmtDb(t.peakDbfs)}`),
      warn.length ? h('div', { class: 'warn-text small' }, warn.join(' ')) : null,
      t.notes ? h('div', { class: 'small' }, t.notes) : null),
    h('div', { class: 'take-actions' },
      h('button', { class: 'btn small', onclick: async () => playBlob((await db.getTake(t.id)).wav) }, '▶'),
      h('button', {
        class: `btn small ${t.redo ? 'redo-on' : ''}`,
        onclick: async () => {
          const full = await db.getTake(t.id);
          full.redo = !full.redo;
          await db.putTake(full);
          render();
        },
      }, t.redo ? 'Opnieuw ✓' : 'Opnieuw'),
      h('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!confirm('Deze opname verwijderen?')) return;
          await db.deleteTake(t.id);
          render();
        },
      }, '🗑')));
  return row;
}

function exportCard(m, takes) {
  const busy = h('div', { class: 'muted small' });
  const build = async () => {
    busy.textContent = 'Zip maken…';
    const full = await db.listTakes(m.id);
    const wavBytes = new Map();
    for (const t of full) wavBytes.set(t.id, new Uint8Array(await t.wav.arrayBuffer()));
    const metas = full.map(({ wav, ...rest }) => rest);
    const { fileName, parts } = exportZip(m, metas, wavBytes);
    const blob = new Blob(parts, { type: 'application/zip' });
    busy.textContent = `${fileName}: ${(blob.size / 1e6).toFixed(1)} MB, ${metas.length} opnames`;
    return { fileName, blob };
  };
  const download = ({ fileName, blob }) => {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const share = async () => {
    const z = await build();
    const file = new File([z.blob], z.fileName, { type: 'application/zip' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: m.name });
      } catch (err) {
        if (err.name !== 'AbortError') toast(`Delen mislukt: ${err.message}`);
      }
    } else {
      download(z);
      toast('Zip opgeslagen in Downloads. Upload hem nu in de OneDrive-app (zie uitleg).', 6000);
    }
  };
  // Chrome deelt alleen bepaalde bestandstypes (audio, beeld, pdf, tekst); zip hoort daar meestal
  // niet bij. Dan is de route: opslaan in Downloads en uploaden met de OneDrive-app.
  const canShareZip = !!navigator.canShare?.({ files: [new File([''], 'x.zip', { type: 'application/zip' })] });
  return h('div', { class: 'card' },
    h('h2', {}, 'Exporteren'),
    h('p', { class: 'muted small' }, `Zip met map ${safeName(m.name)}/: WAV's, motor.json en manifest.json. Doel in OneDrive: Racesounds/opnames/.`),
    canShareZip
      ? h('button', { class: 'btn primary big', disabled: !takes.length, onclick: share }, 'Zip delen (OneDrive)')
      : null,
    h('button', { class: `btn ${canShareZip ? '' : 'primary big'}`, disabled: !takes.length, onclick: async () => download(await build()) }, 'Zip opslaan'),
    canShareZip ? null : h('ol', { class: 'small steps' },
      h('li', {}, 'Tik op "Zip opslaan" (komt in Downloads).'),
      h('li', {}, 'Open de OneDrive-app → map Racesounds/opnames.'),
      h('li', {}, 'Tik op + → Uploaden → Downloads → kies de zip.')),
    busy);
}

// --- Opnemen -----------------------------------------------------------------------------------

let input = null; // AudioInput, blijft open zolang je tussen opnameschermen wisselt
let wakeLock = null;

async function ensureInput(m) {
  if (input) return input;
  input = await AudioInput.open(SYNTH ? { rpm: 0, cylinders: Number(m.cylinders) } : null);
  return input;
}

async function closeInput() {
  const i = input;
  input = null;
  await i?.close();
  try { await wakeLock?.release(); } catch { /* al vrij */ }
  wakeLock = null;
}

const TIPS = [
  'Telefoon vastleggen (klem, tape of op een doek), niet vasthouden.',
  'Windkapje of sok over de microfoon.',
  'Airco, blower en radio uit.',
  'Warme motor.',
  'Stille plek, geen laders of stroomkabels in de buurt (50 Hz-brom).',
  'Begin per positie met 5 s stilte, motor uit.',
];

function tipsList() {
  return h('ul', { class: 'tips' }, TIPS.map((t) => h('li', {}, t)));
}

function tipsScreen() {
  setMain(
    h('header', { class: 'topbar' },
      h('button', { class: 'back', onclick: () => history.back(), 'aria-label': 'terug' }, '‹'),
      h('h1', {}, 'Opnametips')),
    h('div', { class: 'card' }, tipsList(),
      h('p', {}, 'Per toerental: minstens 8–10 s constant vasthouden. Lees het toerental af en vul het in; de app schat het ook uit het geluid.'),
      h('p', {}, 'Niveau: de meter moet bij het hoogste toerental onder het rode deel blijven. Bij "te zacht" de telefoon dichterbij.')),
  );
}

async function recordScreen(motorId, pos, itemKey, guided) {
  const m = await db.getMotor(motorId);
  if (!m) return go('#/');
  const items = recordingItems(m);
  const item = items.find((it) => it.key === itemKey);
  if (!item) return go(`#/motor/${motorId}/${pos}`);
  const kind = KINDS[item.kind];
  const cylinders = Number(m.cylinders);
  const range = searchRange(m);
  const posLabel = POSITIONS.find((p) => p.id === pos)?.label ?? pos;

  // Elementen die live bijgewerkt worden.
  const meterFill = h('div', { class: 'meter-fill' });
  const meterHold = h('div', { class: 'meter-hold' });
  const meterText = h('div', { class: 'meter-text' }, '–');
  const rpmLive = h('div', { class: 'rpm-live' }, '–');
  const stage = h('div', { class: 'stage' });
  const inputInfo = h('div', { class: 'muted small' });

  const tipsOpen = !localStorage.getItem('tipsGezien');
  const tipsBox = h('details', { class: 'card tipsbox', open: tipsOpen },
    h('summary', {}, 'Tips'), tipsList());
  // Alleen de eerste keer open; daarna ingeklapt zodat de bediening bovenaan het scherm staat.
  try { localStorage.setItem('tipsGezien', '1'); } catch { /* geen opslag */ }

  const takes = await db.listTakeMeta(motorId);
  const hasSilence = takes.some((t) => t.kind === 'stilte' && t.position === pos);

  setMain(
    h('header', { class: 'topbar' },
      h('button', { class: 'back', onclick: () => go(`#/motor/${motorId}/${pos}`), 'aria-label': 'terug' }, '‹'),
      h('h1', {}, item.label)),
    h('div', { class: 'muted' }, `${m.name} · ${posLabel}${guided ? ' · begeleid' : ''}`),
    tipsBox,
    item.kind !== 'stilte' && !hasSilence
      ? h('div', { class: 'card warn small' }, 'Nog geen stilte-opname voor deze positie. ',
        h('a', { href: `#/opnemen/${motorId}/${pos}/stilte${guided ? '/begeleid' : ''}` }, 'Eerst stilte opnemen'))
      : null,
    h('div', { class: 'card' },
      item.rpm ? h('div', { class: 'target' }, h('span', { class: 'muted' }, 'Doel '), `${item.rpm} tpm`) : null,
      h('p', { class: 'instruction' }, fillRpm(kind.instruction, item.rpm)),
      h('div', { class: 'meter' }, meterFill, meterHold), meterText,
      item.kind !== 'stilte' ? h('div', { class: 'rpm-box' }, h('span', { class: 'muted' }, 'Geschat uit geluid: '), rpmLive) : null,
      inputInfo),
    stage,
  );

  // Microfoon openen (eerste keer: toestemming).
  try {
    stage.replaceChildren(h('div', { class: 'muted' }, 'Microfoon openen…'));
    await ensureInput(m);
  } catch (err) {
    stage.replaceChildren(h('div', { class: 'card error' },
      h('p', {}, `Geen microfoon: ${err.message || err}`),
      h('p', { class: 'small' }, 'Geef de site toegang tot de microfoon (slotje in de adresbalk → Machtigingen).'),
      h('button', { class: 'btn', onclick: () => render() }, 'Opnieuw proberen')));
    return;
  }
  input.setSynthRpm(item.kind === 'stilte' ? 0 : item.rpm * SYNTH_FACTOR);
  const procWarn = input.processingWarnings();
  inputInfo.replaceChildren(
    `${input.label} · ${input.sampleRate} Hz · ${BIT_DEPTH}-bit mono`,
    procWarn.length ? h('div', { class: 'warn-text' }, `Let op: ${procWarn.join(', ')} staat nog aan (browser negeert de instelling).`) : ' · ruwe audio');
  try { wakeLock = wakeLock || await navigator.wakeLock?.request('screen'); } catch { /* niet ondersteund */ }

  // Niveaumeter + live schatting.
  let hold = -90, holdAt = 0, alive = true;
  const recent = [];
  const meterLoop = () => {
    if (!alive || !input) return;
    const p = toDb(input.takePeak());
    const now = performance.now();
    if (p > hold || now - holdAt > 1500) { hold = p; holdAt = now; }
    const pos01 = (d) => `${Math.max(0, Math.min(100, (d + 60) / 60 * 100))}%`;
    meterFill.style.width = pos01(p);
    meterHold.style.left = pos01(hold);
    const clip = now - input.clipAt < 2000;
    const quiet = item.kind !== 'stilte' && hold < -40;
    meterFill.className = `meter-fill ${clip || hold > -1 ? 'hot' : hold > -6 ? 'warm' : quiet ? 'low' : 'good'}`;
    meterText.textContent = clip ? `OVERSTURING (clipping) · piek ${fmtDb(hold)}`
      : quiet ? `Te zacht · piek ${fmtDb(hold)}`
        : `Piek ${fmtDb(hold)}`;
    meterText.className = `meter-text ${clip ? 'warn-text' : quiet ? 'muted' : ''}`;
    requestAnimationFrame(meterLoop);
  };
  requestAnimationFrame(meterLoop);
  const rpmTimer = item.kind === 'stilte' ? null : setInterval(() => {
    if (!input) return;
    const e = estimateLive(input.latest(1.0), input.sampleRate, { cylinders, ...range });
    if (!e || e.confidence < MIN_CONFIDENCE) {
      recent.length = 0;
      rpmLive.textContent = 'geen duidelijke toon';
      rpmLive.className = 'rpm-live muted';
      return;
    }
    recent.push(e.rpm);
    if (recent.length > 3) recent.shift();
    const r = [...recent].sort((a, b) => a - b)[recent.length >> 1];
    rpmLive.textContent = item.kind === 'constant' ? `${fmtRpm(r)} tpm (${pct(r, item.rpm)})` : `${fmtRpm(r)} tpm`;
    const off = Math.abs(r / item.rpm - 1);
    rpmLive.className = `rpm-live ${item.kind !== 'constant' ? '' : off < 0.05 ? 'ok-text' : off < 0.15 ? 'warm-text' : 'warn-text'}`;
  }, 300);

  let timers = [];
  cleanup = async (stayRecording) => {
    alive = false;
    clearInterval(rpmTimer);
    timers.forEach(clearTimeout);
    timers.forEach(clearInterval);
    if (input?.recording) input.stopRecording();
    stopPlayback();
    if (!stayRecording) await closeInput();
  };

  // --- Toestanden: klaar -> aftellen -> opnemen -> beoordelen.
  const ready = () => {
    stage.replaceChildren(h('button', { class: 'btn rec huge', onclick: countdown }, '● Start opname'),
      h('p', { class: 'muted small center' }, `Na ${COUNTDOWN_SECONDS} s aftellen loopt de opname ${item.kind === 'constant' ? `minstens ${kind.minSeconds} s` : `${kind.seconds} s`}.`));
  };

  const countdown = () => {
    let n = COUNTDOWN_SECONDS;
    const big = h('div', { class: 'countdown' }, n);
    stage.replaceChildren(h('div', { class: 'card center' }, h('div', { class: 'muted' }, item.kind === 'stilte' ? 'Motor uit, stil…' : 'Klaar maken…'), big,
      h('button', { class: 'btn', onclick: () => { timers.forEach(clearInterval); ready(); } }, 'Annuleren')));
    stage.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const t = setInterval(() => {
      n--;
      if (n > 0) big.textContent = n;
      else { clearInterval(t); record(); }
    }, 1000);
    timers.push(t);
  };

  const record = () => {
    input.startRecording();
    const clock = h('div', { class: 'countdown' }, '0,0');
    const bar = h('div', { class: 'progress-fill' });
    const cue = h('div', { class: 'cue' });
    const sub = h('div', { class: 'muted' });
    const stopBtn = h('button', { class: 'btn huge stop', onclick: () => finish() }, '■ Stop');
    stage.replaceChildren(h('div', { class: 'card center recording' }, h('div', { class: 'rec-dot' }, '● OPNAME'), clock,
      h('div', { class: 'progress' }, bar), cue, sub, stopBtn));
    const total = kind.seconds;
    const t = setInterval(() => {
      const s = input.recordedSeconds;
      if (item.kind === 'stilte') clock.textContent = `nog ${Math.max(0, Math.ceil(total - s))}`;
      else clock.textContent = s.toFixed(1).replace('.', ',');
      bar.style.width = `${Math.min(100, (s / total) * 100)}%`;
      if (item.kind === 'constant') {
        sub.textContent = s < kind.minSeconds ? `Vasthouden… nog ${Math.ceil(kind.minSeconds - s)} s tot het minimum` : 'Minimum gehaald, stoppen mag (of laat doorlopen).';
        sub.className = s < kind.minSeconds ? 'muted' : 'ok-text';
      } else if (kind.cueAt != null) {
        if (s >= kind.cueAt) {
          cue.textContent = kind.cue;
          cue.className = 'cue on';
          if (item.kind === 'optrekken') {
            const r = Math.min(1, (s - kind.cueAt) / kind.rampSeconds);
            sub.textContent = r < 1 ? `Rustig naar ~${Math.round(m.idleRpm + r * (item.rpm - m.idleRpm))} tpm` : 'Gas los';
          } else sub.textContent = 'Laten terugzakken naar stationair';
        } else {
          cue.textContent = `over ${Math.ceil(kind.cueAt - s)}…`;
          cue.className = 'cue';
          sub.textContent = item.kind === 'gaslos' ? `Houd ~${item.rpm} tpm vast` : 'Stationair';
        }
      }
      if (s >= total) finish();
    }, 100);
    timers.push(t);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(t);
      const samples = input.stopRecording();
      review(samples);
    };
  };

  const review = (samples) => {
    const lv = levels(samples);
    const seconds = samples.length / input.sampleRate;
    const analysis = item.kind === 'stilte' ? null : analyzeTake(samples, input.sampleRate, { cylinders, ...range }, 0.5);
    const wav = encodeWav(samples, input.sampleRate, BIT_DEPTH);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const draft = {
      id: newId(),
      motorId,
      kind: item.kind,
      position: pos,
      rpmTarget: item.rpm,
      rpmEntered: item.rpm,
      rpmEstimated: analysis?.rpm ?? null,
      rpmConfidence: analysis?.confidence ?? null,
      rpmSpread: analysis?.spread ?? null,
      rpmSeries: analysis?.series ?? [],
      durationSeconds: seconds,
      peakDbfs: lv.peakDbfs,
      rmsDbfs: lv.rmsDbfs,
      clippedSamples: lv.clippedSamples,
      sampleRate: input.sampleRate,
      bitDepth: BIT_DEPTH,
      createdAt: new Date().toISOString(),
      notes: '',
      redo: false,
    };
    draft.redo = lv.clippedSamples > 0;
    const warnings = takeWarnings(draft);
    if (analysis && analysis.rpm == null) warnings.push('Geen duidelijke motortoon gevonden.');
    else if (analysis && item.kind === 'constant' && analysis.spread > 0.1) warnings.push('Toerental niet constant (spreiding > 10%).');

    const canvas = h('canvas', { class: 'wave', width: 600, height: 120 });
    const enteredInput = h('input', { type: 'number', inputmode: 'numeric', value: item.rpm ?? '', oninput: (e) => { draft.rpmEntered = e.target.value === '' ? null : Number(e.target.value); } });
    const notes = h('textarea', { rows: 2, placeholder: 'bv. airco aan, wind, 2e versnelling…', oninput: (e) => { draft.notes = e.target.value; } });
    const save = async () => {
      await db.putTake({ ...draft, wav: blob });
      navigator.vibrate?.(80);
      if (guided) {
        const all = await db.listTakeMeta(motorId);
        const next = items.find((it) => itemStatus(it, pos, all) !== 'opgenomen');
        if (next) return go(`#/opnemen/${motorId}/${pos}/${next.key}/begeleid`);
        toast('Alles opgenomen voor deze positie.');
      }
      go(`#/motor/${motorId}/${pos}`);
    };

    stage.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, 'Terugluisteren'),
      canvas,
      h('button', { class: 'btn big', onclick: () => playBlob(blob) }, '▶ Afspelen'),
      h('dl', { class: 'stats' },
        h('dt', {}, 'Duur'), h('dd', {}, fmtS(seconds)),
        h('dt', {}, 'Piek'), h('dd', {}, fmtDb(lv.peakDbfs)),
        h('dt', {}, 'Rms'), h('dd', {}, fmtDb(lv.rmsDbfs)),
        analysis ? [h('dt', {}, 'Geschat'), h('dd', {}, analysis.rpm
          ? `${fmtRpm(analysis.rpm)} tpm${item.kind === 'constant' ? ` (${pct(analysis.rpm, item.rpm)} t.o.v. doel)` : ''}`
          : '–')] : null,
        analysis?.series.length && item.kind !== 'constant' ? [h('dt', {}, 'Verloop'), h('dd', {}, rpmRange(analysis.series))] : null),
      warnings.length ? h('div', { class: 'warn-text' }, warnings.map((w) => h('div', {}, '⚠ ', w))) : h('div', { class: 'ok-text' }, '✓ Niveau goed'),
      item.kind !== 'stilte' ? h('label', { class: 'field' }, h('span', {}, 'Afgelezen toerental (tpm)'), enteredInput) : null,
      h('label', { class: 'field' }, h('span', {}, 'Notities'), notes),
      h('button', { class: 'btn primary big', onclick: save }, guided ? 'Bewaren en volgende' : 'Bewaren'),
      h('button', { class: 'btn big', onclick: () => { stopPlayback(); countdown(); } }, '↺ Opnieuw opnemen'),
      h('button', { class: 'btn', onclick: () => { stopPlayback(); ready(); } }, 'Weggooien')));
    drawWave(canvas, samples);
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  ready();
}

function rpmRange(series) {
  const good = series.filter((s) => s.confidence >= MIN_CONFIDENCE);
  if (!good.length) return '–';
  const first = good.slice(0, 3).map((s) => s.rpm).sort((a, b) => a - b)[Math.min(1, good.length - 1)];
  const max = Math.max(...good.map((s) => s.rpm));
  const last = good.slice(-3).map((s) => s.rpm).sort((a, b) => a - b)[Math.min(1, good.length - 1)];
  return `${fmtRpm(first)} → max ${fmtRpm(max)} → ${fmtRpm(last)} tpm`;
}

function drawWave(canvas, samples) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const hgt = canvas.clientHeight || 120;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  g.fillStyle = style.getPropertyValue('--wave').trim() || '#2563eb';
  const per = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    const start = x * per;
    for (let i = start; i < Math.min(samples.length, start + per); i++) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
    const y0 = (1 - hi) * hgt / 2, y1 = (1 - lo) * hgt / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.fillStyle = '#dc2626';
  g.fillRect(0, 0, w, 1);
  g.fillRect(0, hgt - 1, w, 1);
}

// --- Start -------------------------------------------------------------------------------------

if ('serviceWorker' in navigator && !SYNTH && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker:', e));
}
render();
