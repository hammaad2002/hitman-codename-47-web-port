// winmm.dll: MIDI input stubs. Sound.dll opens a MIDI input device at startup, and the web port has
// no MIDI hardware, so midiInOpen reports MMSYSERR_NODRIVER and the game carries on without MIDI.
// The timer functions live in user32.cpp.
#include "../core/rt.h"
#include "../core/objects.h"

using namespace rt;

namespace {
const char* kDll = "winmm.dll";
constexpr uint32_t kMmsysNoError = 0;
constexpr uint32_t kMmsysNoDriver = 6;  // MMSYSERR_NODRIVER
}  // namespace

HLE_STDCALL(kDll, midiInOpen, 5) {
  // phmi, uDeviceID, dwCallback, dwCallbackInstance, fdwOpen. The handle is zeroed so a caller
  // that ignores the error cannot use garbage.
  if (arg(c, 0)) st32(arg(c, 0), 0);
  return kMmsysNoDriver;
}

HLE_STDCALL(kDll, midiInStart, 1) { return kMmsysNoDriver; }  // hmi; never reached after a failed open

// The header and buffer calls only touch caller-owned memory, so they report success as no-ops.
HLE_STDCALL(kDll, midiInAddBuffer, 3) { return kMmsysNoError; }
HLE_STDCALL(kDll, midiInPrepareHeader, 3) { return kMmsysNoError; }
HLE_STDCALL(kDll, midiInUnprepareHeader, 3) { return kMmsysNoError; }

// Link anchor: forces this translation unit (and its HLE registrars) to be kept in a static link.
void hle_link_winmm() {}
