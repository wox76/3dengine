# PBR Material Engine - Procedural Generator & 3D Preview

Un generatore procedurale ed estrattore di mappe PBR in tempo reale integrato con un'anteprima 3D fotorealistica. Consente di generare texture tramite motori procedurali locali o endpoint AI di diffusione (es. ComfyUI, Pollinations).

## 🚀 Live Demo
Puoi visualizzare l'applicazione direttamente online qui:
👉 **[https://wox76.github.io/3dengine/](https://wox76.github.io/3dengine/)**

## 🛠️ Tecnologie Utilizzate
* **Three.js** - Per il rendering 3D in tempo reale del materiale PBR.
* **Postprocessing** - Per effetti visivi avanzati (SSGI, Bloom, SMAA, Vignette).
* **HTML5 Canvas / Vanilla JS** - Per la generazione procedurale on-the-fly delle mappe e logica dell'applicazione.
* **API ComfyUI / Pollinations** - Integrazione facoltativa con modelli AI di diffusione per la generazione da prompt testuali.

## 📦 Struttura del Progetto
* `/index.html` - La pagina web principale dell'applicazione.
* `/app.js` - Logica del visualizzatore 3D, calcolo sobel delle mappe Normali, baker PBR e gestione UI.
* `/material-wox.js` - Libreria personalizzata per il calcolo dell'illuminazione globale dello schermo (SSGI).
* `/material-wox-full/` - Repository dei sorgenti e compilatore della libreria `material-wox`.
* `/material_wox_examples/` - Esempi di implementazione della libreria SSGI.
