#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Copyright (C) 2026 mlurker@gmail.com
/* The Android Auto patch for the experimental aapd 21.44.4 build
 * (MGU O18_22w40.3-1-9). Two parts:
 *
 *   - always: the multi-build structure and selection, on synthetic
 *     fixtures built from each build's own anchors — so the 22.39.3 path is
 *     exercised too, without its (unavailable) binary.
 *
 *   - with AAPD2144_BIN / AAPD2144_CONF / AAPD2144_CODING set to copies of a
 *     21.44.4 /usr/bin/aapd, /etc/aapd.conf and /dev/shm/rawcodingdata: the
 *     patcher end to end on temporary copies — the experimental opt-in gate,
 *     apply/reapply/revert, every refusal, the four edits only, and semantic
 *     checks read straight from the binary (the coding->class jump table, the
 *     KombiVariant field's default, and each edit site's branch geometry),
 *     none of them taken from the patch's edit table.
 *
 * The separate parked-car result is in PATCH.md. These file tests alone
 * say nothing about whether the cluster actually shows the map.
 *
 *   [AAPD2144_BIN=<aapd> AAPD2144_CONF=<aapd.conf> AAPD2144_CODING=<shm>] node aapd_aa2144_test.js
 */
'use strict';

var headUnit = require('./head_unit_env.js');   /* supported head unit for patcher and recovery fixtures */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');

var PATCH = path.join(__dirname, '..');
var ap = require('../aapd_patch.js');
var conf = require('../aapd_conf.js');
var record = require('../patch_record.js');

var fails = 0, dirs = [];
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
process.on('exit', function () { dirs.forEach(function (d) { try { cp.execFileSync('rm', ['-rf', d]); } catch (e) {} }); });
function sha(x) { return crypto.createHash('sha256').update(Buffer.isBuffer(x) ? x : fs.readFileSync(x)).digest('hex'); }
function hx(buf, off, len) { return buf.toString('hex', off, off + len); }

function build(ver) {
    return ap.BUILDS.filter(function (b) { return b.version.indexOf(ver) === 0; })[0];
}
var B2239 = build('aapd 22.39.3'), B2144 = build('aapd 21.44.4');

/* ---- the build table (always) ---- */
(function tableTests() {
    ok('two builds: 22.39.3 proven, 21.44.4 experimental', !!B2239 && !!B2144 &&
        B2239.experimental === false && B2144.experimental === true, JSON.stringify(ap.BUILDS.map(function (b) { return [b.version, b.experimental]; })));
    ok('the exported KNOWN and EDITS are the proven build', ap.KNOWN === B2239 && ap.EDITS === B2239.edits);
    ok('sizes are distinct, so size selects the build', B2239.size !== B2144.size &&
        ap.buildBySize(B2239.size) === B2239 && ap.buildBySize(B2144.size) === B2144 && ap.buildBySize(123) === null);
    ap.BUILDS.forEach(function (b) {
        ok(b.version.slice(5, 12) + ': four named edits, patched bytes the same length as stock, 68-byte same-build bound',
            b.edits.length === 4 && b.edits.every(function (e) { return e.patched.length === e.original.length; }) &&
            2 * b.edits.reduce(function (n, e) { return n + e.original.length / 2; }, 0) === 68, b.version);
    });
    /* 21.44.4's self-start edits keep their destinations when the call/jmp is
     * recomputed from the site; the geometry of the retarget, read from the
     * patch's own bytes. */
    function rel32(hexStr, at) { var b = Buffer.from(hexStr, 'hex'); return at + 1 + 4 + b.readInt32LE(at + 1); }
    var call = B2144.edits[1], guard = B2144.edits[2];
    ok('21.44.4 selfstart CALL retargets to 0x1d3ec0 (requestStream)', call.patched.slice(0, 2) === 'e8' && rel32(call.patched, 0) + call.off === 0x1d3ec0,
        '0x' + (rel32(call.patched, 0) + call.off).toString(16));
    ok('21.44.4 selfstart guard JMP keeps destination 0x1d3f80', guard.patched.slice(0, 2) === 'e9' && rel32(guard.patched, 0) + guard.off === 0x1d3f80 && guard.patched.slice(10) === '90',
        '0x' + (rel32(guard.patched, 0) + guard.off).toString(16));
})();

/* ---- build selection on synthetic fixtures (always) ---- */
/* A buffer of the build's size with each edit's before+stock+after bytes at
 * its offset: classify must select that build and read every site original. */
function fixture(b) {
    var buf = Buffer.alloc(b.size);
    b.edits.forEach(function (e) {
        var bl = e.before.length / 2;
        Buffer.from(e.before, 'hex').copy(buf, e.off - bl);
        Buffer.from(e.original, 'hex').copy(buf, e.off);
        Buffer.from(e.after, 'hex').copy(buf, e.off + e.original.length / 2);
    });
    return buf;
}
(function selectionTests() {
    ap.BUILDS.forEach(function (b) {
        var c = ap.classify(fixture(b));
        ok('synthetic ' + b.version.slice(5, 12) + ': classify selects it, all sites original, none bad',
            c.build === b && !c.bad.length && c.states.length === 4 && c.states.every(function (s) { return s.state === 'original'; }), JSON.stringify(c.bad));
        /* the patched fixture reads all sites patched for the same build */
        var patched = fixture(b);
        b.edits.forEach(function (e) { Buffer.from(e.patched, 'hex').copy(patched, e.off); });
        var cp2 = ap.classify(patched);
        ok('synthetic ' + b.version.slice(5, 12) + ' patched: same build, every site patched',
            cp2.build === b && !cp2.bad.length && cp2.states.every(function (s) { return s.state === 'patched'; }), JSON.stringify(cp2.bad));
    });
    /* A size no build has is unknown; a right-sized buffer with a broken
     * anchor is that build but with a bad site. */
    ok('an unknown size is refused by classify', ap.classify(Buffer.alloc(1024)).build === null && ap.classify(Buffer.alloc(1024)).bad.length === 1);
    var broken = fixture(B2144); broken[B2144.edits[0].off - 1] ^= 0x5a;
    var cb = ap.classify(broken);
    ok('a broken anchor is the right build with a bad site (no cross-build confusion)', cb.build === B2144 && cb.bad.length === 1 && /gate/.test(cb.bad[0]), JSON.stringify(cb.bad));
})();

/* ---- the patcher on a real 21.44.4, if provided ---- */
var BIN = process.env.AAPD2144_BIN || '', CONF = process.env.AAPD2144_CONF || '', CODING = process.env.AAPD2144_CODING || '';
if (!fs.existsSync(BIN) || !fs.existsSync(CONF) || !fs.existsSync(CODING)) {
    process.stdout.write('SKIP: set AAPD2144_BIN, AAPD2144_CONF and AAPD2144_CODING to copies of a 21.44.4 aapd, aapd.conf and rawcodingdata for the on-binary tests\n');
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed (table and selection only; binary tests skipped)\n');
    process.exit(fails ? 1 : 0);
}

var SRC = fs.readFileSync(BIN), SRCCONF = fs.readFileSync(CONF), SRCCODING = fs.readFileSync(CODING);
ok('the supplied binary is the 21.44.4 build', sha(SRC) === B2144.sha256 && SRC.length === B2144.size, sha(SRC));
ok('the supplied aapd.conf is the known original', sha(SRCCONF) === conf.ORIGINAL_SHA256, sha(SRCCONF));
ok('the supplied coding reads KI_KOMBI_VARIANT 7 and valid', (SRCCODING[ap.CODING.flags] & 0x0f) === ap.CODING.valid &&
    ((SRCCODING[ap.CODING.at] & ap.CODING.mask) >> ap.CODING.shift) === 7 && ap.CODING.proven === 7);

function unit() {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-aa2144-'));
    dirs.push(d);
    var t = { d: d, bin: path.join(d, 'aapd'), conf: path.join(d, 'aapd.conf'), coding: path.join(d, 'coding'), df: path.join(d, 'df') };
    fs.writeFileSync(t.bin, SRC, { mode: 0o755 });
    fs.writeFileSync(t.conf, SRCCONF, { mode: 0o644 });
    fs.writeFileSync(t.coding, SRCCODING);
    setFree(t, 1 << 30);
    return t;
}
function setFree(t, bytes) {
    fs.writeFileSync(t.df, '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/root 999999 1 ' + Math.floor(bytes / 1024) + ' 1% /"\n');
    fs.chmodSync(t.df, 0o755);
}
function coding(v, flags) {
    var b = Buffer.from(SRCCODING);
    b[ap.CODING.flags] = flags === undefined ? 0x09 : flags;
    b[ap.CODING.at] = (b[ap.CODING.at] & ~ap.CODING.mask) | ((v << ap.CODING.shift) & ap.CODING.mask);
    return b;
}
function patcher(t, args) {
    var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'aapd_patch.js')].concat(args, ['--target', t.bin, '--conf', t.conf, '--coding', t.coding]),
        { encoding: 'utf8', env: Object.assign({}, process.env, { WOC_DF: t.df, WOC_AA_EXPERIMENTAL: '' }) });
    return { code: r.status, out: r.stdout + r.stderr };
}
function status(t) { return patcher(t, ['status']).out; }
function untouched(t) { return sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF) && !fs.existsSync(t.bin + '.woc-orig') && !fs.existsSync(t.conf + '.woc-orig'); }
function onlyEdits(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (!B2144.edits.some(function (e) { return i >= e.off && i < e.off + e.original.length / 2; })) return false;
    }
    return a.length === b.length;
}

/* ---- the experimental opt-in gate ---- */
(function optInTests() {
    var t = unit();
    ok('status: experimental, pristine 21.44.4; every site original; nothing to restore',
        /known:\s+experimental, pristine aapd 21\.44\.4/.test(status(t)) && /gate:\s+ORIGINAL/.test(status(t)) &&
        /restorable:\s+no/.test(status(t)) && /geometry:\s+ORIGINAL/.test(status(t)), status(t));

    var r = patcher(t, ['apply', '--yes']);
    ok('apply without --experimental: refused, nothing written, no backup', r.code === 1 && /is experimental/.test(r.out) && untouched(t), r.out);

    r = patcher(t, ['apply', '--yes', '--experimental']);
    ok('apply --experimental: patched, both backups with their recorded SHA-256, the four edits only',
        r.code === 0 && sha(t.bin + '.woc-orig') === sha(SRC) && sha(t.conf + '.woc-orig') === sha(SRCCONF) &&
        JSON.parse(fs.readFileSync(t.bin + '.woc-orig.json', 'utf8')).sha256_original === sha(SRC) &&
        onlyEdits(SRC, fs.readFileSync(t.bin)) && !fs.readFileSync(t.bin).equals(SRC), r.out);
    ok('apply: every changed byte is inside one of the four sites', onlyEdits(SRC, fs.readFileSync(t.bin)));
    /* Inspect the output, independently of BUILDS[].edits. A relative
     * destination alone cannot distinguish CALL from JMP; swapping them
     * preserves the address but breaks the stack on return. */
    var written = fs.readFileSync(t.bin);
    ok('written gate: cmp class with 2, feature flag and setbe preserved',
        hx(written, 0x998b3, 20) === 'ff928000000084c0740a83bb1c020000020f96c0');
    ok('written selfstart: CALL requestStream with the original this argument',
        written[0x1d437b] === 0xe8 && 0x1d4380 + written.readInt32LE(0x1d437c) === 0x1d3ec0 &&
        hx(written, 0x1d436f, 3) === '4c89ff');
    ok('written guard: JMP to stream request, NOP padding, already-streaming branch preserved',
        written[0x1d3eed] === 0xe9 && 0x1d3ef2 + written.readInt32LE(0x1d3eee) === 0x1d3f80 &&
        written[0x1d3ef2] === 0x90 && hx(written, 0x1d3ee3, 10) === '837b3802740a837b4402');
    ok('written screen: class 2 takes the 12.3 load, other fall-through classes return zero',
        hx(written, 0x15b3d0, 16) === '83f802740b660fefc0ebdc0f1f440000' &&
        hx(written, 0x15b3e0, 4) === 'f20f1005' &&
        0x15b3e8 + written.readInt32LE(0x15b3e4) === 0x524eb0 && written.readDoubleLE(0x524eb0) === 12.3);
    ok('apply: the backup records the experimental version', JSON.parse(fs.readFileSync(t.bin + '.woc-orig.json', 'utf8')).version === B2144.version);
    var rec = record.current(t.bin);
    ok('apply: boot recovery records this build as patched but unproven', rec && rec.patched === true && rec.proven === false);
    ok('status: experimental, modified build; all patched; the 12.3 geometry at 180 dpi',
        /known:\s+experimental, modified build/.test(status(t)) && (status(t).match(/PATCHED/g) || []).length === 5 &&
        /PATCHED \(180 dpi, card shown, crop 1280x720:0,0,1280,564\)/.test(status(t)), status(t));

    /* The opt-in is recorded by the backup: a later density change needs no
     * flag, and never touches a byte outside the edits. */
    var r2 = patcher(t, ['apply', '--dpi', '240', '--yes']);
    ok('re-apply (density) with the backup present needs no flag', r2.code === 0 &&
        JSON.parse(fs.readFileSync(t.conf, 'utf8')).SCREENS.KOMBI_DISPLAY.CODEC_DEFINITION.HIGH_1080P.REPORTED_SCREEN_DENSITY === 240 &&
        onlyEdits(SRC, fs.readFileSync(t.bin)), r2.out);

    /* Refresh metadata left by a version which knew only proven builds,
     * even when the binary and configuration need no further writes. */
    record.write(t.bin, { patched: true, proven: true });
    var noChange = patcher(t, ['apply', '--dpi', '240', '--yes']);
    rec = record.current(t.bin);
    ok('no-op apply repairs stale proven metadata without changing the binary',
        noChange.code === 0 && /nothing to do/.test(noChange.out) && rec && rec.patched && rec.proven === false &&
        fs.readFileSync(t.bin).equals(written), noChange.out);

    /* revert needs no opt-in and restores byte-exact. */
    var r3 = patcher(t, ['revert', '--yes']);
    ok('revert without --experimental: both originals back byte-exact', r3.code === 0 && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r3.out);
    ok('status after revert: original again, nothing restorable', /geometry:\s+ORIGINAL/.test(status(t)) && /restorable:\s+no/.test(status(t)));
})();

/* The service runs as a different user. Correct bytes alone are not a
 * working patch: apply, revert and their no-op paths must preserve access,
 * including when an install hook inherits a restrictive umask. */
(function permissionTests() {
    [0o022, 0o077].forEach(function (mask) {
        var savedMask = process.umask(mask);
        try {
            var t = unit();
            fs.chmodSync(t.bin, 0o755);
            fs.chmodSync(t.conf, 0o644);
            var owner = fs.statSync(t.bin), confOwner = fs.statSync(t.conf);
            function usable() {
                var b = fs.statSync(t.bin), c = fs.statSync(t.conf);
                return (b.mode & 0o777) === 0o755 && (c.mode & 0o777) === 0o644 &&
                    b.uid === owner.uid && b.gid === owner.gid && c.uid === confOwner.uid && c.gid === confOwner.gid;
            }
            var label = 'umask ' + mask.toString(8) + ': ';
            var r = patcher(t, ['apply', '--yes', '--experimental']);
            ok(label + 'apply preserves service access and ownership', r.code === 0 && usable(), r.out);
            var patched = [sha(t.bin), sha(t.conf)];
            fs.chmodSync(t.bin, 0o700);
            fs.chmodSync(t.conf, 0o600);
            r = patcher(t, ['apply', '--yes']);
            ok(label + 'no-op apply repairs service access without changing bytes', r.code === 0 && usable() &&
                sha(t.bin) === patched[0] && sha(t.conf) === patched[1], r.out);
            r = patcher(t, ['revert', '--yes']);
            ok(label + 'revert restores bytes, service access and ownership', r.code === 0 && usable() &&
                sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r.out);
            fs.chmodSync(t.bin, 0o700);
            fs.chmodSync(t.conf, 0o600);
            r = patcher(t, ['revert', '--yes']);
            ok(label + 'no-op revert repairs service access without changing bytes', r.code === 0 && usable() &&
                sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF), r.out);
        } finally { process.umask(savedMask); }
    });
})();

/* ---- refusals: nothing is written on a wrong coding, build, anchor,
 * aapd.conf, backup or disk ---- */
(function refusalTests() {
    [headUnit.NONE, null].forEach(function (cmdline) {
        var t = unit();
        headUnit.set(cmdline);
        var r = patcher(t, ['apply', '--yes', '--experimental']);
        headUnit.set(headUnit.HIGH);
        ok('experimental opt-in never bypasses the head-unit gate: ' + (cmdline ? 'missing hwvariant' : 'unreadable'),
            r.code === 1 && /refusing: head unit:/.test(r.out) && untouched(t), r.out);
    });
    var highf = unit();
    headUnit.set(headUnit.HIGHF);
    var highfRefused = patcher(highf, ['apply', '--yes']);
    var highfApplied = patcher(highf, ['apply', '--yes', '--experimental']);
    headUnit.set(headUnit.HIGH);
    ok('HIGH F follows upstream: supported but still requires experimental opt-in',
        highfRefused.code === 1 && /is experimental/.test(highfRefused.out) && highfApplied.code === 0,
        highfRefused.out + highfApplied.out);
    [[coding(9), 'KI_KOMBI_VARIANT 9 is not the proven'], [coding(2), 'KI_KOMBI_VARIANT 2 is not the proven'],
     [coding(7, 0x0b), 'coding not valid'], [Buffer.alloc(16), 'is 16 bytes']].forEach(function (c) {
        var u = unit(); fs.writeFileSync(u.coding, c[0]);
        var r = patcher(u, ['apply', '--yes', '--experimental']);
        ok('coding refused (' + c[1] + '), nothing written', r.code === 1 && r.out.indexOf(c[1]) >= 0 && untouched(u), r.out);
    });

    B2144.edits.forEach(function (e) {
        [['before', e.off - 1], ['after', e.off + e.original.length / 2], ['site', e.off]].forEach(function (m) {
            var u = unit(), b = Buffer.from(SRC); b[m[1]] ^= 0x5a;
            fs.writeFileSync(u.bin, b);
            var r = patcher(u, ['apply', '--yes', '--experimental']);
            ok('mutation: ' + e.name + ' ' + m[0] + ' changed is refused, nothing written',
                r.code === 1 && r.out.indexOf(e.name) >= 0 && sha(u.bin) === sha(b) && !fs.existsSync(u.bin + '.woc-orig'), r.out);
        });
    });

    var sz = unit(); fs.writeFileSync(sz.bin, Buffer.concat([SRC, Buffer.alloc(16)]));
    ok('a size no build has is refused', /refusing: size/.test(patcher(sz, ['apply', '--yes', '--experimental']).out) && !fs.existsSync(sz.bin + '.woc-orig'));

    var un = unit(), ub = Buffer.from(SRC); ub[0x1000] ^= 1;
    fs.writeFileSync(un.bin, ub);
    var r = patcher(un, ['apply', '--yes', '--experimental']);
    ok('sites intact but another file is refused (first edit needs the pristine build)',
        r.code === 1 && /pristine build/.test(r.out) && !fs.existsSync(un.bin + '.woc-orig'), r.out);
    ok('status of that file: experimental, modified build; nothing restorable', /known:\s+experimental, modified build/.test(status(un)) && /restorable:\s+no/.test(status(un)));

    var cc = unit(); fs.appendFileSync(cc.conf, '\n');
    r = patcher(cc, ['apply', '--yes', '--experimental']);
    ok('another aapd.conf is refused before anything is written', r.code === 1 && /not the known original aapd.conf/.test(r.out) && sha(cc.bin) === sha(SRC), r.out);

    var lo = unit(); setFree(lo, 10 << 20);
    r = patcher(lo, ['apply', '--yes', '--experimental']);
    ok('too little free space refuses, nothing written', r.code === 1 && /bytes free/.test(r.out) && untouched(lo), r.out);

    ok('a density off the steps is refused', patcher(unit(), ['apply', '--dpi', '155', '--yes', '--experimental']).code === 1);

    /* A backup that is not its record's original is never trusted. */
    var t = unit();
    patcher(t, ['apply', '--yes', '--experimental']);
    var bad = fs.readFileSync(t.bin + '.woc-orig'); bad[5] ^= 1;
    fs.writeFileSync(t.bin + '.woc-orig', bad);
    var patched = sha(t.bin);
    ok('a backup that differs from its record refuses apply', patcher(t, ['apply', '--dpi', '200', '--yes']).code === 1 && sha(t.bin) === patched);
    r = patcher(t, ['revert', '--yes']);
    ok('revert never writes an untrusted backup; aapd not undone', r.code === 1 && /recorded/.test(r.out) && sha(t.bin) === patched, r.out);

    /* A backup without its record is not trusted. */
    var nr = unit();
    patcher(nr, ['apply', '--yes', '--experimental']);
    fs.unlinkSync(nr.bin + '.woc-orig.json');
    var nrBin = sha(nr.bin);
    r = patcher(nr, ['revert', '--yes']);
    ok('a backup without its record is not trusted on revert', /has no record/.test(r.out) && sha(nr.bin) === nrBin && sha(nr.conf) === sha(SRCCONF), r.out);
})();

/* ---- firmware-update / force / drop-backup, as for the proven build ---- */
(function revertTests() {
    var t = unit();
    patcher(t, ['apply', '--yes', '--experimental']);
    var other = Buffer.concat([SRC, Buffer.from('new firmware')]);
    fs.writeFileSync(t.bin, other);
    var r = patcher(t, ['revert', '--yes']);
    ok('another aapd build over the backup is left; aapd.conf still restored', r.code === 0 && sha(t.bin) === sha(other) &&
        sha(t.conf) === sha(SRCCONF) && /left as it is/.test(r.out), r.out);
    r = patcher(t, ['revert', '--yes', '--force', '--drop-backup']);
    ok('--force writes the backup over another build; --drop-backup drops both', r.code === 0 && sha(t.bin) === sha(SRC) &&
        !fs.existsSync(t.bin + '.woc-orig') && !fs.existsSync(t.conf + '.woc-orig'), r.out);
})();

/* ---- semantic checks read straight from the binary (not the edit table) ---- */
(function semanticTests() {
    var b = SRC;
    function s32(o) { return b.readInt32LE(o); }

    /* The coding->class jump table the gate relies on. The dispatch reads a
     * 12-entry table (raw 0..11) whose base is the lea at 0x4f87f9; each entry
     * jumps to a `movl $class,(%rsi)` store. Re-derived here from the bytes. */
    ok('codingToInternal dispatch: bounds check then jump table', b[0x4f87f1] === 0x80 && b[0x4f87f4] === 0x77 /* cmpb $0xb;(ja) */ &&
        b[0x4f87f9] === 0x48 && b[0x4f87fa] === 0x8d && b[0x4f87fb] === 0x15 /* lea rdx,[table] */, hx(b, 0x4f87f1, 12));
    var tableBase = 0x4f8800 + s32(0x4f87fc);
    var map = {};
    for (var raw = 0; raw <= 11; raw++) {
        var tgt = (tableBase + s32(tableBase + raw * 4)) >>> 0;
        /* each target is `c7 06 <imm32>` = movl $class,(%rsi) */
        map[raw] = (b[tgt] === 0xc7 && b[tgt + 1] === 0x06) ? b.readUInt32LE(tgt + 2) : 'not-a-store@0x' + tgt.toString(16);
    }
    ok('coding map (this binary): raw 1-8 and 11 -> class 2, 9 -> 0, 10 -> 1, 0 -> 3',
        map[0] === 3 && map[9] === 0 && map[10] === 1 && map[11] === 2 &&
        [1, 2, 3, 4, 5, 6, 7, 8].every(function (r) { return map[r] === 2; }), JSON.stringify(map));
    ok('the car coding raw 7 maps to class 2 (what the <=2 gate admits)', map[7] === 2);

    /* The KombiVariant field +0x21c is default-initialised to class 3 (off):
     * movl $0x3,0x21c(%rbx) at 0x991f9. */
    ok('Application+0x21c default-inits to class 3 (fail-safe off)',
        hx(b, 0x991f9, 10) === 'c7831c02000003000000', hx(b, 0x991f9, 10));

    /* gate: a feature-flag virtual call guards the comparison; only the
     * immediate is our edit. */
    ok('gate: feature-flag virtual call and je, then cmp dword [rbx+0x21c],1; setbe al',
        hx(b, 0x998b3, 6) === 'ff9280000000' /* call *0x80(rdx) */ && b[0x998bb] === 0x74 /* je over the gate */ &&
        b[0x998bd] === 0x83 && b[0x998be] === 0xbb && hx(b, 0x998bf, 4) === '1c020000' /* [rbx+0x21c] */ &&
        b[0x998c3] === 0x01 /* stock imm, our edit makes it 02 */ && hx(b, 0x998c4, 3) === '0f96c0' /* setbe al */, hx(b, 0x998b3, 20));

    /* requestStream at 0x1d3ec0: the already-streaming check stays, and the
     * [rbx+0x44]==2 je whose target the jmp preserves. */
    ok('requestStream: [rbx+0x38]==2 kept, [rbx+0x44]==2 je -> 0x1d3f80',
        hx(b, 0x1d3ee3, 4) === '837b3802' && hx(b, 0x1d3ee9, 4) === '837b4402' &&
        b[0x1d3eed] === 0x0f && b[0x1d3eee] === 0x84 && (0x1d3eed + 6 + s32(0x1d3eef)) === 0x1d3f80,
        '0x' + (0x1d3eed + 6 + s32(0x1d3eef)).toString(16));
    ok('requestStream starts at the selfstart call retarget 0x1d3ec0 (pushq r14)', hx(b, 0x1d3ec0, 2) === '4156');

    /* selfstart call: the stock call reaches setNaviStreamStatus 0x1d3b80;
     * our retarget reaches requestStream 0x1d3ec0. */
    ok('selfstart call: stock -> 0x1d3b80, our byte geometry -> 0x1d3ec0',
        (0x1d437b + 5 + s32(0x1d437c)) === 0x1d3b80 &&
        (0x1d437b + 5 + Buffer.from(B2144.edits[1].patched, 'hex').readInt32LE(1)) === 0x1d3ec0, hx(b, 0x1d437b, 5));

    /* screen: the class->size lookup; the doubles; the patched branch lands
     * on the 12.3 load and the shared return. */
    ok('screen helper: doubles 12.3 and 10.25 at 0x524eb0/0x524eb8',
        b.readDoubleLE(0x524eb0) === 12.3 && b.readDoubleLE(0x524eb8) === 10.25);
    ok('screen helper: class 0 -> je to the 12.3 load 0x15b3e0, which reads 0x524eb0',
        b[0x15b3a8] === 0x74 && (0x15b3a8 + 2 + b.readInt8(0x15b3a9)) === 0x15b3e0 &&
        hx(b, 0x15b3e0, 4) === 'f20f1005' && (0x15b3e0 + 8 + s32(0x15b3e4)) === 0x524eb0, hx(b, 0x15b3e0, 8));
    var patchedScreen = Buffer.from(B2144.edits[3].patched, 'hex');
    ok('screen patch geometry: cmp eax,2; je -> 0x15b3e0 (12.3); pxor; jmp -> 0x15b3b7 (return)',
        hx(patchedScreen, 0, 3) === '83f802' && patchedScreen[3] === 0x74 && (0x15b3d3 + 2 + patchedScreen.readInt8(4)) === 0x15b3e0 &&
        patchedScreen[9] === 0xeb && (0x15b3d9 + 2 + patchedScreen.readInt8(10)) === 0x15b3b7, hx(patchedScreen, 0, 16));
})();

/* The install hook must not opt in on the owner's behalf; once opted in,
 * updates may keep the patch and removal must restore it. */
(function hookTests() {
    var t = unit();
    ['shm', 'var', 'proc', 'units', 'bin'].forEach(function (n) { fs.mkdirSync(path.join(t.d, n)); });
    var mounts = path.join(t.d, 'mounts'), calls = path.join(t.d, 'calls');
    var mount = path.join(t.d, 'bin', 'mount'), carplay = path.join(t.d, 'carplay');
    fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(carplay, 'not a carplay build\n');
    fs.writeFileSync(mount, '#!' + process.execPath + '\nvar fs=require("fs");' +
        'fs.writeFileSync(' + JSON.stringify(mounts) + ',"/dev/root / ext4 "+' +
        '(process.argv.join(" ").indexOf("rw")>=0?"rw":"ro")+" 0 0\\n");\n', { mode: 0o755 });
    ['systemctl', 'kill', 'reboot'].forEach(function (name) {
        fs.writeFileSync(path.join(t.d, 'bin', name), '#!' + process.execPath + '\n' +
            'require("fs").appendFileSync(' + JSON.stringify(calls) + ',' + JSON.stringify(name + '\n') +
            ');process.exit(99);\n', { mode: 0o755 });
    });
    var env = Object.assign({}, process.env, {
        PATH: path.join(t.d, 'bin') + path.delimiter + process.env.PATH,
        WOC_CARPLAY: carplay, WOC_AAPD: t.bin, WOC_AAPD_CONF: t.conf, WOC_CODING: t.coding,
        WOC_DF: t.df, WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts, WOC_PROC: path.join(t.d, 'proc'),
        WOC_PATCH_SOCK: path.join(t.d, 'shm', 'patch.sock'),
        WOC_REMOUNT_LOCK: path.join(t.d, 'shm', 'remount.lock'), WOC_STATE_DIR: path.join(t.d, 'var'),
        WOC_UNIT_DIRS: path.join(t.d, 'units'), WOC_CARPLAY_DROPIN: path.join(t.d, 'dropin.conf'),
        WOC_RECMGR_CONF: path.join(t.d, 'absent-recmgr'), WOC_RECMGR_AT_BOOT: path.join(t.d, 'absent-cache'),
        WOC_PROC_STAT: path.join(t.d, 'absent-stat'), WOC_BOOT_ID: path.join(t.d, 'absent-boot'),
        WOC_REBOOT_CMD: path.join(t.d, 'bin', 'reboot'), WOC_AA_EXPERIMENTAL: ''
    });
    function hook(action) {
        var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'patchd.js'), action],
            { env: env, encoding: 'utf8', timeout: 60000 });
        var lines = (r.stdout || '').trim().split('\n'), result = {};
        try { result = JSON.parse(lines[lines.length - 1]); } catch (e) {}
        return { code: r.status, result: result, out: r.stdout + r.stderr };
    }
    var r = hook('activate');
    ok('install hook: experimental conflict, both originals untouched, no opt-in',
        r.code === 0 && /experimental aapd build/.test(r.result.aa && r.result.aa.conflict) && untouched(t), r.out);
    headUnit.set(headUnit.NONE);
    r = hook('activate');
    headUnit.set(headUnit.HIGH);
    ok('install hook: head-unit refusal takes precedence over experimental conflict',
        r.code === 0 && /unknown variant/.test(r.result.aa && r.result.aa.conflict) && untouched(t), r.out);
    r = patcher(t, ['apply', '--yes', '--experimental']);
    ok('install hook fixture: manual opt-in succeeds', r.code === 0, r.out);
    var patched = sha(t.bin);
    r = hook('activate');
    ok('install hook after opt-in: no experimental conflict, patch preserved',
        r.code === 0 && r.result.aa && !r.result.aa.conflict && sha(t.bin) === patched &&
        /geometry:\s+PATCHED/.test(status(t)), r.out);
    r = hook('deactivate');
    ok('removal hook: byte-exact originals, backups removed, root read-only, no service commands',
        r.code === 0 && untouched(t) && / ext4 ro /.test(fs.readFileSync(mounts, 'utf8')) &&
        fs.readFileSync(calls, 'utf8') === '' && fs.readFileSync(carplay, 'utf8') === 'not a carplay build\n', r.out);
})();

/* The real recovery entry point, with this build and all OS-facing paths
 * confined to the temporary unit. No real mount or service command runs. */
(function bootRecoveryTests() {
    ['patched', 'damaged anchor', 'partial apply'].forEach(function (scenario) {
        var t = unit();
        ['var', 'shm', 'proc'].forEach(function (name) { fs.mkdirSync(path.join(t.d, name)); });
        if (scenario === 'partial apply') fs.mkdirSync(t.conf + '.woc-tmp');
        var applied = patcher(t, ['apply', '--experimental', '--yes']);
        ok('recovery fixture ' + scenario + ': apply reached the expected state',
            applied.code === (scenario === 'partial apply' ? 1 : 0) && sha(t.bin) !== sha(SRC), applied.out);
        if (scenario === 'damaged anchor') {
            var damaged = fs.readFileSync(t.bin);
            damaged[0x998bc] ^= 1;
            fs.writeFileSync(t.bin, damaged);
        }
        var mounts = path.join(t.d, 'mounts'), calls = path.join(t.d, 'calls');
        fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
        fs.writeFileSync(calls, '');
        var mount = path.join(t.d, 'mount'), systemctl = path.join(t.d, 'systemctl');
        fs.writeFileSync(mount, '#!' + process.execPath + '\n' +
            'var fs=require("fs");fs.appendFileSync(' + JSON.stringify(calls) + ',"mount "+process.argv.slice(2).join(" ")+"\\n");' +
            'fs.writeFileSync(' + JSON.stringify(mounts) + ',"/dev/root / ext4 "+(process.argv.join(" ").indexOf("rw")>=0?"rw":"ro")+" 0 0\\n");\n', { mode: 0o755 });
        fs.writeFileSync(systemctl, '#!' + process.execPath + '\nrequire("fs").appendFileSync(' +
            JSON.stringify(calls) + ',"UNEXPECTED systemctl\\n");process.exit(99);\n', { mode: 0o755 });
        var state = path.join(t.d, 'var', 'aa-boot-recovery.json');
        /* A recorded experimental patch restores at its first failed boot.
         * A changed/missing record is unknown and keeps upstream's threshold
         * of two. Include unknown: legacy counters are deliberately reset. */
        fs.writeFileSync(state, JSON.stringify({ fails: scenario === 'patched' ? 0 : 1, unknown: 0,
            arm: { boot: 'previous', patch: scenario === 'patched' ? 'unproven' : 'unknown', crashes: 1 } }));
        fs.writeFileSync(path.join(t.d, 'bootid'), 'review-boot\n');
        var env = Object.assign({}, process.env, {
            WOC_AAPD: t.bin, WOC_AAPD_CONF: t.conf, WOC_CODING: t.coding,
            WOC_CARPLAY: path.join(t.d, 'absent-carplay'),
            WOC_RECOVERY_STATE: path.join(t.d, 'var', 'boot-recovery.json'),
            WOC_BOOT_ID: path.join(t.d, 'bootid'), WOC_PROC: path.join(t.d, 'proc'),
            WOC_PATCH_SOCK: path.join(t.d, 'shm', 'patch.sock'),
            WOC_REMOUNT_LOCK: path.join(t.d, 'shm', 'remount.lock'),
            WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts, WOC_SYSTEMCTL: systemctl,
            WOC_SIN_DIR: path.join(t.d, 'absent-sin'), WOC_AA_EXPERIMENTAL: ''
        });
        var r = cp.spawnSync(process.execPath, [path.join(PATCH, 'recovery.js'), 'boot', 'aapd'],
            { env: env, encoding: 'utf8', timeout: 60000 });
        ok('real boot recovery, ' + scenario + ': both files restored byte-exact without opt-in',
            r.status === 0 && /aapd boot check: restored/.test(r.stdout) && sha(t.bin) === sha(SRC) && sha(t.conf) === sha(SRCCONF),
            r.stdout + r.stderr);
        ok('real boot recovery, ' + scenario + ': read-only again, lock released, CarPlay state untouched',
            / ext4 ro /.test(fs.readFileSync(mounts, 'utf8')) && !fs.existsSync(env.WOC_REMOUNT_LOCK) &&
            !fs.existsSync(env.WOC_RECOVERY_STATE) && !/UNEXPECTED/.test(fs.readFileSync(calls, 'utf8')));
    });
})();

process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
process.exit(fails ? 1 : 0);
