// Logging, dispatch, HLE thunks, PE image loading, guest threads and guest calls.
#include <csignal>
#include <cstdio>
#if !defined(__EMSCRIPTEN__)
#include <sys/time.h>
#include <ucontext.h>
#endif
#include <cstdlib>
#include <map>
#include <chrono>
#include <mutex>
#include <set>
#include <thread>
#include <unordered_map>

#include "rt.h"

namespace rt {

// ---- Logging -------------------------------------------------------------------------------

static std::mutex g_log_mutex;

bool trace_enabled(const char* channel) {
  static const char* env = getenv("BELLA_TRACE");
  if (!env) return false;
  return strstr(env, channel) != nullptr || strstr(env, "all") != nullptr;
}

void log(Log level, const char* fmt, ...) {
  static const char* names[] = {"error", "warn", "info", "hle", "debug"};
  if (level == Log::Debug && !trace_enabled("debug")) return;
  std::lock_guard<std::mutex> lock(g_log_mutex);
  GuestThread* t = current_thread();
  fprintf(stderr, "[%s t%u] ", names[(int)level], t ? t->id : 0);
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
}

static void backtrace(Cpu* c) {
  if (!c) return;
  fprintf(stderr, "  guest registers: eax=%08x ecx=%08x edx=%08x ebx=%08x esp=%08x ebp=%08x esi=%08x edi=%08x\n", c->eax,
          c->ecx, c->edx, c->ebx, c->esp, c->ebp, c->esi, c->edi);
  // Walk the EBP chain (frames without frame pointers are skipped).
  uint32_t ebp = c->ebp;
  for (int i = 0; i < 24 && ebp >= kNullGuardEnd && ebp < kGuestTop - 8; i++) {
    uint32_t ret = ld32(ebp + 4);
    fprintf(stderr, "  frame %2d: ebp=%08x ret=%08x\n", i, ebp, ret);
    uint32_t next = ld32(ebp);
    if (next <= ebp) break;
    ebp = next;
  }
  // Also dump the top of the stack: return addresses into .text are informative.
  fprintf(stderr, "  stack:");
  for (int i = 0; i < 16; i++) fprintf(stderr, " %08x", ld32(c->esp + 4 * (uint32_t)i));
  fputc('\n', stderr);
}

void fatal(const char* fmt, ...) {
  {
    std::lock_guard<std::mutex> lock(g_log_mutex);
    fprintf(stderr, "[fatal] ");
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    GuestThread* t = current_thread();
    if (t) backtrace(&t->cpu);
  }
  fflush(stderr);
  abort();
}

}  // namespace rt

extern "C" void rt_trap(Cpu* c, const char* msg) {
  rt::fatal("guest trap: %s", msg);
  (void)c;
}

namespace rt {

// ---- Thunks and dispatch -------------------------------------------------------------------

struct Thunk {
  std::function<void(Cpu*)> fn;  // empty for imports that are not implemented
  std::string label;
};
static std::vector<Thunk> g_thunks;  // index = (addr - kThunkBase) / 4
static std::mutex g_thunk_mutex;
static const uint32_t kMaxThunks = (kThunkEnd - kThunkBase) / 4 - 16;

uint32_t make_thunk(std::function<void(Cpu*)> fn, const std::string& label) {
  std::lock_guard<std::mutex> lock(g_thunk_mutex);
  if (g_thunks.size() >= kMaxThunks) fatal("out of HLE thunks");
  g_thunks.push_back({fn, label});
  return kThunkBase + 4 * (uint32_t)(g_thunks.size() - 1);
}

const std::string& thunk_label(uint32_t addr) {
  static const std::string none = "?";
  uint32_t i = (addr - kThunkBase) / 4;
  return i < g_thunks.size() ? g_thunks[i].label : none;
}

#if defined(RT_PLAYER)
// Player build: guest code lives in the browser-translated module (web/web_game.cpp).
bool game_owns(uint32_t target);
void game_call(Cpu* c, uint32_t target);
uint32_t game_function_count();

void dispatch_init() {
  if (!game_function_count()) fatal("no translated game module was provided");
  log(Log::Info, "dispatch: %u translated functions (in-browser translation)", game_function_count());
}
#else
static uint32_t g_text_lo, g_text_hi;
static std::vector<GuestFn> g_fn_table;  // direct-mapped over [g_text_lo, g_text_hi)

void dispatch_init() {
  g_text_lo = 0xffffffffu;
  g_text_hi = 0;
  for (uint32_t i = 0; i < recomp_function_count; i++) {
    g_text_lo = std::min(g_text_lo, recomp_functions[i].addr);
    g_text_hi = std::max(g_text_hi, recomp_functions[i].addr + 1);
  }
  g_fn_table.assign(g_text_hi - g_text_lo, nullptr);
  for (uint32_t i = 0; i < recomp_function_count; i++) g_fn_table[recomp_functions[i].addr - g_text_lo] = recomp_functions[i].fn;
  log(Log::Info, "dispatch: %u recompiled functions in [%08x, %08x)", recomp_function_count, g_text_lo, g_text_hi);
}
#endif

// HLE entry points (imports and COM methods) live at thunk addresses.
static bool call_thunk(Cpu* c, uint32_t target) {
  if (target < kThunkBase || target >= kThunkEnd || (target & 3)) return false;
  uint32_t i = (target - kThunkBase) / 4;
  if (i >= g_thunks.size()) return false;
  if (!g_thunks[i].fn) fatal("unimplemented %s (called indirectly from %08x)", g_thunks[i].label.c_str(), ld32(c->esp));
  g_thunks[i].fn(c);
  return true;
}

static bool trace_guest_fn(uint32_t addr) {
  if (!rt::trace_enabled("funcs")) return false;
  static const char* list = getenv("BELLA_TRACE_FUNCS");
  if (!list || !*list) return false;
  char needle[16];
  snprintf(needle, sizeof(needle), "%08x", addr);
  const char* p = list;
  while ((p = strstr(p, needle)) != nullptr) {
    char c = p[8];
    if (c == '\0' || c == ',' || c == ' ' || c == ';') return true;
    p += 8;
  }
  return false;
}

}  // namespace rt

extern "C" void rt_dispatch(Cpu* c, uint32_t target) {
  using namespace rt;
#if defined(RT_PLAYER)
  if (game_owns(target)) {
    game_call(c, target);
    return;
  }
#else
  uint32_t off = target - g_text_lo;
  if (off < g_fn_table.size()) {
    if (GuestFn fn = g_fn_table[off]) {
      const bool tr = trace_guest_fn(target);
      if (tr) log(Log::Info, "func: -> %08x eax=%08x esp=%08x", target, c->eax, c->esp);
      uint32_t ret_site = ld32(c->esp);
      if (rt::trace_enabled("dispatch") && ret_site >= 0x0058b6b0u && ret_site <= 0x0058b720u) {
        log(Log::Info, "b670 dispatch ret=%08x target=%08x ecx=%08x eax=%08x", ret_site, target, c->ecx, c->eax);
      }
      fn(c);
      if (tr) log(Log::Info, "func: <- %08x eax=%08x", target, c->eax);
      return;
    }
  }
#endif
  if (call_thunk(c, target)) return;
  fatal("dispatch to unknown guest address 0x%08x (no recompiled function or thunk) ecx=%08x edx=%08x "
        "stack[esp..+20]=%08x %08x %08x %08x %08x %08x",
        target, c->ecx, c->edx, ld32(c->esp), ld32(c->esp + 4), ld32(c->esp + 8), ld32(c->esp + 12),
        ld32(c->esp + 16), ld32(c->esp + 20));
}

// Fallback used by translated code for targets outside its own function index.
extern "C" void rt_dispatch_ext(Cpu* c, uint32_t target) {
  if (rt::call_thunk(c, target)) return;
  rt::fatal("dispatch to unknown guest address 0x%08x (no translated function or thunk) ecx=%08x edx=%08x "
            "stack[esp..+20]=%08x %08x %08x %08x %08x %08x",
            target, c->ecx, c->edx, ld32(c->esp), ld32(c->esp + 4), ld32(c->esp + 8), ld32(c->esp + 12),
            ld32(c->esp + 16), ld32(c->esp + 20));
}

#include "modules.h"

namespace rt {

// ---- HLE registry and import binding -------------------------------------------------------

static std::map<std::string, HleFn>& registry() {
  static std::map<std::string, HleFn> r;
  return r;
}

static std::string lower(std::string s) {
  for (auto& ch : s) ch = (char)tolower((unsigned char)ch);
  return s;
}

void hle_register(const char* dll, const char* name, HleFn fn) { registry()[lower(dll) + "!" + name] = fn; }

HleFn hle_find(const std::string& dll, const std::string& name) {
  std::string d = lower(dll);
  if (d.find('.') == std::string::npos) d += ".dll";
  auto it = registry().find(d + "!" + name);
  return it == registry().end() ? nullptr : it->second;
}

}  // namespace rt

#if defined(RECOMP_STACK_CHECK)
namespace {
struct StackCheckState {
  std::mutex mu;
  std::set<uint32_t> seen_fn;
  std::set<uint64_t> seen_hle;
  int lines = 0;
  void line() {
    if (lines < 200) lines++;
  }
  bool full() const { return lines >= 200; }
};
StackCheckState g_stackcheck;
}  // namespace

extern "C" void rt_stackcheck_ret(Cpu* c, uint32_t fn_va, uint32_t entry_esp, uint32_t ret_pop, uint32_t ret_site) {
  uint32_t esp_at_ret = c->esp - 4u - ret_pop;
  if (esp_at_ret == entry_esp) return;
  int delta = (int)(esp_at_ret - entry_esp);
  uint32_t ret = ld32(entry_esp);
  std::lock_guard<std::mutex> lock(g_stackcheck.mu);
  if (g_stackcheck.full() || !g_stackcheck.seen_fn.insert(fn_va).second) return;
  fprintf(stderr, "[stackcheck] f_%08x: esp off by %d bytes at ret@%08x (entry_esp=%08x, esp=%08x, ret=%08x)\n", fn_va, delta, ret_site,
          entry_esp, esp_at_ret, ret);
  g_stackcheck.line();
}

static int stdcall_arg_bytes(const std::string& export_name) {
  size_t at = export_name.rfind('@');
  if (at == std::string::npos) return -1;
  char* end = nullptr;
  long n = std::strtol(export_name.c_str() + at + 1, &end, 10);
  if (end == export_name.c_str() + at + 1 || n < 0 || n > 256) return -1;
  return (int)n;
}

extern "C" void rt_stackcheck_hle(Cpu* c, uint32_t import_index, uint32_t esp_at_call) {
  using namespace rt;
  if (import_index >= import_count()) return;
  const auto& im = import_at(import_index);
  int argb = stdcall_arg_bytes(im.name);
  if (argb < 0) return;
  uint32_t want = esp_at_call + 4u + (uint32_t)argb;
  if (c->esp == want) return;
  int delta = (int)(c->esp - want);
  uint32_t ret = ld32(esp_at_call);
  const char* name = import_index < import_count() ? im.name.c_str() : "?";
  uint64_t key = ((uint64_t)import_index << 32) | (uint64_t)(ret & 0xfffffff8u);
  std::lock_guard<std::mutex> lock(g_stackcheck.mu);
  if (g_stackcheck.full() || !g_stackcheck.seen_hle.insert(key).second) return;
  fprintf(stderr, "[stackcheck] hle %s[%u]: esp off by %d after import (esp_at_call=%08x, esp=%08x, ret=%08x)\n", name,
          import_index, delta, esp_at_call, c->esp, ret);
  g_stackcheck.line();
}
#endif

extern "C" void rt_hle(Cpu* c, uint32_t index) {
  using namespace rt;
  if (index >= import_count()) fatal("bad import index %u", index);
  const auto& im = import_at(index);
  if (!im.fn) fatal("unimplemented import %s!%s (called from %08x)", im.dll.c_str(), im.name.c_str(), ld32(c->esp));
  if (trace_enabled("hle")) log(Log::Hle, "%s(%08x, %08x, %08x, %08x) from %08x", im.name.c_str(), arg(c, 0), arg(c, 1), arg(c, 2), arg(c, 3), ld32(c->esp));
  GuestThread* t = current_thread();
  if (t) {
    t->in_hle = im.name.c_str();
    t->last_hle = im.name.c_str();
    t->hle_ret = ld32(c->esp);
    t->hle_calls++;
  }
  reinterpret_cast<HleFn>(im.fn)(c);
  if (t) t->in_hle = nullptr;
}

namespace rt {

// ---- Threads -------------------------------------------------------------------------------

static thread_local GuestThread* t_current = nullptr;
static std::mutex g_threads_mutex;
static std::vector<GuestThread*> g_threads;
static std::atomic<int64_t> g_last_present_ms{0};

static int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void note_present() { g_last_present_ms = now_ms(); }

// ---- Sampling profiler (BELLA_PROFILE=start_s:duration_s) --------------------------------------
// SIGPROF every millisecond of process CPU time records the interrupted host PC; the raw samples
// are written to work/profile.txt and symbolised offline (tools/profile.py).
#if defined(__EMSCRIPTEN__)
static void profiler_start() {}
#else
static constexpr size_t kProfMax = 1 << 22;
static uint64_t* g_prof_pcs = nullptr;
static std::atomic<size_t> g_prof_n{0};

static void prof_handler(int, siginfo_t*, void* uc) {
  size_t i = g_prof_n.fetch_add(1, std::memory_order_relaxed);
  if (i < kProfMax) g_prof_pcs[i] = (uint64_t)((ucontext_t*)uc)->uc_mcontext.gregs[REG_RIP];
}

static void profiler_start() {
  const char* env = getenv("BELLA_PROFILE");
  if (!env) return;
  int start = atoi(env), dur = 30;
  if (const char* c = strchr(env, ':')) dur = atoi(c + 1);
  g_prof_pcs = new uint64_t[kProfMax];
  std::thread([start, dur] {
    std::this_thread::sleep_for(std::chrono::seconds(start));
    struct sigaction sa {};
    sa.sa_sigaction = prof_handler;
    sa.sa_flags = SA_SIGINFO | SA_RESTART;
    sigaction(SIGPROF, &sa, nullptr);
    struct itimerval tv {};
    tv.it_interval.tv_usec = 1000;
    tv.it_value.tv_usec = 1000;
    setitimer(ITIMER_PROF, &tv, nullptr);
    log(Log::Info, "profiler: sampling for %d s", dur);
    std::this_thread::sleep_for(std::chrono::seconds(dur));
    struct itimerval off {};
    setitimer(ITIMER_PROF, &off, nullptr);
    size_t n = std::min(g_prof_n.load(), kProfMax);
    FILE* f = fopen("work/profile.txt", "w");
    if (f) {
      for (size_t i = 0; i < n; i++) fprintf(f, "%lx\n", (unsigned long)g_prof_pcs[i]);
      fclose(f);
    }
    // Shared-library samples are attributed offline using the process map.
    if (FILE* in = fopen("/proc/self/maps", "r")) {
      if (FILE* out = fopen("work/profile_maps.txt", "w")) {
        char line[512];
        while (fgets(line, sizeof line, in)) fputs(line, out);
        fclose(out);
      }
      fclose(in);
    }
    log(Log::Info, "profiler: wrote %zu samples to work/profile.txt", n);
  }).detach();
}
#endif

void watchdog_start() {
  profiler_start();
  const char* env = getenv("BELLA_WATCHDOG");
  if (!env) return;
  int64_t limit = (int64_t)atoi(env) * 1000;
  std::thread([limit] {
    std::vector<uint64_t> prev;
    bool reported = false;
    for (;;) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      int64_t last = g_last_present_ms.load();
      if (!last) continue;
      static int tick = 0;
      bool periodic = getenv("BELLA_STATUS") && ++tick % 5 == 0;
      if (now_ms() - last < limit && !periodic) {
        reported = false;
        continue;
      }
      std::lock_guard<std::mutex> lock(g_threads_mutex);
      prev.resize(g_threads.size());
      std::lock_guard<std::mutex> llock(g_log_mutex);
      fprintf(stderr, "[watchdog] last frame presented %lld ms ago\n", (long long)(now_ms() - last));
      for (size_t i = 0; i < g_threads.size(); i++) {
        GuestThread* t = g_threads[i];
        if (t->finished) continue;
        uint64_t calls = t->hle_calls.load();
        const char* in = t->in_hle.load();
        const char* lastc = t->last_hle.load();
        fprintf(stderr, "  thread %u: %s%s (ret %08x), %llu HLE calls in the last second, last call %s\n", t->id, in ? "in " : "running guest code",
                in ? in : "", t->hle_ret.load(), (unsigned long long)(calls - prev[i]), lastc ? lastc : "-");
        if (!reported && now_ms() - last >= limit) backtrace(&t->cpu);
        prev[i] = calls;
      }
      if (now_ms() - last >= limit) reported = true;
    }
  }).detach();
}
static std::atomic<uint32_t> g_next_tid{0x100};
static uint32_t g_peb;

GuestThread* current_thread() { return t_current; }
void bind_host_thread(GuestThread* t) { t_current = t; }

uint32_t last_error() { return t_current ? ld32(t_current->teb + 0x34) : 0; }
void set_last_error(uint32_t e) {
  if (t_current) st32(t_current->teb + 0x34, e);
}

GuestThread* create_guest_thread(uint32_t stack_size) {
  if (!g_peb) {
    g_peb = sys_alloc(0x1000);
    st32(g_peb + 0x08, kImageBase);  // ImageBaseAddress
    st32(g_peb + 0x18, process_heap());
  }
  auto* t = new GuestThread();
  t->id = g_next_tid.fetch_add(4);
  {
    std::lock_guard<std::mutex> lock(g_threads_mutex);
    g_threads.push_back(t);
  }
  stack_size = std::max<uint32_t>((stack_size + kGranularity - 1) & ~(kGranularity - 1), 0x40000);
  uint32_t stack = vm_reserve(0, stack_size);
  if (!stack || !vm_commit(stack, stack_size)) fatal("cannot allocate a %u-byte guest stack", stack_size);
  t->stack_limit = stack;
  t->stack_base = stack + stack_size;
  t->teb = sys_alloc(0x1000, 0x1000);
  st32(t->teb + 0x00, 0xffffffffu);  // SEH chain terminator
  st32(t->teb + 0x04, t->stack_base);
  st32(t->teb + 0x08, t->stack_limit);
  st32(t->teb + 0x18, t->teb);  // NT_TIB.Self
  st32(t->teb + 0x20, 0x10);    // ClientId.UniqueProcess
  st32(t->teb + 0x24, t->id);   // ClientId.UniqueThread
  st32(t->teb + 0x30, g_peb);
  Cpu& c = t->cpu;
  c.esp = t->stack_base - 16;
  c.fs_base = t->teb;
  c.fcw = 0x27f;  // Windows default: 53-bit precision, round to nearest, exceptions masked
  c.eflags = 0x202;
  c.thread_id = t->id;
  c.rt = t;
  return t;
}

uint32_t guest_call(Cpu* c, uint32_t addr, std::initializer_list<uint32_t> args) {
  uint32_t saved = c->esp;
  for (auto it = std::rbegin(args); it != std::rend(args); ++it) {
    c->esp -= 4;
    st32(c->esp, *it);
  }
  c->esp -= 4;
  st32(c->esp, kReturnSentinel);
  rt_dispatch(c, addr);
  c->esp = saved;  // correct for both stdcall and cdecl callees
  return c->eax;
}

void run_on_new_host_thread(GuestThread* t, uint32_t start, uint32_t param) {
  std::thread([t, start, param] {
    bind_host_thread(t);
    uint32_t code = guest_call(&t->cpu, start, {param});
    t->exit_code = code;
    t->finished.store(true);
    log(Log::Debug, "guest thread %u exited with %u", t->id, code);
  }).detach();
}

[[noreturn]] void process_exit(uint32_t code) {
  log(Log::Info, "process exit (%u)", code);
  fflush(stderr);
  fflush(stdout);
  _Exit((int)code);
}

}  // namespace rt
