(() => {
  'use strict';

  // --- Constants ---
  const TOTAL_KEYS = 88;
  const FIRST_MIDI_NOTE = 21; // A0
  const LAST_MIDI_NOTE = 108; // C8
  const SCROLL_SPEED = 200; // pixels per second
  const NOTE_COLOR_BASE = [79, 195, 247]; // light blue RGB

  // --- Audio: Tone.js Piano Sampler ---
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiNoteToName(noteNumber) {
    const octave = Math.floor(noteNumber / 12) - 1;
    const name = NOTE_NAMES[noteNumber % 12];
    return name + octave;
  }

  // Reduce latency for real-time MIDI input
  Tone.context.lookAhead = 0;

  // --- Gain Nodes ---
  const pianoGain = new Tone.Gain(0.8).toDestination();
  const metronomeGain = new Tone.Gain(0.3).toDestination();

  let samplerReady = false;
  const sampler = new Tone.Sampler({
    urls: {
      A0: 'A0.mp3',
      C1: 'C1.mp3',
      'D#1': 'Ds1.mp3',
      'F#1': 'Fs1.mp3',
      A1: 'A1.mp3',
      C2: 'C2.mp3',
      'D#2': 'Ds2.mp3',
      'F#2': 'Fs2.mp3',
      A2: 'A2.mp3',
      C3: 'C3.mp3',
      'D#3': 'Ds3.mp3',
      'F#3': 'Fs3.mp3',
      A3: 'A3.mp3',
      C4: 'C4.mp3',
      'D#4': 'Ds4.mp3',
      'F#4': 'Fs4.mp3',
      A4: 'A4.mp3',
      C5: 'C5.mp3',
      'D#5': 'Ds5.mp3',
      'F#5': 'Fs5.mp3',
      A5: 'A5.mp3',
      C6: 'C6.mp3',
      'D#6': 'Ds6.mp3',
      'F#6': 'Fs6.mp3',
      A6: 'A6.mp3',
      C7: 'C7.mp3',
      'D#7': 'Ds7.mp3',
      'F#7': 'Fs7.mp3',
      A7: 'A7.mp3',
      C8: 'C8.mp3',
    },
    release: 1,
    baseUrl: 'https://tonejs.github.io/audio/salamander/',
    onload: () => {
      samplerReady = true;
      console.log('Piano samples loaded');
      const loadingEl = document.getElementById('sample-loading');
      if (loadingEl) loadingEl.remove();
    },
  }).connect(pianoGain);

  function noteOn(noteNumber, velocity) {
    if (!samplerReady) return;
    // Ensure Tone.js AudioContext is running (user interaction policy)
    if (Tone.context.state !== 'running') {
      Tone.context.resume();
    }
    const noteName = midiNoteToName(noteNumber);
    const vel = velocity / 127;
    sampler.triggerAttack(noteName, Tone.now(), vel);
  }

  function noteOff(noteNumber) {
    if (!samplerReady) return;
    const noteName = midiNoteToName(noteNumber);
    sampler.triggerRelease(noteName, Tone.now());
  }

  // --- State ---
  let activeNotes = {}; // noteNumber -> { velocity, startTime }
  let fallingNotes = []; // { noteNumber, velocity, startTime, endTime }
  let midiAccess = null;
  let currentInput = null;

  // --- Recording & Replay State ---
  let isRecording = false;
  let recordStartTime = 0;
  let recordedEvents = []; // { type, note, velocity, time }

  let isPlaying = false;
  let replayTimeouts = []; // setTimeout IDs for cleanup

  // --- DOM refs ---
  const statusEl = document.getElementById('midi-status');
  const deviceSelect = document.getElementById('device-select');
  const pianoEl = document.getElementById('piano');
  const canvas = document.getElementById('waterfall');
  const ctx = canvas.getContext('2d');

  // --- Piano keyboard build ---
  // Note pattern in an octave: C C# D D# E F F# G G# A A# B
  // Black key indices in octave: 1, 3, 6, 8, 10
  const BLACK_IN_OCTAVE = new Set([1, 3, 6, 8, 10]);

  function isBlackKey(midiNote) {
    return BLACK_IN_OCTAVE.has(midiNote % 12);
  }

  function buildPiano() {
    const whiteKeys = [];
    const blackKeys = [];

    for (let note = FIRST_MIDI_NOTE; note <= LAST_MIDI_NOTE; note++) {
      const el = document.createElement('div');
      el.dataset.note = note;

      if (isBlackKey(note)) {
        el.className = 'key black';
        blackKeys.push({ note, el });
      } else {
        el.className = 'key white';
        whiteKeys.push({ note, el });
        pianoEl.appendChild(el);
      }
    }

    // Position black keys relative to white keys
    const totalWhite = whiteKeys.length;
    const whiteWidth = 100 / totalWhite; // percentage

    // Build a map: midiNote -> whiteIndex for white keys
    const whiteIndexMap = {};
    whiteKeys.forEach((wk, i) => {
      whiteIndexMap[wk.note] = i;
    });

    blackKeys.forEach(({ note, el }) => {
      // Find the white key just before this black key
      let prevWhite = note - 1;
      while (prevWhite >= FIRST_MIDI_NOTE && isBlackKey(prevWhite)) prevWhite--;
      const wIndex = whiteIndexMap[prevWhite];
      if (wIndex === undefined) return;

      const leftPercent = (wIndex + 1) * whiteWidth - whiteWidth * 0.3;
      el.style.left = leftPercent + '%';
      el.style.width = whiteWidth * 0.6 + '%';
      pianoEl.appendChild(el);
    });
  }

  function highlightKey(noteNumber, velocity) {
    const el = pianoEl.querySelector(`[data-note="${noteNumber}"]`);
    if (!el) return;
    const alpha = 0.4 + 0.6 * (velocity / 127);
    const [r, g, b] = NOTE_COLOR_BASE;
    el.style.setProperty('--highlight', `rgba(${r},${g},${b},${alpha})`);
    el.classList.add('active');
  }

  function unhighlightKey(noteNumber) {
    const el = pianoEl.querySelector(`[data-note="${noteNumber}"]`);
    if (!el) return;
    el.classList.remove('active');
  }

  // --- Note geometry helpers for canvas (DOM-based) ---
  // Cache for key rects, invalidated on resize
  let keyRectCache = {};

  function getKeyRect(noteNumber) {
    if (keyRectCache[noteNumber]) return keyRectCache[noteNumber];
    const el = pianoEl.querySelector(`[data-note="${noteNumber}"]`);
    if (!el) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const keyRect = el.getBoundingClientRect();
    const result = {
      x: keyRect.left - canvasRect.left,
      width: keyRect.width,
    };
    keyRectCache[noteNumber] = result;
    return result;
  }

  function invalidateKeyRectCache() {
    keyRectCache = {};
  }

  function getNoteX(noteNumber) {
    const rect = getKeyRect(noteNumber);
    return rect ? rect.x : 0;
  }

  function getNoteWidth(noteNumber) {
    const rect = getKeyRect(noteNumber);
    return rect ? rect.width : 10;
  }

  // --- Waterfall rendering ---
  function resizeCanvas() {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    invalidateKeyRectCache();
  }

  function render(now) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Draw grid lines aligned with white keys using DOM rects
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let n = FIRST_MIDI_NOTE; n <= LAST_MIDI_NOTE; n++) {
      if (isBlackKey(n)) continue;
      const rect = getKeyRect(n);
      if (!rect) continue;
      ctx.beginPath();
      ctx.moveTo(rect.x, 0);
      ctx.lineTo(rect.x, h);
      ctx.stroke();
    }

    const allNotes = [
      ...fallingNotes.map(n => ({ ...n, active: false })),
      ...Object.entries(activeNotes).map(([num, info]) => ({
        noteNumber: parseInt(num),
        velocity: info.velocity,
        startTime: info.startTime,
        endTime: now,
        active: true,
      })),
    ];

    for (const note of allNotes) {
      const duration = (note.endTime - note.startTime) / 1000;
      const noteHeight = duration * SCROLL_SPEED;

      // bottom of note = h (piano line) for active notes
      // For finished notes: bottom scrolls upward over time
      const timeSinceEnd = (now - note.endTime) / 1000;
      const bottom = h - timeSinceEnd * SCROLL_SPEED;
      const top = bottom - noteHeight;

      // Cull off-screen notes
      if (bottom < 0) continue;
      if (top > h) continue;

      const x = getNoteX(note.noteNumber);
      const nw = getNoteWidth(note.noteNumber);
      const alpha = 0.5 + 0.5 * (note.velocity / 127);
      const [r, g, b] = NOTE_COLOR_BASE;

      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath();
      const radius = 3;
      const drawTop = Math.max(top, 0);
      const drawBottom = Math.min(bottom, h);
      const drawHeight = drawBottom - drawTop;
      if (drawHeight <= 0) continue;

      // Rounded rect
      ctx.beginPath();
      ctx.moveTo(x + radius, drawTop);
      ctx.lineTo(x + nw - radius, drawTop);
      ctx.quadraticCurveTo(x + nw, drawTop, x + nw, drawTop + radius);
      ctx.lineTo(x + nw, drawBottom - radius);
      ctx.quadraticCurveTo(x + nw, drawBottom, x + nw - radius, drawBottom);
      ctx.lineTo(x + radius, drawBottom);
      ctx.quadraticCurveTo(x, drawBottom, x, drawBottom - radius);
      ctx.lineTo(x, drawTop + radius);
      ctx.quadraticCurveTo(x, drawTop, x + radius, drawTop);
      ctx.fill();
    }

    // Cleanup notes that scrolled off
    fallingNotes = fallingNotes.filter(n => {
      const timeSinceEnd = (now - n.endTime) / 1000;
      const bottom = h - timeSinceEnd * SCROLL_SPEED;
      return bottom > 0;
    });

    requestAnimationFrame(render);
  }

  // --- MIDI handling ---
  function onMIDIMessage(e) {
    const [status, noteNumber, velocity] = e.data;
    const command = status & 0xf0;

    if (command === 0x90 && velocity > 0) {
      // Note On
      if (isRecording) {
        if (recordedEvents.length === 0) {
          recordStartTime = performance.now();
        }
        recordedEvents.push({
          type: 'on',
          note: noteNumber,
          velocity,
          time: performance.now() - recordStartTime,
        });
      }
      activeNotes[noteNumber] = { velocity, startTime: performance.now() };
      highlightKey(noteNumber, velocity);
      noteOn(noteNumber, velocity);
    } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      // Note Off
      if (isRecording) {
        recordedEvents.push({
          type: 'off',
          note: noteNumber,
          velocity,
          time: performance.now() - recordStartTime,
        });
      }
      const info = activeNotes[noteNumber];
      if (info) {
        fallingNotes.push({
          noteNumber,
          velocity: info.velocity,
          startTime: info.startTime,
          endTime: performance.now(),
        });
        delete activeNotes[noteNumber];
      }
      unhighlightKey(noteNumber);
      noteOff(noteNumber);
    }
  }

  function connectInput(input) {
    if (currentInput) {
      currentInput.onmidimessage = null;
    }
    currentInput = input;
    if (input) {
      input.onmidimessage = onMIDIMessage;
      statusEl.textContent = `MIDI: 연결됨 — ${input.name}`;
      statusEl.className = 'connected';
    }
  }

  function populateDevices() {
    if (!midiAccess) return;
    const inputs = Array.from(midiAccess.inputs.values());

    // Clear options except first
    deviceSelect.innerHTML = '<option value="">-- 디바이스 선택 --</option>';

    inputs.forEach(input => {
      const opt = document.createElement('option');
      opt.value = input.id;
      opt.textContent = input.name || input.id;
      deviceSelect.appendChild(opt);
    });

    if (inputs.length === 0) {
      statusEl.textContent = 'MIDI: 디바이스 없음';
      statusEl.className = 'disconnected';
    } else if (!currentInput) {
      // Auto-connect first device
      connectInput(inputs[0]);
      deviceSelect.value = inputs[0].id;
    }
  }

  deviceSelect.addEventListener('change', () => {
    if (!midiAccess) return;
    const id = deviceSelect.value;
    if (!id) {
      connectInput(null);
      statusEl.textContent = 'MIDI: 선택 안 됨';
      statusEl.className = 'disconnected';
      return;
    }
    const input = midiAccess.inputs.get(id);
    if (input) connectInput(input);
  });

  async function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      statusEl.textContent = 'MIDI: 이 브라우저는 Web MIDI를 지원하지 않습니다';
      statusEl.className = 'disconnected';
      return;
    }

    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => populateDevices();
      populateDevices();
    } catch (err) {
      statusEl.textContent = 'MIDI: 접근 거부됨';
      statusEl.className = 'disconnected';
      console.error('MIDI access error:', err);
    }
  }

  // --- Recording & Replay Controls ---
  const btnRec = document.getElementById('btn-rec');
  const btnPlay = document.getElementById('btn-play');
  const btnStop = document.getElementById('btn-stop');
  const btnDownload = document.getElementById('btn-download');
  const fileInput = document.getElementById('file-input');

  function toggleRecording() {
    if (isPlaying) return;
    isRecording = !isRecording;
    if (isRecording) {
      // Start new recording — overwrite previous
      recordedEvents = [];
      recordStartTime = performance.now();
      btnRec.classList.add('recording');
      btnPlay.disabled = true;
    } else {
      btnRec.classList.remove('recording');
      btnPlay.disabled = recordedEvents.length === 0;
    }
  }

  function simulateNoteOn(noteNumber, velocity) {
    // Reuse the exact same paths as onMIDIMessage for note-on
    activeNotes[noteNumber] = { velocity, startTime: performance.now() };
    highlightKey(noteNumber, velocity);
    noteOn(noteNumber, velocity);
  }

  function simulateNoteOff(noteNumber) {
    // Reuse the exact same paths as onMIDIMessage for note-off
    const info = activeNotes[noteNumber];
    if (info) {
      fallingNotes.push({
        noteNumber,
        velocity: info.velocity,
        startTime: info.startTime,
        endTime: performance.now(),
      });
      delete activeNotes[noteNumber];
    }
    unhighlightKey(noteNumber);
    noteOff(noteNumber);
  }

  function startReplay() {
    if (isRecording || isPlaying || recordedEvents.length === 0) return;
    isPlaying = true;
    btnPlay.classList.add('playing');
    btnPlay.disabled = true;
    btnRec.disabled = true;
    btnStop.disabled = false;

    for (const evt of recordedEvents) {
      const tid = setTimeout(() => {
        if (!isPlaying) return;
        if (evt.type === 'on') {
          simulateNoteOn(evt.note, evt.velocity);
        } else {
          simulateNoteOff(evt.note);
        }
      }, evt.time);
      replayTimeouts.push(tid);
    }

    // Auto-stop after last event
    const lastTime = recordedEvents[recordedEvents.length - 1].time;
    const endTid = setTimeout(() => stopReplay(), lastTime + 100);
    replayTimeouts.push(endTid);
  }

  function stopReplay() {
    if (!isPlaying) return;
    isPlaying = false;

    // Clear all pending timeouts
    for (const tid of replayTimeouts) clearTimeout(tid);
    replayTimeouts = [];

    // Turn off all active notes
    for (const noteStr of Object.keys(activeNotes)) {
      const noteNumber = parseInt(noteStr);
      unhighlightKey(noteNumber);
      noteOff(noteNumber);
    }
    activeNotes = {};

    btnPlay.classList.remove('playing');
    btnPlay.disabled = recordedEvents.length === 0;
    btnRec.disabled = false;
    btnStop.disabled = true;
  }

  function downloadRecording() {
    if (recordedEvents.length === 0) return;
    const json = JSON.stringify(recordedEvents, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'midi-recording.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function loadRecording(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!Array.isArray(data) || data.length === 0) {
          alert('유효한 녹음 데이터가 아닙니다.');
          return;
        }
        // Validate structure
        const valid = data.every(
          evt => (evt.type === 'on' || evt.type === 'off') &&
                 typeof evt.note === 'number' &&
                 typeof evt.time === 'number'
        );
        if (!valid) {
          alert('JSON 형식이 올바르지 않습니다.');
          return;
        }
        if (isPlaying) stopReplay();
        if (isRecording) toggleRecording();
        recordedEvents = data;
        btnPlay.disabled = false;
      } catch (err) {
        alert('JSON 파일을 읽을 수 없습니다: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  btnRec.addEventListener('click', toggleRecording);
  btnPlay.addEventListener('click', startReplay);
  btnStop.addEventListener('click', stopReplay);
  btnDownload.addEventListener('click', downloadRecording);
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) {
      loadRecording(e.target.files[0]);
      e.target.value = ''; // reset so same file can be re-selected
    }
  });

  // --- Metronome ---
  const btnMetro = document.getElementById('btn-metro');
  const bpmInput = document.getElementById('bpm-input');
  const timeSigSelect = document.getElementById('time-sig');
  const beatContainer = document.getElementById('beat-indicators');

  let metronomeOn = false;
  let metronomeInterval = null;
  let currentBeat = 0;
  let beatsPerMeasure = 4;

  function buildBeatDots() {
    beatContainer.innerHTML = '';
    for (let i = 0; i < beatsPerMeasure; i++) {
      const dot = document.createElement('span');
      dot.className = 'beat-dot';
      dot.dataset.beat = i;
      beatContainer.appendChild(dot);
    }
  }

  buildBeatDots();

  function playClick(isDownbeat) {
    if (Tone.context.state !== 'running') {
      Tone.context.resume();
    }
    const freq = isDownbeat ? 1000 : 800;
    const duration = isDownbeat ? 0.05 : 0.03;
    const osc = new Tone.Oscillator(freq, 'sine').connect(metronomeGain);
    osc.start(Tone.now());
    osc.stop(Tone.now() + duration);
    // Cleanup after sound finishes
    setTimeout(() => osc.dispose(), 200);
  }

  function updateBeatIndicator(beat) {
    const dots = beatContainer.querySelectorAll('.beat-dot');
    dots.forEach((dot, i) => {
      dot.classList.remove('active', 'downbeat');
      if (i === beat) {
        dot.classList.add(beat === 0 ? 'downbeat' : 'active');
      }
    });
  }

  function startMetronome() {
    const bpm = parseInt(bpmInput.value) || 120;
    const intervalMs = 60000 / bpm;
    currentBeat = 0;

    // Play first beat immediately
    playClick(true);
    updateBeatIndicator(0);
    currentBeat = 1;

    metronomeInterval = setInterval(() => {
      const isDownbeat = currentBeat === 0;
      playClick(isDownbeat);
      updateBeatIndicator(currentBeat);
      currentBeat = (currentBeat + 1) % beatsPerMeasure;
    }, intervalMs);
  }

  function stopMetronome() {
    if (metronomeInterval) {
      clearInterval(metronomeInterval);
      metronomeInterval = null;
    }
    currentBeat = 0;
    beatContainer.querySelectorAll('.beat-dot').forEach(dot => dot.classList.remove('active', 'downbeat'));
  }

  function restartMetronome() {
    if (metronomeOn) {
      stopMetronome();
      startMetronome();
    }
  }

  btnMetro.addEventListener('click', () => {
    metronomeOn = !metronomeOn;
    btnMetro.classList.toggle('active', metronomeOn);
    if (metronomeOn) {
      if (Tone.context.state !== 'running') Tone.context.resume();
      startMetronome();
    } else {
      stopMetronome();
    }
  });

  timeSigSelect.addEventListener('change', () => {
    beatsPerMeasure = parseInt(timeSigSelect.value);
    buildBeatDots();
    restartMetronome();
  });

  bpmInput.addEventListener('change', () => {
    let val = parseInt(bpmInput.value);
    if (isNaN(val)) val = 120;
    val = Math.max(40, Math.min(240, val));
    bpmInput.value = val;
    restartMetronome();
  });

  bpmInput.addEventListener('input', () => {
    // Debounced restart while typing
    clearTimeout(bpmInput._debounce);
    bpmInput._debounce = setTimeout(() => {
      let val = parseInt(bpmInput.value);
      if (isNaN(val) || val < 40 || val > 240) return;
      restartMetronome();
    }, 300);
  });

  // --- Volume Controls ---
  const volPiano = document.getElementById('vol-piano');
  const volMetro = document.getElementById('vol-metro');

  volPiano.addEventListener('input', () => {
    pianoGain.gain.value = volPiano.value / 100;
  });

  volMetro.addEventListener('input', () => {
    metronomeGain.gain.value = volMetro.value / 100;
  });

  // --- Mouse/Touch interaction ---
  function getNotFromEvent(e) {
    const el = e.target.closest('.key');
    if (!el) return null;
    return parseInt(el.dataset.note);
  }

  let pointerDown = false;
  let pointerNotes = new Set();

  function handlePointerNoteOn(noteNumber) {
    if (pointerNotes.has(noteNumber)) {
      handlePointerNoteOff(noteNumber);
    }
    pointerNotes.add(noteNumber);
    const velocity = 80;
    activeNotes[noteNumber] = { velocity, startTime: performance.now() };
    highlightKey(noteNumber, velocity);
    noteOn(noteNumber, velocity);
    if (isRecording) {
      if (recordedEvents.length === 0) recordStartTime = performance.now();
      recordedEvents.push({ type: 'on', note: noteNumber, velocity, time: performance.now() - recordStartTime });
    }
  }

  function handlePointerNoteOff(noteNumber) {
    if (!pointerNotes.has(noteNumber)) return;
    pointerNotes.delete(noteNumber);
    const info = activeNotes[noteNumber];
    if (info) {
      fallingNotes.push({ noteNumber, velocity: info.velocity, startTime: info.startTime, endTime: performance.now() });
      delete activeNotes[noteNumber];
    }
    unhighlightKey(noteNumber);
    noteOff(noteNumber);
    if (isRecording) {
      recordedEvents.push({ type: 'off', note: noteNumber, velocity: 0, time: performance.now() - recordStartTime });
    }
  }

  function releaseAllPointerNotes() {
    for (const n of pointerNotes) {
      const info = activeNotes[n];
      if (info) {
        fallingNotes.push({ noteNumber: n, velocity: info.velocity, startTime: info.startTime, endTime: performance.now() });
        delete activeNotes[n];
      }
      unhighlightKey(n);
      noteOff(n);
      if (isRecording) {
        recordedEvents.push({ type: 'off', note: n, velocity: 0, time: performance.now() - recordStartTime });
      }
    }
    pointerNotes.clear();
  }

  pianoEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerDown = true;
    const note = getNotFromEvent(e);
    if (note != null) handlePointerNoteOn(note);
  });

  pianoEl.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const note = getNotFromEvent(e);
    if (note != null) {
      // Release notes that we slid off of
      for (const n of pointerNotes) {
        if (n !== note) handlePointerNoteOff(n);
      }
      handlePointerNoteOn(note);
    }
  });

  pianoEl.addEventListener('pointerup', () => {
    pointerDown = false;
    releaseAllPointerNotes();
  });

  pianoEl.addEventListener('pointerleave', () => {
    pointerDown = false;
    releaseAllPointerNotes();
  });

  pianoEl.addEventListener('pointercancel', () => {
    pointerDown = false;
    releaseAllPointerNotes();
  });

  // Prevent default touch behavior (scrolling) on piano
  pianoEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  pianoEl.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // --- Init ---
  function init() {
    buildPiano();
    resizeCanvas();
    window.addEventListener('resize', () => {
      resizeCanvas();
    });

    // Show loading indicator for piano samples
    if (!samplerReady) {
      const loadingEl = document.createElement('div');
      loadingEl.id = 'sample-loading';
      loadingEl.textContent = '피아노 샘플 로딩 중...';
      loadingEl.style.cssText =
        'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,0.8);color:#4fc3f7;padding:16px 32px;' +
        'border-radius:8px;font-size:16px;z-index:1000;';
      document.body.appendChild(loadingEl);
    }

    // Handle Tone.js AudioContext start on first user interaction
    document.addEventListener('click', () => Tone.start(), { once: true });
    document.addEventListener('keydown', () => Tone.start(), { once: true });

    initMIDI();
    requestAnimationFrame(render);
  }

  init();
})();
