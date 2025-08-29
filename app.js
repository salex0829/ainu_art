// Web Spatial Audio Starter
// Features: HRTF (PannerNode), DeviceOrientation head-tracking, Geolocation, Stillness trigger, Map (Leaflet)
const UI = {
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  gps: document.getElementById('gps'),
  still: document.getElementById('still'),
  activePoint: document.getElementById('activePoint'),
  chkMap: document.getElementById('chkMap'),
  mapSection: document.getElementById('mapSection'),
};

// ---- Config ----
const STILL_WINDOW_MS = 800;     // 「静止」判定に必要な連続時間
const STILL_THRESH = 0.015;      // 加速度分散のしきい値（小さいほど厳しい）
const UPDATE_MS = 200;           // 再生/停止や距離判定の更新間隔
const LOAD_RADIUS_M = 120;       // この距離内の音源のみロード
const FADE_SEC = 0.8;            // フェード時間
const USE_MAP = true;            // Mapの既定表示（UIトグルで変更）

let audioCtx;
let listener;
let running = false;
let headTrackingEnabled = false;
let baseLat = null, baseLon = null;
let map, markers = {};
let points = [];
const sources = new Map(); // id -> { buffer, node, panner, gain, gainNode, playing, loaded }

// ---- Utils ----
const toRad = d => d * Math.PI / 180;
function llToMeters(lat0, lon0, lat, lon) {
  const R = 6378137;
  const dLat = toRad(lat - lat0);
  const dLon = toRad(lon - lon0);
  const x = R * dLon * Math.cos(toRad(lat0));
  const z = -R * dLat;
  return { x, z };
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6378137;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- Audio ----
async function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  listener = audioCtx.listener;
  // default listener up/forward
  listener.forwardX?.setValueAtTime(0, audioCtx.currentTime);
  listener.forwardY?.setValueAtTime(0, audioCtx.currentTime);
  listener.forwardZ?.setValueAtTime(-1, audioCtx.currentTime);
  listener.upX?.setValueAtTime(0, audioCtx.currentTime);
  listener.upY?.setValueAtTime(1, audioCtx.currentTime);
  listener.upZ?.setValueAtTime(0, audioCtx.currentTime);
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Failed to load ' + url);
  return await r.json();
}

async function loadBuffer(url) {
  const arr = await fetch(url).then(r => r.arrayBuffer());
  return await audioCtx.decodeAudioData(arr);
}

function makePanner() {
  return new PannerNode(audioCtx, {
    panningModel: 'HRTF',
    distanceModel: 'inverse',
    refDistance: 2,
    maxDistance: 300,
    rolloffFactor: 1.1,
    coneInnerAngle: 360,
    coneOuterAngle: 0
  });
}

function setListenerPos(x, y, z) {
  listener.positionX?.setValueAtTime(x, audioCtx.currentTime);
  listener.positionY?.setValueAtTime(y, audioCtx.currentTime);
  listener.positionZ?.setValueAtTime(z, audioCtx.currentTime);
}

function fadeTo(gainNode, target, sec=FADE_SEC) {
  const t = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(t);
  gainNode.gain.setValueAtTime(gainNode.gain.value, t);
  gainNode.gain.linearRampToValueAtTime(target, t + sec);
}

// ---- Head tracking ----
async function enableHeadTracking() {
  try {
    if (window.DeviceMotionEvent?.requestPermission) {
      await DeviceMotionEvent.requestPermission();
    }
    if (window.DeviceOrientationEvent?.requestPermission) {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch (e) {
    console.warn('Motion permission:', e);
  }
  window.addEventListener('deviceorientation', e => {
    // yawのみ反映（簡易）
    const yaw = (e.alpha || 0) * Math.PI / 180;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    listener.forwardX?.setValueAtTime(fx, audioCtx.currentTime);
    listener.forwardY?.setValueAtTime(0,  audioCtx.currentTime);
    listener.forwardZ?.setValueAtTime(fz, audioCtx.currentTime);
    listener.upX?.setValueAtTime(0, audioCtx.currentTime);
    listener.upY?.setValueAtTime(1, audioCtx.currentTime);
    listener.upZ?.setValueAtTime(0, audioCtx.currentTime);
  }, true);
  headTrackingEnabled = true;
}

// ---- Stillness detection ----
const accelBuf = [];
let lastStill = false;
function pushAccel(a) {
  const now = performance.now();
  accelBuf.push({ t: now, a });
  // keep window
  while (accelBuf.length && now - accelBuf[0].t > STILL_WINDOW_MS) accelBuf.shift();

  if (accelBuf.length < 4) return false;
  const mean = accelBuf.reduce((s, o) => s + o.a, 0) / accelBuf.length;
  const variance = accelBuf.reduce((s, o) => s + (o.a - mean) ** 2, 0) / accelBuf.length;
  const still = variance < STILL_THRESH;
  lastStill = still;
  document.getElementById('still').textContent = still ? 'YES' : 'NO';
  return still;
}

function setupAccel() {
  window.addEventListener('devicemotion', (e) => {
    const ax = e.accelerationIncludingGravity?.x || 0;
    const ay = e.accelerationIncludingGravity?.y || 0;
    const az = e.accelerationIncludingGravity?.z || 0;
    const mag = Math.sqrt(ax*ax + ay*ay + az*az)/9.80665; // normalize to g
    pushAccel(mag);
  }, true);
}

// ---- Geolocation ----
let currentLat = null, currentLon = null, currentX = 0, currentZ = 0;
function setupGPS() {
  if (!navigator.geolocation) {
    document.getElementById('gps').textContent = 'Geolocation not supported';
    return;
  }
  navigator.geolocation.watchPosition(pos => {
    currentLat = pos.coords.latitude;
    currentLon = pos.coords.longitude;
    if (baseLat === null) { baseLat = currentLat; baseLon = currentLon; }
    const { x, z } = llToMeters(baseLat, baseLon, currentLat, currentLon);
    currentX = x; currentZ = z;
    setListenerPos(currentX, 1.6, currentZ);
    document.getElementById('gps').textContent = `${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}`;
    if (map) map.setView([currentLat, currentLon], map.getZoom());
  }, err => {
    document.getElementById('gps').textContent = 'GPS error: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

// ---- Points & playback ----
async function initPoints() {
  points = await fetchJSON('data/points.json');
  if (USE_MAP) initMap();
  points.forEach(p => {
    if (map) {
      const m = L.circle([p.lat, p.lon], { radius: p.radius_m, color: '#66aaff' }).addTo(map)
        .bindPopup(`${p.name} (r=${p.radius_m}m)`);
      markers[p.id] = m;
    }
  });
}

async function ensurePointLoaded(p) {
  if (sources.has(p.id)) return;
  const buffer = await loadBuffer(p.audio);
  const src = new AudioBufferSourceNode(audioCtx, { buffer, loop: true });
  const panner = makePanner();
  const gainNode = new GainNode(audioCtx, { gain: 0 });
  const { x, z } = llToMeters(baseLat ?? p.lat, baseLon ?? p.lon, p.lat, p.lon);
  panner.positionX.value = x;
  panner.positionY.value = p.y ?? 1.6;
  panner.positionZ.value = z;
  src.connect(panner).connect(gainNode).connect(audioCtx.destination);
  src.start();
  sources.set(p.id, { buffer, node: src, panner, gainNode, playing: false, loaded: true, targetGain: (p.gain ?? 1) });
}

function withinRadius(p) {
  if (currentLat === null) return false;
  const d = distanceMeters(currentLat, currentLon, p.lat, p.lon);
  return d <= p.radius_m;
}

function updatePlayback() {
  if (!running || points.length === 0) return;
  // Load sources in proximity
  for (const p of points) {
    const d = (currentLat && currentLon) ? distanceMeters(currentLat, currentLon, p.lat, p.lon) : Infinity;
    if (d < LOAD_RADIUS_M) ensurePointLoaded(p).catch(console.warn);
  }
  // Play/pause based on stillness & radius
  let active = '—';
  for (const p of points) {
    const src = sources.get(p.id);
    if (!src) continue;
    const on = lastStill && withinRadius(p);
    if (on && !src.playing) {
      fadeTo(src.gainNode, src.targetGain);
      src.playing = true;
      active = p.name;
    } else if (!on && src.playing) {
      fadeTo(src.gainNode, 0.0);
      src.playing = false;
    } else if (on && src.playing) {
      active = p.name;
    }
  }
  document.getElementById('activePoint').textContent = active;
}

let updater = null;
function startLoop() {
  if (updater) clearInterval(updater);
  updater = setInterval(updatePlayback, UPDATE_MS);
}

// ---- Map ----
function initMap() {
  map = L.map('map', { zoomControl: true });
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  });
  osm.addTo(map);
  map.setView([43.451, 144.081], 17); // placeholder
}

// ---- UI wiring ----
document.getElementById('chkMap').addEventListener('change', () => {
  document.getElementById('mapSection').style.display = document.getElementById('chkMap').checked ? '' : 'none';
});

document.getElementById('btnStart').addEventListener('click', async () => {
  await ensureAudio();
  await audioCtx.resume();
  if (!headTrackingEnabled) await enableHeadTracking();
  setupAccel();
  setupGPS();
  await initPoints();
  running = true;
  startLoop();
});

document.getElementById('btnPause').addEventListener('click', async () => {
  running = false;
  if (audioCtx?.state === 'running') await audioCtx.suspend();
});

// Init visibility
document.getElementById('mapSection').style.display = (USE_MAP && document.getElementById('chkMap').checked) ? '' : 'none';
