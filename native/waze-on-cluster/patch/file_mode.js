// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* How the patchers and boot recovery replace a file they keep a backup of
 * (carplay, aapd, aapd.conf), and repair its mode and owner.
 *
 * carplay and aapd run as their own users (carplay.service User=cia_13002,
 * aapd.service User=cia_13006), so a binary must stay executable and
 * aapd.conf readable by group and other: EXEC (0755) and READ (0644) are
 * the bits each must have at least. A replaced file gets its original's
 * mode with those bits and its original's owner. Both are set explicitly
 * on the new file (fchown, then fchmod) and checked with fstat before it
 * is renamed over the target, and the target is checked after. Nothing
 * depends on the process umask, which an installer may set to 077, or on a
 * temporary file a write cut short left behind: that one is removed and
 * the temporary file is created afresh.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');

var EXEC = 0o755;
var READ = 0o644;

function unlinkQuiet(f) { try { fs.unlinkSync(f); } catch (e) {} }

/* What target should be, { mode, uid, gid }: the original's mode (its
 * setuid, setgid and sticky bits too) with at least floor's bits, and its
 * owner. orig: the original's mode, uid and gid as a backup record keeps
 * them (any may be missing); target's own stat fills what it does not
 * give, and floor, the running user, a missing target. */
function wanted(target, orig, floor) {
    var st = null;
    try { st = fs.statSync(target); } catch (e) {}
    function pick(k, dflt) { return orig && typeof orig[k] === 'number' ? orig[k] : st ? st[k] : dflt; }
    return {
        mode: (pick('mode', floor) & 0o7777) | floor,
        uid: pick('uid', process.getuid ? process.getuid() : 0),
        gid: pick('gid', process.getgid ? process.getgid() : 0),
    };
}

function differs(st, want) {
    var why = [];
    if ((st.mode & 0o7777) !== want.mode) why.push('mode 0' + (st.mode & 0o7777).toString(8) + ', not 0' + want.mode.toString(8));
    if (st.uid !== want.uid || st.gid !== want.gid) why.push('owner ' + st.uid + ':' + st.gid + ', not ' + want.uid + ':' + want.gid);
    return why.length ? why.join(', ') : null;
}

/* null also when target cannot be stat'd. */
function mismatch(target, want) {
    var st;
    try { st = fs.statSync(target); } catch (e) { return null; }
    return differs(st, want);
}

/* Whether target lacks what the service's user needs of floor: read and
 * execute by group and other for a binary (EXEC), read for aapd.conf
 * (READ). The owner's bits are left out: they do not stop the service. */
function lacks(target, floor) {
    var need = floor & 0o055;
    try { return (fs.statSync(target).mode & need) !== need; } catch (e) { return false; }
}

/* fd's file made want: owner first (a chown clears setuid), then mode,
 * fsynced and checked. */
function setOn(fd, file, want) {
    var st = fs.fstatSync(fd);
    if (st.uid !== want.uid || st.gid !== want.gid) fs.fchownSync(fd, want.uid, want.gid);
    fs.fchmodSync(fd, want.mode);
    fs.fsyncSync(fd);
    var why = differs(fs.fstatSync(fd), want);
    if (why) throw new Error(file + ': ' + why + ' after setting them');
}

function writeAll(fd, buf) {
    for (var off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off, off);
}

/* target replaced by buf with want's mode and owner: a temporary file
 * beside it, created afresh, written, its owner and mode set and checked,
 * fsynced, renamed over target, then target and its folder checked and
 * synced. inPlace: when the rename fails, target is rewritten in place
 * instead, its owner and mode set the same way. Throws when any step fails;
 * up to the rename target is untouched. */
function replace(target, buf, want, inPlace) {
    var tmp = target + '.woc-tmp', fd;
    unlinkQuiet(tmp);
    fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        writeAll(fd, buf);
        setOn(fd, tmp, want);
    } catch (e) {
        fs.closeSync(fd);
        unlinkQuiet(tmp);
        throw e;
    }
    fs.closeSync(fd);
    try {
        fs.renameSync(tmp, target);
    } catch (e) {
        unlinkQuiet(tmp);
        if (!inPlace) throw e;
        fd = fs.openSync(target, 'r+');
        try {
            writeAll(fd, buf);
            fs.ftruncateSync(fd, buf.length);
            setOn(fd, target, want);
        } finally { fs.closeSync(fd); }
    }
    var why = mismatch(target, want);
    if (why) throw new Error(target + ': ' + why + ' after the write');
    try { var d = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (e) {}
}

/* target's owner and mode made want, its bytes as they are. Throws when it
 * cannot. */
function repair(target, want) {
    var fd = fs.openSync(target, 'r');
    try { setOn(fd, target, want); } finally { fs.closeSync(fd); }
}

module.exports = { EXEC: EXEC, READ: READ, wanted: wanted, mismatch: mismatch, lacks: lacks, replace: replace, repair: repair };
