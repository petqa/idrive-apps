// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* The decoder against the fake MSDK (fake_msdk.h). Its src_crop path: a
 * CarPlay sequence goes from decode to VPP without waiting for the decode
 * task, an Android Auto one is waited for and cropped, and a session that
 * goes from one to the other and back sets VPP up for each. Its pictures: a
 * picture equal to the one before comes out as the same, unpacked, and the
 * others packed with their levels rounded. GPU copy: asked for with
 * MFXInitEx on page-aligned surfaces. A session that cannot be made or set
 * up with it is made again without, the sequence starting over as it began
 * (a rect restart's exemption kept), and no session in the process asks
 * for it again. A VPP run failing with it loses that picture and the
 * session goes on as it is; three in a row move its output planes off
 * 16-byte alignment (the CPU copy), and every picture after them comes
 * out. Each failure runs in a child process, since the fallback is the
 * process's. */
#include <sys/wait.h>
#include <unistd.h>

#include <functional>
#include <stdio.h>

#include <string>
#include <vector>

#include "decoder_msdk.h"
#include "fake_msdk.h"

using fake_msdk::access_unit;
using fake_msdk::calls;
using fake_msdk::count;
using woc::Decoder;
using woc::SourceCrop;
using woc::VideoFrame;

static int failures = 0;

/* body in a child process, so the process-wide GPU copy fallback starts
 * afresh; a failure in it is one here. */
static void isolated(const char *what, const std::function<void()> &body)
{
    fflush(stderr);
    const pid_t pid = fork();
    if (pid == 0) {
        failures = 0;
        body();
        fflush(stderr);
        _exit(failures ? 1 : 0);
    }
    int status = 0;
    if (pid < 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

static void fault(const char *call, int status, int after = 0, int times = 0)
{
    fake_msdk::gpu_fault.call = call;
    fake_msdk::gpu_fault.status = status;
    fake_msdk::gpu_fault.after = after;
    fake_msdk::gpu_fault.times = times;
}

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        for (const std::string &c : calls)
            fprintf(stderr, "    %s\n", c.c_str());
        failures++;
    }
}

namespace {

const char *const kCarPlay = "1088x480", *const kAndroidAuto = "1280x720";

struct Run {
    Decoder dec;
    /* Each frame: its atlas's first byte, 0 for the same picture again, -1
     * for none. */
    std::vector<int> frames;
    std::vector<uint8_t> pictures;   /* the atlases' first bytes */
    bool whole = true;               /* every atlas one level throughout */

    explicit Run(const char *crop, unsigned level_bits = 0, bool gpu_copy = false)
    {
        calls.clear();
        SourceCrop c;
        parse_source_crop(crop, &c);
        std::string err;
        if (!dec.init("/dev/null", 1088, 480, level_bits, gpu_copy, &err, c))
            fprintf(stderr, "init: %s\n", err.c_str());
    }
    void feed(const char *sps, bool idr, uint8_t content, bool picture = true)
    {
        const std::string au = access_unit(sps, idr, content);
        std::string err;
        dec.feed((const uint8_t *)au.data(), au.size(),
                 [this](const VideoFrame &f) {
                     expect(f.w == 1088 && f.h == 480, "every frame of the output size");
                     expect(!(f.same && f.atlas), "the same picture has no atlas");
                     frames.push_back(f.atlas ? (*f.atlas)[0] : f.same ? 0 : -1);
                     if (!f.atlas)
                         return;
                     pictures.push_back((*f.atlas)[0]);
                     for (uint8_t b : *f.atlas)
                         whole = whole && b == (*f.atlas)[0];
                 },
                 &err, true, picture);
    }
    /* A sequence: its SPS with an IDR, then n - 1 P frames. */
    void sequence(const char *size, int n, uint8_t first)
    {
        feed(size, true, first);
        for (int i = 1; i < n; i++)
            feed(nullptr, false, (uint8_t)(first + i));
    }
};

const char *const kAndroidAutoCrop = "1280x720:0,0,1280,564";

}  // namespace

int main()
{
    {
        Run r(kAndroidAutoCrop);
        r.sequence(kCarPlay, 5, 10);
        expect(r.pictures == std::vector<uint8_t>({10, 11, 12, 13, 14}), "carplay with a crop: every picture");
        expect(count("decode-sync") == 0, "carplay with a crop: no wait for the decode task");
        expect(count("vpp 0,0,1088,480") == 5 && count("vpp-sync") == 5, "carplay with a crop: VPP on the whole picture");
        expect(count("init 1088x480") == 1, "carplay with a crop: one sequence");
    }
    {
        Run r(kAndroidAutoCrop);
        r.sequence(kAndroidAuto, 5, 20);
        expect(r.pictures == std::vector<uint8_t>({20, 21, 22, 23, 24}), "android auto: every picture");
        expect(count("vpp-init 0,0,1280,564") == 1, "android auto: VPP set up for the crop");
        expect(count("decode-sync") == 5 && count("vpp 0,0,1280,564") == 5, "android auto: each picture waited for and cropped");
        bool ordered = true;
        for (size_t i = 0; i < calls.size(); i++)
            if (calls[i] == "vpp 0,0,1280,564")
                ordered = ordered && i > 0 && calls[i - 1] == "decode-sync";
        expect(ordered, "android auto: the wait comes before VPP");
    }
    {
        /* One session: Android Auto, then CarPlay's smaller (compatible)
         * sequence, then Android Auto's larger (incompatible) one. */
        Run r(kAndroidAutoCrop);
        r.sequence(kAndroidAuto, 3, 30);
        r.sequence(kCarPlay, 3, 40);
        const size_t carplay_from = calls.size();
        r.feed(nullptr, false, 50);
        r.feed(nullptr, false, 51);
        const std::vector<std::string> carplay(calls.begin() + (long)carplay_from, calls.end());
        r.sequence(kAndroidAuto, 3, 60);
        expect(r.pictures == std::vector<uint8_t>({30, 31, 32, 40, 41, 42, 50, 51, 60, 61, 62}),
               "android auto, carplay, android auto: every picture");
        expect(count("init 1280x720") == 2 && count("init 1088x480") == 1, "a sequence set up for each change");
        expect(count("vpp-init 0,0,1280,564") == 2 && count("vpp-init 0,0,1088,480") == 1, "VPP set up for each rect");
        expect(count("vpp 0,0,1280,564") == 6 && count("vpp 0,0,1088,480") == 5, "each picture in its own rect");
        expect(carplay == std::vector<std::string>({"vpp 0,0,1088,480", "vpp-sync", "vpp 0,0,1088,480", "vpp-sync"}),
               "carplay after android auto: no wait for the decode task");
        /* The compatible SPS's picture is waited for once, to find it needs
         * another rect; Android Auto's six are waited for. */
        expect(count("decode-sync") == 7, "the waits: android auto's pictures and the change");
    }
    {
        /* A compatible SPS that makes a sequence croppable: a larger stream,
         * then Android Auto's within its surfaces. */
        Run r(kAndroidAutoCrop);
        r.sequence("1920x1080", 2, 70);
        r.sequence(kAndroidAuto, 2, 80);
        expect(r.pictures == std::vector<uint8_t>({70, 71, 80, 81}), "1920x1080 then android auto: every picture");
        expect(count("vpp 0,0,1920,1080") == 2 && count("vpp 0,0,1280,564") == 2, "the larger whole, android auto cropped");
        expect(count("init 1280x720") == 1 && count("vpp-init 0,0,1280,564") == 1, "android auto set up for its rect");
    }
    {
        /* Pictures equal to the one before: VPP's last output is what they
         * are compared with (a frame without a picture has none), an SPS that
         * keeps the sequence keeps it, and a new sequence starts afresh. */
        Run r("", 2);
        r.feed(kCarPlay, true, 5);
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 5);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 9, false);
        r.feed(nullptr, false, 6);
        r.feed(nullptr, false, 5);
        r.feed(kCarPlay, true, 5);
        r.feed(kAndroidAuto, true, 5);
        expect(r.frames == std::vector<int>({4, 0, 0, 8, 0, -1, 0, 4, 0, 4}),
               "the same pictures, the others rounded to 2 bits");
        expect(r.whole, "each atlas packed whole");
        expect(count("vpp-sync") == 9, "VPP on every frame with a picture");
        expect(r.dec.pack_us().n == 9, "each compared or packed");
    }
    {
        Run r("", 0, true);
        r.sequence(kCarPlay, 3, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 2, 3}), "gpu copy: every picture");
        expect(count("session gpucopy 1") == 1 && count("session") == 0, "gpu copy: asked for with MFXInitEx");
        expect(count("vpp-out unaligned") == 0, "gpu copy: VPP's output page-aligned, its pitch a multiple of 64");
        expect(r.dec.vpp_us().n == 3, "the wait for each VPP run timed");
    }
    {
        Run r("");
        r.sequence(kCarPlay, 2, 1);
        expect(count("session") == 1 && count("session gpucopy 1") == 0, "no gpu copy: MFXInit");
    }
    /* Each step of a session's setup failing with GPU copy. */
    const struct {
        const char *call, *what;
        int status;
    } steps[] = {{"MFXInitEx", "MFXInitEx refused", -3},
                 {"SetHandle", "SetHandle failing", -6},
                 {"DECODE_QueryIOSurf", "QueryIOSurf failing", -3},
                 {"VPP_Init", "VPP's Init failing", -4}};
    for (const auto &step : steps)
        isolated(step.what, [&step] {
            fault(step.call, step.status);
            Run r("", 0, true);
            r.sequence(kCarPlay, 2, 1);
            expect(r.pictures == std::vector<uint8_t>({1, 2}), step.what);
            expect(count("session gpucopy 1") == 1, "GPU copy asked for once");
            Run again("", 0, true);
            again.sequence(kCarPlay, 2, 3);
            expect(count("session gpucopy 1") == 0 && again.pictures == std::vector<uint8_t>({3, 4}),
                   "a decoder set up again with it: no GPU copy in this process");
        });
    isolated("a VPP run failing alone with GPU copy", [] {
        fault("VPP_Run", -17, 1, 1);
        Run r("", 0, true);
        r.sequence(kCarPlay, 4, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 3, 4}), "that picture lost, every other one out");
        expect(count("session gpucopy 1") == 1 && count("session") == 0 && count("init 1088x480") == 1,
               "in the same session");
        expect(count("vpp-out shifted") == 0, "its output still copied on the GPU");
        Run again("", 0, true);
        again.sequence(kCarPlay, 2, 5);
        expect(count("session gpucopy 1") == 1 && again.pictures == std::vector<uint8_t>({5, 6}),
               "a decoder set up again still asks for GPU copy");
    });
    isolated("VPP runs failing with GPU copy, a successful one between", [] {
        fault("VPP_Run", -17, 0, 2);
        Run r("", 0, true);
        r.sequence(kCarPlay, 3, 1);
        fault("VPP_Run", -17, 0, 2);
        for (uint8_t i = 4; i <= 6; i++)
            r.feed(nullptr, false, i);
        expect(r.pictures == std::vector<uint8_t>({3, 6}), "the failed pictures lost");
        expect(count("vpp-out shifted") == 0, "the success starts the count again: still copied on the GPU");
    });
    isolated("three VPP runs in a row failing with GPU copy", [] {
        fault("VPP_Run", -17);
        Run r("", 0, true);
        r.sequence(kCarPlay, 6, 1);
        expect(r.pictures == std::vector<uint8_t>({4, 5, 6}),
               "those pictures lost, the session going on with every picture after them");
        expect(count("session gpucopy 1") == 1 && count("session") == 0 && count("init 1088x480") == 1,
               "in the same session");
        expect(count("vpp-out shifted") == 3, "its output copied on the CPU");
        r.sequence(kAndroidAuto, 2, 9);
        expect(count("session") == 1, "the next sequence in a session without GPU copy");
    });
    isolated("a rect restart's exemption kept through the fallback", [] {
        /* Android Auto's sequence whose pictures are CarPlay's size: a rect
         * restart, then converted as they are. VPP's Init fails with GPU
         * copy at that restart. */
        fault("VPP_Init", -4, 1);
        fake_msdk::picture_size = "1088x480";
        Run r(kAndroidAutoCrop, 0, true);
        r.sequence(kAndroidAuto, 3, 1);
        expect(r.pictures == std::vector<uint8_t>({1, 2, 3}), "every picture");
        expect(count("init 1280x720") == 3, "the first start, the restart with GPU copy, and without");
    });
    {
        Run r("");
        r.sequence(kAndroidAuto, 3, 90);
        r.sequence(kCarPlay, 3, 95);
        expect(count("decode-sync") == 0, "no crop: no wait for the decode task");
        expect(count("header 1280x720") == 1 && count("header 1088x480") == 0, "no crop: no header read while running");
    }
    if (failures) {
        fprintf(stderr, "decoder_test: %d failures\n", failures);
        return 1;
    }
    printf("decoder_test: ok\n");
    return 0;
}
