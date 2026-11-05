// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* wifi_band — the Wi-Fi band wireless CarPlay runs on, for patchd.
 *
 * The head unit runs two wireless-CarPlay P2P groups, one on 5 GHz and one
 * on 2.4 GHz (ConnMan's EnableAutoGo), each on a group interface bridged on
 * wlan_bridge: p2p-wlan0-N with Broadcom's driver, p2p-wfd0-N with NXP's.
 * Which name is which band is not fixed.
 *
 * CarPlay is up while carplay (CARPLAY_UID) holds an established TCP
 * connection to a peer that is not the head unit itself (/proc/net/tcp,
 * tcp6). While it is, the phone's group is the p2p interface that receives
 * the most: at least MIN_RX bytes/s and FACTOR times any other's. CarPlay up
 * with no such interface is CarPlay over USB, or too little traffic to tell.
 *
 * The group's frequency is wpa_supplicant's, read over D-Bus with busctl
 * (root only, by its bus policy): the interface object whose Ifname is the
 * group interface, its P2PDevice Group, that group's Frequency (MHz). Any
 * failure, or a frequency in no band, leaves the band unknown; it is never
 * taken from the interface's name or order.
 *
 * Cost: two small /proc reads every POLL_MS. When CarPlay comes up, the
 * byte counters over WINDOW_MS and one D-Bus lookup (a few busctl runs);
 * while it stays up, the same every RESAMPLE_MS over the time since the last.
 * A sample that cannot tell the interface keeps a band already known in
 * that CarPlay session while its interface still receives the most, at
 * least KEEP_RX bytes/s (a still screen and no audio); a new session starts
 * unknown.
 *
 * Node 8 on the unit. No dependencies. */
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var POLL_MS = 15000;
var WINDOW_MS = 5000;
var RESAMPLE_MS = 120000;
var MIN_RX = 1024;          /* bytes/s from the phone */
var KEEP_RX = 128;          /* bytes/s from the phone that keep a band known */
var FACTOR = 4;
var CARPLAY_UID = 13002;    /* cia_13002, carplay */
var P2P = /^p2p-/;
var SVC = 'fi.w1.wpa_supplicant1';
var ROOT = '/fi/w1/wpa_supplicant1';

/* /proc/net/dev's p2p interfaces: { name: { rx, tx } } (bytes). */
function parseNetDev(text) {
    var out = {};
    String(text || '').split('\n').forEach(function (line) {
        var colon = line.indexOf(':');
        if (colon < 0) return;
        var name = line.slice(0, colon).trim();
        if (!P2P.test(name)) return;
        var f = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (f.length >= 9 && isFinite(f[0]) && isFinite(f[8])) out[name] = { rx: f[0], tx: f[8] };
    });
    return out;
}

/* A /proc/net/tcp or tcp6 address (hex) is the head unit's own loopback or unset. */
function local(addr) {
    var a = addr.split(':')[0].toUpperCase();
    if (/^0+$/.test(a)) return true;
    if (a.length === 8) return a.slice(6) === '7F';
    if (a === '00000000000000000000000001000000') return true;
    return a.length === 32 && a.slice(0, 24) === '0000000000000000FFFF0000' && a.slice(30) === '7F';
}

/* Whether a table holds an established connection of uid to another device. */
function sessionIn(table, uid) {
    return String(table || '').split('\n').slice(1).some(function (line) {
        var f = line.trim().split(/\s+/);
        return f.length >= 8 && f[3] === '01' && Number(f[7]) === uid && !local(f[2]);
    });
}

/* The phone's interface between two parseNetDev reads ms apart:
 * { iface, rate (its bytes/s both ways), rates: { name: rx bytes/s } } or
 * { reason }. An interface missing from either read, or whose counters went
 * back, is left out. */
function pick(prev, cur, ms) {
    var rates = {}, names = [];
    Object.keys(cur).forEach(function (n) {
        var a = prev[n], b = cur[n];
        if (!a || b.rx < a.rx || b.tx < a.tx || !(ms > 0)) return;
        rates[n] = { rx: (b.rx - a.rx) * 1000 / ms, tx: (b.tx - a.tx) * 1000 / ms };
        names.push(n);
    });
    if (!names.length) return { reason: 'no Wi-Fi CarPlay interface', rates: rates };
    names.sort(function (x, y) { return rates[y].rx - rates[x].rx; });
    var top = rates[names[0]], next = names.length > 1 ? rates[names[1]].rx : 0;
    if (top.rx < MIN_RX) return { reason: 'no CarPlay traffic over Wi-Fi', rates: rates };
    if (top.rx < FACTOR * next) return { reason: 'CarPlay traffic on more than one Wi-Fi interface', rates: rates };
    return { iface: names[0], rate: top.rx + top.tx, rates: rates };
}

/* '2.4', '5' or null for a frequency in MHz. */
function band(mhz) {
    if (mhz >= 2412 && mhz <= 2484) return '2.4';
    if (mhz >= 4910 && mhz <= 5885) return '5';
    return null;
}

/* busctl get-property's output: q 5785, s "x", o "/x", ao 2 "/a" "/b". */
function parseValue(out) {
    var s = String(out || '').trim();
    var m = /^(\S+)\s*([\s\S]*)$/.exec(s);
    if (!m) return null;
    var sig = m[1], rest = m[2];
    var strings = function (t) {
        var r = [], re = /"((?:[^"\\]|\\.)*)"/g, x;
        while ((x = re.exec(t))) r.push(x[1]);
        return r;
    };
    if (/^[qunyitx]$/.test(sig)) return isFinite(Number(rest)) && rest !== '' ? Number(rest) : null;
    if (sig === 's' || sig === 'o') { var one = strings(rest); return one.length === 1 ? one[0] : null; }
    if (sig === 'ao' || sig === 'as') {
        var n = parseInt(rest, 10), list = strings(rest);
        return n === list.length ? list : null;
    }
    return null;
}

/* busctl as a function: run(args, cb(err, stdout)). */
function busctlRunner(bin) {
    return function (args, cb) {
        cp.execFile(bin, ['--system', '--auto-start=no', '--timeout=2'].concat(args), { timeout: 5000 }, function (err, out) {
            cb(err, String(out || ''));
        });
    };
}

/* cb(err, mhz): the frequency of the P2P group on iface, from wpa_supplicant. */
function readFreq(iface, run, cb) {
    function get(obj, intf, prop, next) {
        run(['get-property', SVC, obj, intf, prop], function (err, out) {
            var v = err ? null : parseValue(out);
            if (v === null) { cb(new Error(prop + ' of ' + obj + ' unreadable' + (err ? ': ' + String(err.message).split('\n')[0] : ''))); return; }
            next(v);
        });
    }
    get(ROOT, SVC, 'Interfaces', function (paths) {
        if (!Array.isArray(paths)) { cb(new Error('no interface list')); return; }
        (function next(i) {
            if (i >= paths.length) { cb(new Error('wpa_supplicant has no interface ' + iface)); return; }
            get(paths[i], SVC + '.Interface', 'Ifname', function (name) {
                if (name !== iface) { next(i + 1); return; }
                get(paths[i], SVC + '.Interface.P2PDevice', 'Group', function (group) {
                    if (!group || group === '/') { cb(new Error(iface + ' has no P2P group')); return; }
                    get(group, SVC + '.Group', 'Frequency', function (mhz) {
                        if (typeof mhz !== 'number') { cb(new Error('no frequency for ' + iface)); return; }
                        cb(null, mhz);
                    });
                });
            });
        })(0);
    });
}

function kb(rate) { return Math.round(rate / 1024); }

/* A band as the logs say it. */
function describe(v) {
    return 'CarPlay Wi-Fi: ' + v.band + ' GHz (' + v.iface + ', ' + v.freq + ' MHz, ' + kb(v.rate) + ' KB/s)';
}

/* The sampler. o: { log(line), onChange(), file (the state file, or null),
 * busctl (run(args, cb)), readFile(path) -> text or null, netDev (path),
 * tables ([paths]), uid, pollMs, windowMs, resampleMs, now() }.
 * current(): { band, iface, freq } while known, else null. */
function Sampler(o) {
    this.o = o;
    this.session = false;
    this.prev = null;           /* { at, dev } */
    this.value = null;          /* { band, iface, freq, rate } */
    this.reason = 'no CarPlay session';
    this.rates = {};
    this.logged = null;         /* the key of the last line logged */
    this.reading = false;
    this.timers = [];
    this.gen = 0;               /* the CarPlay session a sample belongs to */
}

Sampler.prototype.now = function () { return this.o.now ? this.o.now() : Date.now(); };
Sampler.prototype.read = function (p) {
    if (this.o.readFile) return this.o.readFile(p);
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
};
Sampler.prototype.snapshot = function () { return { at: this.now(), dev: parseNetDev(this.read(this.o.netDev)) }; };
Sampler.prototype.carplayUp = function () {
    var self = this;
    return (this.o.tables || []).some(function (t) { return sessionIn(self.read(t), self.o.uid); });
};

Sampler.prototype.current = function () {
    return this.value ? { band: this.value.band, iface: this.value.iface, freq: this.value.freq } : null;
};

/* One poll: CarPlay's session, and a sample when one is due. */
Sampler.prototype.tick = function () {
    var self = this, up = this.carplayUp();
    if (!up) {
        if (this.session) {
            this.session = false;
            this.prev = null;
            this.gen++;
            this.set(null, 'no CarPlay session');
        }
        return;
    }
    if (!this.session) {
        this.session = true;
        this.gen++;
        this.prev = this.snapshot();
        var gen = this.gen;
        this.later(function () { if (self.session && self.gen === gen) self.sample(); }, this.o.windowMs);
        return;
    }
    if (this.prev && !this.reading && this.now() - this.prev.at >= this.o.resampleMs) this.sample();
};

Sampler.prototype.later = function (fn, ms) {
    var t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    this.timers.push(t);
    if (this.timers.length > 8) this.timers.shift();
};

Sampler.prototype.sample = function () {
    var self = this, cur = this.snapshot(), p = pick(this.prev ? this.prev.dev : {}, cur.dev, cur.at - (this.prev ? this.prev.at : cur.at));
    this.prev = cur;
    this.rates = p.rates || {};
    if (!p.iface) {
        var mine = this.value && p.rates[this.value.iface];
        if (mine && mine.rx >= KEEP_RX && Object.keys(p.rates).every(function (n) { return p.rates[n].rx <= mine.rx; })) {
            this.write();
            return;
        }
        this.set(null, p.reason);
        return;
    }
    var gen = this.gen;
    this.reading = true;
    readFreq(p.iface, this.o.busctl, function (err, mhz) {
        self.reading = false;
        if (!self.session || self.gen !== gen) return;
        var b = err ? null : band(mhz);
        if (!b) {
            self.set(null, err ? 'frequency unreadable: ' + err.message : 'frequency ' + mhz + ' MHz in no band', p.iface);
            return;
        }
        self.set({ band: b, iface: p.iface, freq: mhz, rate: p.rate }, null);
    });
};

function keyOf(v) { return 'band ' + v.band + ' ' + v.iface + ' ' + v.freq; }

/* Takes v (null: unknown, for reason), logs a change and tells onChange.
 * Logged: a band, each time it changes; unknown after a band, and a
 * frequency that could not be read; not the unknown of no CarPlay or no
 * Wi-Fi CarPlay before any band. */
Sampler.prototype.set = function (v, reason, iface) {
    var before = this.value ? keyOf(this.value) : null;
    this.value = v;
    this.reason = v ? null : reason;
    this.write();
    var why = v ? null : (iface ? iface + ': ' : '') + reason;
    var key = v ? keyOf(v) : 'unknown ' + why;
    if ((v || /^band /.test(this.logged || '') || /^frequency/.test(reason)) && key !== this.logged) {
        this.o.log(v ? describe(v) : 'CarPlay Wi-Fi: unknown (' + why + ')');
        this.logged = key;
    }
    if ((v ? key : null) !== before && this.o.onChange) this.o.onChange();
};

/* The state file: what the band is, or why it is not known, and each p2p
 * interface's receive and send rates at the last sample (bytes/s). */
Sampler.prototype.write = function () {
    if (!this.o.file) return;
    var self = this, rates = {};
    Object.keys(this.rates).forEach(function (n) { rates[n] = { rx: Math.round(self.rates[n].rx), tx: Math.round(self.rates[n].tx) }; });
    var doc = { at: new Date(this.now()).toISOString(), carplay: this.session, band: this.value ? this.value.band : null,
        iface: this.value ? this.value.iface : null, freq: this.value ? this.value.freq : null,
        rate: this.value ? Math.round(this.value.rate) : null, reason: this.reason, rates: rates };
    var tmp = this.o.file + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(doc) + '\n', { mode: 0o644 });
        fs.chmodSync(tmp, 0o644);
        fs.renameSync(tmp, this.o.file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
    }
};

Sampler.prototype.start = function () {
    var self = this;
    this.write();
    this.interval = setInterval(function () { self.tick(); }, this.o.pollMs);
    if (this.interval.unref) this.interval.unref();
    this.tick();
    return this;
};

Sampler.prototype.stop = function () {
    clearInterval(this.interval);
    this.timers.forEach(clearTimeout);
    this.timers = [];
};

/* patchd's sampler, the unit's paths unless the environment names others. */
function start(log, onChange, dir, env) {
    var e = env || process.env;
    var num = function (k, d) { var n = parseInt(e[k], 10); return n > 0 ? n : d; };
    return new Sampler({
        log: log, onChange: onChange,
        file: e.WOC_WIFI_FILE || path.join(dir, 'wifi-band.json'),
        busctl: busctlRunner(e.WOC_BUSCTL || 'busctl'),
        netDev: e.WOC_PROC_NET_DEV || '/proc/net/dev',
        tables: (e.WOC_PROC_NET_TCP || '/proc/net/tcp,/proc/net/tcp6').split(','),
        uid: num('WOC_CARPLAY_UID', CARPLAY_UID),
        pollMs: num('WOC_WIFI_POLL_MS', POLL_MS),
        windowMs: num('WOC_WIFI_WINDOW_MS', WINDOW_MS),
        resampleMs: num('WOC_WIFI_RESAMPLE_MS', RESAMPLE_MS)
    }).start();
}

module.exports = { parseNetDev: parseNetDev, sessionIn: sessionIn, pick: pick, band: band, parseValue: parseValue,
    readFreq: readFreq, describe: describe, Sampler: Sampler, start: start,
    POLL_MS: POLL_MS, WINDOW_MS: WINDOW_MS, RESAMPLE_MS: RESAMPLE_MS, MIN_RX: MIN_RX, KEEP_RX: KEEP_RX, FACTOR: FACTOR, CARPLAY_UID: CARPLAY_UID };
