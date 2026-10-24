#include "gl1_exec.h"

#include <cstring>

#include "../gl1/gl1_cmd.h"

#ifndef GL1_NO_GL
#include <GLES3/gl3.h>
#include "../core/rt.h"
#include "../platform/platform.h"
#endif

namespace gl1 {
namespace detail {

bool next_record(const uint32_t*& cur, const uint32_t* end, Record& r) {
  while (cur < end && *cur == kMagic) cur++;
  if (cur >= end) return false;
  uint32_t w = *cur;
  uint32_t n = w & 0xffff;
  size_t hdr = 1;
  if (n == 0xffff) {  // long record (image uploads): the next word is the payload length
    if (end - cur < 2) return false;
    n = cur[1];
    hdr = 2;
  }
  if ((size_t)(end - cur) < hdr + (size_t)n) return false;
  r = {(uint16_t)(w >> 16), n, cur + hdr};
  cur += hdr + n;
  return true;
}

bool expand_indices(uint32_t mode, uint32_t n, std::vector<uint32_t>& out) {
  out.clear();
  switch (mode) {
    case 0x0007:  // GL_QUADS
      for (uint32_t i = 0; i + 3 < n; i += 4) {
        uint32_t q[6] = {i, i + 1, i + 2, i, i + 2, i + 3};
        out.insert(out.end(), q, q + 6);
      }
      return true;
    case 0x0008:  // GL_QUAD_STRIP: vertices (0 1 3 2), (2 3 5 4), ...
      for (uint32_t i = 0; i + 3 < n; i += 2) {
        uint32_t q[6] = {i, i + 1, i + 2, i + 2, i + 1, i + 3};
        out.insert(out.end(), q, q + 6);
      }
      return true;
    case 0x0009:  // GL_POLYGON: convex fan
      for (uint32_t i = 1; i + 1 < n; i++) {
        uint32_t t[3] = {0, i, i + 1};
        out.insert(out.end(), t, t + 3);
      }
      return true;
  }
  return false;
}

uint32_t map_wrap(uint32_t e) {
  switch (e) {
    case 0x2901: return 0x2901;  // REPEAT
    case 0x8370: return 0x8370;  // MIRRORED_REPEAT
    default: return 0x812F;      // GL_CLAMP / CLAMP_TO_EDGE / CLAMP_TO_BORDER
  }
}

bool is_mipmap_filter(uint32_t e) { return e >= 0x2700 && e <= 0x2703; }

uint32_t map_blend_factor(uint32_t e) {
  // ZERO, ONE, SRC_COLOR..SRC_ALPHA_SATURATE (0x300-0x308) are valid in GLES; constant colors are not on the wire.
  if (e == 0 || e == 1 || (e >= 0x300 && e <= 0x308)) return e;
  return 0;
}

bool is_valid_cap(uint32_t e) { return e == 0x0B71 || e == 0x0BE2 || e == 0x0B44 || e == 0x0C11 || e == 0x0B90; }

void letterbox(int sw, int sh, int dw, int dh, int& x, int& y, int& w, int& h) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) { x = y = 0; w = dw; h = dh; return; }
  if ((int64_t)dw * sh >= (int64_t)dh * sw) { h = dh; w = (int)((int64_t)dh * sw / sh); }
  else { w = dw; h = (int)((int64_t)dw * sh / sw); }
  x = (dw - w) / 2;
  y = (dh - h) / 2;
}

}  // namespace detail
}  // namespace gl1

#ifdef GL1_NO_GL
namespace gl1 {
void execute(const uint32_t*, size_t) {}
void shutdown() {}
void set_canvas_size_provider(void (*)(int*, int*)) {}
}  // namespace gl1
#else

#include <unordered_map>

namespace gl1 {
namespace {

const char* kVs = R"(#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
layout(location=2) in vec2 aUv;
uniform mat4 uMv;
uniform mat4 uProj;
out vec4 vColor;
out vec2 vUv;
out float vEyeZ;
void main() {
  vec4 eye = uMv * vec4(aPos, 1.0);
  vEyeZ = eye.z;
  vColor = aColor;
  vUv = aUv;
  gl_Position = uProj * eye;
})";

const char* kFs = R"(#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vUv;
in float vEyeZ;
uniform sampler2D uTex;
uniform int uTexEnv;     // 0 REPLACE 1 MODULATE 2 DECAL 3 BLEND
uniform int uHasTex;
uniform int uAlphaFunc;  // 0 = off, else GL_NEVER..GL_ALWAYS - 0x200 + 1
uniform float uAlphaRef;
uniform int uFogMode;    // 0 off 1 LINEAR 2 EXP 3 EXP2
uniform float uFogStart;
uniform float uFogEnd;
uniform float uFogDensity;
uniform vec4 uFogColor;
out vec4 oColor;
void main() {
  vec4 c = vColor;
  if (uHasTex != 0) {
    vec4 t = texture(uTex, vUv);
    if (uTexEnv == 0) c = t;
    else if (uTexEnv == 1) c *= t;
    else if (uTexEnv == 2) c = vec4(mix(c.rgb, t.rgb, t.a), c.a);
    else c = vec4(mix(c.rgb, uFogColor.rgb, t.rgb), c.a * t.a);
  }
  if (uAlphaFunc != 0) {
    bool pass = true;
    if (uAlphaFunc == 1) pass = false;
    else if (uAlphaFunc == 2) pass = c.a < uAlphaRef;
    else if (uAlphaFunc == 3) pass = c.a == uAlphaRef;
    else if (uAlphaFunc == 4) pass = c.a <= uAlphaRef;
    else if (uAlphaFunc == 5) pass = c.a > uAlphaRef;
    else if (uAlphaFunc == 6) pass = c.a != uAlphaRef;
    else if (uAlphaFunc == 7) pass = c.a >= uAlphaRef;
    if (!pass) discard;
  }
  if (uFogMode != 0) {
    float d = abs(vEyeZ);
    float f;
    if (uFogMode == 1) f = (uFogEnd - d) / max(uFogEnd - uFogStart, 1e-6);
    else if (uFogMode == 2) f = exp(-uFogDensity * d);
    else f = exp(-(uFogDensity * d) * (uFogDensity * d));
    c.rgb = mix(uFogColor.rgb, c.rgb, clamp(f, 0.0, 1.0));
  }
  oColor = c;
})";

struct Tex {
  GLuint name = 0;
  uint32_t minFilter = 0x2703;  // GL default
};

struct Uniforms {
  GLint mv, proj, tex, texEnv, hasTex, alphaFunc, alphaRef, fogMode, fogStart, fogEnd, fogDensity, fogColor;
};

struct State {
  bool inited = false;
  GLuint prog = 0, vbo = 0, vao = 0, ibo = 0, fbo = 0, color = 0, depth = 0, scratchTex = 0;
  Uniforms u{};
  int w = 800, h = 600;
  bool sizeLocked = false;
  std::unordered_map<uint32_t, Tex> tex;
  GLuint bound = 0;  // guest id
  uint32_t texEnv = 1;
  bool texture2d = false, alphaTest = false, fog = false;
  uint32_t alphaFunc = 0x207;
  float alphaRef = 0;
  uint32_t fogMode = 0x0800;
  float fogStart = 0, fogEnd = 1, fogDensity = 1, fogColor[4] = {0, 0, 0, 0};
  std::vector<uint32_t> idx;
  void (*canvas)(int*, int*) = nullptr;
} S;

float f32(uint32_t w) { float f; memcpy(&f, &w, 4); return f; }

GLuint compile(GLenum type, const char* src) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, nullptr);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[1024];
    glGetShaderInfoLog(s, sizeof log, nullptr, log);
    rt::log(rt::Log::Error, "GL1 shader: %s", log);
  }
  return s;
}

void init() {
  S.inited = true;
  GLuint vs = compile(GL_VERTEX_SHADER, kVs), fs = compile(GL_FRAGMENT_SHADER, kFs);
  S.prog = glCreateProgram();
  glAttachShader(S.prog, vs);
  glAttachShader(S.prog, fs);
  glLinkProgram(S.prog);
  glDeleteShader(vs);
  glDeleteShader(fs);
  auto L = [](const char* n) { return glGetUniformLocation(S.prog, n); };
  S.u = {L("uMv"), L("uProj"), L("uTex"), L("uTexEnv"), L("uHasTex"), L("uAlphaFunc"), L("uAlphaRef"),
         L("uFogMode"), L("uFogStart"), L("uFogEnd"), L("uFogDensity"), L("uFogColor")};

  glGenVertexArrays(1, &S.vao);
  glBindVertexArray(S.vao);
  glGenBuffers(1, &S.vbo);
  glGenBuffers(1, &S.ibo);
  glBindBuffer(GL_ARRAY_BUFFER, S.vbo);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, S.ibo);
  const GLsizei stride = 9 * 4;
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, (void*)0);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, stride, (void*)12);
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, stride, (void*)28);

  glGenTextures(1, &S.color);
  glBindTexture(GL_TEXTURE_2D, S.color);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, S.w, S.h);
  glGenRenderbuffers(1, &S.depth);
  glBindRenderbuffer(GL_RENDERBUFFER, S.depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, S.w, S.h);
  glGenFramebuffers(1, &S.fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, S.fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, S.color, 0);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, S.depth);
  glViewport(0, 0, S.w, S.h);
  glGenTextures(1, &S.scratchTex);
  glClearColor(0, 0, 0, 0);
}

// The offscreen target grows to the largest viewport the game asks for (it first sets a cinematic
// letterbox viewport, then the full window), so the presented image keeps the window's aspect.
void resize_target(int w, int h) {
  S.w = w, S.h = h;
  glDeleteTextures(1, &S.color);
  glDeleteRenderbuffers(1, &S.depth);
  glGenTextures(1, &S.color);
  glBindTexture(GL_TEXTURE_2D, S.color);
  glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, S.w, S.h);
  glGenRenderbuffers(1, &S.depth);
  glBindRenderbuffer(GL_RENDERBUFFER, S.depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, S.w, S.h);
  glBindFramebuffer(GL_FRAMEBUFFER, S.fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, S.color, 0);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, S.depth);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

void bind_guest_tex() {
  auto it = S.tex.find(S.bound);
  glBindTexture(GL_TEXTURE_2D, it == S.tex.end() ? 0 : it->second.name);
}

Tex& cur_tex() {
  Tex& t = S.tex[S.bound];
  if (!t.name) {
    glGenTextures(1, &t.name);
    glBindTexture(GL_TEXTURE_2D, t.name);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST_MIPMAP_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
  }
  return t;
}

void set_cap(GLenum cap, bool on) {
  if (on) glEnable(cap); else glDisable(cap);
}

void apply_uniforms(const float* mv, const float* proj, bool hasTex, bool fixedState) {
  glUniformMatrix4fv(S.u.mv, 1, GL_FALSE, mv);
  glUniformMatrix4fv(S.u.proj, 1, GL_FALSE, proj);
  glUniform1i(S.u.tex, 0);
  glUniform1i(S.u.hasTex, hasTex);
  glUniform1i(S.u.texEnv, fixedState ? (S.texEnv == 0x1E01 ? 0 : S.texEnv == 0x2100 ? 1 : S.texEnv == 0x2101 ? 2 : S.texEnv == 0x0BE2 ? 3 : 1) : 0);
  glUniform1i(S.u.alphaFunc, fixedState && S.alphaTest ? (int)(S.alphaFunc - 0x200 + 1) : 0);
  glUniform1f(S.u.alphaRef, S.alphaRef);
  glUniform1i(S.u.fogMode, fixedState && S.fog ? (S.fogMode == 0x0801 ? 2 : S.fogMode == 0x2601 ? 1 : 3) : 0);
  glUniform1f(S.u.fogStart, S.fogStart);
  glUniform1f(S.u.fogEnd, S.fogEnd);
  glUniform1f(S.u.fogDensity, S.fogDensity);
  glUniform4fv(S.u.fogColor, 1, S.fogColor);
}

void draw(const uint32_t* p, uint32_t n) {
  if (n < 35) return;
  uint32_t mode = p[0], nv = p[1], flags = p[2];
  if (n < 35 + (size_t)nv * 9 || nv == 0) return;
  float mv[16], proj[16];
  for (int i = 0; i < 16; i++) { mv[i] = f32(p[3 + i]); proj[i] = f32(p[19 + i]); }
  const uint32_t* v = p + 35;
  bool hasTex = (flags & kHasTex) && S.texture2d && S.tex.count(S.bound);
  glUseProgram(S.prog);
  apply_uniforms(mv, proj, hasTex, true);
  glActiveTexture(GL_TEXTURE0);
  bind_guest_tex();
  glBindVertexArray(S.vao);
  glBindBuffer(GL_ARRAY_BUFFER, S.vbo);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)nv * 36, v, GL_STREAM_DRAW);
  if (detail::expand_indices(mode, nv, S.idx)) {
    if (S.idx.empty()) return;
    glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)S.idx.size() * 4, S.idx.data(), GL_STREAM_DRAW);
    glDrawElements(GL_TRIANGLES, (GLsizei)S.idx.size(), GL_UNSIGNED_INT, nullptr);
  } else if (mode <= 6) {  // POINTS..TRIANGLE_FAN share GL's numbering
    glDrawArrays(mode, 0, nv);
  }
}

void draw_pixels(const uint32_t* p, uint32_t n) {
  if (n < 4) return;
  int rx = (int)p[0], ry = (int)p[1], w = (int)p[2], h = (int)p[3];
  if (w <= 0 || h <= 0 || n < 4 + (size_t)w * h) return;
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(GL_TEXTURE_2D, S.scratchTex);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, p + 4);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  float id[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
  float ortho[16] = {2.f / S.w, 0, 0, 0, 0, 2.f / S.h, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1};
  glUseProgram(S.prog);
  apply_uniforms(id, ortho, true, false);
  float x0 = (float)rx, y0 = (float)ry, x1 = x0 + w, y1 = y0 + h;
  // Rows arrive bottom-to-top, matching GL's t = 0 at the first row.
  float q[4][9] = {{x0, y0, 0, 1, 1, 1, 1, 0, 0}, {x1, y0, 0, 1, 1, 1, 1, 1, 0},
                   {x1, y1, 0, 1, 1, 1, 1, 1, 1}, {x0, y1, 0, 1, 1, 1, 1, 0, 1}};
  glBindVertexArray(S.vao);
  glBindBuffer(GL_ARRAY_BUFFER, S.vbo);
  glBufferData(GL_ARRAY_BUFFER, sizeof q, q, GL_STREAM_DRAW);
  glDisable(GL_CULL_FACE);
  glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
  bind_guest_tex();
}

void present() {
  int cw = 800, ch = 600;
  if (S.canvas) S.canvas(&cw, &ch);
  int x, y, w, h;
  detail::letterbox(S.w, S.h, cw, ch, x, y, w, h);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, S.fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glDisable(GL_SCISSOR_TEST);
  glClearColor(0, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT);
  glBlitFramebuffer(0, 0, S.w, S.h, x, y, x + w, y + h, GL_COLOR_BUFFER_BIT, GL_LINEAR);
  glBindFramebuffer(GL_FRAMEBUFFER, S.fbo);
}

void op(const detail::Record& r) {
  const uint32_t* p = r.p;
  uint32_t n = r.n;
  switch ((Op)r.op) {
    case Op::Draw: draw(p, n); break;
    case Op::Clear: if (n >= 1) { GLbitfield m = 0; if (p[0] & 0x4000) m |= GL_COLOR_BUFFER_BIT; if (p[0] & 0x100) m |= GL_DEPTH_BUFFER_BIT; if (p[0] & 0x400) m |= GL_STENCIL_BUFFER_BIT; glClear(m); } break;
    case Op::ClearColor: if (n >= 4) glClearColor(f32(p[0]), f32(p[1]), f32(p[2]), f32(p[3])); break;
    case Op::Enable:
    case Op::Disable: {
      if (n < 1) break;
      bool on = (Op)r.op == Op::Enable;
      if (p[0] == 0x0DE1) S.texture2d = on;
      else if (p[0] == 0x0BC0) S.alphaTest = on;
      else if (p[0] == 0x0B60) S.fog = on;
      else if (detail::is_valid_cap(p[0])) set_cap(p[0], on);
      break;
    }
    case Op::BlendFunc: if (n >= 2) { uint32_t s = detail::map_blend_factor(p[0]), d = detail::map_blend_factor(p[1]); if ((s || p[0] == 0) && (d || p[1] == 0)) glBlendFunc(s, d); } break;
    case Op::AlphaFunc: if (n >= 2 && p[0] >= 0x200 && p[0] <= 0x207) { S.alphaFunc = p[0]; S.alphaRef = f32(p[1]); } break;
    case Op::DepthFunc: if (n >= 1 && p[0] >= 0x200 && p[0] <= 0x207) glDepthFunc(p[0]); break;
    case Op::DepthMask: if (n >= 1) glDepthMask(p[0] ? GL_TRUE : GL_FALSE); break;
    case Op::CullFace: if (n >= 1) glCullFace(p[0]); break;
    case Op::ShadeModel: break;  // flat shading unsupported: GLES3 has no global switch; smooth is always used
    case Op::Viewport:
      if (n >= 4) {
        int w = (int)p[2], h = (int)p[3];
        if ((w > S.w || h > S.h) && w > 0 && h > 0 && w <= 4096 && h <= 4096) resize_target(std::max(w, S.w), std::max(h, S.h));
        glViewport((int)p[0], (int)p[1], w, h);
        bind_guest_tex();
      }
      break;
    case Op::Scissor: if (n >= 4) glScissor((int)p[0], (int)p[1], (int)p[2], (int)p[3]); break;
    case Op::Fog:
      if (n >= 8) {
        S.fogMode = p[0]; S.fogStart = f32(p[1]); S.fogEnd = f32(p[2]); S.fogDensity = f32(p[3]);
        for (int i = 0; i < 4; i++) S.fogColor[i] = f32(p[4 + i]);
      }
      break;
    case Op::TexEnv: if (n >= 1) S.texEnv = p[0]; break;
    case Op::BindTexture: if (n >= 1) { S.bound = p[0]; if (p[0]) cur_tex(); bind_guest_tex(); } break;
    case Op::DeleteTexture:
      if (n >= 1) {
        auto it = S.tex.find(p[0]);
        if (it != S.tex.end()) { glDeleteTextures(1, &it->second.name); S.tex.erase(it); }
        if (S.bound == p[0]) { S.bound = 0; glBindTexture(GL_TEXTURE_2D, 0); }
      }
      break;
    case Op::TexParameter:
      if (n >= 2 && S.bound) {
        Tex& t = cur_tex();
        glBindTexture(GL_TEXTURE_2D, t.name);
        if (p[0] == 0x2801) {  // MIN
          t.minFilter = p[1];
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, (GLint)p[1]);
        } else if (p[0] == 0x2800) {
          glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, p[1] == 0x2600 ? GL_NEAREST : GL_LINEAR);
        } else if (p[0] == 0x2802 || p[0] == 0x2803) {
          glTexParameteri(GL_TEXTURE_2D, p[0], (GLint)detail::map_wrap(p[1]));
        }
      }
      break;
    case Op::TexImage2D:
      if (n >= 3 && S.bound && p[0] == 0 && n >= 3 + (size_t)p[1] * p[2]) {  // only level 0: mips are generated
        Tex& t = cur_tex();
        glBindTexture(GL_TEXTURE_2D, t.name);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, (int)p[1], (int)p[2], 0, GL_RGBA, GL_UNSIGNED_BYTE, p + 3);
        if (detail::is_mipmap_filter(t.minFilter)) glGenerateMipmap(GL_TEXTURE_2D);
      }
      break;
    case Op::TexSubImage2D:
      if (n >= 5 && S.bound && p[0] == 0 && n >= 5 + (size_t)p[3] * p[4]) {
        Tex& t = cur_tex();
        glBindTexture(GL_TEXTURE_2D, t.name);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
        glTexSubImage2D(GL_TEXTURE_2D, 0, (int)p[1], (int)p[2], (int)p[3], (int)p[4], GL_RGBA, GL_UNSIGNED_BYTE, p + 5);
        if (detail::is_mipmap_filter(t.minFilter)) glGenerateMipmap(GL_TEXTURE_2D);
      }
      break;
    case Op::DrawPixels: draw_pixels(p, n); break;
    case Op::ReadPixels:
      if (n >= 5) {
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels((int)p[0], (int)p[1], (int)p[2], (int)p[3], GL_RGBA, GL_UNSIGNED_BYTE, rt::host(p[4]));
      }
      break;
    case Op::Present: present(); break;
    case Op::DrawBuffer: break;  // always the offscreen FBO
    case Op::Finish: glFinish(); break;
  }
}

}  // namespace

void set_canvas_size_provider(void (*fn)(int*, int*)) { S.canvas = fn; }

void execute(const uint32_t* words, size_t n) {
  const uint32_t* cur = words;
  const uint32_t* end = words + n;
  detail::Record r;
  while (detail::next_record(cur, end, r)) {
    // The FBO takes the first Viewport's size, so peek before creating it.
    if (!S.inited) {
      if ((Op)r.op == Op::Viewport && r.n >= 4 && (int)r.p[2] > 0 && (int)r.p[3] > 0) { S.w = (int)r.p[2]; S.h = (int)r.p[3]; }
      init();
    }
    op(r);
  }
}

void shutdown() {
  if (!S.inited) return;
  for (auto& kv : S.tex) glDeleteTextures(1, &kv.second.name);
  S.tex.clear();
  glDeleteTextures(1, &S.color);
  glDeleteTextures(1, &S.scratchTex);
  glDeleteRenderbuffers(1, &S.depth);
  glDeleteFramebuffers(1, &S.fbo);
  glDeleteBuffers(1, &S.vbo);
  glDeleteBuffers(1, &S.ibo);
  glDeleteVertexArrays(1, &S.vao);
  glDeleteProgram(S.prog);
  S.inited = false;
}

}  // namespace gl1
#endif
