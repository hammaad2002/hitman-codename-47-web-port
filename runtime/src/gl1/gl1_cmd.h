// OpenGL 1.1 command stream: the guest-thread side (hle/opengl32.cpp) records these commands into a
// std::vector<uint32_t>; the page's main thread (gles/gl1_exec.cpp) replays them with GLES3/WebGL2.
// Layout: word0 = (op << 16) | payload_words, then payload_words 32-bit words. Floats are carried as
// their IEEE bit pattern. Long records (image uploads) set the payload field to 0xFFFF and carry the real
// payload length in the next word. A batch is routed to the GL1 executor when its first word is kGl1Magic.
#pragma once
#include <cstdint>

namespace gl1 {

constexpr uint32_t kMagic = 0x474c3100;  // 'GL1\0': first word of a batch (a lone word, payload 0)

// GL enums used on the wire (the real GL values, so the HLE can pass them through).
// Vertex format flags of Op::Draw.
enum DrawFlags : uint32_t { kHasColor = 1, kHasTex = 2 };

enum class Op : uint16_t {
  // Stateless-per-draw: matrices travel with every Draw, so the executor keeps no matrix stack.
  Draw = 1,         // [mode, nverts, flags, mv[16], proj[16], nverts * (x y z r g b a s t)]; flat vertex list
                    // (glDrawElements / Begin..End are already expanded by the HLE). mode: GL_POINTS..GL_QUAD_STRIP.
                    // r g b a are floats 0..1 (current color if kHasColor is unset); s t = 0 if kHasTex unset.
  Clear = 2,        // [mask]
  ClearColor = 3,   // [r g b a floats]
  Enable = 4,       // [cap]      GL_TEXTURE_2D, GL_BLEND, GL_DEPTH_TEST, GL_ALPHA_TEST, GL_CULL_FACE, GL_FOG, GL_SCISSOR_TEST
  Disable = 5,      // [cap]
  BlendFunc = 6,    // [src, dst]
  AlphaFunc = 7,    // [func, ref float]
  DepthFunc = 8,    // [func]
  DepthMask = 9,    // [flag]
  CullFace = 10,    // [mode]
  ShadeModel = 11,  // [mode]
  Viewport = 12,    // [x y w h]
  Scissor = 13,     // [x y w h]
  Fog = 14,         // [mode(GL_LINEAR/EXP/EXP2) start end density colorR colorG colorB colorA floats]
  TexEnv = 15,      // [GL_REPLACE/MODULATE/DECAL/BLEND]
  BindTexture = 16, // [id]       ids are allocated by the HLE (glGenTextures); 0 = no texture
  DeleteTexture = 17, // [id]
  TexParameter = 18,  // [pname, param]  MIN/MAG filter, WRAP_S/T for the currently bound texture
  TexImage2D = 19,    // [level, w, h, w*h RGBA8 words]  (HLE converts every format to RGBA8)
  TexSubImage2D = 20, // [level, x, y, w, h, w*h RGBA8 words]
  DrawPixels = 21,    // [rasterX rasterY w h, w*h RGBA8 words]  (window coords, drawn as a textured quad)
  ReadPixels = 22,    // [x y w h guestDestAddr]  RGBA8 rows bottom-to-top written to guest memory (sync: use submit_and_wait)
  Present = 23,       // [] end of frame (SwapBuffers); also sent with submit(words, present=true)
  DrawBuffer = 24,    // [mode]
  Finish = 25,        // []
};

inline uint32_t pack(Op op, uint32_t payload_words) { return ((uint32_t)op << 16) | payload_words; }

}  // namespace gl1
