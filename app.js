import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ArToolkitSource, ArToolkitContext, ArMarkerControls } from 'threex';

// ==========================================================================
// Visualizador 3D + Realidade Aumentada para o modelo quati.fbx
//
// A RA agora usa AR.js (marcador "Hiro", via câmera) em vez da API nativa
// WebXR. Isso troca o posicionamento livre por hit-test por uma âncora fixa:
// o quati aparece em cima de um marcador impresso ou exibido em outra
// tela. Em compensação funciona em bem mais navegadores/dispositivos
// (inclusive Safari/iOS), o que o WebXR não fazia.
//
// A animação de entrada (deslizamento) do modelo "de mesa" foi retirada
// daqui e vive em ./modules/entranceAnimation.js — veja aquele arquivo se
// quiser reativá-la.
// ==========================================================================

// URL da imagem do marcador Hiro (para o usuário imprimir ou exibir em outra tela)
const AR_MARKER_IMAGE_URL = 'https://cdn.jsdelivr.net/gh/jeromeetienne/AR.js@master/data/images/HIRO.jpg';
// Dados que o AR.js precisa para calibração da câmera e reconhecimento do marcador
const AR_CAMERA_PARAMS_URL = 'https://cdn.jsdelivr.net/gh/AR-js-org/AR.js@master/data/data/camera_para.dat';
const AR_MARKER_PATTERN_URL = 'https://cdn.jsdelivr.net/gh/AR-js-org/AR.js@master/data/data/patt.hiro';

const infoEl = document.getElementById('info');
const loadingEl = document.getElementById('loading');
const arContainer = document.getElementById('ar-button-container');
const arWarning = document.getElementById('ar-warning');

const DEFAULT_INFO_TEXT = 'Quati 3D — arraste para girar, scroll para zoom';
const AR_INFO_TEXT = 'Aponte a câmera para o marcador Hiro para ver o quati sobre ele.';

// ==========================================================================
// ---------- MOVIMENTO: rotação automática e eixo vertical do modelo ----------
// Toda a lógica de "movimento" do modelo fica concentrada aqui, separada do
// resto do arquivo, para ficar fácil de achar e ajustar.
// ==========================================================================

// Rotação automática (gira sozinha, além do arraste manual do OrbitControls
// no modo "de mesa"). Isso é aplicado tanto no modelo "de mesa" quanto no
// modelo da RA, no loop de animação lá embaixo.
const MODEL_AUTO_ROTATE = true;      // true = o quati gira sozinho; false = fica parado até o usuário arrastar
const MODEL_ROTATION_SPEED = 0.6;    // radianos por segundo (≈ 34°/s) — velocidade da rotação automática
const MODEL_ROTATION_AXIS = 'y';     // eixo da rotação automática: 'x', 'y' ou 'z'

// Eixo vertical (Y) do modelo, usado para apoiar o quati sobre o marcador
// na RA. Alguns FBX são exportados com o eixo Y espelhado/invertido em
// relação ao que o three.js espera (Y crescendo para cima). Se o quati
// aparecer de cabeça para baixo, flutuando ou afundado no marcador, alterne
// este valor — é usado lá em setupARScene().
const INVERT_MODEL_Y = true;

// Relógio para calcular a rotação automática em radianos/segundo "de
// verdade", independente da taxa de quadros (FPS) do dispositivo.
const clock = new THREE.Clock();

// ==========================================================================
// ---------- Modo "de mesa" (visualização normal, fora da RA) ----------
// ==========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d0f);

const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    2000
);
camera.position.set(0, 0, 150);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Controles de mouse/touch (arrastar para girar, scroll para zoom) - só
// fazem sentido no modo "de mesa", fora da sessão de RA.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Luzes do modo "de mesa"
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

const backLight = new THREE.DirectionalLight(0xffffff, 0.4);
backLight.position.set(-1, -1, -1);
scene.add(backLight);

// ---------- Estado do modelo carregado ----------
// modelObject é um "wrapper" (THREE.Group) que contém o objeto do FBX como
// filho. O objeto do FBX é centralizado dentro desse wrapper (equivalente ao
// que era feito com geometry.translate() no STL), enquanto o próprio
// wrapper fica em (0,0,0) — assim dá para reaproveitar o wrapper tanto no
// modo "de mesa" quanto (clonado) na RA, aplicando escala/posição/rotação
// nele sem bagunçar a centralização interna.
let modelObject = null;
let modelSize = null; // THREE.Vector3 com as dimensões do bounding box
let modelMaxDim = 1;
let previewMesh = null; // wrapper do modo "de mesa" (guardado para a rotação automática)

// Material usado como fallback para malhas do FBX que não trouxerem material
// próprio embutido no arquivo.
const FALLBACK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0xa9835a,
    metalness: 0.05,
    roughness: 0.85
});

// ---------- Carregamento do FBX ----------
const loader = new FBXLoader();

loader.load(
    './quati.fbx',
    (object) => {
        object.traverse((child) => {
            if (child.isMesh && !child.material) {
                child.material = FALLBACK_MATERIAL;
            }
        });

        // Centraliza o quati: mede a caixa delimitadora do objeto recém
        // carregado (ainda na origem) e desloca o próprio objeto para que
        // seu centro fique em (0,0,0).
        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        modelSize = new THREE.Vector3();
        box.getSize(modelSize);
        modelMaxDim = Math.max(modelSize.x, modelSize.y, modelSize.z) || 1;

        // O objeto centralizado vira filho de um wrapper — é esse wrapper
        // que manipulamos (posição/escala/rotação) daqui pra frente.
        modelObject = new THREE.Group();
        modelObject.add(object);

        // Modelo "de mesa" - aparece direto centralizado. A rotação
        // automática (se MODEL_AUTO_ROTATE estiver true) é aplicada no loop
        // de animação lá embaixo; não há mais animação de entrada por
        // deslizamento.
        previewMesh = modelObject;
        camera.position.set(0, 0, modelMaxDim * 2);
        controls.target.set(0, 0, 0);
        controls.update();
        scene.add(previewMesh);

        if (loadingEl) loadingEl.style.display = 'none';
        checkARSupport();
    },
    (xhr) => {
        if (xhr.total && loadingEl) {
            const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
            loadingEl.textContent = `Carregando modelo... ${pct}%`;
        }
    },
    (error) => {
        console.error('Erro ao carregar o FBX:', error);
        if (loadingEl) {
            loadingEl.textContent = 'Erro ao carregar quati.fbx. Verifique se o arquivo está na mesma pasta.';
        }
    }
);

// ==========================================================================
// ---------- Realidade Aumentada (AR.js, marcador Hiro) ----------
// ==========================================================================
let arActive = false;
let arRenderer = null;
let arScene = null;
let arCamera = null;
let markerRoot = null;
let arMesh = null; // wrapper do quati dentro da RA (guardado para a rotação automática)
let arToolkitSource = null;
let arToolkitContext = null;
let arMarkerControls = null;
let arContextReady = false;

function showWarning(msg) {
    if (!arWarning) return;
    arWarning.style.display = 'block';
    arWarning.textContent = msg;
}

function describeError(e) {
    if (!e) return 'erro desconhecido';
    return `${e.name || 'Error'}: ${e.message || e}`;
}

// Verificação de suporte em etapas, cada uma com uma mensagem ESPECÍFICA -
// evita deixar o usuário travado numa tela de carregamento sem saber por quê.
async function checkARSupport() {
    if (!window.isSecureContext) {
        showWarning(
            `A RA por câmera precisa de um contexto seguro (HTTPS ou localhost). Esta página ` +
            `foi carregada via "${location.protocol}//${location.host}", que não é seguro. ` +
            `Sirva os arquivos com HTTPS (ex.: um túnel como ngrok/Cloudflare Tunnel, ou ` +
            `hospedagem com certificado válido).`
        );
        return;
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        showWarning(
            'Este navegador não expõe acesso à câmera (getUserMedia indisponível). Tente um ' +
            'navegador atualizado, como Chrome, Safari ou Firefox.'
        );
        return;
    }

    createARButton();
}

function createARButton() {
    const button = document.createElement('button');
    button.id = 'ar-button';
    button.textContent = 'Ver em RA';
    arContainer.appendChild(button);

    const hint = document.createElement('a');
    hint.id = 'ar-marker-link';
    hint.href = AR_MARKER_IMAGE_URL;
    hint.target = '_blank';
    hint.rel = 'noopener';
    hint.textContent = 'Ver marcador Hiro (imprima ou abra em outra tela)';
    arContainer.appendChild(hint);

    arContainer.classList.add('ready');

    button.addEventListener('click', () => {
        if (arActive) {
            stopARSession();
        } else {
            startARSession(button);
        }
    });
}

async function startARSession(button) {
    // Testamos a permissão de câmera antes de inicializar o AR.js, para
    // conseguir mostrar uma mensagem de erro específica caso o usuário
    // negue o acesso, em vez da tela travar carregando silenciosamente.
    try {
        const testStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });
        testStream.getTracks().forEach((track) => track.stop());
    } catch (err) {
        console.error('Falha ao acessar a câmera:', err);
        const msg = 'Não foi possível acessar a câmera: ' + describeError(err);
        if (infoEl) infoEl.textContent = msg;
        showWarning(msg);
        return;
    }

    arActive = true;
    button.textContent = 'Sair da RA';
    if (arWarning) arWarning.style.display = 'none';

    // Modo "de mesa" some enquanto a RA está ativa
    renderer.domElement.style.display = 'none';
    controls.enabled = false;

    if (!arRenderer) {
        setupARScene();
    } else {
        arRenderer.domElement.style.display = 'block';
        arToolkitSource.domElement.style.display = 'block';
    }

    if (infoEl) infoEl.textContent = AR_INFO_TEXT;
}

function stopARSession() {
    arActive = false;
    const button = document.getElementById('ar-button');
    if (button) button.textContent = 'Ver em RA';

    if (arRenderer) arRenderer.domElement.style.display = 'none';
    if (arToolkitSource && arToolkitSource.domElement) {
        arToolkitSource.domElement.style.display = 'none';
        // Libera a câmera de verdade (para o LED da câmera apagar entre sessões)
        const stream = arToolkitSource.domElement.srcObject;
        if (stream) stream.getTracks().forEach((track) => track.stop());
    }

    renderer.domElement.style.display = 'block';
    controls.enabled = true;
    if (infoEl) infoEl.textContent = DEFAULT_INFO_TEXT;

    // Descartamos tudo para a próxima sessão começar limpa (evita estados
    // internos estranhos do ArToolkitSource ao tentar reabrir a câmera).
    arRenderer = null;
    arScene = null;
    arCamera = null;
    markerRoot = null;
    arMesh = null;
    arToolkitSource = null;
    arToolkitContext = null;
    arMarkerControls = null;
    arContextReady = false;
}

function setupARScene() {
    arRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    arRenderer.setClearColor(new THREE.Color(0x000000), 0);
    arRenderer.setPixelRatio(window.devicePixelRatio);
    arRenderer.setSize(window.innerWidth, window.innerHeight);
    arRenderer.domElement.style.position = 'absolute';
    arRenderer.domElement.style.top = '0px';
    arRenderer.domElement.style.left = '0px';
    arRenderer.domElement.style.zIndex = '1';
    document.body.appendChild(arRenderer.domElement);

    arScene = new THREE.Scene();
    arCamera = new THREE.Camera();
    arScene.add(arCamera);

    arScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const arDirLight = new THREE.DirectionalLight(0xffffff, 1);
    arDirLight.position.set(1, 1, 1);
    arScene.add(arDirLight);

    // O quati fica dentro de markerRoot; o AR.js atualiza a matriz de
    // markerRoot a cada frame para acompanhar a posição do marcador.
    markerRoot = new THREE.Group();
    markerRoot.matrixAutoUpdate = false;
    arScene.add(markerRoot);

    if (modelObject) {
        arMesh = modelObject.clone(true); // clona o wrapper + o objeto FBX centralizado dentro dele
        const scale = 1 / modelMaxDim; // maior eixo do quati ≈ largura do marcador
        arMesh.scale.setScalar(scale);

        // ---------- Eixo vertical: apoiar o quati sobre o marcador ----------
        // O objeto do FBX foi centralizado dentro do wrapper no carregamento
        // (loader.load acima), então o "chão" do modelo fica a meia altura
        // abaixo do centro. Para o quati ficar de pé sobre o marcador (y=0
        // do marcador), subimos o wrapper nessa mesma distância
        // (verticalOffset). Como esse deslocamento é aplicado no wrapper (e
        // não no objeto filho já centralizado), ele não interfere na
        // centralização interna.
        // INVERT_MODEL_Y (configurado no topo do arquivo) troca o sentido
        // desse deslocamento — use-o se o seu FBX tiver o eixo Y
        // espelhado/invertido e o quati aparecer flutuando, afundado ou de
        // cabeça para baixo em vez de apoiado no marcador.
        const verticalOffset = (modelSize.y / 2) * scale;
        arMesh.position.y = INVERT_MODEL_Y ? -verticalOffset : verticalOffset;

        markerRoot.add(arMesh);
    }

    arToolkitSource = new ArToolkitSource({
        sourceType: 'webcam',
        sourceWidth: window.innerWidth > window.innerHeight ? 640 : 480,
        sourceHeight: window.innerWidth > window.innerHeight ? 480 : 640
    });

    arToolkitSource.init(() => {
        arToolkitSource.domElement.addEventListener('canplay', () => {
            initARContext();
            onARResize();
        });
        setTimeout(onARResize, 1000);
    });

    window.addEventListener('resize', onARResize);
}

function initARContext() {
    if (arContextReady) return;
    arContextReady = true;

    arToolkitContext = new ArToolkitContext({
        cameraParametersUrl: AR_CAMERA_PARAMS_URL,
        detectionMode: 'mono'
    });

    arToolkitContext.init(() => {
        arCamera.projectionMatrix.copy(arToolkitContext.getProjectionMatrix());
    });

    arMarkerControls = new ArMarkerControls(arToolkitContext, markerRoot, {
        type: 'pattern',
        patternUrl: AR_MARKER_PATTERN_URL
    });
}

function onARResize() {
    if (!arToolkitSource || !arRenderer) return;
    arToolkitSource.onResizeElement();
    arToolkitSource.copyElementSizeTo(arRenderer.domElement);
    if (arToolkitContext && arToolkitContext.arController) {
        arToolkitSource.copyElementSizeTo(arToolkitContext.arController.canvas);
    }
}

// ---------- Loop de renderização ----------
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    // ---------- MOVIMENTO: rotação automática do modelo ----------
    // Gira o mesh que está visível no momento (o de mesa ou o da RA) no
    // eixo configurado em MODEL_ROTATION_AXIS, lá no topo do arquivo. Fica
    // independente do arraste manual do OrbitControls, que continua
    // funcionando normalmente por cima disso no modo "de mesa".
    if (MODEL_AUTO_ROTATE) {
        const activeMesh = arActive ? arMesh : previewMesh;
        if (activeMesh) {
            activeMesh.rotation[MODEL_ROTATION_AXIS] += MODEL_ROTATION_SPEED * delta;
        }
    }

    if (arActive) {
        if (arToolkitContext && arToolkitSource && arToolkitSource.ready) {
            arToolkitContext.update(arToolkitSource.domElement);
        }
        if (arRenderer && arScene && arCamera) {
            arRenderer.render(arScene, arCamera);
        }
    } else {
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();

// ---------- Responsividade (modo "de mesa") ----------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (arRenderer) arRenderer.setSize(window.innerWidth, window.innerHeight);
});

// ==========================================================================
// ---------- QR Code de acesso rápido ----------
// ==========================================================================
let qrRendered = false;

function renderQRCode() {
    const target = document.getElementById('qrcode');
    if (!target || typeof QRCode === 'undefined') return;
    target.innerHTML = '';
    new QRCode(target, {
        text: window.location.href,
        width: 180,
        height: 180,
        colorDark: '#0b0d0f',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    const urlEl = document.getElementById('qr-url');
    if (urlEl) urlEl.textContent = window.location.href;
    qrRendered = true;
}

const qrToggle = document.getElementById('qr-toggle');
const qrPanel = document.getElementById('qr-panel');
if (qrToggle && qrPanel) {
    qrToggle.addEventListener('click', () => {
        const isOpen = qrPanel.classList.toggle('open');
        if (isOpen && !qrRendered) renderQRCode();
    });
    const qrClose = document.getElementById('qr-close');
    if (qrClose) qrClose.addEventListener('click', () => qrPanel.classList.remove('open'));
}
