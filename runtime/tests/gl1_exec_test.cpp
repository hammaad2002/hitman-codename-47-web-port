// Pure-logic tests for the GL1 executor (no GL context): build with -DGL1_NO_GL.
// Build: g++ -std=c++17 -DGL1_NO_GL -Iruntime/src runtime/tests/gl1_exec_test.cpp runtime/src/gles/gl1_exec.cpp -o /tmp/gl1t && /tmp/gl1t
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "gles/gl1_exec.h"
#include "gl1/gl1_cmd.h"

#define CHECK(c) do { if (!(c)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #c); std::exit(1); } } while (0)

int main() {
  using namespace gl1;
  using namespace gl1::detail;

  uint32_t w[] = {kMagic, pack(Op::Clear, 1), 0x4100, pack(Op::Present, 0), pack(Op::Fog, 8), 0, 0, 0, 0, 0, 0, 0};
  const uint32_t* cur = w;
  Record r;
  CHECK(next_record(cur, w + 4, r) && r.op == (uint16_t)Op::Clear && r.n == 1 && r.p[0] == 0x4100);
  CHECK(next_record(cur, w + 4, r) && r.op == (uint16_t)Op::Present && r.n == 0);
  CHECK(!next_record(cur, w + 4, r));
  cur = w + 4;
  CHECK(!next_record(cur, w + 8, r));  // truncated payload

  std::vector<uint32_t> idx;
  CHECK(expand_indices(0x7, 8, idx) && idx.size() == 12 && idx[3] == 0 && idx[4] == 2 && idx[9] == 4);
  CHECK(expand_indices(0x8, 6, idx) && idx.size() == 12 && idx[6] == 2 && idx[11] == 5);
  CHECK(expand_indices(0x9, 5, idx) && idx.size() == 9 && idx[0] == 0 && idx[8] == 4);
  CHECK(expand_indices(0x7, 3, idx) && idx.empty());
  CHECK(!expand_indices(0x4, 6, idx));

  CHECK(map_wrap(0x2900) == 0x812F && map_wrap(0x2901) == 0x2901);
  CHECK(is_mipmap_filter(0x2703) && !is_mipmap_filter(0x2601));
  CHECK(map_blend_factor(0x302) == 0x302 && map_blend_factor(0x8001) == 0);
  CHECK(is_valid_cap(0x0BE2) && !is_valid_cap(0x0DE1));

  int x, y, ww, hh;
  letterbox(800, 600, 1600, 600, x, y, ww, hh);
  CHECK(ww == 800 && hh == 600 && x == 400 && y == 0);
  letterbox(800, 600, 800, 1200, x, y, ww, hh);
  CHECK(ww == 800 && hh == 600 && y == 300);

  std::puts("gl1_exec_test OK");
  return 0;
}
