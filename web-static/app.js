let WORD_TO_VIDEO = {};
let currentMode = 'all';
let queue = [];
let isPlaying = false;
let recognition = null;
let recognitionActive = false;
let recognitionStarting = false;
let recognitionHadFinal = false;
let recognitionHadError = false;
let lastInterimTranscript = '';
let lastSubmittedTranscript = '';
let lastResults = [];
const SIGN_SENTENCE_DELAY_MS = 2250;
let signSentenceBuffer = [];
let signSentenceTimer = null;
let speechQueue = [];
let activeSpeech = null;
let speechWatchdogTimer = null;
let thaiSpeechVoice = null;
let latestGestureSentence = '';

const el = (id) => document.getElementById(id);
const normalize = (value) => (value || '').toLocaleLowerCase('th').replace(/[\sๆฯ,.!?…]/g, '');

document.body.classList.add('welcome-open');
let pendingSystemId = null;
const systemGuides = {
  'video-system': {
    title: 'วิธีใช้ระบบวิดีโอภาษามือ',
    message: 'พิมพ์คำหรือแตะปุ่มไมโครโฟนเพื่อพูดคำที่ต้องการ จากนั้นกด “ค้นหา” แล้วแตะปุ่มเล่นเพื่อดูคลิป หรือแตะปุ่มขยายเพื่อดูเต็มจอ หากใช้ไมโครโฟน ให้กดอนุญาตเมื่อเบราว์เซอร์ถาม',
  },
  'gesture-system': {
    title: 'วิธีใช้ระบบจับท่าทางภาษามือ',
    message: 'แตะ “กดทุกครั้งก่อนเริ่มใช้” เพื่อทดสอบเสียง แล้วอนุญาตให้เว็บไซต์ใช้กล้อง จัดภาพให้เห็นใบหน้า มือ และลำตัวช่วงอกชัดเจน แนะนำให้ใช้มือขวาทำทีละท่า (ยกเว้นท่า “รัก” ที่ใช้สองมือ) จากนั้นกด “เปิดกล้อง” และทำท่าที่รองรับ ระบบจะรอประมาณ 2.25 วินาทีเพื่อให้ต่อท่าเป็นประโยคได้',
  },
};
function showSystemGuide(systemId, isInitial = false) {
  const guide = systemGuides[systemId];
  if (!guide) return;
  pendingSystemId = systemId;
  el('system-guide-title').textContent = guide.title;
  el('system-guide-message').textContent = guide.message;
  el('system-guide-back').hidden = isInitial;
  el('main-content').inert = true;
  el('system-guide').hidden = false;
  document.body.classList.add('welcome-open');
  el('system-guide-enter').focus();
}
function activateSystem(systemId) {
  document.querySelectorAll('[data-system-target]').forEach((item) => {
    const selected = item.dataset.systemTarget === systemId;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.system-panel').forEach((panel) => { panel.hidden = panel.id !== systemId; });
  if (systemId !== 'video-system') recognition?.stop();
  if (systemId !== 'gesture-system') {
    pauseGestureReferenceVideos();
    const expandedFrame = document.querySelector('.gesture-clip-frame.expanded');
    if (expandedFrame) {
      expandedFrame.classList.remove('expanded');
      document.body.classList.remove('gesture-clip-expanded');
      const expandButton = expandedFrame.querySelector('.gesture-clip-expand');
      expandButton.textContent = '⛶';
      expandButton.setAttribute('aria-label', `ขยายคลิป${expandedFrame.closest('.gesture-clip-card').querySelector('h3').textContent}`);
    }
  }
  window.dispatchEvent(new CustomEvent('system-view-changed', { detail: { systemId } }));
}
function showWelcomeStep(stepNumber) {
  const firstStep = stepNumber === 1;
  el('welcome-step-1').hidden = !firstStep;
  el('welcome-step-2').hidden = firstStep;
  el('welcome-gate').setAttribute('aria-labelledby', firstStep ? 'welcome-title' : 'welcome-device-title');
  el('welcome-gate').setAttribute('aria-describedby', firstStep ? 'welcome-message' : 'welcome-device-message');
  if (firstStep) el('welcome-next').focus();
  else (document.querySelector('[data-recommended-device][aria-pressed="true"]') || document.querySelector('[data-recommended-device]'))?.focus();
}
el('welcome-next').addEventListener('click', () => showWelcomeStep(2));
el('welcome-back').addEventListener('click', () => showWelcomeStep(1));
document.querySelectorAll('[data-recommended-device]').forEach((deviceButton) => {
  deviceButton.addEventListener('click', () => {
    document.querySelectorAll('[data-recommended-device]').forEach((button) => {
      const selected = button === deviceButton;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('selected', selected);
    });
    el('welcome-device-selection').textContent = `เลือก${deviceButton.textContent.trim()}แล้ว กด “เข้าใช้งานเว็บไซต์” เพื่อไปต่อ`;
    el('welcome-enter').disabled = false;
    el('welcome-enter').focus();
  });
});
el('welcome-enter').addEventListener('click', () => {
  if (!document.querySelector('[data-recommended-device][aria-pressed="true"]')) return;
  el('welcome-gate').hidden = true;
  showSystemGuide('video-system', true);
});
el('welcome-next').focus();
el('system-guide-back').addEventListener('click', () => {
  el('system-guide').hidden = true;
  document.body.classList.remove('welcome-open');
  el('main-content').inert = false;
  document.querySelector('[data-system-target].active')?.focus();
  pendingSystemId = null;
});
el('system-guide-enter').addEventListener('click', () => {
  const systemId = pendingSystemId;
  el('system-guide').hidden = true;
  document.body.classList.remove('welcome-open');
  el('main-content').inert = false;
  pendingSystemId = null;
  if (systemId) activateSystem(systemId);
  document.querySelector(`[data-system-target="${systemId}"]`)?.focus();
});

function refreshThaiSpeechVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  thaiSpeechVoice = voices.find((voice) => /^th(?:-|_)/i.test(voice.lang)) || null;
}

if ('speechSynthesis' in window) {
  refreshThaiSpeechVoice();
  window.speechSynthesis.onvoiceschanged = refreshThaiSpeechVoice;
}
const VOCABULARY_CATEGORIES = [
  { name: 'เครื่องดื่มและการสั่งซื้อ', icon: '🥤', files: ['ราคาเท่าไหร่.mp4', 'รับโอนได้ไหม.mp4', 'จ่ายด้วยเงินสด.mp4', 'รับเงินสดได้ไหม.mp4', 'ขอลดราคาได้ไหม.mp4', 'โกโก้.mp4', 'ชาเขียว.mp4', 'ชาเขียวมะนาว.mp4', 'ชาดำ.mp4', 'ชาไทย.mp4', 'ชาน้ำผึ้งมะนาว.mp4', 'ชามะลิ.mp4', 'นมชมพู.mp4', 'นมเปรี้ยวปีโป้.mp4', 'นมสด.mp4', 'น้ำผลไม้.mp4', 'เอ็มร้อยปีโป้.mp4', 'เย็น.mp4', 'ปั่น.mp4', 'ไม่หวาน.mp4', 'หวานน้อย.mp4', 'หวานปกติ.mp4'] },
  { name: 'อารมณ์และความรู้สึก', icon: '🙂', files: ['angry.mp4', 'behappy.mp4', 'dislike.mp4', 'happy.mp4', 'love.mp4', 'sad.mp4', 'smile.mp4', 'กลัว.mp4', 'คิดถึง.mp4', 'ร้องไห้.mp4', 'สงสัย.mp4', 'หัวเราะ.mp4'] },
  { name: 'สุขภาพและความรู้สึกทางกาย', icon: '🩺', files: ['สบายดี.mp4', 'หิว.mp4', 'อิ่ม.mp4'] },
  { name: 'บุคคลและครอบครัว', icon: '👪', files: ['เขา.mp4', 'คนชรา.mp4', 'ฉัน.mp4', 'เด็ก.mp4', 'ตา.mp4', 'น้องชาย.mp4', 'น้องสาว.mp4', 'น้าชาย.mp4', 'น้าหญิง.mp4', 'ป้า.mp4', 'ปู่.mp4', 'ผู้ชาย.mp4', 'ผู้หญิง.mp4', 'ผู้ใหญ่.mp4', 'พวกเขา.mp4', 'พวกเรา.mp4', 'พ่อ.mp4', 'พี่ชาย.mp4', 'พี่สาว.mp4', 'แม่.mp4', 'ย่า.mp4', 'ยาย.mp4', 'ลุง.mp4', 'ลูก.mp4', 'วัยรุ่น.mp4', 'หลาน.mp4', 'อาชาย.mp4'] },
  { name: 'การกระทำและลักษณะ', icon: '💭', files: ['ขยัน.mp4', 'ขี้เกียจ.mp4', 'ง่าย.mp4', 'ยาก.mp4', 'จำ.mp4', 'ลืม.mp4', 'อยาก.mp4'] },
  { name: 'คำทักทายและบทสนทนา', icon: '💬', files: ['ชื่อ.mp4', 'ชื่อสกุล.mp4', 'ไปทานข้าวด้วยกันมั้ย.mp4', 'สวัสดี.mp4'] },
];
const VOCABULARY_CATEGORY_BY_FILE = new Map(VOCABULARY_CATEGORIES.flatMap((category) => category.files.map((file) => [file, category])));
const TSL_PERSON_FILES = new Set([
  'เขา.mp4', 'คนชรา.mp4', 'ฉัน.mp4', 'เด็ก.mp4', 'ตา.mp4', 'น้องชาย.mp4', 'น้องสาว.mp4',
  'น้าชาย.mp4', 'น้าหญิง.mp4', 'ป้า.mp4', 'ปู่.mp4', 'ผู้ชาย.mp4', 'ผู้หญิง.mp4', 'ผู้ใหญ่.mp4',
  'พวกเขา.mp4', 'พวกเรา.mp4', 'พ่อ.mp4', 'พี่ชาย.mp4', 'พี่สาว.mp4', 'แม่.mp4', 'ย่า.mp4',
  'ยาย.mp4', 'ลุง.mp4', 'ลูก.mp4', 'วัยรุ่น.mp4', 'หลาน.mp4', 'อาชาย.mp4',
]);
const TSL_OBJECT_FILES = new Set([
  ...TSL_PERSON_FILES,
  'โกโก้.mp4', 'ชาเขียว.mp4', 'ชาเขียวมะนาว.mp4', 'ชาดำ.mp4', 'ชาไทย.mp4', 'ชาน้ำผึ้งมะนาว.mp4',
  'ชามะลิ.mp4', 'นมชมพู.mp4', 'นมเปรี้ยวปีโป้.mp4', 'นมสด.mp4', 'น้ำผลไม้.mp4', 'เอ็มร้อยปีโป้.mp4',
  'ชื่อ.mp4', 'ชื่อสกุล.mp4',
]);
const TSL_TRANSITIVE_PREDICATES = new Map([
  ['love.mp4', TSL_PERSON_FILES],
  ['dislike.mp4', TSL_PERSON_FILES],
  ['คิดถึง.mp4', TSL_PERSON_FILES],
  ['angry.mp4', TSL_PERSON_FILES],
  ['จำ.mp4', TSL_OBJECT_FILES],
  ['ลืม.mp4', TSL_OBJECT_FILES],
  ['อยาก.mp4', TSL_OBJECT_FILES],
]);

async function loadVocabulary() {
  const response = await fetch('/web-static/vocabulary.json');
  if (!response.ok) throw new Error('load vocabulary failed');
  WORD_TO_VIDEO = await response.json();
  const uniqueClips = new Set(Object.values(WORD_TO_VIDEO));
  el('video-count').textContent = `${uniqueClips.size} คลิป`;
  const aliases = Object.keys(WORD_TO_VIDEO).sort((a, b) => a.localeCompare(b, 'th'));
  el('vocabulary-count').textContent = `${aliases.length} คำ/วลี · ${uniqueClips.size} คลิป`;
  const categories = VOCABULARY_CATEGORIES.map((category) => ({ ...category, aliases: [] }));
  const categoryLookup = new Map(categories.map((category) => [category.name, category]));
  const uncategorized = { name: 'คำอื่น ๆ', icon: '📚', aliases: [] };
  for (const alias of aliases) {
    const category = VOCABULARY_CATEGORY_BY_FILE.get(WORD_TO_VIDEO[alias]);
    (category ? categoryLookup.get(category.name).aliases : uncategorized.aliases).push(alias);
  }
  if (uncategorized.aliases.length) categories.push(uncategorized);
  el('vocabulary-list').replaceChildren(...categories.filter((category) => category.aliases.length).map((category) => {
    const section = document.createElement('section');
    section.className = 'vocabulary-category';
    const heading = document.createElement('h3');
    heading.textContent = `${category.icon} ${category.name}`;
    const count = document.createElement('span');
    count.className = 'category-count';
    count.textContent = `${category.aliases.length} คำ/วลี`;
    heading.append(count);
    const terms = document.createElement('div');
    terms.className = 'vocabulary-category-terms';
    terms.append(...category.aliases.map((alias) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vocabulary-chip';
      chip.textContent = alias;
      chip.dataset.searchText = normalize(alias);
      chip.addEventListener('click', () => submitText(alias));
      return chip;
    }));
    section.append(heading, terms);
    return section;
  }));
}

function findVideos(text) {
  const source = normalize(text);
  const matches = [];
  const aliases = Object.keys(WORD_TO_VIDEO).sort((a, b) => b.length - a.length);
  let cursor = 0;
  while (cursor < source.length) {
    let found = null;
    for (const alias of aliases) {
      const key = normalize(alias);
      const position = source.indexOf(key, cursor);
      if (position === cursor && key) { found = { alias, key, file: WORD_TO_VIDEO[alias] }; break; }
    }
    if (found) {
      if (!matches.length || matches[matches.length - 1].file !== found.file) matches.push(found);
      cursor += found.key.length;
    } else cursor += 1;
  }
  return matches;
}

function arrangeVideosForThaiSignGrammar(matches) {
  const arranged = [];
  let reorderedClauses = 0;
  for (let index = 0; index < matches.length;) {
    const subject = matches[index];
    const predicate = matches[index + 1];
    const object = matches[index + 2];
    const allowedObjects = predicate && TSL_TRANSITIVE_PREDICATES.get(predicate.file);
    if (subject && predicate && object && TSL_PERSON_FILES.has(subject.file) && allowedObjects?.has(object.file)) {
      arranged.push(object, subject, predicate);
      reorderedClauses += 1;
      index += 3;
    } else {
      arranged.push(subject);
      index += 1;
    }
  }
  return { matches: arranged, reorderedClauses };
}

function submitText(text = el('text-input').value, { keepInput = false } = {}) {
  const value = (text || '').trim();
  if (!value) return;
  el('text-input').value = keepInput ? value : '';
  el('status').textContent = `รับข้อความ: ${value}`;
  const { matches, reorderedClauses } = arrangeVideosForThaiSignGrammar(findVideos(value));
  lastResults = matches;
  el('result-list').replaceChildren(...matches.map(({alias}) => {
    const chip = document.createElement('span'); chip.className = 'result-chip'; chip.textContent = alias; return chip;
  }));
  if (!matches.length) {
    el('status').textContent = `ยังไม่มีวิดีโอสำหรับ “${value}” ลองพิมพ์คำสั้น ๆ เช่น สวัสดี, หิว, รัก`;
    return;
  }
  queue.push(...matches);
  el('status').textContent = reorderedClauses
    ? `จัด ${reorderedClauses} ประโยคเป็นลำดับกรรม–ประธาน–กริยาแล้ว · พบ ${matches.length} ท่า กำลังเล่นวิดีโอ`
    : `พบ ${matches.length} ท่า กำลังเล่นวิดีโอ`;
  playNext();
}

function handleSignDetected(word) {
  const isNewWord = signSentenceBuffer[signSentenceBuffer.length - 1] !== word;
  if (!isNewWord) return;
  signSentenceBuffer.push(word);
  if (signSentenceTimer) clearTimeout(signSentenceTimer);
  signSentenceTimer = setTimeout(flushSignSentence, SIGN_SENTENCE_DELAY_MS);
  el('gesture-status').textContent = `เก็บคำจากท่า: ${signSentenceBuffer.join(' ')} (รอท่าถัดไป…)`;
  el('gesture-result-list').replaceChildren(...signSentenceBuffer.map((wordInSentence) => {
    const chip = document.createElement('span'); chip.className = 'result-chip'; chip.textContent = wordInSentence; return chip;
  }));
}

function flushSignSentence() {
  signSentenceTimer = null;
  if (!signSentenceBuffer.length) return;
  const sentence = signSentenceBuffer.join(' ');
  signSentenceBuffer = [];
  latestGestureSentence = sentence;
  el('gesture-speak-button').hidden = false;
  speakGestureSentence(sentence);
}

function playNext() {
  if (isPlaying || !queue.length) return;
  isPlaying = true;
  const item = queue.shift();
  const player = el('sign-video');
  const playerWrap = el('player-wrap');
  const emptyPlayer = playerWrap.querySelector('.empty-player');
  const playOverlay = el('video-play-overlay');
  const expandButton = el('video-expand-button');
  emptyPlayer.hidden = true;
  playOverlay.hidden = true;
  expandButton.hidden = false;
  player.src = `/web-static/videos/${encodeURIComponent(item.file)}`;
  player.hidden = false;
  player.onloadedmetadata = () => {
    if (player.videoWidth && player.videoHeight) {
      playerWrap.style.aspectRatio = `${player.videoWidth} / ${player.videoHeight}`;
    }
    el('now-playing').textContent = `กำลังแสดงท่า: ${item.alias}`;
  };
  player.onplay = () => { isPlaying = true; playOverlay.hidden = true; };
  player.onended = () => { isPlaying = false; if (queue.length) playNext(); };
  player.onerror = () => {
    isPlaying = false;
    player.hidden = true;
    emptyPlayer.hidden = false;
    playOverlay.hidden = true;
    expandButton.hidden = true;
    playerWrap.classList.remove('expanded');
    document.body.classList.remove('video-expanded');
    expandButton.textContent = '⛶';
    expandButton.setAttribute('aria-label', 'ขยายวิดีโอ');
    expandButton.setAttribute('aria-pressed', 'false');
    playerWrap.style.aspectRatio = '4 / 3';
    el('status').textContent = `เปิดวิดีโอ “${item.alias}” ไม่ได้`;
    if (queue.length) playNext();
  };
  player.play().then(() => {
    playOverlay.hidden = true;
  }).catch(() => {
    isPlaying = false;
    playOverlay.hidden = false;
    el('status').textContent = `คลิป “${item.alias}” พร้อมเล่น แตะปุ่มเล่นบนวิดีโอ`;
  });
}

function clearSpeechWatchdog() {
  if (speechWatchdogTimer) clearTimeout(speechWatchdogTimer);
  speechWatchdogTimer = null;
}

function reportGestureSpeechState(sentence, state) {
  const status = el('gesture-status');
  if (state === 'started') status.textContent = `กำลังพูดประโยคจากท่าที่ตรวจพบ: ${sentence}`;
  else if (state === 'finished') status.textContent = `พูดแล้ว: ${sentence} · แตะ “พูดซ้ำ” ได้`;
  else if (state === 'failed') status.textContent = `เสียงไม่เริ่ม: ${sentence} · แตะ “พูดซ้ำ” หรือตรวจระดับเสียงอุปกรณ์`;
  else status.textContent = `กำลังเตรียมเสียงพูด: ${sentence}`;
}

function speakGestureSentence(sentence, { fromUserAction = false } = {}) {
  const callbacks = {
    onStart: () => reportGestureSpeechState(sentence, 'started'),
    onEnd: () => reportGestureSpeechState(sentence, 'finished'),
    onError: () => reportGestureSpeechState(sentence, 'failed'),
  };
  reportGestureSpeechState(sentence, 'pending');
  if (fromUserAction) speakImmediately(sentence, callbacks);
  else speak(sentence, callbacks);
}

function makeSpeechRequest(text, callbacks = {}) {
  return { text, callbacks, retries: 0, started: false, utterance: null };
}

function finishSpeechRequest(request) {
  if (activeSpeech !== request) return;
  clearSpeechWatchdog();
  activeSpeech = null;
  request.callbacks.onEnd?.();
  pumpSpeechQueue();
}

function failSpeechRequest(request, reason, canRetry = true) {
  if (activeSpeech !== request) return;
  clearSpeechWatchdog();
  activeSpeech = null;
  window.speechSynthesis.cancel();
  if (canRetry && request.retries < 1) {
    request.retries += 1;
    speechQueue.unshift(request);
    setTimeout(pumpSpeechQueue, 180);
    return;
  }
  request.callbacks.onError?.(reason);
  setTimeout(pumpSpeechQueue, 0);
}

function startSpeechRequest(request) {
  const synth = window.speechSynthesis;
  activeSpeech = request;
  request.started = false;
  const utterance = new SpeechSynthesisUtterance(request.text);
  request.utterance = utterance;
  utterance.lang = thaiSpeechVoice?.lang || 'th-TH';
  if (thaiSpeechVoice) utterance.voice = thaiSpeechVoice;
  utterance.rate = 0.92;
  utterance.volume = 1;
  utterance.onstart = () => {
    if (activeSpeech !== request) return;
    request.started = true;
    clearSpeechWatchdog();
    request.callbacks.onStart?.();
    speechWatchdogTimer = setTimeout(() => failSpeechRequest(request, 'speech-timeout', false), Math.max(10000, request.text.length * 700));
  };
  utterance.onend = () => {
    if (activeSpeech !== request) return;
    if (!request.started) { failSpeechRequest(request, 'speech-did-not-start'); return; }
    finishSpeechRequest(request);
  };
  utterance.onerror = (event) => {
    if (activeSpeech !== request) return;
    const retryable = !['not-allowed', 'voice-unavailable', 'language-unavailable'].includes(event.error);
    failSpeechRequest(request, event.error || 'speech-error', retryable);
  };
  synth.resume();
  try {
    synth.speak(utterance);
  } catch (error) {
    failSpeechRequest(request, error.name || 'speech-error');
    return;
  }
  speechWatchdogTimer = setTimeout(() => failSpeechRequest(request, 'speech-did-not-start'), 2800);
}

function pumpSpeechQueue() {
  if (activeSpeech || !speechQueue.length || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') return;
  startSpeechRequest(speechQueue.shift());
}

function speak(text, callbacks = {}) {
  if (!text) return;
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') {
    callbacks.onError?.('speech-unavailable');
    return;
  }
  speechQueue.push(makeSpeechRequest(text, callbacks));
  pumpSpeechQueue();
}

function speakImmediately(text, callbacks = {}) {
  if (!text || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') {
    callbacks.onError?.('speech-unavailable');
    return;
  }
  clearSpeechWatchdog();
  speechQueue = [];
  activeSpeech = null;
  window.speechSynthesis.cancel();
  startSpeechRequest(makeSpeechRequest(text, callbacks));
}

function setMicIdle() {
  recognitionActive = false;
  recognitionStarting = false;
  el('mic-button').classList.remove('listening');
  el('mic-button').textContent = '🎙 แตะเพื่อพูด';
}

function speechErrorMessage(error) {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Safari ไม่อนุญาตใช้ไมค์หรือบริการรู้จำเสียง: ตรวจสิทธิ์ไมโครโฟนของเว็บไซต์ และเปิด Siri ในการตั้งค่าอุปกรณ์';
    case 'audio-capture':
      return 'เปิดไมโครโฟนไม่ได้: ตรวจสิทธิ์ไมโครโฟนของ Safari และลองปิดแอปอื่นที่กำลังใช้ไมค์';
    case 'network':
      return 'บริการรู้จำเสียงเชื่อมต่อไม่ได้: ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง';
    case 'no-speech':
      return 'ไม่ได้ยินเสียงพูด: ลองพูดใกล้ไมโครโฟนแล้วแตะอีกครั้ง';
    case 'aborted':
      return 'หยุดฟังแล้ว';
    case 'language-not-supported':
      return 'อุปกรณ์ไม่รองรับการรู้จำเสียงภาษาไทย';
    default:
      return `เริ่มรู้จำเสียงไม่ได้ (${error || 'ไม่ทราบสาเหตุ'})`;
  }
}

function startListening() {
  if (!el('mic-consent').checked) { el('status').textContent = 'กรุณายินยอมใช้ไมโครโฟนก่อน'; return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { el('status').textContent = 'เบราว์เซอร์นี้ไม่รองรับการถอดเสียงบนเว็บนี้ ลองเปิดลิงก์ด้วย Safari แล้วเปิด Siri หรือพิมพ์ข้อความแทน'; return; }
  if (!recognition) {
    recognition = new SpeechRecognition(); recognition.lang = 'th-TH'; recognition.continuous = false; recognition.interimResults = true; recognition.maxAlternatives = 5;
    recognition.onstart = () => {
      recognitionStarting = false;
      recognitionActive = true;
      recognitionHadFinal = false;
      recognitionHadError = false;
      lastInterimTranscript = '';
      lastSubmittedTranscript = '';
      el('mic-button').classList.add('listening');
      el('mic-button').textContent = '🎙 กำลังฟัง… แตะเพื่อหยุด';
      el('status').textContent = 'กำลังฟัง พูดให้จบแล้วรอสักครู่';
      el('mic-transcript').hidden = false;
      el('mic-transcript').textContent = 'กำลังรอเสียงพูด…';
    };
    recognition.onresult = (event) => {
      const finalParts = [];
      const interimParts = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternatives = [];
        for (let alternativeIndex = 0; alternativeIndex < result.length; alternativeIndex += 1) {
          alternatives.push(result[alternativeIndex].transcript || '');
        }
        const transcript = alternatives.sort((a, b) => findVideos(b).length - findVideos(a).length || b.length - a.length)[0] || '';
        if (result.isFinal) finalParts.push(transcript);
        else interimParts.push(transcript);
      }
      const finalTranscript = finalParts.join('').trim();
      const interimTranscript = interimParts.join('').trim();
      if (interimTranscript) {
        lastInterimTranscript = interimTranscript;
        if (!finalTranscript) {
          el('mic-transcript').hidden = false;
          el('mic-transcript').textContent = `กำลังได้ยิน: “${interimTranscript}”`;
        }
      }
      if (finalTranscript && finalTranscript !== lastSubmittedTranscript) {
        recognitionHadFinal = true;
        lastSubmittedTranscript = finalTranscript;
        el('mic-transcript').hidden = false;
        el('mic-transcript').textContent = `ถอดเสียงได้: “${finalTranscript}”`;
        submitText(finalTranscript, { keepInput: true });
      }
    };
    recognition.onerror = (event) => {
      recognitionHadError = true;
      el('status').textContent = speechErrorMessage(event.error);
      setMicIdle();
    };
    recognition.onnomatch = () => {
      recognitionHadError = true;
      el('mic-transcript').hidden = false;
      el('mic-transcript').textContent = 'ได้ยินเสียง แต่ถอดเป็นคำไม่ได้ ลองพูดช้าลงและใกล้ไมค์';
    };
    recognition.onend = () => {
      const incompleteTranscript = !recognitionHadFinal && !recognitionHadError;
      const partial = lastInterimTranscript.trim();
      setMicIdle();
      if (incompleteTranscript) {
        if (partial) {
          el('mic-transcript').textContent = `ใช้คำที่ได้ยิน: “${partial}”`;
          submitText(partial, { keepInput: true });
        } else {
          el('status').textContent = 'ไมค์หยุดฟังแต่ไม่ได้ข้อความเสียง ตรวจว่าเปิดด้วย Safari และเปิด Siri แล้วลองพูดอีกครั้ง';
        }
      }
    };
  }
  recognitionStarting = true;
  recognitionHadFinal = false;
  recognitionHadError = false;
  lastInterimTranscript = '';
  lastSubmittedTranscript = '';
  el('mic-transcript').hidden = false;
  el('mic-transcript').textContent = 'กำลังเริ่มไมโครโฟน…';
  el('mic-button').textContent = '🎙 กำลังเริ่มไมค์…';
  el('status').textContent = 'กำลังเชื่อมต่อไมโครโฟน';
  try {
    recognition.start();
  } catch (error) {
    setMicIdle();
    el('status').textContent = speechErrorMessage(error.name || error.message);
  }
}

el('send-button').addEventListener('click', () => submitText());
el('text-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitText(); });
el('video-play-overlay').addEventListener('click', () => {
  const player = el('sign-video');
  player.play().then(() => {
    isPlaying = true;
    el('video-play-overlay').hidden = true;
  }).catch(() => {
    isPlaying = false;
    el('status').textContent = 'เล่นคลิปไม่ได้ ลองแตะปุ่มเล่นของวิดีโออีกครั้ง';
  });
});
el('video-expand-button').addEventListener('click', () => {
  const playerWrap = el('player-wrap');
  const button = el('video-expand-button');
  const expanded = playerWrap.classList.toggle('expanded');
  document.body.classList.toggle('video-expanded', expanded);
  button.textContent = expanded ? '×' : '⛶';
  button.setAttribute('aria-label', expanded ? 'ย่อวิดีโอ' : 'ขยายวิดีโอ');
  button.setAttribute('aria-pressed', String(expanded));
});
el('vocabulary-filter').addEventListener('input', (event) => {
  const query = normalize(event.target.value);
  const chips = Array.from(el('vocabulary-list').querySelectorAll('.vocabulary-chip'));
  let visible = 0;
  chips.forEach((chip) => {
    const match = !query || chip.dataset.searchText.includes(query);
    chip.hidden = !match;
    if (match) visible += 1;
  });
  el('vocabulary-list').querySelectorAll('.vocabulary-category').forEach((category) => {
    category.hidden = !category.querySelector('.vocabulary-chip:not([hidden])');
  });
  const clipCount = new Set(chips.filter((chip) => !chip.hidden).map((chip) => WORD_TO_VIDEO[chip.textContent])).size;
  el('vocabulary-count').textContent = query ? `${visible} คำ/วลี · ${clipCount} คลิป` : `${chips.length} คำ/วลี · ${new Set(Object.values(WORD_TO_VIDEO)).size} คลิป`;
});
el('mic-button').addEventListener('click', () => {
  if (recognitionActive) {
    try { recognition.stop(); } catch (error) { el('status').textContent = speechErrorMessage(error.name || error.message); setMicIdle(); }
  } else if (!recognitionStarting) startListening();
});
el('speak-button').addEventListener('click', () => speak('ระบบเสียงภาษาไทยพร้อมใช้งาน'));
el('gesture-speaker-test').addEventListener('click', () => {
  const button = el('gesture-speaker-test');
  button.disabled = true;
  button.textContent = '🔊 กำลังทดสอบลำโพง…';
  speakImmediately('ระบบจับท่าทางพร้อมแล้ว', {
    onStart: () => { el('gesture-status').textContent = 'กำลังทดสอบลำโพง…'; },
    onEnd: () => {
      button.disabled = false;
      button.textContent = '🔊 กดทุกครั้งก่อนเริ่มใช้';
      el('gesture-status').textContent = 'ทดสอบลำโพงแล้ว: ระบบจับท่าทางพร้อมแล้ว';
    },
    onError: () => {
      button.disabled = false;
      button.textContent = '🔊 กดทุกครั้งก่อนเริ่มใช้';
      el('gesture-status').textContent = 'เสียงไม่ทำงาน ตรวจสอบระดับเสียงและการตั้งค่าเสียงพูดของอุปกรณ์';
    },
  });
});
el('gesture-speak-button').addEventListener('click', () => {
  if (latestGestureSentence) speakGestureSentence(latestGestureSentence, { fromUserAction: true });
});
function pauseGestureReferenceVideos(except = null) {
  document.querySelectorAll('.gesture-reference-video').forEach((video) => {
    if (video === except) return;
    video.pause();
  });
}
document.querySelectorAll('.gesture-clip-play').forEach((button) => {
  button.addEventListener('click', async () => {
    const frame = button.closest('.gesture-clip-frame');
    const video = frame.querySelector('.gesture-reference-video');
    if (!video.paused) { video.pause(); return; }
    pauseGestureReferenceVideos(video);
    try { await video.play(); }
    catch { button.textContent = '▶'; }
  });
});
document.querySelectorAll('.gesture-reference-video').forEach((video) => {
  const button = video.closest('.gesture-clip-frame').querySelector('.gesture-clip-play');
  const signName = video.closest('.gesture-clip-card').querySelector('h3').textContent;
  video.addEventListener('play', () => {
    video.closest('.gesture-clip-frame').classList.add('playing');
    button.textContent = 'Ⅱ';
    button.setAttribute('aria-label', `หยุดคลิปท่า${signName}`);
  });
  video.addEventListener('pause', () => {
    video.closest('.gesture-clip-frame').classList.remove('playing');
    button.textContent = '▶';
    button.setAttribute('aria-label', `เล่นคลิปท่า${signName}`);
  });
});
document.querySelectorAll('.gesture-clip-expand').forEach((button) => {
  button.addEventListener('click', () => {
    const frame = button.closest('.gesture-clip-frame');
    const expanded = frame.classList.toggle('expanded');
    document.body.classList.toggle('gesture-clip-expanded', expanded);
    button.textContent = expanded ? '×' : '⛶';
    button.setAttribute('aria-label', expanded ? 'ย่อคลิป' : 'ขยายคลิป');
  });
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const expandedFrame = document.querySelector('.gesture-clip-frame.expanded');
  if (!expandedFrame) return;
  expandedFrame.classList.remove('expanded');
  document.body.classList.remove('gesture-clip-expanded');
  const button = expandedFrame.querySelector('.gesture-clip-expand');
  button.textContent = '⛶';
  button.setAttribute('aria-label', `ขยายคลิป${expandedFrame.closest('.gesture-clip-card').querySelector('h3').textContent}`);
});
window.addEventListener('sign-detected', (event) => handleSignDetected(event.detail.word));
document.querySelectorAll('[data-system-target]').forEach((tab) => {
  tab.addEventListener('click', () => showSystemGuide(tab.dataset.systemTarget));
});
loadVocabulary().catch(() => { el('video-count').textContent = 'โหลดรายการคลิปไม่สำเร็จ'; el('status').textContent = 'โหลดข้อมูลวิดีโอไม่สำเร็จ กรุณารีเฟรชหน้า'; });
