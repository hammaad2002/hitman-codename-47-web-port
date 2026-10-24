// gdi32.dll: minimal HLE for Hitman's OpenGL renderer.
// Only the functions the game actually imports are implemented. GetDeviceCaps and DeleteObject
// live in user32.cpp, which owns the display metrics; registering them twice would race.
#include <cstring>

#include "../core/rt.h"
#include "../core/objects.h"

using namespace rt;

namespace {
const char* kDll = "gdi32.dll";

// Fake handles, never used for real color mapping or GDI drawing.
uint32_t g_next_palette = 0x3000;
constexpr uint32_t kStockBase = 0x4000;

// PIXELFORMATDESCRIPTOR, 40 bytes as in the Win32 header.
struct PixelFormatDescriptor {
  uint16_t nSize;
  uint16_t nVersion;
  uint32_t dwFlags;
  uint8_t iPixelType;
  uint8_t cColorBits;
  uint8_t cRedBits;
  uint8_t cRedShift;
  uint8_t cGreenBits;
  uint8_t cGreenShift;
  uint8_t cBlueBits;
  uint8_t cBlueShift;
  uint8_t cAlphaBits;
  uint8_t cAlphaShift;
  uint8_t cAccumBits;
  uint8_t cAccumRedBits;
  uint8_t cAccumGreenBits;
  uint8_t cAccumBlueBits;
  uint8_t cAccumAlphaBits;
  uint8_t cDepthBits;
  uint8_t cStencilBits;
  uint8_t cAuxBuffers;
  uint8_t iLayerType;
  uint8_t bReserved;
  uint32_t dwLayerMask;
  uint32_t dwVisibleMask;
  uint32_t dwDamageMask;
};
static_assert(sizeof(PixelFormatDescriptor) == 40, "PIXELFORMATDESCRIPTOR layout");
}  // namespace

HLE_STDCALL(kDll, CreatePalette, 1) {
  // The game never reads palette entries back, so the handle is all it needs.
  uint32_t h = g_next_palette;
  g_next_palette += 4;
  return h;
}

HLE_STDCALL(kDll, DescribePixelFormat, 4) {
  // hdc, pixel_format, size, ppfd. We expose exactly one format (index 1) and return the count.
  uint32_t size = arg(c, 2);
  uint32_t ppfd = arg(c, 3);
  if (size > 0 && ppfd) {
    PixelFormatDescriptor pfd{};
    pfd.nSize = sizeof(PixelFormatDescriptor);
    pfd.nVersion = 1;
    pfd.dwFlags = 0x00000025;  // PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER
    pfd.iPixelType = 0;        // PFD_TYPE_RGBA
    pfd.cColorBits = 32;
    pfd.cRedBits = 8;   pfd.cRedShift = 16;
    pfd.cGreenBits = 8; pfd.cGreenShift = 8;
    pfd.cBlueBits = 8;  pfd.cBlueShift = 0;
    pfd.cAlphaBits = 8; pfd.cAlphaShift = 24;
    pfd.cDepthBits = 24;
    pfd.cStencilBits = 8;
    pfd.iLayerType = 0;  // PFD_MAIN_PLANE
    memcpy(host(ppfd), &pfd, size < sizeof(pfd) ? size : sizeof(pfd));
  }
  return 1;
}

HLE_STDCALL(kDll, GetPixelFormat, 1) { return 1; }  // hdc; the only format we expose

HLE_STDCALL(kDll, GetStockObject, 1) {
  // The game uses stock brushes and pens as opaque handles and never inspects them.
  return kStockBase + arg(c, 0);
}

HLE_STDCALL(kDll, RealizePalette, 1) { return 0; }  // no entries realized; there is no real palette

HLE_STDCALL(kDll, SelectPalette, 3) { return 0; }  // fake previous palette handle

HLE_STDCALL(kDll, SetPixelFormat, 3) { return 1; }  // hdc, format, ppfd; BOOL TRUE

// Link anchor: forces this translation unit (and its HLE registrars) to be kept in a static link.
void hle_link_gdi32() {}
