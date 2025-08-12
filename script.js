const canvas = document.getElementById('webcam-canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const hiddenVideo = document.getElementById('hidden-video');
const startBtn = document.getElementById('start-recording-btn');
const stopBtn = document.getElementById('stop-recording-btn');
const switchBtn = document.getElementById('switch-camera-btn');
const objectSelector = document.getElementById('object-selector');
const selectObjectBtn = document.getElementById('select-object-btn');
const zoomSlider = document.getElementById('zoom-slider');
const marginSlider = document.getElementById('margin-slider');
const easeSlider = document.getElementById('ease-slider');
const recordingStatus = document.getElementById('recording-indicator');

let mediaRecorder;
let recordedChunks = [];
let currentStream;
let videoInputs = [];
let currentCameraIndex = 0;
let model = null;

let trackedObject = null;
let trackedObjectInfo = null;
let targetZoom = 1.0;
let targetPanX = 0;
let targetPanY = 0;
let currentZoom = 1.0;
let currentPanX = 0;
let currentPanY = 0;
let EASE_FACTOR = 0.25;
const MAX_ZOOM = 4.0;
const MIN_ZOOM = 1.0;
let lastDetectionTime = 0;
const detectionInterval = 33; // ~30 FPS

async function loadModel() {
    try {
        model = await cocoSsd.load();
        console.log('AI model načten.');
        renderLoop();
    } catch (error) {
        console.error('Nepodařilo se načíst AI model:', error);
    }
}

async function getStream(deviceId) {
    try {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }
        const constraints = {
            video: deviceId ? { deviceId: { exact: deviceId } } : true
        };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        hiddenVideo.srcObject = currentStream;
        startBtn.disabled = false;

        hiddenVideo.onloadedmetadata = () => {
            const aspectRatio = hiddenVideo.videoWidth / hiddenVideo.videoHeight;
            const containerWidth = canvas.parentNode.offsetWidth;
            const newCanvasHeight = containerWidth / aspectRatio;
            canvas.width = containerWidth;
            canvas.height = newCanvasHeight;
            hiddenVideo.play();
            
            currentZoom = 1.0;
            currentPanX = hiddenVideo.videoWidth / 2;
            currentPanY = hiddenVideo.videoHeight / 2;
        };
    } catch (error) {
        console.error('Přístup ke kameře byl odmítnut nebo nastala chyba:', error);
        alert('Přístup ke kameře byl zamítnut nebo nastala chyba. Zkontrolujte, zda jste aplikaci povolili přístup.');
    }
}

async function getCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        alert('Váš prohlížeč nepodporuje výčet zařízení.');
        return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoInputs = devices.filter(device => device.kind === 'videoinput');
    if (videoInputs.length > 1) {
        switchBtn.style.display = 'inline-block';
    } else {
        switchBtn.style.display = 'none';
    }
}

function startRecording() {
    recordedChunks = [];
    const canvasStream = canvas.captureStream(60); // Nastavení vyššího FPS pro záznam
    mediaRecorder = new MediaRecorder(canvasStream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.style = 'display: none';
        a.href = url;
        a.download = 'nahravka.webm';
        a.click();
        window.URL.revokeObjectURL(url);
    };
    mediaRecorder.start();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    recordingStatus.style.display = 'block';
    console.log('Nahrávání zahájeno...');
}

function stopRecording() {
    mediaRecorder.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    recordingStatus.style.display = 'none';
    console.log('Nahrávání zastaveno. Stahuji video...');
}

function switchCamera() {
    if (videoInputs.length < 2) return;
    currentCameraIndex = (currentCameraIndex + 1) % videoInputs.length;
    const nextCameraId = videoInputs[currentCameraIndex].deviceId;
    getStream(nextCameraId);
}

function renderLoop() {
    const videoWidth = hiddenVideo.videoWidth;
    const videoHeight = hiddenVideo.videoHeight;
    
    currentZoom += (targetZoom - currentZoom) * EASE_FACTOR;
    currentPanX += (targetPanX - currentPanX) * EASE_FACTOR;
    currentPanY += (targetPanY - currentPanY) * EASE_FACTOR;

    const sourceWidth = videoWidth / currentZoom;
    const sourceHeight = videoHeight / currentZoom;
    const sourceX = Math.max(0, Math.min(videoWidth - sourceWidth, currentPanX - sourceWidth / 2));
    const sourceY = Math.max(0, Math.min(videoHeight - sourceHeight, currentPanY - sourceHeight / 2));

    context.clearRect(0, 0, canvas.width, canvas.height);
    if (hiddenVideo.readyState >= 2) {
        context.drawImage(hiddenVideo, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    }
    
    if (trackedObject) {
        const [x, y, width, height] = trackedObject.bbox;
        const canvasX = (x - sourceX) * (canvas.width / sourceWidth);
        const canvasY = (y - sourceY) * (canvas.height / sourceHeight);
        const canvasWidth = width * (canvas.width / sourceWidth);
        const canvasHeight = height * (canvas.height / sourceHeight);

        context.beginPath();
        context.rect(canvasX, canvasY, canvasWidth, canvasHeight);
        context.lineWidth = 2;
        context.strokeStyle = 'red';
        context.stroke();
        
        context.font = '16px Arial';
        context.fillStyle = 'red';
        context.fillText(`${trackedObject.class} (${Math.round(trackedObject.score * 100)}%)`, canvasX, canvasY > 10 ? canvasY - 5 : 10);
    }

    if (Date.now() - lastDetectionTime > detectionInterval) {
        lastDetectionTime = Date.now();
        detectObjects();
    }
    
    requestAnimationFrame(renderLoop);
}

async function detectObjects() {
    if (!model || hiddenVideo.readyState < 2) return;
    const predictions = await model.detect(hiddenVideo);
    const selectedObject = objectSelector.value;

    if (selectedObject === "none") {
        trackedObject = null;
        trackedObjectInfo = null;
        targetZoom = parseFloat(zoomSlider.value);
        targetPanX = hiddenVideo.videoWidth / 2;
        targetPanY = hiddenVideo.videoHeight / 2;
    } else if (selectedObject === "manual") {
        if (trackedObjectInfo) {
            const [x, y, width, height] = trackedObjectInfo.bbox;
            const currentBestMatch = predictions
                .filter(p => p.class === trackedObjectInfo.class)
                .sort((a, b) => {
                    const aDist = Math.sqrt(Math.pow(a.bbox[0] - x, 2) + Math.pow(a.bbox[1] - y, 2));
                    const bDist = Math.sqrt(Math.pow(b.bbox[0] - x, 2) + Math.pow(b.bbox[1] - y, 2));
                    return aDist - bDist;
                })[0];
            
            trackedObject = currentBestMatch;
            if (trackedObject) {
                trackedObjectInfo = trackedObject;
                updateZoomAndPan();
            } else {
                targetZoom = parseFloat(zoomSlider.value);
                targetPanX = hiddenVideo.videoWidth / 2;
                targetPanY = hiddenVideo.videoHeight / 2;
            }
        }
    } else {
        const bestPrediction = predictions
            .filter(p => p.class === selectedObject)
            .sort((a, b) => b.score - a.score)[0];
        trackedObject = bestPrediction;
        if (trackedObject) {
            updateZoomAndPan();
        } else {
            targetZoom = parseFloat(zoomSlider.value);
            targetPanX = hiddenVideo.videoWidth / 2;
            targetPanY = hiddenVideo.videoHeight / 2;
        }
    }
}

function updateZoomAndPan() {
    if (!trackedObject) return;
    const [x, y, width, height] = trackedObject.bbox;
    const margin = parseFloat(marginSlider.value);
    const videoWidth = hiddenVideo.videoWidth;
    const videoHeight = hiddenVideo.videoHeight;
    const boxAspect = width / height;
    const videoAspect = videoWidth / videoHeight;

    let newZoom;
    if (boxAspect > videoAspect) {
        newZoom = videoWidth / (width * margin);
    } else {
        newZoom = videoHeight / (height * margin);
    }

    targetZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
    targetPanX = x + width / 2;
    targetPanY = y + height / 2;
}

function findClosestObject(x, y) {
    if (!model || hiddenVideo.readyState < 2) return;
    model.detect(hiddenVideo).then(predictions => {
        let minDistance = Infinity;
        let closestPrediction = null;
        const videoWidth = hiddenVideo.videoWidth;
        const videoHeight = hiddenVideo.videoHeight;

        predictions.forEach(p => {
            const [objX, objY, objW, objH] = p.bbox;
            const centerX = (objX + objW / 2);
            const centerY = (objY + objH / 2);
            
            const dist = Math.sqrt(Math.pow(centerX - x, 2) + Math.pow(centerY - y, 2));
            if (dist < minDistance) {
                minDistance = dist;
                closestPrediction = p;
            }
        });

        if (closestPrediction) {
            trackedObject = closestPrediction;
            trackedObjectInfo = {
                class: closestPrediction.class,
                bbox: closestPrediction.bbox
            };
            updateZoomAndPan();
        }
    });
}

window.onload = () => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        loadModel();
        getCameras().then(() => {
            getStream(videoInputs[currentCameraIndex]?.deviceId);
        });
    } else {
        alert('Váš prohlížeč nepodporuje přístup ke kameře.');
    }
};

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
switchBtn.addEventListener('click', switchCamera);
zoomSlider.addEventListener('input', () => {
    if (objectSelector.value === "none" || objectSelector.value === "manual") {
        targetZoom = parseFloat(zoomSlider.value);
    }
});
marginSlider.addEventListener('input', () => {
     if (trackedObject) {
         updateZoomAndPan();
     } else {
         targetZoom = parseFloat(zoomSlider.value);
     }
});
easeSlider.addEventListener('input', (event) => {
     EASE_FACTOR = parseFloat(event.target.value);
});
objectSelector.addEventListener('change', () => {
    if (objectSelector.value === "manual" || objectSelector.value === "none") {
        selectObjectBtn.disabled = objectSelector.value !== "manual";
        if (objectSelector.value === "none") {
            trackedObject = null;
            trackedObjectInfo = null;
            targetZoom = parseFloat(zoomSlider.value);
            targetPanX = hiddenVideo.videoWidth / 2;
            targetPanY = hiddenVideo.videoHeight / 2;
        }
    } else {
        selectObjectBtn.disabled = true;
        trackedObjectInfo = null;
    }
});
selectObjectBtn.addEventListener('click', () => {
    canvas.style.cursor = 'crosshair';
    canvas.onclick = (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const videoX = (x / canvas.width) * hiddenVideo.videoWidth;
        const videoY = (y / canvas.height) * hiddenVideo.videoHeight;

        findClosestObject(videoX, videoY);
        canvas.style.cursor = 'default';
        canvas.onclick = null;
    };
});
