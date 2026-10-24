/* Authenticated local-server selfie enrollment and rear-camera target tracking. */
(() => {
    'use strict';
    class VisionClient {
        constructor({ video, session, onState = () => {}, onLock = () => {}, onEnroll = () => {}, onError = () => {} }) {
            Object.assign(this, { video, session, onState, onLock, onEnroll, onError });
            this.enabled = false; this.online = false; this.status = 'off'; this.frame = null;
            this.locked = false; this.visible = false; this.targetId = null;
            this.frameId = 0; this.previewPending = false; this.captures = new Map();
            this.previewEnabled = true; this.enrollmentPending = false; this.selfEnrolled = false; this.opponentEnrolled = false;
        }
        async start({ preview = true } = {}) {
            this.previewEnabled = preview;
            if (this.enabled) { if (this.online && preview) void this.preview(); return; }
            if (preview && (!this.video.srcObject?.active || this.video.readyState < 2)) { this.onError('CAMERA_REQUIRED'); return; }
            this.enabled = true; this.status = 'loading'; this.onState();
            try {
                await this.session.connect();
                if (!this.enabled) return;
                const url = new URL('/ws/vision', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const socket = new WebSocket(url); socket.binaryType = 'arraybuffer'; this.socket = socket;
                socket.onopen = () => socket.send(JSON.stringify({ type: 'HELLO', token: this.session.token }));
                socket.onmessage = event => { if (this.socket === socket) this.receive(event.data); };
                socket.onclose = () => {
                    if (this.socket !== socket) return;
                    this.online = false; this.enabled = false; this.locked = false; this.visible = false;
                    this.enrollmentPending = false; clearTimeout(this.enrollmentTimeout);
                    this.status = 'offline'; clearTimeout(this.timer); clearTimeout(this.watchdog); this.onState();
                };
                this.watchdog = setTimeout(() => { if (!this.online) { this.onError('VISION_TIMEOUT'); this.stop(); } }, 20000);
            } catch { this.status = 'error'; this.enabled = false; this.onError('SERVER_UNAVAILABLE'); this.onState(); }
        }
        receive(raw) {
            let message; try { message = JSON.parse(raw); } catch { return; }
            if (message.type === 'VISION_READY') {
                clearTimeout(this.watchdog); this.online = true; this.status = 'ready'; this.enrollmentState(message); this.onState(); void this.preview();
            } else if (message.type === 'VISION_FRAME') {
                const previous = this.locked;
                this.frame = message; this.receivedAt = performance.now(); this.locked = message.locked;
                this.visible = message.targetVisible; this.targetId = message.targetId;
                this.enrollmentState(message);
                this.previewPending = false; this.onState();
                if (this.locked && !previous) this.onLock(true);
                this.timer = setTimeout(() => { void this.preview(); }, 170);
            } else if (message.type === 'ENROLLMENT_RESULT' || message.type === 'ENROLLMENT_STATE') {
                this.enrollmentState(message); this.locked = false; this.visible = false;
                if (message.type === 'ENROLLMENT_RESULT') { this.enrollmentPending = false; clearTimeout(this.enrollmentTimeout); this.onEnroll(message.accepted === true); }
                this.onState();
            } else if (message.type === 'TARGET_LOCK') {
                this.locked = message.locked; this.targetId = message.targetId || null;
                this.onState(); this.onLock(message.locked);
            } else if (message.type === 'VISION_ERROR') {
                this.enrollmentPending = false; clearTimeout(this.enrollmentTimeout);
                this.previewPending = false; this.onError(message.code); this.onState();
                if (this.enabled && this.online) this.timer = setTimeout(() => { void this.preview(); }, 300);
            }
        }
        enrollmentState(message) { this.selfEnrolled = message.selfEnrolled === true; this.opponentEnrolled = message.opponentEnrolled === true; }
        async capture(source = this.video, limit = 960, quality = .8) {
            if (!source.srcObject?.active || source.readyState < 2 || document.visibilityState !== 'visible') return Promise.resolve(null);
            const scale = Math.min(1, limit/Math.max(source.videoWidth, source.videoHeight));
            const width = Math.round(source.videoWidth*scale), height = Math.round(source.videoHeight*scale);
            const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
            canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, width, height);
            let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (blob?.size > 262144) blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .55));
            return blob;
        }
        async enroll(source) {
            if (!this.online || this.enrollmentPending) return;
            this.enrollmentPending = true; this.onState();
            let blob = await this.capture(source, 1280, .85);
            if (blob?.size > 262144) blob = await this.capture(source, 960, .7);
            if (!await this.packet({ kind: 'ENROLL', frameId: ++this.frameId }, blob)) { this.enrollmentPending = false; this.onError('SELFIE_CAPTURE_FAILED'); this.onState(); return; }
            this.enrollmentTimeout = setTimeout(() => { this.enrollmentPending = false; this.onError('SELFIE_TIMEOUT'); this.onState(); }, 12000);
        }
        pausePreview() { this.previewEnabled = false; clearTimeout(this.timer); }
        async packet(header, blob) {
            if (!blob || !this.online || this.socket?.readyState !== WebSocket.OPEN || blob.size > 262144) return false;
            const json = new TextEncoder().encode(JSON.stringify(header)), prefix = new ArrayBuffer(4);
            new DataView(prefix).setUint32(0, json.length, false);
            this.socket.send(new Blob([prefix, json, blob])); return true;
        }
        async preview() {
            if (!this.enabled || !this.online || !this.previewEnabled || this.previewPending) return;
            if (document.visibilityState !== 'visible' || !this.video.srcObject?.active) { this.timer = setTimeout(() => { void this.preview(); }, 300); return; }
            this.previewPending = true;
            const frameId = ++this.frameId, blob = await this.capture();
            if (!await this.packet({ kind: 'PREVIEW', frameId }, blob)) { this.previewPending = false; this.timer = setTimeout(() => { void this.preview(); }, 300); }
        }
        prepareShot(sequence) {
            this.discardShot(sequence);
            const capture = { frameId: ++this.frameId, blob: this.capture() };
            capture.timeout = setTimeout(() => this.discardShot(sequence), 2000);
            this.captures.set(sequence, capture);
        }
        discardShot(sequence) { const previous = this.captures.get(sequence); if (previous) clearTimeout(previous.timeout); this.captures.delete(sequence); }
        async submitShot(sequence, shotId) {
            const capture = this.captures.get(sequence); this.discardShot(sequence);
            if (capture) await this.packet({ kind: 'SHOT', frameId: capture.frameId, shotId }, await capture.blob);
        }
        stop() {
            this.enabled = false; this.online = false; this.locked = false; this.visible = false;
            clearTimeout(this.timer); clearTimeout(this.watchdog);
            clearTimeout(this.enrollmentTimeout); this.enrollmentPending = false; this.previewPending = false;
            for (const sequence of this.captures.keys()) this.discardShot(sequence);
            if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
            this.status = 'off'; this.frame = null; this.onState();
        }
    }
    function transform(videoWidth, videoHeight, width, height) {
        const scale = Math.max(width/videoWidth, height/videoHeight);
        const cropX = (videoWidth*scale-width)/2, cropY = (videoHeight*scale-height)/2;
        return { scale, toView: point => [point[0]*videoWidth*scale-cropX, point[1]*videoHeight*scale-cropY],
            fromView: point => [(point[0]+cropX)/(videoWidth*scale), (point[1]+cropY)/(videoHeight*scale)] };
    }
    window.ShootyVision = Object.freeze({ VisionClient, transform });
})();
