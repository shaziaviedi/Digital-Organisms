// Time as Metamorphosis

/*
- Webcam brightness drives organism growth rate + day/night visuals 
- Cocoons crack/hatch on growth thresholds that update live with light
- Mouse acts as a movable light source; clicks place nectar attractors.
- Butterflies free-fly with flocking
- Adult size reflects real development time (bright/fast → smaller; dark/slow → larger).
*/

// ---------------------------
// CONFIG / CONSTANTS
// ---------------------------
const N = 6;

// growth thresholds in "growth seconds" (not real seconds)
const CRACK_GROWTH = 10;    // growth-sec to crack
const HATCH_GROWTH = 20;    // growth-sec to hatch

// stagger between cocoons in "growth seconds"
const STAGGER_GROWTH = 20;  // stagger starts at 0,20,40,...

// branch arc (placing cocoons)
let ARC_LEFT = 0, ARC_RIGHT = 600;
const ARC_BASE_Y = 265;
const ARC_AMPLITUDE = 60;

// images & scaling
let imgBranch;
let imgCrysalisDefault, imgCrysalisCracked, imgCrysalisOpen;
let imgButterfly;
const SCALE_BRANCH    = 0.293;
const SCALE_COCOON    = 0.15;
const SCALE_BUTTERFLY = 0.08;
const COCOON_LEFT  = 70;
const COCOON_RIGHT = 530;
const COCOON_Y_OFFSETS = [27, 25, 13, 8, 12, 5];

// time
let startSceneSec = 0;
let lastMs = 0;

// organism-time accumulator (integrates growth rate every frame)
let worldGrowth = 0;  // growth seconds since scene start

// environment (webcam/brightness -> day-night, growth rate, visuals)
let cam;
const CAM_W = 64, CAM_H = 48;
let camBrightness = 128;        // raw 0..255
let smoothedBrightness = 128;   // low-pass for stable visuals
const smoothFactor = 0.08;            // smoothing factor
const DAY_THRESH = 110;         // > day, <= night

// growth rate: brightness -> organism-time speed
const MIN_GROWTH = 0.6, MAX_GROWTH = 2.0;  // growth-sec per real second

// expected real development range for size mapping (sec) — widened for more variety
const DEV_REAL_MIN = 6;    // very bright / very fast
const DEV_REAL_MAX = 50;   // very dark / very slow

// adult size range (multiplies SCALE_BUTTERFLY)
const SIZE_MIN = 0.65;     // smaller adult at fast dev
const SIZE_MAX = 1.55;     // larger adult at slow dev
const SIZE_JITTER = 0.12;  // ±12% organic variation
const ECTO_EXP = 1.35;     // >1 emphasizes bigger size for slow development

// sky gradient colors (top/bottom for night ↔ day)
let nightTop, nightBottom, dayTop, dayBottom, dawnTop, dawnBottom, duskTop, duskBottom;

// sun/moon arc
const SUN_ARC_RADIUS = 320;
const SUN_ARC_CX = 300;
const SUN_ARC_CY = 560;  // center below canvas so arc spans left->right above horizon

// attractors
let nectar = [];                 // {x,y,born,life}
const NECTAR_LIFE = 12;          // seconds
const NECTAR_PULL = 0.10;        // pull to nectar
const SUN_PULL    = 0.09;        // pull to mouse "sun"

// butterflies (agents)
let butterflies = [];            // {x,y,vx,vy,angle,size,fatigue}
const MAX_SPEED = 2.2;
const MAX_FORCE = 0.06;

// --- WIDER SPREAD (tuned flocking radii + weights) ---
const SEP_RADIUS   = 42;   // ↑ separation radius (from 28)
const ALIGN_RADIUS = 70;   // slight ↑ to smooth headings
const COH_RADIUS   = 95;   // neighbors considered farther out
const W_SEP  = 2.0;        // ↑ separation weight (push apart)
const W_ALIGN= 0.6;        // alignment steady
const W_COH  = 0.45;       // ↓ cohesion pull (less clumping)

// cocoons (per-cocoon state)
let cocoons = []; // {x, yBase, offsetY, started, startGrowthOffset, localGrowth, realStartSec, cracked, open, spawned}

// visuals
let tick = 0;

// mouse halo size knob
let MOUSE_HALO_SCALE = 0.55;  // 1.0 = larger; smaller = tighter halo

// ---------------------------
// PRELOAD / SETUP
// ---------------------------
function preload() {
  imgBranch           = loadImage('assets/03_branch.png');
  imgCrysalisDefault  = loadImage('assets/03_cocoon.png');
  imgCrysalisCracked  = loadImage('assets/03_cracked.png');
  imgCrysalisOpen     = loadImage('assets/03_shell.png');
  imgButterfly        = loadImage('assets/03_butterfly.png');
}

function setup() {
  createCanvas(600, 600);
  imageMode(CENTER);
  startSceneSec = millis() / 1000;
  lastMs = millis();

  ARC_LEFT = 0; ARC_RIGHT = width;

  // sky palette
  nightTop    = color(10, 20, 45);
  nightBottom = color(18, 35, 70);
  dawnTop     = color(255, 140, 90);
  dawnBottom  = color(255, 200, 130);
  dayTop      = color(120, 190, 255);
  dayBottom   = color(200, 230, 255);
  duskTop     = color(240, 120, 160);
  duskBottom  = color(110, 60, 120);

  // evenly-spaced cocoon x positions
  const xs = Array.from({ length: N }, (_, i) => map(i, 0, N - 1, COCOON_LEFT, COCOON_RIGHT));
  cocoons = xs.map((x, i) => ({
    x,
    yBase: arcY(x),
    offsetY: COCOON_Y_OFFSETS[i] || 0,
    started: false,
    startGrowthOffset: i * STAGGER_GROWTH, // gate by organism-time (growth seconds), not real time
    localGrowth: 0,                        // growth-seconds since this cocoon started
    realStartSec: null,                    // real time when this cocoon started
    cracked: false,
    open: false,
    spawned: false
  }));

  // webcam
  cam = createCapture(VIDEO);
  cam.size(CAM_W, CAM_H);
  cam.hide();
}

// ---------------------------
// DRAW
// ---------------------------
function draw() {
  const nowMs = millis();
  const dt = max(0.001, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  tick++;

  // --- ENVIRONMENT SENSE ---
  updateCameraBrightness();
  smoothedBrightness = lerp(smoothedBrightness, camBrightness, smoothFactor);
  const dayValue = map(constrain(smoothedBrightness, 20, 220), 20, 220, 0, 1); // 0 night -> 1 day
  const growthRate = map(constrain(smoothedBrightness, 20, 220), 20, 220, MIN_GROWTH, MAX_GROWTH);

  // integrate organism-time
  worldGrowth += growthRate * dt;

  // --- SKY / SUN-MOON / HALOS ---
  drawSkyGradient(dayValue);
  drawSunMoonArc(dayValue);
  drawSunMoonHalo(dayValue);  // big halo for the sky body
  drawMouseHalo();            // scalable halo at mouse as alternate light

  // --- BRANCH ---
  drawBranch();

  // --- NECTAR ---
  updateNectar(millis()/1000);
  drawNectar();

  // --- COCOONS (adaptive starts + thresholds) ---
  for (let i = 0; i < cocoons.length; i++) {
    const c = cocoons[i];

    // start when organism-time crosses this cocoon's start offset
    if (!c.started && worldGrowth >= c.startGrowthOffset) {
      c.started = true;
      c.realStartSec = millis() / 1000; // mark real-time start for size mapping
    }

    // accumulate this cocoon's local growth (in growth-seconds)
    if (c.started && !c.open) {
      c.localGrowth += growthRate * dt;
    }

    // thresholds on local growth
    if (c.started && !c.cracked && c.localGrowth >= CRACK_GROWTH) {
      c.cracked = true;
    }
    if (c.started && !c.open && c.localGrowth >= HATCH_GROWTH) {
      c.open = true;
      if (!c.spawned) {
        // compute real development duration for size mapping
        const devRealSec = max(0.001, (millis()/1000) - (c.realStartSec ?? (millis()/1000)));

        // map to [0..1], then shape nonlinearly to accentuate slow-development larger adults
        let norm = constrain((devRealSec - DEV_REAL_MIN) / (DEV_REAL_MAX - DEV_REAL_MIN), 0, 1);
        norm = pow(norm, ECTO_EXP);

        // base size from development time, plus a small per-individual jitter
        const baseSize = lerp(SIZE_MIN, SIZE_MAX, norm);
        const jitter   = random(1 - SIZE_JITTER, 1 + SIZE_JITTER);
        const size     = baseSize * jitter;

        butterflies.push(spawnButterflyAt(c.x, c.yBase + c.offsetY, size));
        c.spawned = true;
      }
    }

    // draw the cocoon with vibration if cracked but not open yet
    const state = (!c.started) ? "default" : (c.open ? "open" : (c.cracked ? "cracked" : "default"));
    drawCocoon(jitterX(c.x, state), jitterY(c.yBase + c.offsetY, state), state);
  }

  // --- BUTTERFLIES UPDATE & DRAW (FREE FLIGHT) ---
  updateButterflies(dt, dayValue);
  drawButterflies();

  // --- DAY/NIGHT OVERLAY & CLOCK ---
  drawDayNightTint();       // subtle wash on top
  drawClock((millis()/1000) - startSceneSec); // absolute scene time
}

// ---------------------------
// SKY / SUN / MOON
// ---------------------------
function drawSkyGradient(dayValue) {
  // blend through four stops: night -> dawn -> day -> dusk
  let topA, bottomA, topB, bottomB, t;
  if (dayValue < 0.33) {
    t = map(dayValue, 0, 0.33, 0, 1);
    topA=nightTop; bottomA=nightBottom; topB=dawnTop; bottomB=dawnBottom;
  } else if (dayValue < 0.66) {
    t = map(dayValue, 0.33, 0.66, 0, 1);
    topA=dawnTop; bottomA=dawnBottom; topB=dayTop; bottomB=dayBottom;
  } else {
    t = map(dayValue, 0.66, 1, 0, 1);
    topA=dayTop; bottomA=dayBottom; topB=duskTop; bottomB=duskBottom;
  }
  const topCol = lerpColor(topA, topB, t);
  const botCol = lerpColor(bottomA, bottomB, t);

  // vertical gradient
  noFill();
  for (let y = 0; y < height; y++) {
    const f = y / (height - 1);
    const c = lerpColor(topCol, botCol, f);
    stroke(c);
    line(0, y, width, y);
  }
}

function drawSunMoonArc(dayValue) {
  // sky body moves along a semicircle based on dayValue (0..1)
  const theta = PI + dayValue * PI;
  const sx = SUN_ARC_CX + SUN_ARC_RADIUS * cos(theta);
  const sy = SUN_ARC_CY + SUN_ARC_RADIUS * sin(theta);

  const showSun = dayValue >= 0.45;
  push();
  noStroke();
  if (showSun) {
    fill(255, 230, 120);
    circle(sx, sy, 24);
  } else {
    fill(220, 230, 255);
    circle(sx, sy, 18);
    // simple crescent mask
    fill(10, 20, 45);
    circle(sx + 5, sy - 2, 16);
  }
  pop();
}

function drawSunMoonHalo(dayValue) {
  // ADD-blend halo around the sky body position
  const theta = PI + dayValue * PI;
  const sx = SUN_ARC_CX + SUN_ARC_RADIUS * cos(theta);
  const sy = SUN_ARC_CY + SUN_ARC_RADIUS * sin(theta);

  const showSun = dayValue >= 0.45;
  const base = showSun ? color(255, 230, 150, 44) : color(120, 160, 255, 50);

  push();
  blendMode(ADD);
  noStroke();
  for (let r = 220; r >= 24; r -= 22) {
    const a = map(r, 24, 220, 90, 10);
    fill(red(base), green(base), blue(base), a);
    circle(sx, sy, r);
  }
  blendMode(BLEND);
  pop();
}

// smaller, scalable ADD-blend halo at the mouse (alternate light source)
function drawMouseHalo() {
  push();
  blendMode(ADD);
  noStroke();

  // gentle pulse
  const t = millis() / 1000;
  const pulse = 1 + 0.06 * sin(t * 2.1);

  // scaled diameters
  const dOuter = 110 * pulse * MOUSE_HALO_SCALE;
  const dMid   = 68  * pulse * MOUSE_HALO_SCALE;
  const dInner = 36  * pulse * MOUSE_HALO_SCALE;

  // modest alphas so it reads but doesn't overwhelm
  const aOuter = 58;
  const aMid   = 42;
  const aInner = 30;

  fill(255, 240, 150, aOuter); circle(mouseX, mouseY, dOuter);
  fill(255, 255, 200, aMid);   circle(mouseX, mouseY, dMid);
  fill(255, 255, 255, aInner); circle(mouseX, mouseY, dInner);

  blendMode(BLEND);
  pop();
}

// stronger top wash indicating day/night mood (on top)
function drawDayNightTint() {
  const isDay = smoothedBrightness > DAY_THRESH;
  push();
  noStroke();
  if (isDay) fill(255, 240, 150, 20);
  else       fill(90, 120, 255, 32);
  rect(0, 0, width, height);
  pop();
}

// ---------------------------
// COCOONS
// ---------------------------
function drawCocoon(x, y, state){
  let img = imgCrysalisDefault;
  if (state === "cracked") img = imgCrysalisCracked;
  if (state === "open")    img = imgCrysalisOpen;

  if (img) {
    image(img, x, y, img.width * SCALE_COCOON, img.height * SCALE_COCOON);
  } else {
    noStroke();
    if (state === "default") fill(180,200,210);
    else if (state === "cracked") fill(250,205,120);
    else fill(200,255,200);
    ellipse(x, y, 46, 76);
  }
}

function jitterX(x, state){ return (state === "cracked") ? x + random(-1.2, 1.2) : x; }
function jitterY(y, state){ return (state === "cracked") ? y + random(-0.8, 0.8) : y; }

// ---------------------------
// BRANCH & ARC
// ---------------------------
function drawBranch(){
  if (imgBranch) {
    push();
    imageMode(CORNER);
    image(imgBranch, 0, -10,
          imgBranch.width  * SCALE_BRANCH,
          imgBranch.height * SCALE_BRANCH);
    pop();
  } else {
    noStroke(); fill(120,80,50);
    rect(0, -10, 600, 50, 9);
  }
}

function arcY(x){
  const u = constrain((x - ARC_LEFT) / (ARC_RIGHT - ARC_LEFT), 0, 1);
  return ARC_BASE_Y + ARC_AMPLITUDE * (1 - Math.cos(TWO_PI * u)) * 0.5;
}

// ---------------------------
// BUTTERFLIES (AGENTS)
// ---------------------------
function spawnButterflyAt(x, y, sizeFactor=1){
  const angle = random(TWO_PI);
  const speed = random(0.6, 1.2);
  return {
    x, y,
    vx: speed * Math.cos(angle),
    vy: speed * Math.sin(angle),
    angle: angle,
    size: sizeFactor,
    fatigue: 0
  };
}

function updateButterflies(dt, dayValue){
  for (let i = 0; i < butterflies.length; i++) {
    const b = butterflies[i];

    // neighborhood forces
    let sep = createVector(0, 0);
    let ali = createVector(0, 0);
    let coh = createVector(0, 0);
    let countAli = 0, countCoh = 0;

    for (let j = 0; j < butterflies.length; j++) {
      if (i === j) continue;
      const o = butterflies[j];
      const dx = o.x - b.x, dy = o.y - b.y;
      const d = Math.hypot(dx, dy);

      // separation
      if (d > 0 && d < SEP_RADIUS) {
        const away = createVector(-dx, -dy);
        away.mult(1 / d);
        sep.add(away);
      }
      // alignment
      if (d < ALIGN_RADIUS) {
        ali.add(createVector(o.vx, o.vy));
        countAli++;
      }
      // cohesion
      if (d < COH_RADIUS) {
        coh.add(createVector(o.x, o.y));
        countCoh++;
      }
    }

    if (countAli > 0) ali.div(countAli);
    if (countCoh > 0) {
      coh.div(countCoh);
      coh.sub(createVector(b.x, b.y)); // toward center of neighbors
    }

    sep.limit(MAX_FORCE);
    ali.limit(MAX_FORCE);
    coh.limit(MAX_FORCE);

    // attractor: strongest = nearest nectar else mouse (sun)
    const attract = getAttractor(b.x, b.y);
    const toAttr = createVector(attract.x - b.x, attract.y - b.y);
    toAttr.setMag(attract.pull);

    // mild drift (air current)
    const drift = createVector(noise(tick*0.003+i)*0.2-0.1, noise(tick*0.004-i)*0.2-0.1);

    // combine accelerations (wider spread via higher separation, lower cohesion)
    const ax = sep.x * W_SEP + ali.x * W_ALIGN + coh.x * W_COH + toAttr.x + drift.x;
    const ay = sep.y * W_SEP + ali.y * W_ALIGN + coh.y * W_COH + toAttr.y + drift.y;

    b.vx += ax; b.vy += ay;

    // limit speed (slightly faster by day)
    const sp = Math.hypot(b.vx, b.vy);
    const maxSp = MAX_SPEED * (0.8 + 0.4*dayValue);
    if (sp > maxSp) { b.vx *= maxSp/sp; b.vy *= maxSp/sp; }

    // integrate
    b.x += b.vx; b.y += b.vy;

    // screen wrap gently
    if (b.x < -20) b.x = width + 20;
    if (b.x > width + 20) b.x = -20;
    if (b.y < -20) b.y = height + 20;
    if (b.y > height + 20) b.y = -20;

    b.angle = Math.atan2(b.vy, b.vx);
  }
}

function drawButterflies(){
  for (const b of butterflies) {
    drawButterflyImg(b.x, b.y, b.angle, b.size);
    drawButterflyGlow(b.x, b.y);
  }
}

function drawButterflyImg(x, y, angle, factor = 1){
  push();
  translate(x, y);
  rotate(angle + radians(150)); // adjust if sprite points differently
  if (imgButterfly) {
    const s = SCALE_BUTTERFLY * factor;
    image(imgButterfly, 0, 0, imgButterfly.width * s, imgButterfly.height * s);
  } else {
    noStroke(); fill(100, 80, 220);
    triangle(0, -10, -8, 8, 8, 8);
  }
  pop();
}

function drawButterflyGlow(x, y){
  const isDay = smoothedBrightness > DAY_THRESH;
  push();
  blendMode(ADD);
  noStroke();
  const base = isDay ? color(255,220,120,28) : color(140,170,255,26);
  fill(base); circle(x, y, 18);
  fill(red(base), green(base), blue(base), 12); circle(x, y, 36);
  blendMode(BLEND);
  pop();
}

// ---------------------------
// NECTAR & ATTRACTORS
// ---------------------------
function mousePressed() {
  nectar.push({ x: mouseX, y: mouseY, born: millis()/1000, life: NECTAR_LIFE });
}

function updateNectar(tNow) {
  nectar = nectar.filter(n => (tNow - n.born) < n.life);
}

function drawNectar(){
  push();
  noStroke();
  for (const n of nectar) {
    const age = (millis()/1000) - n.born;
    const lifeFrac = constrain(1 - age/NECTAR_LIFE, 0, 1);
    const a = 180 * lifeFrac;
    fill(255, 200, 90, a);
    circle(n.x, n.y, 12 + 10*lifeFrac);
    fill(255, 255, 180, 130*lifeFrac);
    circle(n.x, n.y, 5 + 18*lifeFrac);
  }
  pop();
}

function getAttractor(x, y) {
  if (nectar.length > 0) {
    let best = null, bestD = 1e9;
    for (const n of nectar) {
      const d2 = (x - n.x)*(x - n.x) + (y - n.y)*(y - n.y);
      if (d2 < bestD) { bestD = d2; best = n; }
    }
    return { x: best.x, y: best.y, pull: NECTAR_PULL };
  }
  // mouse = sun
  return { x: mouseX, y: mouseY, pull: SUN_PULL };
}

// ---------------------------
// CAMERA / BRIGHTNESS
// ---------------------------
function updateCameraBrightness() {
  if (!cam) return;
  cam.loadPixels();
  if (!cam.pixels || cam.pixels.length === 0) return;

  let sum = 0, count = 0;
  for (let y = 0; y < CAM_H; y += 2) {
    for (let x = 0; x < CAM_W; x += 2) {
      const idx = 4 * (x + y * CAM_W);
      const r = cam.pixels[idx], g = cam.pixels[idx+1], b = cam.pixels[idx+2];
      sum += 0.2126*r + 0.7152*g + 0.0722*b; // luma
      count++;
    }
  }
  if (count > 0) camBrightness = sum / count;
}

// ---------------------------
// MISC UI
// ---------------------------
function drawClock(t){
  const mm = floor(t / 60);
  const ss = floor(t % 60);
  const label = nf(mm, 2) + ":" + nf(ss, 2);
  push();
  fill(30); noStroke();
  textAlign(RIGHT, BOTTOM);
  textSize(16);
  text(label, width - 12, height - 10);
  pop();
}
