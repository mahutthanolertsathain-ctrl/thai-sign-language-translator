import { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0';

const camera = document.getElementById('camera-video');
const cameraWrap = camera.closest('.camera-wrap');
const placeholder = document.getElementById('camera-placeholder');
const startButton = document.getElementById('camera-start');
const stopButton = document.getElementById('camera-stop');
const badge = document.getElementById('camera-status');
const frameCanvas = document.createElement('canvas');
const frameContext = frameCanvas.getContext('2d', { willReadFrequently: false });
let stream = null;
let handTask = null;
let faceTask = null;
let poseTask = null;
let lastPoseResult = null;
let lastPoseAt = -Infinity;
let loopId = 0;
let lastInferenceAt = 0;
let lastVideoTime = -1;
const state = {
  meSince: 0, meLastValid: 0, meLatched: false, angryStage: 0, angrySince: 0, angryCooldownUntil: 0,
  sickStage: 0, sickSince: 0, sickHoldSince: 0, sickLastValid: 0,
  fatherStage: 0, fatherSince: 0, fatherFistSince: 0,
  motherStage: 0, motherSince: 0, motherFistSince: 0,
  loveSince: 0,
  sosStage: 0, sosSince: 0, sosHoldSince: 0,
  lastWord: '', lastWordAt: 0, prompt: 'กำลังตรวจจับท่าที่รองรับ', cooldown: new Map()
};
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const ME_HOLD_MS = 1500;
const ME_HOLD_SECONDS = (ME_HOLD_MS / 1000).toFixed(1);
const ANGRY_TOUCH_THRESHOLD = 0.12;
const ANGRY_PULL_THRESHOLD = 0.15;
const ANGRY_TIMEOUT_MS = 2000;
const ANGRY_COOLDOWN_MS = 1000;
const SICK_TIMEOUT_MS = 2500;
const SICK_HOLD_MS = 250;
const SICK_COOLDOWN_MS = 1500;
const SICK_TRACKING_GRACE_MS = 300;
const SICK_FOREHEAD_DISTANCE = 0.12;

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function up(points, tip, pip) { return points[tip].y < points[pip].y; }
const practice = { active: document.getElementById('gesture-system').classList.contains('practicing'), word: document.getElementById('practice-word').value, matched: false, awaitNeutral: document.getElementById('gesture-system').classList.contains('practicing'), neutralSince: null };
window.addEventListener('practice-settings-changed', (event) => {
  practice.active = Boolean(event.detail.active); practice.word = event.detail.word || '';
  practice.matched = false; practice.awaitNeutral = practice.active; practice.neutralSince = null;
  resetRecognitionState();
  if (!framingPanel.hidden) renderCameraGuidance();
});
function announce(word, now, minimumInterval = 2200) {
  if (practice.active && (practice.matched || practice.awaitNeutral || word !== practice.word)) return false;
  const last = state.cooldown.get(word);
  if (last !== undefined && now - last < minimumInterval) return false;
  state.cooldown.set(word, now);
  state.lastWord = word;
  state.lastWordAt = now;
  if (practice.active) practice.matched = true;
  window.dispatchEvent(new CustomEvent('sign-detected', { detail: { word } }));
  badge.textContent = `ตรวจพบ: ${word}`;
  return true;
}
function handLabel(result, index) {
  return result.handedness?.[index]?.[0]?.categoryName || '';
}

function updateCameraAspectRatio() {
  if (camera.videoWidth && camera.videoHeight) {
    cameraWrap.style.aspectRatio = `${camera.videoWidth} / ${camera.videoHeight}`;
  }
}

function isFistY(points) { return [8, 12, 16, 20].every((tip) => points[tip].y > points[tip - 2].y); }
function distanceFromWrist(points, index) { return distance(points[index], points[0]); }
function resetRecognitionState() {
  Object.assign(state, {
    meSince: 0, meLastValid: 0, meLatched: false, angryStage: 0, angrySince: 0, angryCooldownUntil: 0,
    sickStage: 0, sickSince: 0, sickHoldSince: 0, sickLastValid: 0,
    fatherStage: 0, fatherSince: 0, fatherFistSince: 0,
    motherStage: 0, motherSince: 0, motherFistSince: 0,
    loveSince: 0,
    sosStage: 0, sosSince: 0, sosHoldSince: 0,
    lastWord: '', lastWordAt: 0, prompt: 'กำลังตรวจจับท่าที่รองรับ'
  });
  state.cooldown.clear();
  resetAddedSigns();
  resetFullState();
  resetWellState();
  resetUncleMotion();
  resetCryMotion();
  resetChildMotion();
  resetSmileMotion();
  resetHelloState();
  loveHold.latched = false; loveHold.lastValid = 0;
  sickHold.latched = false; sickHold.lastValid = 0;
  lastSingleAt = 0;
}
function resetSingleHandState() {
  state.meSince = state.meLastValid = 0;
  state.meLatched = false;
  state.fatherStage = state.motherStage = 0;
  state.fatherSince = state.motherSince = 0;
  state.fatherFistSince = state.motherFistSince = 0;
}

// These two sequences follow the reference clips, using palm/face scale rather
// than fixed pixel distances. Mirrored video can reverse handedness labels.
const addedSigns = {
  heSince: 0, heLastValid: 0, heStartOffset: 0, heMoved: false, heLatched: false,
  hungryStage: 0, hungrySince: 0, hungryLastValid: 0, hungryLatched: false
};
function resetAddedSigns() {
  Object.assign(addedSigns, { heSince: 0, heLastValid: 0, heStartOffset: 0, heMoved: false, heLatched: false,
    hungryStage: 0, hungrySince: 0, hungryLastValid: 0, hungryLatched: false });
}
function handMetricDistance(a, b) {
  const aspect = frameCanvas.width / frameCanvas.height;
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}
function fingerBendAngle(points, tip) {
  const aspect = frameCanvas.width / frameCanvas.height;
  const base = points[tip - 3], joint = points[tip - 2], end = points[tip];
  const vector = (p) => [(p.x - joint.x) * aspect, p.y - joint.y, (p.z - joint.z) * aspect];
  const a = vector(base), b = vector(end);
  const magnitude = Math.hypot(...a) * Math.hypot(...b);
  if (magnitude < 1e-8) return 0;
  return Math.acos(Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i], 0) / magnitude))) * 180 / Math.PI;
}
function detectHe(points, face, now) {
  const aspect = frameCanvas.width / frameCanvas.height;
  const palm = handMetricDistance(points[0], points[9]);
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const offset = Math.abs(points[9].x - face[152].x) * aspect;
  const angles = [8, 12, 16, 20].map((tip) => fingerBendAngle(points, tip));
  const fourExtended = angles.slice(0, 3).every((angle) => angle > 140) && angles[3] > 130;
  const fingersTogether = [8, 12, 16].every((tip) => handMetricDistance(points[tip], points[tip + 4]) < palm * .75);
  const sideways = Math.abs(points[8].x - points[0].x) * aspect > palm * .45;
  const belowFace = points[5].y > face[152].y + faceWidth * aspect * .25;
  const pose = palm > .015 && faceWidth > .02 && fourExtended && fingersTogether && sideways && belowFace
    && offset > faceWidth * aspect * .85;
  if (!pose) {
    if (now - addedSigns.heLastValid > 400) {
      addedSigns.heSince = 0; addedSigns.heMoved = false; addedSigns.heLatched = false;
    }
    return false;
  }
  addedSigns.heLastValid = now;
  if (!addedSigns.heSince) { addedSigns.heSince = now; addedSigns.heStartOffset = offset; }
  if (offset - addedSigns.heStartOffset > palm * .22) addedSigns.heMoved = true;
  if (!addedSigns.heLatched && addedSigns.heMoved && now - addedSigns.heSince >= 350) {
    if (announce('เขา', now)) addedSigns.heLatched = true;
  }
  return true;
}
function detectHungry(points, face, now) {
  const aspect = frameCanvas.width / frameCanvas.height;
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const faceScale = faceWidth * aspect;
  const neckOffset = points[5].y - face[152].y;
  const atNeck = faceWidth > .02 && neckOffset > -faceScale * .15 && neckOffset < faceScale * .95
    && Math.abs(points[5].x - face[152].x) < faceWidth * .85;
  const otherFingers = [12, 16, 20].map((tip) => fingerBendAngle(points, tip));
  const threeFolded = otherFingers.every((angle) => angle < 125);
  if (!atNeck || !threeFolded) {
    if (otherFingers.every((angle) => angle > 135) || now - addedSigns.hungryLastValid > 400) {
      addedSigns.hungryStage = 0; addedSigns.hungryLatched = false;
    }
    return false;
  }
  addedSigns.hungryLastValid = now;
  if (addedSigns.hungryLatched) return true;
  const indexAngle = fingerBendAngle(points, 8);
  if (addedSigns.hungryStage && now - addedSigns.hungrySince > 2000) addedSigns.hungryStage = 0;
  if (indexAngle > 155) {
    if (!addedSigns.hungryStage) { addedSigns.hungryStage = 1; addedSigns.hungrySince = now; }
    return true;
  }
  if (addedSigns.hungryStage === 1 && indexAngle < 100 && now - addedSigns.hungrySince >= 120) {
    if (announce('หิว', now)) { addedSigns.hungryLatched = true; addedSigns.hungryStage = 0; }
    return true;
  }
  return addedSigns.hungryStage > 0;
}

function flatFingers(points, palm) {
  return [8, 12, 16, 20].every((tip) => fingerBendAngle(points, tip) > 135)
    && [8, 12, 16].every((tip) => handMetricDistance(points[tip], points[tip + 4]) < palm * .7);
}

const fullState = { start: null, lastOpenAt: 0, chinSince: 0, latched: false };
function resetFullState() {
  Object.assign(fullState, { start: null, lastOpenAt: 0, chinSince: 0, latched: false });
}

// The flat hand rises from the chest to the underside of the chin.
function detectFull(points, face, now) {
  if (now - fullState.lastOpenAt > 500) resetFullState();
  if (!points || !face) return false;
  const aspect = frameCanvas.width / frameCanvas.height;
  const chin = face[152];
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const faceScale = faceWidth * aspect;
  const palm = handMetricDistance(points[0], points[9]);
  if (faceWidth < .02 || palm < .015) return false;

  const middle = points[12];
  const across = (middle.x - points[0].x) * aspect;
  const horizontal = Math.abs(across) > palm * 1.15 && Math.abs(middle.y - points[0].y) < Math.abs(across) * .6;
  const centerY = (points[9].y - chin.y) / faceScale;
  const centered = Math.abs(points[9].x - chin.x) < faceWidth * .85;
  if (!horizontal || !centered || !flatFingers(points, palm)) {
    fullState.chinSince = 0;
    return false;
  }

  fullState.lastOpenAt = now;
  const start = fullState.start;
  if (!fullState.latched && centerY > .85 && centerY < 3.6
      && (!start || centerY >= start.offset || now - start.at > 1500)) {
    fullState.start = { offset: centerY, palmY: points[9].y, at: now };
  }
  const tipY = (middle.y - chin.y) / faceScale;
  const atChin = centerY > -.4 && centerY < .55 && tipY > -.6 && tipY < .55
    && Math.abs(middle.x - chin.x) < faceWidth;
  if (!atChin) { fullState.chinSince = 0; return false; }
  if (fullState.latched) return true;
  if (!start || now - start.at > 1500 || start.offset - centerY < .65
      || start.palmY - points[9].y < faceScale * .4) return false;

  fullState.chinSince ||= now;
  if (now - fullState.chinSince >= 140 && announce('อิ่ม', now)) fullState.latched = true;
  return true;
}

const wellState = { chestAt: 0, thumbsSince: 0, latched: false };
function resetWellState() {
  Object.assign(wellState, { chestAt: 0, thumbsSince: 0, latched: false });
}

// Both flat hands point inward over the chest, then both thumbs turn upward.
function detectWell(hands, face, now) {
  if (!wellState.latched && now - wellState.chestAt > 1700) resetWellState();
  if (hands.length !== 2 || !face) { wellState.thumbsSince = 0; return false; }
  const chin = face[152];
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const faceScale = faceWidth * (frameCanvas.width / frameCanvas.height);
  if (faceWidth < .02) return false;

  const [left, right] = hands[0][0].x < hands[1][0].x ? hands : [hands[1], hands[0]];
  const atChest = (points, side) => {
    const palm = handMetricDistance(points[0], points[9]);
    const wristX = side * (points[0].x - chin.x) / faceWidth;
    const tipX = side * (points[12].x - chin.x) / faceWidth;
    const palmY = (points[9].y - chin.y) / faceScale;
    return palm > .015 && wristX > .75 && wristX < 2.55 && tipX > -.23 && tipX < .8
      && wristX - tipX > .55 && palmY > .65 && palmY < 2.6
      && Math.abs(points[12].y - points[0].y) < palm * .8 && flatFingers(points, palm);
  };
  const thumbUp = (points, side) => {
    const palm = handMetricDistance(points[0], points[9]);
    const palmX = side * (points[9].x - chin.x) / faceWidth;
    const palmY = (points[9].y - chin.y) / faceScale;
    return palm > .015 && palmX > .75 && palmX < 2.65 && palmY > -.55 && palmY < 1.35
      && points[3].y - points[4].y > palm * .15 && points[9].y - points[4].y > palm * .55
      && [8, 12, 16, 20].every((tip) => fingerBendAngle(points, tip) < 115);
  };
  const thumbsUp = thumbUp(left, -1) && thumbUp(right, 1)
    && Math.abs(left[9].y - right[9].y) < faceScale * .8;
  if (thumbsUp && (wellState.chestAt || wellState.latched)) {
    wellState.thumbsSince ||= now;
    if (!wellState.latched && now - wellState.thumbsSince >= 140 && announce('สบายดี', now)) wellState.latched = true;
    return true;
  }

  if (wellState.latched) resetWellState();
  wellState.thumbsSince = 0;
  if (atChest(left, -1) && atChest(right, 1) && left[12].x < right[12].x + faceWidth * .12
      && Math.abs(left[9].y - right[9].y) < faceScale * .65) {
    wellState.chestAt = now;
  }
  return false;
}

const uncleMotion = { samples: [], side: 0, lastValid: 0, latched: false };
const cryMotion = { start: null, lastValid: 0, latched: false };

function resetUncleMotion() {
  uncleMotion.samples = [];
  uncleMotion.side = 0;
  uncleMotion.lastValid = 0;
  uncleMotion.latched = false;
}

function resetCryMotion() {
  cryMotion.start = null;
  cryMotion.lastValid = 0;
  cryMotion.latched = false;
}

function reversesDirection(from, turn, to, axis, scale) {
  const out = turn[axis] - from[axis];
  const back = to[axis] - turn[axis];
  const rawAxis = axis === 'x' ? 'rawX' : 'rawY';
  return out * back < 0 && Math.min(Math.abs(out), Math.abs(back)) >= .16
    && Math.sign(out) * (turn[rawAxis] - from[rawAxis]) >= scale * .11
    && Math.sign(back) * (to[rawAxis] - turn[rawAxis]) >= scale * .11;
}

// The L stays open while the hand moves back and forth beside the temple.
function detectUncleMotion(index, wrist, nose, faceWidth, faceScale, side, now) {
  if (uncleMotion.side !== side) resetUncleMotion();
  uncleMotion.side = side;
  uncleMotion.lastValid = now;
  if (uncleMotion.latched) return true;

  const sample = {
    x: (index.x - nose.x) / faceWidth, y: (wrist.y - nose.y) / faceScale,
    rawX: index.x, rawY: wrist.y, at: now
  };
  const recent = uncleMotion.samples.filter(previous => now - previous.at <= 1600);
  // Check movement in the image as well as relative to the face.
  const reversed = recent.some((turn, index) => recent.slice(0, index).some(from =>
    reversesDirection(from, turn, sample, 'x', faceWidth)
    || reversesDirection(from, turn, sample, 'y', faceScale)));
  recent.push(sample);
  uncleMotion.samples = recent;
  if (reversed) uncleMotion.latched = announce('ลุง', now);
  return reversed;
}

// Two extended fingers start by the eye and move down the face together.
function detectCryMotion(tips, face, faceWidth, faceScale, now) {
  const nose = face[1];
  const offset = (tips.y - nose.y) / faceScale;
  const x = (tips.x - nose.x) / faceWidth;
  if (cryMotion.start && now - cryMotion.start.at > 2300) cryMotion.start = null;
  if (offset < -.2 && [face[133], face[362]].some(eye => handMetricDistance(tips, eye) < faceScale * .45)) {
    if (!cryMotion.start || offset < cryMotion.start.offset) cryMotion.start = { offset, x, y: tips.y, at: now };
  }
  const start = cryMotion.start;
  if (start && now - start.at >= 200 && offset >= -.05
      && offset - start.offset >= .36 && tips.y - start.y >= faceScale * .28
      && Math.abs(x - start.x) < .42) {
    cryMotion.latched = announce('ร้องไห้', now);
    return true;
  }
  return false;
}

function detectFaceSigns(points, face, now) {
  if (now - uncleMotion.lastValid > 480) resetUncleMotion();
  if (now - cryMotion.lastValid > 480) resetCryMotion();
  if (!points || !face) return false;

  const aspect = frameCanvas.width / frameCanvas.height;
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const faceScale = faceWidth * aspect;
  const palm = handMetricDistance(points[0], points[9]);
  if (faceWidth < .02 || palm < .015) return false;
  const nose = face[1], index = points[8], middle = points[12], thumb = points[4];
  const side = Math.sign(index.x - nose.x);
  const indexX = Math.abs(index.x - nose.x) / faceWidth;
  const indexY = (index.y - nose.y) / faceScale;
  const upright = points[5].y - index.y > palm * .4;
  const [indexAngle, middleAngle, ringAngle, pinkyAngle] = [8, 12, 16, 20].map(tip => fingerBendAngle(points, tip));
  const fingersFolded = ringAngle < 120 && pinkyAngle < 120;
  const lShape = upright && indexAngle > 150 && middleAngle < 110 && fingersFolded
    && side * (points[2].x - thumb.x) * aspect > palm * .34
    && Math.abs(thumb.y - points[2].y) < palm * .5;
  const thumbNearCheek = [face[50], face[280]].some(cheek => handMetricDistance(cheek, thumb) < faceScale * .30);
  if (lShape && indexX > .38 && indexX < 1.28 && indexY > -.95 && indexY < .12 && !thumbNearCheek) {
    resetCryMotion();
    return detectUncleMotion(index, points[0], nose, faceWidth, faceScale, side, now);
  }
  resetUncleMotion();

  const separation = handMetricDistance(index, middle);
  const tips = { x: (index.x + middle.x) / 2, y: (index.y + middle.y) / 2 };
  const tipY = (tips.y - nose.y) / faceScale;
  const vShape = upright && indexAngle > 145 && middleAngle > 145 && fingersFolded
    && separation > palm * .24 && separation < palm * .95 && Math.abs(index.y - middle.y) < palm * .48;
  if (vShape && Math.abs(tips.x - nose.x) < faceWidth * .55 && tipY > -.95 && tipY < .66) {
    cryMotion.lastValid = now;
    return cryMotion.latched || detectCryMotion(tips, face, faceWidth, faceScale, now);
  }
  resetCryMotion();
  return false;
}

const childMotion = { stage: '', anchor: null, since: 0, lastValid: 0, side: 0, latched: false };

function resetChildMotion() {
  Object.assign(childMotion, { stage: '', anchor: null, since: 0, lastValid: 0, side: 0, latched: false });
}

function palmNormalY(points, aspect) {
  const [wrist, index, pinky] = [points[0], points[5], points[17]];
  const a = { x: (index.x - wrist.x) * aspect, y: index.y - wrist.y, z: (index.z - wrist.z) * aspect };
  const b = { x: (pinky.x - wrist.x) * aspect, y: pinky.y - wrist.y, z: (pinky.z - wrist.z) * aspect };
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return Math.abs(y) / Math.hypot(x, y, z);
}

// A flat hand dips, rises and dips again below the face.
function detectChild(points, face, now) {
  if (now - childMotion.lastValid > 700 || (!childMotion.latched && now - childMotion.since > 1900)) resetChildMotion();
  if (!points || !face) return false;

  const aspect = frameCanvas.width / frameCanvas.height;
  const mouth = face[13], wrist = points[0], middle = points[12];
  const faceWidth = Math.abs(face[234].x - face[454].x);
  const scale = faceWidth * aspect;
  const palm = handMetricDistance(wrist, points[9]);
  if (faceWidth < .02 || palm < .015) return false;
  const wristOffset = (wrist.x - mouth.x) / faceWidth;
  const side = Math.sign(wristOffset);
  const offset = (middle.y - mouth.y) / scale;
  if (Math.abs(wristOffset) < .68 || Math.abs(wristOffset) > 2.65 || offset < 1.25 || offset > 3.55) {
    resetChildMotion();
    return false;
  }
  if (side !== childMotion.side) resetChildMotion();
  // An individual frame can lose the finger shape during a quick dip.
  if (!flatFingers(points, palm)) return false;
  childMotion.lastValid = now;
  childMotion.side = side;
  if (childMotion.latched) {
    if (offset >= 2.24) return true;
    resetChildMotion();
    return false;
  }

  const sample = { offset, wristY: wrist.y };
  const towardMiddle = side * (wrist.x - middle.x) * aspect;
  const level = palmNormalY(points, aspect);
  const raised = towardMiddle > palm * .85 && level > .44 && offset < 2.28;
  const low = offset >= 2.24 && towardMiddle > palm * .85 && level > .4;
  if (!childMotion.anchor) {
    if (!raised && !low) return false;
    childMotion.stage = raised ? 'first-press' : 'lift';
    childMotion.anchor = sample;
    childMotion.since = now;
    return false;
  }

  const anchor = childMotion.anchor;
  if (childMotion.stage === 'lift') {
    if (raised && anchor.offset - offset >= .32 && anchor.wristY - wrist.y >= scale * .15) {
      childMotion.stage = 'second-press';
      childMotion.anchor = sample;
    } else if (offset > anchor.offset) childMotion.anchor = sample;
  } else if (offset - anchor.offset >= .34 && wrist.y - anchor.wristY >= scale * .15) {
    if (childMotion.stage === 'second-press') {
      childMotion.latched = announce('เด็ก', now);
      return true;
    }
    childMotion.stage = 'lift';
    childMotion.anchor = sample;
  } else if (raised && offset < anchor.offset) childMotion.anchor = sample;
  return false;
}

const smileMotion = { start: null, lastValid: 0, finishSince: 0, latched: false };

function resetSmileMotion() {
  Object.assign(smileMotion, { start: null, lastValid: 0, finishSince: 0, latched: false });
}

// Both hands move from the middle of the mouth out toward the cheeks.
function detectSmile(hands, face, now) {
  if (now - smileMotion.lastValid > 550) resetSmileMotion();
  if (hands.length !== 2 || !face) return false;
  const aspect = frameCanvas.width / frameCanvas.height;
  const mouth = face[13], faceWidth = Math.abs(face[234].x - face[454].x);
  const scale = faceWidth * aspect;
  if (faceWidth < .02) return false;
  const [left, right] = hands[0][0].x < hands[1][0].x ? hands : [hands[1], hands[0]];
  const fingerNearMouth = (points, side) => {
    const wrist = points[0], middle = points[12];
    const palm = handMetricDistance(wrist, points[9]);
    const wristX = side * (wrist.x - mouth.x) / faceWidth;
    const tipX = side * (middle.x - mouth.x) / faceWidth;
    return palm > .015 && wristX > .68 && wristX < 2.15 && tipX > -.17 && tipX < .95
      && side * (wrist.x - middle.x) * aspect > palm * .85
      && Math.abs(middle.y - mouth.y) < scale * .63
      && points[4].y - points[9].y > -palm * .22 && flatFingers(points, palm);
  };
  if (!fingerNearMouth(left, -1) || !fingerNearMouth(right, 1)) {
    smileMotion.finishSince = 0;
    return false;
  }
  smileMotion.lastValid = now;
  if (smileMotion.latched) return true;

  const leftOffset = (mouth.x - left[12].x) / faceWidth;
  const rightOffset = (right[12].x - mouth.x) / faceWidth;
  const gap = leftOffset + rightOffset;
  if (smileMotion.start && now - smileMotion.start.at > 1450) smileMotion.start = null;
  if (leftOffset < .46 && rightOffset < .46 && gap < .69 && (!smileMotion.start || gap < smileMotion.start.gap)) {
    smileMotion.start = { leftOffset, rightOffset, gap, at: now };
  }
  const start = smileMotion.start;
  const atCheeks = start && leftOffset > .33 && rightOffset > .33
    && leftOffset - start.leftOffset >= .13 && rightOffset - start.rightOffset >= .13 && gap - start.gap >= .37;
  if (!atCheeks) {
    smileMotion.finishSince = 0;
    return false;
  }
  smileMotion.finishSince ||= now;
  if (now - smileMotion.finishSince < 120) return false;
  smileMotion.latched = announce('ยิ้ม', now);
  return true;
}

// The greeting reference is palms together followed by a bow. A hand can
// temporarily hide the other hand, and a deep bow can hide the face.
const helloState = { since: 0, lastPairAt: 0, lastValid: 0, latched: false, bowSeen: false, baselineTilt: 0, faceHistory: [] };
function resetHelloState() {
  Object.assign(helloState, { since: 0, lastPairAt: 0, lastValid: 0, latched: false, bowSeen: false, baselineTilt: 0, faceHistory: [] });
}
function detectHello(hands, face, now) {
  const aspect = frameCanvas.width / frameCanvas.height;
  if (face) {
    const tilt = Math.atan2((face[152].z - face[10].z) * aspect, face[152].y - face[10].y) * 180 / Math.PI;
    helloState.faceHistory.push({ at: now, tilt, chin: face[152], width: Math.abs(face[234].x - face[454].x) });
  }
  helloState.faceHistory = helloState.faceHistory.filter((sample) => now - sample.at <= 1800);
  const recentFace = helloState.faceHistory[helloState.faceHistory.length - 1];
  const upright = (p) => {
    const palm = handMetricDistance(p[0], p[9]);
    return palm > .015 && (p[0].y - p[12].y) > palm * 1.15
      && [8, 12, 16, 20].every((tip) => fingerBendAngle(p, tip) > 135)
      && [8, 12, 16].every((tip) => handMetricDistance(p[tip], p[tip + 4]) < palm * .7);
  };
  const centered = (p) => recentFace && now - recentFace.at <= 1100
    && Math.abs(p[9].x - recentFace.chin.x) < recentFace.width
    && p[9].y > recentFace.chin.y - recentFace.width * aspect
    && p[9].y < recentFace.chin.y + recentFace.width * aspect * 3.3;
  let paired = false;
  if (hands.length === 2 && hands.every(upright) && hands.every(centered)) {
    const palm = (handMetricDistance(hands[0][0], hands[0][9]) + handMetricDistance(hands[1][0], hands[1][9])) / 2;
    paired = handMetricDistance(hands[0][8], hands[1][8]) < palm * .95
      && handMetricDistance(hands[0][0], hands[1][0]) < palm * 1.65;
  }
  if (paired) {
    helloState.lastPairAt = now;
    if (!helloState.since) {
      helloState.since = now;
      helloState.baselineTilt = Math.min(...helloState.faceHistory.map((sample) => sample.tilt));
      helloState.bowSeen = helloState.faceHistory.some((sample) => now - sample.at < 850 && sample.tilt - helloState.baselineTilt > 18);
    }
  }
  const singleContinuation = helloState.since && hands.length === 1 && upright(hands[0]) && centered(hands[0]) && now - helloState.lastPairAt <= 1100;
  const valid = paired || singleContinuation;
  if (helloState.since && face && recentFace.tilt - helloState.baselineTilt > 18) helloState.bowSeen = true;
  if (valid) {
    helloState.lastValid = now;
    if (!helloState.latched && helloState.bowSeen && now - helloState.since >= 300) {
      if (announce('สวัสดี', now)) helloState.latched = true;
    }
  } else if (helloState.since && now - helloState.lastValid > 600) {
    helloState.since = 0; helloState.latched = false; helloState.bowSeen = false;
  }
  if (helloState.since && now - helloState.since > 4000 && !helloState.latched) helloState.since = 0;
  return Boolean(valid || helloState.since && now - helloState.lastValid <= 600);
}

const loveHold = { latched: false, lastValid: 0 };
const sickHold = { latched: false, lastValid: 0 };
let lastSingleAt = 0;
function chestArms(pose) {
  if (!pose || [11, 12].some((i) => (pose[i].visibility ?? 0) < .3)) return null;
  const aspect = frameCanvas.width / frameCanvas.height;
  const width = Math.abs(pose[11].x - pose[12].x), height = width * aspect;
  if (width < .06) return null;
  const center = { x: (pose[11].x + pose[12].x) / 2, y: (pose[11].y + pose[12].y) / 2 };
  const wrists = [pose[15], pose[16]];
  const visible = wrists.map((w) => (w.visibility ?? 0) >= .25);
  const raised = wrists.map((w, i) => visible[i] && Math.abs(w.x - center.x) < width * 1.1
    && w.y > center.y - height * .45 && w.y < center.y + height * 1.05);
  const down = wrists.map((w, i) => !visible[i] || w.y >= center.y + height * 1.05);
  return { width, height, center, wrists, bothRaised: raised.every(Boolean),
    singleRaised: raised[0] && down[1] ? wrists[0] : raised[1] && down[0] ? wrists[1] : null };
}
function chestPalm(points, face) {
  const palm = handMetricDistance(points[0], points[9]);
  const aspect = frameCanvas.width / frameCanvas.height;
  const faceWidth = Math.abs(face[234].x - face[454].x), faceScale = faceWidth * aspect;
  const openCount = [8, 12, 16, 20].filter((tip) => fingerBendAngle(points, tip) > 115).length;
  const together = [8, 12, 16].every((tip) => handMetricDistance(points[tip], points[tip + 4]) < palm * .9);
  const onChest = points[9].y > face[152].y + faceScale * .05
    && points[9].y < face[152].y + faceScale * 3.3
    && Math.abs(points[9].x - face[152].x) < faceWidth * 1.8;
  const dx = (points[12].x - points[0].x) * aspect;
  return { palm, dx, open: palm > .012 && openCount >= 3 && together,
    pose: palm > .012 && openCount >= 3 && together && onChest && Math.abs(dx) > palm * .5 };
}

function detectMe(points, face, now, arms) {
  const chin = face[152];
  const hand = chestPalm(points, face);
  // Body landmarks improve separation when available, but a hidden idle arm
  // must not prevent a single clear hand on the chest from being recognized.
  const rightHandFallback = points[0].x > chin.x + Math.abs(face[234].x - face[454].x) * .08 && hand.dx < 0;
  const pose = hand.pose && !arms?.bothRaised && (arms?.singleRaised || rightHandFallback);
  if (pose) {
    state.meLastValid = now;
    if (!state.meLatched) {
      if (!state.meSince || !state.meAnchor || handMetricDistance(points[0], state.meAnchor) > hand.palm * .85) {
        state.meSince = now; state.meAnchor = { ...points[0] };
      }
      if (now - state.meSince >= ME_HOLD_MS) {
        announce('ฉัน', now);
        state.meSince = 0;
        state.meLatched = true;
      }
    }
  } else if (!state.meLastValid || now - state.meLastValid > 450) {
    state.meSince = 0;
    state.meLastValid = 0;
    state.meLatched = false;
  }
  const trackingGrace = state.meLastValid > 0 && now - state.meLastValid <= 450;
  return pose || trackingGrace;
}

function detectAngry(hands, face, now) {
  if (now < state.angryCooldownUntil) return false;
  if (!hands.length || !face) {
    state.angryStage = 0;
    state.angrySince = 0;
    return false;
  }
  const points = hands[0];
  const forehead = face[10];
  const fingertipsTouching = [4, 8, 12, 16, 20].every((index) => distance(points[index], forehead) <= ANGRY_TOUCH_THRESHOLD);
  const palmAway = distance(points[0], forehead) > ANGRY_TOUCH_THRESHOLD + 0.05;
  const fingertipsCenter = { x: (points[8].x + points[12].x) / 2, y: (points[8].y + points[12].y) / 2 };
  const pullDistance = distance(forehead, fingertipsCenter);
  if (state.angryStage === 0) {
    if (fingertipsTouching && palmAway) { state.angryStage = 1; state.angrySince = now; }
    return fingertipsTouching && palmAway;
  }
  if (now - state.angrySince > ANGRY_TIMEOUT_MS) {
    state.angryStage = 0;
    state.angrySince = 0;
  } else if (pullDistance > ANGRY_PULL_THRESHOLD) {
    announce('โกรธ', now, ANGRY_COOLDOWN_MS);
    state.angryStage = 0;
    state.angrySince = 0;
    state.angryCooldownUntil = now + ANGRY_COOLDOWN_MS;
  }
  return state.angryStage === 1;
}

function detectSick(hands, handsResult, face, now) {
  if (sickHold.latched) {
    const holding = face && hands.length && distance(hands[0][9], face[10]) < .18;
    if (holding) { sickHold.lastValid = now; return true; }
    if (now - sickHold.lastValid <= 600) return false;
    sickHold.latched = false;
  }
  if (!hands.length || !face) {
    if (state.sickStage === 1 && state.sickLastValid && now - state.sickLastValid <= SICK_TRACKING_GRACE_MS) return true;
    state.sickStage = 0;
    state.sickSince = 0;
    state.sickHoldSince = 0;
    state.sickLastValid = 0;
    return false;
  }

  const points = hands[0];
  const forehead = face[10];
  const label = handLabel(handsResult, 0);
  const fingersStraight = [8, 12, 16, 20].every((index) => points[index].y < points[index - 2].y);
  const labelsToTry = label === 'Left' ? ['Left', 'Right'] : ['Right', 'Left'];
  const thumbBackPose = labelsToTry.some((side) => {
    const thumbFolded = side === 'Left' ? points[4].x > points[5].x - 0.02 : points[4].x < points[5].x + 0.02;
    const backHand = side === 'Left' ? points[4].x < points[8].x : points[4].x > points[8].x;
    return thumbFolded && backHand;
  });
  const thumbTucked = Math.abs(points[4].x - points[9].x) < 0.05;
  const foreheadDistance = distance(points[9], forehead);
  state.sickLastValid = now;

  if (state.sickStage === 0) {
    if (fingersStraight && thumbTucked && thumbBackPose && foreheadDistance < 0.25) {
      state.sickStage = 1;
      state.sickSince = now;
      state.sickHoldSince = 0;
    }
  } else if (now - state.sickSince > SICK_TIMEOUT_MS) {
    state.sickStage = 0;
    state.sickSince = 0;
    state.sickHoldSince = 0;
    state.sickLastValid = 0;
  } else if (foreheadDistance < SICK_FOREHEAD_DISTANCE) {
    state.sickHoldSince = state.sickHoldSince || now;
    if (now - state.sickHoldSince >= SICK_HOLD_MS && announce('ไม่สบาย', now, SICK_COOLDOWN_MS)) {
      sickHold.latched = true; sickHold.lastValid = now;
      state.sickStage = 0;
      state.sickSince = 0;
      state.sickHoldSince = 0;
      state.sickLastValid = 0;
    }
  } else state.sickHoldSince = 0;

  return state.sickStage === 1;
}

function detectParents(points, face, now) {
  const cheeks = [face[50], face[280]];
  const thumbAtCheek = cheeks.some((cheek) => distance(points[4], cheek) < 0.06);
  const fingerStates = [8, 12, 16, 20].map((tip) => up(points, tip, tip - 2));
  const fatherPose = fingerStates.every(Boolean);
  const motherPose = fingerStates[0] && fingerStates.slice(1).every((value) => !value);
  const fist = isFistY(points);

  if (state.fatherStage === 0 && fatherPose && thumbAtCheek) { state.fatherStage = 1; state.fatherSince = now; }
  if (state.fatherStage === 1) {
    if (now - state.fatherSince > 3000) { state.fatherStage = 0; state.fatherFistSince = 0; }
    else if (fist) {
      state.fatherFistSince = state.fatherFistSince || now;
      if (now - state.fatherFistSince >= 500) { announce('พ่อ', now); state.fatherStage = 0; state.fatherFistSince = 0; }
    } else state.fatherFistSince = 0;
  }

  if (state.motherStage === 0 && motherPose && thumbAtCheek) { state.motherStage = 1; state.motherSince = now; }
  if (state.motherStage === 1) {
    if (now - state.motherSince > 3000) { state.motherStage = 0; state.motherFistSince = 0; }
    else if (fist) {
      state.motherFistSince = state.motherFistSince || now;
      if (now - state.motherFistSince >= 500) { announce('แม่', now); state.motherStage = 0; state.motherFistSince = 0; }
    } else state.motherFistSince = 0;
  }
  return thumbAtCheek && (fatherPose || motherPose) || state.fatherStage > 0 || state.motherStage > 0;
}

function detectLove(hands, result, face, now, arms) {
  let pose = false;
  if (face && hands.length) {
    const candidates = hands.map((points) => ({ points, ...chestPalm(points, face) })).filter((hand) => hand.pose);
    if (candidates.length === 2) {
      const [a, b] = candidates;
      const palm = (a.palm + b.palm) / 2;
      const interval = (p) => [Math.min(p[0].x, p[12].x), Math.max(p[0].x, p[12].x)];
      const ia = interval(a.points), ib = interval(b.points);
      const overlap = (Math.min(ia[1], ib[1]) - Math.max(ia[0], ib[0])) * (frameCanvas.width / frameCanvas.height);
      pose = a.dx * b.dx < 0 && overlap > palm * .25
        && handMetricDistance(a.points[9], b.points[9]) < palm * 2.1;
    }
    if (!pose && arms?.bothRaised) {
      const [a, b] = arms.wrists;
      const closeWrists = Math.abs(a.x - b.x) < arms.width * 1.25 && Math.abs(a.y - b.y) < arms.height * .65;
      pose = closeWrists && candidates.some(({ points: p }) =>
        (p[12].x - p[0].x) * (p[0].x - arms.center.x) < 0
        && Math.abs(p[12].x - arms.center.x) < Math.abs(face[234].x - face[454].x) * 1.2
        && arms.wrists.some((w) => handMetricDistance(p[0], w) < arms.height * .9));
    }
  }
  if (pose) {
    loveHold.lastValid = now;
    state.loveSince = state.loveSince || now;
    if (!loveHold.latched && now - state.loveSince >= 500 && announce('รัก', now)) loveHold.latched = true;
  } else {
    state.loveSince = 0;
    if (now - loveHold.lastValid > 600) loveHold.latched = false;
  }
  return pose;
}

function detectHelpSOS(hands, now) {
  if (hands.length !== 1) {
    state.sosStage = 0; state.sosSince = 0; state.sosHoldSince = 0;
    if (state.prompt.startsWith('ช่วยฉันด้วย:')) state.prompt = 'กำลังตรวจจับท่าที่รองรับ';
    return false;
  }
  const p = hands[0];
  const straight = (tip, pip, mcp) => distanceFromWrist(p, tip) > distanceFromWrist(p, pip) + 0.01 && distanceFromWrist(p, pip) > distanceFromWrist(p, mcp);
  const folded = (tip, mcp) => distanceFromWrist(p, tip) < distanceFromWrist(p, mcp) + 0.02;
  const fourStraight = [8, 12, 16, 20].every((tip) => straight(tip, tip - 2, tip - 3));
  const fourFolded = [8, 12, 16, 20].every((tip) => folded(tip, tip - 3));
  const fingersClose = distance(p[8], p[12]) < 0.08 && distance(p[12], p[16]) < 0.08 && distance(p[16], p[20]) < 0.08;
  const palmUpright = p[9].y < p[0].y - 0.05;
  const thumbDistance = distance(p[4], p[17]);
  const thumbFolded = thumbDistance < 0.07, thumbExtended = thumbDistance > 0.09;
  const allPinched = [8, 12, 16].every((tip) => distance(p[4], p[tip]) < 0.08) && !fourFolded;

  if (state.sosStage > 0 && now - state.sosSince > 3000) { state.sosStage = 0; state.sosHoldSince = 0; state.prompt = 'กำลังตรวจจับท่าที่รองรับ'; }
  if (state.sosStage === 0) {
    if (thumbExtended && fourStraight && fingersClose && palmUpright) {
      state.sosHoldSince = state.sosHoldSince || now;
      state.prompt = 'ช่วยฉันด้วย: กางมือค้างไว้';
      if (now - state.sosHoldSince >= 500) { state.sosStage = 1; state.sosSince = now; state.sosHoldSince = 0; }
    } else {
      state.sosHoldSince = 0;
      if (state.prompt.startsWith('ช่วยฉันด้วย:')) state.prompt = 'กำลังตรวจจับท่าที่รองรับ';
    }
  } else if (state.sosStage === 1) {
    state.prompt = 'ช่วยฉันด้วย: พับนิ้วโป้ง';
    if (allPinched) { state.sosStage = 0; state.prompt = 'กำลังตรวจจับท่าที่รองรับ'; }
    else if (thumbFolded && fourStraight) { state.sosStage = 2; state.sosSince = now; }
  } else if (state.sosStage === 2) {
    state.prompt = 'ช่วยฉันด้วย: กำมือ';
    if (allPinched) { state.sosStage = 0; state.prompt = 'กำลังตรวจจับท่าที่รองรับ'; }
    else if (thumbFolded && fourFolded) {
      announce('ช่วยฉันด้วย', now);
      state.sosStage = 0; state.sosHoldSince = 0; state.prompt = 'กำลังตรวจจับท่าที่รองรับ';
    }
  }
  return state.sosStage > 0 || state.sosHoldSince > 0;
}

function recognizeSigns(handsResult, faceResult, now, poseResult = null) {
  const hands = handsResult.landmarks || [];
  const face = (faceResult.faceLandmarks || [])[0];
  if (practice.active && practice.awaitNeutral) {
    if (!hands.length) {
      practice.neutralSince ??= now;
      if (now - practice.neutralSince >= 450) {
        practice.awaitNeutral = false; resetRecognitionState();
        window.dispatchEvent(new CustomEvent('practice-ready'));
      }
    } else practice.neutralSince = null;
    return 'เตรียมเริ่มท่าใหม่';
  }
  if (practice.active && practice.matched) return 'ฝึกสำเร็จแล้ว · กดฝึกอีกครั้งหรือเลือกคำถัดไป';

  const arms = chestArms(poseResult?.landmarks?.[0]);
  const helloActive = detectHello(hands, face, now);
  const wellActive = detectWell(helloActive ? [] : hands, face, now);
  const loveActive = !helloActive && !wellActive && detectLove(hands, handsResult, face, now, arms);
  const smileActive = detectSmile(helloActive || wellActive || loveActive ? [] : hands, face, now);
  const bothHandsActive = helloActive || wellActive || loveActive || smileActive;
  const singleHand = !bothHandsActive && hands.length === 1 ? hands[0] : null;
  const faceSignActive = detectFaceSigns(singleHand, face, now);
  const childActive = detectChild(faceSignActive ? null : singleHand, face, now);
  const otherSignActive = bothHandsActive || faceSignActive || childActive;
  if (helloActive || wellActive) { state.loveSince = 0; if (now - loveHold.lastValid > 600) loveHold.latched = false; }
  if (!otherSignActive && hands.length === 1 && face) {
    lastSingleAt = now;
    const points = hands[0];
    const hungryActive = detectHungry(points, face, now);
    if (hungryActive) resetFullState();
    const fullActive = !hungryActive && detectFull(points, face, now);
    if (fullActive) { addedSigns.hungryStage = 0; addedSigns.hungryLatched = false; }
    const heActive = !fullActive && detectHe(points, face, now);
    if (hungryActive || fullActive || heActive) resetSingleHandState();
    else { detectMe(points, face, now, arms); detectParents(points, face, now); }
  } else if (!otherSignActive && arms?.singleRaised && face && hands.length === 2) {
    lastSingleAt = now;
    const points = [...hands].sort((a, b) => handMetricDistance(a[0], arms.singleRaised) - handMetricDistance(b[0], arms.singleRaised))[0];
    detectMe(points, face, now, arms);
  } else if (otherSignActive || hands.length > 1 || now - lastSingleAt > 500) {
    resetSingleHandState(); resetAddedSigns(); resetFullState();
  }
  if (!otherSignActive) { detectAngry(hands, face, now); detectSick(hands, handsResult, face, now); }
  if (faceSignActive) { state.angryStage = 0; state.sickStage = 0; state.sickHoldSince = 0; }

  const sosActive = !otherSignActive && detectHelpSOS(hands, now);
  if (otherSignActive) { state.sosStage = 0; state.sosHoldSince = 0; }

  if (state.lastWord && now - state.lastWordAt < 1500) state.prompt = `ตรวจพบ: ${state.lastWord}`;
  else if (loveActive && !loveHold.latched) state.prompt = 'ท่ารัก: วางสองมือไขว้ที่อกแล้วค้างสักครู่';
  else if (state.meSince && !state.meLatched) state.prompt = `ท่าฉัน: ค้างมือที่อกอีก ${Math.max(0, (ME_HOLD_MS - (now - state.meSince)) / 1000).toFixed(1)} วินาที`;
  else if (helloActive && !helloState.latched) state.prompt = 'ท่าสวัสดี: พนมมือแล้วก้มศีรษะไหว้';
  else if (addedSigns.hungryStage > 0) state.prompt = 'ท่าหิว: งอนิ้วชี้เข้าบริเวณลำคอ';
  else if (addedSigns.heSince && !addedSigns.heLatched && now - addedSigns.heLastValid <= 400) state.prompt = 'ท่าเขา: ยื่นมือออกด้านข้างเล็กน้อย';
  else if (state.sickStage > 0) state.prompt = 'ท่าป่วย: ขยับหลังมือชิดหน้าผากแล้วค้าง';
  else if (hands.length) {
    if (!sosActive) state.prompt = 'พบมือ กำลังตรวจจับท่าที่รองรับ';
  } else state.prompt = 'กำลังตรวจจับท่าที่รองรับ';
  if (practice.active) {
    if (practice.matched) return `ตรวจพบท่า “${practice.word}” แล้ว · ฝึกสำเร็จ`;
    return `กำลังฝึกคำ “${practice.word}”`;
  }
  return state.prompt;
}

const framingPanel = document.getElementById('camera-framing');
const guidance = document.getElementById('camera-guidance');
const holdPanel = document.getElementById('practice-hold');
const holdBar = document.getElementById('practice-hold-bar');
const holdTime = document.getElementById('practice-hold-time');
const initialGuidance = { key: '', level: 'info', message: 'กำลังตรวจใบหน้า มือ และช่วงอก…' };
const framingState = { pending: '', since: 0, shown: initialGuidance };
function chestVisible(pose) {
  if (!pose || !pose[11] || !pose[12]) return false;
  const shoulders = [pose[11], pose[12]];
  if (shoulders.some((p) => (p.visibility ?? 0) < .45 || p.x < .025 || p.x > .975 || p.y < .025 || p.y > .9)) return false;
  const width = Math.abs(shoulders[0].x - shoulders[1].x);
  const chestBottom = Math.max(shoulders[0].y, shoulders[1].y) + width * (frameCanvas.width / frameCanvas.height) * .65;
  return width > .06 && chestBottom < .97;
}
function framingFeedback(handsResult, faceResult, poseResult, now = 0) {
  const hands = handsResult.landmarks || [];
  const faces = faceResult.faceLandmarks || [];
  if (!faces.length && helloState.since && now - helloState.lastValid <= 600) return { key: 'bow', level: 'info', message: 'กำลังติดตามท่าไหว้ · ค่อย ๆ เงยหน้ากลับหลังทำท่า' };
  if (!faces.length) return { key: 'face', level: 'warning', message: 'ไม่พบใบหน้า · หันหน้าเข้ากล้องและจัดแสงให้เห็นใบหน้าชัดเจน' };
  if (!hands.length) return { key: 'hands', level: 'warning', message: 'ไม่พบมือ · ยกมือเข้ามาในภาพให้เห็นทั้งฝ่ามือและปลายนิ้ว' };
  const edge = hands.some((p) => p.some((point) => point.x < .025 || point.x > .975 || point.y < .025 || point.y > .975));
  if (edge) return { key: 'edge', level: 'warning', message: 'มืออยู่ชิดขอบภาพ · ถอยออกเล็กน้อยหรือขยับมือเข้ากลางภาพ' };
  const face = faces[0];
  if (Math.abs(face[234].x - face[454].x) < .1) return { key: 'far', level: 'warning', message: 'ใบหน้าอยู่ไกลกล้อง · ขยับเข้าใกล้ให้เห็นใบหน้าและมือชัดเจน' };
  if (!chestVisible(poseResult?.landmarks?.[0])) return { key: 'body', level: 'info', message: 'ยังไม่เห็นช่วงอกชัดเจน · ถอยออกหรือปรับกล้องให้เห็นไหล่ทั้งสองข้างและลำตัวช่วงอก' };
  return { key: 'ready', level: 'ready', message: 'เห็นใบหน้า มือ และช่วงอกแล้ว · ทำท่าตามคลิปตัวอย่างได้เลย' };
}
function practiceGuidance(feedback, holdingMe) {
  if (practice.matched) return { level: 'ready', message: 'ทำท่าสำเร็จแล้ว · เลือกฝึกอีกครั้งหรือไปคำถัดไปได้เลย' };
  if (practice.awaitNeutral) return { level: 'info', message: 'ลดมือให้พ้นภาพสักครู่ แล้วค่อยเริ่มทำท่า' };
  if (holdingMe) return { level: 'ready', message: 'เริ่มนับแล้ว · ค้างมือที่อกให้นิ่งจนแถบเต็ม' };
  if (practice.word === 'ฉัน' && (feedback.key === 'ready' || feedback.key === 'body' && !poseTask)) {
    return { level: 'info', message: `วางมือขวาที่อก เหยียดนิ้วให้ชิดกัน แล้วค้างไว้ ${ME_HOLD_SECONDS} วินาที` };
  }
  return feedback;
}

function renderCameraGuidance(now) {
  const showHold = practice.active && practice.word === 'ฉัน' && !practice.awaitNeutral;
  const holdMs = practice.matched ? ME_HOLD_MS : state.meSince ? state.meLastValid - state.meSince : 0;
  const holdingMe = showHold && state.meSince > 0 && state.meLastValid === now;
  const feedback = practice.active ? practiceGuidance(framingState.shown, holdingMe) : framingState.shown;
  framingPanel.dataset.level = feedback.level;
  if (guidance.textContent !== feedback.message) guidance.textContent = feedback.message;

  holdPanel.hidden = !showHold;
  holdBar.value = showHold ? holdMs / ME_HOLD_MS : 0;
  if (showHold) {
    const seconds = (Math.floor(holdMs / 100) / 10).toFixed(1);
    const time = `${seconds} / ${ME_HOLD_SECONDS} วินาที`;
    if (holdTime.textContent !== time) holdTime.textContent = time;
  }
}

function updateFramingGuidance(handsResult, faceResult, poseResult, now) {
  framingPanel.hidden = false;
  const faceSeen = Boolean(faceResult.faceLandmarks?.length);
  const handCount = handsResult.landmarks?.length || 0;
  const faceChip = document.getElementById('camera-face-chip');
  const handChip = document.getElementById('camera-hand-chip');
  faceChip.textContent = faceSeen ? '✓ พบใบหน้า' : '○ ยังไม่พบใบหน้า';
  faceChip.dataset.found = String(faceSeen);
  handChip.textContent = handCount ? `✓ พบมือ ${handCount} ข้าง` : '○ ยังไม่พบมือ';
  handChip.dataset.found = String(handCount > 0);
  const chestSeen = chestVisible(poseResult?.landmarks?.[0]);
  const chestChip = document.getElementById('camera-chest-chip');
  chestChip.textContent = chestSeen ? '✓ เห็นช่วงอก' : !poseTask ? '○ ยังไม่ยืนยันช่วงอก' : '○ ยังไม่เห็นช่วงอกชัดเจน';
  chestChip.dataset.found = String(chestSeen);
  const feedback = framingFeedback(handsResult, faceResult, poseResult, now);
  if (feedback.key !== framingState.pending) { framingState.pending = feedback.key; framingState.since = now; }
  // Avoid flashing warnings during a bow or brief tracking loss.
  if (framingState.shown.key !== feedback.key && now - framingState.since >= 550) {
    framingState.shown = feedback;
  }
  renderCameraGuidance(now);
}

async function loadModels() {
  badge.textContent = 'กำลังโหลดตัวตรวจจับ…';
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm');
  const [hand, face, pose] = await Promise.all([
    HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minTrackingConfidence: 0.5 }),
    FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5 }),
    PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: .5, minTrackingConfidence: .5 }).catch(() => null)
  ]);
  handTask = hand; faceTask = face; poseTask = pose;
}

function inferFrame() {
  if (!stream || camera.readyState < 2) { loopId = requestAnimationFrame(inferFrame); return; }
  const now = performance.now();
  if (now - lastInferenceAt > 220 && camera.currentTime !== lastVideoTime) {
    lastInferenceAt = now;
    lastVideoTime = camera.currentTime;
    const sourceWidth = camera.videoWidth || 640, sourceHeight = camera.videoHeight || 480;
    const scale = Math.min(1, 480 / sourceWidth, 480 / sourceHeight);
    const width = Math.max(2, Math.round(sourceWidth * scale / 2) * 2);
    const height = Math.max(2, Math.round(sourceHeight * scale / 2) * 2);
    if (frameCanvas.width !== width || frameCanvas.height !== height) { frameCanvas.width = width; frameCanvas.height = height; }
    frameContext.save(); frameContext.translate(width, 0); frameContext.scale(-1, 1); frameContext.drawImage(camera, 0, 0, width, height); frameContext.restore();
    try {
      const timestamp = Math.round(now);
      const handsResult = handTask.detectForVideo(frameCanvas, timestamp);
      const faceResult = faceTask.detectForVideo(frameCanvas, timestamp);
      if (poseTask && (faceResult.faceLandmarks.length || handsResult.landmarks.length) && now - lastPoseAt >= 440) {
        try { lastPoseResult = poseTask.detectForVideo(frameCanvas, timestamp); }
        catch (_) { lastPoseResult = null; }
        lastPoseAt = now;
      }
      const freshPose = now - lastPoseAt <= 700 ? lastPoseResult : null;
      badge.textContent = recognizeSigns(handsResult, faceResult, now, freshPose);
      updateFramingGuidance(handsResult, faceResult, freshPose, now);
      if (now - state.lastWordAt > 2800) document.getElementById('gesture-live-caption').hidden = true;
    } catch (error) { badge.textContent = 'ประมวลผลกล้องไม่สำเร็จ'; }
  }
  loopId = requestAnimationFrame(inferFrame);
}

async function startCamera() {
  startButton.disabled = true;
  cameraWrap.dataset.cameraState = 'loading';
  framingState.pending = ''; framingState.shown = initialGuidance; framingState.since = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    camera.srcObject = stream;
    await camera.play();
    updateCameraAspectRatio();
    placeholder.hidden = true;
    if (!handTask || !faceTask) await loadModels();
    startButton.hidden = true; stopButton.hidden = false;
    badge.textContent = 'กำลังตรวจจับท่าที่รองรับ';
    cameraWrap.dataset.cameraState = 'ready';
    window.dispatchEvent(new CustomEvent('camera-state-changed', { detail: { state: 'ready' } }));
    lastInferenceAt = 0; lastVideoTime = -1;
    loopId = requestAnimationFrame(inferFrame);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop()); stream = null;
    startButton.disabled = false;
    badge.textContent = 'เปิดกล้องไม่ได้';
    cameraWrap.dataset.cameraState = 'error';
    window.dispatchEvent(new CustomEvent('camera-state-changed', { detail: { state: 'error' } }));
    placeholder.hidden = false;
    placeholder.textContent = error?.name === 'NotAllowedError' ? 'กรุณาอนุญาตใช้กล้องในเบราว์เซอร์' : 'เปิดกล้องหรือโหลดตัวตรวจจับไม่สำเร็จ';
  }
}

function stopCamera() {
  cameraWrap.dataset.cameraState = 'off';
  if (practice.active) { practice.awaitNeutral = true; practice.neutralSince = null; }
  window.dispatchEvent(new CustomEvent('camera-state-changed', { detail: { state: 'off' } }));
  document.getElementById('gesture-live-caption').hidden = true;
  cancelAnimationFrame(loopId);
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  camera.srcObject = null; placeholder.hidden = false; placeholder.textContent = 'แตะ “เปิดกล้อง” เพื่อเริ่มแปล';
  cameraWrap.style.aspectRatio = '4 / 3';
  startButton.hidden = false; startButton.disabled = false; stopButton.hidden = true; badge.textContent = 'ปิดกล้อง';
  resetRecognitionState();
  lastPoseResult = null; lastPoseAt = -Infinity;
  framingPanel.hidden = true;
}

const cameraSetupDialog = document.getElementById('camera-setup-dialog');
startButton.addEventListener('click', () => cameraSetupDialog.showModal());
document.getElementById('camera-setup-cancel').addEventListener('click', () => cameraSetupDialog.close());
document.getElementById('camera-setup-confirm').addEventListener('click', () => {
  cameraSetupDialog.close();
  startCamera();
});
stopButton.addEventListener('click', stopCamera);
camera.addEventListener('loadedmetadata', updateCameraAspectRatio);
window.addEventListener('system-view-changed', (event) => {
  if (event.detail?.systemId !== 'gesture-system' && stream) stopCamera();
});
window.addEventListener('pagehide', stopCamera);
