(function (root, factory) {
    const exports = factory();
    if (typeof module === 'object' && module.exports) module.exports = exports;
    else root.ShootyAudio = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const SHOT_URL = '/web/audio/pistol-1911.wav';
    const RELOAD_URLS = {
        'reload-start': '/web/audio/pistol-reload-start.wav',
        'reload-complete': '/web/audio/pistol-reload-complete.wav'
    };
    const DURATIONS = { empty: 0.075, 'body-hit': .075, 'head-hit': .12 };

    function soundData(name, sampleRate) {
        const duration = DURATIONS[name];
        if (!duration) throw new Error('Unknown sound');
        const data = new Float32Array(Math.ceil(duration * sampleRate));
        let seed = 38171;
        const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
        function click(time, start, decay, frequency) {
            const t = time - start;
            return t < 0 ? 0 : Math.exp(-t / decay) * (noise() * .52 + Math.sin(2 * Math.PI * frequency * t) * .25);
        }
        for (let i = 0; i < data.length; i++) {
            const t = i / sampleRate;
            const value = name === 'empty' ? click(t, 0, .008, 1550) * .5 :
                Math.sin(2*Math.PI*(name === 'head-hit' ? 1600 : 1100)*t)*Math.exp(-t/.025)*.18;
            const fadeIn = Math.min(1, i / (sampleRate * .0007));
            const fadeOut = Math.min(1, (data.length - i - 1) / (sampleRate * .006));
            data[i] = Math.max(-.9, Math.min(.9, value * fadeIn * fadeOut));
        }
        return data;
    }

    class AudioEngine {
        constructor({ volume = .45, muted = false, onState = () => {} } = {}) {
            this.volume = volume; this.muted = muted; this.onState = onState;
            this.context = null; this.buffers = new Map(); this.voices = new Set(); this.playCounts = {};
            this.shotStatus = 'idle'; this.shotError = null; this.shotLoad = null;
            this.reloadStatus = 'idle'; this.reloadError = null; this.reloadLoad = null; this.reloadVoices = new Set();
        }
        get state() { return this.context ? this.context.state : 'locked'; }
        get shotDuration() { return this.buffers.get('shot')?.duration || 0; }
        get reloadDurations() { return Object.fromEntries(Object.keys(RELOAD_URLS).map(name => [name, this.buffers.get(name)?.duration || 0])); }
        async loadRecordedReload() {
            if (this.reloadStatus === 'ready') return true;
            if (this.reloadLoad) return this.reloadLoad;
            this.reloadStatus = 'loading'; this.reloadError = null; this.onState(this.state);
            this.reloadLoad = (async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                try {
                    const buffers = await Promise.all(Object.entries(RELOAD_URLS).map(async ([name, url]) => {
                        const response = await fetch(url, { signal: controller.signal });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
                        if (!buffer.length || buffer.duration > 2) throw new Error('Invalid reload recording');
                        return [name, buffer];
                    }));
                    for (const [name, buffer] of buffers) this.buffers.set(name, buffer);
                    this.reloadStatus = 'ready'; return true;
                } catch (error) {
                    controller.abort(); this.reloadStatus = 'error'; this.reloadError = error.message; return false;
                } finally { clearTimeout(timeout); this.onState(this.state); }
            })();
            try { return await this.reloadLoad; }
            finally { this.reloadLoad = null; }
        }
        async loadRecordedShot() {
            if (this.shotStatus === 'ready') return true;
            if (this.shotLoad) return this.shotLoad;
            this.shotStatus = 'loading'; this.shotError = null; this.onState(this.state);
            this.shotLoad = (async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                try {
                    const response = await fetch(SHOT_URL, { signal: controller.signal });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
                    if (!buffer.length || buffer.duration > 5) throw new Error('Invalid shot recording');
                    this.buffers.set('shot', buffer); this.shotStatus = 'ready';
                    return true;
                } catch (error) {
                    this.shotStatus = 'error'; this.shotError = error.message;
                    return false;
                } finally {
                    clearTimeout(timeout); this.onState(this.state);
                }
            })();
            try { return await this.shotLoad; }
            finally { this.shotLoad = null; }
        }
        async unlock() {
            const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!Context) { this.onState('unsupported'); return false; }
            try {
                if (!this.context) {
                    this.context = new Context({ latencyHint: 'interactive' });
                    this.master = this.context.createGain();
                    this.master.connect(this.context.destination);
                    for (const name of Object.keys(DURATIONS)) {
                        const data = soundData(name, this.context.sampleRate);
                        const buffer = this.context.createBuffer(1, data.length, this.context.sampleRate);
                        buffer.copyToChannel(data, 0); this.buffers.set(name, buffer);
                    }
                    this.context.onstatechange = () => this.onState(this.state);
                }
                this.setVolume(this.volume); this.setMuted(this.muted);
                if (this.context.state !== 'running') await this.context.resume();
                const [shotReady, reloadReady] = await Promise.all([this.loadRecordedShot(), this.loadRecordedReload()]);
                this.onState(this.state);
                return this.state === 'running' && shotReady && reloadReady;
            } catch { this.onState('blocked'); return false; }
        }
        setVolume(value) { this.volume = Math.max(0, Math.min(1, Number(value) || 0)); this.applyGain(); }
        setMuted(value) { this.muted = Boolean(value); this.applyGain(); this.onState(this.state); }
        applyGain() { if (this.master) this.master.gain.setValueAtTime(this.muted ? 0 : this.volume, this.context.currentTime); }
        play(name, delay = 0) {
            if (this.state !== 'running' || this.muted || this.volume === 0 || !this.buffers.has(name)) return false;
            if (this.voices.size >= 6) { const oldest = this.voices.values().next().value; oldest.stop(); this.voices.delete(oldest); this.reloadVoices.delete(oldest); }
            const node = this.context.createBufferSource();
            node.buffer = this.buffers.get(name); node.connect(this.master); this.voices.add(node);
            if (Object.hasOwn(RELOAD_URLS, name)) this.reloadVoices.add(node);
            node.onended = () => { this.voices.delete(node); this.reloadVoices.delete(node); node.disconnect(); };
            node.start(this.context.currentTime + delay);
            this.playCounts[name] = (this.playCounts[name] || 0) + 1;
            return true;
        }
        stopReload() { for (const node of this.reloadVoices) { try { node.stop(); } catch {} this.voices.delete(node); } this.reloadVoices.clear(); }
        stop() { for (const node of this.voices) { try { node.stop(); } catch {} } this.voices.clear(); this.reloadVoices.clear(); }
    }
    return { AudioEngine, soundData, DURATIONS, SHOT_URL, RELOAD_URLS };
});
