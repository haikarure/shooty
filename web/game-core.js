(function (root, factory) {
    const exports = factory();
    if (typeof module === 'object' && module.exports) module.exports = exports;
    else root.ShootyCore = exports;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const BUTTON_IDS = new Set('23456789A'.split(''));
    const ACTIONS = ['reload', 'aim', 'mute'];

    class InputDecoder {
        constructor() { this.reset(); }
        reset() { this.trigger = false; this.buttons = new Set(); }
        decode(bytes) {
            const text = String.fromCharCode(...bytes);
            if (text === 'ARGun KeyPressed') {
                if (this.trigger) return null;
                this.trigger = true;
                return { action: 'fire', pressed: true };
            }
            if (bytes.length === 16 && bytes.every(byte => byte === 0)) {
                if (!this.trigger) return null;
                this.trigger = false;
                return { action: 'fire', pressed: false };
            }
            const match = /^B([2-9A])(DOWN|UP)$/.exec(text);
            if (!match) return null;
            const button = match[1], pressed = match[2] === 'DOWN';
            if (pressed === this.buttons.has(button)) return null;
            if (pressed) this.buttons.add(button); else this.buttons.delete(button);
            return { button, pressed };
        }
    }

    class TrainingSession {
        constructor({ capacity = 30, reloadMs = 1200, cooldownMs = 200 } = {}) {
            this.capacity = capacity;
            this.reloadMs = reloadMs;
            this.cooldownMs = cooldownMs;
            this.ammo = capacity;
            this.active = false;
            this.reloadAt = null;
            this.lastShotAt = -Infinity;
            this.shots = 0;
        }
        start() { this.active = true; }
        stop() { this.active = false; this.reloadAt = null; }
        cancelReload() { this.reloadAt = null; }
        update(now) {
            if (this.active && this.reloadAt !== null && now >= this.reloadAt) {
                this.reloadAt = null;
                this.ammo = this.capacity;
                return 'reload-complete';
            }
            return null;
        }
        fire(now) {
            if (!this.active) return 'inactive';
            if (this.reloadAt !== null) return 'reloading';
            if (now - this.lastShotAt < this.cooldownMs) return 'cooldown';
            this.lastShotAt = now;
            if (this.ammo === 0) return 'empty';
            this.ammo -= 1;
            this.shots += 1;
            return 'shot';
        }
        reload(now) {
            if (!this.active) return 'inactive';
            if (this.reloadAt !== null) return 'reloading';
            if (this.ammo === this.capacity) return 'full';
            this.reloadAt = now + this.reloadMs;
            return 'reload-start';
        }
    }

    class ControlBindings {
        constructor(data) {
            this.map = Object.fromEntries(ACTIONS.map(action => [action, null]));
            if (data && data.version === 1 && data.bindings) {
                for (const action of ACTIONS) {
                    const id = data.bindings[action];
                    if (BUTTON_IDS.has(id) && !Object.values(this.map).includes(id)) this.map[action] = id;
                }
            }
        }
        actionFor(button) { return ACTIONS.find(action => this.map[action] === button) || null; }
        assign(action, button) {
            if (!ACTIONS.includes(action) || !BUTTON_IDS.has(button)) return { ok: false, reason: 'invalid' };
            const conflict = this.actionFor(button);
            if (conflict && conflict !== action) return { ok: false, reason: 'conflict', conflict };
            this.map[action] = button;
            return { ok: true };
        }
        clear(action) { if (ACTIONS.includes(action)) this.map[action] = null; }
        serialize() { return { version: 1, bindings: { ...this.map } }; }
    }

    // Two clean press/release cycles avoid assigning a diagonal/chord by accident.
    // All packets are consumed during learning, including the final release.
    class ButtonLearner {
        constructor() { this.reset(); }
        reset() { this.candidate = null; this.completedCycles = 0; this.dirty = false; }
        consume(event, heldButtons, triggerHeld) {
            if (event.action === 'fire') {
                this.dirty = true;
                if (!triggerHeld && heldButtons.size === 0) this.reset();
                return { status: 'trigger-reserved' };
            }
            if (!BUTTON_IDS.has(event.button)) return { status: 'waiting' };
            if (triggerHeld || heldButtons.size > 1) this.dirty = true;
            if (event.pressed && !this.dirty) {
                if (this.candidate && this.candidate !== event.button) this.reset();
                this.candidate = event.button;
                return { status: 'release', button: event.button };
            }
            if (!event.pressed && heldButtons.size === 0 && !triggerHeld) {
                if (this.dirty) { this.reset(); return { status: 'chord-rejected' }; }
                if (event.button === this.candidate) {
                    this.completedCycles += 1;
                    if (this.completedCycles === 2) return { status: 'complete', button: this.candidate };
                    return { status: 'confirm', button: this.candidate };
                }
            }
            return { status: 'waiting' };
        }
    }
    return { InputDecoder, TrainingSession, ControlBindings, ButtonLearner };
});
