#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* collect-logs.sh's wifi.txt, with stand-in /proc/net/dev, patchd's band
 * file, journalctl and dmesg: the band as patchd wrote it, each P2P
 * interface's counters and no other interface's, and the kernel's 802.1X
 * and DHCP lines for the P2P interfaces from the journal, from dmesg when
 * the journal has none, the last 60; "(none)" for what is missing. */
'use strict';
var assert = require('assert');
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var SCRIPT = path.join(__dirname, '..', '..', 'tools', 'collect-logs.sh');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-collect-'));
var bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
var DEV = path.join(dir, 'net-dev'), BAND = path.join(dir, 'wifi-band.json');
var KERNEL = path.join(dir, 'journal-kernel'), DMESG = path.join(dir, 'dmesg-out');

/* journalctl -k prints KERNEL; other journalctl calls print nothing */
fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/sh\ncase " $* " in *" -k "*) cat ' + KERNEL + ' 2>/dev/null ;; esac\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'dmesg'), '#!/bin/sh\ncat ' + DMESG + ' 2>/dev/null\n', { mode: 0o755 });

var ENV = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, WOC_PROC_NET_DEV: DEV, WOC_WIFI_FILE: BAND });

function collect() {
    var out = path.join(dir, 'out-' + Date.now() + Math.random().toString(16).slice(2));
    fs.mkdirSync(out);
    var archive = cp.execFileSync('sh', [SCRIPT, '-o', out], { env: ENV, encoding: 'utf8' }).trim();
    cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
    var name = path.basename(archive).replace(/\.tar\.gz$/, '');
    return fs.readFileSync(path.join(out, name, 'wifi.txt'), 'utf8');
}

var lines = [];
for (var i = 0; i < 70; i++) lines.push('Nov 05 06:53:' + String(i % 60).padStart(2, '0') + '.000000 mgu kernel: DHCP[p2p-wlan0-1] - REQUEST [TX] ' + i);
fs.writeFileSync(KERNEL, '[   11.575296] wlan_bridge: port 2(p2p-wlan0-0) entered forwarding state\n' +
    'Nov 05 06:53:00.000000 mgu kernel: ETHER_TYPE_802_1X[p2p-wlan0-1] [TX]: ver 2, type 3, replay 1\n' +
    'Nov 05 06:53:00.100000 mgu kernel: DHCP[wlan0] - DISCOVER [TX]\n' + lines.join('\n') + '\n');
fs.writeFileSync(DEV, 'Inter-|   Receive\n face |bytes packets\n    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n' +
    '  wlan0: 5 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0\n  p2p-wlan0-0: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n' +
    '  p2p-wlan0-1: 9000000 1 0 0 0 0 0 0 400000 1 0 0 0 0 0 0\n');
fs.writeFileSync(BAND, '{"band":"2.4","iface":"p2p-wlan0-1","freq":2462}\n');

var w = collect();
var sections = w.split(/^-- /m).slice(1);
assert.strictEqual(sections.length, 3, w);
assert(/^CarPlay Wi-Fi band \(patchd, .*wifi-band\.json\)\n\{"band":"2\.4","iface":"p2p-wlan0-1","freq":2462\}\n$/.test(sections[0]), sections[0]);
assert.deepStrictEqual(sections[1].split('\n').slice(1, -1).map(function (l) { return l.trim().split(':')[0]; }), ['p2p-wlan0-0', 'p2p-wlan0-1'],
    'the P2P interfaces only');
var k = sections[2].split('\n').slice(1, -1);
assert.strictEqual(k.length, 60, 'the last 60');
assert(/REQUEST \[TX\] 69$/.test(k[59]) && /REQUEST \[TX\] 10$/.test(k[0]), k[0]);
assert(!/DHCP\[wlan0\]|entered forwarding/.test(sections[2]), 'only the P2P interfaces\' 802.1X and DHCP lines');
console.log('ok   wifi.txt: patchd\'s band, the P2P interfaces\' counters, their last 60 802.1X and DHCP lines from the journal');

fs.writeFileSync(KERNEL, '');
fs.writeFileSync(DMESG, '[   29.966111] ETHER_TYPE_802_1X[p2p-wfd0-1] [TX]: ver 2, type 3, replay 1\n[   30.111144] DHCP[p2p-wfd0-1] - REQUEST [TX]\n');
w = collect();
assert(/802\.1X and DHCP lines.*\n\[   29\.966111\] ETHER_TYPE_802_1X\[p2p-wfd0-1\].*\n\[   30\.111144\] DHCP\[p2p-wfd0-1\] - REQUEST \[TX\]\n$/.test(w), w);
console.log('ok   none in the journal: dmesg\'s, NXP\'s p2p-wfd0-N');

fs.unlinkSync(BAND);
fs.unlinkSync(DMESG);
fs.writeFileSync(DEV, 'Inter-|   Receive\n face |bytes packets\n  eth0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n');
w = collect();
assert.strictEqual(w.replace(/\(patchd, [^)]*\)/, '(patchd)').replace(/in \S+\n/, 'in DEV\n'),
    '-- CarPlay Wi-Fi band (patchd)\n(none)\n-- P2P interfaces in DEV\n(none)\n-- 802.1X and DHCP lines for P2P interfaces (the last 60)\n(none)\n');
console.log('ok   no band file, no P2P interface, no kernel line (the emulator): each "(none)"');

try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) { /* left in tmp */ }
