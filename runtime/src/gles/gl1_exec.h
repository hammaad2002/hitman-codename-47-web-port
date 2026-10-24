// Replays the OpenGL 1.1 command stream (gl1/gl1_cmd.h) with OpenGL ES 3.0 (native) / WebGL 2 (web).
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace gl1 {
void execute(const uint32_t* words, size_t n);
void shutdown();
// Canvas (default framebuffer) size used for the letterboxed present; defaults to 800x600.
void set_canvas_size_provider(void (*fn)(int* w, int* h));

// Pure logic, testable without a GL context.
namespace detail {
struct Record {
  uint16_t op;
  uint32_t n;  // payload words
  const uint32_t* p;
};
// Reads the next record (skipping kMagic words); false at the end or on a truncated record.
bool next_record(const uint32_t*& cur, const uint32_t* end, Record& r);
// Triangle indices for GL_QUADS / GL_QUAD_STRIP / GL_POLYGON; false for modes GLES draws natively.
bool expand_indices(uint32_t mode, uint32_t nverts, std::vector<uint32_t>& out);
uint32_t map_wrap(uint32_t glenum);            // GL_CLAMP -> CLAMP_TO_EDGE, etc.
bool is_mipmap_filter(uint32_t glenum);
uint32_t map_blend_factor(uint32_t glenum);    // 0 if invalid in GLES (e.g. GL_SRC_COLOR as source is fine; GL_SRC_ALPHA_SATURATE too)
bool is_valid_cap(uint32_t glenum);            // caps forwarded to glEnable
// Largest letterboxed rect of aspect sw:sh inside dw:dh.
void letterbox(int sw, int sh, int dw, int dh, int& x, int& y, int& w, int& h);
}  // namespace detail
}  // namespace gl1
