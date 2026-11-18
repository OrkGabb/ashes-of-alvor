import * as THREE from "three";
import { CONFIG, QUALITY, flicker } from "./config.js";

// Os extras de cada material do GLB (gerados no Blender) dizem qual conjunto PBR aplicar.
// UVs do GLB estão em METROS, então repeat = 1 / tile_m dá a mesma densidade de texel em toda a vila.

const PUDDLE_GLSL_COMMON = /* glsl */ `
uniform float uAlvorTime;
uniform float uAlvorRain;
varying float vAlvorWetness;
varying vec3 vAlvorWorldPos;
float alvorHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float alvorNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(alvorHash(i), alvorHash(i + vec2(1.0, 0.0)), u.x), mix(alvorHash(i + vec2(0.0, 1.0)), alvorHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 alvorRipple(vec2 p, float t) {
  vec2 cell = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = alvorHash(cell);
  float phase = fract(t * 0.85 + h);
  vec2 d = f - (vec2(alvorHash(cell + 3.1), alvorHash(cell + 7.7)) - 0.5) * 0.5;
  float r = length(d);
  float radius = phase * 0.45;
  float ring = sin((r - radius) * 46.0) * smoothstep(radius + 0.06, radius, r) * smoothstep(radius - 0.12, radius, r) * (1.0 - phase);
  return d / max(r, 1e-3) * ring;
}
`;

// Detalhe pintado nas superfícies do kit Kenney (public/textures/detail.json). A classe do pixel (reboco, viga,
// tábuas, pedra, telha, folhagem, ferro) vem do alfa da paleta, então não custa leitura extra. Uma leitura do
// texture array por pixel: R,G = normal tangente, B = detalhe de luminância. A projeção é alinhada à face:
// tangente horizontal ao longo da superfície e bitangente subindo pela parede ou pelo caimento do telhado, de
// modo que tábuas e fileiras de telha fiquem sempre na horizontal. Some com a distância (uDetailFar).
const DETAIL_MAX_LAYERS = 8;
const DETAIL_GLSL_COMMON = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDetailTex;
uniform float uDetailTile[${DETAIL_MAX_LAYERS}];
uniform float uDetailStrength[${DETAIL_MAX_LAYERS}];
uniform vec2 uDetailRough[${DETAIL_MAX_LAYERS}];
uniform float uDetailNormal;
uniform float uDetailFar;
varying vec3 vDetailPos;
varying vec3 vDetailNormal;
`;

// Slots de textura de cor/superfície que se beneficiam de mipmap + anisotropia
const TEXTURE_SLOTS = Object.freeze(["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap", "bumpMap"]);

export class MaterialLibrary {
  constructor(renderer) {
    this.renderer = renderer;
    this.loader = new THREE.TextureLoader();
    this.manifest = null;
    this.textureSets = new Map();
    this.processed = new Set();
    this.flickering = [];
    this.uniforms = { uAlvorTime: { value: 0 }, uAlvorRain: { value: 1 } };
    // Anisotropia do preset (alta 8, desempenho 4), limitada pela GPU: tira o serrilhado/borrão do chão
    // e das paredes vistas de lado à distância
    this.maxAnisotropy = Math.max(1, Math.min(QUALITY.anisotropy || 4, renderer.capabilities.getMaxAnisotropy() || 1));
    this.tunedTextures = new WeakSet();
    // Array neutro de 1 texel até as camadas carregarem (o tipo do sampler já fica certo no primeiro compile)
    const neutral = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1);
    neutral.needsUpdate = true;
    this.detail = {
      layers: [],
      uniforms: {
        uDetailTex: { value: neutral },
        uDetailTile: { value: new Array(DETAIL_MAX_LAYERS).fill(1) },
        uDetailStrength: { value: new Array(DETAIL_MAX_LAYERS).fill(0) },
        uDetailRough: { value: Array.from({ length: DETAIL_MAX_LAYERS }, () => new THREE.Vector2(0.84, 0)) },
        uDetailNormal: { value: 1 },
        uDetailFar: { value: 60 },
      },
    };
  }

  // Carrega as camadas de detalhe num único DataArrayTexture (pixels crus: sem gestão de cor nem
  // pré-multiplicação, porque os canais são normal e detalhe, não cor)
  async initDetail(far) {
    const spec = await fetch(CONFIG.assets.detailSpec).then((r) => r.json());
    const size = spec.tamanho_px;
    const layers = spec.camadas.slice(0, DETAIL_MAX_LAYERS);
    const u = this.detail.uniforms;
    u.uDetailFar.value = far;
    u.uDetailNormal.value = spec.normal_jogo ?? 1;
    layers.forEach((layer, i) => {
      u.uDetailTile.value[i] = 1 / layer.tile_m;
      u.uDetailStrength.value[i] = layer.forca;
      u.uDetailRough.value[i].set(layer.rugosidade[0], layer.rugosidade[1]);
    });
    const data = new Uint8Array(size * size * 4 * layers.length);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    for (let i = 0; i < layers.length; i++) {
      const res = await fetch(`${CONFIG.assets.textureDir}detail/${layers[i].id}.png`);
      if (!res.ok) {
        // Camada ainda não gerada: neutra (normal reta, detalhe 1,0), as outras seguem valendo
        data.fill(128, i * size * size * 4, (i + 1) * size * size * 4);
        continue;
      }
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "flipY" });
      g.clearRect(0, 0, size, size);
      g.drawImage(bmp, 0, 0, size, size);
      // flipY: a linha 0 do array é v = 0 (base), então o topo da imagem fica no alto da parede
      data.set(g.getImageData(0, 0, size, size).data, i * size * size * 4);
      bmp.close();
    }
    const tex = new THREE.DataArrayTexture(data, size, size, layers.length);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.maxAnisotropy;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    u.uDetailTex.value = tex;
    this.detail.layers = layers.map((l) => l.id);
  }

  // Liga o detalhe pintado num material de paleta Kenney (classe no alfa do mapa)
  enableSurfaceDetail(material) {
    const uniforms = this.detail.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vDetailPos;\nvarying vec3 vDetailNormal;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vec4 alvorWP = vec4(transformed, 1.0);
          vec3 alvorWN = objectNormal;
          #ifdef USE_INSTANCING
            alvorWP = instanceMatrix * alvorWP;
            alvorWN = mat3(instanceMatrix) * alvorWN;
          #endif
          vDetailPos = (modelMatrix * alvorWP).xyz;
          vDetailNormal = mat3(modelMatrix) * alvorWN;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + DETAIL_GLSL_COMMON)
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          // Classe da superfície no alfa da paleta: 255 = sem detalhe, 255 - 32 k = camada k
          float alvorCls = floor((1.0 - sampledDiffuseColor.a) * 7.97 + 0.5);
          diffuseColor.a = opacity;
          int alvorLayer = int(max(alvorCls - 1.0, 0.0));
          vec3 alvorN = normalize(vDetailNormal);
          vec3 alvorT = abs(alvorN.y) > 0.97 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), alvorN));
          vec3 alvorB = cross(alvorN, alvorT);
          vec2 alvorUv = vec2(dot(vDetailPos, alvorT), dot(vDetailPos, alvorB)) * uDetailTile[alvorLayer];
          // Leitura fora de qualquer desvio (derivadas do mipmap válidas em todo pixel). Medido na iGPU alvo:
          // textureGrad dentro de um if por distância saiu mais caro (+3 ms) que esta leitura simples (+1,5 ms)
          vec3 alvorD = texture(uDetailTex, vec3(alvorUv, float(alvorLayer))).rgb;
          float alvorFade = alvorCls > 0.5 ? clamp(1.0 - length(vDetailPos - cameraPosition) / uDetailFar, 0.0, 1.0) : 0.0;
          diffuseColor.rgb *= mix(1.0, alvorD.b * 2.0, uDetailStrength[alvorLayer] * alvorFade);`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          vec2 alvorR = uDetailRough[alvorLayer];
          roughnessFactor = mix(roughnessFactor, clamp(alvorR.x - (alvorD.b * 2.0 - 1.0) * alvorR.y, 0.04, 1.0), alvorFade);`
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          vec2 alvorNxy = (alvorD.rg * 2.0 - 1.0) * uDetailNormal * alvorFade;
          normal = normalize(normal + (viewMatrix * vec4(alvorT * alvorNxy.x + alvorB * alvorNxy.y, 0.0)).xyz);`
        );
    };
    material.customProgramCacheKey = () => "alvor-surface-detail";
  }

  async init() {
    const res = await fetch(CONFIG.assets.textureManifest);
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    this.manifest = await res.json();
  }

  textureSet(name) {
    if (this.textureSets.has(name)) return this.textureSets.get(name);
    const spec = this.manifest && this.manifest.sets[name];
    if (!spec) return null;
    const repeat = 1 / spec.tile_m;
    const load = (file, srgb) => {
      const tex = this.loader.load(CONFIG.assets.textureDir + file);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.flipY = false; // convenção glTF: origem do UV no topo da imagem
      tex.repeat.set(repeat, repeat);
      this.tuneTexture(tex);
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return tex;
    };
    const set = {
      map: load(spec.files.map, true),
      normalMap: load(spec.files.normalMap, false),
      roughnessMap: load(spec.files.roughnessMap, false),
    };
    this.textureSets.set(name, set);
    return set;
  }

  /**
   * Filtragem de qualidade numa textura de cor/detalhe: mipmaps trilineares + anisotropia do preset.
   * Idempotente (cada textura é ajustada uma vez). DataTexture sem mipmaps gerados e texturas com
   * filtro NEAREST de propósito (pixel art) ficam como estão.
   * @param {THREE.Texture | null | undefined} tex
   * @returns {THREE.Texture | null | undefined}
   */
  tuneTexture(tex) {
    if (!tex || !tex.isTexture || this.tunedTextures.has(tex)) return tex;
    this.tunedTextures.add(tex);
    if (tex.magFilter === THREE.NearestFilter) return tex;
    let changed = false;
    if (!tex.isDataTexture || tex.generateMipmaps) {
      if (!tex.generateMipmaps) {
        tex.generateMipmaps = true;
        changed = true;
      }
      if (tex.minFilter !== THREE.LinearMipmapLinearFilter) {
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        changed = true;
      }
    }
    if (tex.anisotropy !== this.maxAnisotropy) {
      tex.anisotropy = this.maxAnisotropy;
      changed = true;
    }
    // Só reenvia à GPU se a imagem já chegou (senão o upload normal já sai com os novos parâmetros)
    if (changed && tex.image) tex.needsUpdate = true;
    return tex;
  }

  /**
   * Ajusta todos os mapas de um material (ou array de materiais).
   * @param {THREE.Material | THREE.Material[] | null | undefined} material
   */
  tuneMaterial(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      for (let i = 0; i < material.length; i++) this.tuneMaterial(material[i]);
      return;
    }
    for (let i = 0; i < TEXTURE_SLOTS.length; i++) this.tuneTexture(material[TEXTURE_SLOTS[i]]);
  }

  /**
   * Percorre uma subárvore (cidade inteira, personagem, arma) e ajusta as texturas de todos os materiais.
   * Rodar uma vez depois de loadWorld (as texturas dos kits glTF e as paletas do KitMaterials não passam
   * por prepare()). Custo: um traverse no carregamento, nada por frame.
   * @param {THREE.Object3D} root
   * @returns {number} quantidade de malhas visitadas
   */
  tuneScene(root) {
    let meshes = 0;
    root.traverse((o) => {
      if (!o.material) return;
      meshes++;
      this.tuneMaterial(o.material);
    });
    return meshes;
  }

  // Aplica uma única vez por material (materiais são compartilhados entre malhas)
  prepare(material, geometry) {
    if (this.processed.has(material.uuid)) return;
    this.processed.add(material.uuid);
    const extras = material.userData || {};
    const setName = extras.pbr_set;
    if (setName) {
      const set = this.textureSet(setName);
      if (set) {
        material.map = set.map;
        material.normalMap = set.normalMap;
        material.roughnessMap = set.roughnessMap;
        const ns = Number(extras.normal_scale ?? 1);
        material.normalScale = new THREE.Vector2(ns, -ns);
        material.roughness = Number(extras.rough_mul ?? 1);
        material.metalness = 0;
      }
    }
    if (extras.wet_puddles) this.enableWetPuddles(material, geometry);
    if (extras.flicker && material.emissiveIntensity !== undefined) {
      this.flickering.push({
        material,
        base: material.emissiveIntensity,
        seed: this.flickering.length * 2.17,
        amp: extras.flicker === "fire" ? 0.28 : extras.flicker === "mana" ? 0.12 : 0.06,
        speed: extras.flicker === "fire" ? 1.0 : 0.45,
      });
    }
    this.tuneMaterial(material);
    material.needsUpdate = true;
  }

  // Água dos chafarizes: ondulação procedural (duas camadas de ruído correndo em sentidos opostos) na normal
  // e um leve escurecimento nos vales; sem textura, e a área de água é pequena
  enableWater(material) {
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uAlvorTime = uniforms.uAlvorTime;
      shader.uniforms.uAlvorRain = uniforms.uAlvorRain;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vAlvorWorldPos;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vec4 alvorWW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            alvorWW = instanceMatrix * alvorWW;
          #endif
          vAlvorWorldPos = (modelMatrix * alvorWW).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + PUDDLE_GLSL_COMMON.replace("varying float vAlvorWetness;", ""))
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          vec2 alvorP = vAlvorWorldPos.xz * 3.0;
          float alvorT = uAlvorTime * 0.6;
          float alvorE = 0.08;
          float alvorH0 = alvorNoise(alvorP + vec2(alvorT, alvorT * 0.7)) + alvorNoise(alvorP * 1.9 - vec2(alvorT * 1.3, -alvorT * 0.4)) * 0.5;
          float alvorHx = alvorNoise(alvorP + vec2(alvorE, 0.0) + vec2(alvorT, alvorT * 0.7)) + alvorNoise((alvorP + vec2(alvorE, 0.0)) * 1.9 - vec2(alvorT * 1.3, -alvorT * 0.4)) * 0.5;
          float alvorHz = alvorNoise(alvorP + vec2(0.0, alvorE) + vec2(alvorT, alvorT * 0.7)) + alvorNoise((alvorP + vec2(0.0, alvorE)) * 1.9 - vec2(alvorT * 1.3, -alvorT * 0.4)) * 0.5;
          vec2 alvorG = vec2(alvorHx - alvorH0, alvorHz - alvorH0) / alvorE * (0.06 + 0.06 * uAlvorRain);
          normal = normalize(normal + (viewMatrix * vec4(-alvorG.x, 0.0, -alvorG.y, 0.0)).xyz);
          diffuseColor.rgb *= 0.88 + 0.12 * alvorH0;`
        );
    };
    material.customProgramCacheKey = () => "alvor-water";
  }

  // Poças: roughness e albedo vêm do shader a partir da máscara de umidade do relevo (atributo _wetness)
  enableWetPuddles(material, geometry) {
    if (geometry && geometry.getAttribute("_wetness")) {
      geometry.setAttribute("aAlvorWetness", geometry.getAttribute("_wetness"));
      geometry.deleteAttribute("_wetness");
    }
    material.envMapIntensity = 1.25;
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uAlvorTime = uniforms.uAlvorTime;
      shader.uniforms.uAlvorRain = uniforms.uAlvorRain;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aAlvorWetness;\nvarying float vAlvorWetness;\nvarying vec3 vAlvorWorldPos;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvAlvorWetness = aAlvorWetness;\nvAlvorWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + PUDDLE_GLSL_COMMON)
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
          float alvorBreakup = alvorNoise(vAlvorWorldPos.xz * 1.3) * 0.6 + alvorNoise(vAlvorWorldPos.xz * 4.1) * 0.4;
          float alvorPuddle = smoothstep(0.32, 0.62, vAlvorWetness + (alvorBreakup - 0.5) * 0.45);`
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          diffuseColor.rgb *= mix(mix(1.0, 0.78, uAlvorRain), 0.42, alvorPuddle);`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor * mix(1.0, 0.7, uAlvorRain), 0.035, alvorPuddle);`
        )
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nvec3 alvorFlatNormal = normal;")
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          // Ondulações da chuva só onde há poça e chove (ramo dinâmico: o resto do chão não paga o custo)
          if (alvorPuddle > 0.02 && uAlvorRain > 0.05) {
            vec2 alvorR = alvorRipple(vAlvorWorldPos.xz * 2.2, uAlvorTime) + alvorRipple(vAlvorWorldPos.xz * 3.7 + 11.0, uAlvorTime * 1.3) * 0.6;
            vec3 alvorRippleView = (viewMatrix * vec4(alvorR.x, 0.0, alvorR.y, 0.0)).xyz * 0.35 * uAlvorRain;
            normal = normalize(mix(normal, normalize(alvorFlatNormal + alvorRippleView), alvorPuddle));
          } else {
            normal = normalize(mix(normal, alvorFlatNormal, alvorPuddle));
          }`
        );
    };
    material.customProgramCacheKey = () => "alvor-wet-puddles";
  }

  update(elapsed) {
    this.uniforms.uAlvorTime.value = elapsed;
    for (let i = 0; i < this.flickering.length; i++) {
      const f = this.flickering[i];
      f.material.emissiveIntensity = f.base * (1 + flicker(elapsed, f.seed, f.speed) * f.amp);
    }
  }
}
