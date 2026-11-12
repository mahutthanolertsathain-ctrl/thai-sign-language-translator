let WORD_TO_VIDEO = {};
let videoAliases = new Map();
let maxVideoAliasLength = 0;
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
let pendingVideoResults = null;
let videoPlaybackId = 0;
let vocabularyReady = false;
const SIGN_SENTENCE_DELAY_MS = 2250;
let signSentenceBuffer = [];
let signSentenceTimer = null;
let speechQueue = [];
let activeSpeech = null;
let speechWatchdogTimer = null;
let thaiSpeechVoice = null;
let latestGestureSentence = '';
let practiceMode = false;
let pendingPractice = false;
let practiceComplete = false;
let practiceCameraReady = false;
const practicedWords = new Set();
const PRACTICE_TEST_LIMIT = 10;
const PRACTICE_TEST_DURATION_MS = 8000;
const PRACTICE_TEST_STORAGE = 'muepood-practice-tests-v1';
let practiceTestMode = false;
let practiceTestPhase = 'idle';
let practiceTestTimer = null;
let practiceTestStartedAt = 0;
let practiceTestDeadline = 0;
let practiceTestRuns = {};
let practiceTestStorageAvailable = true;

const el = (id) => document.getElementById(id);
const normalize = (value) => (value || '').toLocaleLowerCase('th').replace(/[\sๆฯ,.!?…]/g, '');
const thaiWords = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const stackedVideoLayout = window.matchMedia('(max-width: 820px)');

const welcomeDevices = [...document.querySelectorAll('[data-recommended-device]')];
const welcomeStorageKey = 'muepood-welcome-v1';
let welcomePreferences = {};
try { welcomePreferences = JSON.parse(localStorage.getItem(welcomeStorageKey)) || {}; } catch (_) {}
let selectedDevice = welcomeDevices.find((button) => button.dataset.recommendedDevice === welcomePreferences.device);
const seenGuides = new Set(selectedDevice && Array.isArray(welcomePreferences.guides) ? welcomePreferences.guides : []);

function saveWelcomePreferences() {
  try { localStorage.setItem(welcomeStorageKey, JSON.stringify({ device: selectedDevice.dataset.recommendedDevice, guides: [...seenGuides] })); } catch (_) {}
}

let pendingSystemId = null;
let guideReturnFocus = null;
const systemGuides = {
  'video-system': {
    title: 'วิธีใช้ระบบวิดีโอภาษามือ',
    message: 'พิมพ์แล้วกด “ค้นหา” หรือแตะไมโครโฟนเพื่อพูดคำที่ต้องการ หากมีคำที่ยังไม่มีคลิป ให้เลือกดูเฉพาะท่าที่มีหรือแก้ข้อความ แตะปุ่มขยายเพื่อดูคลิปเต็มจอ หากใช้ไมโครโฟน ให้กดอนุญาตเมื่อเบราว์เซอร์ถาม',
  },
  'gesture-system': {
    title: 'วิธีใช้ระบบจับท่าทางภาษามือ',
    message: 'กด “เปิดกล้อง” อ่านคำแนะนำแล้วแตะ “พร้อมแล้ว เปิดกล้อง” ระบบจะเตรียมเสียงให้อัตโนมัติ จากนั้นอนุญาตให้เว็บไซต์ใช้กล้อง จัดภาพให้เห็นใบหน้า มือ และลำตัวช่วงอกชัดเจน แนะนำให้ใช้มือขวาทำทีละท่า (ท่า “รัก” “สวัสดี” “สบายดี” “ยิ้ม” “กลัว” และ “ง่าย” ใช้สองมือ) ระบบจะรอประมาณ 2.25 วินาทีหลังท่าล่าสุดเพื่อให้ต่อคำเป็นประโยคก่อนพูด',
  },
  practice: {
    title: 'วิธีใช้โหมดฝึกทีละคำ',
    message: 'เลือกคำที่ต้องการฝึก แล้วกดดูคลิปตัวอย่าง จากนั้นกด “เปิดกล้อง” ลดมือให้พ้นภาพสักครู่ก่อนเริ่มทำท่า เมื่อระบบตรวจพบคำที่เลือกจะแสดงว่าฝึกสำเร็จ กดฝึกซ้ำหรือไปคำถัดไปได้ โดยโหมดนี้จะไม่ต่อคำเป็นประโยค',
  },
};
function openGuide(guide, systemId = null) {
  pendingSystemId = systemId;
  guideReturnFocus = document.activeElement;
  el('system-guide-title').textContent = guide.title;
  el('system-guide-message').textContent = guide.message;
  el('system-guide-back').hidden = !systemId;
  el('system-guide-enter').textContent = systemId ? 'เข้าใช้งานระบบนี้' : 'ปิดวิธีใช้';
  el('main-content').inert = true;
  el('system-guide').hidden = false;
  document.body.classList.add('welcome-open');
  el('system-guide-enter').focus();
}
function showSystemGuide(systemId) {
  const guideKey = pendingPractice ? 'practice' : systemId;
  if (seenGuides.has(guideKey)) enterSystem(systemId);
  else openGuide(systemGuides[guideKey], systemId);
}
function closeGuide() {
  el('system-guide').hidden = true;
  document.body.classList.remove('welcome-open');
  el('main-content').inert = false;
  pendingSystemId = null;
}
function enterSystem(systemId) {
  activateSystem(systemId);
  if (pendingPractice) setPracticeMode(true);
  pendingPractice = false;
  if (practiceMode && systemId === 'gesture-system') {
    el('practice-word').focus({ preventScroll: true });
    document.querySelector('.gesture-mode-switch').scrollIntoView({ block: 'start', behavior: 'auto' });
  } else document.querySelector(`[data-system-target="${systemId}"]`)?.focus();
}
function activateSystem(systemId) {
  if (systemId !== 'gesture-system' && practiceMode) setPracticeMode(false);
  document.body.classList.remove('home-view');
  document.querySelectorAll('[data-system-target]').forEach((item) => {
    const selected = item.dataset.systemTarget === systemId;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.system-panel').forEach((panel) => { panel.hidden = panel.id !== systemId; });
  if (systemId !== 'video-system') { recognition?.stop(); el('sign-video').pause(); queue = []; isPlaying = false; }
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
welcomeDevices.forEach((deviceButton) => {
  deviceButton.addEventListener('click', () => {
    selectedDevice = deviceButton;
    welcomeDevices.forEach((button) => {
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
  if (!selectedDevice) return;
  saveWelcomePreferences();
  el('welcome-gate').hidden = true;
  document.body.classList.remove('welcome-open');
  el('main-content').inert = false;
  el('home-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
});
if (selectedDevice) {
  el('welcome-gate').hidden = true;
  el('main-content').inert = false;
} else {
  document.body.classList.add('welcome-open');
}
const siteIntro = el('site-intro');
if (siteIntro.open) {
  siteIntro.addEventListener('close', () => el(selectedDevice ? 'home-title' : 'welcome-next').focus({ preventScroll: true }), { once: true });
} else if (!selectedDevice) el('welcome-next').focus();
function dismissGuide() {
  closeGuide();
  pendingPractice = false;
  guideReturnFocus?.focus({ preventScroll: true });
}
el('system-guide-back').addEventListener('click', dismissGuide);
el('system-guide-enter').addEventListener('click', () => {
  const systemId = pendingSystemId;
  if (!systemId) { dismissGuide(); return; }
  seenGuides.add(pendingPractice ? 'practice' : systemId);
  saveWelcomePreferences();
  closeGuide();
  enterSystem(systemId);
});
el('show-help').addEventListener('click', () => {
  const activeSystem = document.querySelector('[data-system-target].active')?.dataset.systemTarget;
  const key = practiceMode ? 'practice' : activeSystem;
  openGuide(systemGuides[key] || {
    title: 'วิธีใช้เว็บไซต์มือพูด',
    message: 'เริ่มที่ “ฝึกทีละคำ” เพื่อดูคลิปแล้วลองทำตาม เลือก “พูดหรือพิมพ์ → ดูภาษามือ” เพื่อค้นหาคลิป หรือเลือก “ทำท่า → ฟังเสียงพูด” เพื่อใช้กล้องแปลท่าที่รองรับ เว็บไซต์ยังเป็นต้นแบบและตรวจจับได้บางคำ',
  });
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
  videoAliases = new Map(Object.entries(WORD_TO_VIDEO).map(([alias, file]) => [normalize(alias), { alias, file }]));
  maxVideoAliasLength = Math.max(0, ...Array.from(videoAliases.keys(), (alias) => alias.length));
  vocabularyReady = true;
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
  const words = thaiWords
    ? Array.from(thaiWords.segment(text)).filter(({ isWordLike }) => isWordLike).map(({ segment }) => segment)
    : text.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  const tokens = words.map((word) => ({ word, key: normalize(word) })).filter(({ key }) => key);
  const matches = [];
  const missing = [];
  for (let start = 0; start < tokens.length;) {
    let key = '';
    let matchedEnd = start;
    let match;
    for (let end = start; end < tokens.length; end += 1) {
      key += tokens[end].key;
      if (key.length > maxVideoAliasLength) break;
      const candidate = videoAliases.get(key);
      if (candidate) { match = candidate; matchedEnd = end + 1; }
    }
    if (!match) {
      missing.push(tokens[start].word);
      start += 1;
      continue;
    }
    if (matches.at(-1)?.file !== match.file) matches.push(match);
    start = matchedEnd;
  }
  return { matches, missing: [...new Set(missing)] };
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

function hideVideoCoverage() {
  pendingVideoResults = null;
  el('video-coverage').hidden = true;
}

function clearVideoResults() {
  videoPlaybackId += 1;
  queue = [];
  isPlaying = false;
  const player = el('sign-video');
  player.onloadedmetadata = player.onplay = player.onended = player.onerror = null;
  player.pause();
  if (player.hasAttribute('src')) { player.removeAttribute('src'); player.load(); }
  player.hidden = true;
  const wrap = el('player-wrap');
  wrap.querySelector('.empty-player').hidden = false;
  wrap.style.aspectRatio = '';
  const expandButton = el('video-expand-button');
  if (wrap.classList.contains('expanded')) expandButton.click();
  expandButton.hidden = true;
  el('video-play-overlay').hidden = true;
  el('now-playing').textContent = 'ยังไม่ได้เลือกคำ';
  el('result-list').replaceChildren();
  el('video-results-coverage').hidden = true;
}

function submitText(text = el('text-input').value) {
  const value = (text || '').trim();
  if (!value) return;
  el('text-input').value = value;
  hideVideoCoverage();
  clearVideoResults();
  if (!vocabularyReady) {
    el('status').textContent = 'รายการคลิปยังไม่พร้อม ลองค้นหาอีกครั้งหรือรีเฟรชหน้า';
    return;
  }
  const { matches, missing } = findVideos(value);
  if (!matches.length || missing.length) {
    const missingText = (missing.length ? missing : [value]).map((word) => `“${word}”`).join(' ');
    const message = `ยังไม่มีคลิปสำหรับ ${missingText}`;
    pendingVideoResults = matches.length ? { matches, message } : null;
    el('video-play-partial').hidden = !pendingVideoResults;
    el('status').textContent = matches.length ? `พบ ${matches.length} ท่า · มีคำที่ยังไม่มีคลิป` : 'ไม่พบคลิปสำหรับข้อความนี้';
    const warning = el('video-coverage');
    warning.hidden = false;
    el('video-coverage-message').textContent = message;
    if (stackedVideoLayout.matches) {
      warning.focus({ preventScroll: true });
      warning.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
    return;
  }
  const arranged = arrangeVideosForThaiSignGrammar(matches);
  playVideoResults(arranged.matches, arranged.reorderedClauses);
}

function playVideoResults(matches, reorderedClauses = 0, partialMessage = '') {
  el('result-list').replaceChildren(...matches.map(({alias}) => {
    const chip = document.createElement('span'); chip.className = 'result-chip'; chip.textContent = alias; return chip;
  }));
  const coverage = el('video-results-coverage');
  coverage.hidden = !partialMessage;
  coverage.textContent = partialMessage ? `กำลังแสดงเฉพาะท่าที่มี · ${partialMessage}` : '';
  queue = [...matches];
  el('status').textContent = partialMessage ? `กำลังเล่นเฉพาะ ${matches.length} ท่าที่มีคลิป` : reorderedClauses
    ? `พบคลิปครบ · เรียงท่าตามรูปแบบประโยคที่ระบบรองรับ · ${matches.length} ท่า`
    : `พบคลิปครบ · ${matches.length} ท่า`;
  playNext();
  if (stackedVideoLayout.matches) {
    el('video-results-title').focus({ preventScroll: true });
    el('video-results-title').closest('.player-card').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function handleSignDetected(word) {
  if (practiceMode) {
    if (practiceTestMode) {
      if (practiceTestPhase === 'running') {
        finishPracticeTest(performance.now() >= practiceTestDeadline ? null : word);
      }
      return;
    }
    if (!practiceComplete && word === el('practice-word').value) completePractice();
    return;
  }
  const isNewWord = signSentenceBuffer[signSentenceBuffer.length - 1] !== word;
  if (!isNewWord) return;
  signSentenceBuffer.push(word);
  el('gesture-live-caption').hidden = false;
  el('gesture-live-caption').textContent = `ตรวจพบ: ${word}`;
  startSentenceCountdown();
  if (signSentenceTimer) clearTimeout(signSentenceTimer);
  signSentenceTimer = setTimeout(flushSignSentence, SIGN_SENTENCE_DELAY_MS);
  el('gesture-status').textContent = `เก็บคำจากท่า: ${signSentenceBuffer.join(' ')} (รอท่าถัดไป…)`;
  el('gesture-result-list').replaceChildren(...signSentenceBuffer.map((wordInSentence) => {
    const chip = document.createElement('span'); chip.className = 'result-chip'; chip.textContent = wordInSentence; return chip;
  }));
}

function flushSignSentence() {
  stopSentenceCountdown();
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
  const playbackId = ++videoPlaybackId;
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
  player.src = `/web-static/videos/${encodeURIComponent(item.file)}`;
  player.play().then(() => {
    if (playbackId !== videoPlaybackId) return;
    playOverlay.hidden = true;
  }).catch(() => {
    if (playbackId !== videoPlaybackId) return;
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
  document.querySelector('.gesture-output-card').dataset.speechState = state;
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
  keepGestureCameraPlaying();
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
    keepGestureCameraPlaying();
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
  speechWatchdogTimer = setTimeout(() => failSpeechRequest(request, 'speech-did-not-start'), 2800);
  try {
    synth.speak(utterance);
  } catch (error) {
    failSpeechRequest(request, error.name || 'speech-error');
    return;
  }
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

function keepGestureCameraPlaying() {
  const video = el('camera-video');
  if (video.srcObject && video.paused) video.play().catch(() => {});
}
function prepareGestureAudioFromTap() {
  if (practiceMode) return;
  refreshThaiSpeechVoice();
  // Keep speak() in the trusted click stack, before camera permission/model awaits.
  // WebKit clears its initial speech user-gesture restriction here.
  speakImmediately('ระบบเสียงพร้อมแล้ว', {
    onStart: () => { el('gesture-status').textContent = 'เปิดเสียงแล้ว · เมื่อกล้องพร้อม ทำท่าที่รองรับได้เลย'; },
    onError: () => { el('gesture-status').textContent = 'เริ่มเสียงไม่ได้ · ลองแตะ “พูดซ้ำ” หลังตรวจพบท่า หรือตรวจระดับเสียงอุปกรณ์'; },
  });
}
el('camera-setup-confirm').addEventListener('click', prepareGestureAudioFromTap, { capture: true });

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
    recognition = new SpeechRecognition(); recognition.lang = 'th-TH'; recognition.continuous = false; recognition.interimResults = true;
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
        let transcript = '';
        for (let alternativeIndex = 0; alternativeIndex < result.length; alternativeIndex += 1) {
          transcript = result[alternativeIndex].transcript?.trim() || '';
          if (transcript) break;
        }
        if (result.isFinal) finalParts.push(transcript);
        else interimParts.push(transcript);
      }
      const finalTranscript = finalParts.join(' ').trim();
      const interimTranscript = interimParts.join(' ').trim();
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
        submitText(finalTranscript);
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
          submitText(partial);
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
el('text-input').addEventListener('input', () => {
  if (el('video-coverage').hidden) return;
  hideVideoCoverage();
  el('status').textContent = 'กด “ค้นหา” เพื่อดูผลของข้อความใหม่';
});
el('video-edit-search').addEventListener('click', () => el('text-input').focus());
el('video-play-partial').addEventListener('click', () => {
  if (!pendingVideoResults) return;
  const { matches, message } = pendingVideoResults;
  hideVideoCoverage();
  playVideoResults(matches, 0, message);
});
el('video-play-overlay').addEventListener('click', () => {
  const player = el('sign-video');
  const playbackId = videoPlaybackId;
  player.play().then(() => {
    if (playbackId !== videoPlaybackId) return;
    isPlaying = true;
    el('video-play-overlay').hidden = true;
  }).catch(() => {
    if (playbackId !== videoPlaybackId) return;
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
      button.textContent = '🔊 ทดสอบเสียง';
      el('gesture-status').textContent = 'ทดสอบลำโพงแล้ว: ระบบจับท่าทางพร้อมแล้ว';
    },
    onError: () => {
      button.disabled = false;
      button.textContent = '🔊 ทดสอบเสียง';
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
  if (!el('system-guide').hidden) { dismissGuide(); return; }
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
  tab.addEventListener('click', () => { pendingPractice = false; showSystemGuide(tab.dataset.systemTarget); });
});
loadVocabulary().catch(() => { el('video-count').textContent = 'โหลดรายการคลิปไม่สำเร็จ'; el('status').textContent = 'โหลดข้อมูลวิดีโอไม่สำเร็จ กรุณารีเฟรชหน้า'; });

// Presentation controls keep all camera and speech processing in the existing systems.
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let motionPreference = null;
try { motionPreference = localStorage.getItem('muepood-reduced-motion'); } catch (_) {}
function setReducedMotion(reduced) {
  document.body.classList.toggle('reduce-motion', reduced);
  document.body.classList.toggle('allow-motion', !reduced);
  el('motion-toggle').setAttribute('aria-pressed', String(reduced));
  el('motion-toggle').textContent = reduced ? 'เปิดการเคลื่อนไหว' : 'ลดการเคลื่อนไหว';
}
setReducedMotion(motionPreference === null ? motionQuery.matches : motionPreference === 'true');
el('motion-toggle').addEventListener('click', () => {
  const reduced = !document.body.classList.contains('reduce-motion');
  motionPreference = String(reduced);
  setReducedMotion(reduced);
  try { localStorage.setItem('muepood-reduced-motion', String(reduced)); } catch (_) {}
});
motionQuery.addEventListener('change', (event) => {
  if (motionPreference === null) setReducedMotion(event.matches);
});
function goHome(event) {
  if (practiceMode) setPracticeMode(false);
  event?.preventDefault();
  document.body.classList.add('home-view');
  el('sign-video').pause();
  queue = []; isPlaying = false;
  pauseGestureReferenceVideos();
  try { recognition?.stop(); } catch (_) {}
  document.querySelectorAll('[data-system-target]').forEach((button) => {
    button.classList.remove('active'); button.setAttribute('aria-selected', 'false');
  });
  window.dispatchEvent(new CustomEvent('system-view-changed', { detail: { systemId: 'home' } }));
  el('home-title').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo({ top: 0, behavior: 'auto' });
}
el('home-button').addEventListener('click', goHome);
el('brand-home').addEventListener('click', goHome);
document.querySelectorAll('[data-quick-word]').forEach((button) => {
  button.addEventListener('click', () => {
    el('text-input').value = button.dataset.quickWord;
    submitText();
  });
});
let sentenceCountdown = null;
function stopSentenceCountdown() {
  clearInterval(sentenceCountdown);
  sentenceCountdown = null;
  el('sentence-progress').hidden = true;
}
function startSentenceCountdown() {
  clearInterval(sentenceCountdown);
  document.querySelector('.gesture-output-card').dataset.speechState = 'collecting';
  const deadline = performance.now() + SIGN_SENTENCE_DELAY_MS;
  el('sentence-progress').hidden = false;
  const update = () => {
    const remaining = Math.max(0, deadline - performance.now());
    el('sentence-progress-fill').style.width = `${remaining / SIGN_SENTENCE_DELAY_MS * 100}%`;
    el('sentence-progress-label').textContent = `รอท่าถัดไปอีก ${(remaining / 1000).toFixed(1)} วินาที แล้วพูดประโยค`;
    if (!remaining) stopSentenceCountdown();
  };
  update();
  sentenceCountdown = setInterval(update, 100);
}

const practiceLessons = [...document.querySelectorAll('.gesture-clip-grid .gesture-clip-card')].map((card) => {
  const label = card.querySelector('h3').textContent.trim();
  return { word: label.includes('ไม่สบาย') ? 'ไม่สบาย' : label, label, src: card.querySelector('video').getAttribute('src') };
});
practiceLessons.forEach((lesson) => {
  const option = document.createElement('option'); option.value = lesson.word; option.textContent = lesson.label;
  el('practice-word').append(option);
});
function practiceResult(title, message, state = 'waiting') {
  el('practice-result-title').textContent = title;
  el('practice-result-message').textContent = message;
  el('practice-result').dataset.state = state;
}
function resetPracticeAttempt() {
  practiceComplete = false;
  el('practice-retry').hidden = true;
  window.dispatchEvent(new CustomEvent('practice-settings-changed', { detail: {
    active: practiceMode, word: el('practice-word').value,
    testing: practiceTestMode, accepting: !practiceTestMode || practiceTestPhase === 'neutral' || practiceTestPhase === 'running'
  } }));
  practiceResult(practiceCameraReady ? 'เตรียมเริ่มท่าใหม่' : 'เปิดกล้องเพื่อเริ่มฝึก', practiceCameraReady
    ? 'ลดมือให้พ้นภาพสักครู่ แล้วทำท่าตามคลิปตัวอย่าง' : 'ดูคลิปตัวอย่างก่อน จากนั้นกด “เปิดกล้อง”');
}
function updatePracticeLesson() {
  cancelPracticeTest();
  const lesson = practiceLessons.find((item) => item.word === el('practice-word').value);
  if (!lesson) return;
  const video = el('practice-video'); video.pause(); video.src = lesson.src; video.load();
  el('practice-play').textContent = '▶ ดูคลิปตัวอย่าง';
  video.setAttribute('aria-label', `คลิปตัวอย่างท่า${lesson.label}`);
  document.querySelector('.camera-card h2').textContent = practiceMode ? `ฝึกท่า “${lesson.label}”` : 'ตรวจจับท่าทาง';
  resetPracticeAttempt();
  renderPracticeTest();
}
function setPracticeMode(active) {
  cancelPracticeTest();
  practiceMode = active;
  document.getElementById('gesture-system').classList.toggle('practicing', active);
  el('practice-card').hidden = !active;
  document.querySelector('.gesture-output-card').hidden = active;
  document.querySelector('.supported-guide').hidden = active;
  for (const [id, selected] of [['translation-mode', !active], ['practice-mode', active]]) {
    el(id).classList.toggle('active', selected); el(id).setAttribute('aria-pressed', String(selected));
  }
  if (signSentenceTimer) clearTimeout(signSentenceTimer);
  signSentenceTimer = null; signSentenceBuffer = []; stopSentenceCountdown();
  el('gesture-result-list').replaceChildren();
  el('gesture-status').textContent = 'เปิดกล้องแล้วทำท่าที่รองรับเพื่อต่อคำเป็นประโยค';
  el('gesture-live-caption').hidden = true;
  if (activeSpeech || speechQueue.length) {
    clearSpeechWatchdog(); speechQueue = []; activeSpeech = null;
    window.speechSynthesis?.cancel();
  }
  pauseGestureReferenceVideos();
  if (active) {
    updatePracticeLesson();
    document.querySelector('.gesture-mode-switch').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  else { el('practice-video').pause(); document.querySelector('.camera-card h2').textContent = 'ตรวจจับท่าทาง'; resetPracticeAttempt(); }
  renderPracticeTest();
}
function loadPracticeTests() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRACTICE_TEST_STORAGE) || '{}');
    for (const { word } of practiceLessons) {
      const attempts = saved?.[word]?.attempts;
      if (!Array.isArray(attempts) || attempts.length > PRACTICE_TEST_LIMIT) continue;
      const valid = attempts.every(attempt => {
        if (!attempt || typeof attempt !== 'object') return false;
        const knownPrediction = practiceLessons.some(lesson => lesson.word === attempt.prediction);
        const outcome = attempt.prediction === null ? 'missed' : attempt.prediction === word ? 'correct' : 'wrong';
        return (attempt.prediction === null || knownPrediction) && attempt.outcome === outcome
          && Number.isFinite(attempt.at) && Number.isFinite(attempt.durationMs) && attempt.durationMs >= 0;
      });
      if (valid) practiceTestRuns[word] = { attempts: attempts.map(attempt => ({
        prediction: attempt.prediction, outcome: attempt.outcome, at: attempt.at, durationMs: attempt.durationMs
      })) };
    }
  } catch (_) {
    practiceTestRuns = {};
  }
}

function savePracticeTests() {
  try {
    localStorage.setItem(PRACTICE_TEST_STORAGE, JSON.stringify(practiceTestRuns));
    practiceTestStorageAvailable = true;
  } catch (_) {
    practiceTestStorageAvailable = false;
  }
}

function currentPracticeTest() {
  const word = el('practice-word').value;
  practiceTestRuns[word] ??= { attempts: [] };
  return practiceTestRuns[word];
}

function practiceTestBusy() {
  return practiceTestPhase === 'neutral' || practiceTestPhase === 'running';
}

function renderPracticeTest() {
  const testing = practiceMode && practiceTestMode;
  const busy = practiceTestBusy();
  const { attempts } = currentPracticeTest();
  const complete = attempts.length === PRACTICE_TEST_LIMIT;
  el('practice-test-live').hidden = !testing;
  el('practice-test-results').hidden = !testing;
  el('practice-word').disabled = busy;
  el('practice-next').disabled = busy;
  el('practice-play').disabled = busy;
  el('practice-test-reset').disabled = busy;
  el('practice-test-start').disabled = !practiceCameraReady || busy || complete;
  el('practice-test-start').hidden = busy;
  el('practice-test-cancel').hidden = !busy;
  el('practice-test-clock').hidden = practiceTestPhase !== 'running';
  el('practice-test-start').textContent = `เริ่มครั้งที่ ${Math.min(attempts.length + 1, PRACTICE_TEST_LIMIT)}`;
  if (practiceTestMode) el('practice-retry').hidden = true;

  const label = el('practice-word').selectedOptions[0]?.textContent || '';
  let status = `ทดสอบ “${label}” · บันทึกแล้ว ${attempts.length} / ${PRACTICE_TEST_LIMIT} ครั้ง`;
  if (practiceTestPhase === 'neutral') status = `ครั้งที่ ${attempts.length + 1} · ลดมือให้พ้นภาพสักครู่เพื่อเริ่มนับเวลา`;
  if (practiceTestPhase === 'running') status = `ครั้งที่ ${attempts.length + 1} · ทำท่า “${label}” ได้เลย`;
  if (complete) status = `ทดสอบ “${label}” ครบ ${PRACTICE_TEST_LIMIT} ครั้งแล้ว`;
  el('practice-test-status').textContent = status;
  if (practiceTestPhase !== 'running') {
    el('practice-test-time').textContent = busy ? 'เตรียมพร้อม · เวลายังไม่เริ่มนับ' : practiceCameraReady ? 'กดเริ่มเมื่อพร้อมทำท่า' : 'เปิดกล้องก่อนเริ่มทดสอบ';
  }

  const correct = attempts.filter(attempt => attempt.outcome === 'correct').length;
  const wrong = attempts.filter(attempt => attempt.outcome === 'wrong').length;
  const missed = attempts.length - correct - wrong;
  el('practice-test-summary').textContent = attempts.length
    ? `ผลชุดนี้ · จับตรงคำ ${correct} / ${attempts.length} ครั้ง (${Math.round(correct / attempts.length * 100)}%) · อ่านเป็นคำอื่น ${wrong} ครั้ง · จับไม่ได้ ${missed} ครั้ง`
    : 'ยังไม่มีผลทดสอบของคำนี้';
  el('practice-test-attempts').replaceChildren(...attempts.map((attempt, index) => {
    const item = document.createElement('li');
    item.dataset.outcome = attempt.outcome;
    const result = attempt.outcome === 'correct' ? 'จับตรงคำ'
      : attempt.outcome === 'wrong' ? `อ่านเป็น “${attempt.prediction}”` : 'จับไม่ได้ภายใน 8 วินาที';
    item.textContent = `ครั้งที่ ${index + 1} · ${result}`;
    return item;
  }));
  el('practice-test-storage').textContent = practiceTestStorageAvailable
    ? 'เก็บผลชุดล่าสุดของแต่ละคำในเบราว์เซอร์นี้ ผลทดสอบขึ้นอยู่กับผู้ทำท่า แสง และมุมกล้องในชุดนี้'
    : 'เบราว์เซอร์บันทึกผลถาวรไม่ได้ ผลชุดนี้จะแสดงจนกว่าจะปิดหรือรีเฟรชหน้า';
}

function cancelPracticeTest(message = '') {
  const interrupted = practiceTestBusy();
  clearInterval(practiceTestTimer);
  practiceTestTimer = null;
  practiceTestPhase = 'idle';
  if (interrupted) {
    resetPracticeAttempt();
    if (message) practiceResult('ยกเลิกครั้งนี้แล้ว', message);
  }
}

function startPracticeTest() {
  if (!practiceMode || !practiceTestMode || !practiceCameraReady || practiceTestBusy()
      || currentPracticeTest().attempts.length >= PRACTICE_TEST_LIMIT) return;
  el('practice-video').pause();
  practiceTestPhase = 'neutral';
  resetPracticeAttempt();
  practiceResult('เตรียมทดสอบครั้งใหม่', 'ลดมือให้พ้นภาพสักครู่ แล้วทำท่าเมื่อระบบเริ่มนับเวลา');
  renderPracticeTest();
}

function runPracticeTest() {
  if (practiceTestPhase !== 'neutral' || !practiceCameraReady) return;
  practiceTestPhase = 'running';
  practiceTestStartedAt = performance.now();
  practiceTestDeadline = practiceTestStartedAt + PRACTICE_TEST_DURATION_MS;
  practiceResult('เริ่มทำท่าได้เลย', 'ระบบจะบันทึกคำแรกที่อ่านได้ในครั้งนี้');
  renderPracticeTest();
  const update = () => {
    const remaining = Math.max(0, practiceTestDeadline - performance.now());
    el('practice-test-clock').value = remaining / 1000;
    el('practice-test-time').textContent = `เหลือ ${Math.ceil(remaining / 1000)} วินาที`;
    if (!remaining) finishPracticeTest(null);
  };
  practiceTestTimer = setInterval(update, 100);
  update();
}

function finishPracticeTest(prediction) {
  if (practiceTestPhase !== 'running') return;
  clearInterval(practiceTestTimer);
  practiceTestTimer = null;
  const word = el('practice-word').value;
  const outcome = prediction === null ? 'missed' : prediction === word ? 'correct' : 'wrong';
  currentPracticeTest().attempts.push({
    prediction, outcome, at: Date.now(), durationMs: Math.min(PRACTICE_TEST_DURATION_MS, performance.now() - practiceTestStartedAt)
  });
  practiceTestPhase = 'result';
  savePracticeTests();
  resetPracticeAttempt();
  const message = outcome === 'correct' ? `ระบบอ่านเป็น “${prediction}” ตรงกับคำที่เลือก`
    : outcome === 'wrong' ? `เลือก “${word}” แต่ระบบอ่านเป็น “${prediction}”` : 'หมดเวลา 8 วินาทีโดยระบบยังอ่านท่าไม่ได้';
  practiceResult(outcome === 'correct' ? 'จับตรงคำแล้ว' : 'บันทึกผลครั้งนี้แล้ว', message, outcome === 'correct' ? 'success' : 'waiting');
  renderPracticeTest();
}

el('practice-test-mode').addEventListener('change', () => {
  cancelPracticeTest();
  practiceTestMode = el('practice-test-mode').checked;
  resetPracticeAttempt();
  renderPracticeTest();
  if (practiceTestMode) el('practice-test-live').scrollIntoView({ block: 'start', behavior: 'auto' });
});
el('practice-test-start').addEventListener('click', startPracticeTest);
el('practice-test-cancel').addEventListener('click', () => {
  cancelPracticeTest('ครั้งที่ยกเลิกจะไม่นับรวมในผลทดสอบ');
  renderPracticeTest();
});
el('practice-test-reset').addEventListener('click', () => {
  if (practiceTestBusy()) return;
  practiceTestRuns[el('practice-word').value] = { attempts: [] };
  savePracticeTests();
  resetPracticeAttempt();
  renderPracticeTest();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && practiceTestBusy()) {
    cancelPracticeTest('กลับมาหน้านี้แล้วกดเริ่มครั้งเดิมได้อีกครั้ง');
    renderPracticeTest();
  }
});
window.addEventListener('pagehide', () => cancelPracticeTest());

function completePractice() {
  practiceComplete = true;
  const word = el('practice-word').value;
  const label = practiceLessons.find((lesson) => lesson.word === word)?.label || word;
  practicedWords.add(word);
  practiceResult(`✓ ตรวจพบท่า “${label}” แล้ว`, 'ฝึกคำนี้อีกครั้ง หรือเลือกคำถัดไปได้เลย', 'success');
  el('practice-retry').hidden = false;
  el('practice-progress').textContent = `ฝึกสำเร็จในรอบนี้ ${practicedWords.size} / ${practiceLessons.length} คำ`;
  el('gesture-live-caption').textContent = `✓ ${label}`; el('gesture-live-caption').hidden = false;
}
el('practice-home').addEventListener('click', () => { pendingPractice = true; showSystemGuide('gesture-system'); });
el('practice-mode').addEventListener('click', () => setPracticeMode(true));
el('translation-mode').addEventListener('click', () => {
  const wasPracticing = practiceMode;
  setPracticeMode(false);
  if (wasPracticing && practiceCameraReady) prepareGestureAudioFromTap();
});
el('practice-word').addEventListener('change', updatePracticeLesson);
el('practice-retry').addEventListener('click', resetPracticeAttempt);
el('practice-next').addEventListener('click', () => {
  el('practice-word').selectedIndex = (el('practice-word').selectedIndex + 1) % practiceLessons.length;
  updatePracticeLesson(); el('practice-word').focus();
});
el('practice-play').addEventListener('click', () => {
  const video = el('practice-video');
  if (!video.paused) video.pause();
  else video.play().catch((error) => {
    if (error.name !== 'AbortError') practiceResult('ยังเล่นคลิปไม่ได้', 'ลองกดดูคลิปอีกครั้ง หรือเลือกคำใหม่');
  });
});
el('practice-video').addEventListener('play', () => { el('practice-play').textContent = 'Ⅱ หยุดคลิปตัวอย่าง'; });
el('practice-video').addEventListener('pause', () => { el('practice-play').textContent = '▶ ดูคลิปตัวอย่าง'; });
el('practice-video').addEventListener('error', () => { if (practiceMode) practiceResult('โหลดคลิปไม่ได้', 'ตรวจการเชื่อมต่อแล้วลองเลือกคำอีกครั้ง'); });
window.addEventListener('practice-ready', () => {
  if (practiceMode && practiceTestMode) {
    if (practiceTestPhase === 'neutral') runPracticeTest();
    return;
  }
  if (practiceMode && !practiceComplete) practiceResult(`กำลังรอท่า “${el('practice-word').selectedOptions[0].textContent}”`, 'ทำท่าตามคลิป โดยให้กล้องเห็นใบหน้าและมือชัดเจน');
});
window.addEventListener('camera-state-changed', (event) => {
  practiceCameraReady = event.detail.state === 'ready';
  if (!practiceCameraReady) cancelPracticeTest('กล้องหยุดแล้ว · ครั้งที่ยังทำค้างอยู่จะเริ่มใหม่ได้');
  renderPracticeTest();
  if (practiceMode && !practiceComplete && !practiceCameraReady) practiceResult('ยังไม่ได้เปิดกล้อง', 'กด “เปิดกล้อง” เพื่อเริ่มฝึกคำที่เลือก');
});
window.addEventListener('practice-instruction', (event) => {
  const { word, steps, index, complete } = event.detail;
  if (word !== el('practice-word').value) return;
  el('practice-steps').replaceChildren(...steps.map((text, stepIndex) => {
    const item = document.createElement('li');
    item.textContent = text;
    item.dataset.state = complete || stepIndex < index ? 'done' : stepIndex === index ? 'current' : 'pending';
    if (!complete && stepIndex === index) item.setAttribute('aria-current', 'step');
    return item;
  }));
  el('practice-step-note').textContent = complete ? 'ระบบตรวจพบท่าที่เลือกครบแล้ว'
    : !practiceCameraReady ? 'เปิดกล้องเพื่อให้ขั้นตอนเปลี่ยนตามจังหวะที่ตรวจพบ'
    : index < 0 ? 'เตรียมพร้อมก่อนเริ่มทำท่า' : `กำลังรอจังหวะที่ ${index + 1} / ${steps.length}`;
});
loadPracticeTests();
updatePracticeLesson();
el('practice-progress').textContent = `ฝึกสำเร็จในรอบนี้ 0 / ${practiceLessons.length} คำ`;
