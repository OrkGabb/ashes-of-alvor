import * as THREE from "three";
import { CONFIG, QUALITY, dampFactor, flicker } from "./config.js";

// Atmosfera: céu com ciclo dia/noite, sol/lua (DirectionalLight com sombra que acompanha o jogador),
// clima (chuva que vem e vai), e o orçamento de luz.
//
// Orçamento de luz — por que a lareira "só acendia de certo ângulo": antes, as N PointLights eram
// dadas às âncoras mais próximas da CÂMERA (que gira em 3ª pessoa) e, em GPU fraca, só 2 slots
// existiam; a lareira perdia o slot conforme o ângulo. Agora a escolha usa a posição do JOGADOR,
// luzes do interior em que ele está ficam fixadas (pinned), há histerese contra troca a cada passo
// e o número de slots é constante (shader não recompila). Luzes sem slot continuam "acesas" pelas
// poças de luz e halos baratos do world.js.

const DAY_SKY = { zenith: new THREE.Color(0x3d7fd6), mid: new THREE.Color(0x86b6ea), horizon: new THREE.Color(0xd9e6f2) };
const DUSK_SKY = { zenith: new THREE.Color(0x26335e), mid: new THREE.Color(0x8a5a78), horizon: new THREE.Color(0xf09a5c) };
const NIGHT_SKY = { zenith: new THREE.Color(0x03060e), mid: new THREE.Color(0x0b172b), horizon: new THREE.Color(0x0a1322) };
const RAIN_TINT = new THREE.Color(0x5d6673);
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

function smooth01(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Atmosphere {
  constructor(scene, renderer, materials) {
    this.scene = scene;
    this.renderer = renderer;
    this.materials = materials;
    this.pointLights = [];
    this.interiorBlend = 0;
    this.zoneFogBoost = 0;
    this.zoneTint = new THREE.Color(0xffffff);
    this.zoneTintMix = 0;
    this.slotCount = QUALITY.lightSlots;
    this.lightTimer = 0;
    this.time = { hour: CONFIG.time.startHour, day: 1 };
    this.weather = { rain: CONFIG.weather.startRain, target: CONFIG.weather.startRain, hold: CONFIG.weather.minHold };
    this.state = { night: 1, daylight: 0, sunDir: new THREE.Vector3(0, 1, 0) };

    scene.background = new THREE.Color(0x060b15);
    scene.fog = new THREE.FogExp2(0x0a1322, 0.02);

    this.hemi = new THREE.HemisphereLight(0x3d5986, 0x1b1712, 0.5);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    const r = CONFIG.render.shadowRange;
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 160;
    cam.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.sky = this.createSky();
    this.rain = null;
  }

  createSky() {
    const geo = new THREE.SphereGeometry(180, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uMid: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
        uMoonDir: { value: new THREE.Vector3(-0.45, 0.82, 0.36).normalize() },
        uNight: { value: 1 },
        uCloud: { value: 0.5 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uMid, uHorizon, uSunDir, uSunColor, uMoonDir;
        uniform float uNight, uCloud, uTime;
        varying vec3 vDir;
        float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
        void main() {
          vec3 dir = normalize(vDir);
          float h = clamp(dir.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.3, h));
          col = mix(col, uZenith, smoothstep(0.25, 0.9, h));
          float sd = max(0.0, dot(dir, normalize(uSunDir)));
          col += uSunColor * (pow(sd, 8.0) * 0.35 + pow(sd, 64.0) * 0.4 + smoothstep(0.9988, 0.9994, sd) * 6.0) * (1.0 - uNight * 0.85) * (1.0 - uCloud * 0.7);
          float md = max(0.0, dot(dir, normalize(uMoonDir)));
          // Lua: disco com mares (ruído) e halo; some abaixo do horizonte
          float moonUp = smoothstep(-0.02, 0.08, normalize(uMoonDir).y);
          float disc = smoothstep(0.9982, 0.9990, md);
          float maria = 0.82 + 0.18 * hash31(floor(dir * 900.0));
          col += vec3(0.62, 0.75, 0.98) * (pow(md, 14.0) * 0.28 + pow(md, 300.0) * 0.35) * uNight * moonUp;
          col = mix(col, vec3(0.93, 0.95, 1.0) * maria * 1.35, disc * uNight * moonUp * (1.0 - uCloud * 0.6));
          vec2 cuv = dir.xz / (dir.y + 0.35) * 2.2 + vec2(uTime * 0.008, uTime * 0.004);
          float cloud = sin(cuv.x * 2.4 + cos(cuv.y * 2.1)) * cos(cuv.y * 2.8) * 0.5 + 0.5;
          vec3 cloudCol = mix(vec3(0.92, 0.94, 0.98), uMid * 1.25, uNight);
          float cover = cloud * uCloud * smoothstep(0.04, 0.4, h);
          col = mix(col, cloudCol, cover);
          if (h > 0.05 && uNight > 0.05) {
            // Duas camadas de estrelas (miúdas e brilhantes), escondidas pela nuvem e pelo luar perto da lua
            float s = hash31(floor(dir * 260.0));
            float s2 = hash31(floor(dir * 120.0) + 17.0);
            float twinkle = 0.6 + 0.4 * sin(uTime * 2.4 + s * 90.0);
            float stars = step(0.9935, s) * 0.9 + step(0.9975, s2) * 1.8;
            col += vec3(0.78, 0.87, 1.0) * stars * twinkle * smoothstep(0.05, 0.35, h) * (1.0 - cover * 1.4) * uNight * (1.0 - pow(md, 30.0));
          }
          col = mix(col, uHorizon, exp(-max(0.0, dir.y) * 14.0) * 0.7);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = "SkyDome";
    dome.renderOrder = -1;
    dome.frustumCulled = false;
    this.scene.add(dome);
    return dome;
  }

  attachWorld(world) {
    this.world = world;
    this.anchors = world.lights.map((a, i) => ({ ...a, seed: i * 3.71, active: 1 }));
    this.setLightSlots(this.slotCount);
    this.rain = this.createRain();
    this.buildEnvironment(world);
  }

  // Slots fixos: a contagem de PointLights nunca muda durante o jogo (nada de recompilar shaders)
  setLightSlots(count) {
    for (const s of this.pointLights) this.scene.remove(s.light);
    this.pointLights = [];
    this.slotCount = count;
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.castShadow = false;
      this.scene.add(light);
      this.pointLights.push({ light, anchor: null, next: null, fade: 0 });
    }
    this.lightTimer = Infinity;
  }

  // Pontuação de uma âncora para o jogador em (px, pz) na zona 'zone'
  score(a, px, pz, zone, insideKey) {
    if (a.active < 0.02) return -1;
    if (a.zone) {
      // Luz de interior: só conta com o jogador dentro do prédio ou junto da porta (sem sombras, ela vazaria pelas paredes)
      const inside = insideKey === a.zone || (zone && zone.key === a.zone);
      if (!inside) {
        const d = Math.hypot(a.position.x - px, a.position.z - pz);
        if (d > a.distance * 0.75 || !this.world.underRoof(px, pz, CONFIG.lights.doorwayReach)) return -1;
        return a.importance * 0.4 / (1 + (d * d) / (a.distance * a.distance));
      }
      return 100 + a.importance;
    }
    if (insideKey) return -1;
    const d2 = (a.position.x - px) ** 2 + (a.position.z - pz) ** 2;
    const reach = a.distance * a.distance;
    if (d2 > reach * 2.2) return -1;
    return a.importance / (1 + d2 / reach);
  }

  updateLights(dt, elapsed, playerPos, zone, camera) {
    const slots = this.pointLights;
    this.lightTimer += dt;
    if (this.lightTimer >= CONFIG.lights.reassignEvery) {
      this.lightTimer = 0;
      const insideKey = zone && zone.building ? zone.interiorOf || zone.key : null;
      camera.getWorldDirection(_fwd);
      const ranked = [];
      for (const a of this.anchors) {
        let s = this.score(a, playerPos.x, playerPos.z, zone, insideKey);
        if (s <= 0) continue;
        _v.set(a.position.x - camera.position.x, 0, a.position.z - camera.position.z);
        if (_v.dot(_fwd) > 0) s *= 1.25;
        if (slots.some((sl) => sl.anchor === a)) s *= 1.3;
        ranked.push({ a, s });
      }
      ranked.sort((x, y) => y.s - x.s);
      const wanted = ranked.slice(0, slots.length).map((r) => r.a);
      for (const sl of slots) {
        if (sl.anchor && wanted.includes(sl.anchor)) sl.next = sl.anchor;
        else sl.next = null;
      }
      for (const a of wanted) {
        if (slots.some((sl) => sl.next === a)) continue;
        const free = slots.find((sl) => sl.next === null);
        if (free) free.next = a;
      }
    }
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.next !== s.anchor) {
        s.fade = Math.max(0, s.fade - dt * 5);
        if (s.fade === 0) {
          s.anchor = s.next;
          if (s.anchor) {
            s.light.color.copy(s.anchor.color);
            s.light.distance = s.anchor.distance;
            s.light.decay = s.anchor.decay;
            s.light.position.copy(s.anchor.position);
          }
        }
      } else if (s.anchor && s.fade < 1) {
        s.fade = Math.min(1, s.fade + dt * 5);
      }
      const a = s.anchor;
      s.light.intensity = a ? a.intensity * a.active * s.fade * (1 + flicker(elapsed, a.seed) * a.flicker) : 0;
    }
  }

  // Chuva em LineSegments que acompanha a câmera; animada só no vertex shader
  createRain() {
    const { drops, height, speed, streak, wind, radius } = CONFIG.rain;
    const base = new Float32Array(drops * 2 * 3);
    const end = new Float32Array(drops * 2);
    for (let n = 0; n < drops; n++) {
      const x = (Math.random() * 2 - 1) * radius;
      const z = (Math.random() * 2 - 1) * radius;
      const y = Math.random() * height;
      for (let k = 0; k < 2; k++) {
        base.set([x, y, z], (n * 2 + k) * 3);
        end[n * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(base, 3));
    geo.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: height },
        uSpeed: { value: speed },
        uStreak: { value: streak },
        uWind: { value: new THREE.Vector2(wind[0], wind[1]) },
        uColor: { value: new THREE.Color(0x9ab8e0) },
        uOpacity: { value: 0.42 },
        uRadius: { value: radius },
        uCenter: { value: new THREE.Vector3() },
        uRoofs: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aEnd;
        uniform float uTime, uHeight, uSpeed, uStreak, uRadius;
        uniform vec2 uWind;
        uniform vec3 uCenter;
        varying float vFade;
        void main() {
          float y = mod(position.y - uTime * uSpeed, uHeight);
          vec3 p = vec3(position.x, y + 0.05, position.z);
          // Grade toroidal centrada na câmera: as gotas não "andam" junto quando o jogador anda
          p.xz = mod(p.xz - uCenter.xz + uRadius, uRadius * 2.0) - uRadius + uCenter.xz;
          p.xz += uWind * (uHeight - y) * 0.025;
          p.y += aEnd * uStreak;
          p.xz -= aEnd * uWind * uStreak * 0.025;
          vFade = (1.0 - aEnd) * smoothstep(0.0, 1.5, y);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vFade;
        void main() { gl_FragColor = vec4(uColor, uOpacity * (0.25 + vFade * 0.75)); }`,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.name = "Rain";
    this.scene.add(lines);
    return lines;
  }

  buildEnvironment(world) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x1a2a44);
    env.add(new THREE.HemisphereLight(0x6a8cc0, 0x2a2018, 1.6));
    const orbGeo = new THREE.SphereGeometry(0.9, 8, 6);
    for (const l of world.lights.slice(0, 24)) {
      const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: l.color.clone().multiplyScalar(1.4) }));
      orb.position.copy(l.position);
      env.add(orb);
    }
    const rt = pmrem.fromScene(env, 0.04);
    // Preset "alta": reflexo de ambiente em tudo. "desempenho": só no calçamento molhado (IBL global
    // custava ~2,5 ms/frame numa iGPU, medido).
    if (QUALITY.ibl) {
      this.scene.environment = rt.texture;
      pmrem.dispose();
      return;
    }
    this.scene.traverse((o) => {
      const m = o.material;
      if (m && !Array.isArray(m) && m.userData && m.userData.wet_puddles) {
        m.envMap = rt.texture;
        m.needsUpdate = true;
      }
    });
    pmrem.dispose();
  }

  // Relógio e clima avançam aqui (fonte única do horário do mundo)
  tick(dt) {
    const t = this.time;
    const night = t.hour < 5.5 || t.hour > 19.5;
    t.hour += (dt * (night ? CONFIG.time.nightMinutesPerSecond : CONFIG.time.minutesPerSecond)) / 60;
    if (t.hour >= 24) {
      t.hour -= 24;
      t.day++;
    }
    const w = this.weather;
    w.hold -= dt;
    if (w.hold <= 0) {
      w.target = this.rollWeather();
      w.hold = CONFIG.weather.minHold + Math.random() * (CONFIG.weather.maxHold - CONFIG.weather.minHold);
    }
    w.rain += (w.target - w.rain) * dampFactor(CONFIG.weather.rate, dt);
  }

  rollWeather() {
    const table = CONFIG.weather.table;
    let total = 0;
    for (let i = 0; i < table.length; i++) total += table[i].weight;
    let roll = Math.random() * total;
    for (let i = 0; i < table.length; i++) {
      roll -= table[i].weight;
      if (roll <= 0) return table[i].rain;
    }
    return table[table.length - 1].rain;
  }

  // Estado salvo no servidor (jogo.py: d["mundo"]); sem save, vale o CONFIG de jogo novo
  load(mundo) {
    if (!mundo) return;
    const hora = Number(mundo.hora);
    if (Number.isFinite(hora)) this.time.hour = Math.min(23.999, Math.max(0, hora));
    if (Number.isFinite(Number(mundo.dia))) this.time.day = Math.max(1, Math.floor(Number(mundo.dia)));
    if (Number.isFinite(Number(mundo.chuva))) this.weather.rain = Math.min(1, Math.max(0, Number(mundo.chuva)));
    if (Number.isFinite(Number(mundo.alvo))) this.weather.target = Math.min(1, Math.max(0, Number(mundo.alvo)));
  }

  snapshot() {
    return { hora: +this.time.hour.toFixed(3), dia: this.time.day, chuva: +this.weather.rain.toFixed(3), alvo: this.weather.target };
  }

  clockLabel() {
    const h = Math.floor(this.time.hour);
    const m = Math.floor((this.time.hour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  update(dt, elapsed, camera, playerPos, zone, pixelRatio) {
    this.tick(dt);
    const hour = this.time.hour;
    // Sol: nasce às 6h a leste, põe às 18h a oeste
    const sunAngle = ((hour - 6) / 12) * Math.PI;
    const sunY = Math.sin(sunAngle);
    const daylight = smooth01(-0.08, 0.25, sunY);
    const night = 1 - smooth01(-0.18, 0.06, sunY);
    const dusk = Math.max(0, 1 - Math.abs(sunY) / 0.28) * (1 - night * 0.6);
    const rain = this.weather.rain;
    this.state.night = night;
    this.state.daylight = daylight;
    this.state.rain = rain;
    this.state.sunDir.set(Math.cos(sunAngle) * 0.8, Math.max(0.12, sunY), 0.35).normalize();

    // Lua oposta ao sol (nasce ao anoitecer a leste, cruza o céu e põe ao amanhecer)
    const moonAngle = sunAngle + Math.PI;
    const moonDir = this.sky.material.uniforms.uMoonDir.value;
    moonDir.set(Math.cos(moonAngle) * 0.75, Math.sin(moonAngle), -0.3).normalize();
    const moonUp = smooth01(-0.05, 0.2, moonDir.y);
    // Luz direcional: sol de dia, lua de noite; lua baixa demais vira luz de céu vinda do alto (sombra estável)
    _fwd.set(moonDir.x * 0.5, Math.max(0.55, moonDir.y), moonDir.z * 0.5).normalize();
    const lightDir = daylight > 0.01 ? this.state.sunDir : _fwd;
    _c1.setRGB(1.0, 0.94, 0.84).lerp(_c2.setRGB(1.0, 0.62, 0.38), dusk);
    _c2.set(0x8fa9d9);
    this.sun.color.copy(daylight > 0.01 ? _c1 : _c2);
    this.sun.intensity = daylight > 0.01 ? (0.25 + daylight * 2.1) * (1 - rain * 0.55) : (0.35 + moonUp * 0.4) * (1 - rain * 0.45);
    // Sombra acompanha o jogador, presa à grade de texels para não tremer
    const range = CONFIG.render.shadowRange;
    const texel = (range * 2) / CONFIG.render.shadowMapSize;
    const cx = Math.round(playerPos.x / texel) * texel;
    const cz = Math.round(playerPos.z / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + lightDir.x * 70, lightDir.y * 70, cz + lightDir.z * 70);

    // Céu e névoa
    const u = this.sky.material.uniforms;
    _c1.copy(NIGHT_SKY.zenith).lerp(DUSK_SKY.zenith, dusk).lerp(DAY_SKY.zenith, daylight);
    u.uZenith.value.copy(_c1).lerp(RAIN_TINT, rain * 0.45 * daylight);
    _c1.copy(NIGHT_SKY.mid).lerp(DUSK_SKY.mid, dusk).lerp(DAY_SKY.mid, daylight);
    u.uMid.value.copy(_c1).lerp(RAIN_TINT, rain * 0.5 * daylight);
    _c1.copy(NIGHT_SKY.horizon).lerp(DUSK_SKY.horizon, dusk).lerp(DAY_SKY.horizon, daylight);
    u.uHorizon.value.copy(_c1).lerp(RAIN_TINT, rain * 0.5 * daylight);
    u.uSunDir.value.copy(this.state.sunDir);
    u.uNight.value = night;
    u.uCloud.value = 0.06 + rain * 0.84;
    u.uTime.value = elapsed;
    this.sky.position.set(camera.position.x, 0, camera.position.z);

    // Interior: luz ambiente quente e névoa leve; zonas externas podem adicionar névoa/matiz suave
    const target = zone.building ? 1 : 0;
    this.interiorBlend += (target - this.interiorBlend) * dampFactor(3.0, dt);
    this.zoneFogBoost += ((zone.fogBoost || 0) - this.zoneFogBoost) * dampFactor(2.0, dt);
    const tintDamp = dampFactor(2.0, dt);
    if (zone.ambientTint) {
      this.zoneTint.lerp(_c2.set(zone.ambientTint), tintDamp);
      this.zoneTintMix += (0.24 - this.zoneTintMix) * tintDamp;
    } else {
      this.zoneTintMix += (0 - this.zoneTintMix) * tintDamp;
    }
    const tintFactor = this.zoneTintMix * (1 - this.interiorBlend);
    this.scene.fog.color.copy(u.uHorizon.value).lerp(u.uMid.value, 0.4);
    if (tintFactor > 0.0001) this.scene.fog.color.lerp(this.zoneTint, tintFactor);

    _c1.set(0x3d5986).lerp(_c2.set(0xbfd6f2), daylight);
    this.hemi.color.copy(_c1).lerp(_c2.set(0x6a4a32), this.interiorBlend);
    if (tintFactor > 0.0001) this.hemi.color.lerp(this.zoneTint, tintFactor);
    this.hemi.groundColor.set(0x1b1712).lerp(_c2.set(0x5a5a40), daylight * (1 - this.interiorBlend));
    this.hemi.intensity = THREE.MathUtils.lerp(0.5 + daylight * 0.7, 0.62 + daylight * 0.25, this.interiorBlend);
    this.scene.fog.density = THREE.MathUtils.lerp(0.012 + rain * 0.014 + night * 0.004 + this.zoneFogBoost, 0.006, this.interiorBlend);
    this.renderer.toneMappingExposure = CONFIG.render.exposure * (1 + (1 - daylight) * 0.05);

    // Lampiões acendem ao anoitecer; luzes de interior e fogo ficam sempre ligados
    const lampsOn = smooth01(0.0, 0.6, night + (rain > 0.6 ? 0.25 : 0));
    // Fogo e cristal ao ar livre perdem força sob o sol (senão a forja tinge a rua inteira de vermelho)
    const outdoorFire = 1 - daylight * 0.75;
    for (const a of this.anchors) {
      const k = a.key || "";
      if (a.zone || k === "Fireplace") a.active = 1;
      else if (
        k === "Forja" ||
        k === "ManaCrystal" ||
        k === "TemploBraseiros" ||
        k.startsWith("Ruina") ||
        k.startsWith("Acampamento") ||
        k.startsWith("Santuario")
      ) {
        a.active = Math.max(outdoorFire, lampsOn);
      } else {
        a.active = lampsOn;
      }
    }
    this.world.nightUniform.value = lampsOn;
    this.updateLights(dt, elapsed, playerPos, zone, camera);

    // Chuva e poças
    if (this.rain) {
      const ru = this.rain.material.uniforms;
      ru.uTime.value = elapsed;
      ru.uCenter.value.copy(camera.position);
      ru.uOpacity.value = 0.42 * rain;
      // Dentro de um prédio a câmera fica entre paredes: nada de chuva atravessando o teto
      this.rain.visible = rain > 0.03 && !zone.building;
    }
    this.materials.uniforms.uAlvorRain.value = Math.min(1, rain * 1.2);
  }
}
