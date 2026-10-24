const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { InputDecoder, TrainingSession, ControlBindings, ButtonLearner } = require('../web/game-core.js');
const { soundData, DURATIONS } = require('../web/audio.js');

test('real trigger capture decodes twelve shots and twelve releases without auxiliary actions', () => {
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/controller/gun-probe-20261024T041902528662Z.json')));
    const decoder = new InputDecoder();
    const events = report.notifications.map(packet => decoder.decode(Uint8Array.from(Buffer.from(packet.hex, 'hex')))).filter(Boolean);
    assert.equal(events.filter(event => event.action === 'fire' && event.pressed).length, 12);
    assert.equal(events.filter(event => event.action === 'fire' && !event.pressed).length, 12);
    assert.equal(events.filter(event => event.button).length, 0);
});

test('all captured auxiliary edges remain separate and unknown input cannot fire', () => {
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/controller/gun-probe-20261024T041708282838Z.json')));
    const decoder = new InputDecoder(); const ids = new Set();
    for (const packet of report.notifications) {
        const data = Buffer.from(packet.hex, 'hex'); const event = decoder.decode(data);
        if (data.toString().startsWith('B') && event) { assert.equal(event.action, undefined); ids.add(event.button); }
    }
    assert.deepEqual([...ids].sort(), [...'23456789A']);
    for (const text of ['B1DOWN', 'ARGun KeyPressed\0', 'unknown']) assert.equal(decoder.decode(Buffer.from(text)), null);
});

test('press deduplication resets on disconnect without repeating a held trigger', () => {
    const decoder = new InputDecoder(); const press = Buffer.from('ARGun KeyPressed');
    assert.equal(decoder.decode(press).pressed, true); assert.equal(decoder.decode(press), null);
    decoder.decode(Buffer.from('B7DOWN')); decoder.decode(Buffer.from('B7UP'));
    assert.equal(decoder.decode(press), null);
    decoder.reset(); assert.equal(decoder.decode(press).pressed, true);
});

test('reload blocks shots, ignores spam, fills once at its deadline, and full magazine is a no-op', () => {
    const game = new TrainingSession();
    assert.equal(game.fire(0), 'inactive'); game.start();
    assert.equal(game.reload(0), 'full'); assert.equal(game.fire(0), 'shot');
    assert.equal(game.fire(199), 'cooldown');
    assert.equal(game.reload(200), 'reload-start'); const deadline = game.reloadAt;
    assert.equal(game.fire(500), 'reloading'); assert.equal(game.reload(700), 'reloading');
    assert.equal(game.reloadAt, deadline); assert.equal(game.ammo, 29);
    assert.equal(game.update(1399), null); assert.equal(game.update(1400), 'reload-complete');
    assert.equal(game.ammo, 30); assert.equal(game.update(1500), null);
});

test('empty magazine stays empty and a canceled reload cannot refill another session', () => {
    const game = new TrainingSession({ capacity: 1 }); game.start();
    assert.equal(game.fire(0), 'shot'); assert.equal(game.fire(300), 'empty'); assert.equal(game.ammo, 0);
    game.reload(400); game.stop(); game.start();
    assert.equal(game.update(10000), null); assert.equal(game.ammo, 0);
});

test('bindings persist cleanly and reject duplicate actions, trigger and invalid stored IDs', () => {
    const bindings = new ControlBindings(); assert.equal(bindings.assign('reload', '7').ok, true);
    assert.deepEqual(bindings.assign('mute', '7'), { ok: false, reason: 'conflict', conflict: 'reload' });
    assert.equal(bindings.assign('reload', 'trigger').ok, false);
    const restored = new ControlBindings(JSON.parse(JSON.stringify(bindings.serialize())));
    assert.equal(restored.actionFor('7'), 'reload');
    const corrupt = new ControlBindings({ version: 1, bindings: { reload: '2', aim: '2', mute: 'Z' } });
    assert.deepEqual(corrupt.map, { reload: '2', aim: null, mute: null });
});

test('calibration requires two clean cycles and rejects chords and trigger presses', () => {
    const decoder = new InputDecoder(); const learner = new ButtonLearner();
    const feed = text => { const event = decoder.decode(Buffer.from(text)); return learner.consume(event, decoder.buttons, decoder.trigger); };
    feed('B7DOWN'); feed('B8DOWN'); feed('B7UP'); assert.equal(feed('B8UP').status, 'chord-rejected');
    assert.equal(feed('ARGun KeyPressed').status, 'trigger-reserved');
    learner.consume(decoder.decode(Buffer.alloc(16)), decoder.buttons, decoder.trigger);
    feed('B7DOWN'); assert.equal(feed('B7UP').status, 'confirm');
    feed('B7DOWN'); assert.deepEqual(feed('B7UP'), { status: 'complete', button: '7' });
});

test('empty and hit cues contain finite bounded nonzero audio', () => {
    for (const name of Object.keys(DURATIONS)) {
        const data = soundData(name, 48000);
        assert.equal(data.length, Math.ceil(DURATIONS[name] * 48000));
        let energy = 0;
        for (const sample of data) { assert.ok(Number.isFinite(sample) && Math.abs(sample) <= .91); energy += sample * sample; }
        assert.ok(energy / data.length > 0.00001); assert.ok(data[0] === 0 && data.at(-1) === 0);
    }
    assert.deepEqual(Object.keys(DURATIONS), ['empty','body-hit','head-hit']);
});
