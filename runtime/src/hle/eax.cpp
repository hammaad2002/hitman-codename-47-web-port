// eax.dll: Sound.dll imports EAXDirectSoundCreate by ordinal 5. We expose no EAX effects, so it
// forwards to the plain DirectSound object that dsound.cpp creates.
#include "../core/rt.h"

using namespace rt;

namespace {
constexpr uint32_t kEFail = 0x80004005u;

// Same stdcall shape as DirectSoundCreate8(guid, ppDS, unkOuter). The target pops its own
// arguments and sets EAX, so this must not pop them again.
void eax_direct_sound_create(Cpu* c) {
  HleFn create = hle_find("dsound.dll", "DirectSoundCreate8");
  if (!create) return ret_stdcall(c, kEFail, 3);
  create(c);
}

static rt::HleRegistrar g_eax_name("eax.dll", "EAXDirectSoundCreate", eax_direct_sound_create);
static rt::HleRegistrar g_eax_ordinal("eax.dll", "#5", eax_direct_sound_create);  // EAX.dll export 5
}  // namespace

// Link anchor: forces this translation unit (and its HLE registrars) to be kept in a static link.
void hle_link_eax() {}
