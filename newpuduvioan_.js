let posePlayer;
let headImg; // Head image

const fps = 30;
const poseWidth = 640;
const poseHeight = 480;

// Skeleton edges
const skeletonEdges = [
  [5, 7], [7, 9], [6, 8], [8, 10],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [5, 6], [11, 12], [5, 11], [6, 12]
];

function preload() {
  posePlayer = new PosePlayer('bncbc.mp4', 'contra-poseestimationrrstageone.json');
  headImg = loadImage('head.png'); // Load head image
}

function setup() {
  createCanvas(1280, 720);
  frameRate(fps);
  posePlayer.setup();
}

function draw() {
  background(0);
  posePlayer.update();
  posePlayer.display();
}

function keyPressed() {
  posePlayer.handleKey(key.toUpperCase());
}

// ---------------- PosePlayer Class ----------------
class PosePlayer {
  constructor(videoFile, poseJSONFile) {
    this.videoFile = videoFile;
    this.poseJSONFile = poseJSONFile;

    this.poseMap = {};
    this.video = null;
    this.poseTime = 0;
    this.playing = false;
    this.showPose = true;
    this.playbackRate = 1;

    this.scaleCycle = [1, 0.75, 0.5, 0.25];
    this.scaleIndex = 0;
    this.scaleFactor = 1;

    this.pointSizeCycle = [6, 12, 18, 24, 36];
    this.pointSizeIndex = 1;
    this.pointSize = this.pointSizeCycle[this.pointSizeIndex];
    this.headSize = 150; // size of head image

    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.speedInput = null;
    this.isLoaded = false;

    // transparency controls (from previous step)
    this.alpha = 120; // 0..255
    this.alphaSlider = null;

    this._lastVideoW = null;
    this._lastVideoH = null;

    // ===== NEW: Trails (loci) =====
    // trails[personIndex][keypointIndex] = [{x,y}, ...] stored in *video coordinate space* (0..poseWidth/poseHeight)
    this.trails = {};
    this.showTrails = true;
    this.maxTrailLen = 240; // ~8 seconds at 30 fps
    this.trailAlpha = 160;  // opacity of curves
    this.trailWeight = 3;   // stroke weight (base; scales with zoom)
    this.trailColors = [
      [0, 200, 255],
      [255, 80, 0],
      [0, 255, 120],
      [255, 200, 0],
      [180, 120, 255],
      [255, 0, 180]
    ];
  }

  setup() {
    this.loadJSONData();
    this.loadVideo();
    this.setupControls();
  }

  loadJSONData() {
    loadJSON(this.poseJSONFile, data => {
      this.preparePoseMap(data);
      this.checkIfLoaded();
    }, err => console.error("Failed to load JSON:", err));
  }

  loadVideo() {
    this.video = createVideo([this.videoFile], () => {
      this.video.hide();
      this.video.volume(0);
      this.video.elt.muted = true;
      this.video.speed(this.playbackRate);
      this.checkIfLoaded();
    }, err => console.error("Failed to load video:", err));
  }

  checkIfLoaded() {
    if (this.video && Object.keys(this.poseMap).length > 0) {
      this.isLoaded = true;
      this.play();
    }
  }

  preparePoseMap(data) {
    const entries = Array.isArray(data) ? data : Object.values(data);
    entries.forEach(entry => {
      const frameId = Number(entry.frame_id);
      if (!this.poseMap[frameId]) this.poseMap[frameId] = [];
      this.poseMap[frameId].push(entry.keypoints);
    });
  }

  update() {
    if (!this.isLoaded || !this.playing) return;

    this.poseTime += (deltaTime / 1000) * this.playbackRate;

    if (this.video && this.video.elt.readyState >= 2) {
      const dur = this.video.elt.duration || Infinity;
      if (this.poseTime >= dur) {
        this.poseTime = dur;
        this.stop();
      } else if (abs(this.video.time() - this.poseTime) > 0.1) {
        this.video.time(this.poseTime);
      }
    }

    const lastFrameNum = Math.max(...Object.keys(this.poseMap).map(Number));
    const lastTime = lastFrameNum / fps;
    if (this.poseTime >= lastTime) this.stop();

    // ===== NEW: push current positions into trails =====
    this._updateTrails();
  }

  display() {
    if (!this.isLoaded) {
      this.showLoading();
      return;
    }

    const videoAspect = poseWidth / poseHeight;
    const targetHeight = height;
    const targetWidth = targetHeight * videoAspect;

    this._lastVideoW = targetWidth;
    this._lastVideoH = targetHeight;

    if (this.video && this.video.elt.readyState >= 2) {
      image(this.video, 0, 0, targetWidth, targetHeight);
    }

    // Draw trails *under* the points/skeleton so tracks sit behind the markers
    if (this.showTrails) {
      this._drawTrails(targetWidth, targetHeight);
    }

    if (this.showPose) {
      this.drawPoseOverlayToCanvas(targetWidth, targetHeight);
    }
  }

  showLoading() {
    push();
    textSize(36);
    fill(255);
    textAlign(CENTER, CENTER);
    text('Loading...', width / 2, height / 2);
    pop();
  }

  drawPoseOverlayToCanvas(videoW, videoH) {
    this._drawPoseOverlay(drawingContext, videoW, videoH);
  }

  _drawPoseOverlay(ctx, videoW, videoH) {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];

    push();
    translate(this.offsetX, this.offsetY);
    scale(this.scaleFactor);

    const scaleX = videoW / poseWidth;
    const scaleY = videoH / poseHeight;

    const edgeAlpha = this.alpha;
    const pointAlpha = this.alpha;
    const labelAlpha = max(90, this.alpha - 30);

    persons.forEach(kpts => {
      // Skeleton
      skeletonEdges.forEach(([i, j]) => {
        const a = kpts[i], b = kpts[j];
        if (a && b) {
          stroke(255, 255, 0, edgeAlpha);
          strokeWeight(max(3, 4 / this.scaleFactor));
          line(a[0] * scaleX, a[1] * scaleY, b[0] * scaleX, b[1] * scaleY);
        }
      });

      // Keypoints + labels
      noStroke();
      fill(255, 0, 0, pointAlpha);
      kpts.forEach((p, idx) => {
        if (!p) return;
        const x = p[0] * scaleX;
        const y = p[1] * scaleY;
        ellipse(x, y, this.pointSize);

        fill(255, 255, 255, labelAlpha);
        textAlign(CENTER, CENTER);
        textSize(max(10, 14 / this.scaleFactor));
        text(idx.toString(), x, y - this.pointSize);

        if (idx === 0 && headImg) {
          push();
          tint(255, this.alpha);
          imageMode(CENTER);
          const scaledHeadSize = this.headSize * this.scaleFactor;
          image(headImg, x, y - scaledHeadSize / 2, scaledHeadSize, scaledHeadSize);
          pop();
        }
      });
    });

    pop();
  }

  // ===== NEW: record trails (in video coords) =====
  _updateTrails() {
    const frameIndex = floor(this.poseTime * fps);
    const persons = this.poseMap[frameIndex] || [];

    // ensure trails structure has arrays for current number of persons
    for (let pi = 0; pi < persons.length; pi++) {
      if (!this.trails[pi]) this.trails[pi] = {};
      const kpts = persons[pi];
      for (let ki = 0; ki < kpts.length; ki++) {
        if (!this.trails[pi][ki]) this.trails[pi][ki] = [];
        const p = kpts[ki];
        if (p) {
          // store *video space* position so scaling/panning later works cleanly
          this.trails[pi][ki].push({ x: p[0], y: p[1] });
          if (this.trails[pi][ki].length > this.maxTrailLen) {
            this.trails[pi][ki].shift();
          }
        }
      }
    }

    // optional: if person count shrinks, keep existing trails (they'll fade by length cap)
  }

  // ===== NEW: draw smooth locus curves =====
  _drawTrails(videoW, videoH) {
    push();
    translate(this.offsetX, this.offsetY);
    scale(this.scaleFactor);

    const scaleX = videoW / poseWidth;
    const scaleY = videoH / poseHeight;

    const baseW = max(1.5, this.trailWeight / this.scaleFactor);

    Object.keys(this.trails).forEach(piStr => {
      const pi = Number(piStr);
      const [r, g, b] = this.trailColors[pi % this.trailColors.length];

      Object.keys(this.trails[pi]).forEach(kiStr => {
        const pts = this.trails[pi][kiStr];
        if (!pts || pts.length < 2) return;

        // Fade along the trail: newer segments more opaque
        // We'll draw as multiple small curve strips to get a gradient effect
        // (cheap & pretty)
        const segs = pts.length - 1;
        for (let s = 1; s < pts.length; s++) {
          const t = s / pts.length; // 0..1
          const a = lerp(40, this.trailAlpha, t); // fade head->tail
          stroke(r, g, b, a);
          strokeWeight(baseW);
          noFill();

          // small curve chunk using local neighborhood (Catmull-Rom)
          beginShape();
          const p0 = pts[max(0, s - 2)];
          const p1 = pts[s - 1];
          const p2 = pts[s];
          const p3 = pts[min(pts.length - 1, s + 1)];

          // curveVertex needs at least 4 points; repeat ends
          curveVertex(p0.x * scaleX, p0.y * scaleY);
          curveVertex(p1.x * scaleX, p1.y * scaleY);
          curveVertex(p2.x * scaleX, p2.y * scaleY);
          curveVertex(p3.x * scaleX, p3.y * scaleY);
          endShape();
        }
      });
    });

    pop();
  }

  // --------- Controls ----------
  setupControls() {
    const yBase = height - 60;
    createButton('Play').position(20, yBase).mousePressed(() => this.play());
    createButton('Pause').position(100, yBase).mousePressed(() => this.pause());
    createButton('Stop').position(180, yBase).mousePressed(() => this.stop());
    createButton('Scale').position(260, yBase).mousePressed(() => this.cycleScale());
    createSpan(' Speed:').position(340, yBase + 5);
    this.speedInput = createInput('1.0').position(400, yBase).size(50);
    this.speedInput.input(() => this.setSpeed());

    createSpan('  Alpha:').position(470, yBase + 5);
    this.alphaSlider = createSlider(0, 255, this.alpha, 1).position(530, yBase).size(100);
    this.alphaSlider.input(() => { this.alpha = this.alphaSlider.value(); });

    // NEW: Trail controls
    createButton('Toggle Trails').position(640, yBase).mousePressed(() => this.showTrails = !this.showTrails);
    createButton('Clear Trails').position(750, yBase).mousePressed(() => this.clearTrails());

    createSpan(' Len:').position(860, yBase + 5);
    this.lenSlider = createSlider(10, 1200, this.maxTrailLen, 1).position(900, yBase).size(120);
    this.lenSlider.input(() => { this.maxTrailLen = this.lenSlider.value(); });

    createSpan(' Thick:').position(1030, yBase + 5);
    this.wSlider = createSlider(1, 10, this.trailWeight, 0.5).position(1080, yBase).size(80);
    this.wSlider.input(() => { this.trailWeight = this.wSlider.value(); });
  }

  clearTrails() {
    this.trails = {};
  }

  cycleScale() {
    this.scaleIndex = (this.scaleIndex + 1) % this.scaleCycle.length;
    this.scaleFactor = this.scaleCycle[this.scaleIndex];
    this.pointSizeIndex = (this.pointSizeIndex + 1) % this.pointSizeCycle.length;
    this.pointSize = this.pointSizeCycle[this.pointSizeIndex];
  }

  setSpeed() {
    const val = parseFloat(this.speedInput.value());
    this.playbackRate = isNaN(val) ? 1 : val;
    if (this.video) this.video.speed(this.playbackRate);
  }

  play() {
    this.playing = true;
    if (this.video && this.video.elt.readyState >= 2) {
      this.video.play();
      this.video.speed(this.playbackRate);
    }
  }

  pause() {
    this.playing = false;
    if (this.video) this.video.pause();
  }

  stop() {
    this.playing = false;
    this.poseTime = 0;
    if (this.video) {
      this.video.pause();
      this.video.time(0);
    }
    // keep trails so you can see full locus; use "Clear Trails" if you want to reset
  }

  handleKey(k) {
    if (k === 'T') this.showPose = !this.showPose;
    if (k === 'P') this.playing ? this.pause() : this.play();
  }

  mousePressed() {
    if (this.showPose || this.showTrails) {
      this.isDragging = true;
      this.dragStartX = mouseX - this.offsetX;
      this.dragStartY = mouseY - this.offsetY;
    }
  }

  mouseDragged() {
    if (this.isDragging) {
      this.offsetX = mouseX - this.dragStartX;
      this.offsetY = mouseY - this.dragStartY;
    }
  }

  mouseReleased() {
    this.isDragging = false;
  }
}

// Global mouse events
function mousePressed() { posePlayer.mousePressed(); }
function mouseDragged() { posePlayer.mouseDragged(); }
function mouseReleased() { posePlayer.mouseReleased(); }
