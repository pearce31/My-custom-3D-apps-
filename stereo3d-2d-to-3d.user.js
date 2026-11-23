// ==UserScript==
// @name         Stereo3D 2D-to-3D (Full-Color Green/Magenta)
// @namespace    com.stereo3d.injector.pseudo
// @version      3.0
// @description  Real-time 2D->3D pseudo-depth for any <video>, using the EXACT full-color green/magenta shader + GL pipeline from the 3D Browser app. Single mode. Depth + Converge (edge re-converge) sliders; defaults 30 / 0.2 = depth with no crosstalk.
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CID = 'AnaCanvas', PID = 'AnaPanel', BID = 'AnaModeBtn';

  // ---- shader: lifted verbatim from the 3D Browser app ----
  const VS = "attribute vec2 p;varying vec2 uv;void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}";
  const FS = [
  "precision highp float;","varying vec2 uv;","uniform sampler2D uTex;",
  "uniform vec2 uTexSize,uCanvasSize;","uniform vec4 uCrop;",
  "uniform float uStrength,uGreenGain,uDesat,uGhost,uConverge,uMode,uSource,uSwap,uFull,uEdge,uSBS,uLeak;",
  "const vec3 LUMA=vec3(0.299,0.587,0.114);",
  "vec3 toLin(vec3 c){return pow(c,vec3(2.2));}",
  "vec3 toSrgb(vec3 c){return pow(max(c,0.0),vec3(1.0/2.2));}",
  "void main(){",
  " float eye=0.0; vec2 bv=uv;",
  " if(uSBS>0.5){ float hf=step(0.5,uv.x); bv=vec2((uv.x-hf*0.5)*2.0, uv.y); eye=(uSwap>0.5)?(1.0-hf):hf; }",
  " float ca=uCanvasSize.x/max(uCanvasSize.y,1.0);",
  " if(uSBS>0.5 && ca>2.4) ca*=0.5;",
  " float va; float asp=uTexSize.x/max(uTexSize.y,1.0);",
  " if(uSource<0.5) va=asp;",
  " else if(uSource<1.5) va=(asp>2.2)?(uTexSize.x*0.5)/max(uTexSize.y,1.0):asp;",
  " else va=(asp<1.3)?uTexSize.x/max(uTexSize.y*0.5,1.0):asp;",
  " vec2 s=ca>va?vec2(va/ca,1.0):vec2(1.0,ca/va);",
  " vec2 u=(bv-0.5)/s+0.5;",
  " float inB=step(0.0,u.x)*step(u.x,1.0)*step(0.0,u.y)*step(u.y,1.0);",
  " float conv=(uSource<0.5)?uConverge:uConverge*4.0;",
  " vec3 cL,cR;",
  " if(uSource<0.5){",
  "   float l=dot(texture2D(uTex,u).rgb,LUMA);",
  "   float lL=dot(texture2D(uTex,u-vec2(4.0/uTexSize.x,0.0)).rgb,LUMA);",
  "   float lR=dot(texture2D(uTex,u+vec2(4.0/uTexSize.x,0.0)).rgb,LUMA);",
  "   float smL=(l+lR+lL)/3.0; float dist=distance(u,vec2(0.5));",
  "   float z=((0.35-dist)*0.8+(smL-0.5)*0.25)*uStrength;",
  "   float edg=abs(l-lL)+abs(l-lR); z*=1.0-smoothstep(0.12,0.45,edg)*uEdge;",
  "   vec2 uL=vec2(clamp(u.x-z+conv,0.001,0.999),u.y);",
  "   vec2 uR=vec2(clamp(u.x+z-conv,0.001,0.999),u.y);",
  "   cL=toLin(texture2D(uTex,uL).rgb); cR=toLin(texture2D(uTex,uR).rgb);",
  "   if(uSwap>0.5 && uSBS<0.5){ vec3 t=cL; cL=cR; cR=t; }",
  " } else if(uSource<1.5){",
  "   vec2 lv=vec2(clamp(u.x*0.5+conv,0.0,0.5),u.y);",
  "   vec2 rv=vec2(clamp(u.x*0.5+0.5-conv,0.5,1.0),u.y);",
  "   if(uSwap>0.5){ vec2 t=lv; lv=rv; rv=t; }",
  "   cL=toLin(texture2D(uTex,lv).rgb); cR=toLin(texture2D(uTex,rv).rgb);",
  " } else if(uSource<2.5){",
  "   vec2 lv=vec2(clamp(u.x+conv,0.0,1.0),clamp(u.y*0.5+0.5,0.5,1.0));",
  "   vec2 rv=vec2(clamp(u.x-conv,0.0,1.0),clamp(u.y*0.5,0.0,0.5));",
  "   if(uSwap>0.5){ vec2 t=lv; lv=rv; rv=t; }",
  "   cL=toLin(texture2D(uTex,lv).rgb); cR=toLin(texture2D(uTex,rv).rgb);",
  " } else {",
  "   cL=toLin(texture2D(uTex,u).rgb); cR=cL;",
  " }",
  " float yL=dot(cL,LUMA),yR=dot(cR,LUMA);",
  " cL=mix(cL,vec3(yL),uDesat*(1.0-uFull)); cR=mix(cR,vec3(yR),uDesat*(1.0-uFull));",
  " vec3 outLin;",
  " if(uSource>2.5){ outLin=cL; }",
  " else if(uSource<0.5){",
  "   if(uMode<0.5) outLin=vec3(cL.r, cR.g*uGreenGain, cL.b);",
  "   else outLin=vec3(cL.r, cR.g*uGreenGain, cR.b*uGreenGain);",
  " } else {",
  "   vec3 lC=max(cL-cR*uGhost,0.0); vec3 rC=max(cR-cL*uGhost,0.0);",
  "   if(uMode<0.5) outLin=vec3(lC.r, rC.g*uGreenGain, lC.b);",
  "   else outLin=vec3(lC.r, rC.g*uGreenGain, rC.b*uGreenGain);",
  " }",
  " if(uSBS>0.5){ vec3 lens; if(uMode<0.5){ lens=(eye<0.5)?vec3(1.0,uLeak,1.0):vec3(uLeak,1.0,uLeak); } else { lens=(eye<0.5)?vec3(1.0,uLeak,uLeak):vec3(uLeak,1.0,1.0); } outLin*=lens; }",
  " gl_FragColor=mix(vec4(0.0,0.0,0.0,1.0),vec4(toSrgb(outLin),1.0),inB);","}"].join("\n");

  // ---- fixed browser settings for 2D green/magenta on-screen anaglyph ----
  const GREEN_GAIN = 0.80, DESAT = 0.35, GHOST = 0.22;   // from the app; desat/ghost unused here (full-color 2D)

  // defaults: Depth 30, Edge clean 0.2 (removes crosstalk, keeps depth), Converge 0.002 (screen-plane shift for more depth)
  if (localStorage.a3d_depth == null) localStorage.a3d_depth = '30';
  if (localStorage.a3d_edge  == null) localStorage.a3d_edge  = '0.2';
  if (localStorage.a3d_conv  == null) localStorage.a3d_conv  = '0.002';
  let on = (localStorage.a3d_on === '1');

  const depthVal = () => parseFloat(localStorage.a3d_depth || '30');
  const edgeVal  = () => parseFloat(localStorage.a3d_edge  || '0.2');
  const convVal  = () => parseFloat(localStorage.a3d_conv  || '0.002');
  const modeVal  = () => (localStorage.a3d_mode === '1') ? 1 : 0;   // 0=green/magenta, 1=red/cyan
  const swapVal  = () => (localStorage.a3d_swap === '1') ? 1 : 0;

  let gl = null, pr = null, tex = null, loc = {}, src = null, r = null, panel = null, btn = null;

  const findSrc = () =>
    [...document.querySelectorAll('video')].find(x => (x.videoWidth || x.width) > 0) ||
    document.querySelector('video');

  const compile = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.warn('[2D-to-3D] shader', gl.getShaderInfoLog(o)); return o; };

  const kill = () => {
    if (window._3D_RAF) cancelAnimationFrame(window._3D_RAF);
    window._3D_RAF = null;
    const eC = document.getElementById(CID); if (eC) eC.remove();
    if (gl) { try { const lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext(); } catch (e) {} }
    gl = null; pr = null; tex = null;
  };

  const buildPanel = () => {
    if (document.getElementById(PID)) return;
    panel = document.createElement('div'); panel.id = PID;
    Object.assign(panel.style, {
      position: 'fixed', bottom: '34px', left: '50%', transform: 'translateX(-50%)',
      zIndex: 2147483647, display: 'flex', flexDirection: 'column', gap: '8px',
      background: 'rgba(16,18,24,0.82)', padding: '10px 14px', borderRadius: '12px',
      fontFamily: 'sans-serif', fontSize: '12px', color: '#fff', transition: 'opacity 0.5s',
      opacity: '0.8', pointerEvents: 'auto', width: '300px'
    });
    let fT;
    var show = () => {
      panel.style.opacity = '0.9'; if (btn) btn.style.opacity = '0.85';
      clearTimeout(fT);
      fT = setTimeout(() => { panel.style.opacity = '0'; if (btn) btn.style.opacity = '0'; }, 4000);
    };
    const mkRow = (label, key, min, max, step, def) => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
      const lab = document.createElement('span'); lab.textContent = label;
      Object.assign(lab.style, { width: '62px', opacity: '0.85' });
      const val = document.createElement('span');
      Object.assign(val.style, { width: '42px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = min; sl.max = max; sl.step = step;
      sl.value = parseFloat(localStorage[key] != null ? localStorage[key] : def);
      Object.assign(sl.style, { flex: '1', accentColor: 'magenta', cursor: 'pointer' });
      val.textContent = sl.value;
      sl.oninput = () => { localStorage[key] = sl.value; val.textContent = sl.value; show(); };
      row.appendChild(lab); row.appendChild(sl); row.appendChild(val);
      return row;
    };
    const mkToggle = (getLabel, key) => {
      const bt = document.createElement('button');
      Object.assign(bt.style, { flex: '1', background: 'rgba(40,40,50,0.95)', color: '#fff',
        border: '1px solid #555', borderRadius: '8px', padding: '7px 8px', fontFamily: 'sans-serif',
        fontSize: '12px', fontWeight: '600', cursor: 'pointer' });
      bt.textContent = getLabel();
      bt.onclick = (e) => { e.stopPropagation(); localStorage[key] = (localStorage[key] === '1') ? '0' : '1'; bt.textContent = getLabel(); show(); };
      return bt;
    };
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '8px' });
    btnRow.appendChild(mkToggle(() => 'Color: ' + (modeVal() ? 'Red/Cyan' : 'Green/Magenta'), 'a3d_mode'));
    btnRow.appendChild(mkToggle(() => 'Swap: ' + (swapVal() ? 'ON' : 'OFF'), 'a3d_swap'));
    panel.appendChild(btnRow);
    panel.appendChild(mkRow('Depth',      'a3d_depth', 0,     60,   1,     30));
    panel.appendChild(mkRow('Edge clean', 'a3d_edge',  0,     1,    0.05,  0.2));
    panel.appendChild(mkRow('Converge',   'a3d_conv',  -0.01, 0.01, 0.001, 0.002));
    document.body.appendChild(panel);
    window._anaShow = show; show();
    document.addEventListener('mousemove', show);
    document.addEventListener('touchstart', show, { passive: true });
  };
  const killPanel = () => { const e = document.getElementById(PID); if (e) e.remove(); panel = null; };

  const start = () => {
    src = findSrc();
    if (!src) return false;

    r = document.createElement('canvas'); r.id = CID;
    Object.assign(r.style, {
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      zIndex: 2147483646, pointerEvents: 'none', display: 'block'
    });
    document.body.appendChild(r);

    // EXACT browser pipeline: WebGL1, no color-space overrides
    gl = window._3D_GL = r.getContext('webgl', { alpha: false }) || r.getContext('experimental-webgl');
    if (!gl) { r.remove(); return false; }

    pr = gl.createProgram();
    gl.attachShader(pr, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);

    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const la = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(la);
    gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 0, 0);

    ['uTex','uTexSize','uCanvasSize','uCrop','uStrength','uGreenGain','uDesat','uGhost','uConverge','uMode','uSource','uSwap','uFull','uEdge','uSBS','uLeak']
      .forEach(n => { loc[n] = gl.getUniformLocation(pr, n); });

    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const loop = () => {
      if (!gl) return;
      if (!src || !((src.videoWidth || src.width) > 0)) { const ns = findSrc(); if (ns) src = ns; }
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      if (sw > 0) {
        r.width = innerWidth; r.height = innerHeight;
        gl.viewport(0, 0, r.width, r.height);
        try {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);   // RGBA: iOS-safe for video (RGB banded on some frames)
          gl.uniform1i(loc.uTex, 0);
          gl.uniform2f(loc.uTexSize, sw, sh);
          gl.uniform2f(loc.uCanvasSize, r.width, r.height);
          gl.uniform4f(loc.uCrop, 0, 0, 1, 1);
          gl.uniform1f(loc.uStrength, (depthVal() / 100) * 0.08 * (modeVal() ? 1.4 : 1.0));   // red/cyan gets 1.4x like the app
          gl.uniform1f(loc.uGreenGain, GREEN_GAIN);
          gl.uniform1f(loc.uDesat, DESAT);
          gl.uniform1f(loc.uGhost, GHOST);
          gl.uniform1f(loc.uConverge, convVal());
          gl.uniform1f(loc.uMode, modeVal());   // 0=green/magenta, 1=red/cyan
          gl.uniform1f(loc.uSource, 0);   // 2D fake depth
          gl.uniform1f(loc.uSwap, swapVal());
          gl.uniform1f(loc.uFull, 1);     // full color
          gl.uniform1f(loc.uEdge, edgeVal());   // "Converge" slider = edge re-converge (kills crosstalk)
          gl.uniform1f(loc.uSBS, 0);
          gl.uniform1f(loc.uLeak, 0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch (e) {
          kill(); killPanel(); on = false; localStorage.a3d_on = '0'; if (btn) btn.textContent = 'MODE: 2D';
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
    kill(); killPanel();
    if (on) { if (!start()) console.warn('[2D-to-3D] No <video> found yet.'); else buildPanel(); }
  };

  const buildBtn = () => {
    if (document.getElementById(BID)) return;
    btn = document.createElement('button'); btn.id = BID; btn.textContent = 'MODE: ' + (on ? '3D' : '2D');
    Object.assign(btn.style, {
      position: 'fixed', top: '20px', left: '20px', zIndex: 2147483647,
      background: 'rgba(20,20,20,0.9)', color: '#fff', border: '1px solid #444',
      borderRadius: '8px', padding: '10px 14px', fontFamily: 'sans-serif', fontSize: '14px',
      fontWeight: '600', transition: 'opacity 0.5s', opacity: '0.7', pointerEvents: 'auto'
    });
    document.body.appendChild(btn);
    btn.onclick = (e) => {
      e.stopPropagation();
      on = !on; localStorage.a3d_on = on ? '1' : '0';
      btn.textContent = 'MODE: ' + (on ? '3D' : '2D');
      rebuild();
      if (window._anaShow) window._anaShow();
    };
  };

  buildBtn();
  if (on) { if (start()) buildPanel(); }
})();
