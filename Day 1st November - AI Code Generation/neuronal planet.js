/* Neural canvas background: neurons connected to a CPU with sparks traveling links */
(function neuralBackground(){
    const canvas = document.getElementById('neuralCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const glCanvas = document.getElementById('glCanvas');
    const gl = glCanvas ? (glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl')) : null;
    let w = innerWidth, h = innerHeight, dpr = Math.max(1, window.devicePixelRatio || 1);
    let nodes = [], edges = [], sparks = [], center = {x: w/2, y: h/2};
    let rotation = 0; // planet rotation
    const rotationSpeedBase = 0.00035;
    let planetRadius = Math.min(w,h) * 0.48;
    let running = true;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { canvas.style.display = 'none'; if (glCanvas) glCanvas.style.display='none'; return; }

    // controls
    const paletteSelect = document.getElementById('paletteSelect');
    const intensityRange = document.getElementById('intensityRange');
    const hoverToggle = document.getElementById('hoverToggle');
    const gpuToggle = document.getElementById('gpuToggle');
    const nodeTooltip = document.getElementById('nodeTooltip');
    let palette = paletteSelect ? paletteSelect.value : 'cool';
    let intensity = intensityRange ? parseFloat(intensityRange.value) : 1;
    let hoverEnabled = hoverToggle ? hoverToggle.checked : true;
    // gpuToggle now enables true GPU mode (WebGL renderer). lowCpuMode is a separate performance fallback.
    let lowCpuMode = false;
    let gpuMode = gpuToggle ? gpuToggle.checked : false;

    // WebGL renderer state
    let glState = {
        inited: false,
        programPoint: null,
        programLine: null,
        bufNodePos: null,
        bufNodeSize: null,
        bufNodeColor: null,
        bufLinePos: null,
        bufSparkPos: null,
        bufSparkSize: null,
        bufSparkColor: null,
    };

    function createShader(gl, type, src){ const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){ console.warn(gl.getShaderInfoLog(s)); gl.deleteShader(s); return null; } return s; }
    function createProgram(gl, vsSrc, fsSrc){ const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc); const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc); if(!vs||!fs) return null; const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p); if(!gl.getProgramParameter(p, gl.LINK_STATUS)){ console.warn(gl.getProgramInfoLog(p)); gl.deleteProgram(p); return null; } return p; }

    function initGL(){
        if (!gl) return;
        if (glState.inited) return;
        // point shader (nodes & sparks)
        const vsPoint = `attribute vec2 a_pos; attribute float a_size; attribute vec3 a_col; uniform vec2 u_resolution; varying vec3 v_col; void main(){ vec2 zeroToOne = a_pos / u_resolution; vec2 clip = zeroToOne * 2.0 - 1.0; gl_Position = vec4(clip * vec2(1, -1), 0, 1); gl_PointSize = a_size; v_col = a_col; }`;
        const fsPoint = `precision mediump float; varying vec3 v_col; uniform float u_alpha; void main(){ vec2 coord = gl_PointCoord - vec2(0.5); float dist = length(coord); float a = smoothstep(0.55, 0.0, dist); gl_FragColor = vec4(v_col/255.0, a * u_alpha); }`;

        // line shader for triangle-quads (uniform color)
        const vsLine = `attribute vec2 a_pos; uniform vec2 u_resolution; void main(){ vec2 zeroToOne = a_pos / u_resolution; vec2 clip = zeroToOne * 2.0 - 1.0; gl_Position = vec4(clip * vec2(1, -1), 0, 1); }`;
        const fsLine = `precision mediump float; uniform vec3 u_color; uniform float u_alpha; void main(){ gl_FragColor = vec4(u_color/255.0, u_alpha); }`;

        // post-process fullscreen quad (separable blur + composite)
        const vsPost = `attribute vec2 a_pos; varying vec2 v_uv; void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
        // separable blur shader: samples along u_dir
        const fsBlur = `precision mediump float; varying vec2 v_uv; uniform sampler2D u_texture; uniform vec2 u_resolution; uniform vec2 u_dir; uniform float u_radius; vec4 sampleOffset(vec2 off){ return texture2D(u_texture, v_uv + off); } void main(){ vec2 texel = 1.0 / u_resolution; vec2 dir = u_dir * texel; // 9-tap Gaussian-like weights
            float w0 = 0.227027; float w1 = 0.1945946; float w2 = 0.1216216; float w3 = 0.054054;
            vec3 c = sampleOffset(vec2(0.0)).rgb * w0;
            c += sampleOffset(dir * 1.0).rgb * w1; c += sampleOffset(dir * -1.0).rgb * w1;
            c += sampleOffset(dir * 2.0).rgb * w2; c += sampleOffset(dir * -2.0).rgb * w2;
            c += sampleOffset(dir * 3.0).rgb * w3; c += sampleOffset(dir * -3.0).rgb * w3;
            gl_FragColor = vec4(c, 1.0);
        }`;

        // composite shader: combine original scene and blurred texture
        const fsComposite = `precision mediump float; varying vec2 v_uv; uniform sampler2D u_scene; uniform sampler2D u_blur; uniform vec2 u_resolution; uniform float u_bloom; uniform float u_intensity; vec4 sampleS(sampler2D s, vec2 uv){ return texture2D(s, uv); } void main(){ vec2 texel = 1.0 / u_resolution; // perform a small vertical blur on the horizontally-blurred texture
            float w0 = 0.227027; float w1 = 0.1945946; float w2 = 0.1216216; float w3 = 0.054054;
            vec3 b = sampleS(u_blur, v_uv).rgb * w0;
            b += sampleS(u_blur, v_uv + vec2(0.0, texel.y * 1.0)).rgb * w1;
            b += sampleS(u_blur, v_uv - vec2(0.0, texel.y * 1.0)).rgb * w1;
            b += sampleS(u_blur, v_uv + vec2(0.0, texel.y * 2.0)).rgb * w2;
            b += sampleS(u_blur, v_uv - vec2(0.0, texel.y * 2.0)).rgb * w2;
            b += sampleS(u_blur, v_uv + vec2(0.0, texel.y * 3.0)).rgb * w3;
            b += sampleS(u_blur, v_uv - vec2(0.0, texel.y * 3.0)).rgb * w3;
            vec3 scene = sampleS(u_scene, v_uv).rgb;
            vec3 bloom = max(vec3(0.0), b - 0.6) * u_bloom * u_intensity;
            vec3 outc = scene + bloom;
            gl_FragColor = vec4(outc, 1.0);
        }`;

        glState.programPoint = createProgram(gl, vsPoint, fsPoint);
        glState.programLine = createProgram(gl, vsLine, fsLine);
        glState.programBlur = createProgram(gl, vsPost, fsBlur);
        glState.programComposite = createProgram(gl, vsPost, fsComposite);
        if (!glState.programPoint || !glState.programLine || !glState.programBlur || !glState.programComposite) return;

        // create buffers
        glState.bufNodePos = gl.createBuffer(); glState.bufNodeSize = gl.createBuffer(); glState.bufNodeColor = gl.createBuffer();
        glState.bufLinePos = gl.createBuffer(); // will hold triangle quad verts
        glState.bufSparkPos = gl.createBuffer(); glState.bufSparkSize = gl.createBuffer(); glState.bufSparkColor = gl.createBuffer();
        glState.bufPostQuad = gl.createBuffer();

        // create framebuffer + texture for postprocessing (scene)
        glState.fb = gl.createFramebuffer(); glState.fbTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // intermediate texture (horizontal blur result)
        glState.tempFb = gl.createFramebuffer(); glState.tempTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, glState.tempTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // full-screen quad (clip space coords)
        const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufPostQuad); gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

        // enable additive blend for glow
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        // allocate textures with correct size now
        function allocFbTex(tex, fb){ gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, glCanvas.width, glCanvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); }
        allocFbTex(glState.fbTex, glState.fb); allocFbTex(glState.tempTex, glState.tempFb);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        glState.postProcessEnabled = true;
        glState.inited = true;
    }

    function getPaletteColors() {
        if (palette === 'warm') return {chip1:'#2b0718', chip2:'#3b1028', nodeA:'255,190,210', nodeB:'255,120,170', sparkHueBase:330};
        if (palette === 'neon') return {chip1:'#041020', chip2:'#0b0820', nodeA:'120,255,230', nodeB:'255,120,255', sparkHueBase:280};
        // default cool
        return {chip1:'#06112a', chip2:'#11183a', nodeA:'200,230,255', nodeB:'110,170,255', sparkHueBase:210};
    }

    function resize(){
        w = innerWidth; h = innerHeight; dpr = Math.max(1, window.devicePixelRatio || 1);
        // 2D canvas
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
        ctx.setTransform(dpr,0,0,dpr,0,0);
        // GL canvas
        if (glCanvas){ glCanvas.style.width = w + 'px'; glCanvas.style.height = h + 'px'; glCanvas.width = Math.floor(w * dpr); glCanvas.height = Math.floor(h * dpr); if (glState.inited) gl.viewport(0,0,glCanvas.width, glCanvas.height); }
        // reallocate GL framebuffer textures when resizing
        if (gl && glState && glState.inited){
            try {
                gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, glCanvas.width, glCanvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.bindTexture(gl.TEXTURE_2D, glState.tempTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, glCanvas.width, glCanvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                // reattach
                gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glState.fbTex, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, glState.tempFb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glState.tempTex, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            } catch(err){ console.warn('GL resize alloc failed', err); }
        }
        center = {x: w/2, y: h/2};
        generateNetwork();
    }

    function generateNetwork(){
        nodes = [];
        edges = [];
        sparks = [];
        const area = Math.max(80000, w*h);
        const baseN = Math.max(40, Math.min(120, Math.floor(area/100000)));
        const N = lowCpuMode ? Math.max(12, Math.floor(baseN*0.45)) : baseN;
        planetRadius = Math.min(w,h) * 0.48;
        // place nodes around a circle (planet surface) with small depth variation
        for(let i=0;i<N;i++){
            const angle = (i / N) * Math.PI * 2 + (Math.random()-0.5)*(Math.PI*2/N)*0.6;
            const z = (Math.random()*0.6 - 0.3); // pseudo-depth for size/brightness
            const baseR = planetRadius * (0.92 + Math.random()*0.12);
            nodes.push({angle, z, baseR, r:2.6 + Math.random()*5.6, pulse:Math.random()*Math.PI*2, lastHover:0});
        }
        // connect each node to its nearest neighbors by angular distance
        for(let i=0;i<nodes.length;i++){
            // link to next 2 neighbors clockwise and ccw
            const a = i; const b1 = (i+1) % nodes.length; const b2 = (i+2) % nodes.length; const b3 = (i-1+nodes.length)%nodes.length;
            [[a,b1],[a,b2],[a,b3]].forEach(pair=>{
                const ia = pair[0], ib = pair[1]; if (!edges.some(e=> (e.a===ia && e.b===ib) || (e.a===ib && e.b===ia))) edges.push({a:ia,b:ib});
            });
        }
        // some nodes connect radially to the CPU core
        const cpuLinks = Math.max(3, Math.floor(nodes.length*0.12));
        for(let i=0;i<cpuLinks;i++) edges.push({a:'cpu', b: Math.floor(Math.random()*nodes.length)});
    }

    function spawnSpark(fromIndex, toIndex){
        if(edges.length===0) return;
        const e = (fromIndex !== undefined && toIndex !== undefined) ? {a:fromIndex, b:toIndex} : edges[Math.floor(Math.random()*edges.length)];
        const speed = (0.002 + Math.random()*0.012) * (lowCpuMode ? 0.45 : 1) * (1.6 - intensity*0.5);
        const pal = getPaletteColors();
        const hue = pal.sparkHueBase + Math.random()*40 - 10;
        const light = 48 + Math.random()*18;
        const color = `hsl(${hue}, ${82}%, ${light}%)`;
        // store edge reference for dynamic positions along the planet
        sparks.push({edge:e, t:0, speed, color});
        // limit
        const maxSparks = lowCpuMode ? 70 : 260;
        if (sparks.length>maxSparks) sparks.splice(0, sparks.length-(maxSparks-30));
    }

    function getEdgePoint(e, t){
        // return position on curved arc along planet surface between endpoints at progress t
        const aNode = (e.a === 'cpu') ? null : nodes[e.a];
        const bNode = (e.b === 'cpu') ? null : nodes[e.b];
        const r = planetRadius;
        // compute angles for endpoints (if cpu, use a random anchor close to center but project outward)
        let aAng, bAng, aR, bR;
        if (aNode){ aAng = aNode.angle + rotation; aR = aNode.baseR * (1 + aNode.z*0.12); } else { aAng = (Math.random()*Math.PI*2) ; aR = r*0.25; }
        if (bNode){ bAng = bNode.angle + rotation; bR = bNode.baseR * (1 + bNode.z*0.12); } else { bAng = (Math.random()*Math.PI*2); bR = r*0.25; }
        // shortest angular interpolation
        let diff = bAng - aAng; if (Math.abs(diff) > Math.PI) diff -= Math.sign(diff)*2*Math.PI;
        const ang = aAng + diff * t;
        // arc height peaks at t=0.5
        const arcH = Math.sin(Math.PI * t) * (Math.min(w,h) * 0.06) * (0.6 + intensity*0.6);
        const radiusAt = r + arcH;
        const x = center.x + Math.cos(ang) * radiusAt;
        const y = center.y + Math.sin(ang) * (radiusAt * 0.86); // slight ellipse to mimic perspective
        return {x,y};
    }

    function getNodePos(n){
        const ang = n.angle + rotation;
        const radius = n.baseR * (1 + n.z*0.08);
        const x = center.x + Math.cos(ang) * radius;
        const y = center.y + Math.sin(ang) * (radius * 0.86);
        return {x,y};
    }

    let lastSpawn = 0;
    let lastTime = performance.now();
    function animate(now){
        if (!running) return;
        const dt = Math.min(40, now - lastTime);
        lastTime = now;
        // if GPU mode is enabled and WebGL available, render with GL
        if (gpuMode && gl){
            if (!glState.inited) initGL();
            renderGL(dt);
            requestAnimationFrame(animate);
            return;
        }

        // translucent background for motion trails (2D fallback)
        ctx.clearRect(0,0,w,h);

        // draw planet circle
        const pal = getPaletteColors();
        const planetGrad = ctx.createRadialGradient(center.x, center.y, planetRadius*0.2, center.x, center.y, planetRadius*1.2);
        planetGrad.addColorStop(0, `rgba(${pal.nodeA},0.06)`);
        planetGrad.addColorStop(1, `rgba(0,0,0,0.0)`);
        ctx.fillStyle = planetGrad; ctx.beginPath(); ctx.arc(center.x, center.y, planetRadius*1.12, 0, Math.PI*2); ctx.fill();

        // draw links as gentle arcs on the planet surface
        ctx.lineWidth = 1.1;
        edges.forEach(e=>{
            const aNode = (e.a==='cpu') ? null : nodes[e.a];
            const bNode = (e.b==='cpu') ? null : nodes[e.b];
            const pa = aNode ? getNodePos(aNode) : {x:center.x, y:center.y};
            const pb = bNode ? getNodePos(bNode) : {x:center.x, y:center.y};
            // mid point for quadratic control (lifted outward from center)
            const mid = getEdgePoint(e, 0.5);
            const grad = ctx.createLinearGradient(pa.x,pa.y,pb.x,pb.y);
            grad.addColorStop(0, `rgba(${pal.nodeA},${0.08*intensity})`);
            grad.addColorStop(1, `rgba(${pal.nodeB},${0.06*intensity})`);
            ctx.strokeStyle = grad; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.quadraticCurveTo(mid.x, mid.y, pb.x, pb.y); ctx.stroke();
        });

        // draw nodes (neurons)
        const palCol = getPaletteColors();
        nodes.forEach((n,idx)=>{
            n.pulse += dt*0.002;
            // apply hover pulse
            const hoverBoost = (n.hover || 0) * 0.02;
            n.hover = Math.max(0, (n.hover||0) - dt*0.004);
            const pulse = 0.6 + Math.sin(n.pulse + hoverBoost) * 0.4 + (hoverBoost*0.8);
            const pos = getNodePos(n);
            const size = n.r * (0.9 + pulse*0.6) * (1 + n.z*0.25);
            const gr = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 22 + (hoverBoost*10));
            gr.addColorStop(0, `rgba(${palCol.nodeA},${Math.min(1,0.92*pulse*intensity)})`);
            gr.addColorStop(1, `rgba(${palCol.nodeB},${0.02*pulse})`);
            ctx.fillStyle = gr;
            ctx.beginPath(); ctx.arc(pos.x, pos.y, size, 0, Math.PI*2); ctx.fill();
        });

        // draw CPU core as central chip (planet core)
        const cpuR = Math.min(w,h) * 0.12;
        const cpuX = center.x, cpuY = center.y;
        // glowing core circle
        const coreGlow = ctx.createRadialGradient(cpuX, cpuY, cpuR*0.2, cpuX, cpuY, cpuR*1.6);
        coreGlow.addColorStop(0, `rgba(${palCol.nodeB},0.28)`);
        coreGlow.addColorStop(1, `rgba(6,8,20,0.0)`);
        ctx.fillStyle = coreGlow; ctx.beginPath(); ctx.arc(cpuX, cpuY, cpuR*1.6,0,Math.PI*2); ctx.fill();
        // chip body
        const chipGrad = ctx.createLinearGradient(cpuX-cpuR, cpuY-cpuR, cpuX+cpuR, cpuY+cpuR);
        chipGrad.addColorStop(0, '#071026'); chipGrad.addColorStop(1, '#141530');
        ctx.fillStyle = chipGrad; roundRect(ctx, cpuX-cpuR, cpuY-cpuR, cpuR*2, cpuR*2, 10); ctx.fill();
        // inner pattern
        ctx.fillStyle = `rgba(${palCol.nodeA},0.06)`; ctx.beginPath(); ctx.arc(cpuX, cpuY, cpuR*0.6,0,Math.PI*2); ctx.fill();
        // radial pins
        ctx.fillStyle = `rgba(${palCol.nodeB},0.09)`;
        for(let i=0;i<10;i++){ const ang = (i/10)*Math.PI*2 + rotation*0.2; const px = cpuX + Math.cos(ang)*(cpuR+8); const py = cpuY + Math.sin(ang)*(cpuR+8); ctx.fillRect(px-2, py-2, 4,4); }

        // update & draw sparks with additive blending following curved arcs
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        for(let i=sparks.length-1;i>=0;i--){
            const s = sparks[i];
            s.t += s.speed * dt;
            if (s.t>1){ sparks.splice(i,1); continue; }
            const p = getEdgePoint(s.edge, s.t);
            const glow = (8 + 12 * Math.sin(s.t * Math.PI)) * (1.0 + intensity*0.8);
            const rad = (3.0 + 3.5*Math.sin(s.t*Math.PI)) * (0.9 + intensity*0.7);
            ctx.beginPath(); ctx.fillStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = glow; ctx.arc(p.x,p.y, rad,0,Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
        }
        ctx.restore();

        // occasionally spawn sparks (reduced when lowCpuMode)
        const spawnFreq = lowCpuMode ? 200 : 80;
        if (now - lastSpawn > spawnFreq){ if (Math.random() < (lowCpuMode ? 0.45 : 0.9)) spawnSpark(); lastSpawn = now - Math.random()*200; }

        // increment planet rotation slowly
        rotation += rotationSpeedBase * (0.6 + intensity*0.6) * (lowCpuMode ? 0.45 : 1);

        // loop
        requestAnimationFrame(animate);
    }

    function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }

    /* ---------- WebGL renderer functions ---------- */
    function updateGLBuffers(){
        if (!glState.inited) return;
        // upload node positions/sizes/colors
        const nodePos = new Float32Array(nodes.length * 2);
        const nodeSize = new Float32Array(nodes.length);
        const nodeColor = new Float32Array(nodes.length * 3);
        const pal = getPaletteColors();
        const ncol = pal.nodeA.split(',').map(Number);
        for(let i=0;i<nodes.length;i++){ const p = getNodePos(nodes[i]); nodePos[i*2]=p.x; nodePos[i*2+1]=p.y; nodeSize[i]=nodes[i].r* (1.6 + intensity*1.4) * (1 + nodes[i].z*0.2); nodeColor[i*3]=ncol[0]; nodeColor[i*3+1]=ncol[1]; nodeColor[i*3+2]=ncol[2]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodePos); gl.bufferData(gl.ARRAY_BUFFER, nodePos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodeSize); gl.bufferData(gl.ARRAY_BUFFER, nodeSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodeColor); gl.bufferData(gl.ARRAY_BUFFER, nodeColor, gl.DYNAMIC_DRAW);

        // edges: build triangle-quads for thicker smooth lines
        // each edge -> two triangles (6 verts)
        const lineWidth = Math.max(1.5, 2.0 + intensity*1.8);
        const quadVerts = new Float32Array(edges.length * 6 * 2);
        let idx = 0;
        for(let i=0;i<edges.length;i++){
            const e = edges[i]; const pa = (e.a==='cpu') ? center : getNodePos(nodes[e.a]); const pb = (e.b==='cpu') ? center : getNodePos(nodes[e.b]);
            const dx = pb.x - pa.x; const dy = pb.y - pa.y; const len = Math.sqrt(dx*dx + dy*dy) + 0.0001;
            const nx = -dy / len; const ny = dx / len; const hw = lineWidth * 0.5;
            const ax1 = pa.x + nx*hw, ay1 = pa.y + ny*hw;
            const ax2 = pa.x - nx*hw, ay2 = pa.y - ny*hw;
            const bx1 = pb.x + nx*hw, by1 = pb.y + ny*hw;
            const bx2 = pb.x - nx*hw, by2 = pb.y - ny*hw;
            // triangle 1: ax1, ax2, bx2
            quadVerts[idx++]=ax1; quadVerts[idx++]=ay1;
            quadVerts[idx++]=ax2; quadVerts[idx++]=ay2;
            quadVerts[idx++]=bx2; quadVerts[idx++]=by2;
            // triangle 2: ax1, bx2, bx1
            quadVerts[idx++]=ax1; quadVerts[idx++]=ay1;
            quadVerts[idx++]=bx2; quadVerts[idx++]=by2;
            quadVerts[idx++]=bx1; quadVerts[idx++]=by1;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufLinePos); gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.DYNAMIC_DRAW);

        // sparks
        const sparkCount = sparks.length;
        const sparkPos = new Float32Array(sparkCount * 2);
        const sparkSize = new Float32Array(sparkCount);
        const sparkCol = new Float32Array(sparkCount * 3);
        for(let i=0;i<sparks.length;i++){ const s=sparks[i]; const t = s.t; const p = getEdgePoint(s.edge, t); const px = p.x; const py = p.y; sparkPos[i*2]=px; sparkPos[i*2+1]=py; sparkSize[i]=6 + 8 * Math.sin(t*Math.PI) * intensity; const rgb = hslToRgb(parseInt(s.color.match(/hsl\((\d+),/)[1]), 0.8, 0.6); sparkCol[i*3]=rgb[0]; sparkCol[i*3+1]=rgb[1]; sparkCol[i*3+2]=rgb[2]; }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkPos); gl.bufferData(gl.ARRAY_BUFFER, sparkPos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkSize); gl.bufferData(gl.ARRAY_BUFFER, sparkSize, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkColor); gl.bufferData(gl.ARRAY_BUFFER, sparkCol, gl.DYNAMIC_DRAW);
    }

    function renderGL(dt){
        if (!glState.inited) initGL(); if (!glState.inited) return;
        // ensure framebuffer texture size matches canvas
        const fbW = glCanvas.width, fbH = glCanvas.height;
        gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fbW, fbH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glState.fbTex, 0);

        // update webgl buffers from JS arrays
        updateGLBuffers();

        // render scene into framebuffer
        gl.viewport(0,0,fbW, fbH);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);

        // draw line quads
        gl.useProgram(glState.programLine);
        const a_pos_line = gl.getAttribLocation(glState.programLine, 'a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufLinePos);
        if (a_pos_line>=0){ gl.enableVertexAttribArray(a_pos_line); gl.vertexAttribPointer(a_pos_line,2,gl.FLOAT,false,0,0); }
        const u_res_line = gl.getUniformLocation(glState.programLine, 'u_resolution'); const u_col_line = gl.getUniformLocation(glState.programLine, 'u_color'); const u_alpha_line = gl.getUniformLocation(glState.programLine, 'u_alpha');
        gl.uniform2f(u_res_line, w, h);
        const pal = getPaletteColors(); const lc = pal.nodeA.split(',').map(Number);
        gl.uniform3f(u_col_line, lc[0], lc[1], lc[2]); gl.uniform1f(u_alpha_line, 0.08 * intensity);
        // triangles count = edges.length * 2
        gl.drawArrays(gl.TRIANGLES, 0, edges.length * 6);

        // draw nodes & sparks to framebuffer (points)
        gl.useProgram(glState.programPoint);
        const a_pos_p = gl.getAttribLocation(glState.programPoint, 'a_pos'); const a_size_p = gl.getAttribLocation(glState.programPoint, 'a_size'); const a_col_p = gl.getAttribLocation(glState.programPoint, 'a_col');
        const u_res_p = gl.getUniformLocation(glState.programPoint, 'u_resolution'); const u_alpha_p = gl.getUniformLocation(glState.programPoint, 'u_alpha');
        gl.uniform2f(u_res_p, w, h); gl.uniform1f(u_alpha_p, 0.9 * intensity);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodePos); if (a_pos_p>=0){ gl.enableVertexAttribArray(a_pos_p); gl.vertexAttribPointer(a_pos_p,2,gl.FLOAT,false,0,0); }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodeSize); if (a_size_p>=0){ gl.enableVertexAttribArray(a_size_p); gl.vertexAttribPointer(a_size_p,1,gl.FLOAT,false,0,0); }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufNodeColor); if (a_col_p>=0){ gl.enableVertexAttribArray(a_col_p); gl.vertexAttribPointer(a_col_p,3,gl.FLOAT,false,0,0); }
        gl.drawArrays(gl.POINTS, 0, nodes.length);

        // sparks
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkPos); if (a_pos_p>=0){ gl.enableVertexAttribArray(a_pos_p); gl.vertexAttribPointer(a_pos_p,2,gl.FLOAT,false,0,0); }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkSize); if (a_size_p>=0){ gl.enableVertexAttribArray(a_size_p); gl.vertexAttribPointer(a_size_p,1,gl.FLOAT,false,0,0); }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufSparkColor); if (a_col_p>=0){ gl.enableVertexAttribArray(a_col_p); gl.vertexAttribPointer(a_col_p,3,gl.FLOAT,false,0,0); }
        gl.uniform1f(u_alpha_p, 1.0 * intensity);
        gl.drawArrays(gl.POINTS, 0, sparks.length);

        // two-pass separable blur + composite
        // --- pass 1: horizontal blur into tempFb
        gl.bindFramebuffer(gl.FRAMEBUFFER, glState.tempFb);
        gl.viewport(0,0,glCanvas.width, glCanvas.height);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(glState.programBlur);
        // bind scene texture as input
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
        const u_tex_h = gl.getUniformLocation(glState.programBlur, 'u_texture'); const u_res_h = gl.getUniformLocation(glState.programBlur, 'u_resolution'); const u_dir_h = gl.getUniformLocation(glState.programBlur, 'u_dir');
        if (u_tex_h) gl.uniform1i(u_tex_h, 0);
        if (u_res_h) gl.uniform2f(u_res_h, glCanvas.width, glCanvas.height);
        if (u_dir_h) gl.uniform2f(u_dir_h, 1.0, 0.0);
        const a_pos_h = gl.getAttribLocation(glState.programBlur, 'a_pos'); gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufPostQuad); if (a_pos_h>=0){ gl.enableVertexAttribArray(a_pos_h); gl.vertexAttribPointer(a_pos_h,2,gl.FLOAT,false,0,0); }
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- pass 2: vertical blur + composite to screen (reads tempTex + scene)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0,0,glCanvas.width, glCanvas.height);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
        // if low-power mode or post-process disabled, just draw the scene texture directly
        if (!glState.postProcessEnabled){
            // simple textured blit of scene texture
            gl.useProgram(glState.programComposite);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
            const u_blur = gl.getUniformLocation(glState.programComposite, 'u_blur'); const u_scene = gl.getUniformLocation(glState.programComposite, 'u_scene'); const u_res_c = gl.getUniformLocation(glState.programComposite, 'u_resolution'); const u_bloom_c = gl.getUniformLocation(glState.programComposite, 'u_bloom'); const u_int_c = gl.getUniformLocation(glState.programComposite, 'u_intensity');
            if (u_blur) gl.uniform1i(u_blur, 0);
            if (u_scene) gl.uniform1i(u_scene, 1);
            if (u_res_c) gl.uniform2f(u_res_c, glCanvas.width, glCanvas.height);
            if (u_bloom_c) gl.uniform1f(u_bloom_c, 0.0);
            if (u_int_c) gl.uniform1f(u_int_c, intensity);
            const a_pos_c = gl.getAttribLocation(glState.programComposite, 'a_pos'); gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufPostQuad); if (a_pos_c>=0){ gl.enableVertexAttribArray(a_pos_c); gl.vertexAttribPointer(a_pos_c,2,gl.FLOAT,false,0,0); }
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            return;
        }

        gl.useProgram(glState.programComposite);
        // bind temp (h-blur) -> unit0, scene (original) -> unit1
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.tempTex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glState.fbTex);
        const u_blur = gl.getUniformLocation(glState.programComposite, 'u_blur'); const u_scene = gl.getUniformLocation(glState.programComposite, 'u_scene'); const u_res_c = gl.getUniformLocation(glState.programComposite, 'u_resolution'); const u_bloom_c = gl.getUniformLocation(glState.programComposite, 'u_bloom'); const u_int_c = gl.getUniformLocation(glState.programComposite, 'u_intensity');
        if (u_blur) gl.uniform1i(u_blur, 0);
        if (u_scene) gl.uniform1i(u_scene, 1);
        if (u_res_c) gl.uniform2f(u_res_c, glCanvas.width, glCanvas.height);
        if (u_bloom_c) gl.uniform1f(u_bloom_c, 0.95);
        if (u_int_c) gl.uniform1f(u_int_c, intensity);
        const a_pos_c = gl.getAttribLocation(glState.programComposite, 'a_pos'); gl.bindBuffer(gl.ARRAY_BUFFER, glState.bufPostQuad); if (a_pos_c>=0){ gl.enableVertexAttribArray(a_pos_c); gl.vertexAttribPointer(a_pos_c,2,gl.FLOAT,false,0,0); }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function hslToRgb(h, s, l){ // h in degrees 0-360, s/l 0-1
        s = Math.max(0,Math.min(1,s)); l = Math.max(0,Math.min(1,l));
        const c = (1 - Math.abs(2*l-1))*s; const hh = h/60; const x = c*(1-Math.abs(hh%2-1)); let r=0,g=0,b=0;
        if (hh>=0 && hh<1){ r=c; g=x; b=0; } else if (hh<2){ r=x; g=c; b=0; } else if (hh<3){ r=0; g=c; b=x; } else if (hh<4){ r=0; g=x; b=c; } else if (hh<5){ r=x; g=0; b=c; } else { r=c; g=0; b=x; }
        const m = l - c/2; return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
    }

    // pointer hover interaction
    let lastHoverIndex = -1;
    document.addEventListener('pointermove', (ev)=>{
        if (!hoverEnabled) { nodeTooltip.style.display='none'; return; }
        const rect = (gpuMode && glCanvas) ? glCanvas.getBoundingClientRect() : canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left; const my = ev.clientY - rect.top;
        let best = -1; let bestDist = 999999;
        for(let i=0;i<nodes.length;i++){ const np = getNodePos(nodes[i]); const dx = np.x - mx; const dy = np.y - my; const d = dx*dx + dy*dy; if (d < bestDist){ bestDist = d; best = i; } }
        const thresh = Math.min(120, (Math.min(w,h)*0.08));
        if (best !== -1 && bestDist < thresh*thresh){
            // pulse node
            const node = nodes[best]; node.hover = 1.6; node.lastHover = performance.now();
            // spawn sparks to neighbors
            edges.filter(e=> e.a===best || e.b===best || e.a==='cpu' && e.b===best || e.b==='cpu' && e.a===best).slice(0,4).forEach(e=>{ const aIdx = (e.a==='cpu') ? 'cpu' : e.a; const bIdx = (e.b==='cpu') ? 'cpu' : e.b; spawnSpark(aIdx==='cpu' ? 'cpu' : aIdx, bIdx==='cpu' ? 'cpu' : bIdx); });
            // tooltip
            nodeTooltip.style.display='block'; nodeTooltip.textContent = `Neuron ${best}`;
            nodeTooltip.style.left = (ev.clientX + 12) + 'px'; nodeTooltip.style.top = (ev.clientY + 12) + 'px';
        } else { nodeTooltip.style.display='none'; }
    });

    // pause when hidden
    document.addEventListener('visibilitychange', ()=>{ running = document.visibilityState === 'visible'; if (running) { lastTime = performance.now(); requestAnimationFrame(animate); } });

    // control listeners
    if (paletteSelect) paletteSelect.addEventListener('change', (e)=>{ palette = e.target.value; });
    if (intensityRange) intensityRange.addEventListener('input', (e)=>{ intensity = parseFloat(e.target.value); document.getElementById('intensityVal').textContent = intensity.toFixed(2); });
    if (hoverToggle) hoverToggle.addEventListener('change', (e)=>{ hoverEnabled = e.target.checked; if (!hoverEnabled) nodeTooltip.style.display='none'; });

    const gpuStatusEl = document.getElementById('gpuStatus');
    const captureBtn = document.getElementById('captureBtn');
    let gpuAvailable = false; let softwareRenderer = false; let gpuRendererName = '';

    function detectGPUAvailability(){
        if (!gl){ gpuAvailable = false; gpuStatusEl.textContent = 'GPU: WebGL not available — using CPU fallback'; gpuToggle.disabled = true; return; }
        try {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || gl.getParameter(gl.VERSION));
            gpuRendererName = renderer || 'Unknown';
            softwareRenderer = /swiftshader|software|llvmpipe/i.test(gpuRendererName);
            gpuAvailable = true;
            if (softwareRenderer){ gpuStatusEl.textContent = `GPU: Software renderer detected (${gpuRendererName}) — consider disabling GPU mode`; gpuToggle.disabled = false; }
            else { gpuStatusEl.textContent = `GPU: Available — ${gpuRendererName}`; gpuToggle.disabled = false; }
        } catch(err){ gpuAvailable = false; gpuStatusEl.textContent = 'GPU: detection failed — using CPU fallback'; gpuToggle.disabled = true; }
    }

    // Capture button: read glCanvas to image
    if (captureBtn){ captureBtn.addEventListener('click', ()=>{
        try {
            if (!glCanvas) { alert('GL canvas not found'); return; }
            const data = glCanvas.toDataURL('image/png'); const w = window.open('about:blank'); if (w){ const img = w.document.createElement('img'); img.src = data; w.document.body.style.background = '#000'; w.document.body.appendChild(img); } else { // fallback: download
                const a = document.createElement('a'); a.href = data; a.download = 'genai-neural-capture.png'; a.click();
            }
        } catch(err){ console.warn('capture failed', err); alert('Capture failed: ' + err.message); }
    }); }

    // initial detect
    detectGPUAvailability();

    const disableGpuBtn = document.getElementById('disableGpuBtn');
    const lowPowerBtnEl = document.getElementById('lowPowerBtn');
    // low-power state defaults
    let lowPowerMode = false;

    if (disableGpuBtn){ disableGpuBtn.addEventListener('click', ()=>{ gpuMode = false; if (gpuToggle) { gpuToggle.checked = false; } detectGPUAvailability(); document.getElementById('gpuStatus').textContent = 'GPU: disabled by user'; }); }

    if (lowPowerBtnEl){ lowPowerBtnEl.addEventListener('click', ()=>{
        lowPowerMode = !lowPowerMode;
        lowCpuMode = lowPowerMode;
        // disable post-process when low-power
        if (glState) glState.postProcessEnabled = !lowPowerMode;
        lowPowerBtnEl.textContent = lowPowerMode ? 'Low-power ✓' : 'Low-power';
        // if enabling low power, also suggest disabling GPU mode
        if (lowPowerMode && gpuMode){ gpuMode = false; if (gpuToggle) gpuToggle.checked = false; document.getElementById('gpuStatus').textContent = 'GPU: disabled (low-power)'; }
        generateNetwork();
    }); }

    if (gpuToggle) gpuToggle.addEventListener('change', (e)=>{
        const wanted = e.target.checked;
        if (wanted && !gpuAvailable){ gpuMode = false; gpuToggle.checked = false; alert('GPU not available on this browser/device. Falling back to CPU renderer.'); return; }
        if (wanted && softwareRenderer){ // warn but allow
            const ok = confirm(`Your GPU appears to be a software renderer (${gpuRendererName}). GPU mode may be slow. Enable anyway?`);
            if (!ok){ gpuToggle.checked = false; gpuMode = false; return; }
        }
        gpuMode = wanted;
        if (gpuMode){ initGL(); }
        generateNetwork();
    });

    window.addEventListener('resize', debounce(resize, 180));
    function debounce(fn, wait){ let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), wait); }; }

    // performance readout
    const perfEl = document.getElementById('perfReadout');
    let fpsSmoothed = 60; let fpsLast = performance.now(); let frameCount = 0; let glLastMs = 0;

    // expose a hook for GL render timing
    const origRenderGL = renderGL;
    function wrappedRenderGL(dt){ const t0 = performance.now(); origRenderGL(dt); glLastMs = Math.round(performance.now() - t0); if (perfEl){ perfEl.textContent = `FPS: ${fpsSmoothed} | GL: ${glLastMs}ms`; } }
    // replace reference used in animate() with wrappedRenderGL by assigning name (we call renderGL directly in animate path)
    renderGL = wrappedRenderGL;

    // start
    resize(); lastTime = performance.now(); requestAnimationFrame(function loop(t){
        // measure FPS
        frameCount++; const now = performance.now(); const delta = now - fpsLast; if (delta >= 250){ fpsSmoothed = Math.round((frameCount / delta) * 1000); frameCount = 0; fpsLast = now; }
        // animate step will call renderGL if needed; we'll measure GL time in renderGL and update perfEl here
        requestAnimationFrame(loop);
    });
    // start animation loop
    requestAnimationFrame(animate);
})();
