#include "com.h"

#include <cstring>
#include <cstdio>
#include <mutex>
#include <set>
#include <unordered_map>

namespace plat {
__attribute__((weak)) bool gl_create_context() { return false; }
__attribute__((weak)) void gl_swap() {}
__attribute__((weak)) void gl_set_swap_interval(int) {}
__attribute__((weak)) void frame_presented(uint64_t) {}
}  // namespace plat

namespace rt {

namespace {
std::mutex g_com_mutex;
std::unordered_map<uint32_t, ComObject*> g_objects;  // object id -> object
uint32_t g_next_id = 1;

// Every vtable slot must dispatch to a non-null guest thunk. nullptr ComMethod::fn used to leave
// holes (guest rt_dispatch(0)); unregistered methods log once and return 0 (EAX).
std::mutex g_fallback_log_mutex;
std::set<std::string> g_fallback_logged;

// Stack DWORDs the callee must pop (stdcall args including `this`, excluding the return address).
int com_stdcall_pop_dwords(Cpu* c, int nargs, const char* method) {
  return nargs + 1;
}

uint32_t com_method_fallback(Cpu* c, ComObject*, const char* iface, const char* method, int nargs) {
  std::string key = std::string(iface) + "::" + method;
  {
    std::lock_guard<std::mutex> lock(g_fallback_log_mutex);
    if (g_fallback_logged.insert(key).second)
      log(Log::Info, "COM %s: TODO(wave 3) — conservative return 0", key.c_str());
  }
  ret_stdcall(c, 0, com_stdcall_pop_dwords(c, nargs, method));
  return 0;
}
}  // namespace

ComInterface::ComInterface(const char* name, std::vector<ComMethod> methods, std::recursive_mutex* serialize)
    : name_(name), methods_(std::move(methods)), serialize_(serialize) {}

uint32_t ComInterface::vtable() {
  if (vtable_) return vtable_;
  uint32_t vt = sys_alloc((uint32_t)methods_.size() * 4, 4);
  for (size_t i = 0; i < methods_.size(); i++) {
    ComMethod m = methods_[i];
    std::string label = name_ + "::" + m.name;
    std::recursive_mutex* serialize = serialize_;
    const char* iface_name = name_.c_str();
    const char* method_name = m.name;
    int nargs = m.nargs;
    ComFn fn = m.fn;
    st32(vt + 4 * (uint32_t)i,
         make_thunk(
             [fn, iface_name, method_name, nargs, label, serialize](Cpu* c) {
               std::unique_lock<std::recursive_mutex> lock;
               if (serialize) lock = std::unique_lock<std::recursive_mutex>(*serialize);
               uint32_t self_ptr = arg(c, 0);
               ComObject* self = com_object(self_ptr);
               if (!self) fatal("%s called on unknown object %08x", label.c_str(), self_ptr);
               if (!fn) {
                 com_method_fallback(c, self, iface_name, method_name, nargs);
                 return;
               }
               if (trace_enabled("com"))
                 log(Log::Hle, "%s(%08x, %08x, %08x, %08x)", label.c_str(), arg(c, 1), arg(c, 2), arg(c, 3), arg(c, 4));
               uint32_t r = fn(c, self);
               ret_stdcall(c, r, com_stdcall_pop_dwords(c, nargs, method_name));
             },
             label));
  }
  vtable_ = vt;
  return vt;
}

uint32_t com_wrap(ComObject* obj, ComInterface& iface) {
  uint32_t id;
  {
    std::lock_guard<std::mutex> lock(g_com_mutex);
    id = g_next_id++;
    g_objects[id] = obj;
  }
  uint32_t p = heap_alloc(process_heap(), 8, true);
  st32(p, iface.vtable());
  st32(p + 4, id);
  obj->wrappers.push_back(p);
  return p;
}

ComObject* com_object(uint32_t guest_ptr) {
  if (guest_ptr < kNullGuardEnd) return nullptr;
  uint32_t id = ld32(guest_ptr + 4);
  std::lock_guard<std::mutex> lock(g_com_mutex);
  auto it = g_objects.find(id);
  return it == g_objects.end() ? nullptr : it->second;
}

ComObject::~ComObject() {
  std::lock_guard<std::mutex> lock(g_com_mutex);
  for (uint32_t w : wrappers) {
    auto it = g_objects.find(ld32(w + 4));
    if (it != g_objects.end() && it->second == this) g_objects.erase(it);
    st32(w + 4, 0);
  }
}

uint32_t com_AddRef(Cpu*, ComObject* self) { return (uint32_t)++self->refs; }

uint32_t com_Release(Cpu* c, ComObject* self) {
  int32_t r = --self->refs;
  // Guest wrappers stay allocated; the destructor unregisters them.
  if (r == 0) delete self;
  return (uint32_t)std::max<int32_t>(r, 0);
}

uint32_t com_QueryInterface_none(Cpu* c, ComObject*) {
  if (arg(c, 2)) st32(arg(c, 2), 0);
  return E_NOINTERFACE;
}

Guid read_guid(uint32_t addr) {
  Guid g;
  memcpy(&g, host(addr), 16);
  return g;
}

bool guid_eq(const Guid& a, const Guid& b) { return memcmp(&a, &b, 16) == 0; }

std::string guid_str(const Guid& g) {
  char buf[64];
  snprintf(buf, sizeof buf, "{%08X-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}", g.d1, g.d2, g.d3, g.d4[0], g.d4[1], g.d4[2],
           g.d4[3], g.d4[4], g.d4[5], g.d4[6], g.d4[7]);
  return buf;
}

// ---- ole32.dll: COM startup and the task allocator -------------------------------------------
// The game imports only d3d8/dinput8 directly; the few ole32 entry points it uses are for COM
// initialisation and the shared task heap. CoCreateInstance has no registered classes here.
// TODO(M4): register whatever class the game instantiates, if any, once its call sites are traced.

const char* kOleDll = "ole32.dll";

HLE_STDCALL(kOleDll, CoInitialize, 1) { return S_OK; }
HLE_STDCALL(kOleDll, CoUninitialize, 0) { return 0; }
HLE_STDCALL(kOleDll, CoCreateInstance, 5) {
  if (arg(c, 4)) st32(arg(c, 4), 0);
  if (trace_enabled("com")) log(Log::Hle, "CoCreateInstance(%s): no class registered", guid_str(read_guid(arg(c, 0))).c_str());
  return 0x80040154;  // REGDB_E_CLASSNOTREG
}
HLE_STDCALL(kOleDll, CoTaskMemAlloc, 1) { return heap_alloc(process_heap(), arg(c, 0) ? arg(c, 0) : 1, false); }
HLE_STDCALL(kOleDll, CoTaskMemFree, 1) { return heap_free(process_heap(), arg(c, 0)); }
HLE_STDCALL(kOleDll, CoFreeUnusedLibraries, 0) { return 0; }

}  // namespace rt
