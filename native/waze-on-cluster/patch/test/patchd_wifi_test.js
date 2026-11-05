#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* patchd's CarPlay Wi-Fi band, with fake /proc files and a fake busctl
 * standing in for wpa_supplicant: null in the status with no CarPlay and no
 * busctl run; with CarPlay over Wi-Fi on 2.4 GHz a status carrying
 * {band, iface, freq}, the log line with the interface, frequency and byte
 * rate, and wifi-band.json next to the socket; null again, and a status,
 * when CarPlay ends. */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-wifi-'));
var SOCK = path.join(dir, 'sock', 'patch.sock');
var DEV = path.join(dir, 'net-dev');
var TCP6 = path.join(dir, 'tcp6');
var BUSCTL = path.join(dir, 'busctl');
var CALLS = path.join(dir, 'busctl-calls');

var TCP6_HDR = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
var SESSION = TCP6_HDR + '   0: 000080FE000000001122334455667788:178E 000080FE00000000A1B2C3D4E5F60718:C001 01 ' +
    '00000000:00000000 00:00000000 00000000 13002        0 1234 1 0000000000000000 20 4 30 10 -1\n';
fs.writeFileSync(TCP6, TCP6_HDR);
/* p2p-wlan0-0 on 5785 MHz, p2p-wlan0-1 on 2462 MHz, as on the owner's car */
fs.writeFileSync(BUSCTL, '#!/bin/sh\necho "$*" >> ' + CALLS + '\n' +
    'R=/fi/w1/wpa_supplicant1\n' +
    'case "$6 $8" in\n' +
    '"$R Interfaces") echo "ao 3 \\"$R/Interfaces/0\\" \\"$R/Interfaces/1\\" \\"$R/Interfaces/2\\"" ;;\n' +
    '"$R/Interfaces/0 Ifname") echo \'s "wlan0"\' ;;\n' +
    '"$R/Interfaces/1 Ifname") echo \'s "p2p-wlan0-0"\' ;;\n' +
    '"$R/Interfaces/2 Ifname") echo \'s "p2p-wlan0-1"\' ;;\n' +
    '"$R/Interfaces/1 Group") echo "o \\"$R/Interfaces/1/Groups/aa\\"" ;;\n' +
    '"$R/Interfaces/2 Group") echo "o \\"$R/Interfaces/2/Groups/bb\\"" ;;\n' +
    '"$R/Interfaces/1/Groups/aa Frequency") echo "q 5785" ;;\n' +
    '"$R/Interfaces/2/Groups/bb Frequency") echo "q 2462" ;;\n' +
    '*) echo "Unknown object" >&2; exit 1 ;;\n' +
    'esac\n', { mode: 0o755 });

var bytes = 0;
function writeDev() {
    fs.writeFileSync(DEV, 'Inter-| Receive | Transmit\n face |bytes packets|bytes packets\n' +
        '  p2p-wlan0-0: 100 1 0 0 0 0 0 0 ' + (300 * bytes / 1e6 | 0) + ' 1 0 0 0 0 0 0\n' +
        '  p2p-wlan0-1: ' + bytes + ' 1 0 0 0 0 0 0 ' + (bytes / 20 | 0) + ' 1 0 0 0 0 0 0\n');
}
writeDev();

var ENV = Object.assign({}, process.env, {
    WOC_PATCH_SOCK: SOCK,
    WOC_PATCH_GROUP: '',
    WOC_LOCAL_CONF: path.join(dir, 'local.conf'),
    WOC_STATE_DIR: dir,
    WOC_CARPLAY: path.join(dir, 'no-carplay'),
    WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
    WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
    WOC_RECMGR_CONF: path.join(dir, 'no-recmgr'),
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: path.join(dir, 'no-stat'),
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_MOUNT: path.join(dir, 'no-mount'),
    WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
    WOC_PROC_NET_DEV: DEV,
    WOC_PROC_NET_TCP: TCP6,
    WOC_BUSCTL: BUSCTL,
    WOC_WIFI_POLL_MS: '100',
    WOC_WIFI_WINDOW_MS: '500',
    WOC_WIFI_RESAMPLE_MS: '600000'
});
var out = '';
var p = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.on('data', function (d) { out += d; });
p.stderr.on('data', function (d) { out += d; });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var passed = 0, total = 0;
function ok(name, cond) {
    total++;
    if (cond) passed++;
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + '\n');
}

/* A client keeping every message. */
function client() {
    var c = { msgs: [], buf: '' };
    c.s = net.connect(SOCK);
    c.s.setEncoding('utf8');
    c.s.on('data', function (d) {
        c.buf += d;
        var lines = c.buf.split('\n');
        c.buf = lines.pop();
        lines.forEach(function (l) { try { c.msgs.push(JSON.parse(l)); } catch (e) { /* not ours */ } });
    });
    c.wait = async function (what, test) {
        for (var t = 0; t < 8000; t += 50) {
            var m = c.msgs.filter(test);
            if (m.length) return m[m.length - 1];
            await sleep(50);
        }
        throw new Error('no ' + what);
    };
    return c;
}

(async function () {
    for (var t = 0; t < 5000 && !fs.existsSync(SOCK); t += 50) await sleep(50);
    var c = client();
    var st = await c.wait('status', function (m) { return m.ev === 'status'; });
    ok('no CarPlay: wifi null in the status', st.wifi === null);
    await sleep(300);
    ok('no CarPlay: no busctl run', !fs.existsSync(CALLS));
    var file = JSON.parse(fs.readFileSync(path.join(dir, 'sock', 'wifi-band.json'), 'utf8'));
    ok('no CarPlay: wifi-band.json says so', file.band === null && file.reason === 'no CarPlay session' && file.carplay === false);
    ok('wifi-band.json readable by all', (fs.statSync(path.join(dir, 'sock', 'wifi-band.json')).mode & 0o777) === 0o644);

    fs.writeFileSync(TCP6, SESSION);
    var timer = setInterval(function () { bytes += 200000; writeDev(); }, 100);
    st = await c.wait('a status with the band', function (m) { return m.ev === 'status' && m.wifi; });
    ok('CarPlay over Wi-Fi on 2.4 GHz: wifi in the status', JSON.stringify(st.wifi) === JSON.stringify({ band: '2.4', iface: 'p2p-wlan0-1', freq: 2462 }));
    var line = await c.wait('the log line', function (m) { return m.ev === 'log' && /CarPlay Wi-Fi: 2\.4 GHz/.test(m.line); });
    ok('logged with the interface, the frequency and the byte rate: ' + line.line,
        /CarPlay Wi-Fi: 2\.4 GHz \(p2p-wlan0-1, 2462 MHz, \d+ KB\/s\)$/.test(line.line));
    file = JSON.parse(fs.readFileSync(path.join(dir, 'sock', 'wifi-band.json'), 'utf8'));
    ok('wifi-band.json: the band, the interface, its frequency and each p2p interface\'s rates',
        file.band === '2.4' && file.iface === 'p2p-wlan0-1' && file.freq === 2462 && file.carplay === true &&
        file.rates['p2p-wlan0-1'].rx > 0 && 'p2p-wlan0-0' in file.rates);
    ok('busctl run without starting wpa_supplicant', /^--system --auto-start=no --timeout=2 get-property fi\.w1\.wpa_supplicant1 /.test(fs.readFileSync(CALLS, 'utf8')));
    var c2 = client();
    st = await c2.wait('status', function (m) { return m.ev === 'status'; });
    ok('a client connecting later gets the band in its first status', st.wifi && st.wifi.band === '2.4');
    c2.s.end();

    fs.writeFileSync(TCP6, TCP6_HDR);
    clearInterval(timer);
    var n = c.msgs.length;
    st = await c.wait('a status without the band', function (m) { return c.msgs.indexOf(m) >= n && m.ev === 'status' && m.wifi === null; });
    ok('CarPlay ended: wifi null again in a new status', st.wifi === null);
    ok('logged: unknown', out.indexOf('CarPlay Wi-Fi: unknown (no CarPlay session)') >= 0);
    c.s.end();
})().catch(function (e) {
    ok('no error: ' + e.message, false);
}).then(function () {
    p.kill();
    try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) {}
    process.stdout.write(passed + '/' + total + ' passed\n');
    if (passed !== total) { process.stdout.write(out); process.exitCode = 1; }
});
