import * as THREE from "three";
import { OrbitControls } from "https://unpkg.com/three@0.153.0/examples/jsm/controls/OrbitControls.js";
import * as POSTPROCESSING from "postprocessing";
import { SSGIEffect, VelocityDepthNormalPass } from "material-wox";

// --- STATE MANAGEMENT ---
const state = {
    prompt: 'concrete',
    roughnessBase: 0.5,
    metallicBase: 0.0,
    displacementScale: 0.05,
    tiling: 1,
    noiseFrequency: 2.0,
    opacity: 1.0,
    autorotate: true,
    meshShape: 'sphere',
    lightSetup: 'studio',
    isGenerating: false,
    
    // AI Backend parameters
    aiBackend: 'comfyui', // 'pollinations' or 'comfyui'
    comfyUrl: 'http://127.0.0.1:8188',
    comfyModel: 'z_image_turbo_bf16.safetensors',
    comfyWeightDtype: 'default',
    comfyClip: 'qwen_3_4b.safetensors',
    comfyClipType: 'lumina2',
    comfyVae: 'ae.safetensors'
};

// --- DOM ELEMENTS ---
const elements = {
    canvasAlbedo: document.getElementById('canvas-albedo'),
    canvasNormal: document.getElementById('canvas-normal'),
    canvasSpecular: document.getElementById('canvas-specular'),
    canvasDisplacement: document.getElementById('canvas-displacement'),
    canvasReflection: document.getElementById('canvas-reflection'),
    
    inputRoughness: document.getElementById('input-roughness'),
    inputMetallic: document.getElementById('input-metallic'),
    inputDisplacement: document.getElementById('input-displacement'),
    inputTiling: document.getElementById('input-tiling'),
    inputFrequency: document.getElementById('input-frequency'),
    inputOpacity: document.getElementById('input-opacity'),
    
    valRoughness: document.getElementById('val-roughness'),
    valMetallic: document.getElementById('val-metallic'),
    valDisplacement: document.getElementById('val-displacement'),
    valTiling: document.getElementById('val-tiling'),
    valFrequency: document.getElementById('val-frequency'),
    valOpacity: document.getElementById('val-opacity'),
    
    promptInput: document.getElementById('prompt-input'),
    btnGenerate: document.getElementById('btn-generate'),
    btnDownloadAll: document.getElementById('btn-download-all'),
    presetBtns: document.querySelectorAll('.preset-btn'),
    
    // AI Config elements
    selectBackend: document.getElementById('select-backend'),
    comfySettingsGroup: document.getElementById('comfyui-settings'),
    inputComfyUrl: document.getElementById('input-comfy-url'),
    inputComfyModel: document.getElementById('input-comfy-model'),
    selectComfyWeightDtype: document.getElementById('input-comfy-weight-dtype'),
    inputComfyClip: document.getElementById('input-comfy-clip'),
    selectComfyClipType: document.getElementById('input-comfy-clip-type'),
    inputComfyVae: document.getElementById('input-comfy-vae'),
    
    threeContainer: document.getElementById('threejs-container'),
    selectMesh: document.getElementById('select-mesh'),
    selectLight: document.getElementById('select-light'),
    btnRotate: document.getElementById('btn-rotate'),
    toast: document.getElementById('toast')
};

// --- NOISE HELPER FUNCTIONS (For fallback procedural engine) ---
function createNoiseGenerator() {
    const size = 256;
    const grad = new Float32Array(size * size);
    for (let i = 0; i < grad.length; i++) {
        grad[i] = Math.random();
    }
    
    function getValue(x, y) {
        x = ((x % size) + size) % size;
        y = ((y % size) + size) % size;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = (x0 + 1) % size;
        const y1 = (y0 + 1) % size;
        
        const tx = x - x0;
        const ty = y - y0;
        
        const u = tx * tx * (3 - 2 * tx);
        const v = ty * ty * (3 - 2 * ty);
        
        const val00 = grad[y0 * size + x0];
        const val10 = grad[y0 * size + x1];
        const val01 = grad[y1 * size + x0];
        const val11 = grad[y1 * size + x1];
        
        return val00 + u * (val10 - val00) + v * ((val01 + u * (val11 - val01)) - (val00 + u * (val10 - val00)));
    }
    
    return function fbm(x, y, octaves = 4) {
        let value = 0;
        let amplitude = 1.0;
        let frequency = 1.0;
        let maxVal = 0;
        for (let i = 0; i < octaves; i++) {
            value += getValue(x * frequency, y * frequency) * amplitude;
            maxVal += amplitude;
            frequency *= 2.0;
        }
        return value / maxVal;
    };
}

const fbmNoise = createNoiseGenerator();

// --- PBR MAPS BAKER & AI EXTRACTOR ---

function getPixelIndex(x, y, width) {
    return (y * width + x) * 4;
}

let lastAlbedoSource = null;
const canvasRoughnessOffscreen = document.createElement('canvas');
canvasRoughnessOffscreen.width = 512;
canvasRoughnessOffscreen.height = 512;

// Generate PBR maps from loaded Albedo Image or Canvas
function processAlbedoToPBR(imgSource) {
    let width = 512;
    let height = 512;

    if (imgSource && imgSource.width && imgSource.height) {
        width = imgSource.width;
        height = imgSource.height;
    }

    const canvases = [elements.canvasAlbedo, elements.canvasNormal, elements.canvasSpecular, elements.canvasDisplacement, elements.canvasReflection];
    canvases.forEach(c => {
        if (c.width !== width || c.height !== height) {
            c.width = width;
            c.height = height;
        }
    });
    if (canvasRoughnessOffscreen.width !== width || canvasRoughnessOffscreen.height !== height) {
        canvasRoughnessOffscreen.width = width;
        canvasRoughnessOffscreen.height = height;
    }

    const ctxAlbedo = elements.canvasAlbedo.getContext('2d', { willReadFrequently: true });
    const ctxNormal = elements.canvasNormal.getContext('2d', { willReadFrequently: true });
    const ctxSpecular = elements.canvasSpecular.getContext('2d', { willReadFrequently: true });
    const ctxDisplacement = elements.canvasDisplacement.getContext('2d', { willReadFrequently: true });
    const ctxReflection = elements.canvasReflection.getContext('2d', { willReadFrequently: true });
    const ctxRoughnessOffscreen = canvasRoughnessOffscreen.getContext('2d', { willReadFrequently: true });

    // Store reference if a new source image is passed
    if (imgSource && imgSource !== elements.canvasAlbedo) {
        lastAlbedoSource = imgSource;
    }

    // Always redraw the cached source image onto albedo before processing
    if (lastAlbedoSource) {
        ctxAlbedo.drawImage(lastAlbedoSource, 0, 0, width, height);
    }

    const imgAlbedo = ctxAlbedo.getImageData(0, 0, width, height);
    const imgSpecular = ctxSpecular.createImageData(width, height);
    const imgDisplacement = ctxDisplacement.createImageData(width, height);
    const imgReflection = ctxReflection.createImageData(width, height);
    const imgRoughness = ctxRoughnessOffscreen.createImageData(width, height);

    const promptLower = state.prompt.toLowerCase();

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = getPixelIndex(x, y, width);
            
            const r = imgAlbedo.data[idx];
            const g = imgAlbedo.data[idx + 1];
            const b = imgAlbedo.data[idx + 2];
            const a = imgAlbedo.data[idx + 3];

            const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
            
            // Displacement Map
            let h = luma;
            if (promptLower.includes('brick') || promptLower.includes('wood') || promptLower.includes('concrete')) {
                h = Math.pow(luma, 1.3);
            }
            const dispVal = Math.max(0, Math.min(255, h * 255));
            imgDisplacement.data[idx] = dispVal;
            imgDisplacement.data[idx + 1] = dispVal;
            imgDisplacement.data[idx + 2] = dispVal;
            imgDisplacement.data[idx + 3] = a;

            // Specular Map (High highlights on smooth surfaces, low on rough surfaces - inverse of roughness)
            let rough = state.roughnessBase;
            if (promptLower.includes('gold') || promptLower.includes('metal') || promptLower.includes('iron') || promptLower.includes('marble')) {
                rough = Math.max(0.02, state.roughnessBase * (0.35 + (1.0 - luma) * 0.65));
            } else {
                rough = Math.min(0.98, state.roughnessBase * (0.65 + luma * 0.35));
            }
            const specularVal = Math.max(0, Math.min(255, (1.0 - rough) * 255));
            imgSpecular.data[idx] = specularVal;
            imgSpecular.data[idx + 1] = specularVal;
            imgSpecular.data[idx + 2] = specularVal;
            imgSpecular.data[idx + 3] = a;

            // Roughness map (offscreen canvas used by ThreeJS)
            const roughVal = Math.max(0, Math.min(255, rough * 255));
            imgRoughness.data[idx] = roughVal;
            imgRoughness.data[idx + 1] = roughVal;
            imgRoughness.data[idx + 2] = roughVal;
            imgRoughness.data[idx + 3] = a;

            // Reflection Map (Metallic/Reflective surface mapping)
            let metal = state.metallicBase;
            if (promptLower.includes('gold') || promptLower.includes('metal') || promptLower.includes('iron') || promptLower.includes('copper')) {
                metal = Math.max(0.75, state.metallicBase * (0.4 + luma * 0.6));
            } else {
                metal = state.metallicBase * 0.1;
            }
            const metalVal = Math.max(0, Math.min(255, metal * 255));
            imgReflection.data[idx] = metalVal;
            imgReflection.data[idx + 1] = metalVal;
            imgReflection.data[idx + 2] = metalVal;
            imgReflection.data[idx + 3] = a;
        }
    }

    ctxDisplacement.putImageData(imgDisplacement, 0, 0);
    ctxSpecular.putImageData(imgSpecular, 0, 0);
    ctxReflection.putImageData(imgReflection, 0, 0);
    ctxRoughnessOffscreen.putImageData(imgRoughness, 0, 0);

    // 2. GENERATE NORMAL MAP VIA SOBEL
    const imgNormal = ctxNormal.createImageData(width, height);
    const normalStrength = state.noiseFrequency * 2.5;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const getVal = (px, py) => {
                const tx = (px + width) % width;
                const ty = (py + height) % height;
                return imgDisplacement.data[getPixelIndex(tx, ty, width)] / 255.0;
            };

            const tl = getVal(x - 1, y - 1);
            const t  = getVal(x,     y - 1);
            const tr = getVal(x + 1, y - 1);
            const l  = getVal(x - 1, y);
            const r  = getVal(x + 1, y);
            const bl = getVal(x - 1, y + 1);
            const b  = getVal(x,     y + 1);
            const br = getVal(x + 1, y + 1);

            const dX = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
            const dY = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);

            const nx = -dX * normalStrength;
            const ny = -dY * normalStrength;
            const nz = 1.0;

            const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
            const rN = (nx / len) * 0.5 + 0.5;
            const gN = (ny / len) * 0.5 + 0.5;
            const bN = (nz / len) * 0.5 + 0.5;

            const idx = getPixelIndex(x, y, width);
            imgNormal.data[idx] = Math.floor(rN * 255);
            imgNormal.data[idx + 1] = Math.floor(gN * 255);
            imgNormal.data[idx + 2] = Math.floor(bN * 255);
            imgNormal.data[idx + 3] = imgAlbedo.data[idx + 3];
        }
    }
    ctxNormal.putImageData(imgNormal, 0, 0);

    updateThreeJSTextures();
}

// Fallback: Generates a high quality procedural material locally on canvas if AI is offline
function generateProceduralFallback() {
    const width = 512;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    
    const promptLower = state.prompt.toLowerCase();
    const freq = state.noiseFrequency;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const nx = (x / width) * freq * 10;
            const ny = (y / height) * freq * 10;
            const idx = getPixelIndex(x, y, width);
            
            let r = 128, g = 128, b = 128;

            if (promptLower.includes('gold') || promptLower.includes('oro')) {
                const noiseVal = fbmNoise(nx * 0.5, ny * 0.5, 4);
                r = 255 - noiseVal * 15;
                g = 215 - noiseVal * 25;
                b = 100 - noiseVal * 30;
            } else if (promptLower.includes('rust') || promptLower.includes('iron') || promptLower.includes('ferro')) {
                const rustNoise = fbmNoise(nx * 0.8, ny * 0.8, 5);
                const ironNoise = fbmNoise(nx * 3, ny * 3, 3);
                if (rustNoise > 0.52) {
                    const factor = (rustNoise - 0.52) / 0.48;
                    r = 110 + factor * 50; g = 55 + factor * 20; b = 30 + factor * 10;
                } else {
                    const val = 45 + ironNoise * 20;
                    r = val; g = val; b = val;
                }
            } else if (promptLower.includes('wood') || promptLower.includes('legno')) {
                const woodX = nx * 0.4;
                const woodY = ny * 1.5;
                const wave = Math.sin(woodX * 2 + fbmNoise(woodX, woodY, 2) * 5);
                const normWave = (wave + 1) * 0.5;
                r = 90 + normWave * 45; g = 55 + normWave * 30; b = 30 + normWave * 20;
            } else if (promptLower.includes('brick') || promptLower.includes('matton')) {
                const scaleX = 4;
                const scaleY = 10;
                const cellY = Math.floor(y / (height / scaleY));
                const offsetX = (cellY % 2 === 0) ? (width / scaleX) / 2 : 0;
                const localX = ((x + offsetX) % (width / scaleX)) / (width / scaleX);
                const localY = (y % (height / scaleY)) / (height / scaleY);
                const isBorder = (localX < 0.06 || localX > 0.94 || localY < 0.15 || localY > 0.85);
                if (isBorder) {
                    const mortarNoise = fbmNoise(nx * 2, ny * 2, 3);
                    r = 180 + mortarNoise * 30; g = 180 + mortarNoise * 30; b = 180 + mortarNoise * 30;
                } else {
                    const brickNoise = fbmNoise(nx * 1.5, ny * 1.5, 4);
                    r = 150 + brickNoise * 50; g = 60 + brickNoise * 30; b = 40 + brickNoise * 20;
                }
            } else if (promptLower.includes('marble') || promptLower.includes('marmo')) {
                const noiseVal = fbmNoise(nx * 0.3 + fbmNoise(nx * 0.5, ny * 0.5, 3) * 0.8, ny * 0.3, 4);
                const vein = Math.pow(Math.abs(Math.sin(noiseVal * Math.PI * 4)), 8);
                const baseColor = 220 + fbmNoise(nx, ny, 2) * 35;
                r = baseColor * (1.0 - vein * 0.7);
                g = baseColor * (1.0 - vein * 0.7);
                b = (baseColor + 10) * (1.0 - vein * 0.6);
            } else {
                // Concrete/Stone
                const baseNoise = fbmNoise(nx, ny, 4);
                const fineNoise = fbmNoise(nx * 4, ny * 4, 3);
                const colVal = 100 + baseNoise * 60 + fineNoise * 15;
                r = colVal; g = colVal; b = colVal;
            }

            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    processAlbedoToPBR(canvas);
}

// Generate PBR texture maps via Pollinations AI
function generatePollinationsMaterial() {
    let promptQuery = state.prompt;
    if (!promptQuery.toLowerCase().includes('texture')) {
        promptQuery += " seamless texture, highly detailed, tileable pattern, PBR material";
    }

    const randomSeed = Math.floor(Math.random() * 999999);
    const rawUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptQuery)}?width=512&height=512&nologo=true&seed=${randomSeed}`;
    const url = `https://corsproxy.io/?${rawUrl}`;

    fetch(url)
        .then(response => {
            if (!response.ok) throw new Error("Image server returned error status");
            return response.blob();
        })
        .then(blob => {
            const objectURL = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = function() {
                processAlbedoToPBR(img);
                URL.revokeObjectURL(objectURL);
                state.isGenerating = false;
                elements.btnGenerate.disabled = false;
                elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
                elements.btnGenerate.querySelector('span').textContent = 'Genera';
                showToast("Texture generata con successo via AI!");
            };
            img.onerror = function() {
                throw new Error("Failed to load fetched blob image");
            };
            img.src = objectURL;
        })
        .catch(error => {
            console.warn("AI generation failed, launching local procedural engine fallback:", error);
            generateProceduralFallback();
            
            state.isGenerating = false;
            elements.btnGenerate.disabled = false;
            elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
            elements.btnGenerate.querySelector('span').textContent = 'Genera';
            showToast("Server AI offline. Caricata texture procedurale locale.");
        });
}

// Generate PBR texture maps via Local ComfyUI API
function generateComfyUIMaterial() {
    const seed = Math.floor(Math.random() * 9999999999);
    
    // Workflow structure exported from ComfyUI API format
    const workflow = {
      "83:28": {
        "class_type": "UNETLoader",
        "inputs": {
          "unet_name": state.comfyModel,
          "weight_dtype": state.comfyWeightDtype
        }
      },
      "83:30": {
        "class_type": "CLIPLoader",
        "inputs": {
          "clip_name": state.comfyClip,
          "type": state.comfyClipType,
          "device": "default"
        }
      },
      "83:29": {
        "class_type": "VAELoader",
        "inputs": {
          "vae_name": state.comfyVae
        }
      },
      "83:13": {
        "class_type": "EmptySD3LatentImage",
        "inputs": {
          "width": 512,
          "height": 512,
          "batch_size": 1
        }
      },
      "83:27": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": state.prompt + ", seamless texture, tileable pattern, PBR material",
          "clip": ["83:30", 0]
        }
      },
      "83:33": {
        "class_type": "ConditioningZeroOut",
        "inputs": {
          "conditioning": ["83:27", 0]
        }
      },
      "83:3": {
        "class_type": "KSampler",
        "inputs": {
          "seed": seed,
          "steps": 4,
          "cfg": 1,
          "sampler_name": "res_multistep",
          "scheduler": "simple",
          "denoise": 1,
          "model": ["83:28", 0],
          "positive": ["83:27", 0],
          "negative": ["83:33", 0],
          "latent_image": ["83:13", 0]
        }
      },
      "83:8": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": ["83:3", 0],
          "vae": ["83:29", 0]
        }
      },
      "83:99": {
        "class_type": "ImageScale",
        "inputs": {
          "image": ["83:8", 0],
          "width": 1024,
          "height": 1024,
          "upscale_method": "bicubic",
          "crop": "disabled"
        }
      },
      "60": {
        "class_type": "SaveImage",
        "inputs": {
          "filename_prefix": "z-image-turbo",
          "images": ["83:99", 0]
        }
      }
    };

    const host = state.comfyUrl.replace(/\/$/, ""); // trim trailing slash

    fetch(`${host}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow })
    })
    .then(async response => {
        if (!response.ok) {
            const errDetails = await response.text();
            throw new Error(`Errore durante l'invio della coda ComfyUI: ${errDetails}`);
        }
        return response.json();
    })
    .then(data => {
        const promptId = data.prompt_id;
        showToast("Prompt inviato. Elaborazione in corso su ComfyUI...");
        pollComfyUIHistory(host, promptId);
    })
    .catch(err => {
        console.error(err);
        state.isGenerating = false;
        elements.btnGenerate.disabled = false;
        elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
        elements.btnGenerate.querySelector('span').textContent = 'Genera';
        alert("Errore CORS o di connessione a ComfyUI!\n\nPer consentire alla Webapp di comunicare con ComfyUI, avvialo da riga di comando abilitando i permessi CORS:\npython main.py --allow-cors-origin=*");
        showToast("CORS bloccato. Avvia ComfyUI con --allow-cors-origin=*");
    });
}

function pollComfyUIHistory(host, promptId) {
    const checkInterval = setInterval(() => {
        fetch(`${host}/history/${promptId}`)
            .then(res => res.json())
            .then(data => {
                if (data && data[promptId]) {
                    clearInterval(checkInterval);
                    const promptData = data[promptId];
                    const outputs = promptData.outputs;
                    
                    if (outputs && outputs["60"] && outputs["60"].images && outputs["60"].images.length > 0) {
                        const filename = outputs["60"].images[0].filename;
                        const subfolder = outputs["60"].images[0].subfolder || "";
                        const type = outputs["60"].images[0].type || "output";
                        
                        let imageUrl = `${host}/view?filename=${encodeURIComponent(filename)}&type=${type}`;
                        if (subfolder) {
                            imageUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
                        }
                        
                        // Load image onto canvases
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.onload = function() {
                            processAlbedoToPBR(img);
                            state.isGenerating = false;
                            elements.btnGenerate.disabled = false;
                            elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
                            elements.btnGenerate.querySelector('span').textContent = 'Genera';
                            showToast("Texture ComfyUI caricata con successo!");
                        };
                        img.onerror = function() {
                            state.isGenerating = false;
                            elements.btnGenerate.disabled = false;
                            elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
                            elements.btnGenerate.querySelector('span').textContent = 'Genera';
                            showToast("Errore durante il caricamento dell'immagine generata.");
                        };
                        img.src = imageUrl;
                    } else {
                        throw new Error("Nessuna immagine trovata nell'output di ComfyUI");
                    }
                }
            })
            .catch(err => {
                console.error("Errore durante il polling di ComfyUI:", err);
                clearInterval(checkInterval);
                state.isGenerating = false;
                elements.btnGenerate.disabled = false;
                elements.btnGenerate.querySelector('i').classList.remove('fa-spin');
                elements.btnGenerate.querySelector('span').textContent = 'Genera';
                showToast("Errore di elaborazione su ComfyUI.");
            });
    }, 1000);
}

// Controller routing depending on active AI backend
function generateAIMaterial() {
    if (state.isGenerating) return;
    
    state.isGenerating = true;
    elements.btnGenerate.disabled = true;
    elements.btnGenerate.querySelector('i').classList.add('fa-spin');
    elements.btnGenerate.querySelector('span').textContent = 'Generando...';
    showToast("Elaborazione AI...");

    if (state.aiBackend === 'comfyui') {
        state.isGenerating = false; // reset inside function logic
        generateComfyUIMaterial();
    } else {
        generatePollinationsMaterial();
    }
}

// --- THREE.JS VIEWPORT CONTROLS & RENDERER ---

let scene, camera, renderer, orbitControls, composer;
let mainMesh, pbrMaterial;
let studioLightGroup, warmLightGroup, coolLightGroup, dramaticLightGroup;
let albedoTex, normalTex, roughnessTex, displacementTex, metallicTex;

// Generates a custom studio lighting environment map procedurally using Canvas
function createStudioEnvironmentMap() {
    const width = 1024;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    // Gradient dark background
    const grad = ctx.createRadialGradient(width/2, height/2, 10, width/2, height/2, width/2);
    grad.addColorStop(0, '#111622');
    grad.addColorStop(1, '#05070a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    
    // Smooth Softbox 1: Left high white/neutral softbox
    let g1 = ctx.createRadialGradient(280, 120, 0, 280, 120, 160);
    g1.addColorStop(0, 'rgba(255, 255, 255, 1)');
    g1.addColorStop(0.3, 'rgba(240, 245, 255, 0.7)');
    g1.addColorStop(1, 'rgba(240, 245, 255, 0)');
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, width, height);

    // Smooth Softbox 2: Right vertical softbox
    let g2 = ctx.createRadialGradient(780, 250, 0, 780, 250, 260);
    g2.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    g2.addColorStop(0.4, 'rgba(220, 230, 255, 0.45)');
    g2.addColorStop(1, 'rgba(220, 230, 255, 0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, width, height);
    
    // Smooth Softbox 3: Top glow softbox
    let g5 = ctx.createRadialGradient(500, 50, 0, 500, 50, 120);
    g5.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    g5.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g5;
    ctx.fillRect(0, 0, width, height);
    
    // Colored Accent 1: Purple back-light
    let g3 = ctx.createRadialGradient(480, 280, 0, 480, 280, 220);
    g3.addColorStop(0, 'rgba(99, 102, 241, 0.75)');
    g3.addColorStop(0.5, 'rgba(99, 102, 241, 0.18)');
    g3.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = g3;
    ctx.fillRect(0, 0, width, height);
    
    // Colored Accent 2: Pink side-light
    let g4 = ctx.createRadialGradient(220, 380, 0, 220, 380, 200);
    g4.addColorStop(0, 'rgba(236, 72, 153, 0.65)');
    g4.addColorStop(0.4, 'rgba(236, 72, 153, 0.12)');
    g4.addColorStop(1, 'rgba(236, 72, 153, 0)');
    ctx.fillStyle = g4;
    ctx.fillRect(0, 0, width, height);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    return texture;
}

function initThreeJS() {
    const container = elements.threeContainer;
    const width = container.clientWidth;
    const height = container.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c10);
    scene.fog = new THREE.FogExp2(0x0a0c10, 0.02);

    // Apply custom studio environment map for photorealistic reflections
    scene.environment = createStudioEnvironmentMap();

    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 0, 3.5);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);

    // Orbit Controls
    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.05;
    orbitControls.maxDistance = 8;
    orbitControls.minDistance = 1.2;

    // High-fidelity post-processing composer setup (Stable & performant)
    composer = new POSTPROCESSING.EffectComposer(renderer);
    composer.addPass(new POSTPROCESSING.RenderPass(scene, camera));

    // Material Wox: Velocity Depth Normal Pass
    const velocityDepthNormalPass = new VelocityDepthNormalPass(scene, camera);
    composer.addPass(velocityDepthNormalPass);

    // Material Wox: SSGI, SSAO & SSR unified effect
    const ssgiEffect = new SSGIEffect(scene, camera, velocityDepthNormalPass, {
        ...SSGIEffect.DefaultOptions,
        resolutionScale: 0.75, // Balanced quality and performance
        blend: 0.95
    });

    // Create realistic glow/glare on specular reflections
    const bloomEffect = new POSTPROCESSING.BloomEffect({
        luminanceThreshold: 0.55,
        luminanceSmoothing: 0.2,
        intensity: 0.8
    });

    // Create clean edge anti-aliasing
    const smaaEffect = new POSTPROCESSING.SMAAEffect();

    // Premium Camera Vignette
    const vignetteEffect = new POSTPROCESSING.VignetteEffect({
        eskil: false,
        offset: 0.3,
        darkness: 0.55
    });

    const effectPass = new POSTPROCESSING.EffectPass(camera, smaaEffect, ssgiEffect, bloomEffect, vignetteEffect);
    composer.addPass(effectPass);

    // Create Canvas Textures
    albedoTex = new THREE.CanvasTexture(elements.canvasAlbedo);
    normalTex = new THREE.CanvasTexture(elements.canvasNormal);
    roughnessTex = new THREE.CanvasTexture(canvasRoughnessOffscreen);
    displacementTex = new THREE.CanvasTexture(elements.canvasDisplacement);
    metallicTex = new THREE.CanvasTexture(elements.canvasReflection);

    // High quality standard physical material setup
    pbrMaterial = new THREE.MeshPhysicalMaterial({
        map: albedoTex,
        normalMap: normalTex,
        normalScale: new THREE.Vector2(1.2, 1.2),
        roughnessMap: roughnessTex,
        displacementMap: displacementTex,
        displacementScale: state.displacementScale,
        displacementBias: -0.015,
        metalnessMap: metallicTex,
        roughness: 1.0,
        metalness: 1.0,
        clearcoat: 0.45,              // Premium lacquer clearcoat sheen
        clearcoatRoughness: 0.08,
        envMapIntensity: 2.2,         // Brighten reflections
        transparent: state.opacity < 1.0,
        opacity: state.opacity,
        depthWrite: state.opacity >= 0.9
    });

    // Create Mesh
    updateMeshGeometry();

    // Floor with glossy reflections & shadows
    const floorGeo = new THREE.PlaneGeometry(50, 50);
    const floorMat = new THREE.MeshPhysicalMaterial({
        color: 0x07090d,
        roughness: 0.25,
        metalness: 0.1,
        clearcoat: 0.8,
        clearcoatRoughness: 0.25,
        transparent: true,
        opacity: 0.95
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.15;
    floor.receiveShadow = true;
    scene.add(floor);

    // Lighting Systems
    setupLighting();
    applyLightSetup();

    // Event listeners
    window.addEventListener('resize', onWindowResize);

    // Start render loop
    animate();
    
    // First generation
    generateAIMaterial();
}

function updateMeshGeometry() {
    if (mainMesh) scene.remove(mainMesh);

    let geometry;
    const subdiv = 256; // Ultra detailed subdivision for displacement

    switch (state.meshShape) {
        case 'cube':
            geometry = new THREE.BoxGeometry(1.3, 1.3, 1.3, subdiv, subdiv, subdiv);
            break;
        case 'cylinder':
            geometry = new THREE.CylinderGeometry(0.65, 0.65, 1.5, subdiv, subdiv);
            break;
        case 'torus':
            geometry = new THREE.TorusGeometry(0.55, 0.22, subdiv, subdiv);
            break;
        case 'sphere':
        default:
            geometry = new THREE.SphereGeometry(1.0, subdiv, subdiv);
            break;
    }

    if (geometry) {
        geometry.computeTangents(); // Compute proper tangents for advanced lighting maps
    }

    mainMesh = new THREE.Mesh(geometry, pbrMaterial);
    mainMesh.castShadow = true;
    mainMesh.receiveShadow = true;
    scene.add(mainMesh);
}

function setupLighting() {
    // 1. Studio lighting
    studioLightGroup = new THREE.Group();
    const studioAmb = new THREE.AmbientLight(0xffffff, 0.2);
    const studioDir = new THREE.DirectionalLight(0xffffff, 1.6);
    studioDir.position.set(4, 6, 4);
    studioDir.castShadow = true;
    studioDir.shadow.mapSize.width = 2048;
    studioDir.shadow.mapSize.height = 2048;
    studioDir.shadow.bias = -0.0005;
    
    const studioPoint = new THREE.PointLight(0x6366f1, 1.5, 8);
    studioPoint.position.set(-3, 1.5, 3);
    
    studioLightGroup.add(studioAmb, studioDir, studioPoint);

    // 2. Warm lighting
    warmLightGroup = new THREE.Group();
    const warmAmb = new THREE.AmbientLight(0xfff3e0, 0.3);
    const warmDir = new THREE.DirectionalLight(0xffb74d, 2.2);
    warmDir.position.set(4, 5, 2);
    warmDir.castShadow = true;
    warmDir.shadow.mapSize.width = 2048;
    warmDir.shadow.mapSize.height = 2048;
    warmDir.shadow.bias = -0.0005;

    const warmPoint = new THREE.PointLight(0xff5722, 1.8, 8);
    warmPoint.position.set(-3, 1.5, -2);
    warmLightGroup.add(warmAmb, warmDir, warmPoint);

    // 3. Cool lighting
    coolLightGroup = new THREE.Group();
    const coolAmb = new THREE.AmbientLight(0xdbeafe, 0.1);
    const coolDir = new THREE.DirectionalLight(0x06b6d4, 1.6);
    coolDir.position.set(3, 4, 3);
    coolDir.castShadow = true;
    coolDir.shadow.mapSize.width = 2048;
    coolDir.shadow.mapSize.height = 2048;
    coolDir.shadow.bias = -0.0005;

    const coolPoint1 = new THREE.PointLight(0xec4899, 2.5, 8);
    coolPoint1.position.set(-2.5, 1, 2);
    const coolPoint2 = new THREE.PointLight(0x3b82f6, 1.8, 8);
    coolPoint2.position.set(2.5, -1, -2);
    coolLightGroup.add(coolAmb, coolDir, coolPoint1, coolPoint2);

    // 4. Dramatic lighting
    dramaticLightGroup = new THREE.Group();
    const dramaticAmb = new THREE.AmbientLight(0xffffff, 0.05);
    const dramaticDir = new THREE.DirectionalLight(0xffffff, 3.8);
    dramaticDir.position.set(5, 7, 2);
    dramaticDir.castShadow = true;
    dramaticDir.shadow.mapSize.width = 2048;
    dramaticDir.shadow.mapSize.height = 2048;
    dramaticDir.shadow.bias = -0.0005;

    const dramaticPoint = new THREE.PointLight(0xffffff, 0.8, 8);
    dramaticPoint.position.set(-4, -1, 3);
    dramaticLightGroup.add(dramaticAmb, dramaticDir, dramaticPoint);

    scene.add(studioLightGroup);
    scene.add(warmLightGroup);
    scene.add(coolLightGroup);
    scene.add(dramaticLightGroup);
}

function applyLightSetup() {
    studioLightGroup.visible = false;
    warmLightGroup.visible = false;
    coolLightGroup.visible = false;
    dramaticLightGroup.visible = false;

    switch (state.lightSetup) {
        case 'warm':
            warmLightGroup.visible = true;
            break;
        case 'cool':
            coolLightGroup.visible = true;
            break;
        case 'dramatic':
            dramaticLightGroup.visible = true;
            break;
        case 'studio':
        default:
            studioLightGroup.visible = true;
            break;
    }
}

function updateThreeJSTextures() {
    if (albedoTex) albedoTex.needsUpdate = true;
    if (normalTex) normalTex.needsUpdate = true;
    if (roughnessTex) roughnessTex.needsUpdate = true;
    if (displacementTex) displacementTex.needsUpdate = true;
    if (metallicTex) metallicTex.needsUpdate = true;

    const repeatX = state.tiling;
    const repeatY = state.tiling;
    
    [albedoTex, normalTex, roughnessTex, displacementTex, metallicTex].forEach(t => {
        if (t) {
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(repeatX, repeatY);
        }
    });

    if (pbrMaterial) {
        pbrMaterial.displacementScale = state.displacementScale;
        pbrMaterial.needsUpdate = true;
    }
}

function onWindowResize() {
    const width = elements.threeContainer.clientWidth;
    const height = elements.threeContainer.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (composer) {
        composer.setSize(width, height);
    }
}

function animate() {
    requestAnimationFrame(animate);
    if (state.autorotate && mainMesh) {
        mainMesh.rotation.y += 0.0035;
        // Subtle tilt wobble animation for dynamic lighting/reflections
        mainMesh.rotation.x = Math.sin(Date.now() * 0.0008) * 0.12;
    }
    orbitControls.update();
    if (composer) {
        composer.render();
    } else {
        renderer.render(scene, camera);
    }
}

// --- NOTIFICATION UTILITIES ---
function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    setTimeout(() => {
        elements.toast.classList.add('hidden');
    }, 2800);
}

// --- ZIP DOWNLOAD FUNCTIONALITY ---
function triggerDownloadAll() {
    const zip = new JSZip();
    
    const addCanvasToZip = (canvas, filename) => {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                zip.file(filename, blob);
                resolve();
            }, 'image/png');
        });
    };

    const cleanPrompt = state.prompt.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const p1 = addCanvasToZip(elements.canvasAlbedo, `${cleanPrompt}_albedo.png`);
    const p2 = addCanvasToZip(elements.canvasNormal, `${cleanPrompt}_normal.png`);
    const p3 = addCanvasToZip(elements.canvasSpecular, `${cleanPrompt}_specular.png`);
    const p4 = addCanvasToZip(elements.canvasDisplacement, `${cleanPrompt}_displacement.png`);
    const p5 = addCanvasToZip(elements.canvasReflection, `${cleanPrompt}_reflection.png`);

    Promise.all([p1, p2, p3, p4, p5]).then(() => {
        zip.generateAsync({ type: 'blob' }).then((content) => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = `${cleanPrompt}_pbr_maps.zip`;
            link.click();
            showToast("Pacchetto ZIP scaricato!");
        });
    });
}

function downloadSingleMap(mapType) {
    let canvas;
    switch(mapType) {
        case 'albedo': canvas = elements.canvasAlbedo; break;
        case 'normal': canvas = elements.canvasNormal; break;
        case 'specular': canvas = elements.canvasSpecular; break;
        case 'displacement': canvas = elements.canvasDisplacement; break;
        case 'reflection': canvas = elements.canvasReflection; break;
    }

    if (canvas) {
        const cleanPrompt = state.prompt.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const link = document.createElement('a');
        link.download = `${cleanPrompt}_${mapType}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        showToast(`${mapType.toUpperCase()} scaricata!`);
    }
}

// --- EVENT BINDINGS & INIT ---
function bindEvents() {
    // Backend switch
    elements.selectBackend.addEventListener('change', (e) => {
        state.aiBackend = e.target.value;
        if (state.aiBackend === 'comfyui') {
            elements.comfySettingsGroup.classList.remove('hidden');
            showToast("Backend impostato su ComfyUI locale.");
        } else {
            elements.comfySettingsGroup.classList.add('hidden');
            showToast("Backend impostato su Pollinations AI.");
        }
    });

    elements.inputComfyUrl.addEventListener('input', (e) => {
        state.comfyUrl = e.target.value;
    });

    elements.inputComfyModel.addEventListener('input', (e) => {
        state.comfyModel = e.target.value;
    });

    elements.selectComfyWeightDtype.addEventListener('change', (e) => {
        state.comfyWeightDtype = e.target.value;
    });

    elements.inputComfyClip.addEventListener('input', (e) => {
        state.comfyClip = e.target.value;
    });

    elements.selectComfyClipType.addEventListener('change', (e) => {
        state.comfyClipType = e.target.value;
    });

    elements.inputComfyVae.addEventListener('input', (e) => {
        state.comfyVae = e.target.value;
    });

    // Sliders
    elements.inputRoughness.addEventListener('input', (e) => {
        state.roughnessBase = parseFloat(e.target.value);
        elements.valRoughness.textContent = state.roughnessBase;
        processAlbedoToPBR(elements.canvasAlbedo);
    });

    elements.inputMetallic.addEventListener('input', (e) => {
        state.metallicBase = parseFloat(e.target.value);
        elements.valMetallic.textContent = state.metallicBase;
        processAlbedoToPBR(elements.canvasAlbedo);
    });

    elements.inputDisplacement.addEventListener('input', (e) => {
        state.displacementScale = parseFloat(e.target.value);
        elements.valDisplacement.textContent = state.displacementScale;
        updateThreeJSTextures();
    });

    elements.inputTiling.addEventListener('input', (e) => {
        state.tiling = parseInt(e.target.value);
        elements.valTiling.textContent = state.tiling;
        updateThreeJSTextures();
    });

    elements.inputFrequency.addEventListener('input', (e) => {
        state.noiseFrequency = parseFloat(e.target.value);
        elements.valFrequency.textContent = state.noiseFrequency;
        processAlbedoToPBR(elements.canvasAlbedo);
    });

    elements.inputOpacity.addEventListener('input', (e) => {
        state.opacity = parseFloat(e.target.value);
        elements.valOpacity.textContent = state.opacity.toFixed(2);
        if (pbrMaterial) {
            pbrMaterial.opacity = state.opacity;
            pbrMaterial.transparent = state.opacity < 1.0;
            pbrMaterial.depthWrite = state.opacity >= 0.9;
            if (pbrMaterial.transparent) {
                pbrMaterial.alphaTest = 0.0;
            }
            pbrMaterial.needsUpdate = true;
        }
    });

    // Preset Selection
    elements.presetBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            elements.presetBtns.forEach(b => b.classList.remove('active'));
            const presetBtn = e.currentTarget;
            presetBtn.classList.add('active');
            
            const preset = presetBtn.dataset.preset;
            let fullPrompt = "";

            if (preset === 'gold') {
                fullPrompt = "gold texture, polished metallic gold finish, smooth, luxury, tileable PBR";
                state.roughnessBase = 0.12;
                state.metallicBase = 0.95;
                state.displacementScale = 0.01;
            } else if (preset === 'rusty-iron') {
                fullPrompt = "rusty iron plates texture, heavy orange rust metal, dark worn steel, detailed, seamless";
                state.roughnessBase = 0.65;
                state.metallicBase = 0.75;
                state.displacementScale = 0.04;
            } else if (preset === 'wood') {
                fullPrompt = "dark oak wood planks texture, vertical wood grain panels, rustic parquet, seamless";
                state.roughnessBase = 0.7;
                state.metallicBase = 0.0;
                state.displacementScale = 0.02;
            } else if (preset === 'brick') {
                fullPrompt = "old red brick wall texture, weathered bricks with light grey concrete mortar, seamless PBR";
                state.roughnessBase = 0.85;
                state.metallicBase = 0.0;
                state.displacementScale = 0.06;
            } else if (preset === 'marble') {
                fullPrompt = "white carrarra marble texture, polished marble surface with grey veins, luxury stone, seamless";
                state.roughnessBase = 0.06;
                state.metallicBase = 0.0;
                state.displacementScale = 0.01;
            } else { // concrete
                fullPrompt = "rough concrete wall texture, weathered cement block surface, detailed stone, seamless";
                state.roughnessBase = 0.75;
                state.metallicBase = 0.0;
                state.displacementScale = 0.045;
            }
            
            elements.promptInput.value = fullPrompt;
            state.prompt = fullPrompt;
            
            elements.inputRoughness.value = state.roughnessBase;
            elements.valRoughness.textContent = state.roughnessBase;
            elements.inputMetallic.value = state.metallicBase;
            elements.valMetallic.textContent = state.metallicBase;
            elements.inputDisplacement.value = state.displacementScale;
            elements.valDisplacement.textContent = state.displacementScale;

            generateAIMaterial();
        });
    });

    elements.btnGenerate.addEventListener('click', () => {
        state.prompt = elements.promptInput.value;
        generateAIMaterial();
    });

    elements.promptInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            state.prompt = elements.promptInput.value;
            generateAIMaterial();
        }
    });

    elements.btnDownloadAll.addEventListener('click', triggerDownloadAll);
    document.querySelectorAll('.btn-download-map').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mapType = e.currentTarget.dataset.map;
            downloadSingleMap(mapType);
        });
    });

    // Handle texture upload trigger
    document.querySelectorAll('.btn-upload-trigger').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = e.currentTarget.parentElement.querySelector('.input-map-file');
            if (input) input.click();
        });
    });

    // Handle texture file input changes
    document.querySelectorAll('.input-map-file').forEach(input => {
        input.addEventListener('change', (e) => {
            const mapType = e.target.dataset.map;
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    if (mapType === 'albedo') {
                        processAlbedoToPBR(img);
                        showToast("Albedo aggiornato e mappe ricalcolate!");
                    } else {
                        let canvas;
                        switch (mapType) {
                            case 'normal': canvas = elements.canvasNormal; break;
                            case 'specular': canvas = elements.canvasSpecular; break;
                            case 'displacement': canvas = elements.canvasDisplacement; break;
                            case 'reflection': canvas = elements.canvasReflection; break;
                        }
                        if (canvas) {
                            const ctx = canvas.getContext('2d');
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                            
                            if (mapType === 'specular') {
                                const ctxR = canvasRoughnessOffscreen.getContext('2d');
                                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                                const rData = ctxR.createImageData(canvas.width, canvas.height);
                                for (let i = 0; i < imgData.data.length; i += 4) {
                                    const val = 255 - imgData.data[i];
                                    rData.data[i] = val;
                                    rData.data[i+1] = val;
                                    rData.data[i+2] = val;
                                    rData.data[i+3] = 255;
                                }
                                ctxR.putImageData(rData, 0, 0);
                            }
                            updateThreeJSTextures();
                            showToast(`Mappa ${mapType.toUpperCase()} caricata con successo!`);
                        }
                    }
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });
    });

    // Handle texture clearing / resetting
    document.querySelectorAll('.btn-delete-map').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mapType = e.currentTarget.dataset.map;
            let canvas;
            let fillStyle = '#ffffff';
            
            switch(mapType) {
                case 'albedo': 
                    canvas = elements.canvasAlbedo; 
                    fillStyle = '#ffffff';
                    break;
                case 'normal': 
                    canvas = elements.canvasNormal; 
                    fillStyle = '#8080ff';
                    break;
                case 'specular': 
                    canvas = elements.canvasSpecular; 
                    fillStyle = '#222222';
                    break;
                case 'displacement': 
                    canvas = elements.canvasDisplacement; 
                    fillStyle = '#808080';
                    break;
                case 'reflection': 
                    canvas = elements.canvasReflection; 
                    fillStyle = '#000000';
                    break;
            }
            
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = fillStyle;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                if (mapType === 'albedo') {
                    processAlbedoToPBR(canvas);
                } else {
                    if (mapType === 'specular') {
                        const ctxR = canvasRoughnessOffscreen.getContext('2d');
                        ctxR.fillStyle = '#808080';
                        ctxR.fillRect(0, 0, canvasRoughnessOffscreen.width, canvasRoughnessOffscreen.height);
                    }
                    updateThreeJSTextures();
                }
                showToast(`Mappa ${mapType.toUpperCase()} azzerata!`);
            }
        });
    });

    elements.selectMesh.addEventListener('change', (e) => {
        state.meshShape = e.target.value;
        updateMeshGeometry();
    });

    elements.selectLight.addEventListener('change', (e) => {
        state.lightSetup = e.target.value;
        applyLightSetup();
    });

    elements.btnRotate.addEventListener('click', () => {
        state.autorotate = !state.autorotate;
        if (state.autorotate) {
            elements.btnRotate.classList.add('active');
            elements.btnRotate.querySelector('i').classList.add('fa-spin');
        } else {
            elements.btnRotate.classList.remove('active');
            elements.btnRotate.querySelector('i').classList.remove('fa-spin');
        }
    });
}

// Initializer
window.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    initThreeJS();
});
