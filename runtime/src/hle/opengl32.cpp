// opengl32.dll + gdi32!SwapBuffers: the guest-thread side of OpenGL 1.1. Keeps the matrix stacks and
// client-array/immediate-mode state, expands every draw into a flat vertex list, converts texture
// uploads to RGBA8 and records the gl1_cmd.h stream that gles/gl1_exec.cpp replays on the page.
#include <array>
#include <cmath>
#include <cstring>
#include <vector>

#include "../core/objects.h"
#include "../gl1/gl1_cmd.h"
#ifdef __EMSCRIPTEN__
#include "../platform/web.h"
#endif

using namespace rt;

namespace {
const char* kGl = "opengl32.dll";
using Mat = std::array<float, 16>;  // column-major, as GL

constexpr uint32_t GL_MODELVIEW = 0x1700, GL_PROJECTION = 0x1701, GL_TEXTURE = 0x1702;
constexpr uint32_t GL_FLOAT = 0x1406, GL_UBYTE = 0x1401, GL_SHORT = 0x1402, GL_USHORT = 0x1403, GL_INT = 0x1404, GL_UINT = 0x1405;
constexpr uint32_t GL_VERTEX_ARRAY = 0x8074, GL_COLOR_ARRAY = 0x8076, GL_TEXCOORD_ARRAY = 0x8078;

Mat identity() {
  Mat m{};
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
Mat mul(const Mat& a, const Mat& b) {  // a * b
  Mat r{};
  for (int c = 0; c < 4; c++)
    for (int rr = 0; rr < 4; rr++) {
      float s = 0;
      for (int k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      r[c * 4 + rr] = s;
    }
  return r;
}

struct ArrayPtr {
  bool enabled = false;
  uint32_t size = 4, type = GL_FLOAT, stride = 0, ptr = 0;
};

struct State {
  std::vector<uint32_t> words{gl1::kMagic};
  std::vector<Mat> mv{identity()}, proj{identity()};
  uint32_t mode = GL_MODELVIEW;
  float color[4] = {1, 1, 1, 1}, tex[2] = {0, 0};
  ArrayPtr va, ca, ta;
  uint32_t begin_mode = 0;
  bool in_begin = false;
  std::vector<float> verts;  // 9 floats per vertex
  bool imm_color = false, imm_tex = false;
  uint32_t next_tex = 1;
  std::vector<bool> live_tex{false};
  int viewport[4] = {0, 0, 800, 600};
  uint32_t unpack_align = 4, unpack_row = 0;
  int raster[2] = {0, 0};
  float fog[8] = {0x0B65 /*placeholder, replaced below*/, 0, 1, 1, 0, 0, 0, 0};
  uint32_t fog_mode = 0x0801;  // GL_EXP
  uint32_t ctx = 0;
} S;

Mat& cur() { return S.mode == GL_PROJECTION ? S.proj.back() : S.mv.back(); }

uint32_t fbits(float f) { uint32_t b; memcpy(&b, &f, 4); return b; }
float bitsf(uint32_t b) { float f; memcpy(&f, &b, 4); return f; }
double argd(Cpu* c, int i) { uint64_t b = (uint64_t)arg(c, i) | (uint64_t)arg(c, i + 1) << 32; double d; memcpy(&d, &b, 8); return d; }
float argf(Cpu* c, int i) { return bitsf(arg(c, i)); }

void emit(gl1::Op op, std::initializer_list<uint32_t> payload) {
  S.words.push_back(gl1::pack(op, (uint32_t)payload.size()));
  S.words.insert(S.words.end(), payload.begin(), payload.end());
}

void emit_fog() {
  emit(gl1::Op::Fog, {S.fog_mode, fbits(S.fog[1]), fbits(S.fog[2]), fbits(S.fog[3]), fbits(S.fog[4]), fbits(S.fog[5]), fbits(S.fog[6]), fbits(S.fog[7])});
}

void flush(bool present) {
#ifdef __EMSCRIPTEN__
  std::vector<uint32_t> w;
  w.swap(S.words);
  S.words.push_back(gl1::kMagic);
  web::submit(std::move(w), present);
#else
  S.words.resize(1);  // no display natively: drop the batch
  (void)present;
#endif
}

void add_vertex(float x, float y, float z, const float* col, const float* uv) {
  float v[9] = {x, y, z, col[0], col[1], col[2], col[3], uv[0], uv[1]};
  S.verts.insert(S.verts.end(), v, v + 9);
}

void emit_draw(uint32_t mode, uint32_t flags) {
  uint32_t n = (uint32_t)(S.verts.size() / 9);
  if (!n) return;
  S.words.push_back(gl1::pack(gl1::Op::Draw, 3 + 32 + n * 9));  // payload limit is 16 bits: see split below
  S.words.push_back(mode), S.words.push_back(n), S.words.push_back(flags);
  for (float f : S.mv.back()) S.words.push_back(fbits(f));
  for (float f : S.proj.back()) S.words.push_back(fbits(f));
  for (float f : S.verts) S.words.push_back(fbits(f));
  S.verts.clear();
}

// Draw records carry the payload length in 16 bits (65535 words = 7281 vertices): split big draws
// at primitive boundaries so no record overflows.
void emit_draw_split(uint32_t mode, uint32_t flags) {
  uint32_t per = mode == 0x0007 ? 4 : mode == 0x0004 ? 3 : mode == 0x0001 ? 2 : mode == 0x0000 ? 1 : 0;  // QUADS, TRIANGLES, LINES, POINTS
  constexpr uint32_t kMaxVerts = 7000;
  uint32_t n = (uint32_t)(S.verts.size() / 9);
  if (!per || n <= kMaxVerts) return emit_draw(mode, flags);
  uint32_t chunk = kMaxVerts / per * per;
  std::vector<float> all;
  all.swap(S.verts);
  for (uint32_t i = 0; i < n; i += chunk) {
    uint32_t m = std::min(chunk, n - i);
    S.verts.assign(all.begin() + i * 9, all.begin() + (i + m) * 9);
    emit_draw(mode, flags);
  }
}

float read_comp(uint32_t p, uint32_t type, bool norm) {
  switch (type) {
    case GL_FLOAT: return bitsf(ld32(p));
    case GL_UBYTE: return norm ? ld8(p) / 255.0f : (float)ld8(p);
    case GL_SHORT: return (float)(int16_t)ld16(p);
    case GL_INT: return (float)(int32_t)ld32(p);
    default: return 0;
  }
}
uint32_t type_size(uint32_t t) { return t == GL_UBYTE ? 1 : t == GL_SHORT || t == GL_USHORT ? 2 : 4; }

// ---- Pixel formats -> RGBA8 ----------------------------------------------------------------

uint32_t components(uint32_t fmt) {
  switch (fmt) {
    case 0x1907: case 0x80E0: return 3;           // RGB, BGR_EXT
    case 0x1908: case 0x80E1: return 4;           // RGBA, BGRA_EXT
    case 0x1909: case 0x1906: return 1;           // LUMINANCE, ALPHA
    case 0x190A: return 2;                        // LUMINANCE_ALPHA
    default: return 4;
  }
}

std::vector<uint32_t> to_rgba(uint32_t w, uint32_t h, uint32_t fmt, uint32_t type, uint32_t src) {
  std::vector<uint32_t> out((size_t)w * h, 0);
  if (!src) return out;
  bool packed = type == 0x8033 || type == 0x8034 || type == 0x8363;  // 4_4_4_4, 5_5_5_1, 5_6_5
  uint32_t bpp = packed ? 2 : components(fmt) * type_size(type == GL_FLOAT ? GL_FLOAT : GL_UBYTE);
  uint32_t row = S.unpack_row ? S.unpack_row : w;
  uint32_t stride = (row * bpp + S.unpack_align - 1) / S.unpack_align * S.unpack_align;
  for (uint32_t y = 0; y < h; y++) {
    uint32_t p = src + y * stride;
    for (uint32_t x = 0; x < w; x++, p += bpp) {
      uint32_t r = 0, g = 0, b = 0, a = 255;
      if (packed) {
        uint32_t v = ld16(p);
        if (type == 0x8033) r = (v >> 12 & 15) * 17, g = (v >> 8 & 15) * 17, b = (v >> 4 & 15) * 17, a = (v & 15) * 17;
        else if (type == 0x8034) r = (v >> 11 & 31) * 255 / 31, g = (v >> 6 & 31) * 255 / 31, b = (v >> 1 & 31) * 255 / 31, a = (v & 1) * 255;
        else r = (v >> 11 & 31) * 255 / 31, g = (v >> 5 & 63) * 255 / 63, b = (v & 31) * 255 / 31;
      } else {
        auto ch = [&](uint32_t i) { return type == GL_FLOAT ? (uint32_t)std::lround(std::clamp(bitsf(ld32(p + 4 * i)), 0.0f, 1.0f) * 255) : ld8(p + i); };
        switch (fmt) {
          case 0x1907: r = ch(0), g = ch(1), b = ch(2); break;
          case 0x80E0: b = ch(0), g = ch(1), r = ch(2); break;
          case 0x1908: r = ch(0), g = ch(1), b = ch(2), a = ch(3); break;
          case 0x80E1: b = ch(0), g = ch(1), r = ch(2), a = ch(3); break;
          case 0x1909: r = g = b = ch(0); break;
          case 0x1906: r = g = b = 255, a = ch(0); break;  // alpha-only: white with that alpha
          case 0x190A: r = g = b = ch(0), a = ch(1); break;
          default: break;
        }
      }
      out[(size_t)y * w + x] = r | g << 8 | b << 16 | a << 24;
    }
  }
  return out;
}

void emit_image(gl1::Op op, std::initializer_list<uint32_t> head, const std::vector<uint32_t>& px) {
  // Image records can exceed the 16-bit payload field, so the length is stored as a 32-bit word
  // after the header (word0 payload field = 0xFFFF marks "length follows"); see gl1_exec.cpp.
  S.words.push_back(gl1::pack(op, 0xFFFF));
  S.words.push_back((uint32_t)(head.size() + px.size()));
  S.words.insert(S.words.end(), head.begin(), head.end());
  S.words.insert(S.words.end(), px.begin(), px.end());
}
}  // namespace

// ---- State ----------------------------------------------------------------------------------

HLE_STDCALL(kGl, glEnable, 1) { emit(gl1::Op::Enable, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glDisable, 1) { emit(gl1::Op::Disable, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glBlendFunc, 2) { emit(gl1::Op::BlendFunc, {arg(c, 0), arg(c, 1)}); return 0; }
HLE_STDCALL(kGl, glAlphaFunc, 2) { emit(gl1::Op::AlphaFunc, {arg(c, 0), arg(c, 1)}); return 0; }
HLE_STDCALL(kGl, glDepthFunc, 1) { emit(gl1::Op::DepthFunc, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glDepthMask, 1) { emit(gl1::Op::DepthMask, {arg(c, 0) & 0xff}); return 0; }
HLE_STDCALL(kGl, glCullFace, 1) { emit(gl1::Op::CullFace, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glShadeModel, 1) { emit(gl1::Op::ShadeModel, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glDrawBuffer, 1) { emit(gl1::Op::DrawBuffer, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glReadBuffer, 1) { return 0; }
HLE_STDCALL(kGl, glFinish, 0) { emit(gl1::Op::Finish, {}); return 0; }
HLE_STDCALL(kGl, glFlush, 0) { return 0; }
HLE_STDCALL(kGl, glClear, 1) { emit(gl1::Op::Clear, {arg(c, 0)}); return 0; }
HLE_STDCALL(kGl, glClearColor, 4) { emit(gl1::Op::ClearColor, {arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)}); return 0; }
HLE_STDCALL(kGl, glScissor, 4) { emit(gl1::Op::Scissor, {arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)}); return 0; }
HLE_STDCALL(kGl, glViewport, 4) {
  for (int i = 0; i < 4; i++) S.viewport[i] = (int)arg(c, i);
  emit(gl1::Op::Viewport, {arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)});
  return 0;
}
HLE_STDCALL(kGl, glPixelStorei, 2) {
  if (arg(c, 0) == 0x0CF5) S.unpack_align = arg(c, 1);       // GL_UNPACK_ALIGNMENT
  else if (arg(c, 0) == 0x0CF2) S.unpack_row = arg(c, 1);    // GL_UNPACK_ROW_LENGTH
  return 0;
}

HLE_STDCALL(kGl, glFogf, 2) {
  uint32_t p = arg(c, 0);
  float v = argf(c, 1);
  if (p == 0x0B65) S.fog_mode = (uint32_t)v;
  else if (p == 0x0B63) S.fog[1] = v;
  else if (p == 0x0B64) S.fog[2] = v;
  else if (p == 0x0B62) S.fog[3] = v;
  emit_fog();
  return 0;
}
HLE_STDCALL(kGl, glFogi, 2) {
  if (arg(c, 0) == 0x0B65) S.fog_mode = arg(c, 1);
  emit_fog();
  return 0;
}
HLE_STDCALL(kGl, glFogfv, 2) {
  uint32_t p = arg(c, 0), q = arg(c, 1);
  if (p == 0x0B66) for (int i = 0; i < 4; i++) S.fog[4 + i] = bitsf(ld32(q + 4 * i));
  else if (p == 0x0B65) S.fog_mode = (uint32_t)bitsf(ld32(q));
  else if (p == 0x0B63) S.fog[1] = bitsf(ld32(q));
  else if (p == 0x0B64) S.fog[2] = bitsf(ld32(q));
  else if (p == 0x0B62) S.fog[3] = bitsf(ld32(q));
  emit_fog();
  return 0;
}

// ---- Matrices -------------------------------------------------------------------------------

HLE_STDCALL(kGl, glMatrixMode, 1) { S.mode = arg(c, 0); return 0; }
HLE_STDCALL(kGl, glLoadIdentity, 0) { if (S.mode != GL_TEXTURE) cur() = identity(); return 0; }
HLE_STDCALL(kGl, glPushMatrix, 0) {
  auto& st = S.mode == GL_PROJECTION ? S.proj : S.mv;
  if (S.mode != GL_TEXTURE && st.size() < 32) st.push_back(st.back());
  return 0;
}
HLE_STDCALL(kGl, glPopMatrix, 0) {
  auto& st = S.mode == GL_PROJECTION ? S.proj : S.mv;
  if (S.mode != GL_TEXTURE && st.size() > 1) st.pop_back();
  return 0;
}
HLE_STDCALL(kGl, glMultMatrixf, 1) {
  if (S.mode == GL_TEXTURE) return 0;
  Mat m;
  for (int i = 0; i < 16; i++) m[i] = bitsf(ld32(arg(c, 0) + 4 * i));
  cur() = mul(cur(), m);
  return 0;
}
HLE_STDCALL(kGl, glTranslatef, 3) {
  if (S.mode == GL_TEXTURE) return 0;
  Mat m = identity();
  m[12] = argf(c, 0), m[13] = argf(c, 1), m[14] = argf(c, 2);
  cur() = mul(cur(), m);
  return 0;
}
HLE_STDCALL(kGl, glScalef, 3) {
  if (S.mode == GL_TEXTURE) return 0;
  Mat m = identity();
  m[0] = argf(c, 0), m[5] = argf(c, 1), m[10] = argf(c, 2);
  cur() = mul(cur(), m);
  return 0;
}
HLE_STDCALL(kGl, glOrtho, 12) {
  if (S.mode == GL_TEXTURE) return 0;
  double l = argd(c, 0), r = argd(c, 2), b = argd(c, 4), t = argd(c, 6), n = argd(c, 8), f = argd(c, 10);
  Mat m = identity();
  m[0] = (float)(2 / (r - l)), m[5] = (float)(2 / (t - b)), m[10] = (float)(-2 / (f - n));
  m[12] = (float)(-(r + l) / (r - l)), m[13] = (float)(-(t + b) / (t - b)), m[14] = (float)(-(f + n) / (f - n));
  cur() = mul(cur(), m);
  return 0;
}
HLE_STDCALL(kGl, glFrustum, 12) {
  if (S.mode == GL_TEXTURE) return 0;
  double l = argd(c, 0), r = argd(c, 2), b = argd(c, 4), t = argd(c, 6), n = argd(c, 8), f = argd(c, 10);
  Mat m{};
  m[0] = (float)(2 * n / (r - l)), m[5] = (float)(2 * n / (t - b));
  m[8] = (float)((r + l) / (r - l)), m[9] = (float)((t + b) / (t - b)), m[10] = (float)(-(f + n) / (f - n)), m[11] = -1;
  m[14] = (float)(-2 * f * n / (f - n));
  cur() = mul(cur(), m);
  return 0;
}

// ---- Immediate mode and client arrays -------------------------------------------------------

HLE_STDCALL(kGl, glColor4f, 4) { for (int i = 0; i < 4; i++) S.color[i] = argf(c, i); S.imm_color = true; return 0; }
HLE_STDCALL(kGl, glColor3fv, 1) { for (int i = 0; i < 3; i++) S.color[i] = bitsf(ld32(arg(c, 0) + 4 * i)); S.color[3] = 1; S.imm_color = true; return 0; }
HLE_STDCALL(kGl, glColor4fv, 1) { for (int i = 0; i < 4; i++) S.color[i] = bitsf(ld32(arg(c, 0) + 4 * i)); S.imm_color = true; return 0; }
HLE_STDCALL(kGl, glColor4ub, 4) { for (int i = 0; i < 4; i++) S.color[i] = (arg(c, i) & 0xff) / 255.0f; S.imm_color = true; return 0; }
HLE_STDCALL(kGl, glTexCoord2f, 2) { S.tex[0] = argf(c, 0), S.tex[1] = argf(c, 1); S.imm_tex = true; return 0; }
HLE_STDCALL(kGl, glTexCoord2fv, 1) { S.tex[0] = bitsf(ld32(arg(c, 0))), S.tex[1] = bitsf(ld32(arg(c, 0) + 4)); S.imm_tex = true; return 0; }

HLE_STDCALL(kGl, glBegin, 1) {
  S.begin_mode = arg(c, 0);
  S.in_begin = true;
  S.verts.clear();
  S.imm_color = S.imm_tex = false;
  return 0;
}
HLE_STDCALL(kGl, glVertex3f, 3) {
  if (S.in_begin) add_vertex(argf(c, 0), argf(c, 1), argf(c, 2), S.color, S.tex);
  return 0;
}
HLE_STDCALL(kGl, glVertex2f, 2) {
  if (S.in_begin) add_vertex(argf(c, 0), argf(c, 1), 0, S.color, S.tex);
  return 0;
}
HLE_STDCALL(kGl, glVertex3fv, 1) {
  uint32_t p = arg(c, 0);
  if (S.in_begin) add_vertex(bitsf(ld32(p)), bitsf(ld32(p + 4)), bitsf(ld32(p + 8)), S.color, S.tex);
  return 0;
}
HLE_STDCALL(kGl, glEnd, 0) {
  if (!S.in_begin) return 0;
  S.in_begin = false;
  emit_draw_split(S.begin_mode, gl1::kHasColor | gl1::kHasTex);  // current color/texcoord are baked into every vertex
  return 0;
}

HLE_STDCALL(kGl, glEnableClientState, 1) {
  uint32_t a = arg(c, 0);
  (a == GL_VERTEX_ARRAY ? S.va : a == GL_COLOR_ARRAY ? S.ca : S.ta).enabled = a == GL_VERTEX_ARRAY || a == GL_COLOR_ARRAY || a == GL_TEXCOORD_ARRAY;
  return 0;
}
HLE_STDCALL(kGl, glDisableClientState, 1) {
  uint32_t a = arg(c, 0);
  if (a == GL_VERTEX_ARRAY) S.va.enabled = false;
  else if (a == GL_COLOR_ARRAY) S.ca.enabled = false;
  else if (a == GL_TEXCOORD_ARRAY) S.ta.enabled = false;
  return 0;
}
HLE_STDCALL(kGl, glVertexPointer, 4) { bool e = S.va.enabled; S.va = {e, arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)}; return 0; }
HLE_STDCALL(kGl, glColorPointer, 4) { bool e = S.ca.enabled; S.ca = {e, arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)}; return 0; }
HLE_STDCALL(kGl, glTexCoordPointer, 4) { bool e = S.ta.enabled; S.ta = {e, arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3)}; return 0; }

HLE_STDCALL(kGl, glDrawElements, 4) {
  uint32_t mode = arg(c, 0), count = arg(c, 1), itype = arg(c, 2), ip = arg(c, 3);
  if (!S.va.enabled || !S.va.ptr) return 0;
  S.verts.clear();
  uint32_t isz = type_size(itype);
  for (uint32_t i = 0; i < count; i++) {
    uint32_t idx = isz == 1 ? ld8(ip + i) : isz == 2 ? ld16(ip + 2 * i) : ld32(ip + 4 * i);
    uint32_t vp = S.va.ptr + idx * (S.va.stride ? S.va.stride : S.va.size * type_size(S.va.type));
    float col[4] = {S.color[0], S.color[1], S.color[2], S.color[3]}, uv[2] = {0, 0};
    float x = read_comp(vp, S.va.type, false), y = read_comp(vp + type_size(S.va.type), S.va.type, false);
    float z = S.va.size >= 3 ? read_comp(vp + 2 * type_size(S.va.type), S.va.type, false) : 0;
    if (S.ca.enabled && S.ca.ptr) {
      uint32_t cp = S.ca.ptr + idx * (S.ca.stride ? S.ca.stride : S.ca.size * type_size(S.ca.type));
      for (uint32_t k = 0; k < 4; k++) col[k] = k < S.ca.size ? read_comp(cp + k * type_size(S.ca.type), S.ca.type, true) : 1.0f;
    }
    if (S.ta.enabled && S.ta.ptr) {
      uint32_t tp = S.ta.ptr + idx * (S.ta.stride ? S.ta.stride : S.ta.size * type_size(S.ta.type));
      uv[0] = read_comp(tp, S.ta.type, false), uv[1] = read_comp(tp + type_size(S.ta.type), S.ta.type, false);
    }
    add_vertex(x, y, z, col, uv);
  }
  emit_draw_split(mode, gl1::kHasColor | gl1::kHasTex);
  return 0;
}

// ---- Textures -------------------------------------------------------------------------------

HLE_STDCALL(kGl, glGenTextures, 2) {
  for (uint32_t i = 0; i < arg(c, 0); i++) {
    uint32_t id = S.next_tex++;
    if (S.live_tex.size() <= id) S.live_tex.resize(id + 64, false);
    S.live_tex[id] = true;
    st32(arg(c, 1) + 4 * i, id);
  }
  return 0;
}
HLE_STDCALL(kGl, glDeleteTextures, 2) {
  for (uint32_t i = 0; i < arg(c, 0); i++) {
    uint32_t id = ld32(arg(c, 1) + 4 * i);
    if (id && id < S.live_tex.size()) S.live_tex[id] = false, emit(gl1::Op::DeleteTexture, {id});
  }
  return 0;
}
HLE_STDCALL(kGl, glIsTexture, 1) { return arg(c, 0) && arg(c, 0) < S.live_tex.size() && S.live_tex[arg(c, 0)]; }
HLE_STDCALL(kGl, glBindTexture, 2) {
  uint32_t id = arg(c, 1);
  if (id >= S.live_tex.size()) S.live_tex.resize(id + 64, false);
  S.live_tex[id] = id != 0;
  emit(gl1::Op::BindTexture, {id});
  return 0;
}
HLE_STDCALL(kGl, glTexParameteri, 3) { emit(gl1::Op::TexParameter, {arg(c, 1), arg(c, 2)}); return 0; }
HLE_STDCALL(kGl, glTexEnvi, 3) { if (arg(c, 1) == 0x2200) emit(gl1::Op::TexEnv, {arg(c, 2)}); return 0; }
HLE_STDCALL(kGl, glTexEnvf, 3) { if (arg(c, 1) == 0x2200) emit(gl1::Op::TexEnv, {(uint32_t)argf(c, 2)}); return 0; }
HLE_STDCALL(kGl, glTexImage2D, 9) {
  uint32_t level = arg(c, 1), w = arg(c, 3), h = arg(c, 4);
  emit_image(gl1::Op::TexImage2D, {level, w, h}, to_rgba(w, h, arg(c, 6), arg(c, 7), arg(c, 8)));
  return 0;
}
HLE_STDCALL(kGl, glTexSubImage2D, 9) {
  uint32_t w = arg(c, 4), h = arg(c, 5);
  emit_image(gl1::Op::TexSubImage2D, {arg(c, 1), arg(c, 2), arg(c, 3), w, h}, to_rgba(w, h, arg(c, 6), arg(c, 7), arg(c, 8)));
  return 0;
}

// ---- Raster ops -----------------------------------------------------------------------------

HLE_STDCALL(kGl, glRasterPos2i, 2) {
  // Through modelview and projection to window coordinates (Hitman uses it under an orthographic 2D setup).
  Mat m = mul(S.proj.back(), S.mv.back());
  float x = (float)(int32_t)arg(c, 0), y = (float)(int32_t)arg(c, 1);
  float cx = m[0] * x + m[4] * y + m[12], cy = m[1] * x + m[5] * y + m[13], cw = m[3] * x + m[7] * y + m[15];
  if (cw == 0) cw = 1;
  S.raster[0] = S.viewport[0] + (int)((cx / cw * 0.5f + 0.5f) * S.viewport[2]);
  S.raster[1] = S.viewport[1] + (int)((cy / cw * 0.5f + 0.5f) * S.viewport[3]);
  return 0;
}
HLE_STDCALL(kGl, glDrawPixels, 5) {
  uint32_t w = arg(c, 0), h = arg(c, 1);
  emit_image(gl1::Op::DrawPixels, {(uint32_t)S.raster[0], (uint32_t)S.raster[1], w, h}, to_rgba(w, h, arg(c, 2), arg(c, 3), arg(c, 4)));
  return 0;
}
HLE_STDCALL(kGl, glReadPixels, 7) {
  uint32_t x = arg(c, 0), y = arg(c, 1), w = arg(c, 2), h = arg(c, 3), fmt = arg(c, 4), dst = arg(c, 6);
  if (fmt != 0x1908) {  // only RGBA/UNSIGNED_BYTE readback is supported by the executor
    static bool warned = false;
    if (!warned) warned = true, log(Log::Warn, "glReadPixels: format 0x%x unsupported (RGBA only)", fmt);
    return 0;
  }
  emit(gl1::Op::ReadPixels, {x, y, w, h, dst});
#ifdef __EMSCRIPTEN__
  std::vector<uint32_t> wds;
  wds.swap(S.words);
  S.words.push_back(gl1::kMagic);
  web::submit_and_wait(std::move(wds));
#endif
  return 0;
}

// ---- Queries and WGL ------------------------------------------------------------------------

HLE_STDCALL(kGl, glGetString, 1) {
  static uint32_t s_vendor = 0, s_renderer = 0, s_version = 0, s_ext = 0;
  if (!s_vendor) {
    auto mk = [](const char* t) { uint32_t p = sys_alloc((uint32_t)strlen(t) + 1); write_cstr(p, t); return p; };
    s_vendor = mk("Hitman Web"), s_renderer = mk("WebGL2"), s_version = mk("1.4"), s_ext = mk("GL_EXT_bgra GL_EXT_texture_env_add");
  }
  switch (arg(c, 0)) {
    case 0x1F00: return s_vendor;
    case 0x1F01: return s_renderer;
    case 0x1F02: return s_version;
    case 0x1F03: return s_ext;
    default: return 0;
  }
}
HLE_STDCALL(kGl, glGetIntegerv, 2) {
  uint32_t p = arg(c, 1);
  switch (arg(c, 0)) {
    case 0x0BA2: for (int i = 0; i < 4; i++) st32(p + 4 * i, (uint32_t)S.viewport[i]); break;  // GL_VIEWPORT
    case 0x0D33: st32(p, 2048); break;  // GL_MAX_TEXTURE_SIZE
    case 0x84E2: st32(p, 1); break;     // GL_MAX_TEXTURE_UNITS
    case 0x0D56: st32(p, 24); break;    // GL_DEPTH_BITS
    case 0x0D52: case 0x0D53: case 0x0D54: case 0x0D55: st32(p, 8); break;  // R/G/B/A bits
    default: st32(p, 0); break;
  }
  return 0;
}
HLE_STDCALL(kGl, wglCreateContext, 1) { return 0x00020001; }
HLE_STDCALL(kGl, wglDeleteContext, 1) { return 1; }
HLE_STDCALL(kGl, wglMakeCurrent, 2) { S.ctx = arg(c, 1); return 1; }
HLE_STDCALL(kGl, wglGetCurrentContext, 0) { return S.ctx; }
HLE_STDCALL(kGl, wglGetCurrentDC, 0) { return S.ctx ? 0x00010020 : 0; }
HLE_STDCALL(kGl, wglShareLists, 2) { return 1; }
HLE_STDCALL(kGl, wglGetProcAddress, 1) { return 0; }

HLE_STDCALL("gdi32.dll", SwapBuffers, 1) {
  emit(gl1::Op::Present, {});
  flush(true);
  return 1;
}
