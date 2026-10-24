/* Server state owns the room, deadlines and ammo; no hit or payout claims. */
(() => {
    'use strict';
    class DuelClient {
        constructor({ onState = () => {}, onInput = () => {}, onEvent = () => {}, onShot = () => {}, onError = () => {} } = {}) {
            Object.assign(this, { onState, onInput, onEvent, onShot, onError });
            this.room = null; this.playerId = null; this.online = false; this.status = 'offline';
            this.sequence = 0; this.pendingAction = null; this.offset = 0; this.bestRtt = Infinity;
            this.pings = new Map(); this.pingNumber = 0; this.availability = null;
            this.wantConnection = false; this.attempts = 0; this.socket = null; this.connectionPromise = null;
            this.requests = new Map(); this.requestNumber=0; this.chainConfig={enabled:false,ready:false}; this.walletAddress=null;this.walletAuthenticated=false;
            try { this.token = sessionStorage.getItem('shooty.duel.session.v1'); } catch { this.token = null; }
        }
        now() { return performance.now() + this.offset; }
        get self() { return this.room?.players.find(player => player.id === this.playerId) || null; }
        get opponent() { return this.room?.players.find(player => player.id !== this.playerId) || null; }
        raw(message) {
            if (this.socket?.readyState !== WebSocket.OPEN) return false;
            this.socket.send(JSON.stringify(message)); return true;
        }
        connect() {
            if (this.online) return Promise.resolve();
            if (this.connectionPromise) return this.connectionPromise;
            this.wantConnection = true; this.status = 'connecting'; this.onState();
            this.connectionPromise = new Promise((resolve, reject) => {
                this.resolveConnection = resolve; this.rejectConnection = reject;
            });
            const result = this.connectionPromise;
            const url = new URL('/ws/duel', window.SHOOTY_CONFIG?.backendUrl || location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url); this.socket = socket;
            this.handshakeTimer = setTimeout(() => socket.close(), 10000);
            socket.onopen = () => this.raw({ type: 'HELLO', token: this.token });
            socket.onmessage = event => { if (this.socket === socket) this.receive(event.data); };
            socket.onclose = event => {
                if (this.socket !== socket) return;
                clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer); clearTimeout(this.nextPing);
                this.pings.clear(); this.online = false; this.status = 'offline'; this.pendingAction = null;
                for(const request of this.requests.values()){clearTimeout(request.timer);request.reject(new Error('SERVER_UNAVAILABLE'));}this.requests.clear();
                this.rejectConnection?.(new Error('SERVER_UNAVAILABLE'));
                this.connectionPromise = this.resolveConnection = this.rejectConnection = null;
                if (event.code === 1008) { this.wantConnection = false; this.onError('SESSION_CLOSED'); }
                this.onState();
                if (this.wantConnection && this.attempts < 10) {
                    this.attempts += 1;
                    this.reconnectTimer = setTimeout(() => { void this.connect().catch(() => {}); }, Math.min(5000, 500 * 2 ** this.attempts));
                }
            };
            return result;
        }
        receive(raw) {
            let message; try { message = JSON.parse(raw); } catch { return; }
            if (!message || typeof message !== 'object') return;
            const request=this.requests.get(message.requestId);
            if(request){this.requests.delete(message.requestId);clearTimeout(request.timer);if(message.type==='ERROR')request.reject(new Error(message.code));else request.resolve(message);}
            if (message.type === 'SESSION') {
                this.playerId = message.playerId; this.token = message.token; this.sequence = message.nextSequence - 1;
                if (!message.resumed) this.room = null;
                this.offset = message.serverNow - performance.now(); this.bestRtt = Infinity;
                this.online = true; this.status = 'online'; this.attempts = 0;
                clearTimeout(this.handshakeTimer);
                try { sessionStorage.setItem('shooty.duel.session.v1', this.token); } catch {}
                this.resolveConnection?.(); this.connectionPromise = this.resolveConnection = this.rejectConnection = null;
                if (this.availability) this.raw({ type: 'AVAILABLE', ...this.availability });
                this.ping(); this.nextPing = setTimeout(() => this.ping(), 150);
                clearInterval(this.pingTimer); this.pingTimer = setInterval(() => this.ping(), 10000);
                this.onState();
            } else if(message.type==='CHAIN_CONFIG') {
                this.chainConfig=message.config;this.onState();
            } else if(message.type==='WALLET_STATE'||message.type==='WALLET_AUTHENTICATED') {
                this.walletAddress=message.address;this.walletAuthenticated=message.authenticated===true;this.onState();
            } else if (message.type === 'PONG') {
                const sent = this.pings.get(message.nonce); this.pings.delete(message.nonce);
                if (sent === undefined) return;
                const now = performance.now(), rtt = now - sent;
                if (rtt < this.bestRtt) { this.bestRtt = rtt; this.offset = message.serverNow - (sent + now) / 2; }
            } else if (message.type === 'ROOM_STATE') {
                if (this.room?.code === message.room.code && message.room.revision <= this.room.revision) return;
                this.room = message.room; this.pendingAction = null; this.onState();
            } else if (message.type === 'ROOM_LEFT') {
                this.room = null; this.pendingAction = null; this.onState();
            } else if (message.type === 'INPUT_RESULT') {
                if (message.code === this.room?.code && message.matchId === this.room?.matchId) this.onInput(message);
            } else if (message.type === 'SHOT_RESULT') {
                if (message.code === this.room?.code && message.matchId === this.room?.matchId) this.onShot(message);
            } else if (message.type === 'ROOM_EVENT') {
                if (message.code === this.room?.code && message.matchId === this.room?.matchId && message.revision >= this.room.revision) this.onEvent(message);
            } else if (message.type === 'ERROR') {
                this.pendingAction = null; this.onError(message.code); this.onState();
            }
        }
        ping() {
            if (!this.online) return;
            const nonce = String(++this.pingNumber); this.pings.set(nonce, performance.now());
            if (this.pings.size > 10) this.pings.delete(this.pings.keys().next().value);
            this.raw({ type: 'PING', nonce });
        }
        setAvailability(value) {
            if (JSON.stringify(value) === JSON.stringify(this.availability)) return;
            this.availability = value;
            if (this.online) this.raw({ type: 'AVAILABLE', ...value });
        }
        async command(type, fields = {}) {
            this.pendingAction = type; this.onState();
            try { await this.connect(); this.raw({ type, ...fields }); }
            catch { this.pendingAction = null; this.onError('SERVER_UNAVAILABLE'); this.onState(); }
        }
        async request(type,fields={}) {
            await this.connect();
            const requestId='w'+(++this.requestNumber);
            return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(requestId);reject(new Error('SERVER_TIMEOUT'));},60000);this.requests.set(requestId,{resolve,reject,timer});if(!this.raw({type,...fields,requestId})){clearTimeout(timer);this.requests.delete(requestId);reject(new Error('SERVER_UNAVAILABLE'));}});
        }
        ready(value) { return this.online && this.raw({ type: 'READY', ready: value }); }
        input(action) {
            if (!this.online || !['LIVE', 'RESOLVING'].includes(this.room?.phase)) return false;
            const sequence = ++this.sequence;
            return this.raw({ type: 'INPUT', matchId: this.room.matchId, seq: sequence, action }) ? sequence : false;
        }
        retry() { clearTimeout(this.reconnectTimer); this.attempts = 0; this.wantConnection = true; void this.connect().catch(() => {}); }
        resume() { if (this.token) this.retry(); }
        close() {
            this.wantConnection = false; clearTimeout(this.reconnectTimer); clearInterval(this.pingTimer);
            clearTimeout(this.nextPing); clearTimeout(this.handshakeTimer);
            if (this.socket) this.socket.close();
        }
    }
    window.ShootyDuel = Object.freeze({ DuelClient });
})();
