#include "mixer.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <vector>

#include "../core/rt.h"
#include "../platform/platform.h"

namespace audio {
namespace {
std::mutex g_mutex;
std::vector<std::shared_ptr<Source>> g_sources;
std::atomic<uint64_t> g_frames{0};

// BELLA_AUDIO_DUMP=<path.wav> captures the post-mix stereo float output as PCM16 LE.
struct WavDump {
  FILE* f = nullptr;
  uint32_t data_bytes = 0;
  ~WavDump() { close(); }
  void patch_header() {
    if (!f) return;
    const uint32_t riff = 36 + data_bytes;
    fseek(f, 4, SEEK_SET);
    fwrite(&riff, 4, 1, f);
    fseek(f, 40, SEEK_SET);
    fwrite(&data_bytes, 4, 1, f);
    fseek(f, 0, SEEK_END);
    fflush(f);
  }
  void close() {
    if (!f) return;
    patch_header();
    fclose(f);
    f = nullptr;
  }
};
WavDump g_dump;

void close_dump_atexit() { g_dump.close(); }

void maybe_open_dump() {
  static bool tried = false;
  if (g_dump.f || tried) return;
  tried = true;
  const char* path = getenv("BELLA_AUDIO_DUMP");
  if (!path || !*path) return;
  g_dump.f = fopen(path, "wb");
  if (!g_dump.f) {
    rt::log(rt::Log::Warn, "BELLA_AUDIO_DUMP: cannot open %s", path);
    return;
  }
  const uint32_t byte_rate = (uint32_t)(kRate * 2 * sizeof(int16_t));
  const uint16_t channels = 2, bits = 16, fmt = 1;
  fwrite("RIFF", 1, 4, g_dump.f);
  uint32_t zero = 0;
  fwrite(&zero, 4, 1, g_dump.f);  // chunk size (patched on close)
  fwrite("WAVEfmt ", 1, 8, g_dump.f);
  uint32_t fmt_size = 16;
  fwrite(&fmt_size, 4, 1, g_dump.f);
  fwrite(&fmt, 2, 1, g_dump.f);
  fwrite(&channels, 2, 1, g_dump.f);
  uint32_t rate = (uint32_t)kRate;
  fwrite(&rate, 4, 1, g_dump.f);
  fwrite(&byte_rate, 4, 1, g_dump.f);
  uint16_t block = channels * (bits / 8);
  fwrite(&block, 2, 1, g_dump.f);
  fwrite(&bits, 2, 1, g_dump.f);
  fwrite("data", 1, 4, g_dump.f);
  fwrite(&zero, 4, 1, g_dump.f);
  rt::log(rt::Log::Info, "BELLA_AUDIO_DUMP: capturing mixer output to %s (%d Hz stereo)", path, kRate);
  static bool atexit_once = false;
  if (!atexit_once) {
    atexit_once = true;
    atexit(close_dump_atexit);
  }
}

void write_dump(const float* out, int frames) {
  if (!g_dump.f) return;
  for (int i = 0; i < frames * 2; i++) {
    float s = std::clamp(out[i], -1.0f, 1.0f);
    int16_t v = (int16_t)std::lround(s * 32767.0f);
    fwrite(&v, sizeof(v), 1, g_dump.f);
    g_dump.data_bytes += sizeof(v);
  }
  g_dump.patch_header();
}
}  // namespace

void init() {
  static bool opened = false;
  if (!opened) opened = plat::audio_open(kRate, render);
}

void add(const std::shared_ptr<Source>& s) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_sources.push_back(s);
}

void remove(Source* s) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_sources.erase(std::remove_if(g_sources.begin(), g_sources.end(), [&](auto& p) { return p.get() == s; }), g_sources.end());
}

void render(float* out, int frames) {
  maybe_open_dump();
  memset(out, 0, sizeof(float) * 2 * (size_t)frames);
  {
    // Held while mixing so a source cannot be destroyed mid-mix (remove() takes the same lock).
    std::lock_guard<std::mutex> lock(g_mutex);
    for (auto& s : g_sources) s->mix(out, frames);
  }
  for (int i = 0; i < frames * 2; i++) out[i] = std::clamp(out[i], -1.0f, 1.0f);
  write_dump(out, frames);
  g_frames += (uint64_t)frames;
}

uint64_t frames_rendered() { return g_frames.load(); }

float db100_to_gain(int32_t v) {
  if (v <= -10000) return 0.0f;
  if (v >= 0) return 1.0f;
  return std::pow(10.0f, (float)v / 2000.0f);
}

}  // namespace audio
