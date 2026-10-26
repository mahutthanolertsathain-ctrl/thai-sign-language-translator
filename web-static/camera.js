import { FilesetResolver, FaceLandmarker, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0';

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
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
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
function announce(word, now, minimumInterval = 2200) {
  const last = state.cooldown.get(word);
  if (last !== undefined && now - last < minimumInterval) return false;
  state.cooldown.set(word, now);
  state.lastWord = word;
  state.lastWordAt = now;
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
}
function resetSingleHandState() {
  state.meSince = state.meLastValid = 0;
  state.meLatched = false;
  state.fatherStage = state.motherStage = 0;
  state.fatherSince = state.motherSince = 0;
  state.fatherFistSince = state.motherFistSince = 0;
}

function detectMe(points, face, now) {
  const chin = face[152];
  const fingersExtended = [8, 12, 16, 20].every((tip) => distance(points[tip], points[tip - 2]) > 0.02);
  const fingertipsTogether = distance(points[8], points[12]) < 0.08 && distance(points[12], points[16]) < 0.08 && distance(points[16], points[20]) < 0.08;
  const pose = fingersExtended && fingertipsTogether && points[9].y > chin.y + 0.02 && Math.abs(points[0].x - chin.x) < 0.25;
  if (pose) {
    state.meLastValid = now;
    if (!state.meLatched) {
      state.meSince = state.meSince || now;
      if (now - state.meSince >= 1500) {
        announce('ฉัน', now);
        state.meSince = 0;
        state.meLatched = true;
      }
    }
  } else if (!state.meLastValid || now - state.meLastValid > 300) {
    state.meSince = 0;
    state.meLastValid = 0;
    state.meLatched = false;
  }
  const trackingGrace = state.meLastValid > 0 && now - state.meLastValid <= 300;
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

function detectLove(hands, result, face, now) {
  if (hands.length !== 2 || !face) { state.loveSince = 0; return false; }
  const labels = [handLabel(result, 0), handLabel(result, 1)];
  const right = labels.indexOf('Right'), left = labels.indexOf('Left');
  const [first, second] = hands;
  const chinY = face[152].y;
  const onChest = first[0].y > chinY && second[0].y > chinY;
  const wristGap = distance(first[0], second[0]);
  const wristOrder = first[0].x - second[0].x;
  const knuckleOrder = first[9].x - second[9].x;
  const crossedGeometry = wristOrder * knuckleOrder < -0.0005 || wristGap < 0.18;
  const oppositeHandOrientation = (first[4].x - first[20].x) * (second[4].x - second[20].x) < 0;
  const geometryPose = crossedGeometry && oppositeHandOrientation;
  const labeledPose = right >= 0 && left >= 0 && hands[right][0].x < hands[left][0].x &&
    hands[right][4].x > hands[right][20].x && hands[left][4].x < hands[left][20].x;
  const pose = onChest && (geometryPose || labeledPose);
  state.loveSince = pose ? (state.loveSince || now) : 0;
  if (pose && now - state.loveSince >= 500) { announce('รัก', now); state.loveSince = 0; }
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

function recognizeSigns(handsResult, faceResult, now) {
  const hands = handsResult.landmarks || [];
  const face = (faceResult.faceLandmarks || [])[0];

  if (hands.length === 1 && face) {
    const points = hands[0];
    detectMe(points, face, now);
    detectParents(points, face, now);
  } else resetSingleHandState();

  detectAngry(hands, face, now);
  detectSick(hands, handsResult, face, now);

  if (hands.length === 2 && face) detectLove(hands, handsResult, face, now);
  else state.loveSince = 0;

  const sosActive = detectHelpSOS(hands, now);

  if (state.lastWord && now - state.lastWordAt < 1500) state.prompt = `ตรวจพบ: ${state.lastWord}`;
  else if (state.sickStage > 0) state.prompt = 'ท่าป่วย: ขยับหลังมือชิดหน้าผากแล้วค้าง';
  else if (hands.length) {
    if (!sosActive) state.prompt = 'พบมือ กำลังตรวจจับท่าที่รองรับ';
  } else state.prompt = 'กำลังตรวจจับท่าที่รองรับ';
  return state.prompt;
}

async function loadModels() {
  badge.textContent = 'กำลังโหลดตัวตรวจจับ…';
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm');
  const [hand, face] = await Promise.all([
    HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.55, minTrackingConfidence: 0.5 }),
    FaceLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })
  ]);
  handTask = hand; faceTask = face;
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
      badge.textContent = recognizeSigns(handsResult, faceResult, now);
    } catch (error) { badge.textContent = 'ประมวลผลกล้องไม่สำเร็จ'; }
  }
  loopId = requestAnimationFrame(inferFrame);
}

async function startCamera() {
  startButton.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    camera.srcObject = stream;
    await camera.play();
    updateCameraAspectRatio();
    placeholder.hidden = true;
    if (!handTask || !faceTask) await loadModels();
    startButton.hidden = true; stopButton.hidden = false;
    badge.textContent = 'กำลังตรวจจับท่าที่รองรับ';
    lastInferenceAt = 0; lastVideoTime = -1;
    loopId = requestAnimationFrame(inferFrame);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop()); stream = null;
    startButton.disabled = false;
    badge.textContent = 'เปิดกล้องไม่ได้';
    placeholder.hidden = false;
    placeholder.textContent = error?.name === 'NotAllowedError' ? 'กรุณาอนุญาตใช้กล้องในเบราว์เซอร์' : 'เปิดกล้องหรือโหลดตัวตรวจจับไม่สำเร็จ';
  }
}

function stopCamera() {
  cancelAnimationFrame(loopId);
  stream?.getTracks().forEach((track) => track.stop()); stream = null;
  camera.srcObject = null; placeholder.hidden = false; placeholder.textContent = 'แตะ “เปิดกล้อง” เพื่อเริ่มแปล';
  cameraWrap.style.aspectRatio = '4 / 3';
  startButton.hidden = false; startButton.disabled = false; stopButton.hidden = true; badge.textContent = 'ปิดกล้อง';
  resetRecognitionState();
}

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
camera.addEventListener('loadedmetadata', updateCameraAspectRatio);
window.addEventListener('system-view-changed', (event) => {
  if (event.detail?.systemId !== 'gesture-system' && stream) stopCamera();
});
window.addEventListener('pagehide', stopCamera);
