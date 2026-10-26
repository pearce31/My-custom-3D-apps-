// ==UserScript==
// @name         Stereo3D 2D-to-3D (Game + Video)
// @namespace    com.stereo3d.injector.pseudo
// @version      1.1
// @description  Real-time 2D->3D pseudo-depth green/magenta anaglyph for any <video> or game <canvas>. Mode 1 = luminance-edge shift (video), Mode 2 = radial depth (games). Ported 1:1 from the Android injector.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CID = 'AnaCanvas', SID = 'AnaSlider', BID = 'AnaModeBtn';

  const VS = 'attribute vec2 p; varying vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }';

  // Mode 1 — luminance-edge horizontal shift (gentle; good for video)
  const FS1 = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uCanvasSize; uniform vec4 uCrop;
    uniform float uStrength; uniform float uConverge; varying vec2 uv;
    float lum(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
    vec2 cropUv(vec2 uv){ return uCrop.xy + uv * (uCrop.zw - uCrop.xy); }
    vec2 fitUv(vec2 uv){
      float va = uTexSize.x / max(1.0,uTexSize.y);
      float ca = uCanvasSize.x / max(1.0,uCanvasSize.y);
      vec2 s = (ca >= va) ? vec2(va/ca, 1.0) : vec2(1.0, ca/va);
      return (uv - 0.5) / s + 0.5;
    }
    void main(){
      vec2 u = fitUv(uv);
      float inB = step(0.0,u.x)*step(u.x,1.0)*step(0.0,u.y)*step(u.y,1.0);
      u = cropUv(u);
      vec3 col = texture2D(uTex, u).rgb;
      float L = dot(col, vec3(0.299, 0.587, 0.114));
      float d = L - 0.5;
      float curve = sign(d) * pow(max(abs(d),1e-5), 0.7) * smoothstep(0.0, 0.04, abs(d));
      vec2 uS = vec2(clamp(u.x + curve * uStrength * 0.09, 0.0, 1.0), u.y);
      vec3 colS = texture2D(uTex, uS).rgb;
      float LS = dot(colS, vec3(0.299, 0.587, 0.114));
      float edge = smoothstep(0.05, 0.28, abs(L - LS));
      float gC = mix(colS.g, col.g, edge * 0.93);
      gl_FragColor = mix(vec4(0.0,0.0,0.0,1.0), vec4(col.r, gC, col.b, 1.0), inB);
    }`;

  // Mode 2 — radial + luminance depth pop (good for games)
  const FS2 = `
    precision highp float;
    uniform sampler2D uTex; uniform float uStrength; uniform vec2 uTexSize, uCanvasSize; varying vec2 uv;
    void main(){
      float va = uTexSize.x/max(uTexSize.y,1.0);
      float ca = uCanvasSize.x/max(uCanvasSize.y,1.0);
      vec2 s = ca>va ? vec2(va/ca,1.) : vec2(1.,ca/va);
      vec2 u = (uv-0.5)/s+0.5;
      float inB = step(0.0,u.x)*step(u.x,1.0)*step(0.0,u.y)*step(u.y,1.0);
      float l  = dot(texture2D(uTex,u).rgb, vec3(.299,.587,.114));
      float lR = dot(texture2D(uTex,u+vec2(4./uTexSize.x,0)).rgb, vec3(.299,.587,.114));
      float lL = dot(texture2D(uTex,u-vec2(4./uTexSize.x,0)).rgb, vec3(.299,.587,.114));
      float smL = (l+lR+lL)/3.0, dist = distance(u,vec2(0.5));
      float z = ((0.35-dist)*0.8 + (smL-0.5)*0.25) * uStrength;
      vec2 uL = vec2(clamp(u.x-z,0.001,0.999), u.y);
      vec2 uR = vec2(clamp(u.x+z,0.001,0.999), u.y);
      vec3 cL = texture2D(uTex,uL).rgb, cR = texture2D(uTex,uR).rgb;
      cL.g *= 0.8; cR.r *= 0.8; cR.b *= 0.8;
      float magR = 0.7*cL.r + 0.3*cL.b, magB = 0.3*cL.r + 0.7*cL.b;
      gl_FragColor = mix(vec4(0.0,0.0,0.0,1.0), vec4(magR, cR.g*0.95, magB, 1.0), inB);
    }`;

  // per-mode slider range (min, max, step, default) — from the original
  const RANGE = { 1: ['0', '0.18', '0.002', '0.025'], 2: ['0', '0.015', '0.0001', '0.003'] };

  let mode = parseInt(localStorage.a3d_mode || '0', 10) || 0;
  if (localStorage.a3d_s1 == null) localStorage.a3d_s1 = '0.025';
  if (localStorage.a3d_s2 == null) localStorage.a3d_s2 = '0.003';

  let gl = null, pr = null, tex = null, uni = {}, src = null, r = null, slider = null, btn = null;

  const findSrc = () =>
    [...document.querySelectorAll('video')].find(x => (x.videoWidth || x.width) > 0) ||
    document.querySelector('video') ||
    document.querySelector('canvas:not(#' + CID + ')');

  const compile = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };

  const curVal = () => parseFloat((mode === 1 ? localStorage.a3d_s1 : localStorage.a3d_s2) || '0.01');

  const kill = () => {
    if (window._3D_RAF) cancelAnimationFrame(window._3D_RAF);
    window._3D_RAF = null;
    const eC = document.getElementById(CID); if (eC) eC.remove();
    const eS = document.getElementById(SID); if (eS) eS.remove();
    if (gl) { try { const lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext(); } catch (e) {} }
    gl = null; pr = null; tex = null; slider = null;
  };

  const buildSlider = () => {
    slider = document.createElement('input'); slider.id = SID;
    const rg = RANGE[mode] || RANGE[1];
    slider.type = 'range'; slider.min = rg[0]; slider.max = rg[1]; slider.step = rg[2];
    slider.value = curVal();
    Object.assign(slider.style, {
      position: 'fixed', bottom: '40px', left: '50%', transform: 'translateX(-50%)', width: '300px',
      zIndex: 2147483647, transition: 'opacity 0.5s', accentColor: 'magenta', cursor: 'pointer', opacity: '0.7', pointerEvents: 'auto'
    });
    document.body.appendChild(slider);

    let fT;
    const show = () => {
      slider.style.opacity = '0.7'; if (btn) btn.style.opacity = '0.7';
      clearTimeout(fT);
      fT = setTimeout(() => { slider.style.opacity = '0'; if (btn) btn.style.opacity = '0'; }, 4000);
    };
    show();
    document.addEventListener('mousemove', show);
    document.addEventListener('mousedown', show);
    document.addEventListener('touchstart', show, { passive: true });
    slider.oninput = () => { if (mode === 1) localStorage.a3d_s1 = slider.value; else localStorage.a3d_s2 = slider.value; show(); };
    window._anaShow = show;
  };

  const start = () => {
    src = findSrc();
    if (!src) return false;

    r = document.createElement('canvas'); r.id = CID;
    Object.assign(r.style, {
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      zIndex: 2147483646, pointerEvents: 'none', display: 'block', transform: 'scaleY(-1)'
    });
    document.body.appendChild(r);

    gl = window._3D_GL = r.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true }) || r.getContext('webgl');
    if (!gl) { r.remove(); return false; }
    try { if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb'; } catch (e) {}
    try { if ('unpackColorSpace' in gl) gl.unpackColorSpace = 'srgb'; } catch (e) {}

    pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, mode === 1 ? FS1 : FS2));
    gl.linkProgram(pr); gl.useProgram(pr);

    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const la = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(la);
    gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 0, 0);

    uni = {
      uStrength: gl.getUniformLocation(pr, 'uStrength'),
      uTexSize: gl.getUniformLocation(pr, 'uTexSize'),
      uCanvasSize: gl.getUniformLocation(pr, 'uCanvasSize'),
      uCrop: gl.getUniformLocation(pr, 'uCrop')
    };

    const loop = () => {
      if (!gl) return;
      if (!src || !((src.videoWidth || src.width) > 0)) { const ns = findSrc(); if (ns) src = ns; }
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      if (sw > 0) {
        r.width = innerWidth; r.height = innerHeight;
        gl.viewport(0, 0, r.width, r.height);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.flush();
          gl.uniform1f(uni.uStrength, curVal() * 3.8);
          gl.uniform2f(uni.uTexSize, sw, sh);
          gl.uniform2f(uni.uCanvasSize, r.width, r.height);
          if (uni.uCrop) gl.uniform4f(uni.uCrop, 0.0, 0.0, 1.0, 1.0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch (e) {
          // tainted (cross-origin video/canvas) — can't read pixels; stop cleanly
          kill(); mode = 0; localStorage.a3d_mode = '0'; if (btn) btn.textContent = 'MODE: 2D';
          console.warn('[2D-to-3D] Source not readable (cross-origin). Disabled.');
          return;
        }
      }
      window._3D_RAF = requestAnimationFrame(loop);
    };
    loop();
    return true;
  };

  const rebuild = () => {
    kill();
    if (mode !== 0) { if (!start()) console.warn('[2D-to-3D] No <video> or <canvas> found yet.'); }
  };

  const modeLabel = () => 'MODE: ' + (mode === 0 ? '2D' : mode);

  const buildBtn = () => {
    if (document.getElementById(BID)) return;
    btn = document.createElement('button'); btn.id = BID; btn.textContent = modeLabel();
    Object.assign(btn.style, {
      position: 'fixed', top: '20px', left: '20px', zIndex: 2147483647,
      background: 'rgba(20,20,20,0.9)', color: '#fff', border: '1px solid #444',
      borderRadius: '8px', padding: '10px 14px', fontFamily: 'sans-serif', fontSize: '14px',
      fontWeight: '600', transition: 'opacity 0.5s', opacity: '0.7', pointerEvents: 'auto'
    });
    document.body.appendChild(btn);
    btn.onclick = (e) => {
      e.stopPropagation();
      mode = (mode + 1) % 3; localStorage.a3d_mode = String(mode);
      btn.textContent = modeLabel();
      rebuild();
      if (mode !== 0) buildSlider();
      if (window._anaShow) window._anaShow();
    };
  };

  buildBtn();
  if (mode !== 0) { if (start()) buildSlider(); }
})();
