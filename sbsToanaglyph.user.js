// ==UserScript==
// @name         Stereo3D SBS Anaglyph Injector
// @namespace    com.stereo3d.injector
// @version      4.6
// @description  SBS -> anaglyph WebGL overlay for inline <video>. Auto convergence+depth, Dubois red/cyan + Dubois green/magenta matrices, desaturation. Inline, non-DRM video only.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const C = 'MGX', U = 'MGXU';

  if (localStorage.mgx_auto !== '0' && localStorage.mgx_auto !== '1') localStorage.mgx_auto = '1';
  if (localStorage.mgx_sat == null) localStorage.mgx_sat = '0.7';
  if (localStorage.mgx_bright == null) localStorage.mgx_bright = '1';
  if (localStorage.mgx_dub !== '0' && localStorage.mgx_dub !== '1') localStorage.mgx_dub = '1';
  const FITS = ['half', 'full', '240', '235', '169'];
  if (FITS.indexOf(localStorage.mgx_fit) < 0) localStorage.mgx_fit = 'half';

  const VS = 'attribute vec2 p; varying vec2 u; void main(){ u = (p + 1.0) * 0.5; gl_Position = vec4(p, 0, 1); }';

  // kind: 'gm' = green/magenta (desat + de-ghost split), 'rc' = red/cyan (Dubois matrix).
  // K = auto convergence, D = auto depth scale (1 = full), SAT = saturation (1 full colour, 0 grayscale).
  // Out-of-range samples after convergence are painted black (no edge smearing).
  const fsBody = (kind) => `
    precision mediump float;
    uniform sampler2D t; uniform sampler2D dT; uniform vec2 V, O; uniform float S, K, SAT, BR, AV, DUB; varying vec2 u;
    void main(){
      vec2 a = vec2(u.x, 1.0 - u.y);
      float av = AV, ao = O.x / max(O.y, 1.0);   // AV = target per-eye display aspect (set per Fit mode in JS)
      vec2 p = a * 2.0 - 1.0, q = p;
      if(ao > av) q.x *= ao / av; else q.y *= av / ao;
      if(abs(q.x) > 1.0 || abs(q.y) > 1.0){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
      vec2 f = q * 0.5 + 0.5;
      float lx = f.x * 0.5 + K;
      float rx = f.x * 0.5 + 0.5 - K;
      if(lx < 0.0 || lx > 0.5 || rx < 0.5 || rx > 1.0){ gl_FragColor = vec4(0.0,0.0,0.0,1.0); return; }
      vec2 Lu = vec2(lx, f.y);
      vec2 Ru = vec2(rx, f.y);
      if(S > 0.5){ vec2 tmp = Lu; Lu = Ru; Ru = tmp; }
      vec3 l = texture2D(t, Lu).rgb, r = texture2D(t, Ru).rgb;
      float Dl = texture2D(dT, vec2(f.x, f.y)).r;   // per-region depth factor (1 = full depth, lower = flatter)
      float w = (1.0 - Dl) * 0.5;
      vec3 lm = mix(l, r, w), rm = mix(r, l, w);
      l = lm; r = rm;
      float yl = dot(l, vec3(0.299,0.587,0.114));
      float yr = dot(r, vec3(0.299,0.587,0.114));
      l = mix(vec3(yl), l, SAT);
      r = mix(vec3(yr), r, SAT);
      vec3 col;
      ${kind === 'rc' ? `
      if (DUB > 0.5) {
        vec3 oL = vec3(dot(l, vec3(0.456,0.500,0.176)), dot(l, vec3(-0.040,-0.038,-0.016)), dot(l, vec3(-0.015,-0.021,-0.005)));
        vec3 oR = vec3(dot(r, vec3(-0.043,-0.088,-0.002)), dot(r, vec3(0.378,0.734,-0.018)), dot(r, vec3(-0.072,-0.113,1.226)));
        col = oL + oR;
      } else { col = vec3(l.r, r.g, r.b); }   // plain red/cyan split
      ` : `
      if (DUB > 0.5) {
        vec3 oL = vec3(dot(l, vec3(-0.062,-0.158,-0.039)), dot(l, vec3(0.284,0.668,0.143)), dot(l, vec3(-0.015,-0.027,0.021)));
        vec3 oR = vec3(dot(r, vec3(0.529,0.705,0.024)), dot(r, vec3(-0.016,-0.015,0.065)), dot(r, vec3(0.009,0.075,0.937)));
        col = oL + oR;
      } else { col = vec3(l.r, r.g, l.b); }   // plain green/magenta split
      `}
      gl_FragColor = vec4(clamp(col * BR, 0.0, 1.0), 1.0);
    }`;

  const FS1 = fsBody('gm'); // 3D-A: green/magenta
  const FS2 = fsBody('rc'); // 3D-B: red/cyan (Dubois)

  // ---- auto-depth tunables (no convergence: the frame never shifts sideways) ----
  const EST_EVERY = 4, CONF_MIN = 0.05, DEPTH_SMOOTH = 0.30, DEPTH_BUDGET = 0.045, DMIN = 0.15;

  // ---- state ----
  let mode = parseInt(localStorage.mgx_mode || '0', 10) || 0; // 0 off, 1 green/magenta, 2 red/cyan
  let gl = null, pr = null, tx = null, c = null, ui = null, v = null, uni = {};
  let curK = 0, frameN = 0, eCv = null, eCx = null, dTex = null; // curK stays 0 — convergence removed
  const GW = 5, GH = 4;                              // local depth grid (matches estimator COLS×ROWS)
  const curDGrid = new Float32Array(GW * GH).fill(1); // per-region depth factor (1 = full depth)
  const dBuf = new Uint8Array(GW * GH);
  let btnAuto, btnMode, btnSwap, btnLayout, btnDub, satSlider, brSlider, show;

  const findVideo = () =>
    [...document.querySelectorAll('video')].find(x => x.videoWidth > 0) ||
    document.querySelector('video');

  // Target per-eye display aspect. 'half' = container (works for files stored at true
  // aspect); fixed values force a picture shape for anamorphic files (scope squeezed into 16:9).
  const FIT_LABEL = { half: 'Fit: Half', full: 'Fit: Full', '240': 'Fit: 2.40', '235': 'Fit: 2.35', '169': 'Fit: 16:9' };
  const computeAV = () => {
    const vx = (v && v.videoWidth) || 16, vy = Math.max((v && v.videoHeight) || 9, 1);
    switch (localStorage.mgx_fit) {
      case 'full': return (vx / 2) / vy;
      case '240': return 2.40;
      case '235': return 2.3485;
      case '169': return 16 / 9;
      default: return vx / vy; // half
    }
  };

  const compile = (type, src) => { const z = gl.createShader(type); gl.shaderSource(z, src); gl.compileShader(z); return z; };

  const buildProgram = () => {
    const FS = (mode === 2) ? FS2 : FS1;
    if (pr) gl.deleteProgram(pr);
    pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const al = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(al);
    gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
    uni = {
      t: gl.getUniformLocation(pr, 't'), dT: gl.getUniformLocation(pr, 'dT'),
      V: gl.getUniformLocation(pr, 'V'), O: gl.getUniformLocation(pr, 'O'),
      S: gl.getUniformLocation(pr, 'S'), K: gl.getUniformLocation(pr, 'K'),
      SAT: gl.getUniformLocation(pr, 'SAT'), BR: gl.getUniformLocation(pr, 'BR'),
      AV: gl.getUniformLocation(pr, 'AV'), DUB: gl.getUniformLocation(pr, 'DUB')
    };
    gl.uniform1i(uni.t, 0);   // video on texture unit 0
    gl.uniform1i(uni.dT, 1);  // depth grid on texture unit 1
  };

  const stop = () => {
    if (window._mgx) cancelAnimationFrame(window._mgx);
    window._mgx = null;
    const eC = document.getElementById(C); if (eC) eC.remove();
    c = null; gl = null; pr = null; tx = null;
  };

  // ---- auto-depth estimator: measure the frame's disparity spread, crush deep scenes
  //      to the fusion budget. No convergence, so nothing ever shifts sideways. ----
  const estimate = () => {
    if (!v || !v.videoWidth) { const nv = findVideo(); if (nv) v = nv; }
    if (!v || !v.videoWidth) return;
    if (!eCv) { eCv = document.createElement('canvas'); eCv.width = 200; eCv.height = 90; eCx = eCv.getContext('2d', { willReadFrequently: true }); }
    const AW = eCv.width, AH = eCv.height, ew = AW >> 1;
    let img;
    try { eCx.drawImage(v, 0, 0, AW, AH); img = eCx.getImageData(0, 0, AW, AH).data; }
    catch (e) { setAuto(false); console.warn('[Stereo3D] Auto off: video not readable (DRM/cross-origin).'); return; }

    const Y = new Float32Array(AW * AH);
    for (let i = 0, j = 0; i < Y.length; i++, j += 4) Y[i] = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];

    const MAX = 40, COLS = 5, ROWS = 4;
    const bx0 = (ew * 0.05) | 0, bx1 = (ew * 0.95) | 0, by0 = (AH * 0.10) | 0, by1 = (AH * 0.90) | 0;
    const bw = ((bx1 - bx0) / COLS) | 0, bh = ((by1 - by0) / ROWS) | 0;
    const sad = new Float32Array(2 * MAX + 1);
    const budgetPx = DEPTH_BUDGET * ew;   // comfortable disparity spread, in analysis pixels
    const spArr = new Float32Array(GW * GH); spArr.fill(NaN);
    const valid = [];

    for (let ci = 0; ci < COLS; ci++) for (let ri = 0; ri < ROWS; ri++) {
      const rx0 = bx0 + ci * bw, rx1 = rx0 + bw, ry0 = by0 + ri * bh, ry1 = ry0 + bh;
      const gi = ri * COLS + ci;
      let best = 1e18, bestI = MAX, worst = 0;
      for (let s = -MAX; s <= MAX; s++) {
        let acc = 0, n = 0;
        for (let y = ry0; y < ry1; y++) { const row = y * AW; for (let x = rx0; x < rx1; x++) {
          const rxk = x + s; if (rxk < 0 || rxk >= ew) continue;
          acc += Math.abs(Y[row + x] - Y[row + ew + rxk]); n++;
        } }
        const idx = s + MAX;
        if (n < 20) { sad[idx] = Infinity; continue; }
        acc /= n; sad[idx] = acc;
        if (acc < best) { best = acc; bestI = idx; }
        if (acc > worst) worst = acc;
      }
      if (worst <= 0 || (worst - best) / worst < CONF_MIN) continue; // low-confidence: leave spArr[gi]=NaN
      let sp = bestI - MAX;
      if (bestI > 0 && bestI < sad.length - 1) {
        const a = sad[bestI - 1], b = sad[bestI], cc = sad[bestI + 1];
        if (isFinite(a) && isFinite(cc)) { const den = a - 2 * b + cc; if (den > 1e-6) { let off = 0.5 * (a - cc) / den; if (off > 1) off = 1; else if (off < -1) off = -1; sp += off; } }
      }
      spArr[gi] = sp; valid.push(sp);
    }
    if (valid.length < 4) return;

    // Scene convergence plane = median disparity. Crush each region by how far it sits FROM
    // that plane (not from zero), so a baked-in convergence offset isn't read as all-blown-out.
    valid.sort((a, b) => a - b);
    const med = valid[valid.length >> 1];
    for (let gi = 0; gi < curDGrid.length; gi++) {
      if (isNaN(spArr[gi])) { curDGrid[gi] += (1 - curDGrid[gi]) * 0.1; continue; } // untextured: release
      const dev = Math.abs(spArr[gi] - med);
      const targetDb = dev <= budgetPx ? 1 : Math.max(DMIN, budgetPx / dev);
      curDGrid[gi] += (targetDb - curDGrid[gi]) * DEPTH_SMOOTH;
    }
  };

  const start = () => {
    v = findVideo(); if (!v) return false;
    c = document.createElement('canvas'); c.id = C;
    Object.assign(c.style, { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 2147483646, pointerEvents: 'none', background: '#000' });
    document.body.appendChild(c);
    gl = c.getContext('webgl'); if (!gl) { c.remove(); return false; }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // 5-wide depth-grid rows aren't 4-byte aligned
    buildProgram();
    tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // depth-grid texture (unit 1): small, LINEAR so the per-region factor blends smoothly (no seams)
    dTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.activeTexture(gl.TEXTURE0);

    const draw = () => {
      if (!gl || mode === 0) return;
      if (!v || !v.videoWidth) { const nv = findVideo(); if (nv) v = nv; }

      if (localStorage.mgx_auto == '1') { if ((frameN++ % EST_EVERY) === 0) estimate(); }
      else { curDGrid.fill(1); } // auto off: full depth everywhere

      const d = devicePixelRatio || 1, w = (innerWidth * d) | 0, h = (innerHeight * d) | 0;
      if (c.width != w || c.height != h) { c.width = w; c.height = h; gl.viewport(0, 0, w, h); }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tx);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
        gl.uniform2f(uni.V, v.videoWidth || 1, v.videoHeight || 1);
        gl.uniform2f(uni.O, c.width, c.height);
        gl.uniform1f(uni.S, parseFloat(localStorage.mgx_s || '0'));
        gl.uniform1f(uni.K, curK);
        gl.uniform1f(uni.BR, parseFloat(localStorage.mgx_bright || '1'));
        gl.uniform1f(uni.AV, computeAV());
        gl.uniform1f(uni.SAT, parseFloat(localStorage.mgx_sat || '0.7'));
        gl.uniform1f(uni.DUB, (localStorage.mgx_dub == '0') ? 0.0 : 1.0);
        // upload the per-region depth grid to unit 1 (tiny: 5x4 LUMINANCE)
        for (let i = 0; i < curDGrid.length; i++) { let dv = (curDGrid[i] * 255) | 0; dBuf[i] = dv < 0 ? 0 : (dv > 255 ? 255 : dv); }
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, GW, GH, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, dBuf);
        gl.activeTexture(gl.TEXTURE0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } catch (e) {
        stop(); setMode(0, true);
        console.warn('[Stereo3D] Cannot read this video (DRM or cross-origin). Disabled.');
        return;
      }
      window._mgx = requestAnimationFrame(draw);
    };
    draw(); return true;
  };

  const modeLabel = () => mode === 0 ? 'MODE: 2D' : (mode === 1 ? 'MODE: 3D-A' : 'MODE: 3D-B');

  const setMode = (m, silent) => {
    mode = m; localStorage.mgx_mode = String(m);
    if (btnMode) btnMode.textContent = modeLabel();
    if (m === 0) stop();
    else if (!gl) { if (!start() && !silent) console.warn('[Stereo3D] No playable <video> found yet.'); }
    else buildProgram();
    if (!silent) show && show();
  };

  const setAuto = (on) => {
    localStorage.mgx_auto = on ? '1' : '0';
    if (btnAuto) btnAuto.textContent = on ? 'Auto: ON' : 'Auto: OFF';
    if (!on) { curDGrid.fill(1); }
  };

  const mkRange = (min, max, step, val) => { const s = document.createElement('input'); s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = val; return s; };

  const buildUI = () => {
    if (document.getElementById(U)) return;
    ui = document.createElement('div'); ui.id = U;
    Object.assign(ui.style, { position: 'fixed', top: '20px', left: '20px', zIndex: 2147483647, background: 'rgba(20,20,20,0.9)', padding: '15px', borderRadius: '8px', color: '#fff', fontFamily: 'sans-serif', transition: 'opacity 0.3s' });

    btnMode = document.createElement('button'); btnMode.textContent = modeLabel(); btnMode.style.marginRight = '10px';
    btnSwap = document.createElement('button'); btnSwap.textContent = (localStorage.mgx_s == '1') ? 'Swap: ON' : 'Swap: OFF'; btnSwap.style.marginRight = '10px';
    btnAuto = document.createElement('button'); btnAuto.textContent = (localStorage.mgx_auto == '1') ? 'Auto: ON' : 'Auto: OFF'; btnAuto.style.marginRight = '10px';
    btnLayout = document.createElement('button'); btnLayout.textContent = FIT_LABEL[localStorage.mgx_fit] || 'Fit: Half'; btnLayout.style.marginRight = '10px';
    btnDub = document.createElement('button'); btnDub.textContent = (localStorage.mgx_dub == '0') ? 'Dubois: OFF' : 'Dubois: ON'; btnDub.style.marginRight = '10px';

    satSlider = mkRange('0.0', '1.0', '0.05', localStorage.mgx_sat || '0.7');
    const lbl2 = document.createElement('span'); lbl2.textContent = ' Saturation: ';
    brSlider = mkRange('0.5', '2.5', '0.05', localStorage.mgx_bright || '1');
    const lbl3 = document.createElement('span'); lbl3.textContent = ' Brightness: ';

    ui.appendChild(btnMode); ui.appendChild(btnSwap); ui.appendChild(btnAuto); ui.appendChild(btnLayout); ui.appendChild(btnDub);
    ui.appendChild(lbl2); ui.appendChild(satSlider);
    ui.appendChild(lbl3); ui.appendChild(brSlider);
    document.body.appendChild(ui);

    show = () => {
      ui.style.opacity = '1'; ui.style.pointerEvents = 'auto'; clearTimeout(window._mgt);
      window._mgt = setTimeout(() => { ui.style.opacity = '0'; ui.style.pointerEvents = 'none'; }, 4000);
    };

    btnMode.onclick = (e) => { e.stopPropagation(); setMode((mode + 1) % 3); };
    btnSwap.onclick = (e) => { e.stopPropagation(); localStorage.mgx_s = (localStorage.mgx_s == '1') ? '0' : '1'; btnSwap.textContent = (localStorage.mgx_s == '1') ? 'Swap: ON' : 'Swap: OFF'; show(); };
    btnAuto.onclick = (e) => { e.stopPropagation(); setAuto(localStorage.mgx_auto != '1'); show(); };
    btnLayout.onclick = (e) => { e.stopPropagation(); const i = FITS.indexOf(localStorage.mgx_fit); localStorage.mgx_fit = FITS[(i + 1) % FITS.length]; btnLayout.textContent = FIT_LABEL[localStorage.mgx_fit]; show(); };
    btnDub.onclick = (e) => { e.stopPropagation(); localStorage.mgx_dub = (localStorage.mgx_dub == '0') ? '1' : '0'; btnDub.textContent = (localStorage.mgx_dub == '0') ? 'Dubois: OFF' : 'Dubois: ON'; show(); };
    satSlider.oninput = (e) => { e.stopPropagation(); localStorage.mgx_sat = satSlider.value; show(); };
    brSlider.oninput = (e) => { e.stopPropagation(); localStorage.mgx_bright = brSlider.value; show(); };

    window._mgm = () => show();
    window._mgk = (e) => { if (e.key && e.key.toLowerCase() === 'h') show(); };
    document.addEventListener('keydown', window._mgk);
    document.addEventListener('mousedown', window._mgm);
    document.addEventListener('touchstart', window._mgm, { passive: true });
    show();
  };

  buildUI();
  if (mode !== 0) setMode(mode, true);
})();
