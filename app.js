/* =========================================================================
   Aryan Goyal — portfolio interaction layer
   -------------------------------------------------------------------------
   Everything that moves lives here. The file is split into small, named
   modules so each concern (background, cursor, buttons, reveal, nav) can be
   read and edited on its own.

   Modules
     1. utils          — tiny pure helpers
     2. store          — safe localStorage wrapper
     3. field          — WebGL scene: particle constellation, lit spheres,
                         floating wireframe, orbiting satellite, torus ring
     4. cursor         — reticle cursor (dot + dashed ring + ember aura)
     5. buttons        — classic, CSS-only (hover states in styles.css)
     6. tilt           — 3D card/hero tilt + specular glare
     7. preview        — floating project thumbnail that follows the cursor
     8. words          — headings split into words that rise on scroll
     9. reveal         — scroll-triggered entrance + directional choreography
    10. numerals       — decoding index numbers
    11. counters       — animated stat numbers
    12. parallax       — images drift inside their frames while scrolling
    13. readouts       — depth %, progress bar, local time, nav, scroll meter
    14. ticker         — the single requestAnimationFrame loop
    15. controls       — motion toggle, copy email, lifecycle

   Motion can be fully disabled (reduced motion preference, or the "Motion"
   button in the rail). When off, no WebGL runs and the native cursor returns.
   ========================================================================= */

(() => {
  "use strict";

  /* =======================================================================
     1. utils
     ======================================================================= */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);

  const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mqFine = window.matchMedia("(pointer: fine)");

  /* =======================================================================
     2. store — persisted preferences (only the motion toggle today)
     ======================================================================= */
  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }
  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* storage unavailable — ignore */
    }
  }

  const stored = readStore("ag-motion");
  let motion = stored === "on" ? true : stored === "off" ? false : !mqReduce.matches;

  /* =======================================================================
     3. field — WebGL 3D scene, driven by scroll
     -----------------------------------------------------------------------
     The background is a real 3D scene, all math done on the CPU and rendered
     with four tiny GPU programs:

       · ink-on-paper particle constellation with linking lines
       · two lit spheres with a small satellite orbiting the bigger one
       · a spinning icosahedron wireframe (hero element, fades on scroll)
       · a tumbling torus ring (fades in and travels up as you scroll)

     Scroll progress (0..1) moves the whole scene: the cloud rotates, the
     particles accelerate, the shapes travel across the screen, and the
     accent color drifts from ember to blue as you go deeper into the page.

     If WebGL is not available the canvas stays transparent and the CSS
     gradient behind it still shows — the site never breaks.
     ======================================================================= */
  const field = (() => {
    const canvas = document.getElementById("field");
    if (!canvas) return noopModule();

    const gl =
      canvas.getContext("webgl", { alpha: true, antialias: false }) ||
      canvas.getContext("experimental-webgl", { alpha: true, antialias: false });
    if (!gl) return noopModule();

    const VERT = `
      attribute vec2 aPos;
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        gl_Position = vec4(aPos, 0.0, 1.0);
        gl_PointSize = aSize;
      }
    `;
    const FRAG_POINT = `
      precision mediump float;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float dist = length(d);
        float a = smoothstep(0.5, 0.0, dist);
        a *= a;
        gl_FragColor = vec4(vColor, a * vAlpha);
      }
    `;
    const FRAG_LINE = `
      precision mediump float;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `;

    // lit sphere impostor — a quad that shades itself like a ball
    const VERT_SPHERE = `
      attribute vec2 aPos;
      attribute vec2 aUV;
      varying vec2 vUV;
      void main() {
        vUV = aUV;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const FRAG_SPHERE = `
      precision mediump float;
      varying vec2 vUV;
      uniform vec3 uLight;
      void main() {
        vec2 uv = vUV;
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;
        float z = sqrt(1.0 - r2);
        vec3 n = vec3(uv, z);
        float diff = max(dot(n, uLight), 0.0);
        float rim = pow(1.0 - z, 2.0);
        vec3 base = vec3(0.86, 0.82, 0.74);
        vec3 ember = vec3(1.0, 0.478, 0.239);
        vec3 col = base * (0.42 + 0.58 * diff) + ember * rim * 0.55;
        gl_FragColor = vec4(col, 0.88);
      }
    `;

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    }
    function link(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      return p;
    }

    const pointProgram = link(compile(gl.VERTEX_SHADER, VERT), compile(gl.FRAGMENT_SHADER, FRAG_POINT));
    const lineProgram = link(compile(gl.VERTEX_SHADER, VERT), compile(gl.FRAGMENT_SHADER, FRAG_LINE));
    const sphereProgram = link(compile(gl.VERTEX_SHADER, VERT_SPHERE), compile(gl.FRAGMENT_SHADER, FRAG_SPHERE));

    const attrib = (prog, name, size) => ({ loc: gl.getAttribLocation(prog, name), size });
    const pointSpec = {
      pos: attrib(pointProgram, "aPos", 2),
      size: attrib(pointProgram, "aSize", 1),
      color: attrib(pointProgram, "aColor", 3),
      alpha: attrib(pointProgram, "aAlpha", 1)
    };
    const lineSpec = {
      pos: attrib(lineProgram, "aPos", 2),
      size: attrib(lineProgram, "aSize", 1),
      color: attrib(lineProgram, "aColor", 3),
      alpha: attrib(lineProgram, "aAlpha", 1)
    };
    const sphereSpec = {
      pos: attrib(sphereProgram, "aPos", 2),
      uv: attrib(sphereProgram, "aUV", 2)
    };
    const uLight = gl.getUniformLocation(sphereProgram, "uLight");
    const pointStride = (2 + 1 + 3 + 1) * 4;
    const sphereStride = (2 + 2) * 4;

    // palette — ink dots on warm paper, plus the scroll-shifted accent
    // (ember at the top of the page, drifting toward blue as you scroll)
    const COOL = [0.35, 0.34, 0.36];
    const EMBER_DEEP = [0.76, 0.31, 0.09];
    const BLUE = [0.21, 0.39, 0.91];
    function mix3(a, b, t) {
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    }

    let w = 0;
    let h = 0;
    let dpr = 1;
    let pts = [];
    let running = false;
    let t = 0;
    let nearSegs = [];

    const pointBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();
    const sphereBuffer = gl.createBuffer();

    const shape = buildIcosahedron();
    const torus = buildTorus(1, 0.42, 14, 9);

    function buildIcosahedron() {
      const g = (1 + Math.sqrt(5)) / 2;
      const raw = [
        [-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0],
        [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g],
        [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]
      ];
      const v = raw.map((p) => {
        const l = Math.hypot(p[0], p[1], p[2]);
        return [p[0] / l, p[1] / l, p[2] / l];
      });
      let min = Infinity;
      for (let i = 0; i < 12; i++) {
        for (let j = i + 1; j < 12; j++) {
          const d = Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1], v[i][2] - v[j][2]);
          if (d < min) min = d;
        }
      }
      const edges = [];
      for (let i = 0; i < 12; i++) {
        for (let j = i + 1; j < 12; j++) {
          const d = Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1], v[i][2] - v[j][2]);
          if (Math.abs(d - min) < 0.001) edges.push([i, j]);
        }
      }
      return { v, edges };
    }

    function buildTorus(R, r, uN, vN) {
      const pts = [];
      const edges = [];
      for (let i = 0; i < uN; i++) {
        for (let j = 0; j < vN; j++) {
          const u = (i / uN) * Math.PI * 2;
          const v = (j / vN) * Math.PI * 2;
          const x = (R + r * Math.cos(v)) * Math.cos(u);
          const y = (R + r * Math.cos(v)) * Math.sin(u);
          const z = r * Math.sin(v);
          pts.push([x, y, z]);
          const idx = i * vN + j;
          const idxU = ((i + 1) % uN) * vN + j;
          const idxV = i * vN + ((j + 1) % vN);
          edges.push([idx, idxU], [idx, idxV]);
        }
      }
      return { pts, edges };
    }

    function build() {
      const count = w < 760 ? 150 : w < 1280 ? 240 : 320;
      pts = new Array(count);
      for (let i = 0; i < count; i++) {
        const hot = Math.random() < 0.1;
        pts[i] = {
          x: rand(-1, 1),
          y: rand(-1, 1),
          z: rand(0.03, 1),
          vx: rand(-0.03, 0.03),
          vy: rand(-0.03, 0.03),
          vz: rand(0.003, 0.011),
          r: rand(0.92, 1.08),
          g: rand(0.92, 1.08),
          b: rand(0.92, 1.08),
          hot
        };
      }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      build();
    }

    function start() {
      if (running) return;
      running = true;
      if (!w || !h || canvas.clientWidth !== w || canvas.clientHeight !== h) resize();
    }

    function stop() {
      running = false;
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // project a rotated world point to screen space
    function project(p, cos, sin, ox, oy, spread) {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      const scale = 1 / (1 + (1 - p.z) * 2.2);
      return [ox + rx * spread * scale, oy + ry * spread * scale];
    }

    // write one sphere quad (2 triangles) into data at offset o; returns next offset
    function writeQuad(data, o, cx, cy, r) {
      const x0 = ((cx - r) / w) * 2 - 1;
      const x1 = ((cx + r) / w) * 2 - 1;
      const y0 = -(((cy - r) / h) * 2 - 1);
      const y1 = -(((cy + r) / h) * 2 - 1);
      const v = [
        x0, y0, -1, -1, x1, y1, 1, 1, x1, y0, 1, -1,
        x0, y0, -1, -1, x0, y1, -1, 1, x1, y1, 1, 1
      ];
      for (let i = 0; i < v.length; i++) data[o + i] = v[i];
      return o + v.length;
    }

    function frame(dt, pct, vel, parallaxX, parallaxY, pointer) {
      if (!running || !w) return;
      t += dt * 0.016;

      // the whole scene responds to scroll: the cloud rotates, the particles
      // fly faster, the shapes shift with the scroll, and the accent color
      // drifts from ember to blue as you go deeper into the page
      const rot = t * 0.05 + pct * 1.4;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const spread = Math.max(w, h) * 0.78;
      const speed = 1 + pct * 1.8 + vel * 0.35;
      const accent = mix3(EMBER_DEEP, BLUE, pct);
      const ox = w * 0.5 + parallaxX;
      const oy = h * 0.5 + parallaxY;
      const ptx = pointer.active ? pointer.x : -9999;
      const pty = pointer.active ? pointer.y : -9999;

      gl.clear(gl.COLOR_BUFFER_BIT);

      /* ---- lit spheres — stay centered and grow as you scroll ---- */
      if (w >= 640) {
        gl.useProgram(sphereProgram);

        const ll = Math.hypot(-0.55 + parallaxX * 0.0012, -0.72 + parallaxY * 0.0012, 0.5);
        gl.uniform3f(uLight, (-0.55 + parallaxX * 0.0012) / ll, (-0.72 + parallaxY * 0.0012) / ll, 0.5 / ll);

        const bigR = Math.min(w, h) * 0.19 * (1 + pct * 0.7);
        const bigCx = w * 0.5 + parallaxX * 1.1;
        const bigCy = h * 0.5 + parallaxY * 0.9 + Math.sin(t * 0.7) * 10;

        // satellite — orbits the big sphere, shrinks when passing "behind"
        const orbit = t * (0.8 + pct * 2.2);
        const depth = Math.sin(orbit);
        const satR = bigR * (0.15 + 0.07 * (depth + 1));
        const satCx = bigCx + Math.cos(orbit) * bigR * 1.95;
        const satCy = bigCy + depth * bigR * 1.05;

        const sphereData = new Float32Array(6 * 4 * 2);
        let sOff = writeQuad(sphereData, 0, satCx, satCy, satR);
        sOff = writeQuad(sphereData, sOff, bigCx, bigCy, bigR);
        gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, sphereData, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(sphereSpec.pos.loc);
        gl.vertexAttribPointer(sphereSpec.pos.loc, 2, gl.FLOAT, false, sphereStride, 0);
        gl.enableVertexAttribArray(sphereSpec.uv.loc);
        gl.vertexAttribPointer(sphereSpec.uv.loc, 2, gl.FLOAT, false, sphereStride, 2 * 4);
        gl.drawArrays(gl.TRIANGLES, 0, 12);
      }

      /* ---- particle constellation ---- */
      const pointData = new Float32Array(pts.length * 7);
      const screen = new Array(pts.length);

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];

        p.z += p.vz * dt * speed;
        if (p.z >= 1) {
          p.z = rand(0.02, 0.08);
          p.x = rand(-1, 1);
          p.y = rand(-1, 1);
        }
        p.x += p.vx * dt * 0.016;
        p.y += p.vy * dt * 0.016;

        let sx, sy;
        [sx, sy] = project(p, cos, sin, ox, oy, spread);

        // gentle repulsion from the cursor so the field feels alive
        const dx = sx - ptx;
        const dy = sy - pty;
        const d2 = dx * dx + dy * dy;
        if (pointer.active && d2 < 19600 && d2 > 0.5) {
          const d = Math.sqrt(d2);
          const force = (1 - d / 140) * 26;
          sx += (dx / d) * force;
          sy += (dy / d) * force;
        }

        if (sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) {
          screen[i] = null;
          continue;
        }

        const size = (1.15 + p.z * 2.6) * (p.hot ? 1.85 : 1) * dpr;
        const alpha = (0.12 + 0.8 * p.z) * (p.hot ? 0.95 : 0.7);

        screen[i] = [sx, sy];
        const o = i * 7;
        pointData[o] = (sx / w) * 2 - 1;
        pointData[o + 1] = -((sy / h) * 2 - 1);
        pointData[o + 2] = size;
        if (p.hot) {
          pointData[o + 3] = accent[0];
          pointData[o + 4] = accent[1];
          pointData[o + 5] = accent[2];
          pointData[o + 6] = 0.9;
        } else {
          pointData[o + 3] = COOL[0] * p.r;
          pointData[o + 4] = COOL[1] * p.g;
          pointData[o + 5] = COOL[2] * p.b;
          pointData[o + 6] = (0.1 + 0.5 * p.z) * 0.85;
        }
      }

      gl.useProgram(pointProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.DYNAMIC_DRAW);
      bindAttribs(pointSpec, pointStride);
      gl.drawArrays(gl.POINTS, 0, pts.length);

      /* ---- constellation lines ---- */
      const THRESHOLD = 140;
      const MAX_SEGS = 220;
      nearSegs.length = 0;
      for (let i = 0; i < pts.length; i++) {
        if (!screen[i]) continue;
        for (let j = i + 1; j < pts.length; j++) {
          if (!screen[j]) continue;
          const dx = screen[i][0] - screen[j][0];
          const dy = screen[i][1] - screen[j][1];
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < THRESHOLD) {
            nearSegs.push([screen[i], screen[j], 1 - d / THRESHOLD]);
            if (nearSegs.length >= MAX_SEGS) break;
          }
        }
        if (nearSegs.length >= MAX_SEGS) break;
      }

      if (nearSegs.length) {
        const lineData = new Float32Array(nearSegs.length * 2 * 7);
        for (let i = 0; i < nearSegs.length; i++) {
          const seg = nearSegs[i];
          const a = seg[0];
          const b = seg[1];
          const alpha = seg[2] * 0.32;
          let o = i * 14;
          lineData[o] = (a[0] / w) * 2 - 1;
          lineData[o + 1] = -((a[1] / h) * 2 - 1);
          lineData[o + 2] = 1;
          lineData[o + 3] = accent[0];
          lineData[o + 4] = accent[1];
          lineData[o + 5] = accent[2];
          lineData[o + 6] = alpha;
          o += 7;
          lineData[o] = (b[0] / w) * 2 - 1;
          lineData[o + 1] = -((b[1] / h) * 2 - 1);
          lineData[o + 2] = 1;
          lineData[o + 3] = accent[0];
          lineData[o + 4] = accent[1];
          lineData[o + 5] = accent[2];
          lineData[o + 6] = alpha;
        }
        gl.useProgram(lineProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
        bindAttribs(lineSpec, pointStride);
        gl.drawArrays(gl.LINES, 0, nearSegs.length * 2);
      }

      if (w >= 640) {
        /* ---- icosahedron wireframe — a hero element, fades as you scroll away ---- */
        const spin = t * 0.4 + pct * 2;
        const cs2 = Math.cos(spin);
        const ss2 = Math.sin(spin);
        const fade = clamp(1 - pct * 2.4, 0, 1);
        const shapeCx = w * 0.74 + parallaxX * 1.6;
        const shapeCy = lerp(h * 0.32, h * 0.55, pct) + parallaxY * 1.4 + Math.sin(t * 0.9) * 12;
        const shapeR = Math.min(w, h) * 0.27;
        const tilt = parallaxY * 0.0011;
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const shapeCol = mix3(COOL, accent, 0.45);

        if (fade > 0.03) {
          const shapeData = new Float32Array(shape.edges.length * 2 * 7);
          for (let i = 0; i < shape.edges.length; i++) {
            const ia = shape.edges[i][0];
            const ib = shape.edges[i][1];
            for (let k = 0; k < 2; k++) {
              const p = shape.v[k === 0 ? ia : ib];
              let vx = p[0] * cs2 + p[2] * ss2;
              let vz = -p[0] * ss2 + p[2] * cs2;
              let vy = p[1];
              const vy2 = vy * ct - vz * st;
              vz = vy * st + vz * ct;
              vy = vy2;
              const d01 = (vz + 1) / 2;
              const sc = 1 / (1 + (1 - d01) * 2.2);
              const sx = shapeCx + vx * shapeR * sc;
              const sy = shapeCy + vy * shapeR * sc;
              const o = (i * 2 + k) * 7;
              shapeData[o] = (sx / w) * 2 - 1;
              shapeData[o + 1] = -((sy / h) * 2 - 1);
              shapeData[o + 2] = 1;
              shapeData[o + 3] = shapeCol[0];
              shapeData[o + 4] = shapeCol[1];
              shapeData[o + 5] = shapeCol[2];
              shapeData[o + 6] = 0.5 * fade;
            }
          }
          gl.useProgram(lineProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, shapeData, gl.DYNAMIC_DRAW);
          bindAttribs(lineSpec, pointStride);
          gl.drawArrays(gl.LINES, 0, shape.edges.length * 2);
        }

        /* ---- torus ring — fades in and travels up the page as you scroll ---- */
        const ts = Math.sin(t * 0.5);
        const tc = Math.cos(t * 0.5);
        const tiltT = -0.55 + parallaxX * 0.001;
        const tt = Math.cos(tiltT);
        const tu = Math.sin(tiltT);
        const fadeIn = clamp((pct - 0.12) * 1.7, 0, 1);
        const torusScale = Math.min(w, h) * 0.15;
        const torusCx = lerp(w * 0.84, w * 0.6, pct) + parallaxX * 1.3;
        const torusCy = lerp(h * 0.75, h * 0.24, pct) + parallaxY * 1.1;

        if (fadeIn > 0.03) {
          const torusData = new Float32Array(torus.edges.length * 2 * 7);
          for (let i = 0; i < torus.edges.length; i++) {
            for (let k = 0; k < 2; k++) {
              const p = torus.pts[torus.edges[i][k]];
              let vx = p[0] * tc + p[2] * ts;
              let vz = -p[0] * ts + p[2] * tc;
              let vy = p[1];
              const vy2 = vy * tt - vz * tu;
              vz = vy * tu + vz * tt;
              vy = vy2;
              const depth = clamp((vz / 0.42) * 0.5 + 0.5, 0, 1);
              const sc = 1 / (1 + (1 - depth) * 1.8);
              const sx = torusCx + vx * torusScale * sc;
              const sy = torusCy + vy * torusScale * sc;
              const o = (i * 2 + k) * 7;
              torusData[o] = (sx / w) * 2 - 1;
              torusData[o + 1] = -((sy / h) * 2 - 1);
              torusData[o + 2] = 1;
              torusData[o + 3] = accent[0];
              torusData[o + 4] = accent[1];
              torusData[o + 5] = accent[2];
              torusData[o + 6] = 0.34 * fadeIn * (0.45 + depth * 0.55);
            }
          }
          gl.useProgram(lineProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, torusData, gl.DYNAMIC_DRAW);
          bindAttribs(lineSpec, pointStride);
          gl.drawArrays(gl.LINES, 0, torus.edges.length * 2);
        }
      }
    }

    function bindAttribs(spec, stride) {
      gl.enableVertexAttribArray(spec.pos.loc);
      gl.vertexAttribPointer(spec.pos.loc, spec.pos.size, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(spec.size.loc);
      gl.vertexAttribPointer(spec.size.loc, spec.size.size, gl.FLOAT, false, stride, 2 * 4);
      gl.enableVertexAttribArray(spec.color.loc);
      gl.vertexAttribPointer(spec.color.loc, spec.color.size, gl.FLOAT, false, stride, 3 * 4);
      gl.enableVertexAttribArray(spec.alpha.loc);
      gl.vertexAttribPointer(spec.alpha.loc, spec.alpha.size, gl.FLOAT, false, stride, 6 * 4);
    }

    return {
      start,
      stop,
      frame,
      resize,
      isOn: () => running
    };
  })();

  function noopModule() {
    return {
      start() {},
      stop() {},
      frame() {},
      resize() {},
      isOn: () => false
    };
  }

  /* =======================================================================
     4. cursor — reticle design
     -----------------------------------------------------------------------
     Three layers move at different speeds:
       · dot  — precise aiming point, snaps almost instantly
       · ring — dashed circle, lags behind and rotates like a dial
       · glow — soft ember aura that drags behind everything

     States (toggled via pointerover):
       .is-link   hovering a link / button (ring grows, spins faster)
       .is-media  hovering a work card (ring fills, "Open" chip appears)
       .is-text   over an input (native caret wins, cursor hides)
       .is-down   mouse button held (ring contracts)
     ======================================================================= */
  const cursorEl = document.getElementById("cursor");
  const dotEl = document.getElementById("cursor-dot");
  const ringEl = document.getElementById("cursor-ring");
  const glowEl = document.getElementById("cursor-glow");
  const labelEl = document.getElementById("cursor-label");

  const pointer = { x: -200, y: -200, rx: -200, ry: -200, gx: -200, gy: -200, active: false, init: false };

  let cursorOn = false;

  function cursorStart() {
    if (cursorOn || !cursorEl || !motion || !mqFine.matches) return;
    cursorOn = true;
    document.body.classList.add("has-cursor");
    cursorEl.classList.add("is-on");
  }
  function cursorStop() {
    if (!cursorOn) return;
    cursorOn = false;
    document.body.classList.remove("has-cursor");
    cursorEl.classList.remove("is-on", "is-link", "is-media", "is-down");
    pointer.init = false;
  }

  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.active = true;
      if (!pointer.init) {
        pointer.rx = pointer.x;
        pointer.ry = pointer.y;
        pointer.gx = pointer.x;
        pointer.gy = pointer.y;
        pointer.init = true;
      }

      if (cursorOn && e.target && e.target.closest) {
        const row = e.target.closest(".work__row");
        const media = row ? row.querySelector("[data-tilt]") : null;
        const textTarget = e.target.closest("input, textarea");
        const link = e.target.closest("a, button, label");
        const labeled = e.target.closest("[data-cursor]");
        cursorEl.classList.toggle("is-media", !!media);
        cursorEl.classList.toggle("is-link", !media && !!link);
        cursorEl.classList.toggle("is-hidden", !!textTarget);
        if (labelEl) {
          labelEl.textContent = media
            ? media.getAttribute("data-cursor") || "Open"
            : labeled
            ? labeled.getAttribute("data-cursor")
            : "";
        }
      }
    },
    { passive: true }
  );

  document.addEventListener("pointerdown", () => cursorOn && cursorEl.classList.add("is-down"));
  document.addEventListener("pointerup", () => cursorOn && cursorEl.classList.remove("is-down"));
  document.addEventListener("pointerleave", () => {
    pointer.active = false;
    cursorOn && cursorEl.classList.remove("is-on");
  });
  document.addEventListener("pointerenter", () => cursorOn && cursorEl.classList.add("is-on"));

  function cursorFrame() {
    if (!cursorOn) return;

    // dot snaps fast, ring is a slow spring, glow drags even more
    const dx = lerp(pointer.rx, pointer.x, 0.5);
    const dy = lerp(pointer.ry, pointer.y, 0.5);
    pointer.rx = lerp(pointer.rx, pointer.x, 0.15);
    pointer.ry = lerp(pointer.ry, pointer.y, 0.15);
    pointer.gx = lerp(pointer.gx, pointer.x, 0.06);
    pointer.gy = lerp(pointer.gy, pointer.y, 0.06);

    cursorEl.style.transform = `translate3d(${pointer.rx}px, ${pointer.ry}px, 0)`;
    dotEl.style.transform =
      `translate3d(-50%,-50%,0) translate3d(${(dx - pointer.rx).toFixed(2)}px, ${(dy - pointer.ry).toFixed(2)}px, 0)`;
    glowEl.style.transform =
      `translate3d(-50%,-50%,0) translate3d(${(pointer.gx - pointer.rx).toFixed(2)}px, ${(pointer.gy - pointer.ry).toFixed(2)}px, 0)`;
  }

  /* =======================================================================
     5. buttons — classic, CSS-only
     -----------------------------------------------------------------------
     Buttons deliberately behave like normal buttons: solid fill, a color
     change on hover, the arrow nudges, and a small press scale on click.
     All of it lives in styles.css (.btn*); no JS drives them.
     ======================================================================= */

  /* =======================================================================
     6. tilt — 3D card tilt for work images + specular glare
     ======================================================================= */
  const heroFrame = document.getElementById("hero-frame");
  const heroStack = heroFrame ? heroFrame.parentElement : null;
  if (heroFrame && heroStack) {
    heroStack.addEventListener(
      "pointermove",
      (e) => {
        if (!motion || !mqFine.matches) return;
        const r = heroStack.getBoundingClientRect();
        const nx = clamp((e.clientX - (r.left + r.width * 0.5)) / (r.width * 0.5), -1.2, 1.2);
        const ny = clamp((e.clientY - (r.top + r.height * 0.5)) / (r.height * 0.5), -1.2, 1.2);
        heroFrame.style.setProperty("--px", nx.toFixed(3));
        heroFrame.style.setProperty("--py", ny.toFixed(3));
      },
      { passive: true }
    );
    heroStack.addEventListener("pointerleave", () => {
      heroFrame.style.setProperty("--px", "0");
      heroFrame.style.setProperty("--py", "0");
    });
  }

  document.querySelectorAll(".work__row").forEach((row) => {
    const media = row.querySelector("[data-tilt]");
    const tilt = media ? media.querySelector(".tilt") : null;
    if (!media || !tilt) return;
    row.addEventListener(
      "pointermove",
      (e) => {
        if (!motion || !mqFine.matches) return;
        const r = media.getBoundingClientRect();
        const nx = clamp((e.clientX - r.left) / r.width, -0.4, 1.4);
        const ny = clamp((e.clientY - r.top) / r.height, -0.4, 1.4);
        tilt.style.setProperty("--tx", (nx - 0.5).toFixed(3));
        tilt.style.setProperty("--ty", (ny - 0.5).toFixed(3));
        tilt.style.setProperty("--mx", (nx * 100).toFixed(1));
        tilt.style.setProperty("--my", (ny * 100).toFixed(1));
      },
      { passive: true }
    );
    row.addEventListener("pointerleave", () => {
      tilt.style.setProperty("--tx", "0");
      tilt.style.setProperty("--ty", "0");
    });
  });

  /* =======================================================================
     7. preview — floating project thumbnail that follows the cursor
     -----------------------------------------------------------------------
     Hovering the text side of a work row pulls up a live thumbnail of that
     project near the cursor. It eases to the pointer, tilts with movement,
     and flips to the other side of the cursor near screen edges.
     ======================================================================= */
  const previewEl = document.createElement("div");
  previewEl.className = "preview";
  previewEl.setAttribute("aria-hidden", "true");
  previewEl.innerHTML = '<img alt="" /><span class="preview__label">View project</span>';
  document.body.appendChild(previewEl);
  const previewImg = previewEl.querySelector("img");
  const pv = { x: -400, y: -400, rx: -400, ry: -400, rot: 0, on: false };

  document.querySelectorAll(".work__row").forEach((row) => {
    const img = row.querySelector(".tilt img");
    if (!img) return;
    row.addEventListener(
      "pointermove",
      (e) => {
        if (!motion || !mqFine.matches) return;
        pv.x = e.clientX;
        pv.y = e.clientY;
        const overMedia = e.target.closest && e.target.closest(".work__media");
        const wasOn = pv.on;
        pv.on = !overMedia;
        if (pv.on) {
          if (!wasOn) {
            pv.rx = pv.x + 42;
            pv.ry = pv.y - 150;
          }
          if (previewImg.src !== img.src) previewImg.src = img.src;
        }
        previewEl.classList.toggle("is-on", pv.on);
      },
      { passive: true }
    );
    row.addEventListener("pointerleave", () => {
      pv.on = false;
      previewEl.classList.remove("is-on");
    });
  });

  function previewFrame() {
    if (!pv.on) return;
    const prevX = pv.rx;
    const pw = previewEl.offsetWidth || 280;
    const ph = previewEl.offsetHeight || 176;

    // flip to the other side of the cursor near the edges
    let tx = pv.x + 42;
    let ty = pv.y - 150;
    if (tx + pw > innerWidth - 16) tx = pv.x - pw - 42;
    if (ty < 16) ty = pv.y + 42;
    if (ty + ph > innerHeight - 16) ty = pv.y - ph - 42;

    pv.rx = lerp(pv.rx, tx, 0.14);
    pv.ry = lerp(pv.ry, ty, 0.14);
    pv.rot = clamp(lerp(pv.rot, clamp((pv.rx - prevX) * 0.55, -10, 10), 0.1), -12, 12);

    previewEl.style.left = pv.rx.toFixed(1) + "px";
    previewEl.style.top = pv.ry.toFixed(1) + "px";
    previewEl.style.rotate = pv.rot.toFixed(1) + "deg";
  }

  /* =======================================================================
     8. words — headings split into words that rise one by one on scroll
     ======================================================================= */
  function splitWords(el) {
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const words = node.textContent.split(/\s+/).filter(Boolean);
        if (!words.length) return;
        const frag = document.createDocumentFragment();
        words.forEach((w, i) => {
          const outer = document.createElement("span");
          outer.className = "word";
          outer.style.setProperty("--i", i);
          const inner = document.createElement("span");
          inner.className = "word__in";
          inner.textContent = w;
          outer.appendChild(inner);
          frag.appendChild(outer);
          frag.appendChild(document.createTextNode(" "));
        });
        node.replaceWith(frag);
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains("word")) {
        Array.from(node.childNodes).forEach(walk);
      }
    };
    walk(el);
    el.classList.add("words");
  }

  const wordTargets = Array.from(document.querySelectorAll(".section__head h2, .contact__title"));
  if ("IntersectionObserver" in window) {
    const wio = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          wio.unobserve(entry.target);
        });
      },
      { threshold: 0.35 }
    );
    wordTargets.forEach((el) => {
      splitWords(el);
      wio.observe(el);
    });
  }

  /* =======================================================================
     9. reveal — scroll-triggered entrance (directional via CSS)
     ======================================================================= */
  const revealItems = Array.from(document.querySelectorAll(".reveal"));
  if ("IntersectionObserver" in window) {
    revealItems.forEach((el) => {
      const sibs = el.parentElement ? Array.from(el.parentElement.children) : [el];
      const pos = sibs.indexOf(el);
      el.style.setProperty("--d", Math.min(pos * 70, 280) + Math.round(rand(-8, 8)) + "ms");
    });
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
    );
    revealItems.forEach((el) => io.observe(el));
  } else {
    revealItems.forEach((el) => el.classList.add("is-in"));
  }

  /* =======================================================================
     10. numerals — decode the 001/002… index numbers on scroll
     ======================================================================= */
  document.querySelectorAll(".work__idx").forEach((el) => {
    const final = el.textContent;
    if (!motion || !("IntersectionObserver" in window)) return;
    const dec = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          dec.unobserve(el);
          const start = performance.now();
          (function run(now) {
            const p = clamp((now - start) / 620, 0, 1);
            if (p >= 1) {
              el.textContent = final;
              return;
            }
            let out = "";
            for (let i = 0; i < final.length; i++) {
              out += p > i / final.length ? final[i] : String(Math.floor(rand(0, 10)));
            }
            el.textContent = out;
            raf(run);
          })(start);
        });
      },
      { threshold: 0.6 }
    );
    dec.observe(el);
  });

  /* =======================================================================
     11. counters — stat numbers count up when they scroll into view
     ======================================================================= */
  document.querySelectorAll(".stats__num[data-count]").forEach((el) => {
    const target = parseInt(el.getAttribute("data-count"), 10) || 0;
    const suffix = el.getAttribute("data-suffix") || "";
    const render = (v) => {
      el.innerHTML = String(Math.round(v)).padStart(2, "0") + (suffix ? `<em>${suffix}</em>` : "");
    };
    if (!motion || !("IntersectionObserver" in window)) {
      render(target);
      return;
    }
    const cio = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          cio.unobserve(el);
          const start = performance.now();
          (function run(now) {
            const p = clamp((now - start) / 1100, 0, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            render(target * eased);
            if (p < 1) raf(run);
          })(start);
        });
      },
      { threshold: 0.6 }
    );
    cio.observe(el);
  });

  /* =======================================================================
     12. parallax — images drift inside their frames while scrolling
     ======================================================================= */
  const parallaxEls = Array.from(document.querySelectorAll(".tilt img, .record__media img"));
  function parallaxMedia() {
    for (let i = 0; i < parallaxEls.length; i++) {
      const el = parallaxEls[i];
      const r = el.getBoundingClientRect();
      if (r.bottom < -60 || r.top > innerHeight + 60) continue;
      const p = (innerHeight / 2 - (r.top + r.height / 2)) / innerHeight;
      el.style.setProperty("--shift", (clamp(p, -0.6, 0.6) * 11).toFixed(1) + "%");
    }
  }

  /* =======================================================================
     13. readouts — depth %, progress bar, local time, nav, scroll meter
     ======================================================================= */
  const depthEl = document.getElementById("readout-depth");
  const timeEl = document.getElementById("readout-time");
  const meterPath = document.getElementById("meter");
  const progressBar = document.getElementById("progress-bar");
  const navLinks = Array.from(document.querySelectorAll("[data-nav]"));
  const sections = navLinks
    .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
    .filter(Boolean);
  const meterHist = new Array(24).fill(0);

  function setTime() {
    if (!timeEl) return;
    try {
      timeEl.textContent =
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date()) + " IST";
    } catch (_) {
      timeEl.textContent = "--:--";
    }
  }
  setTime();
  setInterval(setTime, 30000);

  function onScroll() {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const pct = clamp((scrollY / max) * 100, 0, 100);
    if (depthEl) depthEl.textContent = String(Math.round(pct)).padStart(4, "0");
    if (progressBar) progressBar.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    parallaxMedia();

    const mark = innerHeight * 0.34;
    let active = -1;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= mark) active = i;
    }
    navLinks.forEach((a, i) => a.classList.toggle("is-active", i === active));
  }
  let scrollTick = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollTick) return;
      scrollTick = true;
      raf(() => {
        scrollTick = false;
        onScroll();
      });
    },
    { passive: true }
  );
  onScroll();

  /* =======================================================================
     14. ticker — the one animation loop that drives everything
     ======================================================================= */
  let rafId = 0;
  let last = 0;
  let scrollS = scrollY;
  let vel = 0;
  let frameNo = 0;
  let parallax = { x: 0, y: 0 };

  function tick(now) {
    rafId = raf(tick);
    const dt = last ? clamp((now - last) / 16.667, 0.25, 3) : 1;
    last = now;
    frameNo++;

    const prevScroll = scrollS;
    scrollS = lerp(scrollS, scrollY, 0.12);
    vel = lerp(vel, Math.abs(scrollS - prevScroll), 0.28);

    if (cursorOn) {
      cursorFrame();
      parallax.x = lerp(parallax.x, (pointer.x / innerWidth - 0.5) * 26, 0.06);
      parallax.y = lerp(parallax.y, (pointer.y / innerHeight - 0.5) * 20, 0.06);
    }

    previewFrame();

    if (field.isOn()) {
      // scroll progress (0..1) drives the whole scene — shapes travel, the
      // cloud spins, particles accelerate, and the accent color shifts
      const docH = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const pct = clamp(scrollS / docH, 0, 1);
      field.frame(dt, pct, vel, parallax.x, parallax.y, {
        x: pointer.active ? pointer.rx : -9999,
        y: pointer.active ? pointer.ry : -9999,
        active: pointer.active
      });
    }

    if (meterPath && frameNo % 2 === 0) {
      meterHist.push(vel);
      meterHist.shift();
      let d = "M0 11";
      for (let i = 0; i < meterHist.length; i++) {
        const x = (i / (meterHist.length - 1)) * 120;
        const amp = clamp(meterHist[i] * 1.5, 0, 9);
        const y = 11 + Math.sin(frameNo * 0.06 + i * 0.55) * 0.9 - amp * (i % 2 ? -1 : 1);
        d += ` L${x.toFixed(1)} ${clamp(y, 1, 21).toFixed(1)}`;
      }
      meterPath.setAttribute("d", d);
    }
  }

  function startTicker() {
    if (rafId) return;
    last = 0;
    rafId = raf(tick);
  }
  function stopTicker() {
    if (!rafId) return;
    caf(rafId);
    rafId = 0;
  }

  /* =======================================================================
     15. controls — motion toggle, copy email, lifecycle
     ======================================================================= */
  const toggle = document.getElementById("motion-toggle");
  const toggleState = document.getElementById("motion-state");

  function setMotion(on, persist) {
    motion = on;
    document.body.classList.toggle("motion-off", !on);
    if (toggleState) toggleState.textContent = on ? "full" : "reduced";
    if (persist) writeStore("ag-motion", on ? "on" : "off");
    if (on) {
      field.start();
      startTicker();
      cursorStart();
    } else {
      field.stop();
      stopTicker();
      cursorStop();
    }
  }
  toggle && toggle.addEventListener("click", () => setMotion(!motion, true));

  const copyBtn = document.getElementById("copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const label = document.getElementById("copy-label");
      const value = copyBtn.getAttribute("data-email") || "";
      const done = (ok) => {
        if (!label) return;
        label.textContent = ok ? "Copied" : "Copy failed";
        copyBtn.classList.toggle("is-done", ok);
        setTimeout(() => {
          label.textContent = "Copy address";
          copyBtn.classList.remove("is-done");
        }, 2200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => done(true), () => done(false));
      } else {
        done(false);
      }
    });
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => field.isOn() && field.resize(), 200);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTicker();
      field.stop();
    } else if (motion) {
      field.start();
      startTicker();
    }
  });

  mqReduce.addEventListener("change", () => {
    if (!stored) setMotion(!mqReduce.matches, false);
  });

  setMotion(motion, false);
})();
