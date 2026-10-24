// Native entry point: map the Hitman modules, bind the HLE layer and run the loader's entry point.
// hitman [install-dir] [registry-file]
#include <fstream>
#include <iterator>

#include "core/modules.h"
#include "core/objects.h"
#include "core/rt.h"
#include "hle/registry.h"
#include "platform/platform.h"

int main(int argc, char** argv) {
  std::string install = argc > 1 ? argv[1] : "work/game/app";
  std::string reg = argc > 2 ? argv[2] : "work/registry.txt";
  rt::memory_init();
  rt::vfs_init(install);
  rt::registry_init(reg);
  if (!plat::init()) return 1;
  rt::load_modules([&](const std::string& name, std::vector<uint8_t>& out) {
    std::ifstream f(install + "/" + name, std::ios::binary);
    if (!f) return false;
    out.assign((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    return true;
  });
  rt::dispatch_init();
  rt::watchdog_start();
  rt::GuestThread* t = rt::create_guest_thread(0x100000);
  rt::bind_host_thread(t);
  rt::run_module_inits();
  rt::log(rt::Log::Info, "starting guest at entry %08x", rt::image_entry());
  uint32_t code = rt::guest_call(&t->cpu, rt::image_entry(), {});
  rt::process_exit(code);
}
