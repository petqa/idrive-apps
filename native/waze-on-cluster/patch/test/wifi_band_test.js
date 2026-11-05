#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* wifi_band.js with fake /proc files and a fake wpa_supplicant over busctl:
 * /proc/net/dev's p2p rows (Broadcom's p2p-wlan0-N, NXP's p2p-wfd0-N);
 * CarPlay's session from /proc/net/tcp and tcp6; the phone's interface by
 * the bytes it receives; the band from the group's frequency, never from
 * the interface's name or order; a band kept through a still screen, not
 * once the phone sends nothing; unknown when the frequency cannot be read
 * or is in no band, with no CarPlay and with CarPlay over USB; the state
 * file; a log line when the band is first known and when it changes, and
 * none while nothing is known. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var w = require('../wifi_band.js');

var HDR = 'Inter-|   Receive                                                |  Transmit\n' +
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
function dev(rows) {
    return HDR + Object.keys(rows).map(function (n) {
        return '  ' + n + ': ' + rows[n][0] + ' 10 0 0 0 0 0 0 ' + rows[n][1] + ' 10 0 0 0 0 0 0';
    }).join('\n') + '\n';
}
var TCP6_HDR = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
var PHONE6 = '000080FE00000000A1B2C3D4E5F60718';
function row6(local, remote, st, uid) {
    return '   0: ' + local + ' ' + remote + ' ' + st + ' 00000000:00000000 00:00000000 00000000 ' + uid + '        0 1234 1 0000000000000000 20 4 30 10 -1\n';
}
var HU6 = '000080FE000000001122334455667788';

/* ---- parsing ---- */
var d = w.parseNetDev(dev({ 'wlan0': [1, 2], 'p2p-wlan0-0': [100, 200], 'p2p-wlan0-1': [300, 400], wlan_bridge: [5, 6] }) +
    'p2p-wfd0-0:4294967296 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n');
assert.deepStrictEqual(d, { 'p2p-wlan0-0': { rx: 100, tx: 200 }, 'p2p-wlan0-1': { rx: 300, tx: 400 }, 'p2p-wfd0-0': { rx: 4294967296, tx: 7 } });
assert.deepStrictEqual(w.parseNetDev(''), {});
assert.deepStrictEqual(w.parseNetDev(null), {});
console.log('ok   /proc/net/dev: the p2p interfaces only, Broadcom\'s and NXP\'s names, a name joined to its count');

var T6 = TCP6_HDR;
assert(w.sessionIn(T6 + row6(HU6 + ':178E', PHONE6 + ':C001', '01', 13002), 13002), 'carplay to the phone');
assert(!w.sessionIn(T6 + row6(HU6 + ':178E', PHONE6 + ':C001', '0A', 13002), 13002), 'listening is no session');
assert(!w.sessionIn(T6 + row6(HU6 + ':178E', PHONE6 + ':C001', '01', 5000), 13002), 'another uid');
assert(!w.sessionIn(T6 + row6('00000000000000000000000001000000:1F90', '00000000000000000000000001000000:9C40', '01', 13002), 13002), '::1');
assert(!w.sessionIn(T6 + row6('0000000000000000FFFF00000100007F:1F90', '0000000000000000FFFF00000100007F:9C40', '01', 13002), 13002),
    'v4-mapped loopback');
var T4 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
assert(!w.sessionIn(T4 + '   0: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000 13002 0 1 1\n', 13002), '127.0.0.1');
assert(w.sessionIn(T4 + '   0: 61DE10AC:1B58 62DE10AC:C001 01 00000000:00000000 00:00000000 00000000 13002 0 1 1\n', 13002), 'IPv4 phone');
assert(!w.sessionIn('', 13002) && !w.sessionIn(null, 13002));
console.log('ok   CarPlay\'s session: an established connection of carplay\'s uid to another device, not to the head unit itself');

var a = { 'p2p-wlan0-0': { rx: 0, tx: 0 }, 'p2p-wlan0-1': { rx: 0, tx: 0 } };
var p = w.pick(a, { 'p2p-wlan0-0': { rx: 2000, tx: 9000 }, 'p2p-wlan0-1': { rx: 6000000, tx: 100000 } }, 5000);
assert.strictEqual(p.iface, 'p2p-wlan0-1');
assert.strictEqual(p.rate, (6000000 + 100000) / 5);
assert.strictEqual(p.rates['p2p-wlan0-0'].tx, 1800, 'the bridge\'s broadcasts out of the idle group count as sent, not received');
assert.strictEqual(w.pick(a, { 'p2p-wlan0-0': { rx: 4000, tx: 0 }, 'p2p-wlan0-1': { rx: 4000, tx: 0 } }, 5000).reason,
    'no CarPlay traffic over Wi-Fi');
assert.strictEqual(w.pick(a, { 'p2p-wlan0-0': { rx: 300000, tx: 0 }, 'p2p-wlan0-1': { rx: 100000, tx: 0 } }, 5000).reason,
    'CarPlay traffic on more than one Wi-Fi interface');
assert.strictEqual(w.pick({ 'p2p-wlan0-0': { rx: 9e9, tx: 0 } }, { 'p2p-wlan0-0': { rx: 1e6, tx: 0 } }, 5000).reason,
    'no Wi-Fi CarPlay interface', 'counters that went back');
assert.strictEqual(w.pick({}, { 'p2p-wlan0-0': { rx: 1e6, tx: 0 } }, 5000).reason, 'no Wi-Fi CarPlay interface', 'an interface new since');
assert.strictEqual(w.pick({}, {}, 5000).reason, 'no Wi-Fi CarPlay interface');
console.log('ok   the phone\'s interface: the one receiving the most, at least 1 KiB/s and 4 times any other');

assert.deepStrictEqual([2412, 2462, 2484, 5180, 5785, 5885, 0, 2300, 5955, 60480].map(w.band),
    ['2.4', '2.4', '2.4', '5', '5', '5', null, null, null, null]);
assert.strictEqual(w.parseValue('q 5785\n'), 5785);
assert.strictEqual(w.parseValue('s "p2p-wlan0-0"'), 'p2p-wlan0-0');
assert.strictEqual(w.parseValue('o "/fi/w1/wpa_supplicant1/Interfaces/3/Groups/4449"'), '/fi/w1/wpa_supplicant1/Interfaces/3/Groups/4449');
assert.deepStrictEqual(w.parseValue('ao 2 "/a" "/b"'), ['/a', '/b']);
assert.deepStrictEqual(w.parseValue('ao 0'), []);
assert.strictEqual(w.parseValue('ao 3 "/a" "/b"'), null);
assert.strictEqual(w.parseValue(''), null);
assert.strictEqual(w.parseValue('q'), null);
assert.strictEqual(w.parseValue('ay 2 1 2'), null);
console.log('ok   the band of a frequency (2.4 GHz, 5 GHz, else none); busctl\'s values');

/* ---- wpa_supplicant over busctl ---- */
var ROOT = '/fi/w1/wpa_supplicant1';
/* ifaces: { name: { group: path or '/', freq } } as wpa_supplicant's objects */
function supplicant(ifaces, opts) {
    var o = opts || {}, calls = [], objs = {}, i = 0;
    Object.keys(ifaces).forEach(function (n) { objs[ROOT + '/Interfaces/' + (i++)] = n; });
    function run(args, cb) {
        calls.push(args.slice(2).join(' '));
        var obj = args[2], intf = args[3], prop = args[4];
        if (o.fail) { setImmediate(cb, new Error('Failed to get property: The name is not activatable')); return; }
        var out = null;
        if (obj === ROOT && prop === 'Interfaces') out = 'ao ' + Object.keys(objs).length + Object.keys(objs).map(function (k) { return ' "' + k + '"'; }).join('');
        else if (objs[obj] && intf === 'fi.w1.wpa_supplicant1.Interface' && prop === 'Ifname') out = 's "' + objs[obj] + '"';
        else if (objs[obj] && prop === 'Group') out = 'o "' + ifaces[objs[obj]].group + '"';
        else if (prop === 'Frequency') {
            var n = Object.keys(ifaces).filter(function (k) { return ifaces[k].group === obj; })[0];
            if (n) out = 'q ' + ifaces[n].freq;
        }
        if (out === null) setImmediate(cb, new Error('Unknown object'));
        else setImmediate(cb, null, out + '\n');
    }
    run.calls = calls;
    return run;
}

var BRCM = { wlan0: { group: '/', freq: 0 }, 'p2p-dev-wlan0': { group: '/', freq: 0 },
    'p2p-wlan0-0': { group: ROOT + '/Interfaces/2/Groups/4449524543542d6161', freq: 5785 },
    'p2p-wlan0-1': { group: ROOT + '/Interfaces/3/Groups/4449524543542d6262', freq: 2462 } };

function freq(iface, run) {
    return new Promise(function (resolve) { w.readFreq(iface, run, function (err, mhz) { resolve(err ? err.message : mhz); }); });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* A sampler over fake files: files[path] = text. */
function sampler(files, run, extra) {
    var t = { now: 1000000, logs: [], changes: 0 };
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-wifi-'));
    t.file = path.join(dir, 'wifi-band.json');
    t.s = new w.Sampler(Object.assign({
        log: function (l) { t.logs.push(l); }, onChange: function () { t.changes++; }, file: t.file, busctl: run,
        readFile: function (f) { return files[f] === undefined ? null : files[f]; },
        netDev: '/proc/net/dev', tables: ['/proc/net/tcp', '/proc/net/tcp6'], uid: 13002,
        pollMs: 15000, windowMs: 1, resampleMs: 120000, now: function () { return t.now; }
    }, extra || {}));
    t.state = function () { return JSON.parse(fs.readFileSync(t.file, 'utf8')); };
    return t;
}

/* The phone on iface, receiving rx bytes/s, after secs seconds. */
function traffic(files, ifaces, onIface, rx, secs) {
    var rows = {};
    ifaces.forEach(function (n) { rows[n] = [n === onIface ? rx * secs : 10 * secs, 600 * secs]; });
    files['/proc/net/dev'] = dev(rows);
}
var CARPLAY = TCP6_HDR + row6(HU6 + ':178E', PHONE6 + ':C001', '01', 13002);

async function main() {
    assert.strictEqual(await freq('p2p-wlan0-1', supplicant(BRCM)), 2462);
    assert.strictEqual(await freq('p2p-wlan0-0', supplicant(BRCM)), 5785);
    assert(/no interface p2p-wlan0-9/.test(await freq('p2p-wlan0-9', supplicant(BRCM))));
    assert(/has no P2P group/.test(await freq('p2p-wlan0-0', supplicant({ 'p2p-wlan0-0': { group: '/', freq: 0 } }))));
    assert(/Interfaces of .* unreadable: Failed to get property/.test(await freq('p2p-wlan0-0', supplicant(BRCM, { fail: true }))));
    var calls = supplicant(BRCM);
    await freq('p2p-wlan0-1', calls);
    assert.deepStrictEqual(calls.calls, ['/fi/w1/wpa_supplicant1 fi.w1.wpa_supplicant1 Interfaces',
        '/fi/w1/wpa_supplicant1/Interfaces/0 fi.w1.wpa_supplicant1.Interface Ifname',
        '/fi/w1/wpa_supplicant1/Interfaces/1 fi.w1.wpa_supplicant1.Interface Ifname',
        '/fi/w1/wpa_supplicant1/Interfaces/2 fi.w1.wpa_supplicant1.Interface Ifname',
        '/fi/w1/wpa_supplicant1/Interfaces/3 fi.w1.wpa_supplicant1.Interface Ifname',
        '/fi/w1/wpa_supplicant1/Interfaces/3 fi.w1.wpa_supplicant1.Interface.P2PDevice Group',
        '/fi/w1/wpa_supplicant1/Interfaces/3/Groups/4449524543542d6262 fi.w1.wpa_supplicant1.Group Frequency']);
    console.log('ok   the frequency: the interface by Ifname, its P2PDevice Group, the group\'s Frequency; an error for each missing step');

    /* No CarPlay: nothing read but /proc, nothing logged. */
    var files = {}, run = supplicant(BRCM), t = sampler(files, run);
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 0, 1);
    t.s.start();
    t.s.stop();
    t.s.tick();
    await sleep(10);
    assert.strictEqual(t.s.current(), null);
    assert.deepStrictEqual([t.logs, run.calls, t.changes], [[], [], 0]);
    assert.deepStrictEqual(t.state(), { at: t.state().at, carplay: false, band: null, iface: null, freq: null, rate: null,
        reason: 'no CarPlay session', rates: {} });
    console.log('ok   no CarPlay: band unknown, no D-Bus call, nothing logged, the state file says why');

    /* Wireless CarPlay on 2.4 GHz (Broadcom). */
    files = { '/proc/net/tcp6': CARPLAY };
    run = supplicant(BRCM);
    t = sampler(files, run);
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 1200 * 1024, 5);
    await sleep(20);
    assert.deepStrictEqual(t.s.current(), { band: '2.4', iface: 'p2p-wlan0-1', freq: 2462 });
    assert.deepStrictEqual(t.logs, ['CarPlay Wi-Fi: 2.4 GHz (p2p-wlan0-1, 2462 MHz, 1201 KB/s)']);
    assert.strictEqual(t.changes, 1);
    var st = t.state();
    assert.deepStrictEqual([st.carplay, st.band, st.iface, st.freq, st.rate, st.reason], [true, '2.4', 'p2p-wlan0-1', 2462, 1200 * 1024 + 600, null]);
    assert.deepStrictEqual(st.rates['p2p-wlan0-0'], { rx: 10, tx: 600 });
    console.log('ok   wireless CarPlay on 2.4 GHz: the interface, its frequency and byte rate logged once, onChange once, the state file');

    /* Polls before the resample: nothing; the resample, same band: nothing more. */
    var n = run.calls.length;
    t.now += 15000;
    t.s.tick();
    assert.strictEqual(run.calls.length, n, 'no D-Bus call between samples');
    t.now += 120000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 900 * 1024, 140);
    t.s.tick();
    await sleep(10);
    assert(run.calls.length > n, 'resampled after RESAMPLE_MS');
    assert.deepStrictEqual([t.logs.length, t.changes], [1, 1]);

    /* A resample with too little traffic to pick an interface (a still
     * screen) keeps the band while its interface still receives the most. */
    t.now += 120000;
    files['/proc/net/dev'] = dev({ 'p2p-wlan0-0': [10 * 260, 600 * 260], 'p2p-wlan0-1': [900 * 1024 * 140 + 200 * 120, 600 * 260] });
    t.s.tick();
    await sleep(10);
    assert.deepStrictEqual(t.s.current(), { band: '2.4', iface: 'p2p-wlan0-1', freq: 2462 });
    assert.deepStrictEqual([t.s.reason, t.logs.length, t.changes], [null, 1, 1]);
    console.log('ok   resampled every 2 minutes; the same band logs nothing more; a still screen keeps the band known');

    /* The phone moves to the 5 GHz group. */
    t.now += 120000;
    files['/proc/net/dev'] = dev({ 'p2p-wlan0-0': [9e8, 9e7], 'p2p-wlan0-1': [900 * 1024 * 140, 600 * 140] });
    t.s.tick();
    await sleep(10);
    assert.deepStrictEqual(t.s.current(), { band: '5', iface: 'p2p-wlan0-0', freq: 5785 });
    assert.strictEqual(t.logs[1].indexOf('CarPlay Wi-Fi: 5 GHz (p2p-wlan0-0, 5785 MHz, '), 0, t.logs[1]);
    assert.strictEqual(t.changes, 2);

    /* The phone gone from Wi-Fi while carplay holds a connection: unknown. */
    t.now += 120000;
    t.s.tick();
    await sleep(10);
    assert.strictEqual(t.s.current(), null);
    assert.deepStrictEqual([t.logs[2], t.changes], ['CarPlay Wi-Fi: unknown (no CarPlay traffic over Wi-Fi)', 3]);
    files['/proc/net/dev'] = dev({ 'p2p-wlan0-0': [9e8 + 9e7, 9e7], 'p2p-wlan0-1': [900 * 1024 * 140, 600 * 140] });
    t.now += 120000;
    t.s.tick();
    await sleep(10);
    assert.deepStrictEqual(t.s.current(), { band: '5', iface: 'p2p-wlan0-0', freq: 5785 });

    /* CarPlay ends. */
    files['/proc/net/tcp6'] = TCP6_HDR;
    t.s.tick();
    assert.strictEqual(t.s.current(), null);
    assert.deepStrictEqual([t.logs[4], t.changes, t.state().reason, t.state().carplay], ['CarPlay Wi-Fi: unknown (no CarPlay session)', 5,
        'no CarPlay session', false]);
    console.log('ok   a move to the other group logged as a change; no traffic from the phone, or the end of CarPlay, logged, the band unknown');

    /* CarPlay over USB: a session, no p2p traffic. */
    files = { '/proc/net/tcp6': CARPLAY };
    run = supplicant(BRCM);
    t = sampler(files, run);
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], null, 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], null, 0, 5);
    await sleep(10);
    assert.deepStrictEqual([t.s.current(), t.logs, run.calls, t.changes, t.state().reason],
        [null, [], [], 0, 'no CarPlay traffic over Wi-Fi']);
    console.log('ok   CarPlay over USB: band unknown, no D-Bus call, nothing logged');

    /* NXP's names, 5 GHz. */
    var NXP = { mlan0: { group: '/', freq: 0 }, wfd0: { group: '/', freq: 0 },
        'p2p-wfd0-0': { group: ROOT + '/Interfaces/2/Groups/aa', freq: 2437 },
        'p2p-wfd0-1': { group: ROOT + '/Interfaces/3/Groups/bb', freq: 5180 } };
    files = { '/proc/net/tcp': T4 + '   0: 61DE10AC:1B58 62DE10AC:C001 01 00000000:00000000 00:00000000 00000000 13002 0 1 1\n' };
    run = supplicant(NXP);
    t = sampler(files, run);
    traffic(files, ['p2p-wfd0-0', 'p2p-wfd0-1'], 'p2p-wfd0-1', 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wfd0-0', 'p2p-wfd0-1'], 'p2p-wfd0-1', 300 * 1024, 5);
    await sleep(10);
    assert.deepStrictEqual(t.s.current(), { band: '5', iface: 'p2p-wfd0-1', freq: 5180 });
    assert.deepStrictEqual(t.logs, ['CarPlay Wi-Fi: 5 GHz (p2p-wfd0-1, 5180 MHz, 301 KB/s)']);
    console.log('ok   NXP\'s p2p-wfd0-N: the band from its group\'s frequency');

    /* The first interface on 2.4 GHz: the band follows the frequency, not the order. */
    var SWAPPED = { 'p2p-wlan0-0': { group: ROOT + '/Interfaces/0/Groups/aa', freq: 2412 },
        'p2p-wlan0-1': { group: ROOT + '/Interfaces/1/Groups/bb', freq: 5745 } };
    files = { '/proc/net/tcp6': CARPLAY };
    t = sampler(files, supplicant(SWAPPED));
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-0', 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-0', 500 * 1024, 5);
    await sleep(10);
    assert.deepStrictEqual(t.s.current(), { band: '2.4', iface: 'p2p-wlan0-0', freq: 2412 });
    console.log('ok   p2p-wlan0-0 on 2.4 GHz: the band from the frequency, never the interface\'s order');

    /* The frequency unreadable: unknown, logged once. */
    files = { '/proc/net/tcp6': CARPLAY };
    t = sampler(files, supplicant(BRCM, { fail: true }));
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 500 * 1024, 5);
    await sleep(10);
    t.now += 120000;
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 500 * 1024, 125);
    t.s.tick();
    await sleep(10);
    assert.strictEqual(t.s.current(), null);
    assert.strictEqual(t.logs.length, 1, t.logs.join('\n'));
    assert(/^CarPlay Wi-Fi: unknown \(p2p-wlan0-1: frequency unreadable: Interfaces of \/fi\/w1\/wpa_supplicant1 unreadable/.test(t.logs[0]), t.logs[0]);
    assert.strictEqual(t.changes, 0);
    assert(/^frequency unreadable/.test(t.state().reason));

    /* A frequency in no band. */
    files = { '/proc/net/tcp6': CARPLAY };
    t = sampler(files, supplicant({ 'p2p-wlan0-0': { group: ROOT + '/Interfaces/0/Groups/aa', freq: 5955 } }));
    traffic(files, ['p2p-wlan0-0'], 'p2p-wlan0-0', 0, 0);
    t.s.tick();
    t.now += 5000;
    traffic(files, ['p2p-wlan0-0'], 'p2p-wlan0-0', 500 * 1024, 5);
    await sleep(10);
    assert.strictEqual(t.s.current(), null);
    assert.deepStrictEqual(t.logs, ['CarPlay Wi-Fi: unknown (p2p-wlan0-0: frequency 5955 MHz in no band)']);
    console.log('ok   a frequency that cannot be read, or in no band: unknown, logged once');

    /* A session that ends before its first sample takes none. */
    files = { '/proc/net/tcp6': CARPLAY };
    run = supplicant(BRCM);
    t = sampler(files, run, { windowMs: 30 });
    traffic(files, ['p2p-wlan0-0', 'p2p-wlan0-1'], 'p2p-wlan0-1', 0, 0);
    t.s.tick();
    files['/proc/net/tcp6'] = TCP6_HDR;
    t.s.tick();
    await sleep(60);
    assert.deepStrictEqual([run.calls, t.logs, t.s.current()], [[], [], null]);
    console.log('ok   CarPlay gone before the first sample: no sample');
}

main().catch(function (e) { console.error(e); process.exit(1); });
