// kernel32.dll functions Hitman's modules import that the shared HLE does not cover yet: file
// management, atoms, DOS dates, environment, FormatMessage.
#include <pthread.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <ctime>
#include <map>
#include <mutex>

#include "../core/objects.h"

using namespace rt;

void hle_link_extra() {}

namespace {
const char* kDll = "kernel32.dll";

std::mutex g_atom_mutex;
std::map<uint32_t, std::string> g_atoms;  // global atoms start at 0xC000

uint32_t atom_add(const std::string& name) {
  std::lock_guard<std::mutex> lock(g_atom_mutex);
  for (auto& [id, n] : g_atoms)
    if (strcasecmp(n.c_str(), name.c_str()) == 0) return id;
  uint32_t id = 0xC000 + (uint32_t)g_atoms.size();
  g_atoms[id] = name;
  return id;
}

bool copy_file(const std::string& from, const std::string& to) {
  FILE* in = fopen(from.c_str(), "rb");
  if (!in) return false;
  FILE* out = fopen(to.c_str(), "wb");
  if (!out) return fclose(in), false;
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) fwrite(buf, 1, n, out);
  fclose(in);
  fclose(out);
  return true;
}
}  // namespace

HLE_STDCALL(kDll, GetVersion, 0) { return 0x0a280105; }  // Windows XP SP2 (5.1, build 2600) like the other ports
HLE_STDCALL(kDll, SetConsoleCtrlHandler, 2) { return 1; }
HLE_STDCALL(kDll, LocalFree, 1) { return 0; }  // buffers handed out by FormatMessage are never reclaimed

HLE_STDCALL(kDll, ExitThread, 1) {
  pthread_exit(nullptr);
  return 0;
}

HLE_STDCALL(kDll, GetEnvironmentVariableA, 3) {
  set_last_error(203);  // ERROR_ENVVAR_NOT_FOUND: the process environment is fixed and empty
  return 0;
}

// SYSTEMTIME in local time; the sandbox has no time zone, so UTC.
HLE_STDCALL(kDll, GetLocalTime, 1) {
  std::time_t t = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&t, &tm);
  uint32_t p = arg(c, 0);
  uint32_t f[7] = {(uint32_t)tm.tm_year + 1900, (uint32_t)tm.tm_mon + 1, (uint32_t)tm.tm_wday, (uint32_t)tm.tm_mday,
                   (uint32_t)tm.tm_hour, (uint32_t)tm.tm_min, (uint32_t)tm.tm_sec};
  for (int i = 0; i < 7; i++) st16(p + 2 * i, f[i]);
  st16(p + 14, 0);
  return 0;
}

HLE_STDCALL(kDll, DeleteFileA, 1) {
  std::string h = vfs_host_path(read_cstr(arg(c, 0)), false);
  if (h.empty() || unlink(h.c_str()) != 0) {
    set_last_error(ERROR_FILE_NOT_FOUND);
    return 0;
  }
  return 1;
}

HLE_STDCALL(kDll, MoveFileA, 2) {
  std::string from = vfs_host_path(read_cstr(arg(c, 0)), false), to = vfs_host_path(read_cstr(arg(c, 1)), true);
  if (from.empty() || to.empty() || rename(from.c_str(), to.c_str()) != 0) {
    set_last_error(ERROR_FILE_NOT_FOUND);
    return 0;
  }
  return 1;
}

HLE_STDCALL(kDll, CopyFileA, 3) {
  std::string from = vfs_host_path(read_cstr(arg(c, 0)), false), to = vfs_host_path(read_cstr(arg(c, 1)), true);
  if (from.empty() || to.empty() || (arg(c, 2) && access(to.c_str(), F_OK) == 0) || !copy_file(from, to)) {
    set_last_error(ERROR_FILE_NOT_FOUND);
    return 0;
  }
  return 1;
}

// FILETIME of the handle's file is not tracked: report a fixed time so comparisons are stable.
HLE_STDCALL(kDll, GetFileTime, 4) {
  for (int i = 1; i < 4; i++)
    if (arg(c, i)) st64(arg(c, i), 0x01C00000ull << 32);
  return 1;
}

HLE_STDCALL(kDll, DosDateTimeToFileTime, 3) {
  uint32_t d = arg(c, 0), t = arg(c, 1);
  std::tm tm{};
  tm.tm_year = (int)(d >> 9) + 80, tm.tm_mon = (int)((d >> 5) & 15) - 1, tm.tm_mday = (int)(d & 31);
  tm.tm_hour = (int)(t >> 11), tm.tm_min = (int)((t >> 5) & 63), tm.tm_sec = (int)(t & 31) * 2;
  uint64_t ft = ((uint64_t)timegm(&tm) + 11644473600ull) * 10000000ull;
  st64(arg(c, 2), ft);
  return 1;
}

HLE_STDCALL(kDll, FileTimeToDosDateTime, 3) {
  std::time_t t = (std::time_t)(ld64(arg(c, 0)) / 10000000ull - 11644473600ull);
  std::tm tm{};
  gmtime_r(&t, &tm);
  st16(arg(c, 1), (uint32_t)((tm.tm_year - 80) << 9 | (tm.tm_mon + 1) << 5 | tm.tm_mday));
  st16(arg(c, 2), (uint32_t)(tm.tm_hour << 11 | tm.tm_min << 5 | tm.tm_sec / 2));
  return 1;
}

HLE_STDCALL(kDll, GlobalAddAtomA, 1) { return arg(c, 0) < 0x10000 ? arg(c, 0) : atom_add(read_cstr(arg(c, 0))); }
HLE_STDCALL(kDll, GlobalDeleteAtom, 1) { return 0; }
HLE_STDCALL(kDll, GlobalGetAtomNameA, 3) {
  std::lock_guard<std::mutex> lock(g_atom_mutex);
  auto it = g_atoms.find(arg(c, 0));
  uint32_t size = arg(c, 2);
  if (it == g_atoms.end() || !size) return 0;
  std::string n = it->second.substr(0, size - 1);
  write_cstr(arg(c, 1), n);
  return (uint32_t)n.size();
}

// FormatMessageA: only the "system message" lookups the game uses for error text; the text is generic.
HLE_STDCALL(kDll, FormatMessageA, 7) {
  uint32_t flags = arg(c, 0), buf = arg(c, 4), size = arg(c, 5);
  std::string msg = "Error " + std::to_string(arg(c, 2)) + "\r\n";
  if (flags & 0x100) {  // FORMAT_MESSAGE_ALLOCATE_BUFFER: lpBuffer receives a pointer
    uint32_t p = sys_alloc((uint32_t)msg.size() + 1);
    write_cstr(p, msg);
    st32(buf, p);
  } else if (size) {
    msg = msg.substr(0, size - 1);
    write_cstr(buf, msg);
  }
  return (uint32_t)msg.size();
}

// Sound.dll imports dsound ordinal 2 = DirectSoundEnumerateA: report the one default device.
HLE_STDCALL_AS("dsound.dll", DirectSoundEnumerateA_ord2, "#2", 2) {
  uint32_t desc = sys_alloc(32), mod = sys_alloc(16);
  write_cstr(desc, "Primary Sound Driver");
  write_cstr(mod, "");
  guest_call(c, arg(c, 0), {0, desc, mod, arg(c, 1)});
  return 0;  // DS_OK
}
