/* Local training and camera-demo duels. Wallets and payouts are separate. */
(() => {
    'use strict';
    const { InputDecoder, TrainingSession, ControlBindings, ButtonLearner } = window.ShootyCore;
    const { AudioEngine } = window.ShootyAudio;
    const $ = id => document.getElementById(id);
    const settings = $('settings');
    const decoder = new InputDecoder();
    const game = new TrainingSession();
    const labels = { reload: 'Reload', aim: 'Bidik (tahan)', mute: 'Suara on / off' };
    const queryMode = new URLSearchParams(location.search).get('input');
    let mode = ['bluetooth', 'touch', 'bridge'].includes(queryMode) ? queryMode : 'bluetooth';
    let device, characteristic, connecting = false, connected = false, cameraPending = false, cameraVersion = 0, connectionVersion = 0;
    let socket, reconnectTimer, wakeLock, wakePending = false, orientationLocked = false;
    const standalone = matchMedia('(display-mode: standalone)').matches;
    let started = false, launchPending = false, displayPending = false, displayVersion = 0, pageActive = true, displayError = null;
    let profile = 'unselected', bindings = new ControlBindings();
    let learning = null, learningTimeout, bannerTimeout, flashTimeout;
    let lastBridgeSequence = 0;
    const bridgeButtons = new Set();
    let bridgeTrigger = false;
    const storage = {
        get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
    };
    const preferences = storage.get('shooty.settings.v1') || {};
    let lastRoomCode = null, roomNotice = '', lastRoomEvent = null;
    let visionNotice = '', damageTimeout;
    let selfieStream = null, selfieVersion = 0, selfiePending = false;
    let walletNotice = '', paymentChoice = false;
    const audio = new AudioEngine({
        volume: Number.isFinite(preferences.volume) ? preferences.volume : .45,
        muted: preferences.muted === true,
        onState: () => renderAudio()
    });
    const duel = new window.ShootyDuel.DuelClient({ onState: onDuelState, onInput: onDuelInput, onEvent: onDuelEvent, onShot: onShotResult, onError: onDuelError });
    const vision = new window.ShootyVision.VisionClient({ video: $('camera-feed'), session: duel, onState: renderVision, onError: onVisionError, onEnroll: accepted => { if (accepted && $('selfie-dialog').open) { visionNotice = ''; void closeSelfie(true); } }, onLock: locked => {
        if (locked) visionNotice = '';
        renderVision();
    } });
    const wallet = new window.ShootyWallet.WalletClient({ session:duel, onState:()=>{renderWallet();renderDuel();}, onError:onWalletError });
    $('volume').value = Math.round(audio.volume * 100);
    $('show-touch').checked = preferences.showTouch === true;
    $('player-name').value = storage.get('shooty.playerName.v1') || '';
    $('room-code-input').value = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 6);

    function syncAvailability() {
        duel.setAvailability({ visible: pageActive && document.visibilityState === 'visible', controllerReady: mode === 'touch' || (mode === 'bluetooth' && connected), inputKind: mode === 'touch' ? 'touch' : 'gun' });
    }
    function tokenAmount(value='0') {
        const amount=BigInt(value),whole=amount/1000000n,fraction=String(amount%1000000n).padStart(6,'0').replace(/0+$/,'');
        return String(whole)+(fraction?'.'+fraction:'');
    }
    function onWalletError(code) {
        const messages={WALLET_NOT_FOUND:'Aktifkan wallet di Mises atau pilih wallet browser yang tersedia.',WALLET_REJECTED:'Permintaan wallet dibatalkan. Lu bisa mencoba lagi.',CHAIN_DISABLED:'Pembayaran testnet belum tersedia di server ini.',WALLET_REQUIRED:'Hubungkan wallet dan sign in dahulu.',SIGNERS_UNAVAILABLE:'Penyiapan match testnet belum tersedia.',WALLET_ROSTER_FROZEN:'Room ini sudah terikat ke wallet sebelumnya. Pilih wallet yang sama.',USDC_BALANCE_LOW:'Saldo test USDC belum cukup untuk entry 1.',WRONG_CHAIN:'Pilih jaringan Monad Testnet di wallet.',INVALID_MATCH_TERMS:'Data match tidak cocok dengan kontrak. Pembayaran dihentikan.',CHAIN_RPC_UNAVAILABLE:'Jaringan Monad belum merespons. Status dana akan diperiksa lagi.',TRANSACTION_PENDING:'Transaksi masih menunggu konfirmasi. Cek status sebelum mencoba lagi.',WALLET_TRANSACTION_FAILED:'Transaksi belum berhasil. Cek saldo test MON dan konfirmasi wallet.'};
        walletNotice=messages[code]||'Wallet belum dapat memproses permintaan. Coba lagi.';renderWallet();
    }
    function fundingLabel(funding) {
        if(!funding)return '';
        const labels={WAITING_ROSTER:'Menunggu dua pemain dengan wallet yang berbeda.',CREATING:'Menyiapkan match di Monad Testnet…',OPEN:`Deposit terkonfirmasi: ${(funding.depositMask&1?1:0)+(funding.depositMask&2?1:0)}/2 pemain.`,FUNDED:'Kedua entry sudah masuk. Siapkan perangkat dan selfie, lalu Siap Duel.',STARTING:'Menunggu konfirmasi start di Monad…',LIVE:'Dana terkunci di kontrak selama duel.',SETTLING:'Hasil dikirim untuk verifikasi kontrak…',CREDITED:'Hasil diverifikasi. Kredit hadiah tersedia.',PAYING:'Hadiah sedang dikirim…',PAID:'Pembayaran sudah dikonfirmasi.',REFUND_PENDING:'Memproses timeout kontrak…',REFUND_AVAILABLE:'Pengembalian dana tersedia.',REFUNDING:'Refund sedang dikirim…',REFUNDED:'Refund sudah dikonfirmasi.'};
        const key=(wallet.account||duel.walletAddress||'').toLowerCase(),received=funding.payments?.[key];
        if(received)return `${tokenAmount(received)} test USDC sudah terkirim ke wallet lu.`;
        return (labels[funding.stage]||'Memeriksa match…')+(funding.error?' Jaringan belum selesai memproses; kredit tetap diperiksa.':'');
    }
    function renderWallet() {
        const selected=$('wallet-provider').value;
        const options=wallet.providers.map((entry,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=entry.name;return option;});
        if(!options.length){const option=document.createElement('option');option.value='0';option.textContent='Wallet belum tersedia';options.push(option);}
        $('wallet-provider').replaceChildren(...options);if(options.some(option=>option.value===selected))$('wallet-provider').value=selected;
        $('wallet-provider').disabled=Boolean(wallet.pending);
        $('connect-wallet').disabled=Boolean(wallet.pending);
        $('connect-wallet').textContent=wallet.pending==='connect'?'Menunggu wallet…':wallet.authenticated?'Wallet tersambung':'Hubungkan & sign in';
        $('wallet-status').textContent=walletNotice||(wallet.authenticated?`${wallet.account.slice(0,6)}…${wallet.account.slice(-4)} · Monad Testnet`:duel.online&&!duel.chainConfig.enabled?'Latihan tanpa dana tersedia. Pembayaran testnet belum diaktifkan.':'Buka di Mises dengan wallet aktif, lalu hubungkan dan sign in.');
        $('wallet-balance').textContent=wallet.balance===null?'':`Saldo ${tokenAmount(wallet.balance)} test USDC · gas memakai test MON`;
        $('recover-payments').disabled=!wallet.authenticated||Boolean(wallet.pending);
        const funding=duel.room?.funding;
        $('funding-panel').hidden=!funding;
        if(funding) {
            const slot=funding.roster?.findIndex(address=>address.toLowerCase()===(duel.walletAddress||'').toLowerCase())??-1;
            const deposited=slot>=0&&Boolean(funding.depositMask&(1<<slot));
            const credit=funding.credits?.find(item=>item.address.toLowerCase()===(duel.walletAddress||'').toLowerCase());
            $('funding-status').textContent=fundingLabel(funding);
            $('deposit-entry').disabled=!wallet.authenticated||Boolean(wallet.pending)||!funding.termsHash||funding.onchainState!==1||deposited;
            $('deposit-entry').textContent=deposited?'DEPOSIT TERKONFIRMASI':wallet.pending==='approve'?'IZINKAN 1 TEST USDC…':wallet.pending==='deposit'?'MENUNGGU DEPOSIT…':'BAYAR 1 TEST USDC';
            $('claim-credit').hidden=!credit||BigInt(credit.amount)===0n;$('claim-credit').disabled=!wallet.authenticated||Boolean(wallet.pending);
            const deadline=Number(funding.onchainState===1?funding.joinDeadline:funding.onchainState===2?funding.startDeadline:funding.resultDeadline);
            $('expire-match').hidden=![1,2,3].includes(funding.onchainState)||!deadline||Date.now()/1000<=deadline;
            $('expire-match').disabled=!wallet.authenticated||Boolean(wallet.pending);
        }
        $('wallet-transaction').hidden=!wallet.lastTransaction;
        if(wallet.lastTransaction)$('wallet-transaction').href=`https://testnet.monadscan.com/tx/${wallet.lastTransaction}`;
        const rows=wallet.recovery.map(match=>{const row=document.createElement('div');row.className='recovery-row';const text=document.createElement('span');text.textContent=`${match.matchId.slice(0,10)}… · ${fundingLabel(match)}`;row.append(text);
            const credit=match.credits?.find(c=>c.address.toLowerCase()===(wallet.account||'').toLowerCase());
            if(credit&&BigInt(credit.amount)>0n){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent=`Klaim ${tokenAmount(credit.amount)}`;button.disabled=Boolean(wallet.pending);button.onclick=()=>void wallet.claim(match);row.append(button);}
            const deadline=Number(match.onchainState===1?match.joinDeadline:match.onchainState===2?match.startDeadline:match.resultDeadline);
            if([1,2,3].includes(match.onchainState)&&deadline&&Date.now()/1000>deadline){const button=document.createElement('button');button.type='button';button.className='small-button';button.textContent='Refund timeout';button.disabled=Boolean(wallet.pending);button.onclick=()=>void wallet.claim(match,true);row.append(button);}return row;});
        $('recovery-list').replaceChildren(...rows);
    }
    function gameView() {
        if (!duel.room) return game;
        const self = duel.self;
        return { ammo: self?.ammo ?? 30, shots: self?.shots ?? 0, reloadAt: self?.reloadAt ?? null,
            capacity: duel.room.rules.capacity, reloadMs: duel.room.rules.reloadMs,
            active: duel.online && duel.room.phase === 'LIVE' && self?.ready === true };
    }
    function onVisionError(code) {
        const messages = { CAMERA_REQUIRED: 'Aktifkan kamera dulu.', SERVER_UNAVAILABLE: 'Server belum tersambung.', VISION_TIMEOUT: 'Deteksi belum siap. Coba aktifkan lagi.', ENGINE_UNAVAILABLE: 'Model deteksi belum tersedia di server.', TARGET_NOT_FOUND: 'Arahkan kamera sampai badan lawan terlihat.', TARGET_AMBIGUOUS: 'Ada beberapa orang bertumpuk. Pilih lawan yang terlihat jelas.', TARGET_FRAME_EXPIRED: 'Frame sudah berubah. Tunggu kotak tubuh muncul, lalu coba lagi.', OPPONENT_REQUIRED: 'Masuk room dengan lawan terlebih dahulu.', PAUSE_TO_CALIBRATE: 'Buka pengaturan untuk mengunci target lagi.' };
        const selfieMessages = { SELFIE_FACE_NOT_FOUND: 'Wajah belum terlihat. Hadapkan wajah ke kamera.', SELFIE_CENTER_FACE: 'Geser wajah lu ke tengah bingkai.', SELFIE_MULTIPLE_FACES: 'Ada dua wajah berdekatan. Dekatkan wajah lu ke tengah bingkai.', SELFIE_TOO_SMALL: 'Dekatkan wajah ke kamera.', SELFIE_POOR_QUALITY: 'Cari cahaya lebih terang dan tahan HP agar tidak blur.', SELFIE_SAME_AS_OPPONENT: 'Wajah ini sudah terdaftar sebagai lawan. Ambil selfie diri sendiri.', SELFIE_CAPTURE_FAILED: 'Foto belum terkirim. Coba lagi.', SELFIE_TIMEOUT: 'Penyimpanan belum selesai. Cek sambungan server.', SELFIE_ROOM_REQUIRED: 'Masuk ke room duel kamera terlebih dahulu.', PAUSE_TO_ENROLL: 'Buka pengaturan untuk mengulang selfie.', FACE_NOT_CONFIRMED: 'Wajah lawan belum cocok dengan selfie di room.' };
        visionNotice = messages[code] || selfieMessages[code] || 'Deteksi belum dapat memproses frame. Coba lagi.';
        if ($('selfie-dialog').open) $('selfie-status').textContent = visionNotice;
        renderVision();
    }
    function renderVision() {
        const ownEnrolled = duel.self?.faceEnrolled === true, otherEnrolled = duel.opponent?.faceEnrolled === true;
        $('open-selfie').disabled = !duel.room || duel.room.mode !== 'VISION' || ['ENDED', 'RESOLVING'].includes(duel.room.phase) || selfiePending || cameraPending;
        $('open-selfie').textContent = ownEnrolled ? 'Ulangi selfie' : 'Daftar selfie';
        $('take-selfie').disabled = !selfieStream?.active || $('selfie-feed').readyState < 2 || !vision.online || vision.enrollmentPending;
        $('take-selfie').textContent = vision.enrollmentPending ? 'MENYIMPAN…' : 'SIMPAN SELFIE';
        $('cancel-selfie').disabled = vision.enrollmentPending;
        $('cancel-selfie').textContent = ownEnrolled ? 'Pakai selfie tersimpan' : 'Batal';
        $('selfie-saved').hidden = !ownEnrolled;
        $('start-vision').disabled = vision.enabled || cameraPending;
        $('start-vision').textContent = vision.status === 'loading' ? 'Menyiapkan kamera…' : vision.online ? 'Kamera game aktif' : 'Aktifkan kamera game';
        $('vision-status').textContent = visionNotice || (!ownEnrolled ? 'Masuk room, lalu ambil selfie diri sendiri.' : !otherEnrolled ? 'Selfie lu tersimpan. Tunggu lawan mendaftarkan selfie.' : vision.status === 'loading' ? 'Menyiapkan kamera…' : 'Selfie kedua pemain siap. Langsung Siap Duel; lawan dikenali otomatis saat main.');
        $('tracking-status').hidden = !vision.online || !duel.room || settings.open;
        $('tracking-status').textContent = vision.locked && vision.visible ? 'LAWAN TERKONFIRMASI' : 'MENCARI WAJAH LAWAN';
        renderDuel();
    }
    async function openSelfie() {
        if (selfiePending || !duel.room || duel.room.mode !== 'VISION') return;
        selfiePending = true; const attempt = ++selfieVersion; visionNotice = '';
        duel.ready(false); vision.pausePreview();
        cameraVersion += 1;
        const rear = $('camera-feed'); if (rear.srcObject) rear.srcObject.getTracks().forEach(track => track.stop()); rear.srcObject = null;
        document.body.dataset.camera = 'false';
        $('selfie-status').textContent = 'Menyiapkan kamera depan…'; $('selfie-dialog').showModal(); renderVision();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
            if (attempt !== selfieVersion || !$('selfie-dialog').open) { stream.getTracks().forEach(track => track.stop()); return; }
            selfieStream = stream; $('selfie-feed').srcObject = stream; await $('selfie-feed').play();
            await vision.start({ preview: false });
            $('selfie-status').textContent = 'Wajah terlihat jelas? Tap Simpan selfie.';
        } catch { $('selfie-status').textContent = 'Kamera depan belum tersedia. Izinkan kamera dan coba lagi.'; }
        finally { selfiePending = false; renderVision(); }
    }
    async function closeSelfie(resume = true) {
        visionNotice = '';
        selfieVersion += 1;
        if (selfieStream) selfieStream.getTracks().forEach(track => track.stop());
        selfieStream = null; $('selfie-feed').srcObject = null;
        if ($('selfie-dialog').open) $('selfie-dialog').close();
        selfiePending = false;
        if (resume && pageActive && duel.room) { await startCamera(); await vision.start(); }
        renderVision();
    }
    async function beginDetection() {
        visionNotice = '';
        if (!$('camera-feed').srcObject?.active) await startCamera();
        await vision.start(); renderVision();
    }
    function drawVision() {
        const canvas = $('vision-overlay'), video = $('camera-feed');
        if (!vision.online) { if (canvas.width) canvas.width = 0; return; }
        const width = innerWidth, height = innerHeight, ratio = Math.min(devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width*ratio) || canvas.height !== Math.round(height*ratio)) { canvas.width = Math.round(width*ratio); canvas.height = Math.round(height*ratio); }
        const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        if (!vision.online || !vision.frame || performance.now()-vision.receivedAt > 700 || !video.videoWidth) return;
        const transform = window.ShootyVision.transform(video.videoWidth, video.videoHeight, width, height);
        for (const candidate of vision.frame.candidates) {
            const color = candidate.selected ? '#b9aaff' : '#ddd7fe';
            context.strokeStyle = color; context.fillStyle = candidate.selected ? '#6e54ff19' : '#ddd7fe09'; context.lineWidth = candidate.selected ? 2 : 1;
            context.setLineDash(candidate.selected ? [] : [5, 5]);
            context.beginPath(); candidate.body.forEach((point, i) => { const [x,y] = transform.toView(point); if (!i) context.moveTo(x,y); else context.lineTo(x,y); }); context.closePath(); context.fill(); context.stroke();
            context.setLineDash([]);
            for (const limb of candidate.limbs) { const a = transform.toView(limb.a), b = transform.toView(limb.b); context.lineWidth = Math.max(1, limb.r*video.videoWidth*transform.scale*2); context.globalAlpha = .35; context.lineCap = 'round'; context.beginPath(); context.moveTo(...a); context.lineTo(...b); context.stroke(); }
            context.globalAlpha = 1; context.lineWidth = 1.5;
            if (candidate.head) { const head = candidate.head, [x,y] = transform.toView([head.cx,head.cy]); context.strokeStyle = '#ff8ee4'; context.beginPath(); context.ellipse(x,y,head.rx*video.videoWidth*transform.scale,head.ry*video.videoHeight*transform.scale,0,0,Math.PI*2); context.stroke(); }
        }
    }
    function onShotResult(event) {
        if (event.status !== 'HIT') { if (event.status === 'MISS' && duel.room?.phase === 'LIVE') message(event.reason === 'TARGET_NOT_CONFIRMED' ? 'LAWAN BELUM TERKONFIRMASI' : 'MELESET'); return; }
        clearTimeout(bannerTimeout); $('hit-banner').textContent = event.zone === 'HEAD' ? `HEADSHOT · −${event.damage}` : `HIT · −${event.damage}`;
        audio.play(event.zone === 'HEAD' ? 'head-hit' : 'body-hit');
        bannerTimeout = setTimeout(() => { $('hit-banner').textContent = ''; }, 850);
    }
    function onDuelError(code) {
        if(['WALLET_REQUIRED','SIGNERS_UNAVAILABLE','CHAIN_DISABLED','CHAIN_RPC_UNAVAILABLE','DUPLICATE_WALLET','FUNDED_ROOM_LOCKED','MATCH_NOT_FUNDED','PAID_VISION_REQUIRED'].includes(code)) {
            const messages={DUPLICATE_WALLET:'Kedua pemain harus memakai wallet berbeda.',FUNDED_ROOM_LOCKED:'Roster sudah dikunci di kontrak. Selesaikan match atau tunggu refund timeout.',MATCH_NOT_FUNDED:'Entry kedua pemain belum dikonfirmasi.',PAID_VISION_REQUIRED:'Duel test USDC memakai mode Duel kamera.'};
            if(messages[code])walletNotice=messages[code];else onWalletError(code);renderWallet();
            $('setup-message').textContent=walletNotice;return;
        }
        const messages = { SERVER_UNAVAILABLE: 'Server belum tersambung. Coba lagi.', ROOM_NOT_FOUND: 'Kode room tidak ditemukan.', INVALID_ROOM_CODE: 'Masukkan kode room 6 karakter.', ROOM_FULL: 'Room sudah berisi dua pemain.', ROOM_ALREADY_STARTED: 'Room sudah dimulai. Buat room baru.', ALREADY_IN_ROOM: 'Keluar dari room saat ini terlebih dahulu.', DEVICE_NOT_READY: 'Pilih Touch atau hubungkan pistol sebelum siap.', ROOM_ENDED: 'Sesi selesai. Keluar dan buat room baru.', SESSION_CLOSED: 'Sesi koneksi ditutup. Buka ulang halaman untuk melanjutkan.', SERVER_FULL: 'Server penuh. Coba lagi nanti.' };
        roomNotice = messages[code] || ({ SELFIE_REQUIRED: 'Daftarkan selfie diri sendiri dahulu.', OPPONENT_SELFIE_REQUIRED: 'Tunggu lawan mendaftarkan selfie.', VISION_NOT_READY: 'Aktifkan kamera belakang dan deteksi sebelum siap.', CAMERA_NOT_READY: 'Kamera belum mengirim frame. Aktifkan deteksi lagi.', RESULT_PENDING: 'Hasil tembakan sedang diperiksa.' })[code] || 'Perintah belum dapat diproses. Coba lagi.';
        $('room-feedback').textContent = roomNotice;
        if (settings.open && duel.room) $('setup-message').textContent = roomNotice;
    }
    function onDuelState() {
        if(!duel.room&&duel.chainConfig.enabled&&!paymentChoice)$('room-payment').value='TEST_USDC';
        renderWallet();
        if (!duel.room && $('selfie-dialog').open) void closeSelfie(false);
        if (duel.room) {
            game.stop(); document.body.dataset.active = 'true';
            if (!duel.online || duel.room.phase !== 'LIVE') { audio.stopReload(); document.body.dataset.aim = 'false'; }
        } else if (lastRoomCode) {
            game.stop(); audio.stopReload(); document.body.dataset.active = 'false';
            if (started && pageActive && !settings.open) settings.showModal();
        }
        lastRoomCode = duel.room?.code || null;
        renderDuel(); renderGame(); renderVision();
    }
    function renderDuel() {
        const room = duel.room, pending = Boolean(duel.pendingAction);
        $('duel-network').textContent = duel.online ? 'Server tersambung' : duel.status === 'connecting' ? 'Menghubungkan…' : 'Belum tersambung';
        $('reconnect-duel').hidden = duel.online || !room;
        $('reconnect-duel').disabled = duel.status === 'connecting';
        $('room-admission').hidden = Boolean(room); $('room-lobby').hidden = !room;
        $('create-room').disabled = pending || mode === 'bridge'; $('join-room').disabled = pending || mode === 'bridge';
        $('leave-room').disabled = pending||Boolean(room?.funding?.sealed&&![4,5].includes(room.funding.onchainState));
        $('duel-hud').hidden = !room;
        $('session-kind').textContent = room ? 'DUEL 1V1' : 'LATIHAN';
        $('target-stat').textContent = room?.mode === 'VISION' ? 'BODY 25 · HEADSHOT 50 · 100 HP' : room ? 'UJI INPUT · DETEKSI HIT BELUM AKTIF' : 'LATIHAN LOKAL';
        $('health-hud').hidden = room?.mode !== 'VISION';
        $('enter-arena').firstChild.nodeValue = room ? (room.phase === 'PAUSED' ? 'SIAP LAGI ' : 'SIAP DUEL ') : 'MASUK LATIHAN ';
        $('enter-arena').disabled = pending || Boolean(room && (!duel.online || ['ENDED','RESOLVING','CHAIN_STARTING'].includes(room.phase)||room.funding&&![2,3].includes(room.funding.onchainState)));
        $('setup-footer-note').textContent = room ? 'Dua pemain mengikuti countdown dan aturan peluru yang sama.' : 'Kamera opsional untuk uji kontrol. Deteksi target belum aktif.';
        if (!room) {
            $('session-status').textContent = game.active ? 'BIDIK & TEMBAK' : 'PERSIAPAN';
            $('room-feedback').textContent = roomNotice || (pending ? 'Menghubungkan ke room…' : 'Buat room atau masukkan kode dari lawan.');
            $('duel-overlay').hidden = true;
            return;
        }
        $('room-code-value').textContent = room.code;
        $('duel-code').textContent = room.code;
        $('duel-self').textContent = `LU ${duel.self?.ammo ?? 30}/30 · ${duel.self?.shots ?? 0} tembakan`;
        $('duel-opponent').textContent = duel.opponent ? `LAWAN ${duel.opponent.ammo}/30 · ${duel.opponent.shots} tembakan` : 'Menunggu lawan';
        if (room.mode === 'VISION') {
            $('self-health-value').textContent = `${duel.self?.health ?? 100} HP`; $('opponent-health-value').textContent = `${duel.opponent?.health ?? 100} HP`;
            $('self-health-fill').style.width = `${duel.self?.health ?? 100}%`; $('opponent-health-fill').style.width = `${duel.opponent?.health ?? 100}%`;
        }
        const roster = room.players.map(player => {
            const row = document.createElement('div'); row.className = 'roster-row';
            const name = document.createElement('strong'); name.textContent = `${player.name}${player.id === duel.playerId ? ' · LU' : ''}`;
            const state = document.createElement('span'); state.textContent = !player.connected ? 'Terputus' : player.ready ? 'Siap' : room.mode === 'VISION' && !player.faceEnrolled ? 'Daftar selfie' : player.available ? 'Belum siap' : 'Atur perangkat';
            const input = document.createElement('span'); input.textContent = player.inputKind === 'gun' ? 'Pistol' : 'Touch';
            row.append(name, input, state); return row;
        });
        if (room.players.length === 1) { const row = document.createElement('div'); row.className = 'roster-row'; row.textContent = 'Slot 2 · menunggu lawan'; roster.push(row); }
        $('room-roster').replaceChildren(...roster);
        const descriptions = { LOBBY: 'Bagikan kode. Tekan Siap Duel setelah perangkat siap.', CHAIN_STARTING:'Menunggu start dikonfirmasi kontrak Monad.', COUNTDOWN: 'Kedua pemain siap. Countdown sedang berjalan.', LIVE: 'Duel berlangsung. Membuka menu menjeda sesi.', PAUSED: 'Sesi dijeda. Kedua pemain perlu siap lagi.', RESOLVING: 'Memeriksa tembakan terakhir sebelum hasil duel.', ENDED: 'Duel selesai. Keluar room untuk memulai sesi baru.' };
        $('room-feedback').textContent = roomNotice || (!duel.online ? 'Koneksi terputus. Tap Sambungkan server untuk mencoba lagi.' : descriptions[room.phase]);
        renderDuelClock();
    }
    function renderDuelClock() {
        const room = duel.room;
        if (!room) return;
        const phase = room.phase === 'ENDED' ? 'ENDED' : duel.online ? room.phase : 'PAUSED';
        $('duel-overlay').hidden = phase === 'LIVE';
        const labels = { LOBBY: 'MENUNGGU', CHAIN_STARTING:'KONFIRMASI START', COUNTDOWN: 'BERSIAP', LIVE: 'LIVE', PAUSED: 'DIJEDA', RESOLVING: 'MEMERIKSA', ENDED: 'SELESAI' };
        $('session-status').textContent = labels[phase];
        if (phase === 'LIVE' && room.endsAt) {
            const remaining = Math.max(0, Math.ceil((room.endsAt-duel.now())/1000));
            $('session-status').textContent = `LIVE · ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
        }
        $('duel-countdown').textContent = phase === 'COUNTDOWN' ? String(Math.max(1, Math.ceil((room.startsAt-duel.now())/1000))) : phase === 'PAUSED' ? 'JEDA' : phase === 'ENDED' ? 'SELESAI' : 'SIAP?';
        const pauseReasons = { PLAYER_DISCONNECTED: 'Koneksi pemain terputus. Buka menu untuk siap lagi.', DEVICE_CHANGED: 'Perangkat pemain belum siap. Buka menu untuk siap lagi.', PLAYER_NOT_READY: 'Pengaturan dibuka. Kedua pemain perlu siap lagi.', PLAYER_RECONNECTED: 'Pemain tersambung lagi. Buka menu untuk siap lagi.' };
        $('duel-caption').textContent = phase === 'COUNTDOWN' ? 'Tunggu sinyal mulai.' : phase === 'PAUSED' ? (!duel.online ? 'Server terputus. Buka menu untuk sambungkan lagi.' : pauseReasons[room.reason] || 'Buka menu dan siap lagi bersama lawan.') : phase === 'ENDED' ? 'Uji input berakhir. Buka menu untuk room baru.' : 'Menunggu kedua pemain siap.';
        if (phase === 'RESOLVING') { $('duel-countdown').textContent = '…'; $('duel-caption').textContent = 'Memeriksa tembakan terakhir.'; }
        if(phase==='CHAIN_STARTING'){$('duel-countdown').textContent='…';$('duel-caption').textContent='Menunggu start dikonfirmasi Monad.';}
        if (phase === 'ENDED' && room.mode === 'VISION') {
            $('duel-countdown').textContent = room.outcome === 'WIN' ? (room.winnerId === duel.playerId ? 'MENANG' : 'KALAH') : room.outcome === 'DRAW' ? 'SERI' : 'DIBATALKAN';
            $('duel-caption').textContent = room.outcome === 'WIN' ? 'Hasil duel ditetapkan server. Buka menu untuk room baru.' : 'Buka menu untuk memulai room baru.';
            if(room.funding)$('duel-caption').textContent=fundingLabel(room.funding);
        }
    }
    function onDuelInput(event) {
        if (!event.accepted) {
            vision.discardShot(event.seq);
            if (event.reason === 'EMPTY') { audio.play('empty'); message('MAGASIN HABIS · tekan reload'); }
            else if (event.reason === 'RELOADING') message('Tunggu, magasin sedang diisi.');
            else if (event.reason === 'FULL') message('Magasin masih penuh.');
            return;
        }
        if (event.shotId) void vision.submitShot(event.seq, event.shotId);
        if (!duel.online || duel.room?.phase !== 'LIVE' || settings.open || document.visibilityState !== 'visible') return;
        if (event.action === 'FIRE') { audio.play('shot'); flashShot(); message(`TEMBAKAN DITERIMA · ${duel.self.ammo} tersisa`); }
        if (event.action === 'RELOAD') { audio.stopReload(); audio.play('reload-start'); document.body.dataset.aim = 'false'; message('RELOAD · 1,2 detik'); }
    }
    function onDuelEvent(event) {
        lastRoomEvent = { action: event.action, playerId: event.playerId };
        if (event.action === 'HIT' && event.targetId === duel.playerId) { clearTimeout(damageTimeout); document.body.dataset.damaged = 'true'; message(`TERKENA ${event.zone === 'HEAD' ? 'HEADSHOT' : 'HIT'} · −${event.damage} HP`); damageTimeout = setTimeout(() => { document.body.dataset.damaged = 'false'; }, 250); }
        if (event.playerId === duel.playerId && event.action === 'RELOAD_COMPLETE' && duel.room?.phase === 'LIVE' && !settings.open && document.visibilityState === 'visible') {
            audio.stopReload(); audio.play('reload-complete'); message('RELOAD SELESAI · 30 peluru');
        }
    }

    function message(text) { $('last-event').textContent = text; }
    function savePreferences() {
        storage.set('shooty.settings.v1', { volume: audio.volume, muted: audio.muted, showTouch: $('show-touch').checked });
    }
    function renderAudio() {
        $('volume-label').textContent = `${Math.round(audio.volume * 100)}%`;
        $('mute').textContent = audio.muted ? 'Unmute' : 'Mute';
        $('mute').setAttribute('aria-pressed', String(audio.muted));
        const loading = audio.shotStatus === 'loading' || audio.reloadStatus === 'loading';
        const failed = audio.shotStatus === 'error' || audio.reloadStatus === 'error';
        const ready = audio.state === 'running' && audio.shotStatus === 'ready' && audio.reloadStatus === 'ready';
        $('test-audio').disabled = loading; $('test-reload').disabled = loading;
        $('audio-badge').textContent = audio.muted || audio.volume === 0 ? 'SUARA DIMATIKAN' : failed ? 'CEK SUARA DI MENU' : loading ? 'MEMUAT SUARA…' : ready ? 'SUARA AKTIF' : 'AKTIFKAN SUARA DI MENU';
        $('audio-status').textContent = failed ? 'Rekaman gagal dimuat. Tap tombol tes untuk mencoba lagi.' : loading ? 'Menyiapkan rekaman tembakan & reload…' : ready ? (audio.muted ? 'Suara dimatikan. Tekan Unmute untuk mengaktifkan.' : 'Rekaman tembakan & reload siap. Cek volume media HP.') : 'Tap Tes tembakan atau Tes reload untuk mengaktifkan audio.';
    }
    function renderBindings() {
        $('binding-rows').replaceChildren();
        for (const action of Object.keys(labels)) {
            const row = document.createElement('div'); row.className = 'binding-row';
            const label = document.createElement('span'); label.textContent = labels[action];
            const code = document.createElement('span'); code.className = 'binding-code'; code.id = `binding-${action}`;
            code.textContent = bindings.map[action] ? `B${bindings.map[action]}` : 'Belum diatur';
            const assign = document.createElement('button'); assign.type = 'button'; assign.className = 'small-button'; assign.dataset.bind = action;
            assign.textContent = 'Atur'; assign.disabled = !connected;
            assign.setAttribute('aria-label', `Atur tombol ${labels[action]}`);
            assign.addEventListener('click', () => beginLearning(action));
            const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'small-button binding-clear'; clear.textContent = '×';
            clear.setAttribute('aria-label', `Hapus tombol ${labels[action]}`); clear.disabled = !bindings.map[action];
            clear.addEventListener('click', () => { cancelLearning(); bindings.clear(action); persistBindings(); renderBindings(); });
            row.append(label, code, assign, clear); $('binding-rows').append(row);
        }
        $('reload-hint').textContent = connected && bindings.map.reload ? `RELOAD · B${bindings.map.reload}` : 'RELOAD DI LAYAR';
    }
    function loadProfile(next) {
        cancelLearning(); profile = next;
        bindings = new ControlBindings(storage.get(`shooty.controls.v1:${profile}`));
        renderBindings();
    }
    function persistBindings() {
        const saved = storage.set(`shooty.controls.v1:${profile}`, bindings.serialize());
        $('binding-feedback').textContent = saved ? 'Mapping disimpan untuk controller ini.' : 'Mapping aktif di sesi ini. Penyimpanan browser tidak tersedia.';
    }
    function beginLearning(action) {
        if (!connected) return;
        cancelLearning();
        learning = { action, learner: new ButtonLearner() };
        if (decoder.trigger || decoder.buttons.size || bridgeTrigger || bridgeButtons.size) learning.learner.dirty = true;
        $('learning-panel').hidden = false;
        $('learning-title').textContent = `Atur ${labels[action]}`;
        $('learning-instruction').textContent = 'Lepaskan semua tombol, lalu tekan dan lepas SATU tombol pistol. Ulangi tombol yang sama untuk konfirmasi.';
        $('binding-feedback').textContent = 'Selama kalibrasi, tombol tidak menjalankan aksi latihan.';
        learningTimeout = setTimeout(() => { cancelLearning(); $('binding-feedback').textContent = 'Kalibrasi habis waktu. Tekan Atur untuk mencoba lagi.'; }, 30000);
    }
    function cancelLearning() { learning = null; clearTimeout(learningTimeout); $('learning-panel').hidden = true; }
    function learn(event, buttons, trigger) {
        const result = learning.learner.consume(event, buttons, trigger);
        const instruction = $('learning-instruction');
        if (result.status === 'trigger-reserved') instruction.textContent = 'Pelatuk khusus untuk menembak. Pilih tombol tambahan.';
        if (result.status === 'chord-rejected') instruction.textContent = 'Beberapa tombol terbaca bersamaan. Lepaskan, lalu tekan satu tombol saja.';
        if (result.status === 'release') instruction.textContent = `B${result.button} terbaca. Lepaskan tombolnya.`;
        if (result.status === 'confirm') instruction.textContent = `Tekan dan lepas B${result.button} sekali lagi untuk menyimpan.`;
        if (result.status === 'complete') {
            const action = learning.action;
            const assignment = bindings.assign(action, result.button);
            cancelLearning();
            if (!assignment.ok) {
                $('binding-feedback').textContent = `B${result.button} sudah dipakai untuk ${labels[assignment.conflict]}. Hapus mapping itu atau pilih tombol lain.`;
                return;
            }
            persistBindings(); renderBindings();
            message(`${labels[action]} terhubung ke B${result.button}.`);
        }
    }
    function setConnected(value) {
        connected = value; document.body.dataset.connected = String(value);
        $('status-indicator').classList.toggle('active', value || mode === 'touch');
        $('status-text').textContent = mode === 'touch' ? 'TOUCH SIAP' : value ? 'PISTOL TERHUBUNG' : 'PISTOL TERPUTUS';
        $('connect-gun').textContent = value && mode === 'bluetooth' ? 'Putuskan pistol' : 'Hubungkan pistol';
        if (!value) { game.cancelReload(); audio.stopReload(); document.body.dataset.aim = 'false'; cancelLearning(); }
        renderBindings(); renderGame();
        syncAvailability(); renderDuel();
    }
    function resetInputs() { decoder.reset(); bridgeButtons.clear(); bridgeTrigger = false; document.body.dataset.aim = 'false'; }
    function gunDisconnected(event) {
        if (event.target !== device) return;
        if (characteristic) characteristic.removeEventListener('characteristicvaluechanged', bluetoothInput);
        characteristic = null; resetInputs(); setConnected(false);
        $('bridge-status').textContent = 'Pistol terputus. Hubungkan lagi; reload yang berlangsung dibatalkan.';
        message('Pistol terputus. Kontrol layar tersedia.');
    }
    function releaseGun() {
        connectionVersion += 1;
        if (characteristic) characteristic.removeEventListener('characteristicvaluechanged', bluetoothInput);
        characteristic = null;
        if (device) { device.removeEventListener('gattserverdisconnected', gunDisconnected); if (device.gatt.connected) device.gatt.disconnect(); }
        device = null; resetInputs();
    }
    function selectMode(next) {
        cancelLearning();
        if (next !== 'bluetooth') releaseGun();
        clearTimeout(reconnectTimer);
        if (socket && next !== 'bridge') socket.close();
        mode = next; document.body.dataset.mode = next;
        $('mode-gun').setAttribute('aria-pressed', String(next !== 'touch'));
        $('mode-touch').setAttribute('aria-pressed', String(next === 'touch'));
        setConnected(next === 'bluetooth' && Boolean(device?.gatt.connected && characteristic));
        if (next === 'touch') {
            loadProfile('touch'); $('bridge-status').textContent = 'Input tombol layar siap.';
        } else if (next === 'bridge') connectBridge();
        else if (!connected) $('bridge-status').textContent = 'Tap Hubungkan pistol, lalu pilih ARGunGame.';
        $('setup-message').textContent = '';
    }
    async function connectGun() {
        if (connecting) return;
        if (mode === 'bluetooth' && connected) {
            releaseGun(); setConnected(false); $('bridge-status').textContent = 'Pistol diputuskan. Touch tetap tersedia.'; return;
        }
        if (!isSecureContext || !navigator.bluetooth) {
            $('setup-message').textContent = 'Gunakan Chrome Android melalui HTTPS atau localhost untuk Bluetooth langsung.'; return;
        }
        selectMode('bluetooth'); releaseGun(); connecting = true;
        const attempt = ++connectionVersion;
        $('mode-gun').disabled = true; $('mode-touch').disabled = true;
        $('connect-gun').disabled = true; $('connect-gun').textContent = 'Menghubungkan…';
        void audio.unlock();
        try {
            const selected = await navigator.bluetooth.requestDevice({ filters: [{ name: 'ARGunGame' }], optionalServices: ['0000fff0-0000-1000-8000-00805f9b34fb'] });
            if (attempt !== connectionVersion) return;
            device = selected;
            device.addEventListener('gattserverdisconnected', gunDisconnected);
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService('0000fff0-0000-1000-8000-00805f9b34fb');
            characteristic = await service.getCharacteristic('0000fff3-0000-1000-8000-00805f9b34fb');
            characteristic.addEventListener('characteristicvaluechanged', bluetoothInput);
            await characteristic.startNotifications();
            if (attempt !== connectionVersion || !device?.gatt.connected || !characteristic) throw new Error('Pistol terputus saat menghubungkan.');
            loadProfile(`bluetooth:${device.id}`); setConnected(true);
            $('bridge-status').textContent = 'ARGunGame terhubung langsung ke HP.';
            $('binding-feedback').textContent = 'Pilih Atur pada Reload, lalu tekan tombol pistol pilihan lu.';
            $('setup-message').textContent = 'Pistol siap. Cek suara dan atur reload sebelum latihan.';
        } catch (error) {
            releaseGun(); setConnected(false);
            $('bridge-status').textContent = error.name === 'NotFoundError' ? 'Pemilihan pistol dibatalkan.' : `Koneksi gagal: ${error.message}`;
        } finally {
            connecting = false; $('connect-gun').disabled = false;
            $('mode-gun').disabled = false; $('mode-touch').disabled = false;
        }
    }
    function routeInput(event, source) {
        if (!event) return;
        const buttons = source === 'bridge' ? bridgeButtons : decoder.buttons;
        const trigger = source === 'bridge' ? bridgeTrigger : decoder.trigger;
        if (learning) { learn(event, buttons, trigger); return; }
        if (settings.open || document.visibilityState !== 'visible') return;
        if (event.action === 'fire') { if (event.pressed) fire(source); return; }
        const action = bindings.actionFor(event.button);
        if (action === 'aim') { document.body.dataset.aim = String(event.pressed); return; }
        if (!event.pressed) return;
        if (action === 'reload') reload();
        if (action === 'mute') toggleMute();
    }
    function bluetoothInput(event) {
        if (mode !== 'bluetooth' || event.target !== characteristic) return;
        const value = event.target.value;
        routeInput(decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), 'bluetooth');
    }
    function connectBridge() {
        if (mode !== 'bridge') return;
        if (socket && socket.readyState <= 1) return;
        lastBridgeSequence = 0; resetInputs();
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8765`);
        socket.onmessage = ({ data }) => {
            if (mode !== 'bridge') return;
            let event; try { event = JSON.parse(data); } catch { return; }
            if (!event || typeof event !== 'object') return;
            if (event.event === 'SYSTEM_INFO' || event.event === 'GUN_CONNECTED') {
                const id = event.gun_mac || event.mac || 'local-bridge';
                loadProfile(`bridge:${id}`); setConnected(event.event === 'GUN_CONNECTED' || event.status === 'connected');
                $('bridge-status').textContent = connected ? 'Pistol tersambung melalui bridge laptop.' : 'Bridge sedang mencari pistol.';
            } else if (event.event === 'GUN_DISCONNECTED') { resetInputs(); setConnected(false); }
            else {
                if (!connected || !Number.isInteger(event.sequence) || event.sequence <= lastBridgeSequence) return;
                lastBridgeSequence = event.sequence;
                if (event.event === 'TRIGGER_FIRE') {
                    if (bridgeTrigger) return; bridgeTrigger = true; routeInput({ action: 'fire', pressed: true }, 'bridge');
                } else if (event.event === 'TRIGGER_RELEASE') {
                    bridgeTrigger = false; routeInput({ action: 'fire', pressed: false }, 'bridge');
                } else if (event.event === 'AUX_BUTTON' && /^[2-9A]$/.test(event.button) && typeof event.pressed === 'boolean') {
                    if (event.pressed === bridgeButtons.has(event.button)) return;
                    if (event.pressed) bridgeButtons.add(event.button); else bridgeButtons.delete(event.button);
                    routeInput({ button: event.button, pressed: event.pressed }, 'bridge');
                }
            }
        };
        socket.onclose = () => { if (mode === 'bridge') { resetInputs(); setConnected(false); reconnectTimer = setTimeout(connectBridge, 2000); } };
    }
    function flashShot() {
        clearTimeout(flashTimeout); clearTimeout(bannerTimeout);
        $('crosshair').classList.add('fire'); $('muzzle-flash').classList.add('fire'); $('hit-banner').textContent = 'TEMBAK';
        flashTimeout = setTimeout(() => { $('crosshair').classList.remove('fire'); $('muzzle-flash').classList.remove('fire'); }, 90);
        bannerTimeout = setTimeout(() => { $('hit-banner').textContent = ''; }, 180);
    }
    function fire(source = 'touch') {
        if (settings.open || document.visibilityState !== 'visible') return;
        if (duel.room) {
            const sequence = duel.sequence+1;
            if (duel.room.mode === 'VISION') vision.prepareShot(sequence);
            if (!duel.input('FIRE')) { vision.discardShot(sequence); message('Tunggu sampai kedua pemain siap dan countdown selesai.'); }
            return;
        }
        finishReload(performance.now());
        const result = game.fire(performance.now());
        if (result === 'shot') { audio.play('shot'); flashShot(); message(`TEMBAKAN ${source === 'touch' ? 'LAYAR' : 'PISTOL'} · ${game.ammo} tersisa`); }
        if (result === 'empty') { audio.play('empty'); message('MAGASIN HABIS · tekan reload'); }
        if (result === 'reloading') message('Tunggu, magasin sedang diisi.');
        renderGame();
    }
    function reload() {
        if (settings.open || document.visibilityState !== 'visible') return;
        if (duel.room) { duel.input('RELOAD'); return; }
        finishReload(performance.now());
        const result = game.reload(performance.now());
        if (result === 'reload-start') { audio.stopReload(); audio.play(result); document.body.dataset.aim = 'false'; message('RELOAD · 1,2 detik'); }
        if (result === 'full') message('Magasin masih penuh.');
        renderGame();
    }
    function finishReload(now) {
        if (duel.room) return;
        if (settings.open || document.visibilityState !== 'visible') return;
        if (game.update(now)) { audio.stopReload(); audio.play('reload-complete'); message('RELOAD SELESAI · 30 peluru'); renderGame(); }
    }
    function renderGame() {
        const view = gameView(), reloading = view.reloadAt !== null;
        document.body.dataset.reloading = String(reloading);
        $('ammo-count').textContent = view.ammo;
        $('ammo-state').textContent = reloading ? 'MENGISI' : view.ammo === 0 ? 'KOSONG' : 'SIAP';
        $('ammo-fill').style.width = `${view.ammo / view.capacity * 100}%`;
        $('reload-progress').hidden = !reloading;
        $('reload').disabled = !view.active || reloading || view.ammo === view.capacity;
        $('touch-fire').disabled = !view.active || reloading;
    }
    function animate(now) {
        finishReload(now);
        renderDuelClock();
        drawVision();
        const view = gameView();
        if (view.reloadAt !== null) {
            const progress = Math.max(0, Math.min(100, 100 * (1 - (view.reloadAt - (duel.room ? duel.now() : now)) / view.reloadMs)));
            $('reload-progress').firstElementChild.style.width = `${progress}%`;
            $('reload-progress').setAttribute('aria-valuenow', String(Math.round(progress)));
        }
        requestAnimationFrame(animate);
    }
    function toggleMute() { audio.setMuted(!audio.muted); savePreferences(); message(audio.muted ? 'Suara dimatikan.' : 'Suara diaktifkan.'); }
    async function startCamera() {
        if (cameraPending) return;
        const video = $('camera-feed');
        if (video.srcObject?.active) return;
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) { $('camera-status').textContent = 'Kamera membutuhkan HTTPS atau localhost.'; return; }
        cameraPending = true; $('start-camera').disabled = true;
        const requestVersion = ++cameraVersion;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
            if (requestVersion !== cameraVersion) { stream.getTracks().forEach(track => track.stop()); return; }
            video.srcObject = stream; await video.play(); document.body.dataset.camera = 'true';
            $('camera-status').textContent = 'Kamera aktif. Bidikan memakai gambar dari HP.';
            $('start-camera').textContent = 'Kamera aktif';
            stream.getVideoTracks()[0].addEventListener('ended', () => { vision.stop(); document.body.dataset.camera = 'false'; $('camera-status').textContent = 'Kamera terhenti. Aktifkan lagi.'; $('start-camera').textContent = 'Aktifkan kamera'; });
        } catch (error) { $('camera-status').textContent = `Kamera belum aktif: ${error.message}`; }
        finally { cameraPending = false; $('start-camera').disabled = false; renderVision(); }
    }
    function renderDisplay() {
        const landscape = innerWidth > innerHeight;
        $('display-status').textContent = displayPending ? 'Menyiapkan landscape…' : orientationLocked ? 'Landscape otomatis aktif.' : landscape ? 'Landscape siap.' : displayError || 'Gunakan landscape untuk ruang bidik yang lebih luas.';
        $('retry-landscape').hidden = landscape && (Boolean(document.fullscreenElement) || standalone);
        $('retry-landscape').disabled = displayPending;
    }
    function releaseOrientation() {
        displayVersion += 1;
        if (orientationLocked && screen.orientation?.unlock) { try { screen.orientation.unlock(); } catch {} }
        orientationLocked = false;
    }
    async function displayRequest(request) {
        let timer;
        try { return await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException('Display request timed out', 'TimeoutError')), 4000); })]); }
        finally { clearTimeout(timer); }
    }
    async function lockLandscape(attempt) {
        if (!screen.orientation?.lock) { displayError = 'Miringkan HP ke landscape.'; return false; }
        try {
            await displayRequest(screen.orientation.lock('landscape'));
            if (attempt !== displayVersion || !pageActive) { if (screen.orientation.unlock) screen.orientation.unlock(); return false; }
            orientationLocked = true; displayError = null; return true;
        } catch (error) { if (error.name === 'TimeoutError' && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch {} } displayError = 'Rotasi otomatis belum tersedia. Miringkan HP ke landscape.'; return false; }
    }
    async function requestFullscreen({ immersive = false } = {}) {
        if (displayPending) return false;
        const attempt = displayVersion;
        displayPending = true; displayError = null; renderDisplay();
        try {
            if ((immersive || !standalone) && !document.fullscreenElement) {
                if (!document.documentElement.requestFullscreen) { displayError = 'Miringkan HP ke landscape.'; return false; }
                await displayRequest(document.documentElement.requestFullscreen({ navigationUI: 'hide' }));
            }
            if (attempt !== displayVersion || !pageActive) return false;
            return orientationLocked || await lockLandscape(attempt);
        } catch { displayError = 'Tap Landscape untuk membuka layar penuh.'; return false; }
        finally { displayPending = false; renderDisplay(); }
    }
    function showPreparation() {
        started = true; document.body.dataset.started = 'true'; $('arena').inert = false;
        $('start-screen').hidden = true; if (!settings.open) settings.showModal(); renderDisplay();
    }
    async function startShooty() {
        if (launchPending || started) return;
        launchPending = true; $('start-shooty').disabled = true; $('start-status').textContent = 'Menyiapkan landscape…';
        // Both requests start in this tap; opening Bluetooth remains a separate tap.
        void audio.unlock();
        await requestFullscreen();
        if (pageActive) showPreparation();
        launchPending = false; $('start-shooty').disabled = false;
    }
    async function obtainWakeLock() {
        if ((!game.active && !duel.room) || document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock || wakePending) return;
        wakePending = true;
        try {
            const lock = await navigator.wakeLock.request('screen');
            if ((!game.active && !duel.room) || document.visibilityState !== 'visible') { await lock.release(); return; }
            wakeLock = lock; lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        } catch {} finally { wakePending = false; }
    }
    function openSettings() {
        if (duel.room) duel.ready(false);
        game.cancelReload(); document.body.dataset.aim = 'false'; audio.stop();
        $('session-status').textContent = 'PERSIAPAN';
        if (!settings.open) settings.showModal(); renderGame(); renderVision();
    }
    function enterArena() {
        if (connecting || cameraPending) { $('setup-message').textContent = 'Tunggu sampai perangkat selesai disiapkan.'; return; }
        if (mode !== 'touch' && !connected) { $('setup-message').textContent = 'Hubungkan pistol dulu, atau pilih mode Touch.'; return; }
        if (duel.room) {
            if (mode === 'bridge') { $('setup-message').textContent = 'Duel memakai Bluetooth langsung di HP atau Touch.'; return; }
            if (!duel.online || duel.room.phase === 'ENDED') { $('setup-message').textContent = 'Room belum siap. Cek koneksi atau buat room baru.'; return; }
            if (duel.room.mode === 'VISION' && (!duel.self?.faceEnrolled || !duel.opponent?.faceEnrolled || !vision.online || !$('camera-feed').srcObject?.active)) { $('setup-message').textContent = 'Selfie kedua pemain dan kamera belakang harus siap. Wajah lawan boleh dikenali setelah duel dimulai.'; return; }
            cancelLearning(); syncAvailability(); duel.ready(true); settings.close();
            document.body.dataset.active = 'true'; void audio.unlock(); void requestFullscreen({ immersive: true }); void obtainWakeLock();
            message('Menunggu kedua pemain siap.'); renderGame(); return;
        }
        cancelLearning(); settings.close(); game.start();
        document.body.dataset.active = 'true'; $('session-status').textContent = 'BIDIK & TEMBAK';
        void audio.unlock(); void requestFullscreen({ immersive: true }); void obtainWakeLock();
        message(connected && !bindings.map.reload ? 'Reload belum dipetakan · gunakan tombol layar.' : 'LATIHAN SIAP · bidik dan tarik pelatuk.');
        renderGame();
    }
    $('mode-gun').addEventListener('click', () => selectMode('bluetooth'));
    async function roomCommand(type) {
        roomNotice = ''; $('setup-message').textContent = '';
        const name = $('player-name').value.trim(); storage.set('shooty.playerName.v1', name);
        syncAvailability();
        await duel.command(type, { name, ...(type === 'JOIN_ROOM' ? { code: $('room-code-input').value.trim().toUpperCase() } : { mode: $('duel-rules').value,funding:$('room-payment').value }) });
    }
    $('create-room').addEventListener('click', () => { void roomCommand('CREATE_ROOM'); });
    $('room-payment').addEventListener('change',()=>{paymentChoice=true;walletNotice='';renderWallet();});
    $('connect-wallet').addEventListener('click',()=>{walletNotice='';void wallet.connect(Number($('wallet-provider').value));});
    $('deposit-entry').addEventListener('click',()=>{walletNotice='';void wallet.deposit(duel.room?.funding);});
    $('claim-credit').addEventListener('click',()=>void wallet.claim(duel.room?.funding));
    $('expire-match').addEventListener('click',()=>void wallet.claim(duel.room?.funding,true));
    $('recover-payments').addEventListener('click',()=>void wallet.recover());
    $('join-room').addEventListener('click', () => { void roomCommand('JOIN_ROOM'); });
    $('reconnect-duel').addEventListener('click', () => { roomNotice = ''; duel.retry(); });
    $('leave-room').addEventListener('click', () => { roomNotice = ''; void duel.command('LEAVE_ROOM'); });
    $('copy-room').addEventListener('click', async () => {
        if (!duel.room) return;
        const link = new URL(location.href); link.searchParams.set('room', duel.room.code); link.searchParams.set('input', 'touch');
        try { await navigator.clipboard.writeText(link.href); roomNotice = 'Undangan disalin. Buka di HP lawan yang tersambung ke server ini.'; }
        catch { roomNotice = `Bagikan kode ${duel.room.code} ke lawan.`; }
        renderDuel();
    });
    $('start-shooty').addEventListener('click', startShooty);
    $('retry-landscape').addEventListener('click', () => { void requestFullscreen({ immersive: true }); });
    $('mode-touch').addEventListener('click', () => selectMode('touch'));
    $('connect-gun').addEventListener('click', connectGun);
    $('start-camera').addEventListener('click', startCamera);
    $('start-vision').addEventListener('click', () => { void beginDetection(); });
    $('open-selfie').addEventListener('click', () => { void openSelfie(); });
    $('take-selfie').addEventListener('click', () => { void vision.enroll($('selfie-feed')); });
    $('cancel-selfie').addEventListener('click', () => { void closeSelfie(); });
    $('selfie-dialog').addEventListener('cancel', event => { event.preventDefault(); if (!vision.enrollmentPending) void closeSelfie(); });
    $('test-audio').addEventListener('click', async () => {
        if (audio.muted) { audio.setMuted(false); savePreferences(); }
        if (await audio.unlock()) { audio.stop(); audio.play('shot'); audio.play('empty', .4); }
    });
    $('test-reload').addEventListener('click', async () => {
        if (audio.muted) { audio.setMuted(false); savePreferences(); }
        if (await audio.unlock()) { audio.stop(); audio.play('reload-start'); audio.play('reload-complete', game.reloadMs / 1000); }
    });
    $('mute').addEventListener('click', toggleMute);
    $('volume').addEventListener('input', event => { audio.setVolume(Number(event.target.value) / 100); savePreferences(); renderAudio(); });
    $('show-touch').addEventListener('change', () => { document.body.dataset.showTouch = String($('show-touch').checked); savePreferences(); });
    $('cancel-learning').addEventListener('click', cancelLearning);
    $('touch-fire').addEventListener('click', () => { void audio.unlock(); fire('touch'); });
    $('reload').addEventListener('click', reload);
    $('open-settings').addEventListener('click', openSettings);
    $('close-settings').addEventListener('click', () => {
        if (duel.room) { $('setup-message').textContent = 'Tekan Siap Duel untuk kembali, atau Keluar room.'; return; }
        if (!game.active) { $('setup-message').textContent = 'Pilih input, lalu tekan Masuk Latihan.'; return; }
        cancelLearning(); settings.close(); $('session-status').textContent = 'BIDIK & TEMBAK';
    });
    $('enter-arena').addEventListener('click', enterArena);
    settings.addEventListener('cancel', event => { if (duel.room || !game.active) event.preventDefault(); else { cancelLearning(); $('session-status').textContent = 'BIDIK & TEMBAK'; } });
    $('settings-form').addEventListener('submit', event => event.preventDefault());
    $('fullscreen').addEventListener('click', () => {
        if (document.fullscreenElement) { releaseOrientation(); void document.exitFullscreen(); }
        else void requestFullscreen({ immersive: true });
    });
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && !standalone) releaseOrientation();
        $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Keluar fullscreen' : 'Masuk fullscreen');
        renderDisplay();
    });
    window.addEventListener('resize', renderDisplay);
    document.addEventListener('visibilitychange', () => {
        syncAvailability();
        if (document.visibilityState === 'hidden') { game.cancelReload(); document.body.dataset.aim = 'false'; audio.stop(); }
        else { renderAudio(); if (duel.room && !duel.online) duel.retry(); if ((game.active || duel.room) && !settings.open) void obtainWakeLock(); }
    });
    window.addEventListener('online', () => { if (duel.room && !duel.online) duel.retry(); });
    window.addEventListener('pagehide', () => {
        pageActive = false;
        selfieVersion += 1; if (selfieStream) selfieStream.getTracks().forEach(track => track.stop()); selfieStream = null; $('selfie-feed').srcObject = null;
        vision.stop();
        duel.close();
        cameraVersion += 1;
        game.stop(); cancelLearning(); releaseGun(); setConnected(false); audio.stop();
        clearTimeout(reconnectTimer); if (socket) { socket.onclose = null; socket.close(); }
        const video = $('camera-feed'); if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop()); video.srcObject = null;
        document.body.dataset.camera = 'false';
        if (wakeLock) void wakeLock.release();
        releaseOrientation();
    });
    window.addEventListener('pageshow', event => {
        pageActive = true;
        syncAvailability();
        if (event.persisted) {
            duel.resume();
            document.body.dataset.active = 'false';
            if (standalone) { showPreparation(); void requestFullscreen(); }
            else { started = false; document.body.dataset.started = 'false'; if (settings.open) settings.close(); $('arena').inert = true; $('start-screen').hidden = false; $('start-status').textContent = 'Tap Mulai untuk membuka layar penuh.'; }
            if (mode === 'bridge') connectBridge();
        }
    });

    selectMode(mode); document.body.dataset.showTouch = String($('show-touch').checked);
    renderAudio(); renderGame(); renderDisplay(); renderDuel(); renderVision(); renderWallet(); duel.resume(); requestAnimationFrame(animate);
    if (standalone) { showPreparation(); void requestFullscreen(); }
    // Read-only snapshot used by local QA and device inspection.
    window.ShootyTraining = Object.freeze({ snapshot: () => ({
        version: 7, started, mode, connected, profile, ammo: gameView().ammo, shots: gameView().shots, reloading: gameView().reloadAt !== null,
        wallet:{address:wallet.account,authenticated:wallet.authenticated,pending:wallet.pending,balance:wallet.balance,chain:duel.chainConfig,recovery:wallet.recovery},
        selfie: { open: $('selfie-dialog').open, cameraActive: Boolean(selfieStream?.active), pending: vision.enrollmentPending, enrolled: duel.self?.faceEnrolled === true, opponentEnrolled: duel.opponent?.faceEnrolled === true },
        vision: { online: vision.online, status: vision.status, locked: vision.locked, targetVisible: vision.visible, targetId: vision.targetId, candidates: vision.frame?.candidates || [], inferenceMs: vision.frame?.inferenceMs || null },
        reloadAt: gameView().reloadAt, active: gameView().active, settingsOpen: settings.open,
        duel: { online: duel.online, status: duel.status, playerId: duel.playerId, room: duel.room ? JSON.parse(JSON.stringify(duel.room)) : null, lastEvent: lastRoomEvent, roundTripMs: Number.isFinite(duel.bestRtt) ? duel.bestRtt : null, serverNow: duel.now() },
        bindings: { ...bindings.map }, learningAction: learning?.action || null,
        audio: { state: audio.state, muted: audio.muted, volume: audio.volume, playCounts: { ...audio.playCounts }, shotStatus: audio.shotStatus, shotSource: audio.shotStatus === 'ready' ? 'recorded-1911' : null, shotDuration: audio.shotDuration, shotError: audio.shotError, reloadStatus: audio.reloadStatus, reloadSource: audio.reloadStatus === 'ready' ? 'recorded-airsoft-mechanics' : null, reloadDurations: audio.reloadDurations, reloadError: audio.reloadError, activeReloadVoices: audio.reloadVoices.size },
        camera: { active: Boolean($('camera-feed').srcObject?.active), width: $('camera-feed').videoWidth, height: $('camera-feed').videoHeight },
        fullscreen: Boolean(document.fullscreenElement), display: { standalone, pending: displayPending, orientationLocked, orientationType: screen.orientation?.type || null, error: displayError }, viewport: { width: innerWidth, height: innerHeight }
    }) });
})();
